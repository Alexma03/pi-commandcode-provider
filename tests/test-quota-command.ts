import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { registerCommandCodeQuota, type QuotaCommandContext } from "../src/quota-command.ts"
import type { AccountService, AccountStatusView } from "../src/accounts.ts"
import type { CommandCodeQuotaResult } from "../src/quota-types.ts"

class CommandApiDouble {
  handler?: (args: string, ctx: QuotaCommandContext) => Promise<void>

  registerCommand(
    name: string,
    options: {
      description: string
      handler: (args: string, ctx: QuotaCommandContext) => Promise<void>
    },
  ): void {
    assert.equal(name, "commandcode-quota")
    assert.match(options.description, /usage and quota/)
    this.handler = options.handler
  }
}

function context(registryKey: string | undefined) {
  const notifications: Array<{ message: string; type?: "info" | "warning" | "error" }> = []
  let waited = false
  const value = {
    async waitForIdle() {
      waited = true
    },
    modelRegistry: {
      async getApiKeyForProvider(provider: string) {
        assert.equal(provider, "commandcode")
        return registryKey
      },
    },
    ui: {
      notify(message: string, type?: "info" | "warning" | "error") {
        notifications.push({ message, type })
      },
    },
  } satisfies QuotaCommandContext
  return { value, notifications, waited: () => waited }
}

const quotaResult: CommandCodeQuotaResult = {
  ok: true,
  quota: {
    account: { login: "alice", orgId: null },
    credits: null,
    subscription: null,
    summary: { totalCost: 1, totalCount: 2 },
  },
}

describe("commandcode-quota command", () => {
  it("registers the command and resolves OMP placeholders through the fallback key", async () => {
    const pi = new CommandApiDouble()
    let requestKey = ""
    let requestBase = ""
    registerCommandCodeQuota(pi, {
      apiBase: "https://api.commandcode.ai",
      getConfiguredKey: () => "fallback-key",
      fetchQuota: async (options) => {
        requestKey = options.apiKey
        requestBase = options.baseUrl ?? ""
        return quotaResult
      },
    })

    assert.ok(pi.handler)
    const ctx = context("$COMMAND_CODE_API_KEY")
    await pi.handler("", ctx.value)
    assert.equal(ctx.waited(), true)
    assert.equal(requestKey, "fallback-key")
    assert.equal(requestBase, "https://api.commandcode.ai")
    assert.equal(ctx.notifications.at(-1)?.type, "info")
    assert.match(ctx.notifications.at(-1)?.message ?? "", /Requests: 2/)
  })

  it("selects the pool primary by default and an explicit opaque account id", async () => {
    const primaryId = "11111111-1111-4111-8111-111111111111"
    const fallbackId = "22222222-2222-4222-8222-222222222222"
    const rows: readonly AccountStatusView[] = [
      {
        id: primaryId,
        label: "primary",
        order: 1,
        primary: true,
        active: true,
        health: "healthy",
      },
      {
        id: fallbackId,
        label: "fallback",
        order: 2,
        primary: false,
        active: false,
        health: "healthy",
      },
    ]
    const selected: string[] = []
    const accountService = {
      mode: async () => ({ kind: "pool" as const, revision: 4 }),
      listStatus: async () => rows,
      refreshQuota: async (id: string) => {
        selected.push(id)
        return {
          ok: true as const,
          quota: quotaResult.quota,
          fetchedAt: 1_700_000_000_000,
          availability: "available" as const,
        }
      },
    } satisfies Pick<AccountService, "mode" | "listStatus" | "refreshQuota">
    const pi = new CommandApiDouble()
    let legacyFetches = 0
    registerCommandCodeQuota(pi, {
      apiBase: "https://api.commandcode.ai",
      accountService,
      fetchQuota: async () => {
        legacyFetches += 1
        return quotaResult
      },
    })

    assert.ok(pi.handler)
    const ctx = context("legacy-key")
    await pi.handler("", ctx.value)
    await pi.handler(fallbackId, ctx.value)

    assert.deepEqual(selected, [primaryId, fallbackId])
    assert.equal(legacyFetches, 0)
    assert.equal(ctx.notifications.at(-1)?.type, "info")
    assert.match(ctx.notifications.at(-1)?.message ?? "", /Requests: 2/)
  })

  it("rejects invalid pool ids and unavailable pool state without a legacy fallback", async () => {
    const primaryId = "11111111-1111-4111-8111-111111111111"
    let refreshed = 0
    const accountService = {
      mode: async () => ({
        kind: "unavailable" as const,
        message: "private account state is unavailable",
      }),
      listStatus: async () => [],
      refreshQuota: async (_id: string) => {
        refreshed += 1
        return {
          ok: false as const,
          error: { kind: "config", message: "unexpected" },
        }
      },
    } satisfies Pick<AccountService, "mode" | "listStatus" | "refreshQuota">
    const pi = new CommandApiDouble()
    let legacyFetches = 0
    registerCommandCodeQuota(pi, {
      apiBase: "https://api.commandcode.ai",
      accountService,
      fetchQuota: async () => {
        legacyFetches += 1
        return quotaResult
      },
    })

    assert.ok(pi.handler)
    const ctx = context("legacy-key")
    await pi.handler(primaryId, ctx.value)
    assert.equal(refreshed, 0)
    assert.equal(legacyFetches, 0)
    assert.equal(ctx.notifications.at(-1)?.type, "error")
    assert.doesNotMatch(
      ctx.notifications.at(-1)?.message ?? "",
      /private account state is unavailable/,
    )
    assert.doesNotMatch(ctx.notifications.at(-1)?.message ?? "", /legacy-key/)
  })

  it("warns without calling the endpoint when no API key is available", async () => {
    const pi = new CommandApiDouble()
    let called = false
    registerCommandCodeQuota(pi, {
      apiBase: "https://api.commandcode.ai",
      getConfiguredKey: () => undefined,
      fetchQuota: async () => {
        called = true
        return quotaResult
      },
    })

    assert.ok(pi.handler)
    const ctx = context(undefined)
    await pi.handler("", ctx.value)
    assert.equal(called, false)
    assert.equal(ctx.notifications.at(-1)?.type, "warning")
    assert.match(ctx.notifications.at(-1)?.message ?? "", /requires an API key/)
  })

  it("redacts endpoint failures before notifying the host", async () => {
    const pi = new CommandApiDouble()
    registerCommandCodeQuota(pi, {
      apiBase: "https://api.commandcode.ai",
      getConfiguredKey: () => "real-key",
      fetchQuota: async () => ({
        ok: false,
        error: { kind: "http", message: "api_key=supersecretvalue123456 failed" },
      }),
    })

    assert.ok(pi.handler)
    const ctx = context("real-key")
    await pi.handler("", ctx.value)
    assert.equal(ctx.notifications.at(-1)?.type, "error")
    assert.doesNotMatch(ctx.notifications.at(-1)?.message ?? "", /supersecret/)
  })
})
