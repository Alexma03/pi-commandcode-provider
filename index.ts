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

import { registerCommandCodeAccountCommands } from "./src/account-commands.ts"
import { createAccountStore } from "./src/account-store.ts"
import { createAccountService } from "./src/accounts.ts"
import { createCoordinationStore } from "./src/coordination.ts"
import { getConfiguredApiKey } from "./src/api-key.ts"
import { createStreamCommandCode } from "./src/core.ts"
import { calculateCommandCodeCost } from "./src/cost.ts"
import {
  apiForModelId,
  baseUrlForModel,
  DEFAULT_MODELS_URL,
  DEFAULT_PROVIDER_API_BASE,
  getModelsTimeoutMs,
  inputModalitiesForModel,
  loadCommandCodeModels,
  MODEL_EFFORTS,
  thinkingMetadataForModel,
  type CommandCodeModel,
} from "./src/models.ts"
import { getApiKey as getOAuthApiKey, login, refreshToken } from "./src/oauth.ts"
import { normalizeCommandCodeMessage } from "./src/overflow.ts"
import { MODEL_COSTS, ZERO_MODEL_COST } from "./src/pricing.ts"
import { registerCommandCodeQuota } from "./src/quota-command.ts"
import {
  createAccountAwareStream,
  createCommandCodeRuntime,
  redactDiagnosticText,
} from "./src/runtime.ts"
import {
  createCommandCodeTransportRegistry,
  createCommandCodeTransportRouter,
} from "./src/transport.ts"

function commandCodeHeaders(): Record<string, string> | undefined {
  if (process.env.CMD_ZDR === "1" || process.env.COMMANDCODE_ZDR === "1") {
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
    apiKey: getConfiguredApiKey() ?? "$COMMAND_CODE_API_KEY",
    api: "commandcode-custom",
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
      api: "commandcode-custom",
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
              supportsReasoningEffort: MODEL_EFFORTS[model.id] !== undefined,
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
  const transportDependencies = {
    createStream: () => new AssistantMessageEventStream(),
    streamProvider: (model, context, options) =>
      streamNativeProvider(
        { ...model, api: apiForModelId(model.id), compat: model.compatConfig ?? model.compat },
        context,
        options,
      ),
    streamGenerate,
  }
  const transport = createCommandCodeTransportRouter(transportDependencies)
  const transportRegistry = createCommandCodeTransportRegistry(transportDependencies)

  let coordinationWarning: string | undefined
  const rememberCoordinationWarning = (message: string): void => {
    coordinationWarning = redactDiagnosticText(message)
  }
  const accountStore = createAccountStore({ getAgentDir })
  const coordination = createCoordinationStore({
    stateDir: accountStore.stateRoot,
    warning: rememberCoordinationWarning,
  })
  const accountService = createAccountService({
    store: accountStore,
    coordination,
    warning: rememberCoordinationWarning,
    apiBase: legacyApiBase(apiBase),
    headers: commandCodeHeaders(),
    pruneAccountState: async (id) => transportRegistry.reset(id),
  })
  const streamCommandCode = createAccountAwareStream({
    accounts: accountService,
    createStream: () => new AssistantMessageEventStream(),
    streamLegacy: transport.stream,
    streamAccount: (account, model, context, options) => {
      if (!account) return transport.stream(model, context, options)
      return transportRegistry.stream(account.id, model, context, options)
    },
  })

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return
    const normalized = normalizeCommandCodeMessage(event.message, ctx.model?.provider)
    return normalized ? { message: normalized.message } : undefined
  })

  registerCommandCodeAccountCommands(pi, { service: accountService })

  registerCommandCodeQuota(pi, {
    apiBase: legacyApiBase(apiBase),
    headers: commandCodeHeaders(),
    accountService,
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
    createProviderConfig: (models) => createProviderConfig(models, apiBase, streamCommandCode),
    getTransport: transport.getTransport,
    accountService,
    getCoordinationWarning: () => coordinationWarning,
  })

  pi.on("session_shutdown", async () => {
    await runtime.shutdown()
  })

  await runtime.initialize()
}
