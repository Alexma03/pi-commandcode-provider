/**
 * Command Code provider for pi.
 *
 * Uses Command Code's documented Provider API:
 * https://api.commandcode.ai/provider/v1
 */

import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ProviderConfig,
} from "@earendil-works/pi-coding-agent"
import { join } from "node:path"

import { getConfiguredApiKey } from "./src/api-key.ts"
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
import { MODEL_COSTS, ZERO_MODEL_COST } from "./src/pricing.ts"
import { createCommandCodeRuntime } from "./src/runtime.ts"

function commandCodeHeaders(): Record<string, string> | undefined {
  if (process.env.COMMANDCODE_ZDR === "1") {
    return { "x-cmd-zdr": "1" }
  }
  return undefined
}

function createProviderConfig(
  models: readonly CommandCodeModel[],
  apiBase: string,
): ProviderConfig {
  const headers = commandCodeHeaders()
  return {
    name: "Command Code",
    baseUrl: apiBase,
    apiKey: getConfiguredApiKey() ?? "$COMMANDCODE_API_KEY",
    api: "openai-completions",
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
            },
    })),
  }
}

export default async function (pi: ExtensionAPI) {
  const apiBase = process.env.COMMANDCODE_API_BASE ?? DEFAULT_PROVIDER_API_BASE
  const modelsUrl = process.env.COMMANDCODE_MODELS_URL ?? DEFAULT_MODELS_URL
  const modelsTimeoutMs = getModelsTimeoutMs()
  const modelsCachePath =
    process.env.COMMANDCODE_MODELS_CACHE ?? join(getAgentDir(), "commandcode-models.json")

  const runtime = createCommandCodeRuntime<ProviderConfig, ExtensionCommandContext>(pi, {
    endpoint: modelsUrl,
    cachePath: modelsCachePath,
    loadModels: () =>
      loadCommandCodeModels({
        url: modelsUrl,
        cachePath: modelsCachePath,
        timeoutMs: modelsTimeoutMs,
      }),
    createProviderConfig: (models) => createProviderConfig(models, apiBase),
  })

  await runtime.initialize()
}
