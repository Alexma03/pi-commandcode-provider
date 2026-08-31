import type { AccountService } from "./accounts.ts"
import { getConfiguredApiKey } from "./api-key.ts"
import { pickCommandCodeApiKey } from "./converters.ts"
import { fetchCommandCodeQuota, redactValue } from "./quota.ts"
import { formatQuota } from "./quota-format.ts"

export interface QuotaCommandContext {
  waitForIdle?: () => Promise<void>
  modelRegistry?: {
    getApiKeyForProvider?: (provider: string) => Promise<string | undefined>
  }
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void
  }
}

interface QuotaCommandApi {
  registerCommand(
    name: string,
    options: {
      description: string
      handler: (args: string, ctx: QuotaCommandContext) => Promise<void>
    },
  ): void
}

interface RegisterQuotaCommandOptions {
  apiBase: string
  headers?: Record<string, string>
  getConfiguredKey?: () => string | undefined
  fetchQuota?: typeof fetchCommandCodeQuota
  accountService?: Pick<AccountService, "mode" | "listStatus" | "refreshQuota">
}

const ACCOUNT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function registerCommandCodeQuota(
  pi: QuotaCommandApi,
  options: RegisterQuotaCommandOptions,
): void {
  const getConfiguredKey = options.getConfiguredKey ?? getConfiguredApiKey
  const fetchQuota = options.fetchQuota ?? fetchCommandCodeQuota

  pi.registerCommand("commandcode-quota", {
    description: "Show Command Code account usage and quota",
    handler: async (args, ctx) => {
      await ctx.waitForIdle?.()

      if (options.accountService) {
        let mode
        try {
          mode = await options.accountService.mode()
        } catch {
          ctx.ui.notify("Command Code account pool is unavailable.", "error")
          return
        }

        if (mode.kind === "unavailable") {
          ctx.ui.notify("Command Code account pool is unavailable.", "error")
          return
        }
        if (mode.kind === "pool") {
          let accounts
          try {
            accounts = await options.accountService.listStatus()
          } catch {
            ctx.ui.notify("Command Code account pool is unavailable.", "error")
            return
          }

          const requested = args.trim()
          if (requested && !ACCOUNT_ID_PATTERN.test(requested)) {
            ctx.ui.notify("A full Command Code account ID is required.", "error")
            return
          }
          const account = requested
            ? accounts.find((candidate) => candidate.id === requested)
            : accounts.find((candidate) => candidate.primary)
          if (!account) {
            ctx.ui.notify(
              requested
                ? "Unknown Command Code account."
                : "No primary Command Code account is configured.",
              "error",
            )
            return
          }

          try {
            const result = await options.accountService.refreshQuota(account.id)
            if (!result.ok) {
              ctx.ui.notify(redactValue(result.error.message), "error")
              return
            }
            ctx.ui.notify(redactValue(formatQuota(result.quota)), "info")
          } catch {
            ctx.ui.notify("Could not fetch Command Code quota.", "error")
          }
          return
        }
      }

      const registryKey = await ctx.modelRegistry?.getApiKeyForProvider?.("commandcode")
      const apiKey = pickCommandCodeApiKey(registryKey, getConfiguredKey())
      if (!apiKey) {
        ctx.ui.notify(
          "Command Code quota requires an API key. Run /login and select Command Code, or set COMMAND_CODE_API_KEY.",
          "warning",
        )
        return
      }

      const result = await fetchQuota({
        apiKey,
        baseUrl: options.apiBase,
        extraHeaders: options.headers,
      })
      if (!result.ok) {
        ctx.ui.notify(redactValue(result.error.message), "error")
        return
      }
      ctx.ui.notify(redactValue(formatQuota(result.quota)), "info")
    },
  })
}
