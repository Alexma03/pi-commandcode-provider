/**
 * Command Code provider for pi.
 *
 * Uses Command Code's documented Provider API:
 * https://api.commandcode.ai/provider/v1
 */

import { AssistantMessageEventStream } from "@earendil-works/pi-ai"
import { streamSimple as streamNativeProvider } from "@earendil-works/pi-ai/compat"
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ProviderConfig,
} from "@earendil-works/pi-coding-agent"
import { join } from "node:path"

import { getConfiguredApiKey } from "./src/api-key.ts"
import { createStreamCommandCode } from "./src/core.ts"
import { calculateCommandCodeCost } from "./src/cost.ts"
import { pickCommandCodeApiKey } from "./src/converters.ts"
import {
  baseUrlForModel,
  DEFAULT_MODELS_URL,
  DEFAULT_PROVIDER_API_BASE,
  getModelsTimeoutMs,
  inputModalitiesForModel,
  loadCommandCodeModels,
  thinkingMetadataForModel,
  type CommandCodeModel,
} from "./src/models.ts"
import { getApiKey as getOAuthApiKey, login, refreshToken } from "./src/oauth.ts"
import { normalizeCommandCodeMessage } from "./src/overflow.ts"
import { MODEL_COSTS, ZERO_MODEL_COST } from "./src/pricing.ts"
import { createCommandCodeRuntime } from "./src/runtime.ts"
import { fetchCommandCodeQuota, formatQuota, redactValue } from "./src/quota.ts"
import { createCommandCodeTransportRouter } from "./src/transport.ts"

const COMMAND_CODE_PROVIDER_ID = "commandcode"

async function resolveCommandCodeApiKey(ctx: ExtensionCommandContext): Promise<string | undefined> {
  const registryKey = await ctx.modelRegistry?.getApiKeyForProvider?.(COMMAND_CODE_PROVIDER_ID)
  // Mirror src/core.ts: OMP may surface an unresolved placeholder; fall back
  // to the env/auth-file resolver so we never send a literal placeholder as a
  // Bearer token (which caused a 401 on /alpha/whoami).
  return pickCommandCodeApiKey(registryKey, getConfiguredApiKey())
}

function commandCodeHeaders(): Record<string, string> | undefined {
  if (process.env.COMMANDCODE_ZDR === "1") {
    return { "x-cmd-zdr": "1" }
  }
  return undefined
}

function createProviderConfig(
  models: readonly CommandCodeModel[],
  apiBase: string,
  streamCommandCode: ProviderConfig["streamSimple"],
): ProviderConfig {
  const headers = commandCodeHeaders()
  return {
    name: "Command Code",
    baseUrl: apiBase,
    apiKey: getConfiguredApiKey() ?? "$COMMANDCODE_API_KEY",
    api: "openai-completions",
    streamSimple: streamCommandCode,
    headers,
    oauth: {
      name: "Command Code",
      login,
      refreshToken,
      getApiKey: getOAuthApiKey,
    },
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      api: model.api,
      baseUrl: baseUrlForModel(apiBase, model.api),
      reasoning: model.reasoning,
      ...(thinkingMetadataForModel(model.id) ?? {}),
      input: [...inputModalitiesForModel(model.id)],
      cost: MODEL_COSTS[model.id] ?? ZERO_MODEL_COST,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      headers,
      compat:
        model.api === "openai-completions"
          ? {
              supportsStore: false,
              supportsDeveloperRole: false,
              supportsReasoningEffort: true,
              maxTokensField: "max_tokens",
            }
          : {
              supportsEagerToolInputStreaming: false,
              supportsLongCacheRetention: false,
              supportsCacheControlOnTools: false,
              supportsToolReferences: false,
              ...(model.reasoning ? { forceAdaptiveThinking: true } : {}),
            },
    })),
  }
}

function legacyApiBase(providerApiBase: string): string {
  return providerApiBase.replace(/\/provider\/v1\/?$/, "")
}

export default async function (pi: ExtensionAPI) {
  const apiBase = process.env.COMMANDCODE_API_BASE ?? DEFAULT_PROVIDER_API_BASE
  const modelsUrl = process.env.COMMANDCODE_MODELS_URL ?? DEFAULT_MODELS_URL
  const modelsTimeoutMs = getModelsTimeoutMs()
  const modelsCachePath =
    process.env.COMMANDCODE_MODELS_CACHE ?? join(getAgentDir(), "commandcode-models.json")
  const streamGenerate = createStreamCommandCode({
    createStream: () => new AssistantMessageEventStream(),
    calculateCost: calculateCommandCodeCost,
    apiBase: legacyApiBase(apiBase),
  })
  const transport = createCommandCodeTransportRouter({
    createStream: () => new AssistantMessageEventStream(),
    streamProvider: streamNativeProvider,
    streamGenerate,
  })

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return
    const normalized = normalizeCommandCodeMessage(event.message, ctx.model?.provider)
    return normalized ? { message: normalized.message } : undefined
  })

  pi.registerCommand("commandcode-quota", {
    description: "Show Command Code account usage and quota",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle?.()

      // Resolve the key in a host-agnostic way so the command also works on
      // OMP (which passes an unresolved "$COMMANDCODE_API_KEY" placeholder
      // through the registry): filter placeholders and fall back to the
      // env/auth-file resolver, mirroring src/core.ts.
      const apiKey = await resolveCommandCodeApiKey(ctx)
      if (!apiKey) {
        ctx.ui.notify(
          "Command Code quota requires an API key. Run /login and select Command Code, or set the COMMANDCODE_API_KEY env var.",
          "warning",
        )
        return
      }

      const result = await fetchCommandCodeQuota({
        apiKey,
        // Alpha endpoints live under the legacy base (no /provider/v1),
        // same as the fallback generate transport.
        baseUrl: legacyApiBase(apiBase),
        // Respect the user's zero-data-retention preference on usage/account
        // calls too, matching the provider stream path.
        extraHeaders: commandCodeHeaders(),
      })

      if (!result.ok) {
        ctx.ui.notify(redactValue(result.error.message), "error")
        return
      }

      ctx.ui.notify(formatQuota(result.quota), "info")
    },
  })

  const runtime = createCommandCodeRuntime<ProviderConfig, ExtensionCommandContext>(pi, {
    endpoint: modelsUrl,
    cachePath: modelsCachePath,
    loadModels: () =>
      loadCommandCodeModels({
        url: modelsUrl,
        cachePath: modelsCachePath,
        timeoutMs: modelsTimeoutMs,
      }),
    createProviderConfig: (models) => createProviderConfig(models, apiBase, transport.stream),
    getTransport: transport.getTransport,
  })

  await runtime.initialize()
}
