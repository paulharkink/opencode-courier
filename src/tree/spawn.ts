import { describeFailure } from "../kernel/protocol.js"
import { busy, isGroupName } from "./domain.js"
import { joinGroup, leaveGroup } from "./group.js"
import { admit } from "./limits.js"
import type { CourierPorts, RosterEntry } from "./ports.js"
import { childStore, groupStore } from "./store.js"
import { childBrief, childBranch } from "./text.js"
import { qualify } from "../platform/remote.js"
import { remoteRequest, type PreparedRemote } from "../platform/remote.js"
import { splitQualified } from "../platform/remote.js"
import { resolveRepository } from "./repos.js"
import { createIdentityManager } from "./session.js"
import { acquireWorkspace, type BranchIntent, type CheckoutIntent, type WorkspaceAssignment } from "./workspace.js"
import { releaseWorkspace } from "./workspace.js"

export interface SpawnInput {
  readonly task: string
  readonly title?: string
  readonly agent?: string
  readonly isolate?: boolean
  readonly group?: string
  readonly peer?: string
  readonly directory?: string
  readonly workName?: string
  readonly repo?: { readonly host: string; readonly name: string; readonly repoId?: string }
  readonly branch?: BranchIntent
  readonly checkout?: CheckoutIntent
}

function titleOf(task: string) {
  const line = task.trim().split("\n")[0] ?? ""
  return line.length > 60 ? `${line.slice(0, 57)}...` : line
}

/**
 * The model a child runs on: its parent's, so it does not fall back to OpenCode's default, which
 * the parent may have been moved off for a reason. An agent that names its own model keeps it.
 */
async function inheritedModel(ports: CourierPorts, parentID: string, agent: string | undefined, directory = ports.directory) {
  const parent = await ports.session.get({ sessionID: parentID })
  if (!parent.model || !agent) return parent.model
  const named = await ports.agent.get({ agentID: agent, location: { directory } })
  return named.data.model ? undefined : parent.model
}

/** Removes a worktree made for a child that was never created; one that cannot be removed stays. */
async function dropWorktree(ports: CourierPorts, directory: string) {
  try {
    await ports.worktree.remove({ projectID: ports.projectID, directory, force: false })
  } catch {
    // The spawn's own failure is the one to report.
  }
}

/**
 * Creates a child session, hands it the task and returns at once; the child reports back with
 * courier_send. Refused past a limit, whether or not the `context` hook hid the tool.
 */
export async function spawn(ports: CourierPorts, parentID: string, input: SpawnInput) {
  // Some models send null, or an empty string, for an optional field they leave out.
  const group = typeof input.group === "string" ? input.group.trim() || undefined : (input.group ?? undefined)
  if (group !== undefined && !isGroupName(group))
    throw new Error(`group must be a name of 1 to 60 letters, digits, dots, dashes or underscores, not ${JSON.stringify(group)}.`)
  const parent = await childStore(ports.storage).indexedEntry(parentID)
  if (parent) throw new Error("Courier workers cannot start child sessions; ask the Head Unit to dispatch the work")
  if (input.repo) return spawnRepository(ports, parentID, input, group)
  if (input.peer !== undefined || input.directory !== undefined || input.workName !== undefined) {
    if (!input.peer || !input.directory || !input.workName?.trim())
      throw new Error("a remote spawn requires peer, an absolute directory on that peer, and workName")
    if (!ports.remote?.peers[input.peer]) throw new Error(`remote peer ${input.peer} is not configured`)
    const admitted = await admit(ports, parentID)
    try {
      return await startRemote(ports, parentID, input, admitted, group)
    } finally {
      admitted.release()
    }
  }
  const admitted = await admit(ports, parentID)
  try {
    return await start(ports, parentID, input, admitted, group)
  } finally {
    admitted.release()
  }
}

async function spawnRepository(ports: CourierPorts, parentID: string, input: SpawnInput, group: string | undefined) {
  if (input.directory !== undefined || input.isolate !== undefined) throw new Error("repo-map spawn cannot be combined with legacy directory or isolate options")
  if (!input.workName?.trim()) throw new Error("repo-map spawn requires a caller-supplied workName label")
  if (!input.branch || !input.checkout) throw new Error("repo-map spawn requires explicit branch and checkout intents")
  if (input.workName.length > 60 || /[\r\n/\\]/.test(input.workName.trim())) throw new Error("workName must be a short label without path separators")
  const identity = createIdentityManager(ports.storage)
  const parentSession = await ports.session.get({ sessionID: parentID })
  const root = await identity.assertRoot(parentID, parentSession.projectID)
  const workName = identity.deriveName(root, input.workName)
  const repository = await resolveRepository(ports, { ...input.repo!, ...(input.peer ? { peer: input.peer } : {}) })
  if (repository.peer) return spawnRemoteRepository(ports, parentID, input, group, root, workName, repository)
  if (!ports.repoMap) throw new Error("repoMapFile is required for local repository work")
  const admitted = await admit(ports, parentID)
  let assignment: WorkspaceAssignment | undefined
  let childID: string | undefined
  try {
    const assignmentID = `assignment_${crypto.randomUUID()}`
    assignment = await acquireWorkspace(
      { gate: ports.gate, nodeId: ports.repoMap.nodeId, worktreeRoot: ports.repoMap.worktreeRoot },
      {
        assignmentID,
        rootSessionID: root.sessionID,
        ownerSessionID: assignmentID,
        repository,
        branch: input.branch,
        checkout: input.checkout,
      },
    )
    const title = input.title ?? titleOf(input.task)
    const model = await inheritedModel(ports, parentID, input.agent, assignment.directory).catch(() => undefined)
    const child = await ports.session.create({
      title,
      ...(input.agent ? { agent: input.agent } : {}),
      ...(model ? { model } : {}),
      location: { directory: assignment.directory },
      metadata: {
        courier: {
          parentID,
          rootSessionID: root.sessionID,
          rootProjectID: root.projectID,
          rootName: root.name,
          managed: true,
          ...(ports.generationID ? { generationID: ports.generationID } : {}),
          workName,
          assignmentID: assignment.assignmentID,
          ownerNodeId: ports.repoMap.nodeId,
          repoId: repository.repoId,
          branch: assignment.branch,
          sourceDirectory: assignment.sourceDirectory,
          directory: assignment.directory,
        },
      },
    })
    childID = child.id
    ports.gate.assignments!.set(assignment.assignmentID, { ...assignment, sessionID: child.id })
    const entry: RosterEntry = {
      sessionID: child.id,
      parentID,
      title,
      directory: assignment.directory,
      isolated: assignment.worktreeId !== undefined,
      createdAt: ports.now(),
      reports: "status",
      source: assignment.sourceDirectory,
      project: child.projectID,
      base: assignment.baseCommit,
      workName,
      assignmentID: assignment.assignmentID,
      repoId: repository.repoId,
      branch: assignment.branch,
      ...(assignment.worktreeId ? { worktreeId: assignment.worktreeId } : {}),
      rootSessionID: root.sessionID,
      rootName: root.name,
      createdWorkspace: input.checkout.mode === "create-worktree",
      ...(group ? { group } : {}),
    }
    const { rosterError, groupError } = await enrol(ports, entry, group)
    if (rosterError) throw new Error(`worker session was prepared but could not be recorded: ${rosterError}`)
    if (groupError) ports.log(`courier_spawn: ${child.id} could not join group ${group}: ${groupError}`)
    ports.roles.delete(parentID)
    await handOver(ports, entry, admitted.depth, input.task, true, Boolean(group && !groupError), { branch: assignment.branch, workName, managed: true })
    return {
      sessionID: child.id,
      directory: assignment.directory,
      sourceDirectory: assignment.sourceDirectory,
      branch: assignment.branch,
      baseCommit: assignment.baseCommit,
      workName,
      dirty: assignment.dirty,
      assignmentID: assignment.assignmentID,
      ...(group && !groupError ? { group } : {}),
    }
  } catch (error) {
    if (assignment) {
      if (childID) {
        try {
          await ports.session.interrupt({ sessionID: childID, resume: false })
          await ports.session.wait({ sessionID: childID })
          const latest = await ports.session.get({ sessionID: childID })
          if (!busy(latest.time)) await releaseWorkspace(ports.gate, assignment.assignmentID, true)
        } catch {
          // Keep the branch reservation if the session could not be confirmed stopped.
        }
      } else {
        await releaseWorkspace(ports.gate, assignment.assignmentID, true).catch(() => undefined)
      }
    }
    throw error
  } finally {
    admitted.release()
  }
}

async function spawnRemoteRepository(
  ports: CourierPorts,
  parentID: string,
  input: SpawnInput,
  group: string | undefined,
  root: Awaited<ReturnType<ReturnType<typeof createIdentityManager>["assertRoot"]>>,
  workName: string,
  repository: Awaited<ReturnType<typeof resolveRepository>>,
) {
  if (!repository.peer) throw new Error("selected remote repository is missing its peer identity")
  const peer = repository.peer
  const admitted = await admit(ports, parentID)
  try {
    const parent = await ports.session.get({ sessionID: parentID }).catch(() => undefined)
    const prepared = await remoteRequest<PreparedRemote & { sourceDirectory: string; assignmentID: string; branch: string; baseCommit: string; dirty: boolean; worktreeId?: string }>(ports, peer, "prepareRepo", {
      repo: { host: repository.host, name: repository.name, repoId: repository.repoId },
      workName,
      root,
      branch: input.branch,
      checkout: input.checkout,
      task: input.task,
      ...(input.title ? { title: input.title } : {}),
      ...(input.agent ? { agent: input.agent } : {}),
      ...(input.group ? { group: input.group } : {}),
      ...(parent?.model ? { parentModel: parent.model } : {}),
    })
    const sessionID = qualify(peer, prepared.sessionID)
    admitted.reservation.sessionID = sessionID
    const title = input.title ?? titleOf(input.task)
    const entry: RosterEntry = {
      sessionID,
      parentID,
      title: prepared.title || title,
      directory: prepared.directory,
      isolated: prepared.worktree !== undefined,
      createdAt: ports.now(),
      reports: "status",
      nodeId: peer,
      workName,
      source: prepared.sourceDirectory ?? repository.path,
      base: prepared.baseCommit,
      assignmentID: prepared.assignmentID,
      repoId: repository.repoId,
      branch: prepared.branch,
      ...(prepared.worktreeId ? { worktreeId: prepared.worktreeId } : {}),
      rootSessionID: root.sessionID,
      rootName: root.name,
      createdWorkspace: input.checkout?.mode === "create-worktree",
      ...(group ? { group } : {}),
    }
    const { rosterError, groupError } = await enrol(ports, entry, group)
    if (rosterError) {
      await remoteRequest(ports, peer, "abortPreparedRepo", { sessionID: prepared.sessionID, parentID: root.sessionID }).catch((error: unknown) =>
        ports.log(`courier_spawn: unrecorded remote worker ${sessionID} remains assigned because it could not be stopped: ${String(error)}`),
      )
      throw new Error(`remote worker was prepared but could not be recorded: ${rosterError}`)
    }
    ports.gate.assignments?.set(prepared.assignmentID, {
      assignmentID: prepared.assignmentID,
      reservationKey: `${peer}\0${repository.repoId}\0${prepared.branch}`,
      rootSessionID: root.sessionID,
      sessionID,
      nodeId: peer,
      repoId: repository.repoId,
      branch: prepared.branch,
      directory: prepared.directory,
      sourceDirectory: prepared.sourceDirectory ?? repository.path,
      dirty: prepared.dirty,
    })
    ports.roles.delete(parentID)
    await handOverRemote(ports, peer, entry, admitted.depth, input.task, workName, prepared)
    return {
      sessionID,
      directory: entry.directory,
      sourceDirectory: prepared.sourceDirectory ?? repository.path,
      branch: prepared.branch,
      baseCommit: prepared.baseCommit,
      workName,
      dirty: prepared.dirty,
      assignmentID: prepared.assignmentID,
      ...(group && !groupError ? { group } : {}),
    }
  } finally {
    admitted.release()
  }
}

async function startRemote(ports: CourierPorts, parentID: string, input: SpawnInput, admitted: Awaited<ReturnType<typeof admit>>, group: string | undefined) {
  const peer = input.peer!
  const workName = input.workName!.trim()
  if (workName.length > 120 || /[\r\n]/.test(workName)) throw new Error("workName must be 1 to 120 characters on one line")
  const parent = await ports.session.get({ sessionID: parentID }).catch(() => undefined)
  const prepared = await remoteRequest<PreparedRemote>(ports, peer, "prepare", {
    directory: input.directory,
    task: input.task,
    workName,
    ...(input.title ? { title: input.title } : {}),
    ...(input.agent ? { agent: input.agent } : {}),
    ...(input.isolate ? { isolate: true } : {}),
    ...(parent?.model ? { parentModel: parent.model } : {}),
  })
  const sessionID = qualify(peer, prepared.sessionID)
  admitted.reservation.sessionID = sessionID
  const title = input.title ?? titleOf(input.task)
  const entry: RosterEntry = {
    sessionID,
    parentID,
    title: prepared.title || title,
    directory: prepared.directory,
    isolated: prepared.worktree !== undefined,
    createdAt: ports.now(),
    reports: "status",
    nodeId: peer,
    workName,
    ...(prepared.worktree ? { source: input.directory, project: prepared.project } : {}),
    ...(prepared.base ? { base: prepared.base } : {}),
    ...(group ? { group } : {}),
  }
  const { rosterError, groupError } = await enrol(ports, entry, group)
  ports.roles.delete(parentID)
  if (rosterError || groupError) {
    await childStore(ports.storage).remove(parentID, entry.sessionID).catch(() => undefined)
    throw new Error(`remote child was prepared but not started because ${rosterError ?? groupError}; no task was sent`)
  }
  await handOverRemote(ports, peer, entry, admitted.depth, input.task, workName, prepared)
  return {
    sessionID: entry.sessionID,
    directory: entry.directory,
    sourceDirectory: input.directory,
    isolated: entry.isolated,
    workName,
    ...(group && !rosterError && !groupError ? { group } : {}),
    ...(rosterError ? { rosterError } : {}),
    ...(groupError ? { groupError } : {}),
  }
}

async function handOverRemote(
  ports: CourierPorts,
  peer: string,
  entry: RosterEntry,
  depth: number,
  task: string,
  workName: string,
  prepared: PreparedRemote,
) {
  const children = childStore(ports.storage)
  await children.prompted(entry.sessionID, ports.now()).catch(() => undefined)
  try {
    await remoteRequest(ports, peer, "start", {
      sessionID: prepared.sessionID,
      parentID: qualify(ports.remote!.nodeId, entry.parentID),
      title: entry.title,
      task,
      workName,
      depth,
    })
  } catch (error) {
    await children.settled(entry.sessionID, "failed", ports.now()).catch(() => undefined)
    if (entry.group)
      await leaveGroup(groupStore(ports.storage), entry.parentID, entry.group, entry.sessionID, "failed", ports.now()).then(
        (complete) => complete && ports.nudge(),
        (leaveError: unknown) => ports.log(`courier_spawn: ${entry.sessionID} could not leave group ${entry.group}: ${String(leaveError)}`),
      )
    throw error
  }
}

async function start(ports: CourierPorts, parentID: string, input: SpawnInput, admitted: Awaited<ReturnType<typeof admit>>, group: string | undefined) {
  const { worktree, handedDown, ...child } = await create(ports, parentID, input)
  admitted.reservation.sessionID = child.sessionID
  const entry: RosterEntry = {
    ...child,
    parentID,
    isolated: worktree !== undefined,
    createdAt: ports.now(),
    reports: "status",
    ...(worktree ? { source: ports.directory, project: ports.projectID } : {}),
    ...(group ? { group } : {}),
  }
  const { rosterError, groupError } = await enrol(ports, entry, group)
  ports.roles.delete(parentID)
  await handOver(ports, entry, admitted.depth, input.task, !rosterError, !rosterError && !groupError)
  return {
    sessionID: entry.sessionID,
    directory: entry.directory,
    ...(group && !rosterError && !groupError ? { group } : {}),
    ...(rosterError ? { rosterError } : {}),
    ...(groupError ? { groupError } : {}),
    ...(handedDown ? { fromParent: true } : {}),
    ...(handedDown?.uncommitted ? { uncommitted: true } : {}),
  }
}

/** Creates the child's session, in a worktree of its own if asked, which goes again if the session cannot be created. */
async function create(ports: CourierPorts, parentID: string, input: SpawnInput) {
  // A failed lookup must not keep the child from starting; it then runs on OpenCode's default.
  const model = await inheritedModel(ports, parentID, input.agent).catch(() => undefined)
  const handedDown = input.isolate ? await parentWork(ports, parentID) : undefined
  const worktree = input.isolate
    ? (await ports.worktree.create({ projectID: ports.projectID, ...(handedDown ? { from: handedDown.directory, branch: handedDown.head } : {}) })).directory
    : undefined
  const base = worktree ? await ports.head(worktree) : undefined
  const title = input.title ?? titleOf(input.task)
  // OpenCode takes a location or a parentID, never both, so an isolated child cannot be a native one.
  const native = ports.nativeChildren === true && !worktree
  const child = await ports.session
    .create({
      title,
      ...(input.agent ? { agent: input.agent } : {}),
      ...(model ? { model } : {}),
      ...(worktree ? { location: { directory: worktree } } : {}),
      // An empty ruleset, not none: a native child would otherwise run on its parent's session rules.
      ...(native ? { parentID, permissions: [] } : {}),
      metadata: { courier: { parentID } },
    })
    .catch(async (error: unknown) => {
      // No session will ever use the fresh worktree, and nothing records it, so it goes now.
      if (worktree) await dropWorktree(ports, worktree)
      throw error
    })
  return {
    sessionID: child.id,
    title,
    directory: worktree ?? child.location.directory,
    worktree,
    handedDown,
    ...(base ? { base } : {}),
    ...(native ? { native: true as const } : {}),
  }
}

/**
 * The worktree and HEAD an isolated parent hands its isolated child, by the reverse index alone; undefined for any
 * other parent. An unreadable HEAD fails the spawn rather than start the child without the parent's work.
 */
async function parentWork(ports: CourierPorts, parentID: string) {
  const parent = await childStore(ports.storage).indexedEntry(parentID)
  if (!parent?.isolated) return undefined
  const head = await ports.head(parent.directory)
  if (!head)
    throw new Error(
      `the HEAD of your worktree ${parent.directory} could not be read, so an isolated session cannot start from it; nothing was started. Start it without isolate, or fix the worktree.`,
    )
  const uncommitted = (await ports.dirty(parent.directory).catch(() => undefined)) === true
  return { directory: parent.directory, head, uncommitted }
}

/**
 * Records the child on the roster, before the prompt, so a child that exists is on the roster even if prompting
 * fails, then in its group. A failed write must not keep the child from its task: each is reported, not thrown.
 */
async function enrol(ports: CourierPorts, entry: RosterEntry, group: string | undefined) {
  const rosterError = await childStore(ports.storage).record(entry).then(
    () => undefined,
    (error: unknown) => describeFailure("roster", error).message,
  )
  const groupError = group && !rosterError ? await join(ports, entry, group) : undefined
  return { rosterError, groupError }
}

/**
 * Hands the child its task. `rostered` says whether its report state is kept, which a child off the roster has none
 * of, and `grouped` whether it is in its group; a child that never got its task leaves both, as it will never report.
 */
async function handOver(
  ports: CourierPorts,
  entry: RosterEntry,
  depth: number,
  task: string,
  rostered: boolean,
  grouped: boolean,
  assignment?: { readonly branch: string; readonly workName: string; readonly managed?: boolean },
) {
  // A baseline, until OpenCode's event for the prompt's delivery moves it on; written first, so it never overtakes that.
  const children = childStore(ports.storage)
  if (rostered) await children.prompted(entry.sessionID, ports.now()).catch(() => undefined)
  try {
    await ports.session.prompt({
      sessionID: entry.sessionID,
      text: childBrief(
        entry.parentID,
        task,
        depth,
        ports.limits,
        assignment?.branch ?? (entry.isolated ? childBranch(entry.sessionID) : undefined),
        assignment?.workName ?? entry.workName,
        assignment?.managed === true,
      ),
    })
  } catch (error) {
    if (rostered) await children.settled(entry.sessionID, "failed", ports.now()).catch(() => undefined)
    if (grouped && entry.group)
      await leaveGroup(groupStore(ports.storage), entry.parentID, entry.group, entry.sessionID, "failed", ports.now()).then(
        (complete) => complete && ports.nudge(),
        (leaveError: unknown) => ports.log(`courier_spawn: ${entry.sessionID} could not leave group ${entry.group}: ${String(leaveError)}`),
      )
    throw error
  }
}

/**
 * Joins a child to its group; one that cannot be joined is recorded in no group, so it reports on its own,
 * and the result says so. Returns the error's message, if any.
 */
async function join(ports: CourierPorts, entry: RosterEntry, group: string) {
  const groups = groupStore(ports.storage)
  try {
    await joinGroup(groups, entry.parentID, group, entry.sessionID, entry.title, ports.now())
    return undefined
  } catch (error) {
    const { group: _, ...ungrouped } = entry
    // A write that failed may have landed all the same: a member left there would hold its group up for good.
    await Promise.all([
      childStore(ports.storage).record(ungrouped).catch(() => undefined),
      groups.remove(entry.parentID, group, entry.sessionID).catch(() => undefined),
    ])
    return describeFailure("group", error).message
  }
}
