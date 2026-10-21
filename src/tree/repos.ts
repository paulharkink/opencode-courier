import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { realpath } from "node:fs/promises"
import { resolve } from "node:path"
import { promisify } from "node:util"
import { findGit } from "./cleanup.js"
import type { RemoteConfig } from "../platform/remote.js"
import { remoteRequest } from "../platform/remote.js"
import type { RepoMapRepository, RepoMapV1 } from "./repo-map.js"

export interface RepositoryCandidate {
  readonly nodeId: string
  readonly peer?: string
  readonly host: string
  readonly name: string
  readonly path: string
  readonly repoId: string
  readonly worktrees: ReadonlyArray<RepoMapRepository["worktrees"][number] & { readonly path: string }>
}

export interface PeerError {
  readonly peer: string
  readonly message: string
}

export interface RepositoryList {
  readonly repositories: ReadonlyArray<RepositoryCandidate>
  readonly worktreeRoots: Readonly<Record<string, string>>
  readonly errors: ReadonlyArray<PeerError>
}

export interface RepoPorts {
  readonly repoMap?: RepoMapV1
  readonly remote?: RemoteConfig
}

const MAX_REPOSITORIES = 500
const normalized = (value: string) => value.toLocaleLowerCase()
const execFileAsync = promisify(execFile)
const hash = (value: string) => createHash("sha256").update(value).digest("hex")

async function git(directory: string, args: string[]) {
  const { stdout } = await execFileAsync(findGit(), ["-C", directory, ...args], { maxBuffer: 16 * 1024 * 1024 })
  return stdout.trim()
}

async function liveWorktrees(candidate: RepositoryCandidate): Promise<RepositoryCandidate> {
  try {
    const source = await realpath(candidate.path)
    const commonDir = await realpath(resolve(source, await git(source, ["rev-parse", "--git-common-dir"])))
    if (hash(commonDir) !== candidate.repoId) return candidate
    const output = await git(source, ["worktree", "list", "--porcelain"])
    const found: Array<{ path?: string; branch?: string; detached?: boolean }> = []
    let current: { path?: string; branch?: string; detached?: boolean } = {}
    const finish = () => {
      if (current.path) found.push(current)
      current = {}
    }
    for (const line of output.split("\n")) {
      if (!line) finish()
      else if (line.startsWith("worktree ")) current.path = line.slice("worktree ".length)
      else if (line.startsWith("branch ")) current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "")
      else if (line === "detached") current.detached = true
    }
    finish()
    const mainPath = await realpath(candidate.worktrees.find((worktree) => worktree.kind === "main")?.path ?? candidate.path)
    const worktrees: Array<RepositoryCandidate["worktrees"][number]> = []
    for (const item of found) {
      if (!item.path || !item.branch) continue
      const path = await realpath(item.path)
      const dirty = (await git(path, ["status", "--porcelain"])).length > 0
      const worktree: RepositoryCandidate["worktrees"][number] = {
        worktreeId: hash(path),
        branch: item.branch,
        kind: path === mainPath ? "main" : "worktree",
        dirty,
        path,
      }
      worktrees.push(worktree)
    }
    if (!worktrees.length) return candidate
    return { ...candidate, path: mainPath, worktrees }
  } catch {
    // A stale or inaccessible configured path remains visible as the static inventory entry.
    return candidate
  }
}

function localCandidates(map: RepoMapV1): RepositoryCandidate[] {
  const grouped = new Map<string, { host: string; name: string; repoId: string; rows: RepoMapRepository[] }>()
  for (const repository of map.repositories) {
    const key = `${repository.host}\0${repository.name}\0${repository.repoId}`
    const group = grouped.get(key) ?? { host: repository.host, name: repository.name, repoId: repository.repoId, rows: [] }
    group.rows.push(repository)
    grouped.set(key, group)
  }
  return [...grouped.values()].map((group) => {
    const worktrees = group.rows.flatMap((repository) => repository.worktrees.map((worktree) => ({ ...worktree, path: repository.path })))
    const main = worktrees.find((worktree) => worktree.kind === "main")
    return {
      nodeId: map.nodeId,
      host: group.host,
      name: group.name,
      path: main?.path ?? worktrees[0]?.path ?? group.rows[0]!.path,
      repoId: group.repoId,
      worktrees,
    }
  })
}

export function listLocalRepositories(map: RepoMapV1 | undefined, query?: string) {
  return (map ? localCandidates(map) : []).filter((candidate) => matches(candidate, query))
}

/** Refresh known repositories from Git itself; this finds newly-created worktrees without scanning the filesystem. */
export async function listLiveLocalRepositories(map: RepoMapV1 | undefined, query?: string) {
  const candidates = await Promise.all((map ? localCandidates(map) : []).map(liveWorktrees))
  return candidates.filter((candidate) => matches(candidate, query))
}

function matches(candidate: RepositoryCandidate, query: string | undefined) {
  if (!query) return true
  const needle = normalized(query.trim())
  if (!needle) return true
  return [candidate.host, candidate.name, candidate.path, ...candidate.worktrees.flatMap((worktree) => [worktree.path, worktree.branch])]
    .some((value) => normalized(value).includes(needle))
}

/** Local inventory is included first. Each selected peer is queried directly and failures stay visible. */
export async function listRepositories(ports: RepoPorts, input: { readonly peer?: string; readonly query?: string } = {}): Promise<RepositoryList> {
  const repositories = await listLiveLocalRepositories(ports.repoMap, input.query)
  const worktreeRoots: Record<string, string> = {}
  if (ports.repoMap?.worktreeRoot) worktreeRoots[ports.repoMap.nodeId] = ports.repoMap.worktreeRoot
  const peerIds = input.peer ? [input.peer] : Object.keys(ports.remote?.peers ?? {})
  const errors: PeerError[] = []
  for (const peer of peerIds) {
    if (!ports.remote?.peers[peer]) {
      errors.push({ peer, message: "peer is not configured" })
      continue
    }
    try {
      const result = await remoteRequest<{ repositories?: unknown; worktreeRoot?: unknown }>(ports, peer, "repositories", { query: input.query })
      if (!Array.isArray(result.repositories) || result.repositories.length > MAX_REPOSITORIES)
        throw new Error("peer returned an invalid repository inventory")
      if (typeof result.worktreeRoot === "string") worktreeRoots[peer] = result.worktreeRoot
      for (const item of result.repositories) {
        if (!isCandidate(item) || item.nodeId !== peer) throw new Error("peer returned an invalid repository candidate")
        repositories.push({ ...item, peer })
      }
    } catch (error) {
      errors.push({ peer, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return { repositories, worktreeRoots, errors }
}

/** Resolve only on the explicitly selected node; clones of one origin remain distinct by repoId. */
export async function resolveRepository(ports: RepoPorts, selection: { readonly host: string; readonly name: string; readonly repoId?: string; readonly peer?: string }) {
  const listed = await listRepositories(ports, selection.peer ? { peer: selection.peer } : {})
  if (selection.peer && listed.errors.length) throw new Error(`repository peer ${selection.peer} is unavailable: ${listed.errors[0]!.message}`)
  const matches = listed.repositories.filter((candidate) =>
    candidate.host === selection.host && candidate.name === selection.name && (selection.peer ? candidate.peer === selection.peer : candidate.peer === undefined) &&
    (selection.repoId === undefined || candidate.repoId === selection.repoId),
  )
  if (matches.length === 1) return matches[0]!
  if (matches.length > 1) {
    const ids = [...new Set(matches.map((candidate) => candidate.repoId))]
    throw new Error(`repository ${selection.host}/${selection.name} is ambiguous; choose repoId from ${ids.join(", ")}`)
  }
  if (listed.errors.length) throw new Error(`repository was not found; peer errors: ${listed.errors.map((item) => `${item.peer}: ${item.message}`).join("; ")}`)
  throw new Error(`repository ${selection.host}/${selection.name}${selection.repoId ? ` (${selection.repoId})` : ""} was not found`)
}

function isCandidate(value: unknown): value is RepositoryCandidate {
  if (!value || typeof value !== "object") return false
  const candidate = value as RepositoryCandidate
  return typeof candidate.nodeId === "string" && typeof candidate.host === "string" && typeof candidate.name === "string" &&
    typeof candidate.path === "string" && typeof candidate.repoId === "string" && Array.isArray(candidate.worktrees) &&
    candidate.worktrees.every((worktree) => typeof worktree?.worktreeId === "string" && typeof worktree.branch === "string" && typeof worktree.path === "string" &&
      (worktree.kind === "main" || worktree.kind === "worktree") && typeof worktree.dirty === "boolean")
}
