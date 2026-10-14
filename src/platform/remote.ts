import { randomUUID, createHmac, timingSafeEqual } from "node:crypto"
import { readFileSync } from "node:fs"
import { realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { obj, str } from "./json.js"

const NODE_ID = /^[A-Za-z0-9_.-]{1,64}$/

export interface RemotePeer {
  readonly url: string
  readonly secret: string
  readonly allowedRoots: readonly string[]
}

export interface RemoteConfig {
  readonly nodeId: string
  readonly peers: Readonly<Record<string, RemotePeer>>
}

export interface RemoteEnvelope {
  readonly version: 1
  readonly id: string
  readonly sender: string
  readonly operation: string
  readonly payload: unknown
}

export interface PreparedRemote {
  readonly sessionID: string
  readonly directory: string
  readonly title: string
  readonly worktree?: string
  readonly project?: string
  readonly base?: string
}

const expandHome = (path: string) => path.replace(/^~(?=$|\/)/, homedir())

/** Reads peer keys only from files; options and logs never carry the key material. */
export function readRemoteConfig(options: unknown): RemoteConfig | undefined {
  const given = obj(options).remoteNodes
  if (given === undefined || given === false) return undefined
  const config = obj(given)
  const nodeId = str(config.nodeId)
  if (!nodeId || !NODE_ID.test(nodeId)) throw new Error("remoteNodes.nodeId must be 1 to 64 letters, digits, dots, underscores or dashes")
  const peers = obj(config.peers)
  const parsed: Record<string, RemotePeer> = {}
  for (const [id, raw] of Object.entries(peers)) {
    const peer = obj(raw)
    if (!NODE_ID.test(id) || id === nodeId) throw new Error(`remoteNodes peer id ${JSON.stringify(id)} is invalid`)
    const endpoint = str(peer.url)
    let url: URL
    try {
      url = new URL(endpoint ?? "")
    } catch {
      throw new Error(`remoteNodes.peers.${id}.url must be an HTTP or HTTPS endpoint`)
    }
    if (!(["http:", "https:"].includes(url.protocol)) || url.username || url.password || url.search || url.hash)
      throw new Error(`remoteNodes.peers.${id}.url must be an HTTP or HTTPS endpoint without credentials, query or fragment`)
    const file = str(peer.secretFile)?.trim()
    if (!file) throw new Error(`remoteNodes.peers.${id}.secretFile is required`)
    let secret: string
    try {
      secret = readFileSync(expandHome(file), "utf8").trim()
    } catch {
      throw new Error(`remoteNodes.peers.${id}.secretFile could not be read`)
    }
    if (!secret) throw new Error(`remoteNodes.peers.${id}.secretFile is empty`)
    const rawRoots = peer.allowedRoots === undefined ? [] : peer.allowedRoots
    if (!Array.isArray(rawRoots) || rawRoots.some((root) => typeof root !== "string" || !isAbsolute(root)))
      throw new Error(`remoteNodes.peers.${id}.allowedRoots must be an array of absolute paths`)
    parsed[id] = {
      url: url.toString().replace(/\/$/, ""),
      secret,
      allowedRoots: [...new Set((rawRoots as string[]).map((root) => resolve(root)))],
    }
  }
  return { nodeId, peers: parsed }
}

export const qualify = (nodeId: string, sessionID: string) => `${nodeId}/${sessionID}`

export function remoteTarget(ports: { readonly remote?: RemoteConfig }, sessionID: string) {
  const address = splitQualified(sessionID)
  if (!address) return undefined
  if (!ports.remote?.peers[address.nodeId]) throw new Error(`remote peer ${address.nodeId} is not configured`)
  return address
}

export function remoteRequest<T>(ports: { readonly remote?: RemoteConfig }, peer: string, operation: string, payload: unknown) {
  if (!ports.remote) throw new Error("remoteNodes is not configured")
  return requestPeer<T>(ports.remote, peer, operation, payload)
}

export function splitQualified(value: string) {
  const slash = value.indexOf("/")
  if (slash <= 0 || slash === value.length - 1 || value.indexOf("/", slash + 1) !== -1) return undefined
  const nodeId = value.slice(0, slash)
  const sessionID = value.slice(slash + 1)
  return NODE_ID.test(nodeId) && sessionID.trim() === sessionID ? { nodeId, sessionID } : undefined
}

export function signature(secret: string, body: string | Uint8Array) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`
}

export function validSignature(secret: string, body: Uint8Array, header: string | undefined) {
  const hex = header?.match(/^sha256=([0-9a-fA-F]{64})$/)?.[1]
  if (!hex) return false
  return timingSafeEqual(Buffer.from(hex, "hex"), createHmac("sha256", secret).update(body).digest())
}

export function parseEnvelope(value: unknown): RemoteEnvelope | undefined {
  const envelope = obj(value)
  const id = str(envelope.id)
  const sender = str(envelope.sender)
  const operation = str(envelope.operation)
  if (envelope.version !== 1 || !id || id.length > 128 || !sender || !NODE_ID.test(sender) || !operation || !/^[a-z][a-zA-Z]{0,31}$/.test(operation)) return undefined
  if (!Object.hasOwn(envelope, "payload")) return undefined
  return { version: 1, id, sender, operation, payload: envelope.payload }
}

export async function withinRoots(directory: string, roots: readonly string[]) {
  if (!isAbsolute(directory)) return false
  let target: string
  try {
    target = await realpath(directory)
  } catch {
    return false
  }
  for (const root of roots) {
    let base: string
    try {
      base = await realpath(root)
    } catch {
      continue
    }
    const rel = relative(base, target)
    if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) return true
  }
  return false
}

export async function requestPeer<T>(config: RemoteConfig, peerId: string, operation: string, payload: unknown, fetcher: typeof fetch = fetch): Promise<T> {
  const peer = config.peers[peerId]
  if (!peer) throw new Error(`remote peer ${peerId} is not configured on ${config.nodeId}`)
  const envelope: RemoteEnvelope = { version: 1, id: randomUUID(), sender: config.nodeId, operation, payload }
  const body = JSON.stringify(envelope)
  let response: Response
  try {
    response = await fetcher(`${peer.url}/courier`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-courier-signature": signature(peer.secret, body) },
      body,
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    throw new Error(`remote peer ${peerId} request failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  const text = await response.text()
  let result: unknown
  try {
    result = JSON.parse(text)
  } catch {
    throw new Error(`remote peer ${peerId} returned an invalid response (${response.status})`)
  }
  if (!response.ok) throw new Error(str(obj(result).error) ?? `remote peer ${peerId} refused the request (${response.status})`)
  return obj(result).result as T
}
