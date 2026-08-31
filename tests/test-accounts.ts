import assert from "node:assert/strict"
import { mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { createAccountStore } from "../src/account-store.ts"
import { createCoordinationStore } from "../src/coordination.ts"
import {
  createAccountService,
  type AccountHealthSnapshot,
  type AccountService,
  type AccountProbeResult,
} from "../src/accounts.ts"
import type { TransportFailure } from "../src/types.ts"

const KEY_A = "cc_test_placeholder_plan_alpha"
const KEY_B = "cc_test_placeholder_plan_bravo"
const KEY_C = "cc_test_placeholder_plan_charlie"
const ID_A = "11111111-1111-4111-8111-111111111111"
const ID_B = "22222222-2222-4222-8222-222222222222"
const ID_C = "33333333-3333-4333-8333-333333333333"

async function withService(
  run: (service: AccountService, now: { value: number }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "commandcode-plan-"))
  try {
    const now = { value: 1_000_000 }
    let nextId = 0
    const ids = [ID_A, ID_B, ID_C]
    const store = createAccountStore({
      stateDir: root,
      uuid: () => ids[nextId++] ?? "44444444-4444-4444-8444-444444444444",
      nonce: () => "55555555-5555-4555-8555-555555555555",
      now: () => now.value,
    })
    const service = createAccountService({
      store,
      now: () => now.value,
      probeAccount: async () => ({ kind: "available" }),
    })
    await service.add({ apiKey: KEY_A, keyName: "alpha", login: "alpha-login" })
    await service.add({ apiKey: KEY_B, keyName: "bravo", login: "bravo-login" })
    await service.add({ apiKey: KEY_C, keyName: "charlie", login: "charlie-login" })
    await run(service, now)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function accountIds(service: AccountService, options?: { tried?: ReadonlySet<string> }) {
  return service
    .planLogicalRequest(options)
    .then((plan) => plan.attempts.map((account) => account.id))
}

function failure(overrides: Partial<TransportFailure>): TransportFailure {
  return {
    source: "generate",
    phase: "response",
    kind: "http",
    status: 500,
    ...overrides,
  }
}

function health(service: AccountService, id: string): AccountHealthSnapshot {
  const snapshot = service.getHealth(id)
  assert.ok(snapshot, `missing health for ${id}`)
  return snapshot
}

describe("account planning and process-local health", () => {
  it("plans an immutable primary-first healthy snapshot and filters tried accounts", async () => {
    await withService(async (service) => {
      await service.setPrimary(ID_B)
      const tried = new Set([ID_C])
      const plan = await service.planLogicalRequest({ tried })

      assert.deepEqual(
        plan.attempts.map((account) => [account.id, account.label]),
        [
          [ID_B, "bravo"],
          [ID_A, "alpha"],
        ],
      )
      assert.equal(Object.isFrozen(plan), true)
      assert.equal(Object.isFrozen(plan.attempts), true)
      assert.equal(Object.isFrozen(plan.attempts[0]), true)
      assert.throws(() => {
        ;(plan.attempts as Array<unknown>).pop()
      })
    })
  })

  it("excludes cooling accounts and re-enables them at the injected deadline", async () => {
    await withService(async (service, now) => {
      await service.recordEligibleFailure(ID_A, failure({ status: 408 }))
      assert.deepEqual(await accountIds(service), [ID_B, ID_C])
      assert.equal(health(service, ID_A).health, "cooling")
      assert.equal(health(service, ID_A).cooldownUntil, now.value + 60_000)

      now.value += 59_999
      assert.deepEqual(await accountIds(service), [ID_B, ID_C])
      now.value += 1
      assert.deepEqual(await accountIds(service), [ID_B, ID_C])
      for (let turn = 0; turn < 1_000 && service.getHealth(ID_A); turn += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      assert.deepEqual(await accountIds(service), [ID_A, ID_B, ID_C])
      assert.equal(service.getHealth(ID_A), undefined)
    })
  })

  it("revalidates membership after a plan before creating an attempt", async () => {
    await withService(async (service) => {
      const plan = await service.planLogicalRequest()
      assert.equal(await service.isStillConfigured(ID_A, plan.revision), true)
      await service.remove(ID_A)
      assert.equal(await service.isStillConfigured(ID_A, plan.revision), false)
      assert.equal(await service.isStillConfigured(ID_B, plan.revision), true)
    })
  })

  it("applies transient, rate-limit, auth, and retry-after cooldown defaults with a hard cap", async () => {
    await withService(async (service, now) => {
      await service.recordEligibleFailure(ID_A, failure({ status: 408 }))
      assert.equal(health(service, ID_A).cooldownUntil, now.value + 60_000)

      now.value += 1
      await service.recordEligibleFailure(
        ID_A,
        failure({ status: 429, retryAfterMs: 60 * 60 * 1000 }),
      )
      assert.equal(health(service, ID_A).failureClass, "rate-limit")
      assert.equal(health(service, ID_A).cooldownUntil, now.value + 15 * 60 * 1000)

      now.value += 1
      await service.recordEligibleFailure(ID_A, failure({ status: 401 }))
      assert.equal(health(service, ID_A).failureClass, "account-auth")
      assert.equal(health(service, ID_A).cooldownUntil, now.value + 15 * 60 * 1000)
    })
  })

  it("converges concurrent same-account failures by later deadline and increments the epoch", async () => {
    await withService(async (service, now) => {
      const before = service.getHealth(ID_A)?.epoch ?? 0
      const failures = Array.from({ length: 12 }, (_, index) =>
        service.recordEligibleFailure(
          ID_A,
          failure(
            index % 2 === 0
              ? { status: 500 }
              : {
                  status: 429,
                  retryAfterMs: index === 11 ? 60 * 60 * 1000 : index * 10_000,
                },
          ),
        ),
      )
      await Promise.all(failures)
      const after = health(service, ID_A)
      assert.equal(after.epoch, before + 12)
      assert.equal(after.cooldownUntil, now.value + 15 * 60 * 1000)
      assert.equal(
        (await service.planLogicalRequest()).attempts.some((a) => a.id === ID_A),
        false,
      )
    })
  })

  it("clears a local penalty only for a request that did not predate a newer failure", async () => {
    await withService(async (service, now) => {
      await service.recordEligibleFailure(ID_A, failure({ status: 429 }))
      const startedBeforeFailure = now.value - 1
      await service.recordSuccess(ID_A, startedBeforeFailure)
      assert.equal(health(service, ID_A).health, "cooling")

      await service.recordSuccess(ID_A, now.value)
      assert.equal(
        health(service, ID_A).health,
        "cooling",
        "an equal-timestamp success must not erase a potentially newer concurrent failure",
      )

      now.value += 1
      await service.recordSuccess(ID_A, now.value)
      assert.equal(
        (await service.listStatus()).find((account) => account.id === ID_A)?.health,
        "healthy",
      )
      assert.equal(service.getHealth(ID_A), undefined)
    })
  })

  it("keeps concurrent healthy planning independent without a request lock", async () => {
    await withService(async (service) => {
      let active = 0
      let maximum = 0
      const plans = await Promise.all(
        Array.from({ length: 8 }, async () => {
          active += 1
          maximum = Math.max(maximum, active)
          const plan = await service.planLogicalRequest()
          await Promise.resolve()
          active -= 1
          return plan
        }),
      )
      assert.equal(plans.length, 8)
      assert.ok(maximum > 1, "planning must not serialize concurrent requests")
    })
  })

  it("propagates cooldowns across services while keeping local health immediate", async () => {
    const root = await mkdtemp(join(tmpdir(), "commandcode-coordination-service-"))
    try {
      const now = { value: 1_000_000 }
      let nextId = 0
      const store = createAccountStore({
        stateDir: root,
        now: () => now.value,
        uuid: () => [ID_A, ID_B][nextId++] ?? "33333333-3333-4333-8333-333333333333",
      })
      const coordinationOne = createCoordinationStore({ stateDir: root, now: () => now.value })
      const coordinationTwo = createCoordinationStore({ stateDir: root, now: () => now.value })
      const first = createAccountService({
        store,
        coordination: coordinationOne,
        now: () => now.value,
      })
      await first.add({ apiKey: KEY_A, keyName: "alpha", login: "alpha" })
      await first.add({ apiKey: KEY_B, keyName: "bravo", login: "bravo" })
      const second = createAccountService({
        store: createAccountStore({ stateDir: root, now: () => now.value }),
        coordination: coordinationTwo,
        now: () => now.value,
      })

      const update = first.recordEligibleFailure(ID_A, failure({ status: 429 }))
      assert.equal(first.getHealth(ID_A)?.health, "cooling")
      await update
      assert.deepEqual(
        (await second.planLogicalRequest()).attempts.map((account) => account.id),
        [ID_B],
      )

      now.value += 1
      await second.recordEligibleFailure(ID_A, failure({ status: 429, retryAfterMs: 900_000 }))
      const shared = await coordinationOne.load()
      assert.equal(shared.kind, "loaded")
      if (shared.kind !== "loaded") return
      assert.equal(shared.snapshot.cooldowns[ID_A]?.epoch, 2)
      assert.equal(shared.snapshot.cooldowns[ID_A]?.cooldownUntil, now.value + 900_000)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("schedules one non-blocking fenced probe and returns to a recovered account", async () => {
    const root = await mkdtemp(join(tmpdir(), "commandcode-probe-service-"))
    try {
      const now = { value: 2_000_000 }
      let nextId = 0
      const store = createAccountStore({
        stateDir: root,
        now: () => now.value,
        uuid: () => [ID_A, ID_B][nextId++] ?? "33333333-3333-4333-8333-333333333333",
      })
      const coordination = createCoordinationStore({ stateDir: root, now: () => now.value })
      let probeStarted = 0
      let releaseProbe: ((result: AccountProbeResult) => void) | undefined
      let resolveProbeFinished: (() => void) | undefined
      const probeResult = new Promise<AccountProbeResult>((resolve) => {
        releaseProbe = resolve
      })
      const probeFinished = new Promise<void>((resolve) => {
        resolveProbeFinished = resolve
      })
      const service = createAccountService({
        store,
        coordination,
        now: () => now.value,
        probeAccount: async (_account, probeOptions) => {
          probeStarted += 1
          assert.equal(probeOptions.timeoutMs, 15_000)
          assert.equal(probeOptions.signal.aborted, false)
          const result = await probeResult
          resolveProbeFinished?.()
          return result
        },
      })
      await service.add({ apiKey: KEY_A, keyName: "alpha", login: "alpha" })
      await service.add({ apiKey: KEY_B, keyName: "bravo", login: "bravo" })
      await service.recordEligibleFailure(ID_A, failure({ status: 408 }))
      now.value += 60_000

      const plan = await service.planLogicalRequest()
      assert.deepEqual(
        plan.attempts.map((account) => account.id),
        [ID_B],
      )
      for (let turn = 0; turn < 1_000 && probeStarted === 0; turn += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      assert.equal(probeStarted, 1)
      assert.equal(service.getHealth(ID_A)?.health, "probing")

      const secondPlan = await service.planLogicalRequest()
      assert.deepEqual(
        secondPlan.attempts.map((account) => account.id),
        [ID_B],
      )
      assert.equal(probeStarted, 1)

      releaseProbe?.({ kind: "available" })
      await probeFinished
      let recovered: string[] = []
      for (let turn = 0; turn < 1_000; turn += 1) {
        recovered = (await service.planLogicalRequest()).attempts.map((account) => account.id)
        if (recovered.includes(ID_A)) break
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      assert.deepEqual(recovered, [ID_A, ID_B])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("uses explicit quota refresh to recover a durable rate-limit cooldown", async () => {
    const root = await mkdtemp(join(tmpdir(), "commandcode-quota-recovery-"))
    try {
      const now = { value: 3_000_000 }
      const store = createAccountStore({ stateDir: root, now: () => now.value, uuid: () => ID_A })
      const coordination = createCoordinationStore({ stateDir: root, now: () => now.value })
      const first = createAccountService({ store, coordination, now: () => now.value })
      await first.add({ apiKey: KEY_A, keyName: "alpha", login: "alpha" })
      await first.recordEligibleFailure(ID_A, failure({ status: 429 }))
      now.value += 5 * 60_000

      const remaining = { value: 1 }
      const second = createAccountService({
        store: createAccountStore({ stateDir: root, now: () => now.value }),
        coordination: createCoordinationStore({ stateDir: root, now: () => now.value }),
        now: () => now.value,
        fetchQuota: async () => ({
          ok: true as const,
          quota: {
            account: { login: "alpha", orgId: null },
            credits: {
              monthlyCredits: 1,
              purchasedCredits: 0,
              freeCredits: 0,
              remainingCredits: remaining.value,
              windowLimits: [],
            },
            subscription: null,
            summary: null,
          },
        }),
      })
      const refreshed = await second.refreshQuota(ID_A)
      assert.equal(refreshed.ok, true)
      assert.equal(second.getQuotaSnapshot(ID_A)?.quota.credits?.remainingCredits, 1)
      assert.deepEqual(
        (await second.planLogicalRequest()).attempts.map((account) => account.id),
        [ID_A],
      )
      const shared = await coordination.load()
      assert.equal(shared.kind, "loaded")
      if (shared.kind === "loaded") assert.equal(shared.snapshot.cooldowns[ID_A], undefined)
      assert.deepEqual(
        (await first.planLogicalRequest()).attempts.map((account) => account.id),
        [ID_A],
        "a remote durable clear must clear matching local shared state",
      )

      remaining.value = 0
      now.value += 1
      await first.recordEligibleFailure(ID_A, failure({ status: 401 }))
      now.value += 15 * 60_000
      const authRefreshed = await second.refreshQuota(ID_A)
      assert.equal(authRefreshed.ok, true)
      if (authRefreshed.ok) assert.equal(authRefreshed.availability, "available")
      const afterAuth = await coordination.load()
      assert.equal(afterAuth.kind, "loaded")
      if (afterAuth.kind === "loaded") assert.equal(afterAuth.snapshot.cooldowns[ID_A], undefined)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("degrades visibly to process-local cooldown when shared coordination is unsafe", async () => {
    const root = await mkdtemp(join(tmpdir(), "commandcode-degraded-coordination-"))
    try {
      const warnings: string[] = []
      const now = { value: 1_000_000 }
      let probeCount = 0
      let nextId = 0
      const store = createAccountStore({
        stateDir: root,
        uuid: () => [ID_A, ID_B][nextId++] ?? "33333333-3333-4333-8333-333333333333",
      })
      const coordination = createCoordinationStore({
        stateDir: root,
        warning: (message) => warnings.push(message),
      })
      await store.addAccount({ label: "alpha", credential: { kind: "api-key", value: KEY_A } })
      await store.addAccount({ label: "bravo", credential: { kind: "api-key", value: KEY_B } })
      await symlink("/etc/passwd", coordination.coordinationPath)
      const service = createAccountService({
        store,
        coordination,
        now: () => now.value,
        warning: (message) => warnings.push(message),
        probeAccount: async () => {
          probeCount += 1
          return { kind: "available" }
        },
      })
      await service.recordEligibleFailure(ID_A, failure({ status: 500 }))
      assert.equal(service.getHealth(ID_A)?.health, "cooling")
      assert.ok(warnings.length > 0)
      assert.doesNotMatch(warnings.join("\n"), /cc_test_placeholder|Bearer|https?:|\/home\//i)

      now.value += 60_000
      assert.deepEqual(
        (await service.planLogicalRequest()).attempts.map((account) => account.id),
        [ID_B],
      )
      for (let turn = 0; turn < 1_000 && service.getHealth(ID_A); turn += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      assert.equal(probeCount, 1)
      assert.deepEqual(
        (await service.planLogicalRequest()).attempts.map((account) => account.id),
        [ID_A, ID_B],
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
