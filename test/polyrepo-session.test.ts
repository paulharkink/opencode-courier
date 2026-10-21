import { expect, test } from "bun:test"
import type { Storage } from "../src/platform/storage.js"
import { createIdentityManager, deriveName } from "../src/tree/session.js"

function memoryStorage(): Storage {
  type StorageValue = Parameters<Storage["set"]>[1]
  const values = new Map<string, StorageValue>()
  return {
    get: async (key) => values.get(key),
    set: async (key, value) => { values.set(key, value) },
    remove: async (key) => { values.delete(key) },
    scan: async ({ prefix, after }) => {
      const entries = [...values.entries()]
        .filter(([key]) => key.startsWith(prefix) && (!after || key > after))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => ({ key, value }))
      return { entries }
    },
  }
}

test("a root registration is repeatable and scoped to its OpenCode project and session", async () => {
  const identities = createIdentityManager(memoryStorage())
  const registered = await identities.register("ses_root", "project_a", "Head Unit A")

  expect(registered).toEqual({ sessionID: "ses_root", projectID: "project_a", name: "Head Unit A" })
  expect(await identities.register("ses_root", "project_a", "Head Unit A")).toEqual(registered)
  expect(await identities.get("ses_root", "project_a")).toEqual(registered)
  expect(await identities.get("ses_root", "project_b")).toBeUndefined()

  const sameSessionOtherProject = await identities.register("ses_root", "project_b", "Head Unit B")
  const otherSessionSameProject = await identities.register("ses_other", "project_a", "Independent Root")
  expect(sameSessionOtherProject).toEqual({ sessionID: "ses_root", projectID: "project_b", name: "Head Unit B" })
  expect(otherSessionSameProject).toEqual({ sessionID: "ses_other", projectID: "project_a", name: "Independent Root" })
  expect(await identities.get("ses_root", "project_a")).toEqual(registered)
})

test("a root name can be updated by the manager while tool policy remains at the caller", async () => {
  const identities = createIdentityManager(memoryStorage())
  await identities.register("ses_root", "project_a", "Before")

  expect(await identities.register("ses_root", "project_a", "After")).toEqual({
    sessionID: "ses_root",
    projectID: "project_a",
    name: "After",
  })
  expect(await identities.assertRoot("ses_root", "project_a")).toEqual({
    sessionID: "ses_root",
    projectID: "project_a",
    name: "After",
  })
})

test("the identity manager fails closed when the current session is not registered as a root", async () => {
  const identities = createIdentityManager(memoryStorage())

  await expect(identities.assertRoot("ses_worker", "project_a")).rejects.toThrow(/not registered/i)
})

test("closing a root can unregister only its project/session identity while retaining other roots", async () => {
  const identities = createIdentityManager(memoryStorage())
  await identities.register("ses_root", "project_a", "Head A")
  await identities.register("ses_root", "project_b", "Head B")

  await identities.unregister("ses_root", "project_a")

  expect(await identities.get("ses_root", "project_a")).toBeUndefined()
  expect(await identities.assertRoot("ses_root", "project_b")).toEqual({
    sessionID: "ses_root",
    projectID: "project_b",
    name: "Head B",
  })
})

test("child work names are qualified by the root and reject ambiguous path separators", () => {
  const root = { sessionID: "ses_root", projectID: "project_a", name: "Head Unit A" }

  expect(deriveName(root, "implement-alpha")).toBe("Head Unit A/implement-alpha")
  expect(() => deriveName(root, "nested/label")).toThrow(/label/i)
  expect(() => deriveName(root, "  ")).toThrow(/label/i)
  expect(() => deriveName({ ...root, name: "bad/root" }, "child")).toThrow(/root name/i)
})
