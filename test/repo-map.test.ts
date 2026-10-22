import { describe, expect, test } from "bun:test"
import { parseRepoMap } from "../src/tree/repo-map.js"

describe("repo-map v1", () => {
  test("preserves local inventory identifiers and peer secret path references", () => {
    const map = parseRepoMap({
      version: 1,
      nodeId: "node-a",
      repositories: [{
        host: "github.com",
        name: "team/alpha",
        path: "/work/alpha",
        repoId: "sha256:repo-a",
        worktrees: [
          { worktreeId: "sha256:main", branch: "main", kind: "main", dirty: true },
          { worktreeId: "sha256:wt", branch: "feature/demo", kind: "worktree", dirty: false },
        ],
      }],
      peers: [{ peerId: "node-b", url: "https://node-b.example", secretFile: "/private/node-b.key", allowedRoots: ["/work"] }],
    })
    expect(map.nodeId).toBe("node-a")
    expect(map.repositories[0]?.repoId).toBe("sha256:repo-a")
    expect(map.repositories[0]?.worktrees.map(({ kind, dirty }) => ({ kind, dirty }))).toEqual([
      { kind: "main", dirty: true },
      { kind: "worktree", dirty: false },
    ])
    expect(map.peers[0]).toEqual({ peerId: "node-b", url: "https://node-b.example", secretFile: "/private/node-b.key", allowedRoots: ["/work"] })
  })

  test("rejects unsupported schema versions and duplicate peer ids", () => {
    expect(() => parseRepoMap({ version: 2, nodeId: "node-a", repositories: [], peers: [] })).toThrow("version must be 1")
    expect(() => parseRepoMap({
      version: 1,
      nodeId: "node-a",
      repositories: [],
      peers: [
        { peerId: "node-b", url: "https://one", secretFile: "/a", allowedRoots: [] },
        { peerId: "node-b", url: "https://two", secretFile: "/b", allowedRoots: [] },
      ],
    })).toThrow("is invalid")
  })
})
