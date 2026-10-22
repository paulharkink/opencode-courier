import { isNotFound } from "../platform/json.js"
import { remoteRequest, remoteTarget } from "../platform/remote.js"
import { busy, type RosterEntry } from "./domain.js"
import type { IdentityManager } from "./session.js"
import type { StopPorts } from "./ports.js"
import { childStore } from "./store.js"
import { releaseWorkspace } from "./workspace.js"
import { forgetWakes } from "./wake.js"

export interface ClosePorts extends StopPorts {
  readonly identity: IdentityManager
}

export interface CloseResult {
  readonly closedSessionIDs: ReadonlyArray<string>
  readonly releasedAssignments: ReadonlyArray<string>
  readonly errors: ReadonlyArray<{ readonly sessionID: string; readonly message: string }>
  readonly rootClosed: boolean
  readonly retainedWorkspaces: true
}

/** Stops and releases named assignments while keeping session history, branches and worktrees intact. */
export async function close(ports: ClosePorts, callerID: string, targetID: string): Promise<CloseResult> {
  const caller = await ports.courier.session.get({ sessionID: callerID })
  const root = await ports.identity.get(callerID, caller.projectID)
  const isRootClose = callerID === targetID && root !== undefined
  if (isRootClose) {
    const children = await childStore(ports.courier.storage).children(callerID)
    const results = await Promise.all(children.map((entry) => closeEntry(ports, callerID, entry)))
    const closedSessionIDs = results.flatMap((result) => result.closed ? [result.sessionID] : [])
    const releasedAssignments = results.flatMap((result) => result.released ? [result.assignmentID!] : [])
    const errors = results.flatMap((result) => result.error ? [{ sessionID: result.sessionID, message: result.error }] : [])
    const rootClosed = errors.length === 0
    if (rootClosed) await ports.identity.unregister(callerID, caller.projectID)
    return { closedSessionIDs, releasedAssignments, errors, rootClosed, retainedWorkspaces: true }
  }

  const entry = await childStore(ports.courier.storage).indexedEntry(targetID)
  if (!entry) {
    const remote = root ? remoteTarget(ports.courier, targetID) : undefined
    if (remote) {
      const stopped = await remoteRequest<{ stopped: true }>(ports.courier, remote.nodeId, "abortPreparedRepo", {
        sessionID: remote.sessionID,
        parentID: callerID,
      })
      if (!stopped.stopped) throw new Error(`Courier could not confirm ${targetID} stopped; its assignment remains owned.`)
      const assignment = [...(ports.courier.gate.assignments?.values() ?? [])].find((item) => item.sessionID === targetID)
      if (assignment) await releaseWorkspace(ports.courier.gate, assignment.assignmentID, true)
      return {
        closedSessionIDs: [targetID],
        releasedAssignments: assignment ? [assignment.assignmentID] : [],
        errors: [],
        rootClosed: false,
        retainedWorkspaces: true,
      }
    }
    throw new Error(`${targetID} is not a Courier worker session.`)
  }
  const lineage = await childStore(ports.courier.storage).lineage(targetID)
  if (!lineage.some((item) => item.parentID === callerID || (root && item.rootSessionID === root.sessionID)))
    throw new Error(`${callerID} is not the Head Unit or an owner above ${targetID}.`)
  const result = await closeEntry(ports, callerID, entry)
  return {
    closedSessionIDs: result.closed ? [result.sessionID] : [],
    releasedAssignments: result.released && result.assignmentID ? [result.assignmentID] : [],
    errors: result.error ? [{ sessionID: result.sessionID, message: result.error }] : [],
    rootClosed: false,
    retainedWorkspaces: true,
  }
}

async function closeEntry(ports: ClosePorts, callerID: string, entry: RosterEntry) {
  const { sessionID } = entry
  try {
    const remote = remoteTarget(ports.courier, sessionID)
    if (remote) {
      await remoteRequest<{ stopped: true }>(ports.courier, remote.nodeId, "interrupt", {
        sessionID: remote.sessionID,
        parentID: callerID,
        resume: false,
      })
    } else {
      await ports.courier.session.interrupt({ sessionID, resume: false })
      await ports.courier.session.wait({ sessionID })
      const latest = await ports.courier.session.get({ sessionID })
      if (busy(latest.time)) throw new Error("OpenCode did not confirm the session stopped")
    }

    await ports.cancelScheduled(sessionID).catch((error: unknown) => ports.courier.log(`courier_close: scheduled messages for ${sessionID} remain: ${String(error)}`))
    await forgetWakes(ports.courier, sessionID).catch((error: unknown) => ports.courier.log(`courier_close: wake state for ${sessionID} remains: ${String(error)}`))
    await childStore(ports.courier.storage).settled(sessionID, "interrupted", ports.courier.now()).catch(() => undefined)
    if (entry.assignmentID) await releaseWorkspace(ports.courier.gate, entry.assignmentID, true)
    return { sessionID, assignmentID: entry.assignmentID, closed: true, released: Boolean(entry.assignmentID) }
  } catch (error) {
    if (isNotFound(error)) return { sessionID, assignmentID: entry.assignmentID, closed: false, released: false, error: "session is no longer available to confirm it stopped; assignment remains owned" }
    return { sessionID, assignmentID: entry.assignmentID, closed: false, released: false, error: error instanceof Error ? error.message : String(error) }
  }
}
