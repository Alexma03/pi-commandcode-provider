/**
 * Abort tests against the real streamCommandCode core.
 */

import assert from "node:assert/strict"
import { after, before, beforeEach, describe, it } from "node:test"

import {
  collectEvents,
  createTestDeps,
  makeContext,
  makeModel,
  startMockCommandCodeServer,
  type MockCommandCodeServer,
} from "./helpers.ts"

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

describe("streamCommandCode — structured abort provenance", () => {
  it("records caller-signal identity as caller even before a runtime deadline", async () => {
    const caller = new AbortController()
    let observed: unknown
    const { streamCommandCode } = createTestDeps({
      fetchImpl: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("provider request aborted", "AbortError")),
            { once: true },
          )
          queueMicrotask(() => caller.abort())
        }),
    })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: "mock-key",
        signal: caller.signal,
        timeoutMs: 1_000,
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
    const terminal = events.at(-1)
    assert.equal(terminal?.type, "error")
    if (terminal?.type !== "error") throw new Error("expected error")
    assert.equal(terminal.reason, "aborted")
  })

  it("records a provider-request abort as runtime timeout while the caller signal stays open", async () => {
    const caller = new AbortController()
    let observed: unknown
    let providerSignal: AbortSignal | undefined
    const { streamCommandCode } = createTestDeps({
      fetchImpl: async (_input, init) => {
        providerSignal = init?.signal ?? undefined
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("provider deadline", "AbortError")),
            { once: true },
          )
        })
      },
    })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: "mock-key",
        signal: caller.signal,
        timeoutMs: 5,
        onTerminalFailure: (failure) => {
          observed = failure
        },
      }),
      1_000,
    )

    assert.ok(providerSignal)
    assert.notEqual(providerSignal, caller.signal)
    assert.equal(caller.signal.aborted, false)
    assert.deepEqual(observed, {
      source: "generate",
      phase: "request",
      kind: "abort",
      abortOrigin: "runtime-timeout",
    })
    assert.equal(events.at(-1)?.type, "error")
  })

  it("treats an upstream aborted event without runtime provenance as caller/unknown", async () => {
    server.mockResponse({
      type: "success",
      events: [JSON.stringify({ type: "abort" })],
    })
    let observed: unknown
    const { streamCommandCode } = createTestDeps({
      apiBase: server.baseUrl(),
    })

    await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: "mock-key",
        onTerminalFailure: (failure) => {
          observed = failure
        },
      }),
    )

    assert.deepEqual(observed, {
      source: "generate",
      phase: "stream",
      kind: "abort",
      abortOrigin: "caller",
    })
  })
})

describe("streamCommandCode — abort behavior", () => {
  it("emits aborted error when signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: "mock-key",
        signal: controller.signal,
      }),
    )

    assert.deepEqual(
      events.map((event) => event.type),
      ["start", "error"],
    )
    const error = events.at(-1)
    assert.equal(error?.type, "error")
    if (error?.type !== "error") throw new Error("expected error")
    assert.equal(error.reason, "aborted")
    assert.equal(error.error.stopReason, "aborted")
    assert.equal(server.requestCount(), 0)
  })

  it("emits aborted error and cancels the response reader mid-stream", async () => {
    server.mockResponse({
      type: "success",
      events: [JSON.stringify({ type: "text-delta", text: "first" })],
      hangAfterLast: true,
    })
    const controller = new AbortController()
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const stream = streamCommandCode(makeModel(), makeContext(), {
      apiKey: "mock-key",
      signal: controller.signal,
    })

    setTimeout(() => controller.abort(), 50)
    const events = await collectEvents(stream, 2_000)

    assert.ok(
      events.some((event) => event.type === "text_delta"),
      "stream should process data before abort",
    )
    const error = events.at(-1)
    assert.equal(error?.type, "error")
    if (error?.type !== "error") throw new Error("expected error")
    assert.equal(error.reason, "aborted")
    assert.equal(error.error.errorMessage, "Request aborted")
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.ok(server.responseClosedBeforeEnd(), "abort should close the hanging upstream response")
  })
})
