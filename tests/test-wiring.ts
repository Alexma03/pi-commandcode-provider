import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { createAccountStore } from "../src/account-store.ts"
import { createAccountService, type AccountService } from "../src/accounts.ts"
import { createCoordinationStore } from "../src/coordination.ts"
import { createAccountAwareStream } from "../src/runtime.ts"
import type {
  AssistantMessageEvent,
  AssistantMessageEventStreamLike,
  StreamOptions,
} from "../src/types.ts"
import { collectEvents, createTestEventStream, makeContext, makeModel } from "./helpers.ts"

const KEY_A = "cc_test_placeholder_wiring_alpha"
const KEY_B = "cc_test_placeholder_wiring_bravo"
const ID_A = "11111111-1111-4111-8111-111111111111"
const ID_B = "22222222-2222-4222-8222-222222222222"

function message() {
  const model = makeModel()
  return {
    role: "assistant" as const,
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: 1,
  }
}

function successStream(text: string): AssistantMessageEventStreamLike {
  const stream = createTestEventStream()
  const partial = { ...message(), content: [{ type: "text" as const, text }] }
  stream.push({ type: "start", partial: message() })
  stream.push({ type: "text_start", contentIndex: 0, partial })
  stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial })
  stream.push({ type: "text_end", contentIndex: 0, content: text, partial })
  stream.push({ type: "done", reason: "stop", message: partial })
  stream.end()
  return stream
}

function failedStream(options: StreamOptions | undefined): AssistantMessageEventStreamLike {
  const stream = createTestEventStream()
  const error = {
    ...message(),
    stopReason: "error" as const,
    errorMessage: `Authorization: Bearer ${KEY_A}`,
  }
  void options?.onTerminalFailure?.({
    source: "generate",
    phase: "response",
    kind: "http",
    status: 429,
  })
  stream.push({ type: "start", partial: message() })
  stream.push({ type: "error", reason: "error", error })
  stream.end()
  return stream
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "commandcode-wiring-"))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function poolService(root: string): Promise<AccountService> {
  const store = createAccountStore({
    stateDir: root,
    uuid: (() => {
      const ids = [ID_A, ID_B]
      let index = 0
      return () => ids[index++] ?? ID_B
    })(),
  })
  const service = createAccountService({ store })
  return (async () => {
    await service.add({ apiKey: KEY_A, keyName: "alpha", login: "alpha" })
    await service.add({ apiKey: KEY_B, keyName: "bravo", login: "bravo" })
    return service
  })()
}

describe("WU6 account routing wiring", () => {
  it("routes a valid non-empty store through the pool stream and never emits the failed attempt", async () => {
    await withRoot(async (root) => {
      const service = await poolService(root)
      const calls: string[] = []
      const stream = createAccountAwareStream({
        accounts: service,
        createStream: createTestEventStream,
        streamLegacy: () => {
          throw new Error("legacy branch must not run for a pool")
        },
        streamAccount: (account, _model, _context, options) => {
          assert.ok(account)
          calls.push(account.id)
          return account.id === ID_A ? failedStream(options) : successStream("bravo")
        },
      })(makeModel(), makeContext(), { apiKey: "host-key", maxRetries: 7 })

      const events = await collectEvents(stream)
      assert.deepEqual(calls, [ID_A, ID_B])
      assert.deepEqual(
        events.map((event) => event.type),
        ["start", "text_start", "text_delta", "text_end", "done"],
      )
      assert.doesNotMatch(JSON.stringify(events), /cc_test_placeholder_wiring_alpha|Bearer/i)
    })
  })

  it("keeps absent and valid-empty stores on the legacy branch with the original options object", async () => {
    await withRoot(async (root) => {
      const store = createAccountStore({ stateDir: root })
      const service = createAccountService({ store })
      const original: StreamOptions = { apiKey: "legacy-key", maxRetries: 8 }
      let seen: StreamOptions | undefined
      const events = await collectEvents(
        createAccountAwareStream({
          accounts: service,
          createStream: createTestEventStream,
          streamLegacy: (_model, _context, options) => {
            seen = options
            return successStream("legacy")
          },
          streamAccount: () => {
            throw new Error("pool branch must not run")
          },
        })(makeModel(), makeContext(), original),
      )

      assert.strictEqual(seen, original)
      assert.equal(original.maxRetries, 8)
      assert.deepEqual(
        events.map((event) => event.type),
        ["start", "text_start", "text_delta", "text_end", "done"],
      )
      await assert.rejects(stat(join(root, "accounts.json")), { code: "ENOENT" })

      const added = await store.addAccount({
        label: "temporary",
        credential: { kind: "api-key", value: KEY_A },
      })
      await store.removeAccount(added.id)
      seen = undefined
      await collectEvents(
        createAccountAwareStream({
          accounts: service,
          createStream: createTestEventStream,
          streamLegacy: (_model, _context, options) => {
            seen = options
            return successStream("empty")
          },
          streamAccount: () => {
            throw new Error("empty pool must use legacy branch")
          },
        })(makeModel(), makeContext(), original),
      )
      assert.strictEqual(seen, original)
    })
  })

  it("fails closed when the store is unavailable instead of falling back to a legacy credential", async () => {
    const seen: string[] = []
    const accounts = {
      mode: async () => ({
        kind: "unavailable" as const,
        message: "Command Code account pool is unavailable; inspect private state permissions.",
      }),
    } as unknown as Pick<
      AccountService,
      | "mode"
      | "planLogicalRequest"
      | "isStillConfigured"
      | "recordEligibleFailure"
      | "recordSuccess"
    >
    const events = await collectEvents(
      createAccountAwareStream({
        accounts,
        createStream: createTestEventStream,
        streamLegacy: () => {
          seen.push("legacy")
          return successStream("must-not-run")
        },
        streamAccount: () => {
          seen.push("pool")
          return successStream("must-not-run")
        },
      })(makeModel(), makeContext(), { apiKey: KEY_A }),
    )

    assert.deepEqual(seen, [])
    assert.deepEqual(
      events.map((event) => event.type),
      ["error"],
    )
    const terminal = events[0]
    assert.equal(terminal?.type, "error")
    if (terminal?.type === "error") {
      assert.match(terminal.error.errorMessage ?? "", /account.*available/i)
      assert.doesNotMatch(terminal.error.errorMessage ?? "", /cc_test_placeholder|Bearer/i)
    }
  })

  it("awaits shutdown until an outstanding probe lease is released", async () => {
    const root = await mkdtemp(join(tmpdir(), "commandcode-wiring-shutdown-"))
    try {
      const now = { value: 1_000 }
      const store = createAccountStore({ stateDir: root, now: () => now.value, uuid: () => ID_A })
      const coordination = createCoordinationStore({ stateDir: root, now: () => now.value })
      const service = createAccountService({
        store,
        coordination,
        now: () => now.value,
        probeAccount: async () => new Promise(() => {}),
      })
      await service.add({ apiKey: KEY_A, keyName: "alpha", login: "alpha" })
      await service.recordEligibleFailure(ID_A, {
        source: "generate",
        phase: "response",
        kind: "http",
        status: 408,
      })
      now.value += 60_000
      await service.planLogicalRequest()
      for (let turn = 0; turn < 1_000; turn += 1) {
        const loaded = await coordination.load()
        if (loaded.kind === "loaded" && loaded.snapshot.leases[ID_A]) break
        await new Promise<void>((resolve) => setImmediate(resolve))
      }

      await Promise.race([
        service.shutdown(),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("shutdown did not release the probe")), 200),
        ),
      ])
      const loaded = await coordination.load()
      assert.equal(loaded.kind, "loaded")
      if (loaded.kind === "loaded") assert.equal(loaded.snapshot.leases[ID_A], undefined)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("keeps final wiring structural: one service, registry, pool stream, and shutdown hook", async () => {
    const source = await readFile(new URL("../index.ts", import.meta.url), "utf8")
    assert.equal((source.match(/createAccountService\(/g) ?? []).length, 1)
    assert.equal((source.match(/createCommandCodeTransportRegistry\(/g) ?? []).length, 1)
    assert.match(source, /createFailoverStream|createAccountAwareStream/)
    assert.match(
      source,
      /pruneAccountState:\s*async\s*\(id\)\s*=>\s*transportRegistry\.reset\(id\)/,
    )
    assert.match(source, /session_shutdown[\s\S]*await runtime\.shutdown\(\)/)
  })
})
