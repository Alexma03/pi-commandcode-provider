import { redactCommandCodeErrorText } from "./overflow.ts"
import type { AssistantMessageEvent, AssistantMessageLike, TransportFailure } from "./types.ts"

export type FailureClassification = "eligible-for-failover" | "never-failover"

const EXPLICIT_NON_ACCOUNT_CATEGORIES = new Set([
  "bad_request",
  "capability_error",
  "content_filter",
  "content_policy_violation",
  "context_length",
  "context_length_exceeded",
  "context_overflow",
  "invalid_request",
  "invalid_request_error",
  "policy_error",
  "request_error",
  "schema_error",
  "tool_error",
  "transport_not_supported",
  "unsupported_api",
  "unsupported_transport",
  "upgrade_required",
])

function hasExplicitNonAccountCategory(failure: TransportFailure): boolean {
  return [failure.providerCode, failure.providerType].some(
    (value) => value !== undefined && EXPLICIT_NON_ACCOUNT_CATEGORIES.has(value.toLowerCase()),
  )
}

function hasValidShape(failure: TransportFailure): boolean {
  if (
    (failure.source !== "generate" && failure.source !== "native") ||
    (failure.phase !== "payload" &&
      failure.phase !== "request" &&
      failure.phase !== "response" &&
      failure.phase !== "stream") ||
    (failure.kind !== "http" &&
      failure.kind !== "network" &&
      failure.kind !== "abort" &&
      failure.kind !== "stream" &&
      failure.kind !== "unknown")
  ) {
    return false
  }

  if (failure.abortOrigin !== undefined && failure.kind !== "abort") return false
  if (
    failure.abortOrigin !== undefined &&
    failure.abortOrigin !== "caller" &&
    failure.abortOrigin !== "runtime-timeout" &&
    failure.abortOrigin !== "runtime-abort"
  ) {
    return false
  }
  if (
    failure.streamReason !== undefined &&
    !(
      failure.phase === "stream" &&
      (failure.kind === "stream" || failure.kind === "network") &&
      (failure.streamReason === "upstream-connection" || failure.streamReason === "truncated")
    )
  ) {
    return false
  }
  if (
    failure.status !== undefined &&
    !(failure.kind === "http" && failure.phase === "response" && Number.isInteger(failure.status))
  ) {
    return false
  }
  if (
    failure.retryAfterMs !== undefined &&
    !(
      failure.kind === "http" &&
      failure.phase === "response" &&
      Number.isSafeInteger(failure.retryAfterMs) &&
      failure.retryAfterMs >= 0
    )
  ) {
    return false
  }

  if (failure.kind === "http") {
    return (
      failure.phase === "response" &&
      failure.status !== undefined &&
      failure.status >= 100 &&
      failure.status <= 599
    )
  }
  if (failure.kind === "stream") {
    return (
      failure.phase === "stream" &&
      (failure.streamReason === "upstream-connection" || failure.streamReason === "truncated")
    )
  }
  if (failure.kind === "abort") {
    return (
      failure.status === undefined &&
      failure.retryAfterMs === undefined &&
      failure.streamReason === undefined
    )
  }
  return failure.status === undefined && failure.retryAfterMs === undefined
}

function isResponseHttpFailure(failure: TransportFailure): boolean {
  if (
    !hasValidShape(failure) ||
    failure.kind !== "http" ||
    failure.phase !== "response" ||
    failure.status === undefined
  ) {
    return false
  }
  return (
    failure.status === 408 ||
    failure.status === 429 ||
    (failure.status >= 500 && failure.status <= 599)
  )
}

function isAccountScopedAuthFailure(failure: TransportFailure): boolean {
  return (
    failure.source === "generate" &&
    failure.phase === "response" &&
    failure.kind === "http" &&
    (failure.status === 401 || failure.status === 403) &&
    !hasExplicitNonAccountCategory(failure)
  )
}

function isKnownConnectionFailure(failure: TransportFailure): boolean {
  return (
    (failure.kind === "network" &&
      failure.status === undefined &&
      (failure.phase === "request" ||
        failure.phase === "response" ||
        failure.phase === "stream")) ||
    (failure.kind === "stream" &&
      failure.status === undefined &&
      failure.phase === "stream" &&
      (failure.streamReason === "upstream-connection" || failure.streamReason === "truncated"))
  )
}

export function classifyFailure(failure: TransportFailure): FailureClassification {
  if (!hasValidShape(failure)) return "never-failover"
  if (failure.abortOrigin === "caller") return "never-failover"

  if (failure.kind === "abort") {
    return failure.abortOrigin === "runtime-timeout" || failure.abortOrigin === "runtime-abort"
      ? "eligible-for-failover"
      : "never-failover"
  }

  if (isResponseHttpFailure(failure) || isKnownConnectionFailure(failure)) {
    return "eligible-for-failover"
  }

  if (isAccountScopedAuthFailure(failure)) return "eligible-for-failover"

  return "never-failover"
}

export interface FailoverStreamDependencies {
  readonly accounts: Pick<
    import("./accounts.ts").AccountService,
    "mode" | "planLogicalRequest" | "isStillConfigured" | "recordEligibleFailure" | "recordSuccess"
  >
  readonly createStream: () => import("./types.ts").AssistantMessageEventStreamLike
  readonly streamAccount: (
    account: import("./accounts.ts").AccountAttempt | undefined,
    model: import("./types.ts").ModelLike,
    context: import("./types.ts").ContextLike,
    options?: import("./types.ts").StreamOptions,
  ) => import("./types.ts").AssistantMessageEventStreamLike
  readonly streamLegacy?: (
    model: import("./types.ts").ModelLike,
    context: import("./types.ts").ContextLike,
    options?: import("./types.ts").StreamOptions,
  ) => import("./types.ts").AssistantMessageEventStreamLike
  readonly classify?: (failure: TransportFailure) => FailureClassification
  readonly now?: () => number
}

export type FailoverStreamFactory = (
  model: import("./types.ts").ModelLike,
  context: import("./types.ts").ContextLike,
  options?: import("./types.ts").StreamOptions,
) => import("./types.ts").AssistantMessageEventStreamLike

interface BufferedAttempt {
  readonly events: AssistantMessageEvent[]
  readonly startedAt: number
  readonly failure?: TransportFailure
  readonly terminal?: Extract<AssistantMessageEvent, { type: "error" }>
  readonly thrown?: unknown
}

interface AttemptResult {
  readonly kind: "success" | "failure" | "caller"
  readonly buffered: readonly AssistantMessageEvent[]
  readonly startedAt: number
  readonly committed: boolean
  readonly terminalForwarded: boolean
  readonly failure?: TransportFailure
  readonly terminal?: Extract<AssistantMessageEvent, { type: "error" }>
  readonly thrown?: unknown
}

function isContentBoundary(event: AssistantMessageEvent): boolean {
  return (
    event.type === "thinking_start" ||
    event.type === "text_start" ||
    event.type === "toolcall_start"
  )
}

function redactedEvent(event: AssistantMessageEvent): AssistantMessageEvent {
  if (event.type !== "error") return event
  return {
    ...event,
    error: {
      ...event.error,
      ...(event.error.errorMessage
        ? { errorMessage: redactCommandCodeErrorText(event.error.errorMessage) }
        : {}),
    },
  }
}

function emptyMessage(model: import("./types.ts").ModelLike): AssistantMessageLike {
  return {
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
    timestamp: Date.now(),
  }
}

function terminalErrorEvent(
  model: import("./types.ts").ModelLike,
  error: unknown,
  aborted = false,
): Extract<AssistantMessageEvent, { type: "error" }> {
  const message = aborted
    ? "Request aborted"
    : redactCommandCodeErrorText(error instanceof Error ? error.message : String(error))
  return {
    type: "error",
    reason: aborted ? "aborted" : "error",
    error: { ...emptyMessage(model), errorMessage: message },
  }
}

function partialFromEvent(
  event: AssistantMessageEvent | undefined,
): AssistantMessageLike | undefined {
  if (!event) return undefined
  if ("partial" in event) return event.partial
  if (event.type === "done") return event.message
  if (event.type === "error") return event.error
  return undefined
}

function commitBuffer(
  output: import("./types.ts").AssistantMessageEventStreamLike,
  events: readonly AssistantMessageEvent[],
  model: import("./types.ts").ModelLike,
  fallback?: AssistantMessageEvent,
): void {
  const start = events.find((event) => event.type === "start")
  const partial = partialFromEvent(start ?? fallback ?? events[0]) ?? emptyMessage(model)
  output.push(
    redactedEvent(
      start ?? {
        type: "start",
        partial,
      },
    ),
  )
  for (const event of events) {
    if (event.type === "start") continue
    output.push(redactedEvent(event))
  }
}

function failureFor(
  captured: TransportFailure | undefined,
  event: AssistantMessageEvent | undefined,
  thrown: unknown,
  signal: AbortSignal | undefined,
): TransportFailure {
  if (captured) return captured
  if (signal?.aborted || (event?.type === "error" && event.reason === "aborted")) {
    return { source: "generate", phase: "stream", kind: "abort", abortOrigin: "caller" }
  }
  if (thrown instanceof Error && thrown.name === "AbortError") {
    return { source: "generate", phase: "stream", kind: "abort", abortOrigin: "caller" }
  }
  return { source: "generate", phase: "stream", kind: "unknown" }
}

function isCallerFailure(failure: TransportFailure): boolean {
  return failure.abortOrigin === "caller"
}

function safeClassification(
  classify: ((failure: TransportFailure) => FailureClassification) | undefined,
  failure: TransportFailure,
): FailureClassification {
  try {
    return (classify ?? classifyFailure)(failure)
  } catch {
    return "never-failover"
  }
}

async function closeAttemptIterator(iterator: AsyncIterator<AssistantMessageEvent>): Promise<void> {
  try {
    await iterator.return?.()
  } catch {
    // Attempt cleanup is best effort; the coordinator still owns the next step.
  }
}

async function consumeAttempt(
  source: import("./types.ts").AssistantMessageEventStreamLike,
  output: import("./types.ts").AssistantMessageEventStreamLike,
  model: import("./types.ts").ModelLike,
  signal: AbortSignal | undefined,
  startedAt: number,
  getFailure: () => TransportFailure | undefined,
): Promise<AttemptResult> {
  const iterator = source[Symbol.asyncIterator]()
  const buffered: AssistantMessageEvent[] = []
  let committed = false
  let terminalForwarded = false
  let capturedFailure = getFailure()
  let resolveCallerAbort: (() => void) | undefined
  const callerAbort = signal
    ? new Promise<"caller">((resolve) => {
        resolveCallerAbort = () => resolve("caller")
      })
    : undefined
  const onCallerAbort = () => resolveCallerAbort?.()
  if (signal) {
    if (signal.aborted) onCallerAbort()
    else signal.addEventListener("abort", onCallerAbort, { once: true })
  }

  try {
    for (;;) {
      let nextResult: IteratorResult<AssistantMessageEvent>
      try {
        const nextPromise = iterator.next()
        const raced = callerAbort
          ? await Promise.race([nextPromise, callerAbort])
          : await nextPromise
        if (raced === "caller") {
          void nextPromise.catch(() => {})
          void closeAttemptIterator(iterator)
          const failure = failureFor(capturedFailure, undefined, undefined, signal)
          const terminal = terminalErrorEvent(model, failure, true)
          if (committed) {
            output.push(terminal)
            terminalForwarded = true
          }
          return {
            kind: "caller",
            buffered,
            startedAt,
            committed,
            terminalForwarded,
            failure,
            terminal: committed ? undefined : terminal,
          }
        }
        nextResult = raced
      } catch (error: unknown) {
        const failure = failureFor(capturedFailure, undefined, error, signal)
        const terminal = terminalErrorEvent(model, error, isCallerFailure(failure))
        if (committed) {
          output.push(terminal)
          terminalForwarded = true
        }
        await closeAttemptIterator(iterator)
        return {
          kind: isCallerFailure(failure) ? "caller" : "failure",
          buffered,
          startedAt,
          committed,
          terminalForwarded,
          failure,
          terminal: committed ? undefined : terminal,
          thrown: error,
        }
      }

      if (nextResult.done) {
        const failure = failureFor(capturedFailure, undefined, undefined, signal)
        const terminal = terminalErrorEvent(
          model,
          new Error("Command Code stream ended unexpectedly"),
        )
        if (committed) {
          output.push(terminal)
          terminalForwarded = true
        }
        await closeAttemptIterator(iterator)
        return {
          kind: isCallerFailure(failure) ? "caller" : "failure",
          buffered,
          startedAt,
          committed,
          terminalForwarded,
          failure,
          terminal: committed ? undefined : terminal,
        }
      }

      const event = nextResult.value
      capturedFailure = getFailure() ?? capturedFailure
      if (!committed) {
        buffered.push(event)
        if (isContentBoundary(event)) {
          commitBuffer(output, buffered, model)
          committed = true
        }
        if (event.type === "done") {
          await closeAttemptIterator(iterator)
          return { kind: "success", buffered, startedAt, committed, terminalForwarded }
        }
        if (event.type === "error") {
          const failure = failureFor(capturedFailure, event, undefined, signal)
          await closeAttemptIterator(iterator)
          return {
            kind: isCallerFailure(failure) ? "caller" : "failure",
            buffered,
            startedAt,
            committed,
            terminalForwarded,
            failure,
            terminal: event,
          }
        }
      } else {
        if (event.type === "start") continue
        output.push(redactedEvent(event))
        if (event.type === "done") {
          await closeAttemptIterator(iterator)
          return { kind: "success", buffered, startedAt, committed, terminalForwarded }
        }
        if (event.type === "error") {
          const failure = failureFor(capturedFailure, event, undefined, signal)
          terminalForwarded = true
          await closeAttemptIterator(iterator)
          return {
            kind: isCallerFailure(failure) ? "caller" : "failure",
            buffered,
            startedAt,
            committed,
            terminalForwarded,
            failure,
            terminal: event,
          }
        }
      }
    }
  } finally {
    signal?.removeEventListener("abort", onCallerAbort)
  }
}

function unavailableEvent(
  model: import("./types.ts").ModelLike,
  retryAt: number | undefined,
): Extract<AssistantMessageEvent, { type: "error" }> {
  const suffix = retryAt === undefined ? "" : ` Retry after ${new Date(retryAt).toISOString()}.`
  return terminalErrorEvent(model, `No Command Code account is currently available.${suffix}`)
}

function createFailoverStreamFor(
  deps: FailoverStreamDependencies,
  model: import("./types.ts").ModelLike,
  context: import("./types.ts").ContextLike,
  options?: import("./types.ts").StreamOptions,
): import("./types.ts").AssistantMessageEventStreamLike {
  const output = deps.createStream()
  const now = deps.now ?? Date.now

  const finish = () => {
    output.end()
  }

  const run = async (): Promise<void> => {
    let mode: import("./accounts.ts").AccountMode
    try {
      mode = await deps.accounts.mode()
    } catch {
      output.push(unavailableEvent(model, undefined))
      finish()
      return
    }

    if (mode.kind === "legacy") {
      try {
        const source = deps.streamLegacy
          ? deps.streamLegacy(model, context, options)
          : deps.streamAccount(undefined, model, context, options)
        for await (const event of source) output.push(event)
      } catch (error: unknown) {
        output.push(terminalErrorEvent(model, error, options?.signal?.aborted))
      } finally {
        finish()
      }
      return
    }

    if (mode.kind === "unavailable") {
      output.push(unavailableEvent(model, undefined))
      finish()
      return
    }

    let plan: import("./accounts.ts").LogicalRequestPlan
    try {
      plan = await deps.accounts.planLogicalRequest()
    } catch {
      output.push(unavailableEvent(model, undefined))
      finish()
      return
    }

    if (plan.attempts.length === 0) {
      output.push(unavailableEvent(model, plan.unavailableUntil))
      finish()
      return
    }

    const tried = new Set<string>()
    let lastEligible: BufferedAttempt | undefined

    for (const account of plan.attempts) {
      if (tried.has(account.id)) continue
      const stillConfigured = await deps.accounts.isStillConfigured(account.id, plan.revision)
      if (!stillConfigured) continue
      tried.add(account.id)
      const startedAt = now()
      let capturedFailure: TransportFailure | undefined
      const attemptOptions: import("./types.ts").StreamOptions = {
        ...options,
        apiKey: account.apiKey,
        maxRetries: 0,
        forceMaxRetriesZero: true,
        onTerminalFailure: async (failure) => {
          capturedFailure ??= failure
          await options?.onTerminalFailure?.(failure)
        },
      }

      let source: import("./types.ts").AssistantMessageEventStreamLike
      try {
        source = deps.streamAccount(account, model, context, attemptOptions)
      } catch (error: unknown) {
        const failure = failureFor(capturedFailure, undefined, error, options?.signal)
        const result: AttemptResult = {
          kind: isCallerFailure(failure) ? "caller" : "failure",
          buffered: [],
          startedAt,
          committed: false,
          terminalForwarded: false,
          failure,
          thrown: error,
          terminal: terminalErrorEvent(model, error, isCallerFailure(failure)),
        }
        if (result.kind === "caller") {
          output.push(result.terminal!)
          finish()
          return
        }
        const classification = safeClassification(deps.classify, failure)
        if (classification === "eligible-for-failover") {
          lastEligible = { events: [], startedAt, failure, thrown: error }
          try {
            await deps.accounts.recordEligibleFailure(account.id, failure)
          } catch {
            output.push(result.terminal!)
            finish()
            return
          }
          continue
        }
        output.push(result.terminal!)
        finish()
        return
      }

      const result = await consumeAttempt(
        source,
        output,
        model,
        options?.signal,
        startedAt,
        () => capturedFailure,
      )

      if (result.kind === "success") {
        if (!result.committed) commitBuffer(output, result.buffered, model)
        await deps.accounts.recordSuccess(account.id, startedAt)
        finish()
        return
      }

      if (result.committed) {
        finish()
        return
      }

      const failure =
        result.failure ?? failureFor(undefined, result.terminal, result.thrown, options?.signal)
      if (result.kind === "caller" || isCallerFailure(failure)) {
        commitBuffer(output, result.buffered, model)
        if (result.terminal && !result.buffered.includes(result.terminal)) {
          output.push(redactedEvent(result.terminal))
        } else if (!result.terminal) {
          output.push(terminalErrorEvent(model, result.thrown, true))
        }
        finish()
        return
      }

      const classification = safeClassification(deps.classify, failure)
      if (classification === "eligible-for-failover") {
        lastEligible = {
          events: [...result.buffered],
          startedAt,
          failure,
          ...(result.terminal ? { terminal: result.terminal } : {}),
          ...(result.thrown !== undefined ? { thrown: result.thrown } : {}),
        }
        try {
          await deps.accounts.recordEligibleFailure(account.id, failure)
        } catch {
          commitBuffer(output, result.buffered, model)
          if (!result.terminal) output.push(terminalErrorEvent(model, result.thrown))
          finish()
          return
        }
        continue
      }

      commitBuffer(output, result.buffered, model)
      if (!result.terminal) output.push(terminalErrorEvent(model, result.thrown))
      finish()
      return
    }

    if (lastEligible) {
      commitBuffer(output, lastEligible.events, model)
      if (!lastEligible.terminal) output.push(terminalErrorEvent(model, lastEligible.thrown))
    } else {
      output.push(unavailableEvent(model, plan.unavailableUntil))
    }
    finish()
  }

  void run().catch((error: unknown) => {
    output.push(terminalErrorEvent(model, error, options?.signal?.aborted))
    finish()
  })
  return output
}

export function createFailoverStream(deps: FailoverStreamDependencies): FailoverStreamFactory
export function createFailoverStream(
  deps: FailoverStreamDependencies,
  model: import("./types.ts").ModelLike,
  context: import("./types.ts").ContextLike,
  options?: import("./types.ts").StreamOptions,
): import("./types.ts").AssistantMessageEventStreamLike
export function createFailoverStream(
  deps: FailoverStreamDependencies,
  model?: import("./types.ts").ModelLike,
  context?: import("./types.ts").ContextLike,
  options?: import("./types.ts").StreamOptions,
): FailoverStreamFactory | import("./types.ts").AssistantMessageEventStreamLike {
  const factory: FailoverStreamFactory = (nextModel, nextContext, nextOptions) =>
    createFailoverStreamFor(deps, nextModel, nextContext, nextOptions)
  if (model === undefined || context === undefined) return factory
  return factory(model, context, options)
}
