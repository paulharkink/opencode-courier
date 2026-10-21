import { createHash, randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { realpath } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import type { ActiveAssignment, SpawnGate } from "./ports.js"
import type { RepositoryCandidate } from "./repos.js"
import { findGit } from "./cleanup.js"

export type BranchIntent =
  | { readonly mode: "existing"; readonly name: string }
  | { readonly mode: "create"; readonly name: string; readonly base: string }

export type CheckoutIntent =
  | { readonly mode: "main" }
  | { readonly mode: "existing-worktree"; readonly worktreeId: string }
  | { readonly mode: "create-worktree"; readonly directory: string }

export interface WorkspaceAssignment extends ActiveAssignment {
  readonly reservationKey: string
  readonly worktreeId?: string
  readonly baseCommit: string
}

export interface WorkspaceRequest {
  readonly assignmentID?: string
  readonly rootSessionID: string
  readonly ownerSessionID: string
  readonly repository: RepositoryCandidate
  readonly branch: BranchIntent
  readonly checkout: CheckoutIntent
}

export interface WorkspacePorts {
  readonly gate: SpawnGate
  readonly nodeId: string
  readonly worktreeRoot?: string
}

interface GitWorktree {
  readonly path: string
  readonly branch?: string
  readonly detached: boolean
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex")

function git(directory: string, args: string[]) {
  return new Promise<string>((resolveOutput, reject) =>
    execFile(findGit(), ["-C", directory, ...args], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) =>
      error ? reject(new Error(`git ${args[0]} in ${directory}: ${stderr.trim() || error.message}`)) : resolveOutput(stdout.trim()),
    ),
  )
}

async function canonical(path: string) {
  return realpath(path)
}

async function commonDir(directory: string) {
  const value = await git(directory, ["rev-parse", "--git-common-dir"])
  return canonical(resolve(directory, value))
}

async function listWorktrees(directory: string): Promise<GitWorktree[]> {
  const output = await git(directory, ["worktree", "list", "--porcelain"])
  const result: GitWorktree[] = []
  let current: { path?: string; branch?: string; detached?: boolean } = {}
  const finish = async () => {
    if (!current.path) return
    result.push({ path: await canonical(current.path), ...(current.branch ? { branch: current.branch } : {}), detached: current.detached === true })
    current = {}
  }
  for (const line of output.split("\n")) {
    if (!line) {
      await finish()
      continue
    }
    if (line.startsWith("worktree ")) current.path = line.slice("worktree ".length)
    else if (line.startsWith("branch ")) current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "")
    else if (line === "detached") current.detached = true
  }
  await finish()
  return result
}

function inside(path: string, root: string) {
  const rel = relative(root, path)
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

async function checkedDestination(directory: string, worktreeRoot: string) {
  if (!isAbsolute(directory)) throw new Error("checkout.directory must be an absolute path")
  if (!existsSync(worktreeRoot)) throw new Error(`configured worktreeRoot does not exist: ${worktreeRoot}`)
  const root = await canonical(worktreeRoot)
  const destination = resolve(directory)
  if (existsSync(destination)) throw new Error(`checkout.directory already exists: ${destination}`)
  const parent = await canonical(dirname(destination)).catch(() => { throw new Error("checkout.directory parent must already exist") })
  const normalized = resolve(parent, destination.slice(dirname(destination).length + 1))
  if (!inside(normalized, root)) throw new Error("checkout.directory must be inside the configured worktreeRoot")
  return normalized
}

async function branchExists(directory: string, branch: string) {
  return git(directory, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).then(() => true, () => false)
}

function validateBranchName(directory: string, name: string) {
  if (!name.trim() || name !== name.trim()) throw new Error("branch name must be non-empty and have no surrounding whitespace")
  return git(directory, ["check-ref-format", "--branch", name])
}

async function baseCommit(directory: string, branch: BranchIntent) {
  if (branch.mode === "create") {
    if (!branch.base.trim() || branch.base !== branch.base.trim()) throw new Error("new branch base must be an explicit ref or commit")
    return git(directory, ["rev-parse", "--verify", `${branch.base}^{commit}`]).catch(() => { throw new Error(`branch base ${JSON.stringify(branch.base)} does not resolve to a commit`) })
  }
  if (!(await branchExists(directory, branch.name))) throw new Error(`existing branch ${JSON.stringify(branch.name)} does not exist in this repository`)
  return git(directory, ["rev-parse", "--verify", `refs/heads/${branch.name}^{commit}`])
}

async function lock(gate: SpawnGate, reservationKey: string, assignment: WorkspaceAssignment) {
  const assignments = gate.assignments
  if (!assignments) throw new Error("Courier workspace assignment map is unavailable")
  const checked = gate.turn.then(() => {
    const owner = [...assignments.values()].find((item) => !item.closed && item.reservationKey === reservationKey)
    if (owner) throw new Error(`branch ${JSON.stringify(assignment.branch)} is already assigned to ${owner.sessionID}`)
    assignments.set(assignment.assignmentID, assignment)
  })
  gate.turn = checked.catch(() => undefined)
  await checked
}

/** Explicitly selects an existing checkout or creates the exact caller-selected branch/path. */
export async function acquireWorkspace(ports: WorkspacePorts, request: WorkspaceRequest): Promise<WorkspaceAssignment> {
  const { repository, branch, checkout } = request
  if (repository.nodeId !== ports.nodeId) throw new Error(`repository ${repository.host}/${repository.name} belongs to node ${repository.nodeId}, not ${ports.nodeId}`)
  if (!repository.repoId || !repository.worktrees.length) throw new Error("repository inventory is missing its repoId or worktree list")
  if (branch.mode !== "existing" && branch.mode !== "create") throw new Error("branch intent is required")
  if (checkout.mode !== "main" && checkout.mode !== "existing-worktree" && checkout.mode !== "create-worktree") throw new Error("checkout intent is required")
  if (checkout.mode !== "create-worktree" && branch.mode === "create") throw new Error("a new branch requires checkout.mode=create-worktree")
  if (checkout.mode === "create-worktree" && !ports.worktreeRoot) throw new Error("this node has no configured worktreeRoot")

  const sourceDirectory = await canonical(repository.path)
  const common = await commonDir(sourceDirectory)
  if (hash(common) !== repository.repoId) throw new Error("repoId does not match the canonical Git common directory")
  const allWorktrees = await listWorktrees(sourceDirectory)
  const advertised = new Map<string, { path: string; branch: string; kind: "main" | "worktree" }>()
  for (const item of repository.worktrees) {
    if (!item.path) continue
    const path = await canonical(item.path).catch(() => undefined)
    if (path) advertised.set(item.worktreeId, { path, branch: item.branch, kind: item.kind })
  }

  let directory: string
  let chosenBranch: string
  let dirty: boolean
  let base: string
  let worktreeId: string | undefined
  let createPath: string | undefined
  if (checkout.mode === "main") {
    const main = repository.worktrees.find((item) => item.kind === "main")
    const selected = main && advertised.get(main.worktreeId)
    if (!selected) throw new Error("the repository inventory has no accessible main checkout")
    const actual = allWorktrees.find((item) => item.path === selected.path)
    if (!actual) throw new Error("the advertised main checkout is not present in Git's worktree list")
    if (branch.mode !== "existing" || actual.branch !== branch.name) throw new Error("checkout.mode=main requires branch.mode=existing matching the actual checked-out branch")
    directory = actual.path
    chosenBranch = actual.branch ?? ""
    base = await git(directory, ["rev-parse", "HEAD"])
  } else if (checkout.mode === "existing-worktree") {
    if (branch.mode !== "existing") throw new Error("an existing worktree requires branch.mode=existing")
    const selected = advertised.get(checkout.worktreeId)
    if (!selected) throw new Error(`worktreeId ${JSON.stringify(checkout.worktreeId)} is not advertised for this repository`)
    const actual = allWorktrees.find((item) => item.path === selected.path)
    if (!actual || actual.branch !== branch.name) throw new Error("selected worktree branch does not match the requested existing branch")
    directory = actual.path
    chosenBranch = actual.branch
    base = await git(directory, ["rev-parse", "HEAD"])
    worktreeId = checkout.worktreeId
  } else {
    await validateBranchName(sourceDirectory, branch.name)
    if (branch.mode === "create") {
      if (await branchExists(sourceDirectory, branch.name)) throw new Error(`branch ${JSON.stringify(branch.name)} already exists; choose branch.mode=existing`)
      base = await baseCommit(sourceDirectory, branch)
    } else {
      const existingBase = await baseCommit(sourceDirectory, branch)
      if (allWorktrees.some((item) => item.branch === branch.name)) throw new Error(`branch ${JSON.stringify(branch.name)} is already checked out; select its existing worktree or checkout.mode=main`)
      base = existingBase
    }
    createPath = await checkedDestination(checkout.directory, ports.worktreeRoot!)
    directory = createPath
    chosenBranch = branch.name
    dirty = false
  }

  if (checkout.mode !== "create-worktree") {
    if (!chosenBranch) throw new Error("selected checkout is detached; choose an attached existing branch")
    if (branch.mode === "create" || branch.name !== chosenBranch) throw new Error("selected checkout does not match the requested branch")
    const checkedOut = allWorktrees.find((item) => item.branch === chosenBranch)
    if (checkout.mode === "main" && (!checkedOut || checkedOut.path !== directory)) throw new Error("main checkout branch ownership changed during selection")
    const actualDirty = await git(directory, ["status", "--porcelain"]).then((out) => out.length > 0)
    dirty = actualDirty
    base = await git(directory, ["rev-parse", "HEAD"])
    worktreeId = hash(directory)
  }

  const assignmentID = request.assignmentID ?? randomUUID()
  const reservationKey = `${ports.nodeId}\0${common}\0${chosenBranch}`
  const pending: WorkspaceAssignment = {
    assignmentID,
    reservationKey,
    rootSessionID: request.rootSessionID,
    sessionID: request.ownerSessionID,
    nodeId: ports.nodeId,
    repoId: repository.repoId,
    branch: chosenBranch,
    directory,
    sourceDirectory,
    dirty: dirty!,
    baseCommit: base,
    ...(worktreeId ? { worktreeId } : {}),
  }
  await lock(ports.gate, reservationKey, pending)

  try {
    if (createPath) {
      if (branch.mode === "create")
        await git(sourceDirectory, ["worktree", "add", "-b", branch.name, "--", createPath, base])
      else await git(sourceDirectory, ["worktree", "add", "--", createPath, branch.name])
      const canonicalCreated = await canonical(createPath)
      if (canonicalCreated !== createPath) throw new Error("Git created the worktree at an unexpected path")
      const createdDirty = await git(createPath, ["status", "--porcelain"]).then((out) => out.length > 0)
      const updated = { ...pending, directory: canonicalCreated, dirty: createdDirty, worktreeId: hash(canonicalCreated) }
      ports.gate.assignments!.set(assignmentID, updated)
      return updated
    }
    return pending
  } catch (error) {
    ports.gate.assignments!.delete(assignmentID)
    throw error
  }
}

/** Release only after the owning node has confirmed the session stopped; the worktree and branch remain. */
export async function releaseWorkspace(gate: SpawnGate, assignmentID: string, stopConfirmed: boolean) {
  if (!stopConfirmed) throw new Error("workspace assignment remains owned until the session is confirmed stopped")
  const assignment = gate.assignments?.get(assignmentID)
  if (!assignment) return { assignmentID, released: false, retainedWorkspace: true as const }
  gate.assignments!.set(assignmentID, { ...assignment, closed: true })
  return { assignmentID, released: true, retainedWorkspace: true as const }
}
