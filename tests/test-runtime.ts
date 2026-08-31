import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  createCommandCodeRuntime,
  type CommandCodeCommandContext,
  type CommandCodeRuntimeApi,
} from "../src/runtime.ts"
import type { CommandCodeModel, LoadCommandCodeModelsResult } from "../src/models.ts"
import type { AccountService, AccountStatusView } from "../src/accounts.ts"

type ProviderConfig = {
  models: readonly CommandCodeModel[]
}

class ExtensionAPITestDouble implements CommandCodeRuntimeApi<ProviderConfig, CommandContext> {
  readonly providers: ProviderConfig[] = []
  readonly commands = new Map<string, (args: string, ctx: CommandContext) => Promise<void> | void>()

  registerProvider(_name: string, config: ProviderConfig): void {
    this.providers.push(config)
  }

  registerCommand(
    name: string,
    options: {
      description: string
      handler: (args: string, ctx: CommandContext) => Promise<void> | void
    },
  ): void {
    this.commands.set(name, options.handler)
  }
}

class CommandContext implements CommandCodeCommandContext {
  readonly notifications: Array<{ message: string; type?: "info" | "warning" | "error" }> = []
  waitForIdleCalls = 0

  readonly ui = {
    notify: (message: string, type?: "info" | "warning" | "error") => {
      this.notifications.push({ message, type })
    },
  }

  async waitForIdle(): Promise<void> {
    this.waitForIdleCalls += 1
  }
}

const FIRST_MODEL: CommandCodeModel = {
  id: "first-model",
  name: "First Model",
  api: "openai-completions",
  reasoning: true,
  contextWindow: 128_000,
  maxTokens: 16_384,
}

const SECOND_MODEL: CommandCodeModel = {
  id: "second-model",
  name: "Second Model",
  api: "openai-completions",
  reasoning: true,
  contextWindow: 256_000,
  maxTokens: 32_768,
}

function loaded(
  models: readonly CommandCodeModel[],
  source: LoadCommandCodeModelsResult["source"] = "live",
  warning?: string,
): LoadCommandCodeModelsResult {
  return warning ? { models, source, warning } : { models, source }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
} {
  let resolvePromise: (value: T) => void = () => {}
  let rejectPromise: (error: unknown) => void = () => {}
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

describe("Command Code runtime", () => {
  it("registers refresh and status commands and exposes redacted state", async () => {
    const pi = new ExtensionAPITestDouble()
    const context = new CommandContext()
    let now = 1_700_000_000_000
    const firstLoad = deferred<LoadCommandCodeModelsResult>()

    const runtime = createCommandCodeRuntime(pi, {
      endpoint: "https://api.commandcode.ai/provider/v1/models?token=user_secret_value",
      cachePath: "/tmp/commandcode-models.json",
      loadModels: () => firstLoad.promise,
      createProviderConfig: (models) => ({ models }),
      getTransport: () => "provider",
      now: () => now,
      logWarning: () => {},
    })

    const initialization = runtime.initialize()
    assert.deepEqual([...pi.commands.keys()], ["commandcode-refresh", "commandcode-status"])
    assert.equal(runtime.getStatus().refreshing, true)
    assert.equal(runtime.getStatus().lastAttempt, now)

    firstLoad.resolve(loaded([FIRST_MODEL]))
    await initialization
    now += 1_000

    const statusCommand = pi.commands.get("commandcode-status")
    assert.ok(statusCommand)
    await statusCommand("", context)
    const statusMessage = context.notifications.at(-1)?.message ?? ""
    assert.match(statusMessage, /transport: provider/)
    assert.match(statusMessage, /source: live/)
    assert.match(statusMessage, /model count: 1/)
    assert.match(statusMessage, /last success:/)
    assert.match(statusMessage, /last attempt:/)
    assert.match(statusMessage, /cache path: \/tmp\/commandcode-models\.json/)
    assert.match(statusMessage, /endpoint: https:\/\/api\.commandcode\.ai\/provider\/v1\/models/)
    assert.doesNotMatch(statusMessage, /token=user_secret_value/)
    assert.doesNotMatch(statusMessage, /user_secret_value/)
  })

  it("appends a redacted pool summary and coordination warning to status", async () => {
    const pi = new ExtensionAPITestDouble()
    const context = new CommandContext()
    let shutdowns = 0
    const accountRows: readonly AccountStatusView[] = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        label: "primary",
        order: 1,
        primary: true,
        active: true,
        health: "healthy",
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        label: "fallback",
        order: 2,
        primary: false,
        active: false,
        health: "cooling",
        retryAfter: 2_000,
        quotaSnapshotAge: 4_000,
      },
    ]
    const accounts = {
      mode: async () => ({ kind: "pool" as const, revision: 3 }),
      listStatus: async () => accountRows,
      shutdown: async () => {
        shutdowns += 1
      },
    } satisfies Pick<AccountService, "mode" | "listStatus" | "shutdown">
    const runtime = createCommandCodeRuntime(pi, {
      endpoint: "https://api.commandcode.ai/provider/v1/models",
      cachePath: "/tmp/commandcode-models.json",
      loadModels: async () => loaded([FIRST_MODEL]),
      createProviderConfig: (models) => ({ models }),
      accountService: accounts,
      getCoordinationWarning: () => "shared coordination is unavailable",
    })

    await runtime.initialize()
    const statusCommand = pi.commands.get("commandcode-status")
    assert.ok(statusCommand)
    await statusCommand("", context)
    const message = context.notifications.at(-1)?.message ?? ""
    assert.match(message, /account summary: 2 configured/)
    assert.match(message, /active markers are process-local/)
    assert.match(message, /coordination warning: shared coordination is unavailable/)
    assert.doesNotMatch(message, /11111111|22222222|fallback/)

    await runtime.shutdown()
    assert.equal(shutdowns, 1)
  })

  it("reports legacy and unavailable account modes without exposing unavailable details", async () => {
    const pi = new ExtensionAPITestDouble()
    const context = new CommandContext()
    let mode: "legacy" | "unavailable" = "legacy"
    const accounts = {
      mode: async () =>
        mode === "legacy"
          ? ({ kind: "legacy" as const } satisfies { kind: "legacy" })
          : ({
              kind: "unavailable" as const,
              message: "private account state unavailable",
            } satisfies {
              kind: "unavailable"
              message: string
            }),
      listStatus: async () => [],
      shutdown: async () => {},
    } satisfies Pick<AccountService, "mode" | "listStatus" | "shutdown">
    const runtime = createCommandCodeRuntime(pi, {
      endpoint: "https://api.commandcode.ai/provider/v1/models",
      cachePath: "/tmp/commandcode-models.json",
      loadModels: async () => loaded([FIRST_MODEL]),
      createProviderConfig: (models) => ({ models }),
      accountService: accounts,
    })

    await runtime.initialize()
    const statusCommand = pi.commands.get("commandcode-status")
    assert.ok(statusCommand)
    await statusCommand("", context)
    assert.match(context.notifications.at(-1)?.message ?? "", /account summary: legacy/)

    mode = "unavailable"
    await statusCommand("", context)
    const unavailable = context.notifications.at(-1)?.message ?? ""
    assert.match(unavailable, /account summary: unavailable/)
    assert.doesNotMatch(unavailable, /private account state unavailable/)
  })

  it("coalesces overlapping refreshes and preserves the current catalog on failure", async () => {
    const pi = new ExtensionAPITestDouble()
    const warnings: string[] = []
    const loads = [Promise.resolve(loaded([FIRST_MODEL])), deferred<LoadCommandCodeModelsResult>()]
    let loadCount = 0

    const runtime = createCommandCodeRuntime(pi, {
      endpoint: "https://api.commandcode.ai/provider/v1/models",
      cachePath: "/tmp/commandcode-models.json",
      loadModels: () => {
        const next = loads[loadCount]
        loadCount += 1
        if (!next) throw new Error("unexpected refresh")
        return next instanceof Promise ? next : next.promise
      },
      createProviderConfig: (models) => ({ models }),
      logWarning: (warning) => warnings.push(warning),
    })

    await runtime.initialize()
    assert.equal(pi.providers.length, 1)
    assert.deepEqual(pi.providers[0]?.models, [FIRST_MODEL])

    const pending = loads[1]
    assert.ok(!(pending instanceof Promise))
    const firstRefresh = runtime.refresh()
    const secondRefresh = runtime.refresh()
    assert.strictEqual(firstRefresh, secondRefresh)
    assert.equal(runtime.getStatus().refreshing, true)

    pending.reject(new Error("request failed with apiKey=user_secret_value"))
    const result = await firstRefresh

    assert.equal(result.refreshed, false)
    assert.equal(result.modelCount, 1)
    assert.equal(runtime.getStatus().modelCount, 1)
    assert.equal(runtime.getStatus().source, "live")
    assert.equal(pi.providers.length, 1)
    assert.equal(runtime.getStatus().refreshing, false)
    assert.match(runtime.getStatus().warning ?? "", /Could not refresh/)
    assert.doesNotMatch(runtime.getStatus().warning ?? "", /user_secret_value/)
    assert.doesNotMatch(warnings.join("\n"), /user_secret_value/)
  })

  it("runs the refresh command and reports the updated catalog", async () => {
    const pi = new ExtensionAPITestDouble()
    const context = new CommandContext()
    const results = [
      Promise.resolve(loaded([FIRST_MODEL])),
      Promise.resolve(loaded([FIRST_MODEL, SECOND_MODEL])),
    ]
    let index = 0

    const runtime = createCommandCodeRuntime(pi, {
      endpoint: "https://api.commandcode.ai/provider/v1/models",
      cachePath: "/tmp/commandcode-models.json",
      loadModels: () => {
        const result = results[index]
        index += 1
        if (!result) throw new Error("unexpected refresh")
        return result
      },
      createProviderConfig: (models) => ({ models }),
      logWarning: () => {},
    })

    await runtime.initialize()
    const refreshCommand = pi.commands.get("commandcode-refresh")
    assert.ok(refreshCommand)
    await refreshCommand("", context)

    assert.equal(context.waitForIdleCalls, 1)
    assert.equal(context.notifications.at(-1)?.type, "info")
    assert.match(context.notifications.at(-1)?.message ?? "", /2 models from live/)
    assert.deepEqual(pi.providers.at(-1)?.models, [FIRST_MODEL, SECOND_MODEL])
  })

  it("installs a cached catalog after an initially empty start", async () => {
    const pi = new ExtensionAPITestDouble()
    const results = [
      Promise.resolve(loaded([], "empty", "offline")),
      Promise.resolve(loaded([SECOND_MODEL], "cache")),
    ]
    let index = 0

    const runtime = createCommandCodeRuntime(pi, {
      endpoint: "https://api.commandcode.ai/provider/v1/models",
      cachePath: "/tmp/commandcode-models.json",
      loadModels: () => {
        const result = results[index]
        index += 1
        if (!result) throw new Error("unexpected refresh")
        return result
      },
      createProviderConfig: (models) => ({ models }),
      logWarning: () => {},
    })

    await runtime.initialize()
    assert.equal(pi.providers.length, 1)
    assert.deepEqual(pi.providers[0]?.models, [])

    const result = await runtime.refresh()
    assert.equal(result.refreshed, true)
    assert.equal(result.source, "cache")
    assert.deepEqual(pi.providers.at(-1)?.models, [SECOND_MODEL])
    assert.equal(runtime.getStatus().modelCount, 1)
  })

  it("does not replace an existing provider with an empty failed catalog", async () => {
    const pi = new ExtensionAPITestDouble()
    const results = [
      Promise.resolve(loaded([FIRST_MODEL])),
      Promise.resolve(loaded([], "cache", "No valid catalog is available at /private/cache")),
      Promise.resolve(loaded([SECOND_MODEL])),
    ]
    let index = 0

    const runtime = createCommandCodeRuntime(pi, {
      endpoint: "http://127.0.0.1:1234/provider/v1/models",
      cachePath: "/private/cache",
      loadModels: () => {
        const result = results[index]
        index += 1
        if (!result) throw new Error("unexpected refresh")
        return result
      },
      createProviderConfig: (models) => ({ models }),
      logWarning: () => {},
    })

    await runtime.initialize()
    const refreshResult = await runtime.refresh()
    assert.equal(refreshResult.refreshed, false)
    assert.equal(pi.providers.length, 1)
    assert.deepEqual(pi.providers[0]?.models, [FIRST_MODEL])
    assert.equal(runtime.getStatus().modelCount, 1)
    assert.equal(runtime.getStatus().source, "live")

    await runtime.refresh()
    assert.equal(pi.providers.length, 2)
    assert.deepEqual(pi.providers[1]?.models, [SECOND_MODEL])
  })

  it("reports a failed initial refresh without leaking diagnostics", async () => {
    const pi = new ExtensionAPITestDouble()
    const context = new CommandContext()
    const runtime = createCommandCodeRuntime(pi, {
      endpoint: "https://api.commandcode.ai/provider/v1/models?api_key=user_initial_secret",
      cachePath: "/tmp/commandcode-models.json",
      loadModels: async () => {
        throw new Error("offline; api_key=user_initial_secret")
      },
      createProviderConfig: (models) => ({ models }),
      logWarning: () => {},
    })

    await runtime.initialize()
    const statusCommand = pi.commands.get("commandcode-status")
    assert.ok(statusCommand)
    await statusCommand("", context)
    const message = context.notifications.at(-1)?.message ?? ""
    assert.match(message, /source: empty/)
    assert.match(message, /model count: 0/)
    assert.match(message, /warning:/)
    assert.doesNotMatch(message, /user_initial_secret/)
  })
})
