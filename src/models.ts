import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const DEFAULT_MODELS_URL = "https://api.commandcode.ai/provider/v1/models"

const DEFAULT_MAX_OUTPUT_TOKENS = 65_536
const MODEL_CACHE_VERSION = 1

interface ApiModel {
  id: string
  name: string
  contextLength: number
}

export interface CommandCodeModel {
  id: string
  name: string
  reasoning: boolean
  contextWindow: number
  maxTokens: number
}

interface FetchCommandCodeModelsOptions {
  url?: string
  fetchImpl?: typeof fetch
}

interface LoadCommandCodeModelsOptions extends FetchCommandCodeModelsOptions {
  cachePath?: string
}

export interface LoadCommandCodeModelsResult {
  models: readonly CommandCodeModel[]
  source: "live" | "cache" | "empty"
  warning?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected ${key} to be a non-empty string`)
  }
  return value
}

function booleanField(record: Record<string, unknown>, key: string): boolean {
  const value = record[key]
  if (typeof value !== "boolean") throw new Error(`Expected ${key} to be a boolean`)
  return value
}

function positiveNumberField(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Expected ${key} to be a positive number`)
  }
  return value
}

function parseApiModel(value: unknown): ApiModel {
  if (!isRecord(value)) throw new Error("Expected model entry to be an object")

  return {
    id: stringField(value, "id"),
    name: stringField(value, "name"),
    contextLength: positiveNumberField(value, "context_length"),
  }
}

function parseCachedModel(value: unknown): CommandCodeModel {
  if (!isRecord(value)) throw new Error("Expected cached model entry to be an object")

  return {
    id: stringField(value, "id"),
    name: stringField(value, "name"),
    reasoning: booleanField(value, "reasoning"),
    contextWindow: positiveNumberField(value, "contextWindow"),
    maxTokens: positiveNumberField(value, "maxTokens"),
  }
}

function requireModels(models: readonly CommandCodeModel[]): readonly CommandCodeModel[] {
  if (models.length === 0) throw new Error("Command Code returned an empty model catalog")
  return models
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function defaultCommandCodeModelsCachePath(): string {
  return join(homedir(), ".commandcode", "pi-models.json")
}

export function commandCodeModelsFromApiResponse(value: unknown): readonly CommandCodeModel[] {
  if (!isRecord(value)) throw new Error("Expected models response to be an object")
  if (value.object !== "list") throw new Error("Expected models response object to be 'list'")

  const data = value.data
  if (!Array.isArray(data)) throw new Error("Expected models response data to be an array")

  return data.map(parseApiModel).map((model) => ({
    id: model.id,
    name: `${model.name} (CC)`,
    reasoning: true,
    contextWindow: model.contextLength,
    maxTokens: Math.min(model.contextLength, DEFAULT_MAX_OUTPUT_TOKENS),
  }))
}

export function commandCodeModelsFromCache(value: unknown): readonly CommandCodeModel[] {
  if (!isRecord(value)) throw new Error("Expected model cache to be an object")
  if (value.version !== MODEL_CACHE_VERSION) {
    throw new Error(`Expected model cache version ${MODEL_CACHE_VERSION}`)
  }
  if (!Array.isArray(value.models)) throw new Error("Expected cached models to be an array")

  return requireModels(value.models.map(parseCachedModel))
}

export async function fetchCommandCodeModels(
  options: FetchCommandCodeModelsOptions = {},
): Promise<readonly CommandCodeModel[]> {
  const url = options.url ?? DEFAULT_MODELS_URL
  const fetchImpl = options.fetchImpl ?? fetch
  const response = await fetchImpl(url, {
    headers: {
      accept: "application/json",
    },
  })

  if (!response.ok) {
    throw new Error(
      `Failed to fetch Command Code models: ${response.status} ${response.statusText}`,
    )
  }

  const body: unknown = await response.json()
  return requireModels(commandCodeModelsFromApiResponse(body))
}

async function readCommandCodeModelsCache(cachePath: string): Promise<readonly CommandCodeModel[]> {
  const contents = await readFile(cachePath, "utf-8")
  const parsed: unknown = JSON.parse(contents)
  return commandCodeModelsFromCache(parsed)
}

async function writeCommandCodeModelsCache(
  cachePath: string,
  models: readonly CommandCodeModel[],
): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true })
  const temporaryPath = `${cachePath}.${process.pid}.tmp`

  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify({ version: MODEL_CACHE_VERSION, models }, null, 2)}\n`,
      { encoding: "utf-8", mode: 0o600 },
    )
    await rename(temporaryPath, cachePath)
  } finally {
    try {
      await rm(temporaryPath, { force: true })
    } catch {
      // Best-effort cleanup must not hide the original cache write error.
    }
  }
}

export async function loadCommandCodeModels(
  options: LoadCommandCodeModelsOptions = {},
): Promise<LoadCommandCodeModelsResult> {
  const cachePath = options.cachePath ?? defaultCommandCodeModelsCachePath()

  try {
    const models = await fetchCommandCodeModels(options)

    try {
      await writeCommandCodeModelsCache(cachePath, models)
      return { models, source: "live" }
    } catch (error) {
      return {
        models,
        source: "live",
        warning: `Loaded the live Command Code model catalog but could not update ${cachePath}: ${errorMessage(error)}`,
      }
    }
  } catch (liveError) {
    try {
      const models = await readCommandCodeModelsCache(cachePath)
      return {
        models,
        source: "cache",
        warning: `Could not refresh the Command Code model catalog (${errorMessage(liveError)}). Using the cached catalog from ${cachePath}.`,
      }
    } catch (cacheError) {
      return {
        models: [],
        source: "empty",
        warning: `Could not refresh the Command Code model catalog (${errorMessage(liveError)}), and no valid cached catalog is available at ${cachePath} (${errorMessage(cacheError)}). Command Code models will remain unavailable until /reload succeeds.`,
      }
    }
  }
}
