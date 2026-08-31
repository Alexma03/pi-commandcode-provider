import { redactCommandCodeErrorText } from "./overflow.ts"
import type {
  AbortOrigin,
  AssistantMessageEvent,
  AssistantMessageEventStreamLike,
  ContextLike,
  ModelLike,
  StreamOptions,
  TransportFailure,
} from "./types.ts"

export type CommandCodeTransport = "unknown" | "provider" | "generate"

export interface TransportDependencies {
  createStream: () => AssistantMessageEventStreamLike
  streamProvider: (
    model: ModelLike,
    context: ContextLike,
    options?: StreamOptions,
  ) => AssistantMessageEventStreamLike
  streamGenerate: (
    model: ModelLike,
    context: ContextLike,
    options?: StreamOptions,
  ) => AssistantMessageEventStreamLike
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const MAX_NATIVE_CAPTURE_BODY_BYTES = 64 * 1024
const NATIVE_CAPTURE_BODY_READ_TIMEOUT_MS = 100
const MAX_MACHINE_FIELD_LENGTH = 128

function machineField(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_MACHINE_FIELD_LENGTH) {
    return undefined
  }
  if (
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0)
      return code <= 31 || code === 127
    })
  ) {
    return undefined
  }
  return value
}

function machineFields(value: unknown): Pick<TransportFailure, "providerCode" | "providerType"> {
  if (!isRecord(value)) return {}
  const nested = isRecord(value.error) ? value.error : undefined
  const code = machineField(nested?.code ?? value.code)
  const type = machineField(nested?.type ?? value.type)
  return {
    ...(code ? { providerCode: code } : {}),
    ...(type ? { providerType: type } : {}),
  }
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    const milliseconds = seconds * 1000
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined
  }
  const date = Date.parse(value)
  if (Number.isNaN(date)) return undefined
  const milliseconds = Math.max(0, date - Date.now())
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined
}

function readBeforeDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  deadline: number,
): Promise<ReadableStreamReadResult<Uint8Array> | undefined> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) return Promise.resolve(undefined)
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      resolve(undefined)
    }, remaining)
    void reader.read().then(
      (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

async function readBoundedText(response: Response): Promise<string | undefined> {
  const reader = response.body?.getReader()
  if (!reader) return ""

  let bytes = 0
  let text = ""
  const decoder = new TextDecoder()
  const deadline = Date.now() + NATIVE_CAPTURE_BODY_READ_TIMEOUT_MS
  try {
    for (;;) {
      const result = await readBeforeDeadline(reader, deadline)
      if (!result) {
        void reader.cancel().catch(() => {})
        return undefined
      }
      const { done, value } = result
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_NATIVE_CAPTURE_BODY_BYTES) {
        void reader.cancel().catch(() => {})
        return undefined
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // The cloned body may already be closed.
    }
  }
}

async function responseMachineFields(
  response: Response,
): Promise<Pick<TransportFailure, "providerCode" | "providerType">> {
  try {
    const text = await readBoundedText(response.clone())
    if (!text) return {}
    return machineFields(JSON.parse(text))
  } catch {
    return {}
  }
}

async function isUpgradeRequired(response: Response): Promise<boolean> {
  if (response.status !== 403) return false

  try {
    const body: unknown = JSON.parse((await readBoundedText(response.clone())) ?? "")
    if (!isRecord(body)) return false
    const error = isRecord(body.error) ? body.error : body
    return error.code === "upgrade_required"
  } catch {
    return false
  }
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key] = value
  })
  return out
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
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

function terminalErrorEvent(model: ModelLike, error: unknown): AssistantMessageEvent {
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
      errorMessage: redactCommandCodeErrorText(
        error instanceof Error ? error.message : String(error),
      ),
      timestamp: Date.now(),
    },
  }
}

interface NativeCapture {
  failure?: TransportFailure
  callerAborted: boolean
  abortOrigin?: AbortOrigin
}

export function createCommandCodeTransportRouter(deps: TransportDependencies) {
  let transport: CommandCodeTransport = "unknown"
  let apiKey: string | undefined

  function pipe(
    source: AssistantMessageEventStreamLike,
    target: AssistantMessageEventStreamLike,
  ): Promise<void> {
    return (async () => {
      for await (const event of source) target.push(redactedEvent(event))
    })()
  }

  return {
    getTransport(): CommandCodeTransport {
      return transport
    },

    reset(): void {
      transport = "unknown"
      apiKey = undefined
    },

    stream(
      model: ModelLike,
      context: ContextLike,
      options?: StreamOptions,
    ): AssistantMessageEventStreamLike {
      if (options?.apiKey !== apiKey) {
        apiKey = options?.apiKey
        transport = "unknown"
      }
      const requestApiKey = options?.apiKey
      const forceMaxRetriesZero = options?.forceMaxRetriesZero === true
      const requestOptions = forceMaxRetriesZero ? { ...options, maxRetries: 0 } : options
      if (transport === "generate") return deps.streamGenerate(model, context, requestOptions)

      const output = deps.createStream()
      const callerSignal = options?.signal
      const capture: NativeCapture = {
        callerAborted: Boolean(callerSignal?.aborted),
        ...(callerSignal?.aborted ? { abortOrigin: "caller" as const } : {}),
      }
      const providerSignalCleanups: Array<() => void> = []
      let upgradeRequired = false
      let terminalFailureNotified = false
      const fetchImpl = options?.fetch ?? fetch

      const abortFailure = (phase: TransportFailure["phase"]): TransportFailure => ({
        source: "native",
        phase,
        kind: "abort",
        abortOrigin:
          capture.abortOrigin ??
          (capture.callerAborted || callerSignal?.aborted ? "caller" : "caller"),
      })
      const noteCallerAbort = () => {
        capture.callerAborted = true
        if (!capture.abortOrigin) capture.abortOrigin = "caller"
        capture.failure = abortFailure("request")
      }
      const noteRuntimeAbort = () => {
        if (!capture.callerAborted && !capture.abortOrigin) {
          capture.abortOrigin = "runtime-abort"
          capture.failure = abortFailure("request")
        }
      }
      const observeProviderSignal = (signal: AbortSignal | undefined) => {
        if (!signal) return
        if (signal === callerSignal) {
          if (signal.aborted) noteCallerAbort()
          return
        }
        if (signal.aborted) noteRuntimeAbort()
        const onAbort = () => noteRuntimeAbort()
        signal.addEventListener("abort", onAbort, { once: true })
        providerSignalCleanups.push(() => signal.removeEventListener("abort", onAbort))
      }
      const notifyTerminalFailure = async (failure: TransportFailure): Promise<void> => {
        if (terminalFailureNotified) return
        terminalFailureNotified = true
        try {
          await options?.onTerminalFailure?.(failure)
        } catch {
          // A diagnostic hook must not change transport behavior.
        }
      }
      const captureNativeBodyFailure = (error: unknown): void => {
        if (capture.abortOrigin === "caller" || capture.callerAborted || callerSignal?.aborted) {
          capture.failure = abortFailure("stream")
        } else if (capture.abortOrigin === "runtime-abort") {
          capture.failure = abortFailure("stream")
        } else if (isAbortError(error)) {
          capture.failure = abortFailure("stream")
        } else {
          capture.failure = {
            source: "native",
            phase: "stream",
            kind: "network",
            streamReason: "upstream-connection",
          }
        }
      }
      const wrapResponseBody = (response: Response): Response => {
        if (!response.body) return response
        const reader = response.body.getReader()
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const { done, value } = await reader.read()
              if (done) controller.close()
              else controller.enqueue(value)
            } catch (error: unknown) {
              captureNativeBodyFailure(error)
              controller.error(error)
            }
          },
          async cancel(reason) {
            await reader.cancel(reason)
          },
        })
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      }
      const nativeFetch = async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        observeProviderSignal(init?.signal ?? undefined)
        try {
          const response = await fetchImpl(input, init)
          if (!response.ok) {
            capture.failure = {
              source: "native",
              phase: "response",
              kind: "http",
              status: response.status,
              ...(parseRetryAfterMs(response.headers.get("retry-after")) !== undefined
                ? { retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")) }
                : {}),
              ...(await responseMachineFields(response)),
            }
          }
          if (await isUpgradeRequired(response)) upgradeRequired = true
          return wrapResponseBody(response)
        } catch (error: unknown) {
          if (capture.abortOrigin === "caller" || capture.callerAborted || callerSignal?.aborted) {
            capture.failure = abortFailure("request")
          } else if (capture.abortOrigin === "runtime-abort" || init?.signal?.aborted) {
            capture.failure = abortFailure("request")
          } else if (isAbortError(error)) {
            capture.failure = abortFailure("request")
          } else {
            capture.failure = { source: "native", phase: "request", kind: "network" }
          }
          throw error
        }
      }

      const providerOptions: StreamOptions = {
        ...requestOptions,
        onTerminalFailure: undefined,
        fetch: nativeFetch,
        onResponse: async (response, responseModel) => {
          if (upgradeRequired) return
          await options?.onResponse?.(response, responseModel)
        },
      }

      if (callerSignal) {
        if (callerSignal.aborted) noteCallerAbort()
        else callerSignal.addEventListener("abort", noteCallerAbort, { once: true })
      }

      const failureFromEvent = (
        event: Extract<AssistantMessageEvent, { type: "error" }>,
      ): TransportFailure => {
        if (capture.failure) return capture.failure
        if (event.reason === "aborted") return abortFailure("stream")
        return {
          source: "native",
          phase: "stream",
          kind: "stream",
          ...machineFields(event.error),
        }
      }
      const failureFromThrown = (error: unknown): TransportFailure => {
        if (capture.failure) return capture.failure
        if (isAbortError(error)) return abortFailure("stream")
        return { source: "native", phase: "stream", kind: "unknown" }
      }

      const run = async () => {
        try {
          let providerStream: AssistantMessageEventStreamLike | undefined
          try {
            providerStream = deps.streamProvider(model, context, providerOptions)
            for await (const event of providerStream) {
              if (upgradeRequired) continue
              if (event.type === "error") {
                await notifyTerminalFailure(failureFromEvent(event))
              }
              if (apiKey === requestApiKey) transport = "provider"
              output.push(redactedEvent(event))
            }
          } catch (error: unknown) {
            if (!upgradeRequired) throw error
          }

          if (upgradeRequired) {
            if (apiKey === requestApiKey) transport = "generate"
            await pipe(deps.streamGenerate(model, context, requestOptions), output)
          }
          output.end()
        } catch (error: unknown) {
          if (!upgradeRequired) await notifyTerminalFailure(failureFromThrown(error))
          output.push(terminalErrorEvent(model, error))
          output.end()
        } finally {
          callerSignal?.removeEventListener("abort", noteCallerAbort)
          for (const cleanup of providerSignalCleanups) cleanup()
        }
      }

      run().catch(async (error: unknown) => {
        await notifyTerminalFailure(failureFromThrown(error))
        output.push(terminalErrorEvent(model, error))
        output.end()
      })

      return output
    },
  }
}

export type CommandCodeTransportRouter = ReturnType<typeof createCommandCodeTransportRouter>

export interface CommandCodeTransportRegistry {
  forAccount(accountId: string, apiKey?: string): CommandCodeTransportRouter
  stream(
    accountId: string,
    model: ModelLike,
    context: ContextLike,
    options?: StreamOptions,
  ): AssistantMessageEventStreamLike
  reset(accountId: string): void
}

/**
 * Keeps transport detection state isolated by stable account id. The registry
 * is deliberately not used by the legacy entry point; WU 6 decides when pool
 * routing is enabled.
 */
export function createCommandCodeTransportRegistry(
  deps: TransportDependencies,
): CommandCodeTransportRegistry {
  const routers = new Map<string, CommandCodeTransportRouter>()
  const keys = new Map<string, string | undefined>()

  const forAccount = (accountId: string, apiKey?: string): CommandCodeTransportRouter => {
    let router = routers.get(accountId)
    if (!router) {
      router = createCommandCodeTransportRouter(deps)
      routers.set(accountId, router)
    }
    const previousKey = keys.get(accountId)
    if (apiKey !== undefined && previousKey !== undefined && previousKey !== apiKey) {
      router.reset()
    }
    if (apiKey !== undefined) keys.set(accountId, apiKey)
    return router
  }

  return {
    forAccount,
    stream(accountId, model, context, options) {
      const router = forAccount(accountId, options?.apiKey)
      return router.stream(model, context, options)
    },
    reset(accountId) {
      routers.get(accountId)?.reset()
      keys.delete(accountId)
    },
  }
}

export const createPerAccountTransportRegistry = createCommandCodeTransportRegistry
export const createAccountTransportRegistry = createCommandCodeTransportRegistry
