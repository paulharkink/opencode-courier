import { describe, expect, test } from "bun:test"
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
})
