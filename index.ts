/**
 * Command Code provider for pi.
 *
 * Connects pi to Command Code's API (https://api.commandcode.ai/alpha/generate).
 *
 * Authentication (pick one):
 *   1. Run `/login`, then select Command Code — opens browser to commandcode.ai, auto-stores API key
 *   2. Set COMMANDCODE_API_KEY environment variable
 *   3. Place API key in `~/.commandcode/auth.json` or `~/.pi/agent/auth.json`
 *      as {"apiKey": "user_..."} or {"commandcode": "user_..."}
 *
 * Models are fetched from Command Code's Provider API at startup.
 */

import { AssistantMessageEventStream } from "@earendil-works/pi-ai"
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { join } from "node:path"

import { getApiKey as getStoredApiKey } from "./src/converters.ts"
import { COMMAND_CODE_CLI_VERSION, createStreamCommandCode, DEFAULT_API_BASE } from "./src/core.ts"
import { calculateCommandCodeCost } from "./src/cost.ts"
import { DEFAULT_MODELS_URL, loadCommandCodeModels } from "./src/models.ts"
import { getApiKey as getOAuthApiKey, login, refreshToken } from "./src/oauth.ts"
import { MODEL_COSTS, ZERO_MODEL_COST } from "./src/pricing.ts"

const API_BASE = process.env.COMMANDCODE_API_BASE ?? DEFAULT_API_BASE
const MODELS_URL = process.env.COMMANDCODE_MODELS_URL ?? DEFAULT_MODELS_URL
const MODELS_CACHE_PATH =
  process.env.COMMANDCODE_MODELS_CACHE ?? join(getAgentDir(), "commandcode-models.json")

const streamCommandCode = createStreamCommandCode({
  createStream: () => new AssistantMessageEventStream(),
  calculateCost: calculateCommandCodeCost,
  apiBase: API_BASE,
})

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
  const storedApiKey = getStoredApiKey()
  const { models, warning } = await loadCommandCodeModels({
    url: MODELS_URL,
    cachePath: MODELS_CACHE_PATH,
  })

  if (warning) console.warn(`[commandcode] ${warning}`)

  pi.registerProvider("commandcode", {
    name: "Command Code",
    baseUrl: API_BASE,
    apiKey: storedApiKey,
    authHeader: true,
    api: "commandcode-custom",
    streamSimple: streamCommandCode,
    headers: {
      "x-command-code-version": COMMAND_CODE_CLI_VERSION,
      "x-cli-environment": "production",
    },
    oauth: {
      name: "Command Code",
      login,
      refreshToken,
      getApiKey: getOAuthApiKey,
    },
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: ["text"] as const,
      cost: MODEL_COSTS[model.id] ?? ZERO_MODEL_COST,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    })),
  })
}
