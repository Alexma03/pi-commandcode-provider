import type { AccountPublicView, AccountService, AccountStatusView } from "./accounts.ts"
import {
  acquireCommandCodeAccount,
  type AcquiredCommandCodeAccount,
  type OAuthLoginCallbacks,
} from "./oauth.ts"
import { redactDiagnosticText } from "./runtime.ts"

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface AccountCommandContext {
  readonly ui: {
    input(title: string, placeholder?: string): Promise<string | undefined>
    select(title: string, options: string[]): Promise<string | undefined>
    confirm(title: string, message: string): Promise<boolean>
    notify(message: string, type?: "info" | "warning" | "error"): void
  }
  waitForIdle?: () => Promise<void>
}

export interface AccountCommandApi {
  registerCommand(
    name: string,
    options: {
      description: string
      handler: (args: string, context: AccountCommandContext) => Promise<void>
    },
  ): void
}

export interface RegisterAccountCommandsOptions {
  readonly service: AccountService
  readonly acquireAccount?: (callbacks: OAuthLoginCallbacks) => Promise<AcquiredCommandCodeAccount>
}

function outputLabel(label: string): string {
  return redactDiagnosticText(label)
}

function optionFor(account: AccountPublicView): string {
  return `${account.order}. ${outputLabel(account.label)} (${account.id})${account.primary ? " [primary]" : ""}`
}

function statusLineFor(account: AccountStatusView): string {
  const health = account.health === "probe-due" ? "probe due" : account.health
  const state = [
    account.primary ? "primary" : undefined,
    account.active ? "active (process-local)" : undefined,
    health,
    account.retryAfter === undefined ? undefined : `cooldown ${account.retryAfter}ms`,
    account.quotaSnapshotAge === undefined
      ? undefined
      : `quota snapshot age ${account.quotaSnapshotAge}ms`,
  ].filter((item): item is string => item !== undefined)
  return `${account.order}. ${outputLabel(account.label)} (${account.id}) [${state.join(", ")}]`
}

async function selectedAccount(
  service: AccountService,
  context: AccountCommandContext,
  title: string,
  argument: string,
): Promise<AccountPublicView | undefined> {
  const accounts = await service.listStatus()
  if (accounts.length === 0) {
    context.ui.notify("No Command Code accounts are configured.", "warning")
    return undefined
  }

  const requested = argument.trim()
  if (requested) {
    if (!UUID_PATTERN.test(requested)) {
      context.ui.notify("A full Command Code account ID is required.", "error")
      return undefined
    }
    const account = accounts.find((candidate) => candidate.id === requested)
    if (!account) {
      context.ui.notify("Unknown Command Code account.", "error")
      return undefined
    }
    return account
  }

  const options = accounts.map(optionFor)
  const selection = await context.ui.select(title, options)
  if (!selection) {
    context.ui.notify("Account selection cancelled.", "warning")
    return undefined
  }
  const index = options.indexOf(selection)
  if (index < 0) {
    context.ui.notify("The selected account is no longer available.", "error")
    return undefined
  }
  return accounts[index]
}

function commandError(context: AccountCommandContext, message: string): void {
  context.ui.notify(message, "error")
}

export function registerCommandCodeAccountCommands(
  api: AccountCommandApi,
  options: RegisterAccountCommandsOptions,
): void {
  const acquireAccount = options.acquireAccount ?? acquireCommandCodeAccount

  api.registerCommand("commandcode-account-add", {
    description: "Add a validated Command Code account",
    handler: async (args, context) => {
      if (args.trim()) {
        commandError(
          context,
          "This command accepts credentials only through its interactive prompt.",
        )
        return
      }
      await context.waitForIdle?.()
      try {
        const callbacks: OAuthLoginCallbacks = {
          onAuth: ({ url }) =>
            context.ui.notify(`Open this Command Code authorization URL: ${url}`, "info"),
          onPrompt: async ({ message }) => (await context.ui.input(message)) ?? "",
        }
        const account = await options.service.add(await acquireAccount(callbacks))
        context.ui.notify(
          `Added Command Code account ${outputLabel(account.label)} (${account.id}).`,
          "info",
        )
      } catch {
        commandError(context, "Could not add the Command Code account.")
      }
    },
  })

  api.registerCommand("commandcode-accounts", {
    description: "List configured Command Code accounts",
    handler: async (_args, context) => {
      try {
        const accounts = await options.service.listStatus()
        if (accounts.length === 0) {
          context.ui.notify("No Command Code accounts are configured.", "info")
          return
        }
        context.ui.notify(accounts.map(statusLineFor).join("\n"), "info")
      } catch {
        commandError(context, "Command Code account state is unavailable.")
      }
    },
  })

  api.registerCommand("commandcode-account-remove", {
    description: "Remove a Command Code account",
    handler: async (args, context) => {
      try {
        const account = await selectedAccount(options.service, context, "Remove account", args)
        if (!account) return
        const confirmed = await context.ui.confirm(
          "Remove Command Code account",
          `Remove ${outputLabel(account.label)} (${account.id})?`,
        )
        if (!confirmed) {
          context.ui.notify("Account removal cancelled.", "warning")
          return
        }
        await context.waitForIdle?.()
        await options.service.remove(account.id)
        context.ui.notify(
          `Removed Command Code account ${outputLabel(account.label)} (${account.id}).`,
          "info",
        )
      } catch {
        commandError(context, "Could not remove the Command Code account.")
      }
    },
  })

  api.registerCommand("commandcode-account-primary", {
    description: "Set the primary Command Code account",
    handler: async (args, context) => {
      try {
        const account = await selectedAccount(
          options.service,
          context,
          "Select primary account",
          args,
        )
        if (!account) return
        await context.waitForIdle?.()
        await options.service.setPrimary(account.id)
        context.ui.notify(
          `Primary Command Code account is now ${outputLabel(account.label)} (${account.id}).`,
          "info",
        )
      } catch {
        commandError(context, "Could not set the primary Command Code account.")
      }
    },
  })
}
