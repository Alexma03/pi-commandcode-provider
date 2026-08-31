import assert from "node:assert/strict"
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
  COORDINATION_FORMAT,
  COORDINATION_VERSION,
  MAX_COORDINATION_ACCOUNTS,
  MAX_COORDINATION_BYTES,
  CoordinationParseError,
  createCoordinationStore,
  parseCoordination,
  type CoordinationSnapshot,
} from "../src/coordination.ts"

const ID_A = "11111111-1111-4111-8111-111111111111"
const ID_B = "22222222-2222-4222-8222-222222222222"
const NONCE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const NONCE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const PLACEHOLDER = "cc_test_placeholder_coordination"

function cooldown(
  accountId = ID_A,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    [accountId]: {
      epoch: 2,
      failureClass: "rate-limit",
      failedAt: 1_700_000_000_000,
      cooldownUntil: 1_700_000_300_000,
      nextProbeAt: 1_700_000_300_000,
      ...overrides,
    },
  }
}

function lease(accountId = ID_A, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    [accountId]: {
      nonce: NONCE_A,
      pid: 4242,
      processStartedAt: 1_699_999_000_000,
      acquiredAt: 1_700_000_300_000,
      expiresAt: 1_700_000_330_000,
      cooldownEpoch: 2,
      fence: 7,
      ...overrides,
    },
  }
}

function rawSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: COORDINATION_FORMAT,
    version: COORDINATION_VERSION,
    revision: 3,
    cooldowns: cooldown(),
    leases: lease(),
    ...overrides,
  }
}

function assertParseRejected(value: unknown, reason: CoordinationParseError["reason"]): void {
  assert.throws(
    () => parseCoordination(value),
    (error: unknown) => error instanceof CoordinationParseError && error.reason === reason,
  )
}

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "commandcode-coordination-"))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe("coordination schema and parser", () => {
  it("accepts a credential-free version-1 record and preserves only coordination fields", () => {
    const parsed = parseCoordination(rawSnapshot())
    assert.equal(parsed.format, COORDINATION_FORMAT)
    assert.equal(parsed.version, 1)
    assert.equal(parsed.revision, 3)
    assert.equal(parsed.cooldowns[ID_A]?.failureClass, "rate-limit")
    assert.equal(parsed.leases[ID_A]?.nonce, NONCE_A)
    assert.doesNotMatch(JSON.stringify(parsed), /placeholder|label|workspace|https?:/i)
  })

  it("rejects unknown fields, malformed ids, invalid classes, and oversized records", () => {
    assertParseRejected({ ...rawSnapshot(), extra: "must reject" }, "corrupt")
    assertParseRejected(rawSnapshot({ cooldowns: cooldown(ID_A, { unexpected: true }) }), "corrupt")
    assertParseRejected(rawSnapshot({ leases: lease(ID_A, { unexpected: true }) }), "corrupt")
    assertParseRejected(rawSnapshot({ cooldowns: { "not-an-id": cooldown()[ID_A] } }), "corrupt")
    assertParseRejected(
      rawSnapshot({ cooldowns: cooldown(ID_A, { failureClass: "quota-message" }) }),
      "corrupt",
    )
    assertParseRejected(rawSnapshot({ revision: Number.POSITIVE_INFINITY }), "corrupt")
    assertParseRejected(rawSnapshot({ leases: lease(ID_A, { nonce: "not-a-uuid" }) }), "corrupt")

    const tooMany = Object.fromEntries(
      Array.from({ length: MAX_COORDINATION_ACCOUNTS + 1 }, (_, index) => [
        `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        {
          epoch: 1,
          failureClass: "transient",
          failedAt: 1,
          cooldownUntil: 2,
          nextProbeAt: 2,
        },
      ]),
    )
    assertParseRejected(rawSnapshot({ cooldowns: tooMany, leases: {} }), "corrupt")
    assertParseRejected("x".repeat(MAX_COORDINATION_BYTES + 1), "corrupt")
  })
})

describe("coordination private state and corruption recovery", () => {
  it("does not create an absent state root, then creates private atomic state on mutation", async () => {
    await withTempRoot(async (root) => {
      const stateRoot = join(root, "commandcode")
      const store = createCoordinationStore({ stateDir: stateRoot })
      assert.deepEqual(await store.load(), { kind: "absent" })
      await assert.rejects(stat(stateRoot), { code: "ENOENT" })

      const steps: string[] = []
      const instrumented = createCoordinationStore({
        stateDir: stateRoot,
        onWriteStep: (step) => steps.push(step),
      })
      await instrumented.recordCooldown(ID_A, {
        failureClass: "transient",
        failedAt: 100,
        cooldownUntil: 200,
        nextProbeAt: 200,
      })
      assert.equal((await stat(stateRoot)).mode & 0o777, 0o700)
      assert.equal((await stat(instrumented.locksPath)).mode & 0o777, 0o700)
      assert.equal((await stat(instrumented.coordinationPath)).mode & 0o777, 0o600)
      assert.deepEqual(steps.slice(-7), [
        "open",
        "write",
        "sync",
        "chmod",
        "close",
        "rename",
        "directory-sync",
      ])
      assert.doesNotMatch(
        await readFile(instrumented.coordinationPath, "utf8"),
        /cc_test_placeholder/i,
      )
    })
  })

  it("corrects a permissive file and emits a redacted warning", async () => {
    await withTempRoot(async (root) => {
      const warnings: string[] = []
      const store = createCoordinationStore({
        stateDir: root,
        warning: (message) => warnings.push(message),
      })
      await store.recordCooldown(ID_A, {
        failureClass: "transient",
        failedAt: 100,
        cooldownUntil: 200,
        nextProbeAt: 200,
      })
      await chmod(store.coordinationPath, 0o644)
      const loaded = await store.load()
      assert.equal(loaded.kind, "loaded")
      assert.equal((await stat(store.coordinationPath)).mode & 0o777, 0o600)
      assert.ok(warnings.length > 0)
      assert.doesNotMatch(warnings.join("\n"), /placeholder|Bearer|api[-_ ]?key|https?:/i)
    })
  })

  it("quarantines corrupt content with a private nonce name and installs an empty record", async () => {
    await withTempRoot(async (root) => {
      const warnings: string[] = []
      const store = createCoordinationStore({
        stateDir: root,
        warning: (message) => warnings.push(message),
        nonce: () => NONCE_B,
      })
      await mkdir(root, { recursive: true, mode: 0o700 })
      await writeFile(store.coordinationPath, `not-json ${PLACEHOLDER}`, { mode: 0o600 })

      const loaded = await store.load()
      assert.equal(loaded.kind, "loaded")
      if (loaded.kind !== "loaded") return
      assert.deepEqual(loaded.snapshot, {
        format: COORDINATION_FORMAT,
        version: COORDINATION_VERSION,
        revision: 0,
        cooldowns: {},
        leases: {},
      } satisfies CoordinationSnapshot)
      assert.ok(warnings.some((message) => /corrupt|replaced|quarantine/i.test(message)))
      assert.doesNotMatch(warnings.join("\n"), new RegExp(PLACEHOLDER))

      const names = (await readdir(root)).filter(
        (name) => name !== "locks" && name !== "coordination.json" && name !== ".gitignore",
      )
      assert.equal(names.length, 1)
      assert.match(names[0] ?? "", /^coordination\.json\.corrupt-[0-9a-f-]+$/i)
      assert.equal((await stat(join(root, names[0]!))).mode & 0o777, 0o600)
      assert.doesNotMatch(
        await readFile(join(root, names[0]!), "utf8"),
        /placeholder|workspace|https?:/i,
      )
      assert.deepEqual(parseCoordination(await readFile(store.coordinationPath)), loaded.snapshot)
    })
  })

  it("refuses symlink coordination paths without reading their target", async () => {
    await withTempRoot(async (root) => {
      const store = createCoordinationStore({ stateDir: root })
      await mkdir(root, { recursive: true, mode: 0o700 })
      await symlink("/etc/passwd", store.coordinationPath)
      const loaded = await store.load()
      assert.deepEqual(loaded, { kind: "unavailable", reason: "permissions" })
    })
  })
})

describe("cooldown propagation and fenced probe leases", () => {
  it("merges cooldowns by later deadline and increments epochs", async () => {
    await withTempRoot(async (root) => {
      const now = { value: 1_000 }
      const store = createCoordinationStore({ stateDir: root, now: () => now.value })
      await store.recordCooldown(ID_A, {
        failureClass: "transient",
        failedAt: now.value,
        cooldownUntil: 2_000,
        nextProbeAt: 2_000,
      })
      await store.recordCooldown(ID_A, {
        failureClass: "rate-limit",
        failedAt: now.value + 1,
        cooldownUntil: 4_000,
        nextProbeAt: 4_000,
      })
      await store.recordCooldown(ID_A, {
        failureClass: "transient",
        failedAt: now.value + 2,
        cooldownUntil: 3_000,
        nextProbeAt: 3_000,
      })
      const loaded = await store.load()
      assert.equal(loaded.kind, "loaded")
      if (loaded.kind !== "loaded") return
      assert.deepEqual(loaded.snapshot.cooldowns[ID_A], {
        epoch: 3,
        failureClass: "rate-limit",
        failedAt: now.value + 1,
        cooldownUntil: 4_000,
        nextProbeAt: 4_000,
      })
    })
  })

  it("acquires one due probe lease, schedules its window, and compares nonce on release", async () => {
    await withTempRoot(async (root) => {
      const now = { value: 5_000 }
      const store = createCoordinationStore({
        stateDir: root,
        now: () => now.value,
        uuid: () => NONCE_A,
        nonce: () => NONCE_A,
        probeWindowMs: 30_000,
        leaseTtlMs: 30_000,
      })
      await store.recordCooldown(ID_A, {
        failureClass: "transient",
        failedAt: 1_000,
        cooldownUntil: now.value,
        nextProbeAt: now.value,
      })

      const acquired = await store.acquireProbe(ID_A)
      assert.ok(acquired)
      assert.equal(acquired?.nonce, NONCE_A)
      assert.equal(acquired?.cooldownEpoch, 1)
      assert.equal(acquired?.expiresAt, now.value + 30_000)
      const afterAcquire = await store.load()
      assert.equal(afterAcquire.kind, "loaded")
      if (afterAcquire.kind !== "loaded") return
      assert.equal(afterAcquire.snapshot.cooldowns[ID_A]?.nextProbeAt, now.value + 30_000)
      assert.equal(afterAcquire.snapshot.leases[ID_A]?.fence, acquired?.fence)
      assert.equal(await store.acquireProbe(ID_A), undefined)
      assert.equal(await store.releaseProbe(ID_A, NONCE_B), false)
      assert.equal(await store.releaseProbe(ID_A, NONCE_A), true)
      assert.equal((await store.load()).kind, "loaded")
    })
  })

  it("rejects not-due probes, recovers TTL/dead leases, and keeps the fence monotonic", async () => {
    await withTempRoot(async (root) => {
      const now = { value: 10_000 }
      const store = createCoordinationStore({
        stateDir: root,
        now: () => now.value,
        uuid: () => NONCE_A,
        nonce: () => NONCE_A,
        leaseTtlMs: 30_000,
      })
      await store.recordCooldown(ID_A, {
        failureClass: "transient",
        failedAt: now.value,
        cooldownUntil: now.value + 1_000,
        nextProbeAt: now.value + 1_000,
      })
      assert.equal(await store.acquireProbe(ID_A), undefined)

      now.value += 1_000
      const first = await store.acquireProbe(ID_A)
      assert.ok(first)
      const firstFence = first?.fence ?? 0

      now.value += 31_000
      const takeover = createCoordinationStore({
        stateDir: root,
        now: () => now.value,
        uuid: () => NONCE_B,
        nonce: () => NONCE_B,
        leaseTtlMs: 30_000,
      })
      const second = await takeover.acquireProbe(ID_A)
      assert.ok(second)
      assert.equal(second?.nonce, NONCE_B)
      assert.ok((second?.fence ?? 0) > firstFence)

      const stale = await store.applyProbeResult(ID_A, first!, { kind: "available" })
      assert.equal(stale, false)
      const afterStale = await takeover.load()
      assert.equal(afterStale.kind, "loaded")
      if (afterStale.kind !== "loaded") return
      assert.equal(afterStale.snapshot.leases[ID_A]?.nonce, NONCE_B)

      assert.equal(await takeover.releaseProbe(ID_A, NONCE_B), true)
      await takeover.recordCooldown(ID_A, {
        failureClass: "transient",
        failedAt: now.value,
        cooldownUntil: now.value,
        nextProbeAt: now.value,
      })
      const deadHolder = createCoordinationStore({
        stateDir: root,
        now: () => now.value,
        uuid: () => NONCE_A,
        nonce: () => NONCE_A,
        isProcessAlive: () => "dead",
      })
      const deadLease = await deadHolder.acquireProbe(ID_A)
      assert.ok(deadLease)
      const replacement = createCoordinationStore({
        stateDir: root,
        now: () => now.value,
        uuid: () => NONCE_B,
        nonce: () => NONCE_B,
        isProcessAlive: () => "dead",
      })
      assert.equal((await replacement.acquireProbe(ID_A))?.nonce, NONCE_B)
    })
  })

  it("applies a matching available result and fences a newer failure", async () => {
    await withTempRoot(async (root) => {
      const now = { value: 20_000 }
      const store = createCoordinationStore({
        stateDir: root,
        now: () => now.value,
        uuid: () => NONCE_A,
        nonce: () => NONCE_A,
      })
      await store.recordCooldown(ID_A, {
        failureClass: "rate-limit",
        failedAt: 1_000,
        cooldownUntil: now.value,
        nextProbeAt: now.value,
      })
      const probe = await store.acquireProbe(ID_A)
      assert.ok(probe)
      await store.recordCooldown(ID_A, {
        failureClass: "transient",
        failedAt: now.value + 1,
        cooldownUntil: now.value + 60_000,
        nextProbeAt: now.value + 60_000,
      })
      assert.equal(await store.applyProbeResult(ID_A, probe!, { kind: "available" }), false)
      const stillCooling = await store.load()
      assert.equal(stillCooling.kind, "loaded")
      if (stillCooling.kind !== "loaded") return
      assert.equal(stillCooling.snapshot.cooldowns[ID_A]?.failureClass, "transient")

      now.value += 60_000
      const due = await store.acquireProbe(ID_A)
      assert.ok(due)
      assert.equal(await store.applyProbeResult(ID_A, due!, { kind: "available" }), true)
      const healthy = await store.load()
      assert.equal(healthy.kind, "loaded")
      if (healthy.kind !== "loaded") return
      assert.equal(healthy.snapshot.cooldowns[ID_A], undefined)
      assert.equal(healthy.snapshot.leases[ID_A], undefined)
    })
  })
})

void ID_B
