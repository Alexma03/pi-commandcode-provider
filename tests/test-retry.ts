/**
 * Tests for retry and timeout behaviour driven by pi settings.json
 * retry config (timeoutMs, maxRetries, maxRetryDelayMs).
 */

import assert from "node:assert/strict"
import { after, before, beforeEach, describe, it } from "node:test"

import type { AssistantMessageEvent } from "../src/core.ts"
import {
  collectEvents,
  createTestDeps,
  createTestEventStream,
  makeContext,
  makeModel,
  startMockCommandCodeServer,
  type MockCommandCodeServer,
} from "./helpers.ts"

const TEST_API_KEY = "option-key"

let server: MockCommandCodeServer

before(async () => {
  server = await startMockCommandCodeServer()
})

after(async () => {
  await server.close()
})

beforeEach(() => {
  server.reset()
})

function eventTypes(events: readonly AssistantMessageEvent[]): string[] {
  return events.map((event) => event.type)
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

describe("streamCommandCode — structured terminal failure capture", () => {
  it("calls onTerminalFailure exactly once before the terminal error with full HTTP metadata", async () => {
    server.mockResponse({
      type: "error",
      status: 429,
      body: JSON.stringify({ error: { code: "rate_limit", type: "temporary_failure" } }),
      headers: { "retry-after": "3" },
    })

    let hookCalls = 0
    let hookFailure: unknown
    let hookWasBeforeError = true
    const { streamCommandCode } = createTestDeps({
      apiBase: server.baseUrl(),
      createStream: () => {
        const inner = createTestEventStream()
        return {
          push(event: AssistantMessageEvent) {
            if (event.type === "error" && hookCalls === 0) hookWasBeforeError = false
            inner.push(event)
          },
          end() {
            inner.end()
          },
          [Symbol.asyncIterator]() {
            return inner[Symbol.asyncIterator]()
          },
        }
      },
    })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        maxRetries: 0,
        onTerminalFailure: (failure) => {
          hookCalls += 1
          hookFailure = failure
        },
      }),
    )

    assert.equal(server.requestCount(), 1)
    assert.equal(hookCalls, 1)
    assert.equal(hookWasBeforeError, true)
    assert.deepEqual(hookFailure, {
      source: "generate",
      phase: "response",
      kind: "http",
      status: 429,
      retryAfterMs: 3_000,
      providerCode: "rate_limit",
      providerType: "temporary_failure",
    })
    assert.equal(events.at(-1)?.type, "error")
  })

  it("captures the original network error class without formatting it into the failure", async () => {
    const socketFailure = new TypeError("socket closed")
    let observed: unknown
    const { streamCommandCode } = createTestDeps({
      fetchImpl: async () => {
        throw socketFailure
      },
    })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        onTerminalFailure: (failure) => {
          observed = failure
        },
      }),
    )

    assert.deepEqual(observed, {
      source: "generate",
      phase: "request",
      kind: "network",
    })
    const error = events.at(-1)
    assert.equal(error?.type, "error")
    if (error?.type !== "error") throw new Error("expected error")
    assert.equal(error.error.errorMessage, socketFailure.message)
  })

  it("does not await cancellation of an oversized cloned metadata body", async () => {
    let observed: unknown
    const oversized = new Uint8Array(64 * 1024 + 1)
    const { streamCommandCode } = createTestDeps({
      fetchImpl: async () => new Response(oversized, { status: 500 }),
    })

    const events = await within(
      collectEvents(
        streamCommandCode(makeModel(), makeContext(), {
          apiKey: TEST_API_KEY,
          forceMaxRetriesZero: true,
          onTerminalFailure: (failure) => {
            observed = failure
          },
        }),
      ),
    )

    assert.deepEqual(observed, {
      source: "generate",
      phase: "response",
      kind: "http",
      status: 500,
    })
    assert.equal(events.at(-1)?.type, "error")
  })

  it("bounds stalled metadata capture independently of the response body", async () => {
    let observed: unknown
    const { streamCommandCode } = createTestDeps({
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull: () => new Promise<void>(() => {}),
          }),
          { status: 500 },
        ),
    })

    const events = await within(
      collectEvents(
        streamCommandCode(makeModel(), makeContext(), {
          apiKey: TEST_API_KEY,
          forceMaxRetriesZero: true,
          timeoutMs: 20,
          onTerminalFailure: (failure) => {
            observed = failure
          },
        }),
      ),
    )

    assert.deepEqual(observed, {
      source: "generate",
      phase: "response",
      kind: "abort",
      abortOrigin: "runtime-timeout",
    })
    assert.equal(events.at(-1)?.type, "error")
  })

  it("records an understood upstream stream reason before terminal capture", async () => {
    server.mockResponse({
      type: "success",
      events: [
        JSON.stringify({
          type: "finish",
          finishReason: "stop",
          rawFinishReason: "upstream_error",
        }),
      ],
    })
    let observed: unknown
    const { streamCommandCode } = createTestDeps({
      apiBase: server.baseUrl(),
    })

    await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        onTerminalFailure: (failure) => {
          observed = failure
        },
      }),
    )

    assert.deepEqual(observed, {
      source: "generate",
      phase: "stream",
      kind: "stream",
      streamReason: "upstream-connection",
    })
  })

  it("records a truncated stream reason before terminal capture", async () => {
    server.mockResponse({ type: "success", events: [] })
    let observed: unknown
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        onTerminalFailure: (failure) => {
          observed = failure
        },
      }),
    )

    assert.deepEqual(observed, {
      source: "generate",
      phase: "stream",
      kind: "stream",
      streamReason: "truncated",
    })
  })
})

describe("streamCommandCode — retry on transient errors", () => {
  it("retries on 429 and succeeds on the second attempt", async () => {
    server.mockResponseQueue([
      { type: "error", status: 429, body: "rate limited" },
      {
        type: "success",
        events: [
          JSON.stringify({ type: "text-delta", text: "ok" }),
          JSON.stringify({ type: "finish", finishReason: "stop" }),
        ],
      },
    ])
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        maxRetries: 2,
      }),
    )

    assert.equal(server.requestCount(), 2)
    assert.deepEqual(eventTypes(events), ["start", "text_start", "text_delta", "text_end", "done"])
    const done = events.at(-1)
    if (done?.type !== "done") throw new Error("expected done")
    assert.equal(done.reason, "stop")
  })

  it("retries on 500 and succeeds on the second attempt", async () => {
    server.mockResponseQueue([
      { type: "error", status: 500, body: "internal server error" },
      {
        type: "success",
        events: [JSON.stringify({ type: "finish", finishReason: "stop" })],
      },
    ])
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        maxRetries: 2,
      }),
    )

    assert.equal(server.requestCount(), 2)
    assert.equal(events.at(-1)?.type, "done")
  })

  it("does NOT retry on 400 (non-retryable client error)", async () => {
    server.mockResponse({ type: "error", status: 400, body: "bad request" })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), { apiKey: TEST_API_KEY }),
    )

    assert.equal(server.requestCount(), 1)
    assert.deepEqual(eventTypes(events), ["start", "error"])
    const last = events.at(-1)
    if (last?.type !== "error") throw new Error("expected error")
    assert.match(last.error.errorMessage ?? "", /400/)
  })

  it("exhausts maxRetries and emits an error", async () => {
    server.mockResponse({ type: "error", status: 503, body: "unavailable" })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        maxRetries: 3,
      }),
    )

    // initial attempt + 3 retries = 4 total
    assert.equal(server.requestCount(), 4)
    assert.deepEqual(eventTypes(events), ["start", "error"])
    const last503 = events.at(-1)
    if (last503?.type !== "error") throw new Error("expected error")
    assert.match(last503.error.errorMessage ?? "", /503/)
  })
})

describe("streamCommandCode — forced coordinator attempt budget", () => {
  it("skips retry delay and cap rewriting when the coordinator forces zero retries", async () => {
    server.mockResponse({
      type: "error",
      status: 429,
      body: "rate limited",
      headers: { "retry-after": "3600" },
    })
    let delayCalls = 0
    let observed: unknown
    const { streamCommandCode } = createTestDeps({
      apiBase: server.baseUrl(),
      delay: async () => {
        delayCalls += 1
      },
    })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        maxRetries: 4,
        maxRetryDelayMs: 10,
        forceMaxRetriesZero: true,
        onTerminalFailure: (failure) => {
          observed = failure
        },
      }),
    )

    assert.equal(server.requestCount(), 1)
    assert.equal(delayCalls, 0)
    assert.deepEqual(observed, {
      source: "generate",
      phase: "response",
      kind: "http",
      status: 429,
      retryAfterMs: 3_600_000,
    })
    const error = events.at(-1)
    assert.equal(error?.type, "error")
    if (error?.type !== "error") throw new Error("expected error")
    assert.doesNotMatch(error.error.errorMessage ?? "", /exceeds max/)
  })
})

describe("streamCommandCode — Retry-After header", () => {
  it("respects Retry-After delay in seconds", async () => {
    let delayCalled = false
    server.mockResponseQueue([
      {
        type: "error",
        status: 429,
        body: "rate limited",
        headers: { "retry-after": "2" },
      },
      {
        type: "success",
        events: [JSON.stringify({ type: "finish", finishReason: "stop" })],
      },
    ])
    const { streamCommandCode } = createTestDeps({
      apiBase: server.baseUrl(),
      delay: async (ms: number) => {
        delayCalled = true
        assert.equal(ms, 2000)
      },
    })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        maxRetries: 2,
      }),
    )

    assert.equal(server.requestCount(), 2)
    assert.equal(events.at(-1)?.type, "done")
    assert.ok(delayCalled, "delay should have been called with Retry-After value")
  })

  it("fails immediately when Retry-After exceeds maxRetryDelayMs", async () => {
    server.mockResponse({
      type: "error",
      status: 429,
      body: "rate limited",
      headers: { "retry-after": "300" },
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        maxRetryDelayMs: 10_000,
      }),
    )

    assert.equal(server.requestCount(), 1)
    assert.deepEqual(eventTypes(events), ["start", "error"])
    const lastMax = events.at(-1)
    if (lastMax?.type !== "error") throw new Error("expected error")
    assert.match(lastMax.error.errorMessage ?? "", /exceeds max/)
  })

  it("does not cap Retry-After when maxRetryDelayMs is 0", async () => {
    let delayCalled = false
    server.mockResponseQueue([
      {
        type: "error",
        status: 429,
        body: "rate limited",
        headers: { "retry-after": "120" },
      },
      {
        type: "success",
        events: [JSON.stringify({ type: "finish", finishReason: "stop" })],
      },
    ])
    const { streamCommandCode } = createTestDeps({
      apiBase: server.baseUrl(),
      delay: async (ms: number) => {
        delayCalled = true
        assert.equal(ms, 120_000)
      },
    })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        maxRetries: 1,
        maxRetryDelayMs: 0,
      }),
    )

    assert.equal(server.requestCount(), 2)
    assert.equal(events.at(-1)?.type, "done")
    assert.ok(delayCalled)
  })
})

describe("streamCommandCode — timeout", () => {
  it("retries on per-attempt timeout and succeeds", async () => {
    server.mockResponseQueue([
      {
        type: "success",
        events: [JSON.stringify({ type: "finish", finishReason: "stop" })],
        hangAfterLast: true,
        responseDelay: 200,
      },
      {
        type: "success",
        events: [
          JSON.stringify({ type: "text-delta", text: "fast" }),
          JSON.stringify({ type: "finish", finishReason: "stop" }),
        ],
      },
    ])
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        timeoutMs: 50,
        maxRetries: 2,
      }),
      5_000,
    )

    assert.equal(server.requestCount(), 2)
    assert.deepEqual(eventTypes(events), ["start", "text_start", "text_delta", "text_end", "done"])
  })

  it("retries when the response starts but the stream hangs before finish", async () => {
    server.mockResponseQueue([
      {
        type: "success",
        events: [],
        hangAfterLast: true,
      },
      {
        type: "success",
        events: [
          JSON.stringify({ type: "text-delta", text: "ok" }),
          JSON.stringify({ type: "finish", finishReason: "stop" }),
        ],
      },
    ])
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        timeoutMs: 50,
        maxRetries: 2,
      }),
      5_000,
    )

    assert.equal(server.requestCount(), 2)
    assert.deepEqual(eventTypes(events), ["start", "text_start", "text_delta", "text_end", "done"])
  })

  it("does NOT retry on timeout after partial text-delta was emitted", async () => {
    server.mockResponse({
      type: "success",
      events: [JSON.stringify({ type: "text-delta", text: "partial" })],
      hangAfterLast: true,
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        timeoutMs: 50,
        maxRetries: 2,
      }),
      5_000,
    )

    assert.equal(server.requestCount(), 1)
    assert.deepEqual(eventTypes(events), ["start", "text_start", "text_delta", "error"])
  })

  it("emits error when all retry attempts time out", async () => {
    server.mockResponse({
      type: "success",
      events: [JSON.stringify({ type: "finish", finishReason: "stop" })],
      hangAfterLast: true,
      responseDelay: 200,
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        timeoutMs: 50,
        maxRetries: 1,
      }),
      5_000,
    )

    // initial + 1 retry = 2
    assert.equal(server.requestCount(), 2)
    assert.deepEqual(eventTypes(events), ["start", "error"])
    const error = events.at(-1)
    if (error?.type !== "error") throw new Error("expected error")
    assert.match(error.error.errorMessage ?? "", /timed out after 50ms/)
  })
})

describe("streamCommandCode — abort cancels retry loop", () => {
  it("user abort stops retries immediately", async () => {
    server.mockResponse({ type: "error", status: 500, body: "error" })
    const controller = new AbortController()
    const { streamCommandCode } = createTestDeps({
      apiBase: server.baseUrl(),
      delay: async (_ms: number, signal: AbortSignal) => {
        // Abort during the retry delay
        controller.abort()
        // Simulate the real delay which rejects on abort
        return new Promise<void>((_, reject) => {
          if (signal.aborted) reject(new DOMException("Aborted", "AbortError"))
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))
        })
      },
    })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        signal: controller.signal,
        maxRetries: 10,
      }),
    )

    // Should only have made 1 request (the initial one), then aborted during delay
    assert.equal(server.requestCount(), 1)
    assert.deepEqual(eventTypes(events), ["start", "error"])
    const error = events.at(-1)
    if (error?.type !== "error") throw new Error("expected error")
    assert.equal(error.reason, "aborted")
  })

  it("reports caller cancellation instead of the failed retry attempt", async () => {
    server.mockResponse({ type: "error", status: 500, body: "error" })
    const controller = new AbortController()
    let observed: unknown
    const { streamCommandCode } = createTestDeps({
      apiBase: server.baseUrl(),
      delay: async (_ms: number, signal: AbortSignal) => {
        controller.abort()
        if (!signal.aborted) throw new Error("expected caller signal to abort the delay")
        throw new DOMException("Aborted", "AbortError")
      },
    })

    await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        signal: controller.signal,
        maxRetries: 1,
        onTerminalFailure: (failure) => {
          observed = failure
        },
      }),
    )

    assert.deepEqual(observed, {
      source: "generate",
      phase: "request",
      kind: "abort",
      abortOrigin: "caller",
    })
  })
})

describe("streamCommandCode — retry defaults", () => {
  it("uses default maxRetries of 0 when not specified", async () => {
    server.mockResponse({ type: "error", status: 500, body: "error" })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    await collectEvents(streamCommandCode(makeModel(), makeContext(), { apiKey: TEST_API_KEY }))

    assert.equal(server.requestCount(), 1)
  })

  it("respects maxRetries: 0 (no retries)", async () => {
    server.mockResponse({ type: "error", status: 500, body: "error" })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        maxRetries: 0,
      }),
    )

    assert.equal(server.requestCount(), 1)
    assert.deepEqual(eventTypes(events), ["start", "error"])
  })
})

describe("streamCommandCode — stream-level error retry", () => {
  it("retries when API returns 200 OK but stream contains an error event", async () => {
    server.mockResponseQueue([
      {
        type: "success",
        events: [
          JSON.stringify({
            type: "error",
            error: "Service temporarily unavailable. Please try again shortly.",
          }),
        ],
      },
      {
        type: "success",
        events: [
          JSON.stringify({ type: "text-delta", text: "ok" }),
          JSON.stringify({ type: "finish", finishReason: "stop" }),
        ],
      },
    ])
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        maxRetries: 2,
      }),
    )

    assert.equal(server.requestCount(), 2)
    assert.deepEqual(eventTypes(events), ["start", "text_start", "text_delta", "text_end", "done"])
  })

  it("exhausts retries on persistent stream-level errors", async () => {
    server.mockResponse({
      type: "success",
      events: [
        JSON.stringify({
          type: "error",
          error: "Service temporarily unavailable. Please try again shortly.",
        }),
      ],
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        maxRetries: 3,
      }),
    )

    // initial + 3 retries = 4
    assert.equal(server.requestCount(), 4)
    assert.deepEqual(eventTypes(events), ["start", "error"])
    const last = events.at(-1)
    if (last?.type !== "error") throw new Error("expected error")
    assert.match(last.error.errorMessage ?? "", /temporarily unavailable/)
  })

  it("does NOT retry stream error when content was already emitted", async () => {
    server.mockResponseQueue([
      {
        type: "success",
        events: [
          JSON.stringify({ type: "text-delta", text: "partial" }),
          JSON.stringify({
            type: "error",
            error: "Service temporarily unavailable",
          }),
        ],
      },
    ])
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), { apiKey: TEST_API_KEY }),
    )

    // Only 1 request — no retry because content was already emitted.
    assert.equal(server.requestCount(), 1)
    assert.deepEqual(eventTypes(events), ["start", "text_start", "text_delta", "error"])
  })
})
