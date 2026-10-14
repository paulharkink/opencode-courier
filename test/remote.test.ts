import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readRemoteConfig, qualify, splitQualified, signature } from "../src/platform/remote.js"
import { receive } from "../src/webhook/receiver.js"
import type { WebhookPorts } from "../src/webhook/subscriptions.js"
import { handleRemote } from "../src/tree/peer.js"
import { spawn } from "../src/tree/spawn.js"
import { DEFAULT_LIMITS } from "../src/tree/domain.js"
import { childStore, rosterKey, settledKey } from "../src/tree/store.js"

describe("remote node configuration and addresses", () => {
  test("loads pairwise secrets from files and keeps peer roots absolute", () => {
    const root = mkdtempSync(join(tmpdir(), "courier-remote-"))
    const secretFile = join(root, "shared.key")
    writeFileSync(secretFile, "pairwise secret\n", { mode: 0o600 })

    const config = readRemoteConfig({
      remoteNodes: {
        nodeId: "head",
        peers: { worker: { url: "http://127.0.0.1:4098", secretFile, allowedRoots: [root] } },
      },
    })!

    expect(config.nodeId).toBe("head")
    expect(config.peers.worker).toMatchObject({ url: "http://127.0.0.1:4098", secret: "pairwise secret", allowedRoots: [root] })
  })

  test("rejects malformed peer identity, endpoint, key, and roots", () => {
    const root = mkdtempSync(join(tmpdir(), "courier-remote-"))
    const secretFile = join(root, "key")
    writeFileSync(secretFile, "key")
    const read = (value: unknown) => readRemoteConfig({ remoteNodes: value })

    expect(() => read({ nodeId: "bad/id", peers: {} })).toThrow("nodeId")
    expect(() => read({ nodeId: "head", peers: { worker: { url: "file:///etc/passwd", secretFile } } })).toThrow("url")
    expect(() => read({ nodeId: "head", peers: { worker: { url: "http://worker:4097", secretFile, allowedRoots: ["relative"] } } })).toThrow("allowedRoots")
    expect(() => read({ nodeId: "head", peers: { worker: { url: "http://worker:4097", secretFile: join(root, "missing") } } })).toThrow("secretFile")
  })

  test("uses node-qualified routing addresses while preserving local bare ids", () => {
    expect(qualify("worker", "ses_child")).toBe("worker/ses_child")
    expect(splitQualified("ses_local")).toBeUndefined()
    expect(splitQualified("worker/ses_child")).toEqual({ nodeId: "worker", sessionID: "ses_child" })
    expect(splitQualified("bad/a/b")).toBeUndefined()
  })

  test("accepts a signed peer operation once and refuses bad auth, peers, and replays", async () => {
    const root = mkdtempSync(join(tmpdir(), "courier-remote-"))
    const secretFile = join(root, "shared.key")
    writeFileSync(secretFile, "pairwise secret")
    const config = readRemoteConfig({ remoteNodes: { nodeId: "worker", peers: { head: { url: "http://head:4097", secretFile, allowedRoots: [root] } } } }!)
    const called: unknown[] = []
    const ports: WebhookPorts = {
      storage: { get: async () => undefined, set: async () => {}, remove: async () => {}, scan: async () => ({ entries: [] }) },
      session: { get: async () => ({ id: "ses" }), synthetic: async () => ({ id: "msg" }) } as any,
      now: () => 1,
      log: () => {},
      remote: { config: config!, handle: async (request) => (called.push(request), { ready: true }) },
    }
    const body = JSON.stringify({ version: 1, id: "request-1", sender: "head", operation: "prepare", payload: { directory: root } })
    const request = (auth: string) => ({ method: "POST", path: "/courier", headers: { "x-courier-signature": auth }, body: Buffer.from(body) })
    const seen = new Set<string>()

    expect(await receive(ports, "unused", request(signature("pairwise secret", body)), seen)).toEqual({ status: 200, body: '{"result":{"ready":true}}' })
    expect(await receive(ports, "unused", request(signature("pairwise secret", body)), seen)).toEqual({ status: 409, body: '{"error":"request already delivered"}' })
    expect((await receive(ports, "unused", request(signature("wrong", body)), seen)).status).toBe(401)
    expect(called).toHaveLength(1)
  })

  test("prepares only allowed directories and records a named child before its first prompt", async () => {
    const root = mkdtempSync(join(tmpdir(), "courier-remote-"))
    const secretFile = join(root, "shared.key")
    writeFileSync(secretFile, "pairwise secret")
    const remote = readRemoteConfig({ remoteNodes: { nodeId: "worker", peers: { head: { url: "http://head:4097", secretFile, allowedRoots: [root] } } } })!
    const store = new Map<string, unknown>()
    let created: any
    let promptSawRoster = false
    const session = {
      create: async (input: any) => {
        created = { id: "ses_remote", title: input.title, location: input.location, metadata: input.metadata }
        return created
      },
      get: async () => created,
      prompt: async ({ sessionID }: any) => {
        promptSawRoster = store.has(rosterKey("head/ses_parent", sessionID))
        return { id: "msg_1" }
      },
      synthetic: async () => ({ id: "msg_2" }),
      context: async () => [],
      interrupt: async () => ({ interrupted: true }),
    }
    const storage: any = {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => void store.set(key, value),
      remove: async (key: string) => void store.delete(key),
      scan: async ({ prefix }: any) => ({ entries: [...store].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) }),
    }
    const ports: any = {
      remote,
      session,
      agent: { get: async () => ({ data: { model: undefined } }) },
      worktree: { create: async () => ({ directory: join(root, ".worktree") }), remove: async () => {} },
      projectID: "project-worker",
      storage,
      directory: root,
      now: () => 123,
      limits: DEFAULT_LIMITS,
      pending: async () => [],
      head: async () => undefined,
      dirty: async () => false,
      log: () => {},
      nudge: () => {},
      roles: new Map(),
    }
    const cleanupPorts: any = { ...ports, inspect: async () => undefined }
    const envelope = (operation: string, payload: unknown) => ({ version: 1 as const, id: "r1", sender: "head", operation, payload })

    await expect(handleRemote(ports, cleanupPorts, envelope("prepare", { directory: tmpdir(), task: "do it", workName: "docs" }))).rejects.toThrow("allowed roots")
    const prepared = await handleRemote(ports, cleanupPorts, envelope("prepare", { directory: root, task: "do it", workName: "docs" })) as any
    expect(prepared).toMatchObject({ sessionID: "ses_remote", directory: root })
    await handleRemote(ports, cleanupPorts, envelope("start", {
      sessionID: prepared.sessionID,
      parentID: "head/ses_parent",
      directory: tmpdir(),
      source: tmpdir(),
      worktree: "/etc",
      project: "attacker-project",
      base: "attacker-base",
      title: prepared.title,
      task: "do it",
      workName: "docs",
    }))

    expect(promptSawRoster).toBe(true)
    expect(store.get(rosterKey("head/ses_parent", "ses_remote"))).toMatchObject({
      workName: "docs",
      sessionID: "ses_remote",
      directory: root,
      isolated: false,
    })
  })

  test("routes child reports and parent replies through the existing send path", async () => {
    const root = mkdtempSync(join(tmpdir(), "courier-remote-"))
    const secretFile = join(root, "shared.key")
    writeFileSync(secretFile, "pairwise secret")
    const mkStorage = () => {
      const values = new Map<string, unknown>()
      return {
        values,
        storage: {
          get: async (key: string) => values.get(key),
          set: async (key: string, value: unknown) => void values.set(key, value),
          remove: async (key: string) => void values.delete(key),
          scan: async ({ prefix }: any) => ({ entries: [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) }),
        },
      }
    }
    const synthetics: Array<{ sessionID: string; text: string }> = []
    const mkPorts = (nodeId: string, peerId: string) => {
      const remote = readRemoteConfig({ remoteNodes: { nodeId, peers: { [peerId]: { url: "http://peer:4097", secretFile, allowedRoots: [root] } } } })!
      const { storage, values } = mkStorage()
      const ports: any = {
        remote,
        storage,
        now: () => 42,
        session: { synthetic: async (input: any) => (synthetics.push(input), { id: "msg" }) },
        nudge: () => {},
        log: () => {},
      }
      return { ports, values }
    }
    const head = mkPorts("head", "worker")
    const worker = mkPorts("worker", "head")
    const child = {
      sessionID: "worker/ses_remote",
      parentID: "ses_parent",
      title: "docs",
      directory: root,
      isolated: false,
      createdAt: 1,
      reports: "status" as const,
    }
    await childStore(head.ports.storage).record(child)
    const envelope = (sender: string, payload: unknown) => ({ version: 1 as const, id: "r1", sender, operation: "send", payload })

    await handleRemote(head.ports, head.ports, envelope("worker", {
      from: "worker/ses_remote", sessionID: "ses_parent", message: "Finished", status: "done", artifacts: { files: ["a.txt"] },
    }))
    expect(synthetics.at(-1)).toMatchObject({ sessionID: "ses_parent", metadata: { from: "worker/ses_remote", status: "done" } })
    expect(head.values.get(settledKey("worker/ses_remote"))).toMatchObject({ by: "report", status: "done" })

    await childStore(worker.ports.storage).record({
      ...child,
      sessionID: "ses_remote",
      parentID: "head/ses_parent",
    })
    await handleRemote(worker.ports, worker.ports, envelope("head", {
      from: "head/ses_parent", sessionID: "ses_remote", message: "Please add a test", queue: true,
    }))
    expect(synthetics.at(-1)).toMatchObject({ sessionID: "ses_remote", delivery: "queue", metadata: { from: "head/ses_parent" } })
  })

  test("does not start a prepared remote session when the Head Unit cannot record it", async () => {
    const root = mkdtempSync(join(tmpdir(), "courier-remote-"))
    const secretFile = join(root, "shared.key")
    writeFileSync(secretFile, "pairwise secret")
    const remote = readRemoteConfig({ remoteNodes: { nodeId: "head", peers: { worker: { url: "http://worker:4098", secretFile } } } })!
    const values = new Map<string, unknown>()
    const operations: string[] = []
    const storage = {
      get: async (key: string) => values.get(key),
      set: async (key: string, value: unknown) => {
        if (key.startsWith("roster/")) throw new Error("disk full")
        values.set(key, value)
      },
      remove: async (key: string) => void values.delete(key),
      scan: async ({ prefix }: any) => ({ entries: [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) }),
    }
    const priorFetch = globalThis.fetch
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const envelope = JSON.parse(String(init?.body))
      operations.push(envelope.operation)
      return new Response(JSON.stringify({ result: { sessionID: "ses_prepared", directory: root, title: "task" } }), { status: 200 })
    }) as typeof fetch
    const ports: any = {
      remote,
      storage,
      session: { get: async () => ({ id: "ses_parent" }) },
      directory: root,
      projectID: "project-head",
      now: () => 1,
      limits: DEFAULT_LIMITS,
      gate: { reserved: new Set(), turn: Promise.resolve() },
      roles: new Map(),
      nudge: () => {},
      log: () => {},
    }
    try {
      await expect(spawn(ports, "ses_parent", { task: "do the work", peer: "worker", directory: root, workName: "docs" }))
        .rejects.toThrow("prepared but not started")
      expect(operations).toEqual(["prepare"])
    } finally {
      globalThis.fetch = priorFetch
    }
  })
})
