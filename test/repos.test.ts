import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { listLiveLocalRepositories, listLocalRepositories, listRepositories, resolveRepository } from "../src/tree/repos.js"
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

function initRepo(path: string) {
  mkdirSync(path, { recursive: true })
  execFileSync("git", ["init", "-b", "main", path])
  execFileSync("git", ["-C", path, "config", "user.name", "Courier Test"])
  execFileSync("git", ["-C", path, "config", "user.email", "courier@example.invalid"])
  writeFileSync(join(path, "README.md"), "test\n")
  execFileSync("git", ["-C", path, "add", "README.md"])
  execFileSync("git", ["-C", path, "commit", "-m", "init"])
  const commonDir = realpathSync(join(path, execFileSync("git", ["-C", path, "rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim()))
  return { repoId: hash(commonDir), worktreeId: hash(realpathSync(path)) }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("repository inventory", () => {
  test("lists local candidates and reports the configured destination root", async () => {
    const result = listLocalRepositories(repoMap)
    expect(result.map(({ nodeId, repoId }) => ({ nodeId, repoId }))).toEqual([
      { nodeId: "node-a", repoId: "repo-one" },
      { nodeId: "node-a", repoId: "repo-two" },
    ])
  })

  test("requires repoId when the host and name identify multiple clones", async () => {
    const root = mkdtempSync(join(tmpdir(), "courier-repos-clones-"))
    roots.push(root)
    const one = join(root, "app")
    const two = join(root, "app-clone")
    const repoOne = initRepo(one)
    const repoTwo = initRepo(two)
    const map: RepoMapV1 = {
      ...repoMap,
      repositories: [
        { host: "github.com", name: "team/app", path: one, repoId: repoOne.repoId, worktrees: [{ worktreeId: repoOne.worktreeId, branch: "main", kind: "main", dirty: false }] },
        { host: "github.com", name: "team/app", path: two, repoId: repoTwo.repoId, worktrees: [{ worktreeId: repoTwo.worktreeId, branch: "main", kind: "main", dirty: false }] },
      ],
    }
    await expect(resolveRepository({ repoMap: map }, { host: "github.com", name: "team/app" })).rejects.toThrow("ambiguous")
    await expect(resolveRepository({ repoMap: map }, { host: "github.com", name: "team/app", repoId: repoTwo.repoId })).resolves.toMatchObject({ path: realpathSync(two) })
  })

  test("filters the local inventory by a case-insensitive query", async () => {
    const result = listLocalRepositories(repoMap, "APP-CLONE")
    expect(result.map((repo) => repo.repoId)).toEqual(["repo-two"])
  })

  test("combines linked-worktree rows under one repoId while retaining each checkout path", async () => {
    const linked: RepoMapV1 = {
      ...repoMap,
      repositories: [
        { host: "github.com", name: "team/app", path: "/src/app", repoId: "repo-one", worktrees: [{ worktreeId: "wt-main", branch: "main", kind: "main", dirty: false }] },
        { host: "github.com", name: "team/app", path: "/worktrees/task", repoId: "repo-one", worktrees: [{ worktreeId: "wt-task", branch: "feature/task", kind: "worktree", dirty: false }] },
      ],
    }
    const result = listLocalRepositories(linked)
    expect(result).toHaveLength(1)
    expect(result[0]?.worktrees.map(({ worktreeId, path }) => ({ worktreeId, path }))).toEqual([
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
    const { repoId, worktreeId } = initRepo(repo)
    const destination = join(worktreeRoot, "smoke-local-B")
    execFileSync("git", ["-C", repo, "worktree", "add", "-b", "smoke/local/B", "--", destination, "HEAD"])
    writeFileSync(join(destination, "untracked.txt"), "dirty\n")
    const outside = join(root, "unadvertised-sibling")
    execFileSync("git", ["-C", repo, "worktree", "add", "-b", "secret/outside", "--", outside, "HEAD"])
    const prunable = join(worktreeRoot, "removed-stale")
    execFileSync("git", ["-C", repo, "worktree", "add", "-b", "stale/prunable", "--", prunable, "HEAD"])
    rmSync(prunable, { recursive: true, force: true })
    const snapshot: RepoMapV1 = {
      version: 1,
      nodeId: "node-a",
      worktreeRoot,
      repositories: [{
        host: "github.com",
        name: "team/live",
        path: repo,
        repoId,
        worktrees: [{ worktreeId, branch: "main", kind: "main", dirty: false }],
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
    expect(result.repositories[0]?.worktrees.some((worktree) => worktree.branch === "secret/outside")).toBe(false)
    await expect(listRepositories({ repoMap: snapshot }, { query: "smoke-local-B" })).resolves.toMatchObject({ repositories: [{ repoId }] })
    const peerView = await listLiveLocalRepositories(snapshot, undefined, [repo])
    expect(peerView[0]?.worktrees.map((worktree) => worktree.branch)).toEqual(["main"])
  })
})
