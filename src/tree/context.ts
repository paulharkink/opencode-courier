import { setBounded } from "../platform/bounded.js"
import type { ContextPorts } from "./ports.js"
import { childStore } from "./store.js"
import { ROLE_PREFIX, rolePart } from "./text.js"

/** How many sessions' depths an instance remembers. */
const ROLES_MAX = 1000

/** The part of a session context this hook changes. */
export interface Shaped {
  readonly sessionID: string
  tools: Record<string, unknown>
  system: Array<{ type: "text"; text: string }>
}

/**
 * The `context` hook: names a session's role in its tree in a system part, and hides courier_spawn, and the tools
 * named `hiddenFromLeaf`, from one at `maxDepth`. A session nobody spawned that has started none is pointed to the skill, if it could spawn.
 */
export async function shapeContext(ports: ContextPorts, event: Shaped) {
  await interruptStaleManagedWorker(ports, event.sessionID)
  try {
    const depth = await depthOf(ports, event.sessionID)
    const worker = depth !== null && depth > 0 ? await childStore(ports.storage).indexedEntry(event.sessionID) : undefined
    if (depth === null && !event.tools.courier_spawn) return
    if (worker || (depth !== null && depth >= ports.limits.maxDepth))
      for (const tool of ["courier_spawn", ...(ports.hiddenFromLeaf ?? [])]) delete event.tools[tool]
    if (!event.system.some((part) => part.text.startsWith(ROLE_PREFIX)))
      event.system.push({ type: "text", text: rolePart(depth, ports.limits, Boolean(worker)) })
  } catch (error) {
    ports.log(`courier: cannot tell the role of session ${event.sessionID}: ${String(error)}`)
  }
}

/** Stop a managed task from an earlier OpenCode process before context reaches the model/provider. */
async function interruptStaleManagedWorker(ports: ContextPorts, sessionID: string) {
  if (!ports.generationID || !ports.session) return
  let session
  try {
    session = await ports.session.get({ sessionID })
  } catch {
    return
  }
  const metadata = session.metadata && typeof session.metadata === "object" ? session.metadata as Record<string, unknown> : {}
  const courier = metadata.courier && typeof metadata.courier === "object" ? metadata.courier as Record<string, unknown> : {}
  if (courier.managed !== true || typeof courier.generationID !== "string" || courier.generationID === ports.generationID) return
  await ports.session.interrupt({ sessionID, resume: false }).catch((error: unknown) => {
    ports.log(`courier: stale managed worker ${sessionID} could not be interrupted: ${String(error)}`)
  })
  throw new Error(`stale managed worker ${sessionID} was interrupted before its task could resume`)
}

async function depthOf(ports: ContextPorts, sessionID: string) {
  const known = ports.roles.get(sessionID)
  if (known !== undefined) return known
  // The reverse index alone: a scan here would run for every session's first request, courier or not.
  const children = childStore(ports.storage)
  const chain = await children.indexedLineage(sessionID)
  const depth = chain.length || ((await children.children(sessionID)).length ? 0 : null)
  setBounded(ports.roles, sessionID, depth, ROLES_MAX)
  return depth
}
