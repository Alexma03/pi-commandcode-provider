import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { classifyFailure, type FailureClassification } from "../src/failover.ts"
import type { TransportFailure } from "../src/types.ts"

const baseFailure: TransportFailure = {
  source: "generate",
  phase: "response",
  kind: "unknown",
}

function classification(failure: TransportFailure): FailureClassification {
  return classifyFailure(failure)
}

describe("classifyFailure — closed structured signal table", () => {
  it("allows exactly the verified HTTP, network, runtime-abort, and account-auth classes", () => {
    const eligible: Array<[string, TransportFailure]> = [
      ["HTTP 408", { ...baseFailure, kind: "http", status: 408 }],
      ["HTTP 429", { ...baseFailure, kind: "http", status: 429 }],
      ["HTTP 500", { ...baseFailure, kind: "http", status: 500 }],
      ["HTTP 599", { ...baseFailure, kind: "http", status: 599 }],
      ["generate connection failure", { ...baseFailure, phase: "request", kind: "network" }],
      ["native stream network failure", { source: "native", phase: "stream", kind: "network" }],
      ["runtime timeout", { ...baseFailure, kind: "abort", abortOrigin: "runtime-timeout" }],
      ["runtime abort", { ...baseFailure, kind: "abort", abortOrigin: "runtime-abort" }],
      ["account HTTP 401", { ...baseFailure, kind: "http", status: 401 }],
      ["account HTTP 403", { ...baseFailure, kind: "http", status: 403 }],
      [
        "recognized account authentication error",
        {
          ...baseFailure,
          kind: "http",
          status: 403,
          providerType: "authentication_error",
        },
      ],
      [
        "known upstream stream connection",
        { ...baseFailure, phase: "stream", kind: "stream", streamReason: "upstream-connection" },
      ],
      [
        "known truncated stream",
        { ...baseFailure, phase: "stream", kind: "stream", streamReason: "truncated" },
      ],
    ]

    for (const [name, failure] of eligible) {
      assert.equal(classification(failure), "eligible-for-failover", name)
    }
  })

  it("rejects caller cancellation, generic errors, and unrecognized combinations", () => {
    const ineligible: Array<[string, TransportFailure]> = [
      ["caller abort", { ...baseFailure, kind: "abort", abortOrigin: "caller" }],
      [
        "network caller cancellation",
        { ...baseFailure, phase: "request", kind: "network", abortOrigin: "caller" },
      ],
      ["HTTP 400", { ...baseFailure, kind: "http", status: 400 }],
      ["HTTP 404", { ...baseFailure, kind: "http", status: 404 }],
      [
        "HTTP 401 from native API",
        { source: "native", kind: "http", status: 401, phase: "response" },
      ],
      [
        "HTTP 403 after request phase",
        { ...baseFailure, kind: "http", status: 403, phase: "request" },
      ],
      [
        "HTTP 403 policy category",
        { ...baseFailure, kind: "http", status: 403, providerType: "policy_error" },
      ],
      [
        "HTTP 403 content category",
        { ...baseFailure, kind: "http", status: 403, providerCode: "content_filter" },
      ],
      [
        "HTTP 403 transport capability category",
        { ...baseFailure, kind: "http", status: 403, providerCode: "upgrade_required" },
      ],
      [
        "HTTP 401 request category",
        { ...baseFailure, kind: "http", status: 401, providerType: "invalid_request_error" },
      ],
      [
        "HTTP 401 schema category",
        { ...baseFailure, kind: "http", status: 401, providerCode: "schema_error" },
      ],
      [
        "HTTP 503 outside response phase",
        { ...baseFailure, kind: "http", status: 503, phase: "request" },
      ],
      [
        "HTTP failure with runtime abort provenance",
        { ...baseFailure, kind: "http", status: 429, abortOrigin: "runtime-timeout" },
      ],
      [
        "network failure with runtime abort provenance",
        { ...baseFailure, phase: "request", kind: "network", abortOrigin: "runtime-abort" },
      ],
      [
        "HTTP failure with stream provenance",
        { ...baseFailure, kind: "http", status: 429, streamReason: "truncated" },
      ],
      [
        "negative retry-after metadata",
        { ...baseFailure, kind: "http", status: 429, retryAfterMs: -1 },
      ],
      ["payload failure", { ...baseFailure, phase: "payload", kind: "unknown" }],
      [
        "schema failure",
        { ...baseFailure, phase: "request", kind: "unknown", providerCode: "schema_error" },
      ],
      ["context overflow", { ...baseFailure, kind: "unknown", providerType: "context_length" }],
      ["tool failure", { ...baseFailure, kind: "unknown", providerCode: "tool_error" }],
      ["policy failure", { ...baseFailure, kind: "unknown", providerType: "policy_error" }],
      ["unknown stream", { ...baseFailure, phase: "stream", kind: "stream" }],
      [
        "unrecognized stream reason",
        { ...baseFailure, phase: "stream", kind: "stream", streamReason: undefined },
      ],
      ["abort without provenance", { ...baseFailure, kind: "abort" }],
      ["HTTP plus network kind", { ...baseFailure, kind: "network", status: 429 }],
    ]

    for (const [name, failure] of ineligible) {
      assert.equal(classification(failure), "never-failover", name)
    }
  })

  it("defaults unknown and body/message-shaped inputs to never-failover", () => {
    assert.equal(
      classifyFailure({ source: "generate", phase: "request", kind: "unknown" }),
      "never-failover",
    )

    const messageShaped = classifyFailure({
      source: "generate",
      phase: "response",
      kind: "unknown",
      // @ts-expect-error TransportFailure intentionally has no user-facing message.
      message: "quota exceeded",
      rawBody: '{"code":"quota"}',
    })
    assert.equal(messageShaped, "never-failover")
  })
})
