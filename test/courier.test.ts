import { describe, expect, spyOn, test } from "bun:test"
import { spawn } from "../src/tree/spawn.js"
import { send } from "../src/tree/send.js"
import { listChildren, status } from "../src/tree/status.js"
import type { CourierPorts } from "../src/tree/ports.js"
import { DEFAULT_LIMITS } from "../src/tree/domain.js"
import { describeFailure, envelope } from "../src/kernel/protocol.js"
import { childBrief, reportBody } from "../src/tree/text.js"
import { joinGroup } from "../src/tree/group.js"
import { childStore, groupStore, memberKey, progressKey, rosterKey, settledKey } from "../src/tree/store.js"
import { createIdentityManager } from "../src/tree/session.js"
import { close } from "../src/tree/close.js"

type Call = { method: string; input: any }

/** What spawn did after looking up the model to give the child. */
const afterLookups = (calls: Call[]) => calls.filter((call) => call.method !== "session.get" && call.method !== "agent.get")

function fakePorts(overrides: { messages?: unknown[]; info?: Record<string, unknown>; agent?: Record<string, unknown> } = {}) {
  const calls: Call[] = []
  const store = new Map<string, unknown>()
  const nudges: number[] = []
  const logs: string[] = []
  const record = (method: string, result: unknown) => async (input: any) => {
    calls.push({ method, input })
    return result
  }
  const ports = {
    directory: "/repo",
    projectID: "proj_1",
    now: () => 1_000,
    storage: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => void store.set(key, value),
      remove: async (key: string) => void store.delete(key),
      scan: async ({ prefix }: { prefix: string }) => ({
        entries: [...store].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
      }),
    },
    session: {
      create: record("session.create", { id: "ses_child", location: { directory: "/repo" } }),
      prompt: record("session.prompt", { id: "msg_1" }),
      synthetic: record("session.synthetic", { id: "msg_2" }),
      get: record("session.get", {
        id: "ses_child",
        title: "Fix the bug",
        parentID: undefined,
        outcome: "succeeded",
        time: { created: 1, updated: 5, idle: 5 },
        ...overrides.info,
      }),
      context: record("session.context", overrides.messages ?? []),
    },
    agent: { get: record("agent.get", { data: { id: "build", ...overrides.agent } }) },
    worktree: {
      create: record("worktree.create", { directory: "/repo/.worktrees/ses" }),
      remove: record("worktree.remove", undefined),
    },
    head: async () => "abc123",
    dirty: async () => false,
    pending: async () => [],
    forms: async () => [],
    limits: DEFAULT_LIMITS,
    gate: { reserved: new Set(), turn: Promise.resolve() },
    roles: new Map(),
    nudge: () => void nudges.push(calls.length),
    log: (message: string) => void logs.push(message),
  } as unknown as CourierPorts
  return { ports, calls, store, nudges, logs }
}

describe("spawn", () => {
  test("a configured repo map requires a registered Head Unit and forbids legacy spawn", async () => {
    const { ports, calls } = fakePorts({ info: { projectID: "proj_1" } })
    ;(ports as any).repoMap = { version: 1, nodeId: "node_a", repositories: [], peers: [] }

    await expect(spawn(ports, "ses_parent", { task: "t", isolate: true })).rejects.toThrow("Register this user-facing session")
    expect(afterLookups(calls)).toEqual([])

    await createIdentityManager(ports.storage).register("ses_parent", "proj_1", "Polyrepo")
    await expect(spawn(ports, "ses_parent", { task: "t", isolate: true })).rejects.toThrow("Registered Courier Head Units must spawn")
    expect(afterLookups(calls)).toEqual([])
  })

  test("a registered Head Unit cannot bypass repo-map policy when no repo map is configured", async () => {
    const { ports, calls } = fakePorts({ info: { projectID: "proj_1" } })
    await createIdentityManager(ports.storage).register("ses_parent", "proj_1", "Polyrepo")

    await expect(spawn(ports, "ses_parent", { task: "t", isolate: true })).rejects.toThrow("Registered Courier Head Units must spawn")
    expect(afterLookups(calls)).toEqual([])
  })

  test("a prepared remote worker is interrupted and released when starting it fails", async () => {
    const { ports, store } = fakePorts({ info: { projectID: "proj_1" } })
    const identity = createIdentityManager(ports.storage)
    await identity.register("ses_parent", "proj_1", "Polyrepo")
    ;(ports as any).remote = { nodeId: "head", peers: { worker: { url: "http://worker.test", secret: "x", allowedRoots: [] } } }
    ;(ports.gate as any).assignments = new Map()
    const operations: string[] = []
    const fetch = spyOn(globalThis, "fetch").mockImplementation((async (_input: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body))
      operations.push(request.operation)
      if (request.operation === "repositories")
        return Response.json({ result: { repositories: [{ nodeId: "worker", host: "github", name: "repo", path: "/remote/repo", repoId: "repo-id", worktrees: [{ worktreeId: "wt-id", branch: "main", kind: "main", dirty: false, path: "/remote/repo" }] }] } })
      if (request.operation === "prepareRepo")
        return Response.json({ result: { sessionID: "ses_remote", directory: "/remote/repo", sourceDirectory: "/remote/repo", title: "Task", assignmentID: "assignment_remote", branch: "main", baseCommit: "abc123", dirty: false } })
      if (request.operation === "start") return Response.json({ error: "start refused" }, { status: 500 })
      if (request.operation === "abortPreparedRepo") return Response.json({ result: { stopped: true, retainedWorkspace: true } })
      return Response.json({ error: "unexpected operation" }, { status: 500 })
    }) as typeof globalThis.fetch)
    try {
      await expect(spawn(ports, "ses_parent", {
        task: "do work",
        workName: "Task",
        peer: "worker",
        repo: { host: "github", name: "repo", repoId: "repo-id" },
        branch: { mode: "existing", name: "main" },
        checkout: { mode: "main" },
      })).rejects.toThrow("start refused")
      expect(operations).toEqual(["repositories", "prepareRepo", "start", "abortPreparedRepo"])
      expect((ports.gate.assignments as Map<string, any>).get("assignment_remote").closed).toBe(true)
      expect(await childStore(ports.storage).indexedEntry("worker/ses_remote")).toMatchObject({ assignmentID: "assignment_remote", nodeId: "worker" })
      expect(store.has(rosterKey("ses_parent", "worker/ses_remote"))).toBe(true)
    } finally {
      fetch.mockRestore()
    }
  })

  test("an unreachable remote abort keeps the assignment owned and returns an explicit close target", async () => {
    const { ports } = fakePorts({ info: { projectID: "proj_1" } })
    await createIdentityManager(ports.storage).register("ses_parent", "proj_1", "Polyrepo")
    ;(ports as any).remote = { nodeId: "head", peers: { worker: { url: "http://worker.test", secret: "x", allowedRoots: [] } } }
    ;(ports.gate as any).assignments = new Map()
    const fetch = spyOn(globalThis, "fetch").mockImplementation((async (_input: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body))
      if (request.operation === "repositories")
        return Response.json({ result: { repositories: [{ nodeId: "worker", host: "github", name: "repo", path: "/remote/repo", repoId: "repo-id", worktrees: [{ worktreeId: "wt-id", branch: "main", kind: "main", dirty: false, path: "/remote/repo" }] }] } })
      if (request.operation === "prepareRepo")
        return Response.json({ result: { sessionID: "ses_remote", directory: "/remote/repo", sourceDirectory: "/remote/repo", title: "Task", assignmentID: "assignment_remote", branch: "main", baseCommit: "abc123", dirty: false } })
      if (request.operation === "start") return Response.json({ error: "start refused" }, { status: 500 })
      if (request.operation === "abortPreparedRepo") return Response.json({ error: "peer unavailable" }, { status: 503 })
      return Response.json({ error: "unexpected operation" }, { status: 500 })
    }) as typeof globalThis.fetch)
    try {
      await expect(spawn(ports, "ses_parent", {
        task: "do work",
        workName: "Task",
        peer: "worker",
        repo: { host: "github", name: "repo", repoId: "repo-id" },
        branch: { mode: "existing", name: "main" },
        checkout: { mode: "main" },
      })).rejects.toThrow("Remote worker worker/ses_remote remains assigned")
      expect((ports.gate.assignments as Map<string, any>).get("assignment_remote").sessionID).toBe("worker/ses_remote")
      expect((ports.gate.assignments as Map<string, any>).get("assignment_remote").closed).toBeUndefined()
    } finally {
      fetch.mockRestore()
    }
  })

  test("courier_close can recover a prepared remote session without a local roster entry", async () => {
    const { ports } = fakePorts({ info: { projectID: "proj_1" } })
    await createIdentityManager(ports.storage).register("ses_parent", "proj_1", "Polyrepo")
    ;(ports as any).remote = { nodeId: "head", peers: { worker: { url: "http://worker.test", secret: "x", allowedRoots: [] } } }
    let abortCalls = 0
    const fetch = spyOn(globalThis, "fetch").mockImplementation((async (_input: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body))
      expect(request.operation).toBe("abortPreparedRepo")
      abortCalls += 1
      return Response.json({ result: { stopped: true, retainedWorkspace: true } })
    }) as typeof globalThis.fetch)
    try {
      const targetID = "worker/ses_remote"
      const result = await close(
        { courier: ports, identity: createIdentityManager(ports.storage), cancelScheduled: async () => [], cleanup: {} } as any,
        "ses_parent",
        targetID,
      )
      expect(abortCalls).toBe(1)
      expect(result).toMatchObject({ closedSessionIDs: [targetID], releasedAssignments: [], errors: [], retainedWorkspaces: true })
      expect(await childStore(ports.storage).indexedEntry(targetID)).toBeUndefined()
    } finally {
      fetch.mockRestore()
    }
  })

  test("creates the child, then prompts it with a brief naming the parent", async () => {
    const { ports, calls: all } = fakePorts()

    const child = await spawn(ports, "ses_parent", { task: "Fix the bug\nin checkout" })
    const calls = afterLookups(all)

    expect(child).toEqual({ sessionID: "ses_child", directory: "/repo" })
    expect(calls.map((call) => call.method)).toEqual(["session.create", "session.prompt"])
    expect(calls[0]!.input).toEqual({ title: "Fix the bug", metadata: { courier: { parentID: "ses_parent" } } })
    expect(calls[1]!.input).toEqual({ sessionID: "ses_child", text: childBrief("ses_parent", "Fix the bug\nin checkout", 1, DEFAULT_LIMITS) })
  })

  describe("with the nativeChildren option", () => {
    test("creates a child without isolate with OpenCode's parentID and an empty ruleset, and records it as native", async () => {
      const { ports, calls, store } = fakePorts()
      ;(ports as any).nativeChildren = true

      await spawn(ports, "ses_parent", { task: "Fix the bug" })

      expect(calls.find((call) => call.method === "session.create")!.input).toEqual({
        title: "Fix the bug",
        parentID: "ses_parent",
        permissions: [],
        metadata: { courier: { parentID: "ses_parent" } },
      })
      expect(store.get(rosterKey("ses_parent", "ses_child"))).toMatchObject({ isolated: false, native: true })
    })

    test("leaves an isolated child as before: its worktree's location, no parentID", async () => {
      const { ports, calls, store } = fakePorts()
      ;(ports as any).nativeChildren = true

      await spawn(ports, "ses_parent", { task: "t", isolate: true })

      const input = calls.find((call) => call.method === "session.create")!.input
      expect(input).toEqual({ title: "t", location: { directory: "/repo/.worktrees/ses" }, metadata: { courier: { parentID: "ses_parent" } } })
      expect(store.get(rosterKey("ses_parent", "ses_child"))).not.toHaveProperty("native")
    })

    test("is off by default: no parentID, nothing recorded", async () => {
      const { ports, calls, store } = fakePorts()

      await spawn(ports, "ses_parent", { task: "t" })

      expect(calls.find((call) => call.method === "session.create")!.input).not.toHaveProperty("parentID")
      expect(store.get(rosterKey("ses_parent", "ses_child"))).not.toHaveProperty("native")
    })
  })

  test("records the child on its parent's roster before prompting it", async () => {
    const { ports, store } = fakePorts()
    ;(ports.session as any).prompt = async () => {
      throw new Error("prompt failed")
    }

    await expect(spawn(ports, "ses_parent", { task: "Fix the bug" })).rejects.toThrow("prompt failed")

    expect(store.get(rosterKey("ses_parent", "ses_child"))).toEqual({
      sessionID: "ses_child",
      parentID: "ses_parent",
      title: "Fix the bug",
      directory: "/repo",
      isolated: false,
      createdAt: 1_000,
      reports: "status",
    })
  })

  test("still prompts the child when the roster cannot be written, and says so", async () => {
    const { ports, calls: all } = fakePorts()
    ;(ports.storage as any).set = async () => {
      throw new Error("disk full")
    }

    const child = await spawn(ports, "ses_parent", { task: "t" })
    const calls = afterLookups(all)

    expect(calls.map((call) => call.method)).toEqual(["session.create", "session.prompt"])
    expect(child).toEqual({ sessionID: "ses_child", directory: "/repo", rosterError: "roster failed: disk full" })
  })

  test("keeps no report state for a child the roster could not record, which nothing would ever remove", async () => {
    const { ports, store } = fakePorts()
    const set = ports.storage.set
    ;(ports.storage as any).set = async (key: string, value: any) => {
      if (key.startsWith("roster/")) throw new Error("disk full")
      return set(key, value)
    }

    await spawn(ports, "ses_parent", { task: "t" })
    ;(ports.session as any).prompt = async () => {
      throw new Error("prompt failed")
    }
    await expect(spawn(ports, "ses_parent", { task: "t" })).rejects.toThrow("prompt failed")

    expect([...store.keys()].filter((key) => key.startsWith("report/"))).toEqual([])
  })

  test("passes the agent and title through", async () => {
    const { ports, calls: all } = fakePorts()

    await spawn(ports, "ses_parent", { task: "t", title: "Custom", agent: "build" })
    const calls = afterLookups(all)

    expect(calls[0]!.input).toMatchObject({ title: "Custom", agent: "build" })
  })

  test("with isolate, creates a worktree and runs the child there", async () => {
    const { ports, calls: all } = fakePorts()

    const child = await spawn(ports, "ses_parent", { task: "t", isolate: true })
    const calls = afterLookups(all)

    expect(calls[0]).toEqual({ method: "worktree.create", input: { projectID: "proj_1" } })
    expect(calls[1]!.input).toMatchObject({ location: { directory: "/repo/.worktrees/ses" } })
    expect(child.directory).toBe("/repo/.worktrees/ses")
  })

  test("records an isolated child with its worktree and the directory it was made from", async () => {
    const { ports, store } = fakePorts()

    await spawn(ports, "ses_parent", { task: "t", title: "Custom", isolate: true })

    expect(store.get(rosterKey("ses_parent", "ses_child"))).toMatchObject({
      title: "Custom",
      directory: "/repo/.worktrees/ses",
      isolated: true,
      source: "/repo",
      project: "proj_1",
      base: "abc123",
    })
  })

  describe("nested isolation", () => {
    test("a spawned worker cannot create any Courier child session", async () => {
      const { ports, calls } = fakePorts()
      await childStore(ports.storage).record({ sessionID: "ses_parent", parentID: "ses_root", title: "P", directory: "/wt/parent", isolated: true, createdAt: 1 })
      await expect(spawn(ports, "ses_parent", { task: "t", isolate: true })).rejects.toThrow("Courier workers cannot start child sessions")
      expect(afterLookups(calls)).toEqual([])
    })

    test("briefs an isolated child with its branch, and a plain one without", async () => {
      const { ports, calls } = fakePorts()
      await spawn(ports, "ses_parent", { task: "t", isolate: true })
      expect(calls.find((call) => call.method === "session.prompt")!.input.text).toBe(
        childBrief("ses_parent", "t", 1, DEFAULT_LIMITS, "courier/ses_child"),
      )
      expect(childBrief("ses_parent", "t", 1, DEFAULT_LIMITS)).not.toContain("courier/")
    })
  })

  test("removes the fresh worktree when the session cannot be created", async () => {
    const { ports, calls: all, store } = fakePorts()
    ;(ports.session as any).create = async () => {
      throw new Error("no such agent")
    }

    await expect(spawn(ports, "ses_parent", { task: "t", isolate: true })).rejects.toThrow("no such agent")
    const calls = afterLookups(all)

    expect(calls.map((call) => call.method)).toEqual(["worktree.create", "worktree.remove"])
    expect(calls[1]!.input).toEqual({ projectID: "proj_1", directory: "/repo/.worktrees/ses", force: false })
    expect(store.size).toBe(0)
  })

  test("shortens a long first line for the title", async () => {
    const { ports, calls: all } = fakePorts()

    await spawn(ports, "ses_parent", { task: "x".repeat(100) })
    const calls = afterLookups(all)

    expect(calls[0]!.input.title).toBe(`${"x".repeat(57)}...`)
  })

  test("gives the child its parent's model", async () => {
    const model = { id: "chat", providerID: "mock", variant: "default" }
    const { ports, calls } = fakePorts({ info: { model } })

    await spawn(ports, "ses_parent", { task: "t" })

    expect(calls[0]).toEqual({ method: "session.get", input: { sessionID: "ses_parent" } })
    expect(calls.find((call) => call.method === "session.create")!.input).toMatchObject({ model })
  })

  test("gives it the parent's model with an agent that names none", async () => {
    const model = { id: "chat", providerID: "mock" }
    const { ports, calls } = fakePorts({ info: { model } })

    await spawn(ports, "ses_parent", { task: "t", agent: "build" })

    expect(calls.find((call) => call.method === "agent.get")!.input).toEqual({ agentID: "build", location: { directory: "/repo" } })
    expect(calls.find((call) => call.method === "session.create")!.input).toMatchObject({ agent: "build", model })
  })

  test("leaves the model to an agent that names its own", async () => {
    const { ports, calls } = fakePorts({
      info: { model: { id: "chat", providerID: "mock" } },
      agent: { model: { id: "small", providerID: "mock" } },
    })

    await spawn(ports, "ses_parent", { task: "t", agent: "build" })

    expect(calls.find((call) => call.method === "session.create")!.input).not.toHaveProperty("model")
  })

  test("starts the child on OpenCode's default when the parent's model cannot be looked up", async () => {
    const { ports, calls } = fakePorts()
    ;(ports.session as any).get = async () => {
      throw new Error("lookup failed")
    }

    const child = await spawn(ports, "ses_parent", { task: "t" })

    expect(child.sessionID).toBe("ses_child")
    expect(calls[0]!.input).not.toHaveProperty("model")
  })
})
describe("spawn, into a group", () => {
  test("records the group on the roster entry, joins the child to it with its title, and says so", async () => {
    const { ports, store } = fakePorts()

    const child = await spawn(ports, "ses_parent", { task: "Review a.ts", group: "reviews" })

    expect(child).toEqual({ sessionID: "ses_child", directory: "/repo", group: "reviews" })
    expect(store.get(rosterKey("ses_parent", "ses_child"))).toMatchObject({ group: "reviews" })
    expect(store.get(memberKey("ses_parent", "reviews", "ses_child"))).toEqual({ title: "Review a.ts", joinedAt: 1_000 })
  })

  test("refuses a name that is not one before starting anything, and takes null for none", async () => {
    const { ports, calls } = fakePorts()

    await expect(spawn(ports, "ses_parent", { task: "t", group: "a/b" })).rejects.toThrow('group must be a name of 1 to 60 letters, digits, dots, dashes or underscores, not "a/b".')
    expect(calls).toEqual([])
    expect(await spawn(ports, "ses_parent", { task: "t", group: null as never })).toEqual({ sessionID: "ses_child", directory: "/repo" })
    expect(await spawn(ports, "ses_parent", { task: "t", group: " " })).toEqual({ sessionID: "ses_child", directory: "/repo" })
    expect(await spawn(ports, "ses_parent", { task: "t", group: " pair " })).toMatchObject({ group: "pair" })
  })

  test("a child in a group that never got its task leaves the group, so the group does not wait for it", async () => {
    const { ports, store, nudges } = fakePorts()
    await joinGroup(groupStore(ports.storage), "ses_parent", "reviews", "ses_other", "Other", 1)
    await ports.storage.set(memberKey("ses_parent", "reviews", "ses_other"), { title: "Other", joinedAt: 1, report: { at: 2, status: "done", message: "m" } })
    ;(ports.session as any).prompt = async () => {
      throw new Error("prompt failed")
    }

    await expect(spawn(ports, "ses_parent", { task: "t", group: "reviews" })).rejects.toThrow("prompt failed")

    expect(store.get(memberKey("ses_parent", "reviews", "ses_child"))).toEqual({ title: "t", joinedAt: 1_000, left: { at: 1_000, by: "failed" } })
    expect(nudges).toHaveLength(1)
  })

  test("starts the child in no group, and says so, when it cannot be joined; a child off the roster joins none", async () => {
    const { ports, store } = fakePorts()
    const set = ports.storage.set
    ;(ports.storage as any).set = async (key: string, value: unknown) => {
      if (key.startsWith("group/")) throw new Error("disk full")
      return set(key, value as never)
    }
    expect(await spawn(ports, "ses_parent", { task: "t", group: "reviews" })).toEqual({ sessionID: "ses_child", directory: "/repo", groupError: "group failed: disk full" })
    // Recorded in no group, so courier_children does not show it as one whose report was released.
    expect(store.get(rosterKey("ses_parent", "ses_child"))).not.toHaveProperty("group")

    // A write that fails after landing leaves no member behind for its group to wait on.
    ;(ports.storage as any).set = async (key: string, value: unknown) => {
      await set(key, value as never)
      if (key.startsWith("group/")) throw new Error("timed out")
    }
    expect(await spawn(ports, "ses_parent", { task: "t", group: "reviews" })).toMatchObject({ groupError: "group failed: timed out" })
    expect([...store.keys()].filter((key) => key.startsWith("group/"))).toEqual([])

    ;(ports.storage as any).set = async () => {
      throw new Error("disk full")
    }
    expect(await spawn(ports, "ses_parent", { task: "t", group: "reviews" })).toEqual({ sessionID: "ses_child", directory: "/repo", rosterError: "roster failed: disk full" })
    expect([...store.keys()].filter((key) => key.startsWith("group/"))).toEqual([])
  })
})

describe("send", () => {
  test("delivers a synthetic message that steers by default and leaves resume on", async () => {
    const { ports, calls } = fakePorts()

    const result = await send(ports, "ses_child", { sessionID: "ses_parent", message: "Done: PR #4" })

    // Not a spawned session: neither a report nor progress.
    expect(result).toEqual({ messageID: "msg_2" })
    expect(calls[0]).toEqual({
      method: "session.synthetic",
      input: {
        sessionID: "ses_parent",
        text: envelope("ses_child", "Done: PR #4"),
        description: "Message from ses_child",
        metadata: { source: "courier", from: "ses_child" },
        delivery: "steer",
      },
    })
    expect(calls[0]!.input).not.toHaveProperty("resume")
  })

  test("queues when asked", async () => {
    const { ports, calls } = fakePorts()

    await send(ports, "ses_child", { sessionID: "ses_parent", message: "m", queue: true })

    expect(calls[0]!.input.delivery).toBe("queue")
  })

  const spawned = { sessionID: "ses_child", parentID: "ses_parent", title: "t", directory: "/repo", isolated: false, createdAt: 1, reports: "status" as const }
  const report = { sessionID: "ses_parent", message: "m", status: "done" as const }

  test("notes a spawned session's message with a status to its parent, and only that, as its report, with the status", async () => {
    const { ports, store } = fakePorts()
    await childStore(ports.storage).record(spawned)

    await send(ports, "ses_child", { sessionID: "ses_other", message: "m", status: "done" })
    expect(store.has(settledKey("ses_child"))).toBe(false)
    await send(ports, "ses_parent", { sessionID: "ses_child", message: "m", status: "done" })
    expect(store.has(settledKey("ses_parent"))).toBe(false)
    expect(await send(ports, "ses_child", { sessionID: "ses_parent", message: "m", status: "blocked" })).toEqual({ messageID: "msg_2", status: "blocked", report: true })
    expect(store.get(settledKey("ses_child"))).toEqual({ at: 1_000, by: "report", status: "blocked" })
  })

  test("carries the status as an attribute of the envelope and in the metadata, and the artifacts in the body", async () => {
    const { ports, calls } = fakePorts()
    const artifacts = { branch: "fix/checkout", commits: ["abc1234"], files: ["src/a.ts"], checks: [{ command: "bun test", result: "412 passed" }] }

    await send(ports, "ses_child", { sessionID: "ses_parent", message: "Fixed it.", status: "done", artifacts })

    expect(calls[0]!.input).toEqual({
      sessionID: "ses_parent",
      text: envelope("ses_child", reportBody("Fixed it.", artifacts), { status: "done" }),
      description: "Message from ses_child",
      metadata: { source: "courier", from: "ses_child", status: "done" },
      delivery: "steer",
    })
    expect(calls[0]!.input.text).toStartWith('<courier from="ses_child" status="done">\nFixed it.\n\nArtifacts:\n- branch: fix/checkout\n')
  })

  test("refuses a status that is none of the four, since OpenCode does not check the schema", async () => {
    const { ports, calls } = fakePorts()

    await expect(send(ports, "ses_child", { sessionID: "ses_parent", message: "m", status: "finished" as never })).rejects.toThrow(
      'status must be one of done, partial, blocked, failed, not "finished".',
    )
    expect(calls).toEqual([])
    // Some models send null for an optional field they leave out.
    expect(await send(ports, "ses_child", { sessionID: "ses_parent", message: "m", status: null as never })).toEqual({ messageID: "msg_2" })
  })

  test("notes a message without a status to the parent as progress, not as the report, and says so", async () => {
    const { ports, store } = fakePorts()
    await childStore(ports.storage).record(spawned)

    expect(await send(ports, "ses_child", { sessionID: "ses_parent", message: "halfway" })).toEqual({ messageID: "msg_2", report: false })

    expect(store.has(settledKey("ses_child"))).toBe(false)
    expect(store.get(progressKey("ses_child"))).toEqual({ at: 1_000 })
    await send(ports, "ses_child", { sessionID: "ses_other", message: "m" })
    expect(store.has(progressKey("ses_other"))).toBe(false)
  })

  test("takes a message without a status from a child an older release briefed as its report, as before", async () => {
    const { ports, store } = fakePorts()
    const { reports, ...older } = spawned
    await childStore(ports.storage).record(older)

    expect(await send(ports, "ses_child", { sessionID: "ses_parent", message: "m" })).toEqual({ messageID: "msg_2", report: true })

    expect(store.get(settledKey("ses_child"))).toEqual({ at: 1_000, by: "report" })
    expect(store.has(progressKey("ses_child"))).toBe(false)
  })

  test("notes the report before delivering it, which may end the parent's turn at once", async () => {
    const { ports, store } = fakePorts()
    await childStore(ports.storage).record(spawned)
    let noted: unknown
    ;(ports.session as any).synthetic = async () => {
      noted = store.get(settledKey("ses_child"))
      return { id: "msg_3" }
    }
    await send(ports, "ses_child", report)
    expect(noted).toEqual({ at: 1_000, by: "report", status: "done" })
  })

  test("takes the note back when the message is not delivered, and delivers it when the report cannot be noted", async () => {
    const { ports, store } = fakePorts()
    await childStore(ports.storage).record(spawned)
    ;(ports.session as any).synthetic = async () => Promise.reject(new Error("parent is gone"))
    await expect(send(ports, "ses_child", report)).rejects.toThrow("parent is gone")
    expect(store.has(settledKey("ses_child"))).toBe(false)
    await expect(send(ports, "ses_child", { sessionID: "ses_parent", message: "m" })).rejects.toThrow("parent is gone")
    expect(store.has(progressKey("ses_child"))).toBe(false)
    store.set(settledKey("ses_child"), { at: 5, by: "failed" })
    await expect(send(ports, "ses_child", report)).rejects.toThrow("parent is gone")
    expect(store.get(settledKey("ses_child"))).toEqual({ at: 5, by: "failed" })

    // Another courier_send of the child's noted its report meanwhile: that note stays.
    ;(ports.session as any).synthetic = async () => {
      store.set(settledKey("ses_child"), { at: 2_000, by: "report", status: "done" })
      throw new Error("parent is gone")
    }
    await expect(send(ports, "ses_child", report)).rejects.toThrow("parent is gone")
    expect(store.get(settledKey("ses_child"))).toEqual({ at: 2_000, by: "report", status: "done" })

    store.delete(settledKey("ses_child"))
    ;(ports.session as any).synthetic = async () => ({ id: "msg_3" })
    ;(ports.storage as any).set = async () => Promise.reject(new Error("disk full"))
    expect(await send(ports, "ses_child", report)).toEqual({ messageID: "msg_3", status: "done" })
  })
})

describe("send, from a member of a group", () => {
  const spawned = { sessionID: "ses_child", parentID: "ses_parent", title: "A", directory: "/repo", isolated: false, createdAt: 1, reports: "status" as const, group: "pair" }
  async function grouped(ports: CourierPorts) {
    await childStore(ports.storage).record(spawned)
    await childStore(ports.storage).record({ ...spawned, sessionID: "ses_other", title: "B" })
    await joinGroup(groupStore(ports.storage), "ses_parent", "pair", "ses_child", "A", 1)
    await joinGroup(groupStore(ports.storage), "ses_parent", "pair", "ses_other", "B", 2)
  }

  test("holds a report with a final status instead of delivering it, settles the report, and says so", async () => {
    const { ports, calls, store, nudges } = fakePorts()
    await grouped(ports)
    const artifacts = { files: ["a.ts"] }

    const sent = await send(ports, "ses_child", { sessionID: "ses_parent", message: "Done.", status: "done", artifacts })

    expect(sent).toEqual({ status: "done", report: true, held: { group: "pair", reported: 1, members: 2 } })
    expect(calls.filter((call) => call.method === "session.synthetic")).toEqual([])
    expect(store.get(settledKey("ses_child"))).toEqual({ at: 1_000, by: "report", status: "done" })
    expect(store.get(memberKey("ses_parent", "pair", "ses_child"))).toEqual({ title: "A", joinedAt: 1, report: { at: 1_000, status: "done", message: "Done.", artifacts } })
    expect(nudges).toEqual([])
  })

  test("a member courier_cleanup dropped reports on its own, as a child in no group, and stays dropped", async () => {
    const { ports, calls, store } = fakePorts()
    await grouped(ports)
    const dropped = { title: "A", joinedAt: 1, left: { at: 50, by: "dropped" } }
    store.set(memberKey("ses_parent", "pair", "ses_child"), dropped)

    const sent = await send(ports, "ses_child", { sessionID: "ses_parent", message: "Done after all.", status: "done" })

    expect(sent).toMatchObject({ status: "done", report: true })
    expect(sent).not.toHaveProperty("held")
    expect(calls.filter((call) => call.method === "session.synthetic")).toHaveLength(1)
    expect(store.get(memberKey("ses_parent", "pair", "ses_child"))).toEqual(dropped)
  })

  test("has the scheduler deliver the group once the last member's report is held", async () => {
    const { ports, nudges } = fakePorts()
    await grouped(ports)

    await send(ports, "ses_child", { sessionID: "ses_parent", message: "m", status: "partial" })
    expect(nudges).toEqual([])
    expect(await send(ports, "ses_other", { sessionID: "ses_parent", message: "m", status: "failed" })).toEqual({
      status: "failed",
      report: true,
      held: { group: "pair", reported: 2, members: 2 },
    })
    expect(nudges).toHaveLength(1)
  })

  test("delivers a blocked report and progress at once, as for a child in no group", async () => {
    const { ports, calls, store } = fakePorts()
    await grouped(ports)

    expect(await send(ports, "ses_child", { sessionID: "ses_parent", message: "Which?", status: "blocked" })).toEqual({ messageID: "msg_2", status: "blocked", report: true })
    expect(await send(ports, "ses_child", { sessionID: "ses_parent", message: "halfway" })).toEqual({ messageID: "msg_2", report: false })

    expect(calls.filter((call) => call.method === "session.synthetic")).toHaveLength(2)
    expect(store.get(memberKey("ses_parent", "pair", "ses_child"))).toEqual({ title: "A", joinedAt: 1 })
    expect(store.get(settledKey("ses_child"))).toEqual({ at: 1_000, by: "report", status: "blocked" })
  })

  test("a blocked report after a held one drops the held one, stale now, so the member is out again", async () => {
    const { ports, store } = fakePorts()
    await grouped(ports)
    await send(ports, "ses_child", { sessionID: "ses_parent", message: "Done.", status: "done" })
    expect(store.get(memberKey("ses_parent", "pair", "ses_child"))).toMatchObject({ report: { status: "done" } })

    // Only once the blocked report is delivered: one that is not leaves the held report in place.
    ;(ports.session as any).synthetic = async () => Promise.reject(new Error("parent is gone"))
    await expect(send(ports, "ses_child", { sessionID: "ses_parent", message: "Which?", status: "blocked" })).rejects.toThrow("parent is gone")
    expect(store.get(memberKey("ses_parent", "pair", "ses_child"))).toMatchObject({ report: { status: "done" } })
    ;(ports.session as any).synthetic = async () => ({ id: "msg_3" })
    await send(ports, "ses_child", { sessionID: "ses_parent", message: "On second thought, which?", status: "blocked" })

    expect(store.get(memberKey("ses_parent", "pair", "ses_child"))).toEqual({ title: "A", joinedAt: 1 })
  })

  test("a blocked report does not open again a group released while it was going out", async () => {
    const { ports, store } = fakePorts()
    await grouped(ports)
    await send(ports, "ses_child", { sessionID: "ses_parent", message: "Done.", status: "done" })
    ;(ports.session as any).synthetic = async () => {
      for (const key of [...store.keys()]) if (key.startsWith("group/")) store.delete(key)
      return { id: "msg_3" }
    }

    await send(ports, "ses_child", { sessionID: "ses_parent", message: "Which?", status: "blocked" })

    expect([...store.keys()].filter((key) => key.startsWith("group/"))).toEqual([])
  })

  test("holds the report even when the group cannot be counted after, and says so without the count", async () => {
    const { ports, calls, store, nudges } = fakePorts()
    await grouped(ports)
    const scan = ports.storage.scan
    ;(ports.storage as any).scan = async (input: { prefix: string }) => (input.prefix.startsWith("group/") ? Promise.reject(new Error("locked")) : scan(input))

    expect(await send(ports, "ses_child", { sessionID: "ses_parent", message: "m", status: "done" })).toEqual({ status: "done", report: true, held: { group: "pair" } })

    expect(calls.filter((call) => call.method === "session.synthetic")).toEqual([])
    expect(store.get(memberKey("ses_parent", "pair", "ses_child"))).toMatchObject({ report: { status: "done" } })
    // Nudged all the same: the group may be complete, and a tick that finds nothing due is cheap.
    expect(nudges).toHaveLength(1)
  })

  test("delivers the report at once when the group has been released, or the child was never joined, or it cannot be held", async () => {
    const { ports, calls, store, nudges, logs } = fakePorts()
    await grouped(ports)
    store.delete(memberKey("ses_parent", "pair", "ses_child"))
    expect(await send(ports, "ses_child", { sessionID: "ses_parent", message: "m", status: "done" })).toEqual({ messageID: "msg_2", status: "done", report: true })

    const set = ports.storage.set
    ;(ports.storage as any).set = async (key: string, value: unknown) => {
      if (key.startsWith("group/")) throw new Error("disk full")
      return set(key, value as never)
    }
    expect(await send(ports, "ses_other", { sessionID: "ses_parent", message: "m", status: "done" })).toEqual({ messageID: "msg_2", status: "done", report: true })
    expect(calls.filter((call) => call.method === "session.synthetic")).toHaveLength(2)
    expect(store.get(settledKey("ses_other"))).toEqual({ at: 1_000, by: "report", status: "done" })
    // Dropped from the group, which the scheduler then finds complete without it, so the others are not held for ever.
    expect(store.has(memberKey("ses_parent", "pair", "ses_other"))).toBe(false)
    expect(nudges).toHaveLength(1)

    // Neither held nor dropped: the call fails, its note taken back, so the sender sends it again rather than the group waiting for ever.
    store.set(memberKey("ses_parent", "pair", "ses_other"), { title: "B", joinedAt: 2 })
    store.delete(settledKey("ses_other"))
    const remove = ports.storage.remove
    ;(ports.storage as any).remove = async (key: string) => (key.startsWith("group/") ? Promise.reject(new Error("locked")) : remove(key))
    await expect(send(ports, "ses_other", { sessionID: "ses_parent", message: "m", status: "done" })).rejects.toThrow(
      "the report could not be held with group pair (Error: disk full), nor the member dropped from it (Error: locked); send it again.",
    )
    expect(calls.filter((call) => call.method === "session.synthetic")).toHaveLength(2)
    expect(store.has(settledKey("ses_other"))).toBe(false)
    expect(logs).toEqual([])
  })

  test("a member whose place in the group cannot be read reports on its own, and is dropped from the group, which is logged", async () => {
    const { ports, calls, store, nudges, logs } = fakePorts()
    await grouped(ports)
    const get = ports.storage.get
    ;(ports.storage as any).get = async (key: string) => (key.startsWith("group/") ? Promise.reject(new Error("locked")) : get(key))

    expect(await send(ports, "ses_child", { sessionID: "ses_parent", message: "m", status: "done" })).toEqual({ messageID: "msg_2", status: "done", report: true })

    expect(calls.filter((call) => call.method === "session.synthetic")).toHaveLength(1)
    expect(store.has(memberKey("ses_parent", "pair", "ses_child"))).toBe(false)
    expect(nudges).toHaveLength(1)
    expect(logs).toEqual(["courier_send: ses_child's place in group pair could not be read, so its report goes on its own: Error: locked"])
  })

  test("a message to any session but the parent is not held", async () => {
    const { ports, calls } = fakePorts()
    await grouped(ports)

    expect(await send(ports, "ses_child", { sessionID: "ses_other", message: "m", status: "done" })).toEqual({ messageID: "msg_2", status: "done" })
    expect(calls.filter((call) => call.method === "session.synthetic")).toHaveLength(1)
  })
})

describe("status", () => {
  test("reports the session's state and its last assistant text", async () => {
    const { ports } = fakePorts({
      messages: [
        { type: "user", text: "go" },
        { type: "assistant", content: [{ type: "text", text: "first" }] },
        {
          type: "assistant",
          content: [
            { type: "reasoning", text: "hidden" },
            { type: "text", text: "Opened " },
            { type: "text", text: "PR #4" },
          ],
        },
        { type: "synthetic", text: "later" },
      ],
    })

    expect(await status(ports, { sessionID: "ses_child" })).toStrictEqual({
      sessionID: "ses_child",
      title: "Fix the bug",
      outcome: "succeeded",
      updated: 5,
      idle: 5,
      lastText: "Opened PR #4",
    })
  })

  test("leaves lastText out when the session has not replied", async () => {
    const { ports } = fakePorts()

    expect(await status(ports, { sessionID: "ses_child" })).not.toHaveProperty("lastText")
  })

  test("lists the requests the session waits on, and leaves pending out when there are none", async () => {
    const { ports } = fakePorts()
    const waiting = { type: "permission" as const, requestID: "per_1", action: "shell", resources: ["git push"] }
    ;(ports as any).pending = async (sessionID: string) => (sessionID === "ses_child" ? [waiting] : [])

    expect((await status(ports, { sessionID: "ses_child" })).pending).toEqual([waiting])
    expect(await status(ports, { sessionID: "ses_other" })).not.toHaveProperty("pending")
  })

  test("never returns undefined values, which make OpenCode hang the tool call", async () => {
    const { ports } = fakePorts({ info: { title: undefined, outcome: undefined, time: { created: 1, updated: 2 } } })

    const result = await status(ports, { sessionID: "ses_child" })

    expect(Object.values(result)).not.toContain(undefined)
    expect(result).toStrictEqual({ sessionID: "ses_child", updated: 2 })
  })
})

describe("listChildren", () => {
  test("lists each child with its status and roster fields, or the error looking it up gave", async () => {
    const { ports } = fakePorts({ messages: [{ type: "assistant", content: [{ type: "text", text: "Done" }] }] })
    const get = ports.session.get
    ;(ports.session as any).get = async (input: { sessionID: string }) => {
      if (input.sessionID === "ses_gone") throw Object.assign(new Error(""), { _tag: "Session.NotFoundError", sessionID: "ses_gone" })
      return get(input)
    }
    await childStore(ports.storage).record({ sessionID: "ses_child", parentID: "ses_parent", title: "Fix the bug", directory: "/repo", isolated: false, createdAt: 900 })
    await childStore(ports.storage).record({ sessionID: "ses_gone", parentID: "ses_parent", title: "Gone", directory: "/wt", isolated: true, createdAt: 950 })
    await childStore(ports.storage).record({ sessionID: "ses_else", parentID: "ses_other", title: "Else", directory: "/repo", isolated: false, createdAt: 900 })

    expect(await listChildren(ports, "ses_parent")).toStrictEqual([
      {
        sessionID: "ses_child",
        title: "Fix the bug",
        outcome: "succeeded",
        updated: 5,
        idle: 5,
        lastText: "Done",
        directory: "/repo",
        isolated: false,
        created: 900,
      },
      {
        sessionID: "ses_gone",
        title: "Gone",
        directory: "/wt",
        isolated: true,
        created: 950,
        error: "courier_status failed: Session.NotFoundError ses_gone",
      },
    ])
  })

  test("is empty for a session that started none", async () => {
    const { ports } = fakePorts()

    expect(await listChildren(ports, "ses_parent")).toEqual([])
  })

  test("names each child's group and its standing there: held, out, failed, deleted, released or unknown", async () => {
    const { ports } = fakePorts()
    ;(ports.session as any).get = async (input: { sessionID: string }) => ({ id: input.sessionID, time: { created: 1, updated: 2 } })
    const get = ports.storage.get
    ;(ports.storage as any).get = async (key: string) => (key.endsWith("/ses_unknown") ? Promise.reject(new Error("locked")) : get(key))
    const spawned = { parentID: "ses_parent", title: "t", directory: "/repo", isolated: false, createdAt: 1, reports: "status" as const, group: "pair" }
    for (const [sessionID, member] of [
      ["ses_held", { title: "t", joinedAt: 1, report: { at: 2, status: "done", message: "m" } }],
      ["ses_out", { title: "t", joinedAt: 1 }],
      ["ses_failed", { title: "t", joinedAt: 1, left: { at: 2, by: "failed" } }],
      ["ses_deleted", { title: "t", joinedAt: 1, left: { at: 2, by: "deleted" } }],
      ["ses_released", undefined],
      ["ses_unknown", undefined],
    ] as const) {
      await childStore(ports.storage).record({ ...spawned, sessionID })
      if (member) await ports.storage.set(memberKey("ses_parent", "pair", sessionID), member as never)
    }
    await childStore(ports.storage).record({ ...spawned, sessionID: "ses_plain", group: undefined })

    const listed = await listChildren(ports, "ses_parent")

    expect(listed.map((child) => [child.sessionID, (child as any).group])).toEqual([
      ["ses_held", { name: "pair", report: "held" }],
      ["ses_out", { name: "pair", report: "out" }],
      ["ses_failed", { name: "pair", report: "failed" }],
      ["ses_deleted", { name: "pair", report: "deleted" }],
      ["ses_released", { name: "pair", report: "released" }],
      ["ses_unknown", { name: "pair", report: "unknown" }],
      ["ses_plain", undefined],
    ])
    expect(listed[6]).not.toHaveProperty("group")
  })
})

describe("describeFailure", () => {
  test("keeps an error's message", () => {
    expect(describeFailure("courier_send", new Error("boom")).message).toBe("courier_send failed: boom")
  })

  test("falls back to the tag and session of an OpenCode error with an empty message", () => {
    const error = Object.assign(new Error(""), { _tag: "Session.NotFoundError", sessionID: "ses_x" })

    expect(describeFailure("courier_status", error).message).toBe("courier_status failed: Session.NotFoundError ses_x")
  })
})
