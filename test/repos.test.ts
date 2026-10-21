import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { listRepositories, resolveRepository } from "../src/tree/repos.js"
import type { RepoMapV1 } from "../src/tree/repo-map.js"

const repoMap: RepoMapV1 = {
  version: 1,
  nodeId: "node-a",
  worktreeRoot: "/worktrees",
  repositories: [
    { host: "github.com", name: "team/app", path: "/src/app", repoId: "repo-one", worktrees: [{ worktreeId: "wt-main", branch: "main", kind: "main", dirty: false }] },
    { host: "github.com", name: "team/app", path: "/src/app-clone", repoId: "repo-two", worktrees: [{ worktreeId: "wt-clone", branch: "main", kind: "main", dirty: true }] },
  ],
  peers: [],
}

const roots: string[] = []
const hash = (value: string) => createHash("sha256").update(value).digest("hex")

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("repository inventory", () => {
  test("lists local candidates and reports the configured destination root", async () => {
    const result = await listRepositories({ repoMap })
    expect(result.repositories.map(({ nodeId, repoId }) => ({ nodeId, repoId }))).toEqual([
      { nodeId: "node-a", repoId: "repo-one" },
      { nodeId: "node-a", repoId: "repo-two" },
    ])
    expect(result.worktreeRoots).toEqual({ "node-a": "/worktrees" })
    expect(result.errors).toEqual([])
  })

  test("requires repoId when the host and name identify multiple clones", async () => {
    await expect(resolveRepository({ repoMap }, { host: "github.com", name: "team/app" })).rejects.toThrow("ambiguous")
    await expect(resolveRepository({ repoMap }, { host: "github.com", name: "team/app", repoId: "repo-two" })).resolves.toMatchObject({ path: "/src/app-clone" })
  })

  test("filters the local inventory by a case-insensitive query", async () => {
    const result = await listRepositories({ repoMap }, { query: "APP-CLONE" })
    expect(result.repositories.map((repo) => repo.repoId)).toEqual(["repo-two"])
  })

  test("combines linked-worktree rows under one repoId while retaining each checkout path", async () => {
    const linked: RepoMapV1 = {
      ...repoMap,
      repositories: [
        { host: "github.com", name: "team/app", path: "/src/app", repoId: "repo-one", worktrees: [{ worktreeId: "wt-main", branch: "main", kind: "main", dirty: false }] },
        { host: "github.com", name: "team/app", path: "/worktrees/task", repoId: "repo-one", worktrees: [{ worktreeId: "wt-task", branch: "feature/task", kind: "worktree", dirty: false }] },
      ],
    }
    const result = await listRepositories({ repoMap: linked })
    expect(result.repositories).toHaveLength(1)
    expect(result.repositories[0]?.worktrees.map(({ worktreeId, path }) => ({ worktreeId, path }))).toEqual([
      { worktreeId: "wt-main", path: "/src/app" },
      { worktreeId: "wt-task", path: "/worktrees/task" },
    ])
  })

  test("discovers worktrees created after the static inventory snapshot and matches their paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "courier-repos-live-"))
    roots.push(root)
    const repo = join(root, "repo")
    const worktreeRoot = join(root, "managed")
    mkdirSync(repo)
    mkdirSync(worktreeRoot)
    execFileSync("git", ["init", "-b", "main", repo])
    execFileSync("git", ["-C", repo, "config", "user.name", "Courier Test"])
    execFileSync("git", ["-C", repo, "config", "user.email", "courier@example.invalid"])
    writeFileSync(join(repo, "README.md"), "test\n")
    execFileSync("git", ["-C", repo, "add", "README.md"])
    execFileSync("git", ["-C", repo, "commit", "-m", "init"])
    const commonDir = realpathSync(join(repo, execFileSync("git", ["-C", repo, "rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim()))
    const repoId = hash(commonDir)
    const destination = join(worktreeRoot, "smoke-local-B")
    execFileSync("git", ["-C", repo, "worktree", "add", "-b", "smoke/local/B", "--", destination, "HEAD"])
    writeFileSync(join(destination, "untracked.txt"), "dirty\n")
    const snapshot: RepoMapV1 = {
      version: 1,
      nodeId: "node-a",
      worktreeRoot,
      repositories: [{
        host: "github.com",
        name: "team/live",
        path: repo,
        repoId,
        worktrees: [{ worktreeId: hash(realpathSync(repo)), branch: "main", kind: "main", dirty: false }],
      }],
      peers: [],
    }

    const result = await listRepositories({ repoMap: snapshot }, { query: "smoke/local/B" })
    expect(result.repositories).toHaveLength(1)
    expect(result.repositories[0]?.worktrees).toContainEqual({
      worktreeId: hash(realpathSync(destination)),
      branch: "smoke/local/B",
      kind: "worktree",
      dirty: true,
      path: realpathSync(destination),
    })
    await expect(listRepositories({ repoMap: snapshot }, { query: "smoke-local-B" })).resolves.toMatchObject({ repositories: [{ repoId }] })
  })
})
