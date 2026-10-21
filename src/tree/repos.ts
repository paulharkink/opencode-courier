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

function matches(candidate: RepositoryCandidate, query: string | undefined) {
  if (!query) return true
  const needle = normalized(query.trim())
  if (!needle) return true
  return [candidate.host, candidate.name, candidate.path, ...candidate.worktrees.map((worktree) => worktree.branch)]
    .some((value) => normalized(value).includes(needle))
}

/** Local inventory is included first. Each selected peer is queried directly and failures stay visible. */
export async function listRepositories(ports: RepoPorts, input: { readonly peer?: string; readonly query?: string } = {}): Promise<RepositoryList> {
  const repositories = listLocalRepositories(ports.repoMap, input.query)
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
