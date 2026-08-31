import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { createAccountStore } from "../src/account-store.ts"
import {
  createAccountService,
  type AccountHealthSnapshot,
  type AccountService,
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
})
