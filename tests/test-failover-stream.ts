import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { createAccountStore } from "../src/account-store.ts"
import { createAccountService, type AccountAttempt, type AccountService } from "../src/accounts.ts"
import { createFailoverStream, type FailoverStreamDependencies } from "../src/failover.ts"
import { classifyFailure } from "../src/failover.ts"
import { createCommandCodeTransportRegistry, type TransportDependencies } from "../src/transport.ts"
import type {
  AssistantMessageEvent,
  AssistantMessageEventStreamLike,
  AssistantMessageLike,
  ModelLike,
  StreamOptions,
  TransportFailure,
} from "../src/types.ts"
import { collectEvents, createTestEventStream, makeContext, makeModel } from "./helpers.ts"

const KEY_A = "cc_test_placeholder_stream_alpha"
const KEY_B = "cc_test_placeholder_stream_bravo"
const KEY_C = "cc_test_placeholder_stream_charlie"
const ID_A = "11111111-1111-4111-8111-111111111111"
const ID_B = "22222222-2222-4222-8222-222222222222"
const ID_C = "33333333-3333-4333-8333-333333333333"

type TestMessage = AssistantMessageLike

type Script = (options: StreamOptions | undefined) => AssistantMessageEventStreamLike

function message(
  content: TestMessage["content"] = [],
  stopReason: TestMessage["stopReason"] = "stop",
  errorMessage?: string,
): TestMessage {
  const model = makeModel()
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: 1_000_000,
  }
}

function successEvents(text = "ok"): AssistantMessageEvent[] {
  const partial = message([{ type: "text", text }])
  return [
    { type: "start", partial: message() },
    { type: "text_start", contentIndex: 0, partial },
    { type: "text_delta", contentIndex: 0, delta: text, partial },
    { type: "text_end", contentIndex: 0, content: text, partial },
    { type: "done", reason: "stop", message: partial },
  ]
}

function errorEvent(
  errorMessage: string,
  reason: "error" | "aborted" = "error",
): Extract<AssistantMessageEvent, { type: "error" }> {
  return {
    type: "error",
    reason,
    error: message([], reason === "aborted" ? "aborted" : "error", errorMessage),
  }
}

function scripted(
  events: readonly AssistantMessageEvent[],
  failure: TransportFailure | undefined,
  options: StreamOptions | undefined,
): AssistantMessageEventStreamLike {
  const stream = createTestEventStream()
  if (failure) void options?.onTerminalFailure?.(failure)
  for (const event of events) stream.push(event)
  stream.end()
  return stream
}

function failure(overrides: Partial<TransportFailure> = {}): TransportFailure {
  return {
    source: "generate",
    phase: "response",
    kind: "http",
    status: 429,
    ...overrides,
  }
}

async function withPool(
  run: (service: AccountService, now: { value: number }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "commandcode-failover-"))
  try {
    const now = { value: 2_000_000 }
    let idIndex = 0
    const ids = [ID_A, ID_B, ID_C]
    const store = createAccountStore({
      stateDir: root,
      uuid: () => ids[idIndex++] ?? "44444444-4444-4444-8444-444444444444",
      nonce: () => "55555555-5555-4555-8555-555555555555",
      now: () => now.value,
    })
    const service = createAccountService({
      store,
      now: () => now.value,
      probeAccount: async () => ({ kind: "available" }),
    })
    await service.add({ apiKey: KEY_A, keyName: "alpha", login: "alpha" })
    await service.add({ apiKey: KEY_B, keyName: "bravo", login: "bravo" })
    await service.add({ apiKey: KEY_C, keyName: "charlie", login: "charlie" })
    await run(service, now)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function createHarness(
  service: AccountService,
  scripts: ReadonlyMap<string, Script>,
  calls: Array<{ id: string | undefined; options: StreamOptions | undefined }>,
  extra: Partial<FailoverStreamDependencies> = {},
): FailoverStreamDependencies {
  return {
    accounts: service,
    createStream: createTestEventStream,
    classify: classifyFailure,
    streamAccount: (account, _model, _context, options) => {
      calls.push({ id: account?.id, options })
      if (!account) throw new Error("legacy stream was not supplied")
      const script = scripts.get(account.id)
      if (!script) throw new Error(`missing script for ${account.id}`)
      return script(options)
    },
    ...extra,
  }
}

describe("buffered account failover stream", () => {
  it("returns synchronously, tries primary first, clones options, and silently wins on B", async () => {
    await withPool(async (service) => {
      const calls: Array<{ id: string | undefined; options: StreamOptions | undefined }> = []
      const observedFailures: TransportFailure[] = []
      const scripts = new Map<string, Script>([
        [
          ID_A,
          (options) =>
            scripted(
              [
                { type: "start", partial: message() },
                errorEvent(`upstream Authorization: Bearer ${KEY_A}`),
              ],
              failure({ status: 429, retryAfterMs: 60 * 60 * 1000 }),
              options,
            ),
        ],
        [ID_B, (options) => scripted(successEvents("bravo"), undefined, options)],
      ])
      const original: StreamOptions = {
        apiKey: "host-placeholder",
        maxRetries: 9,
        maxRetryDelayMs: 12,
        onTerminalFailure: (observed) => {
          observedFailures.push(observed)
        },
      }
      const stream = createFailoverStream(
        createHarness(service, scripts, calls),
        makeModel(),
        makeContext(),
        original,
      )
      assert.ok(stream)
      const events = await collectEvents(stream)

      assert.deepEqual(
        events.map((event) => event.type),
        ["start", "text_start", "text_delta", "text_end", "done"],
      )
      assert.deepEqual(
        calls.map((call) => call.id),
        [ID_A, ID_B],
      )
      assert.equal(calls[0]?.options?.apiKey, KEY_A)
      assert.equal(calls[1]?.options?.apiKey, KEY_B)
      assert.equal(calls[0]?.options?.maxRetries, 0)
      assert.equal(calls[1]?.options?.maxRetries, 0)
      assert.equal(calls[0]?.options?.forceMaxRetriesZero, true)
      assert.equal(calls[1]?.options?.forceMaxRetriesZero, true)
      assert.equal(original.maxRetries, 9)
      assert.deepEqual(observedFailures, [failure({ status: 429, retryAfterMs: 60 * 60 * 1000 })])
      assert.equal(service.getHealth(ID_A)?.cooldownUntil, 2_000_000 + 15 * 60 * 1000)
      assert.doesNotMatch(JSON.stringify(events), new RegExp(KEY_A))
    })
  })

  it("buffers failed attempts and commits only one redacted start plus the last eligible error", async () => {
    await withPool(async (service) => {
      const calls: string[] = []
      const scripts = new Map<string, Script>([
        [
          ID_A,
          (options) => {
            calls.push(ID_A)
            return scripted(
              [{ type: "start", partial: message() }, errorEvent(`Bearer ${KEY_A}`)],
              failure({ status: 500 }),
              options,
            )
          },
        ],
        [
          ID_B,
          (options) => {
            calls.push(ID_B)
            return scripted(
              [{ type: "start", partial: message() }, errorEvent(`Bearer ${KEY_B}`)],
              failure({ status: 408 }),
              options,
            )
          },
        ],
        [
          ID_C,
          (options) => {
            calls.push(ID_C)
            return scripted(
              [{ type: "start", partial: message() }, errorEvent(`Bearer ${KEY_C}`)],
              failure({ status: 503 }),
              options,
            )
          },
        ],
      ])
      const stream = createFailoverStream(
        createHarness(service, scripts, []),
        makeModel(),
        makeContext(),
        { maxRetries: 4 },
      )
      const events = await collectEvents(stream)

      assert.deepEqual(calls, [ID_A, ID_B, ID_C])
      assert.deepEqual(
        events.map((event) => event.type),
        ["start", "error"],
      )
      assert.equal(events.filter((event) => event.type === "start").length, 1)
      const terminal = events.at(-1)
      assert.equal(terminal?.type, "error")
      if (terminal?.type === "error") {
        assert.equal(terminal.error.errorMessage, "Bearer [redacted]")
      }
    })
  })

  it("commits the first content boundary and never switches after content or a tool-call start", async () => {
    await withPool(async (service) => {
      for (const boundary of ["text_start", "thinking_start", "toolcall_start"] as const) {
        const calls: string[] = []
        const scripts = new Map<string, Script>([
          [
            ID_A,
            (options) => {
              calls.push(ID_A)
              const partial = message(
                boundary === "toolcall_start"
                  ? [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }]
                  : boundary === "thinking_start"
                    ? [{ type: "thinking", thinking: "think" }]
                    : [{ type: "text", text: "partial" }],
              )
              const contentEvent: AssistantMessageEvent =
                boundary === "text_start"
                  ? { type: "text_start", contentIndex: 0, partial }
                  : boundary === "thinking_start"
                    ? { type: "thinking_start", contentIndex: 0, partial }
                    : { type: "toolcall_start", contentIndex: 0, partial }
              return scripted(
                [
                  { type: "start", partial: message() },
                  contentEvent,
                  errorEvent(`Bearer ${KEY_A}`),
                ],
                failure({ status: 502 }),
                options,
              )
            },
          ],
          [
            ID_B,
            () => {
              calls.push(ID_B)
              return scripted(successEvents("should-not-run"), undefined, undefined)
            },
          ],
        ])
        const events = await collectEvents(
          createFailoverStream(createHarness(service, scripts, []), makeModel(), makeContext(), {}),
        )
        assert.deepEqual(calls, [ID_A], boundary)
        assert.equal(events.filter((event) => event.type === "start").length, 1, boundary)
        assert.equal(events.at(-1)?.type, "error", boundary)
      }
    })
  })

  it("commits a pre-content done as one start and done and records success", async () => {
    await withPool(async (service) => {
      const calls: string[] = []
      const scripts = new Map<string, Script>([
        [
          ID_B,
          (options) => {
            calls.push(ID_B)
            return scripted(
              [
                { type: "start", partial: message() },
                { type: "done", reason: "stop", message: message() },
              ],
              undefined,
              options,
            )
          },
        ],
      ])
      await service.recordEligibleFailure(ID_A, failure({ status: 429 }))
      const events = await collectEvents(
        createFailoverStream(createHarness(service, scripts, []), makeModel(), makeContext(), {}),
      )
      assert.deepEqual(calls, [ID_B])
      assert.deepEqual(
        events.map((event) => event.type),
        ["start", "done"],
      )
      assert.equal(service.getHealth(ID_B), undefined)
    })
  })

  it("stops on ineligible errors and caller cancellation without cooldown or another account", async () => {
    await withPool(async (service) => {
      const calls: string[] = []
      const ineligible = new Map<string, Script>([
        [
          ID_A,
          (options) => {
            calls.push(ID_A)
            return scripted(
              [{ type: "start", partial: message() }, errorEvent(`Bearer ${KEY_A}`)],
              failure({ status: 400 }),
              options,
            )
          },
        ],
      ])
      const ineligibleEvents = await collectEvents(
        createFailoverStream(
          createHarness(service, ineligible, []),
          makeModel(),
          makeContext(),
          {},
        ),
      )
      assert.deepEqual(calls, [ID_A])
      assert.deepEqual(
        ineligibleEvents.map((event) => event.type),
        ["start", "error"],
      )
      assert.equal(service.getHealth(ID_A), undefined)

      calls.length = 0
      const caller = new AbortController()
      const cancelled = new Map<string, Script>([
        [
          ID_A,
          (options) => {
            calls.push(ID_A)
            return scripted(
              [{ type: "start", partial: message() }, errorEvent("Request aborted", "aborted")],
              failure({ kind: "abort", status: undefined, abortOrigin: "caller" }),
              options,
            )
          },
        ],
      ])
      caller.abort()
      const cancelledEvents = await collectEvents(
        createFailoverStream(createHarness(service, cancelled, []), makeModel(), makeContext(), {
          signal: caller.signal,
        }),
      )
      assert.deepEqual(calls, [ID_A])
      assert.equal(cancelledEvents.at(-1)?.type, "error")
      assert.equal(service.getHealth(ID_A), undefined)
    })
  })

  it("terminates a pending pre-content read immediately on caller cancellation", async () => {
    await withPool(async (service) => {
      const caller = new AbortController()
      let returnCalled = false
      const pending: AssistantMessageEventStreamLike = {
        push() {},
        end() {},
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise<IteratorResult<AssistantMessageEvent>>(() => {}),
            return: () => {
              returnCalled = true
              return new Promise<IteratorResult<AssistantMessageEvent>>(() => {})
            },
          }
        },
      }
      const scripts = new Map<string, Script>([[ID_A, () => pending]])
      const stream = createFailoverStream(
        createHarness(service, scripts, []),
        makeModel(),
        makeContext(),
        { signal: caller.signal },
      )
      caller.abort()

      const events = await Promise.race([
        collectEvents(stream),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("caller cancellation did not terminate")), 100),
        ),
      ])
      assert.equal(returnCalled, true)
      assert.deepEqual(
        events.map((event) => event.type),
        ["start", "error"],
      )
      const terminal = events.at(-1)
      assert.equal(terminal?.type, "error")
      assert.equal(terminal?.type === "error" ? terminal.reason : undefined, "aborted")
      assert.equal(service.getHealth(ID_A), undefined)
    })
  })

  it("shows one unavailable error when every account is cooling and parks A for the next request", async () => {
    await withPool(async (service, now) => {
      await service.recordEligibleFailure(ID_A, failure({ status: 429 }))
      await service.recordEligibleFailure(ID_B, failure({ status: 500 }))
      await service.recordEligibleFailure(ID_C, failure({ status: 503 }))
      const calls: string[] = []
      const stream = createFailoverStream(
        createHarness(service, new Map(), [], {
          streamAccount: (account) => {
            calls.push(account?.id ?? "legacy")
            throw new Error("should not create a cooling attempt")
          },
        }),
        makeModel(),
        makeContext(),
        {},
      )
      const events = await collectEvents(stream)
      assert.deepEqual(calls, [])
      assert.deepEqual(
        events.map((event) => event.type),
        ["error"],
      )
      const terminal = events[0]
      assert.equal(terminal?.type, "error")
      if (terminal?.type === "error") {
        assert.match(terminal.error.errorMessage ?? "", /retry after/i)
        assert.doesNotMatch(terminal.error.errorMessage ?? "", /cc_test_placeholder|Bearer/i)
      }
      assert.equal(now.value, 2_000_000)
    })
  })

  it("returns to primary after non-blocking recovery probing", async () => {
    await withPool(async (service, now) => {
      const order: string[] = []
      const scripts = new Map<string, Script>([
        [
          ID_A,
          (options) => {
            order.push(ID_A)
            return scripted(
              [{ type: "start", partial: message() }, errorEvent("rate limited")],
              failure({ status: 429, retryAfterMs: 2_000 }),
              options,
            )
          },
        ],
        [
          ID_B,
          (options) => {
            order.push(ID_B)
            return scripted(successEvents("fallback"), undefined, options)
          },
        ],
      ])
      await collectEvents(
        createFailoverStream(createHarness(service, scripts, []), makeModel(), makeContext(), {
          maxRetries: 9,
        }),
      )
      await collectEvents(
        createFailoverStream(createHarness(service, scripts, []), makeModel(), makeContext(), {}),
      )
      assert.deepEqual(order, [ID_A, ID_B, ID_B])

      now.value += 5 * 60 * 1000
      await collectEvents(
        createFailoverStream(createHarness(service, scripts, []), makeModel(), makeContext(), {}),
      )
      assert.deepEqual(order, [ID_A, ID_B, ID_B, ID_B])
      for (let turn = 0; turn < 1_000 && service.getHealth(ID_A); turn += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      await collectEvents(
        createFailoverStream(createHarness(service, scripts, []), makeModel(), makeContext(), {}),
      )
      assert.deepEqual(order, [ID_A, ID_B, ID_B, ID_B, ID_A, ID_B])
    })
  })

  it("skips an account removed after planning and applies a primary reorder to the next request", async () => {
    await withPool(async (service) => {
      const calls: string[] = []
      let removed = false
      const scripts = new Map<string, Script>([
        [
          ID_B,
          (options) => {
            calls.push(ID_B)
            return scripted(successEvents("bravo"), undefined, options)
          },
        ],
      ])
      const accounts = {
        ...service,
        isStillConfigured: async (id: string, revision: number) => {
          if (!removed && id === ID_A) {
            removed = true
            await service.remove(ID_A)
            return false
          }
          return service.isStillConfigured(id, revision)
        },
      } satisfies AccountService
      await service.setPrimary(ID_B)
      await service.setPrimary(ID_A)
      const events = await collectEvents(
        createFailoverStream(createHarness(accounts, scripts, []), makeModel(), makeContext(), {}),
      )
      assert.equal(events.at(-1)?.type, "done")
      assert.deepEqual(calls, [ID_B])
      assert.equal(await service.isStillConfigured(ID_A, 1), false)
      await service.setPrimary(ID_B)
      assert.deepEqual(
        (await service.planLogicalRequest()).attempts.map((account) => account.id),
        [ID_B, ID_C],
      )
    })
  })

  it("keeps legacy routing inert and passes the original options object unchanged", async () => {
    const original: StreamOptions = { apiKey: "legacy-key", maxRetries: 6 }
    const seen: { options?: StreamOptions; classifyCalls: number } = { classifyCalls: 0 }
    const legacyStream = createTestEventStream()
    for (const event of successEvents("legacy")) legacyStream.push(event)
    legacyStream.end()
    const accounts = {
      mode: async () => ({ kind: "legacy" as const }),
    } as AccountService
    const deps: FailoverStreamDependencies = {
      accounts,
      createStream: createTestEventStream,
      classify: () => {
        seen.classifyCalls += 1
        throw new Error("legacy must not classify")
      },
      streamLegacy: (_model, _context, options) => {
        seen.options = options
        return legacyStream
      },
      streamAccount: () => {
        throw new Error("legacy must not use pool account stream")
      },
    }
    const events = await collectEvents(
      createFailoverStream(deps, makeModel(), makeContext(), original),
    )
    assert.deepEqual(
      events.map((event) => event.type),
      ["start", "text_start", "text_delta", "text_end", "done"],
    )
    assert.equal(seen.options, original)
    assert.equal(seen.classifyCalls, 0)
  })

  it("allows concurrent healthy logical requests to proceed without cross-request serialization", async () => {
    await withPool(async (service) => {
      await service.recordEligibleFailure(ID_A, failure({ status: 429 }))
      let active = 0
      let maximum = 0
      let started = 0
      let resolveStarted: (() => void) | undefined
      const bothStarted = new Promise<void>((resolve) => {
        resolveStarted = resolve
      })
      const waiting = new Map<string, AssistantMessageEventStreamLike>()
      const scripts = new Map<string, Script>([
        [
          ID_B,
          () => {
            const stream = createTestEventStream()
            active += 1
            maximum = Math.max(maximum, active)
            started += 1
            if (started === 2) resolveStarted?.()
            waiting.set(`${started}`, stream)
            return stream
          },
        ],
      ])
      const deps = createHarness(service, scripts, [])
      const first = createFailoverStream(deps, makeModel(), makeContext(), {})
      const second = createFailoverStream(deps, makeModel(), makeContext(), {})
      const firstEvents = collectEvents(first)
      const secondEvents = collectEvents(second)
      await bothStarted
      assert.equal(maximum, 2)
      for (const stream of waiting.values()) {
        for (const event of successEvents("parallel")) stream.push(event)
        stream.end()
      }
      await Promise.all([firstEvents, secondEvents])
      assert.equal(active, 2)
    })
  })
})

describe("per-account transport registry", () => {
  function providerStream(options: StreamOptions | undefined): AssistantMessageEventStreamLike {
    const stream = createTestEventStream()
    void (async () => {
      const response = await (options?.fetch ?? fetch)("https://transport.test", {
        signal: new AbortController().signal,
      })
      await options?.onResponse?.(
        { status: response.status, headers: Object.fromEntries(response.headers.entries()) },
        makeModel(),
      )
      for (const event of successEvents("provider")) stream.push(event)
      stream.end()
    })().catch(() => stream.end())
    return stream
  }

  it("keeps transport detection isolated per account and resets memory when a key changes", async () => {
    const deps: TransportDependencies = {
      createStream: createTestEventStream,
      streamProvider: (_model, _context, options) => providerStream(options),
      streamGenerate: (_model, _context, options) => providerStream(options),
    }
    const registry = createCommandCodeTransportRegistry(deps)
    const model: ModelLike = makeModel()
    const context = makeContext()
    const a = registry.forAccount(ID_A)
    const b = registry.forAccount(ID_B)
    assert.notEqual(a, b)
    assert.equal(registry.forAccount(ID_A), a)
    assert.equal(a.getTransport(), "unknown")
    assert.equal(b.getTransport(), "unknown")

    await collectEvents(
      a.stream(model, context, {
        apiKey: KEY_A,
        fetch: async () => new Response("ok", { status: 200 }),
      }),
    )
    assert.equal(a.getTransport(), "provider")
    assert.equal(b.getTransport(), "unknown")

    await collectEvents(
      registry.stream(ID_A, model, context, {
        apiKey: KEY_B,
        fetch: async () => new Response("ok", { status: 200 }),
      }),
    )
    assert.equal(a.getTransport(), "provider")
    assert.equal(registry.forAccount(ID_B).getTransport(), "unknown")
  })
})
