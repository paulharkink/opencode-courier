import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { listRepositories } from "../src/tree/repos.js"
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

  test("discovers a created checkout, blocks a second owner, then reuses it after close without refreshing AACT", async () => {
    const f = fixture()
    const destination = join(f.worktreeRoot, "explicit-checkout")
    const created = await acquireWorkspace({ gate: f.gate, nodeId: "node-a", worktreeRoot: f.worktreeRoot }, {
      rootSessionID: "root-session",
      ownerSessionID: "worker-one",
      repository: f.candidate,
      branch: { mode: "create", name: "feature/explicit-name", base: "HEAD" },
      checkout: { mode: "create-worktree", directory: destination },
    })
    const result = await listRepositories({
      repoMap: {
        version: 1,
        nodeId: "node-a",
        worktreeRoot: f.worktreeRoot,
        repositories: [{
          host: f.candidate.host,
          name: f.candidate.name,
          path: f.repo,
          repoId: f.candidate.repoId,
          worktrees: [{ worktreeId: hash(realpathSync(f.repo)), branch: "main", kind: "main", dirty: false }],
        }],
        peers: [],
      },
    })
    const known = result.repositories[0]?.worktrees.find((worktree) => worktree.path === realpathSync(destination))
    expect(known).toMatchObject({ worktreeId: hash(realpathSync(destination)), branch: "feature/explicit-name", kind: "worktree" })
    const reuse = {
      rootSessionID: "root-session",
      ownerSessionID: "worker-two",
      repository: { ...f.candidate, worktrees: result.repositories[0]!.worktrees },
      branch: { mode: "existing" as const, name: "feature/explicit-name" },
      checkout: { mode: "existing-worktree" as const, worktreeId: known!.worktreeId },
    }
    await expect(acquireWorkspace({ gate: f.gate, nodeId: "node-a", worktreeRoot: f.worktreeRoot }, reuse)).rejects.toThrow("already assigned")
    await releaseWorkspace(f.gate, created.assignmentID, true)
    await expect(acquireWorkspace({ gate: f.gate, nodeId: "node-a", worktreeRoot: f.worktreeRoot }, reuse)).resolves.toMatchObject({
      directory: realpathSync(destination),
      worktreeId: hash(realpathSync(destination)),
    })
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

  test("remote peer grants restrict existing worktrees and new destinations before assignment", async () => {
    const f = fixture()
    const outside = join(f.root, "outside-worktree")
    execFileSync("git", ["-C", f.repo, "worktree", "add", "-b", "feature/outside", "--", outside, "HEAD"])
    const candidate = {
      ...f.candidate,
      worktrees: [...f.candidate.worktrees, { worktreeId: hash(realpathSync(outside)), branch: "feature/outside", kind: "worktree" as const, dirty: false, path: outside }],
    }
    await expect(acquireWorkspace({ gate: f.gate, nodeId: "node-a", worktreeRoot: f.root, allowedRoots: [f.repo] }, {
      rootSessionID: "root-session",
      ownerSessionID: "worker-outside",
      repository: candidate,
      branch: { mode: "existing", name: "feature/outside" },
      checkout: { mode: "existing-worktree", worktreeId: hash(realpathSync(outside)) },
    })).rejects.toThrow("outside this peer's allowedRoots")
    expect(f.gate.assignments?.size).toBe(0)

    await expect(acquireWorkspace({ gate: f.gate, nodeId: "node-a", worktreeRoot: f.root, allowedRoots: [f.repo] }, {
      rootSessionID: "root-session",
      ownerSessionID: "worker-create-outside",
      repository: f.candidate,
      branch: { mode: "create", name: "feature/not-granted", base: "HEAD" },
      checkout: { mode: "create-worktree", directory: join(f.worktreeRoot, "not-granted") },
    })).rejects.toThrow("inside this peer's allowedRoots")
    expect(execFileSync("git", ["-C", f.repo, "branch", "--list", "feature/not-granted"], { encoding: "utf8" }).trim()).toBe("")

    const escaped = join(f.repo, "escape")
    symlinkSync(f.root, escaped)
    await expect(acquireWorkspace({ gate: f.gate, nodeId: "node-a", worktreeRoot: f.root, allowedRoots: [f.repo] }, {
      rootSessionID: "root-session",
      ownerSessionID: "worker-symlink",
      repository: f.candidate,
      branch: { mode: "create", name: "feature/symlink-escape", base: "HEAD" },
      checkout: { mode: "create-worktree", directory: join(escaped, "outside") },
    })).rejects.toThrow("inside this peer's allowedRoots")
    expect(f.gate.assignments?.size).toBe(0)
  })
})
