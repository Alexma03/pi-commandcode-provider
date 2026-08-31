import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createCommandCodeTransportRouter } from "../src/transport.ts"
import type {
  AssistantMessageEvent,
  AssistantMessageEventStreamLike,
  StreamOptions,
} from "../src/types.ts"
import { collectEvents, createTestEventStream, makeContext, makeModel } from "./helpers.ts"

function completedStream(text: string): AssistantMessageEventStreamLike {
  const stream = createTestEventStream()
  const model = makeModel()
  const message = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
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
    stopReason: "stop" as const,
    timestamp: Date.now(),
  }
  const events: AssistantMessageEvent[] = [
    { type: "start", partial: message },
    { type: "text_start", contentIndex: 0, partial: message },
    { type: "text_delta", contentIndex: 0, delta: text, partial: message },
    { type: "text_end", contentIndex: 0, content: text, partial: message },
    { type: "done", reason: "stop", message },
  ]
  for (const event of events) stream.push(event)
  stream.end()
  return stream
}

function providerStream(
  response: Response,
  text: string,
  options?: StreamOptions,
): AssistantMessageEventStreamLike {
  const stream = createTestEventStream()
  const run = async () => {
    const received = await (options?.fetch ?? fetch)("https://provider.test", {})
    await options?.onResponse?.(
      { status: received.status, headers: {} },
      makeModel({ api: "openai-completions" }),
    )
    const source = completedStream(text)
    for await (const event of source) stream.push(event)
    stream.end()
  }
  run().catch(() => stream.end())
  return stream
}

async function within<T>(promise: Promise<T>, milliseconds = 1_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("operation did not complete within its bound")),
          milliseconds,
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function nativeErrorEvent(model = makeModel()): Extract<AssistantMessageEvent, { type: "error" }> {
  return {
    type: "error",
    reason: "error",
    error: {
      role: "assistant",
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
      stopReason: "error",
      errorMessage: "native conversion failed",
      timestamp: Date.now(),
    },
  }
}

describe("Command Code transport router", () => {
  it("keeps using the Provider API after a successful request", async () => {
    let providerCalls = 0
    let generateCalls = 0
    const router = createCommandCodeTransportRouter({
      createStream: createTestEventStream,
      streamProvider: (_model, _context, options) => {
        providerCalls += 1
        return providerStream(new Response("ok", { status: 200 }), "provider", options)
      },
      streamGenerate: () => {
        generateCalls += 1
        return completedStream("generate")
      },
    })

    const options: StreamOptions = {
      fetch: () => Promise.resolve(new Response("ok", { status: 200 })),
    }
    const first = await collectEvents(router.stream(makeModel(), makeContext(), options))
    const second = await collectEvents(router.stream(makeModel(), makeContext(), options))

    assert.equal(first.at(-1)?.type, "done")
    assert.equal(second.at(-1)?.type, "done")
    assert.equal(router.getTransport(), "provider")
    assert.equal(providerCalls, 2)
    assert.equal(generateCalls, 0)
  })

  it("forces zero retries through a cached generate transport", async () => {
    let generateCalls = 0
    let lastGenerateOptions: StreamOptions | undefined
    const upgradeBody = JSON.stringify({ error: { code: "upgrade_required" } })
    const router = createCommandCodeTransportRouter({
      createStream: createTestEventStream,
      streamProvider: (_model, _context, options) =>
        providerStream(new Response(upgradeBody, { status: 403 }), "discarded", options),
      streamGenerate: (_model, _context, options) => {
        generateCalls += 1
        lastGenerateOptions = options
        return completedStream("generate")
      },
    })

    await collectEvents(
      router.stream(makeModel(), makeContext(), {
        apiKey: "cached-generate-key",
        fetch: () => Promise.resolve(new Response(upgradeBody, { status: 403 })),
        maxRetries: 3,
        forceMaxRetriesZero: true,
      }),
    )
    await collectEvents(
      router.stream(makeModel(), makeContext(), {
        apiKey: "cached-generate-key",
        maxRetries: 7,
        forceMaxRetriesZero: true,
      }),
    )

    assert.equal(generateCalls, 2)
    assert.equal(lastGenerateOptions?.maxRetries, 0)
  })

  it("falls back only for 403 upgrade_required and remembers generate", async () => {
    let providerCalls = 0
    let generateCalls = 0
    const responseBody = JSON.stringify({
      error: { code: "upgrade_required", type: "permission_error" },
    })
    const router = createCommandCodeTransportRouter({
      createStream: createTestEventStream,
      streamProvider: (_model, _context, options) => {
        providerCalls += 1
        return providerStream(new Response(responseBody, { status: 403 }), "blocked", options)
      },
      streamGenerate: () => {
        generateCalls += 1
        return completedStream("generate")
      },
    })
    const options: StreamOptions = {
      fetch: () => Promise.resolve(new Response(responseBody, { status: 403 })),
    }

    const first = await collectEvents(router.stream(makeModel(), makeContext(), options))
    const second = await collectEvents(router.stream(makeModel(), makeContext(), options))

    assert.equal(first.at(-1)?.type, "done")
    assert.equal(second.at(-1)?.type, "done")
    assert.equal(router.getTransport(), "generate")
    assert.equal(providerCalls, 1)
    assert.equal(generateCalls, 2)
  })

  it("re-detects the transport after the API key changes", async () => {
    let providerCalls = 0
    let generateCalls = 0
    const upgradeBody = JSON.stringify({ error: { code: "upgrade_required" } })
    const router = createCommandCodeTransportRouter({
      createStream: createTestEventStream,
      streamProvider: (_model, _context, options) => {
        providerCalls += 1
        const response =
          options?.apiKey === "go-key"
            ? new Response(upgradeBody, { status: 403 })
            : new Response("ok", { status: 200 })
        return providerStream(response, "provider", options)
      },
      streamGenerate: () => {
        generateCalls += 1
        return completedStream("generate")
      },
    })

    await collectEvents(
      router.stream(makeModel(), makeContext(), {
        apiKey: "go-key",
        fetch: () => Promise.resolve(new Response(upgradeBody, { status: 403 })),
      }),
    )
    await collectEvents(
      router.stream(makeModel(), makeContext(), {
        apiKey: "provider-key",
        fetch: () => Promise.resolve(new Response("ok", { status: 200 })),
      }),
    )

    assert.equal(router.getTransport(), "provider")
    assert.equal(providerCalls, 2)
    assert.equal(generateCalls, 1)
  })

  it("does not let a stale request overwrite the transport for a new API key", async () => {
    let releaseGoRequest: (() => void) | undefined
    const goRequestGate = new Promise<void>((resolve) => {
      releaseGoRequest = resolve
    })
    let providerCalls = 0
    let generateCalls = 0
    const upgradeBody = JSON.stringify({ error: { code: "upgrade_required" } })
    const router = createCommandCodeTransportRouter({
      createStream: createTestEventStream,
      streamProvider: (_model, _context, options) => {
        providerCalls += 1
        const response =
          options?.apiKey === "go-key"
            ? new Response(upgradeBody, { status: 403 })
            : new Response("ok", { status: 200 })
        const stream = createTestEventStream()
        const run = async () => {
          if (options?.apiKey === "go-key") await goRequestGate
          const received = await (options?.fetch ?? fetch)("https://provider.test", {})
          await options?.onResponse?.(
            { status: received.status, headers: {} },
            makeModel({ api: "openai-completions" }),
          )
          if (response.ok) {
            for await (const event of completedStream("provider")) stream.push(event)
          }
          stream.end()
        }
        run().catch(() => stream.end())
        return stream
      },
      streamGenerate: () => {
        generateCalls += 1
        return completedStream("generate")
      },
    })

    const staleGoRequest = collectEvents(
      router.stream(makeModel(), makeContext(), {
        apiKey: "go-key",
        fetch: () => Promise.resolve(new Response(upgradeBody, { status: 403 })),
      }),
    )
    await collectEvents(
      router.stream(makeModel(), makeContext(), {
        apiKey: "provider-key",
        fetch: () => Promise.resolve(new Response("ok", { status: 200 })),
      }),
    )
    releaseGoRequest?.()
    await staleGoRequest
    await collectEvents(
      router.stream(makeModel(), makeContext(), {
        apiKey: "provider-key",
        fetch: () => Promise.resolve(new Response("ok", { status: 200 })),
      }),
    )

    assert.equal(router.getTransport(), "provider")
    assert.equal(providerCalls, 3)
    assert.equal(generateCalls, 1)
  })

  it("does not fall back for other 403 errors", async () => {
    let generateCalls = 0
    const responseBody = JSON.stringify({ error: { code: "permission_denied" } })
    const router = createCommandCodeTransportRouter({
      createStream: createTestEventStream,
      streamProvider: (_model, _context, options) =>
        providerStream(new Response(responseBody, { status: 403 }), "blocked", options),
      streamGenerate: () => {
        generateCalls += 1
        return completedStream("generate")
      },
    })
    const options: StreamOptions = {
      fetch: () => Promise.resolve(new Response(responseBody, { status: 403 })),
    }

    await collectEvents(router.stream(makeModel(), makeContext(), options))

    assert.equal(router.getTransport(), "provider")
    assert.equal(generateCalls, 0)
  })

  it("captures structured non-OK metadata for both selected native API paths", async () => {
    const responseBody = JSON.stringify({
      error: { code: "rate_limit", type: "temporary_failure", message: "not a classifier input" },
    })

    for (const api of ["openai-completions", "anthropic-messages"] as const) {
      let observed: unknown
      let responseInfo: { status: number; headers: Record<string, string> } | undefined
      const router = createCommandCodeTransportRouter({
        createStream: createTestEventStream,
        streamProvider: (_model, _context, options) => {
          const stream = createTestEventStream()
          void (async () => {
            const response = await (options?.fetch ?? fetch)("https://native.test", {
              method: "POST",
              signal: new AbortController().signal,
            })
            responseInfo = {
              status: response.status,
              headers: Object.fromEntries(response.headers.entries()),
            }
            await options?.onResponse?.(responseInfo, makeModel({ api }))
            stream.push({
              type: "error",
              reason: "error",
              error: {
                ...makeModel({ api }),
                role: "assistant",
                model: makeModel({ api }).id,
                content: [],
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "error",
                errorMessage: "native conversion failed",
                timestamp: Date.now(),
              },
            })
            stream.end()
          })().catch(() => stream.end())
          return stream
        },
        streamGenerate: () => completedStream("generate"),
      })

      const events = await collectEvents(
        router.stream(makeModel({ api }), makeContext(), {
          apiKey: "native-test-key",
          fetch: async () =>
            new Response(responseBody, {
              status: 429,
              headers: { "Retry-After": "7", "X-Request-ID": "request-1" },
            }),
          onTerminalFailure: (failure) => {
            observed = failure
          },
        }),
      )

      assert.equal(events.at(-1)?.type, "error")
      assert.deepEqual(observed, {
        source: "native",
        phase: "response",
        kind: "http",
        status: 429,
        retryAfterMs: 7_000,
        providerCode: "rate_limit",
        providerType: "temporary_failure",
      })
      assert.deepEqual(responseInfo, {
        status: 429,
        headers: {
          "content-type": "text/plain;charset=UTF-8",
          "retry-after": "7",
          "x-request-id": "request-1",
        },
      })
    }
  })

  it("captures an HTTP-date Retry-After value as bounded metadata", async () => {
    const retryAt = new Date(Date.now() + 120_000).toUTCString()
    let observed: unknown
    const router = createCommandCodeTransportRouter({
      createStream: createTestEventStream,
      streamProvider: (_model, _context, options) => {
        const stream = createTestEventStream()
        void (async () => {
          await (options?.fetch ?? fetch)("https://native.test", {
            signal: new AbortController().signal,
          })
          stream.push(nativeErrorEvent())
          stream.end()
        })().catch(() => stream.end())
        return stream
      },
      streamGenerate: () => completedStream("generate"),
    })

    const events = await collectEvents(
      router.stream(makeModel({ api: "anthropic-messages" }), makeContext(), {
        apiKey: "native-date-key",
        fetch: async () =>
          new Response(
            JSON.stringify({ error: { code: "rate_limit", type: "temporary_failure" } }),
            {
              status: 429,
              headers: { "Retry-After": retryAt },
            },
          ),
        onTerminalFailure: (failure) => {
          observed = failure
        },
      }),
    )

    assert.equal(events.at(-1)?.type, "error")
    assert.equal((observed as { source?: string }).source, "native")
    assert.equal((observed as { status?: number }).status, 429)
    const retryAfterMs = (observed as { retryAfterMs?: number }).retryAfterMs
    assert.ok(retryAfterMs !== undefined && retryAfterMs >= 119_000 && retryAfterMs <= 120_000)
  })

  it("bounds stalled and oversized native metadata-body capture", async () => {
    const bodies: Array<[string, () => BodyInit]> = [
      [
        "stalled",
        () =>
          new ReadableStream<Uint8Array>({
            pull: () => new Promise<void>(() => {}),
          }),
      ],
      ["oversized", () => new Uint8Array(64 * 1024 + 1)],
    ]

    for (const [name, body] of bodies) {
      let observed: unknown
      const router = createCommandCodeTransportRouter({
        createStream: createTestEventStream,
        streamProvider: (_model, _context, options) => {
          const stream = createTestEventStream()
          void (async () => {
            await (options?.fetch ?? fetch)("https://native.test", {
              signal: new AbortController().signal,
            })
            stream.push(nativeErrorEvent())
            stream.end()
          })().catch(() => stream.end())
          return stream
        },
        streamGenerate: () => completedStream("generate"),
      })

      const events = await within(
        collectEvents(
          router.stream(makeModel({ api: "openai-completions" }), makeContext(), {
            apiKey: `native-${name}-body-key`,
            fetch: async () => new Response(body(), { status: 429 }),
            onTerminalFailure: (failure) => {
              observed = failure
            },
          }),
        ),
      )

      assert.equal(events.at(-1)?.type, "error", name)
      assert.deepEqual(
        observed,
        { source: "native", phase: "response", kind: "http", status: 429 },
        name,
      )
    }
  })

  it("captures a native response-body read failure before SDK conversion", async () => {
    const readFailure = new RangeError("native body read failed")
    for (const api of ["openai-completions", "anthropic-messages"] as const) {
      let observed: unknown
      const router = createCommandCodeTransportRouter({
        createStream: createTestEventStream,
        streamProvider: (_model, _context, options) => {
          const stream = createTestEventStream()
          void (async () => {
            const response = await (options?.fetch ?? fetch)("https://native.test", {
              signal: new AbortController().signal,
            })
            try {
              await response.body?.getReader().read()
            } catch {
              // The adapter must retain this failure before the native SDK formats it.
            }
            stream.push({
              type: "error",
              reason: "error",
              error: {
                ...makeModel(),
                role: "assistant",
                model: makeModel().id,
                content: [],
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "error",
                errorMessage: "body conversion failed",
                timestamp: Date.now(),
              },
            })
            stream.end()
          })().catch(() => stream.end())
          return stream
        },
        streamGenerate: () => completedStream("generate"),
      })

      const events = await collectEvents(
        router.stream(makeModel({ api }), makeContext(), {
          apiKey: "native-test-key",
          fetch: async () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.error(readFailure)
                },
              }),
              { status: 200 },
            ),
          onTerminalFailure: (failure) => {
            observed = failure
          },
        }),
      )

      assert.equal(events.at(-1)?.type, "error")
      assert.deepEqual(observed, {
        source: "native",
        phase: "stream",
        kind: "network",
        streamReason: "upstream-connection",
      })
    }
  })

  it("does not let an earlier HTTP capture mask a later provider abort", async () => {
    const caller = new AbortController()
    let observed: unknown
    const router = createCommandCodeTransportRouter({
      createStream: createTestEventStream,
      streamProvider: (_model, _context, options) => {
        const provider = new AbortController()
        const stream = createTestEventStream()
        void (async () => {
          await (options?.fetch ?? fetch)("https://native.test", { signal: provider.signal })
          provider.abort()
          stream.push({ ...nativeErrorEvent(), reason: "aborted" })
          stream.end()
        })().catch(() => stream.end())
        return stream
      },
      streamGenerate: () => completedStream("generate"),
    })

    await collectEvents(
      router.stream(makeModel({ api: "openai-completions" }), makeContext(), {
        apiKey: "native-abort-after-response-key",
        signal: caller.signal,
        fetch: async () =>
          new Response(JSON.stringify({ error: { code: "rate_limit" } }), {
            status: 429,
            headers: { "Retry-After": "10" },
          }),
        onTerminalFailure: (failure) => {
          observed = failure
        },
      }),
    )

    assert.deepEqual(observed, {
      source: "native",
      phase: "request",
      kind: "abort",
      abortOrigin: "runtime-abort",
    })
  })

  it("preserves the first provider abort provenance when caller abort follows", async () => {
    const caller = new AbortController()
    let observed: unknown
    const router = createCommandCodeTransportRouter({
      createStream: createTestEventStream,
      streamProvider: (_model, _context, options) => {
        const provider = new AbortController()
        const stream = createTestEventStream()
        void (async () => {
          await (options?.fetch ?? fetch)("https://native.test", { signal: provider.signal })
          provider.abort()
          caller.abort()
          stream.push({ ...nativeErrorEvent(), reason: "aborted" })
          stream.end()
        })().catch(() => stream.end())
        return stream
      },
      streamGenerate: () => completedStream("generate"),
    })

    await collectEvents(
      router.stream(makeModel({ api: "anthropic-messages" }), makeContext(), {
        apiKey: "native-provider-first-key",
        signal: caller.signal,
        fetch: async () => new Response("ok", { status: 200 }),
        onTerminalFailure: (failure) => {
          observed = failure
        },
      }),
    )

    assert.deepEqual(observed, {
      source: "native",
      phase: "request",
      kind: "abort",
      abortOrigin: "runtime-abort",
    })
  })

  it("uses signal identity to capture a provider-owned native abort", async () => {
    const caller = new AbortController()
    let providerSignal: AbortSignal | undefined
    let observed: unknown
    const router = createCommandCodeTransportRouter({
      createStream: createTestEventStream,
      streamProvider: (_model, _context, options) => {
        const provider = new AbortController()
        providerSignal = provider.signal
        const stream = createTestEventStream()
        void (async () => {
          try {
            await (options?.fetch ?? fetch)("https://native.test", { signal: provider.signal })
          } catch {
            // The native SDK would convert this into its terminal stream error.
          }
          stream.push({
            type: "error",
            reason: "aborted",
            error: {
              ...makeModel(),
              role: "assistant",
              model: makeModel().id,
              content: [],
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "aborted",
              errorMessage: "native abort",
              timestamp: Date.now(),
            },
          })
          stream.end()
        })()
        queueMicrotask(() => provider.abort())
        return stream
      },
      streamGenerate: () => completedStream("generate"),
    })

    const events = await collectEvents(
      router.stream(makeModel({ api: "anthropic-messages" }), makeContext(), {
        apiKey: "native-test-key",
        signal: caller.signal,
        fetch: async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("provider abort", "AbortError")),
              { once: true },
            )
          }),
        onTerminalFailure: (failure) => {
          observed = failure
        },
      }),
    )

    assert.ok(providerSignal)
    assert.notEqual(providerSignal, caller.signal)
    assert.equal(caller.signal.aborted, false)
    assert.equal(events.at(-1)?.type, "error")
    assert.deepEqual(observed, {
      source: "native",
      phase: "request",
      kind: "abort",
      abortOrigin: "runtime-abort",
    })
  })

  it("discards upgrade_required capture and retries one same-key generate leg with zero retries", async () => {
    const upgradeBody = JSON.stringify({
      error: { code: "upgrade_required", type: "permission_error" },
    })
    let providerCalls = 0
    let generateCalls = 0
    let providerOptions: StreamOptions | undefined
    let generateOptions: StreamOptions | undefined
    let hookCalls = 0
    const router = createCommandCodeTransportRouter({
      createStream: createTestEventStream,
      streamProvider: (_model, _context, options) => {
        providerCalls += 1
        providerOptions = options
        return providerStream(new Response(upgradeBody, { status: 403 }), "discarded", options)
      },
      streamGenerate: (_model, _context, options) => {
        generateCalls += 1
        generateOptions = options
        return completedStream("generate")
      },
    })

    const events = await collectEvents(
      router.stream(makeModel({ api: "openai-completions" }), makeContext(), {
        apiKey: "same-account-key",
        maxRetries: 4,
        forceMaxRetriesZero: true,
        fetch: async () => new Response(upgradeBody, { status: 403 }),
        onTerminalFailure: () => {
          hookCalls += 1
        },
      }),
    )

    assert.equal(events.at(-1)?.type, "done")
    assert.equal(providerCalls, 1)
    assert.equal(generateCalls, 1)
    assert.equal(providerOptions?.apiKey, "same-account-key")
    assert.equal(providerOptions?.maxRetries, 0)
    assert.equal(generateOptions?.apiKey, "same-account-key")
    assert.equal(generateOptions?.maxRetries, 0)
    assert.equal(hookCalls, 0)
  })
})
