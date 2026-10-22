import { readFileSync } from "node:fs"
import { isAbsolute } from "node:path"
import { obj, str } from "../platform/json.js"

/** The node-local AACT repo-map file. Peer secret paths are references; this module never reads or returns key contents. */
export interface RepoMapV1 {
  readonly version: 1
  readonly nodeId: string
  readonly worktreeRoot?: string
  readonly repositories: ReadonlyArray<RepoMapRepository>
  readonly peers: ReadonlyArray<RepoMapPeer>
}

export interface RepoMapRepository {
  readonly host: string
  readonly name: string
  readonly path: string
  readonly repoId: string
  readonly worktrees: ReadonlyArray<RepoMapWorktree>
}

export interface RepoMapWorktree {
  readonly worktreeId: string
  readonly branch: string
  readonly kind: "main" | "worktree"
  readonly dirty: boolean
  /** Added by Courier while parsing AACT's one-row-per-checkout inventory. */
  readonly path?: string
}

export interface RepoMapPeer {
  readonly peerId: string
  readonly url: string
  readonly secretFile: string
  readonly allowedRoots: ReadonlyArray<string>
}

const ID = /^[A-Za-z0-9_.:-]{1,128}$/
const NODE_ID = /^[A-Za-z0-9_.-]{1,64}$/

/** Parse only the public shape. The peer's secretFile remains a local path and is never dereferenced here. */
export function parseRepoMap(value: unknown): RepoMapV1 {
  const input = obj(value)
  if (input.version !== 1) throw new Error("repo map version must be 1")
  const nodeId = str(input.nodeId)
  if (!nodeId || !NODE_ID.test(nodeId)) throw new Error("repo map nodeId is invalid")
  const worktreeRoot = str(input.worktreeRoot)
  if (worktreeRoot !== undefined && !isAbsolute(worktreeRoot)) throw new Error("repo map worktreeRoot must be an absolute path")
  if (!Array.isArray(input.repositories)) throw new Error("repo map repositories must be an array")
  if (!Array.isArray(input.peers)) throw new Error("repo map peers must be an array")

  const repositories = input.repositories.map((value, index): RepoMapRepository => {
    const repo = obj(value)
    const host = str(repo.host)
    const name = str(repo.name)
    const path = str(repo.path)
    const repoId = str(repo.repoId)
    if (!host || !name || !path || !repoId || !ID.test(repoId)) throw new Error(`repo map repositories[${index}] is missing a valid host, name, path or repoId`)
    if (!Array.isArray(repo.worktrees)) throw new Error(`repo map repositories[${index}].worktrees must be an array`)
    const worktrees = repo.worktrees.map((value, worktreeIndex): RepoMapWorktree => {
      const worktree = obj(value)
      const worktreeId = str(worktree.worktreeId)
      const branch = str(worktree.branch)
      if (!worktreeId || !ID.test(worktreeId) || !branch || (worktree.kind !== "main" && worktree.kind !== "worktree") || typeof worktree.dirty !== "boolean")
        throw new Error(`repo map repositories[${index}].worktrees[${worktreeIndex}] is invalid`)
      return { worktreeId, branch, kind: worktree.kind, dirty: worktree.dirty, path }
    })
    return { host, name, path, repoId, worktrees }
  })

  const seenPeers = new Set<string>()
  const peers = input.peers.map((value, index): RepoMapPeer => {
    const peer = obj(value)
    const peerId = str(peer.peerId)
    const url = str(peer.url)
    const secretFile = str(peer.secretFile)
    if (!peerId || !NODE_ID.test(peerId) || peerId === nodeId || seenPeers.has(peerId) || !url || !secretFile)
      throw new Error(`repo map peers[${index}] is invalid`)
    seenPeers.add(peerId)
    if (!Array.isArray(peer.allowedRoots) || peer.allowedRoots.some((root) => typeof root !== "string" || !root.startsWith("/")))
      throw new Error(`repo map peers[${index}].allowedRoots must be an array of absolute paths`)
    return { peerId, url, secretFile, allowedRoots: peer.allowedRoots as string[] }
  })

  return { version: 1, nodeId, ...(worktreeRoot ? { worktreeRoot } : {}), repositories, peers }
}

export function readRepoMap(file: string): RepoMapV1 {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"))
  } catch (error) {
    throw new Error(`repoMapFile could not be read or parsed: ${error instanceof Error ? error.message : String(error)}`)
  }
  return parseRepoMap(parsed)
}
