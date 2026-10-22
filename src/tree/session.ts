import type { Storage } from "../platform/storage.js"

/** The named, user-facing root of one managed Courier tree. */
export interface RootIdentity {
  readonly sessionID: string
  readonly projectID: string
  readonly name: string
}

/** Session and project scoped identity operations used by the root tool and spawn path. */
export interface IdentityManager {
  register(sessionID: string, projectID: string, name: string): Promise<RootIdentity>
  get(sessionID: string, projectID: string): Promise<RootIdentity | undefined>
  assertRoot(sessionID: string, projectID: string): Promise<RootIdentity>
  unregister(sessionID: string, projectID: string): Promise<void>
  deriveName(root: RootIdentity, label: string): string
}

const PREFIX = "tree/root-identity/v1/"
const MAX_NAME_LENGTH = 60
type StorageValue = Parameters<Storage["set"]>[1]

function keyOf(sessionID: string, projectID: string) {
  return `${PREFIX}${encodeURIComponent(projectID)}/${encodeURIComponent(sessionID)}`
}

function identityPart(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value))
    throw new Error(`${field} must be a non-empty string without control characters.`)
  return value.trim()
}

function namePart(value: unknown, field: "Root name" | "Child label") {
  const name = identityPart(value, field)
  if (name.length > MAX_NAME_LENGTH || name.includes("/") || name.includes("\\"))
    throw new Error(`${field} must be at most ${MAX_NAME_LENGTH} characters and cannot contain path separators.`)
  return name
}

function readIdentity(value: unknown, sessionID: string, projectID: string): RootIdentity | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.sessionID !== sessionID || record.projectID !== projectID || typeof record.name !== "string") return undefined
  try {
    return { sessionID, projectID, name: namePart(record.name, "Root name") }
  } catch {
    return undefined
  }
}

/**
 * Creates the identity store over OpenCode's plugin storage. This module intentionally handles
 * identity persistence only; callers enforce that only an eligible user-facing session registers.
 */
export function createIdentityManager(storage: Storage): IdentityManager {
  return {
    async register(sessionID, projectID, rawName) {
      const session = identityPart(sessionID, "Session ID")
      const project = identityPart(projectID, "Project ID")
      const name = namePart(rawName, "Root name")
      const identity: RootIdentity = { sessionID: session, projectID: project, name }
      await storage.set(keyOf(session, project), identity as unknown as StorageValue)
      return identity
    },

    async get(sessionID, projectID) {
      if (typeof sessionID !== "string" || !sessionID.trim() || typeof projectID !== "string" || !projectID.trim()) return undefined
      const session = sessionID.trim()
      const project = projectID.trim()
      return readIdentity(await storage.get(keyOf(session, project)), session, project)
    },

    async assertRoot(sessionID, projectID) {
      const identity = await this.get(sessionID, projectID)
      if (!identity) throw new Error(`Session ${sessionID} is not registered as a Courier root in project ${projectID}.`)
      return identity
    },

    async unregister(sessionID, projectID) {
      const session = identityPart(sessionID, "Session ID")
      const project = identityPart(projectID, "Project ID")
      await storage.remove(keyOf(session, project))
    },

    deriveName(root, label) {
      return deriveName(root, label)
    },
  }
}

/** Constructs the stable child work name from the registered root and caller-supplied label. */
export function deriveName(root: RootIdentity, rawLabel: string): string {
  const rootName = namePart(root?.name, "Root name")
  const label = namePart(rawLabel, "Child label")
  return `${rootName}/${label}`
}
