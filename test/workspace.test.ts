import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import type { SpawnGate } from "../src/tree/ports.js"
import type { RepositoryCandidate } from "../src/tree/repos.js"
import { acquireWorkspace, releaseWorkspace } from "../src/tree/workspace.js"

const roots: string[] = []
const hash = (value: string) => createHash("sha256").update(value).digest("hex")

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "courier-workspace-test-"))
  roots.push(root)
  const repo = join(root, "repo")
  const worktreeRoot = join(root, "worktrees")
  mkdirSync(repo)
  mkdirSync(worktreeRoot)
  execFileSync("git", ["init", "-b", "main", repo])
  execFileSync("git", ["-C", repo, "config", "user.name", "Courier Test"])
  execFileSync("git", ["-C", repo, "config", "user.email", "courier@example.invalid"])
  writeFileSync(join(repo, "README.md"), "test\n")
  execFileSync("git", ["-C", repo, "add", "README.md"])
  execFileSync("git", ["-C", repo, "commit", "-m", "init"])
  const common = execFileSync("git", ["-C", repo, "rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim()
  const commonPath = realpathSync(join(repo, common))
  const candidate: RepositoryCandidate = {
    nodeId: "node-a",
    host: "example.invalid",
    name: "team/app",
    path: repo,
    repoId: hash(commonPath),
    worktrees: [{ worktreeId: hash(realpathSync(repo)), branch: "main", kind: "main", dirty: false, path: repo }],
  }
  const gate: SpawnGate = { reserved: new Set(), assignments: new Map(), turn: Promise.resolve() }
  return { root, repo, worktreeRoot, candidate, gate }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("repo workspace assignment", () => {
  test("reserves an existing branch on main and refuses a second active owner", async () => {
    const f = fixture()
    const request = {
      rootSessionID: "root-session",
      ownerSessionID: "worker-one",
      repository: f.candidate,
      branch: { mode: "existing" as const, name: "main" },
      checkout: { mode: "main" as const },
    }
    const assignment = await acquireWorkspace({ gate: f.gate, nodeId: "node-a", worktreeRoot: f.worktreeRoot }, request)
    expect(assignment.directory).toBe(realpathSync(f.repo))
    expect(assignment.branch).toBe("main")
    await expect(acquireWorkspace({ gate: f.gate, nodeId: "node-a", worktreeRoot: f.worktreeRoot }, { ...request, ownerSessionID: "worker-two" })).rejects.toThrow("already assigned")
    expect(await releaseWorkspace(f.gate, assignment.assignmentID, true)).toEqual({ assignmentID: assignment.assignmentID, released: true, retainedWorkspace: true })
    await expect(acquireWorkspace({ gate: f.gate, nodeId: "node-a", worktreeRoot: f.worktreeRoot }, { ...request, ownerSessionID: "worker-three" })).resolves.toMatchObject({ directory: realpathSync(f.repo) })
  })

  test("creates only the exact branch, base and destination requested", async () => {
    const f = fixture()
    const base = execFileSync("git", ["-C", f.repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
    const destination = join(f.worktreeRoot, "chosen-checkout")
    const assignment = await acquireWorkspace({ gate: f.gate, nodeId: "node-a", worktreeRoot: f.worktreeRoot }, {
      rootSessionID: "root-session",
      ownerSessionID: "worker-one",
      repository: f.candidate,
      branch: { mode: "create", name: "feature/explicit-name", base },
      checkout: { mode: "create-worktree", directory: destination },
    })
    expect(assignment.directory).toBe(realpathSync(destination))
    expect(assignment.branch).toBe("feature/explicit-name")
    expect(execFileSync("git", ["-C", destination, "branch", "--show-current"], { encoding: "utf8" }).trim()).toBe("feature/explicit-name")
    expect(execFileSync("git", ["-C", destination, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(base)
  })

  test("rejects checkout paths outside the explicitly configured worktree root", async () => {
    const f = fixture()
    await expect(acquireWorkspace({ gate: f.gate, nodeId: "node-a", worktreeRoot: f.worktreeRoot }, {
      rootSessionID: "root-session",
      ownerSessionID: "worker-one",
      repository: f.candidate,
      branch: { mode: "create", name: "feature/explicit-name", base: "HEAD" },
      checkout: { mode: "create-worktree", directory: join(f.root, "outside") },
    })).rejects.toThrow("inside the configured worktreeRoot")
    expect(f.gate.assignments?.size).toBe(0)
  })
})
