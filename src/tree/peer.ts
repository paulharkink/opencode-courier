import { isAbsolute } from "node:path"
import { splitQualified, withinRoots, type PreparedRemote, type RemoteEnvelope } from "../platform/remote.js"
import { obj, str } from "../platform/json.js"
import { STATUSES } from "../kernel/protocol.js"
import type { CleanupPorts, CourierPorts, RosterEntry } from "./ports.js"
import { childStore } from "./store.js"
import { childBrief, childBranch } from "./text.js"
import { status } from "./status.js"
import { cleanup } from "./cleanup.js"
import { send } from "./send.js"
import { forgetWakes } from "./wake.js"

const MAX_TASK = 40_000
const WORK_NAME = /^[^\r\n]{1,120}$/

export async function handleRemote(ports: CourierPorts, cleanupPorts: CleanupPorts, request: RemoteEnvelope) {
  const input = obj(request.payload)
  switch (request.operation) {
    case "prepare":
      return prepare(ports, request.sender, input)
    case "start":
      return start(ports, request.sender, input)
    case "send":
      return receiveSend(ports, request.sender, input)
    case "status":
      await childOwnedBy(ports, request.sender, requiredString(input.sessionID, "sessionID"))
      return status(ports, { sessionID: requiredString(input.sessionID, "sessionID") })
    case "interrupt": {
      const sessionID = requiredString(input.sessionID, "sessionID")
      await childOwnedBy(ports, request.sender, sessionID)
      await forgetWakes(ports, sessionID).catch((error: unknown) => ports.log(`courier_stop: could not drop the wake watch of ${sessionID}: ${String(error)}`))
      return ports.session.interrupt({ sessionID })
    }
    case "cleanup": {
      const sessionID = requiredString(input.sessionID, "sessionID")
      const entry = await childOwnedBy(ports, request.sender, sessionID)
      if (entry.parentID !== requiredString(input.parentID, "parentID")) throw new Error("cleanup parent does not own this session")
      return cleanup(cleanupPorts, requiredString(input.parentID, "parentID"), {
        sessionID,
        force: input.force === true,
      })
    }
    default:
      throw new Error(`unsupported Courier operation ${request.operation}`)
  }
}

async function prepare(ports: CourierPorts, sender: string, input: Record<string, any>): Promise<PreparedRemote> {
  const peer = ports.remote?.peers[sender]
  if (!peer) throw new Error("requesting node is not configured")
  const directory = requiredString(input.directory, "directory")
  if (!isAbsolute(directory) || !(await withinRoots(directory, peer.allowedRoots))) throw new Error("directory is outside this peer's allowed roots or does not exist")
  const task = requiredString(input.task, "task")
  if (task.length > MAX_TASK) throw new Error(`task is over ${MAX_TASK} characters`)
  const workName = requiredString(input.workName, "workName").trim()
  if (!WORK_NAME.test(workName)) throw new Error("workName must be 1 to 120 characters on one line")
  const agent = optionalString(input.agent, "agent")
  const title = optionalString(input.title, "title") ?? (task.trim().split("\n")[0] ?? "").slice(0, 60)
  if (title.length > 200 || (agent && agent.length > 128)) throw new Error("title or agent is too long")
  const parentModel = validModel(input.parentModel)
  let model = parentModel
  if (agent) {
    const selected = await ports.agent.get({ agentID: agent, location: { directory } })
    if (selected.data.model) model = undefined
  }
  let worktree: string | undefined
  try {
    if (input.isolate === true) worktree = (await ports.worktree.create({ projectID: ports.projectID })).directory
    const base = worktree ? await ports.head(worktree) : undefined
    const child = await ports.session.create({
      title,
      ...(agent ? { agent } : {}),
      ...(model ? { model } : {}),
      location: { directory: worktree ?? directory },
      metadata: {
        courier: {
          remotePreparedBy: sender,
          workName,
          remoteSourceDirectory: directory,
          remoteIsolated: worktree !== undefined,
          ...(worktree ? { remoteProject: ports.projectID } : {}),
          ...(base ? { remoteBase: base } : {}),
        },
      },
    })
    return {
      sessionID: child.id,
      directory: worktree ?? child.location.directory,
      title,
      ...(worktree ? { worktree, project: ports.projectID } : {}),
      ...(base ? { base } : {}),
    }
  } catch (error) {
    if (worktree) await ports.worktree.remove({ projectID: ports.projectID, directory: worktree, force: false }).catch(() => undefined)
    throw error
  }
}

async function start(ports: CourierPorts, sender: string, input: Record<string, any>) {
  const sessionID = requiredString(input.sessionID, "sessionID")
  const parentID = requiredString(input.parentID, "parentID")
  const task = requiredString(input.task, "task")
  const workName = requiredString(input.workName, "workName").trim()
  if (!WORK_NAME.test(workName)) throw new Error("workName must be 1 to 120 characters on one line")
  const depth = input.depth === undefined ? 1 : input.depth
  if (!Number.isInteger(depth) || depth < 1 || depth > 64) throw new Error("depth is invalid")
  const prepared = await ports.session.get({ sessionID })
  const metadata = obj(prepared.metadata)
  const courier = obj(metadata.courier)
  const parent = splitQualified(parentID)
  if (parent?.nodeId !== sender || courier.remotePreparedBy !== sender || courier.workName !== workName)
    throw new Error("prepared session does not match the requesting node and workName")
  if (typeof courier.remoteSourceDirectory !== "string" || typeof courier.remoteIsolated !== "boolean")
    throw new Error("prepared session is missing its remote directory metadata")
  const entry: RosterEntry = {
    sessionID,
    parentID,
    title: requiredString(optionalString(input.title, "title") ?? prepared.title, "title"),
    directory: prepared.location.directory,
    isolated: courier.remoteIsolated,
    createdAt: ports.now(),
    reports: "status",
    workName,
    ...(courier.remoteIsolated ? { source: courier.remoteSourceDirectory, project: optionalString(courier.remoteProject, "remoteProject") } : {}),
    ...(typeof courier.remoteBase === "string" ? { base: courier.remoteBase } : {}),
  }
  await childStore(ports.storage).record(entry)
  await childStore(ports.storage).prompted(sessionID, ports.now())
  try {
    await ports.session.prompt({
      sessionID,
      text: childBrief(parentID, task, depth, ports.limits, entry.isolated ? childBranch(sessionID) : undefined, workName),
    })
  } catch (error) {
    await childStore(ports.storage).settled(sessionID, "failed", ports.now()).catch(() => undefined)
    throw error
  }
  return { sessionID, directory: prepared.location.directory, workName }
}

async function receiveSend(ports: CourierPorts, sender: string, input: Record<string, any>) {
  const sessionID = requiredString(input.sessionID, "sessionID")
  const from = requiredString(input.from, "from")
  const outbound = checkedSend(input)
  const address = splitQualified(from)
  if (address?.nodeId === sender) {
    const recipient = splitQualified(sessionID)
    if (recipient && recipient.nodeId !== ports.remote?.nodeId) throw new Error("recipient node does not match this service")
    const localSessionID = recipient?.sessionID ?? sessionID
    const children = childStore(ports.storage)
    const senderChild = await children.indexedEntry(from)
    if (senderChild?.parentID === localSessionID)
      return send(ports, from, { sessionID: localSessionID, ...outbound })
    const recipientChild = await children.indexedEntry(localSessionID)
    if (recipientChild?.parentID === from)
      return send(ports, from, { sessionID: localSessionID, ...outbound })
    throw new Error("sender and recipient are not a parent and child")
  }
  throw new Error(address ? "sender node does not match authenticated peer" : "sender session must include its node id")
}

function checkedSend(input: Record<string, any>) {
  const message = requiredString(input.message, "message")
  if (message.length > MAX_TASK) throw new Error(`message is over ${MAX_TASK} characters`)
  if (input.status !== undefined && !STATUSES.includes(input.status)) throw new Error("status is invalid")
  if (input.queue !== undefined && typeof input.queue !== "boolean") throw new Error("queue must be a boolean")
  let artifacts: Record<string, unknown> | undefined
  if (input.artifacts !== undefined) {
    const raw = obj(input.artifacts)
    const list = (name: string) => {
      const items = raw[name]
      if (items === undefined) return undefined
      if (!Array.isArray(items) || items.length > 100 || items.some((item) => typeof item !== "string" || item.length > 4_000))
        throw new Error(`artifacts.${name} is invalid`)
      return items
    }
    if (raw.branch !== undefined && (typeof raw.branch !== "string" || raw.branch.length > 4_000)) throw new Error("artifacts.branch is invalid")
    const checks = raw.checks
    if (checks !== undefined && (!Array.isArray(checks) || checks.length > 100 || checks.some((item) => {
      const check = obj(item)
      return typeof check.command !== "string" || typeof check.result !== "string" || check.command.length > 4_000 || check.result.length > 4_000
    }))) throw new Error("artifacts.checks is invalid")
    artifacts = {
      ...(raw.branch !== undefined ? { branch: raw.branch } : {}),
      ...(list("commits") ? { commits: list("commits") } : {}),
      ...(list("files") ? { files: list("files") } : {}),
      ...(checks ? { checks } : {}),
    }
  }
  return { message, ...(input.status !== undefined ? { status: input.status } : {}), ...(artifacts ? { artifacts } : {}), ...(input.queue === true ? { queue: true } : {}) }
}

async function childOwnedBy(ports: CourierPorts, sender: string, sessionID: string) {
  const entry = await childStore(ports.storage).indexedEntry(sessionID)
  const parent = entry && splitQualified(entry.parentID)
  if (!entry || parent?.nodeId !== sender) throw new Error("session is not a child of the requesting node")
  return entry
}

function requiredString(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`)
  return value
}

function optionalString(value: unknown, name: string) {
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string") throw new Error(`${name} must be a string`)
  return value
}

function validModel(value: unknown): NonNullable<NonNullable<Parameters<CourierPorts["session"]["create"]>[0]>["model"]> | undefined {
  const model = obj(value)
  if (typeof model.id !== "string" || typeof model.providerID !== "string") return undefined
  return { id: model.id, providerID: model.providerID, ...(typeof model.variant === "string" ? { variant: model.variant } : {}) }
}
