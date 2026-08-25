import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

import {
  COMMAND_CODE_CLI_VERSION,
  MODEL_EFFORTS,
  MODEL_INPUT_MODALITIES,
} from "../../src/commandcode-catalog.ts"

const execFileAsync = promisify(execFile)
const MODELS_REFERENCE_PATH = "dist/bundled/command-code-knowledge/reference/models.md"
const CLI_BUNDLE_PATH = "dist/cli.mjs"
const TEXT_ONLY_MARKER = ',__name(isKnownTextOnlyModel,"isKnownTextOnlyModel")'
const VALID_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"])
const CATALOG_SOURCE_PATH = new URL("../../src/commandcode-catalog.ts", import.meta.url)
const README_PATH = new URL("../../README.md", import.meta.url)

export interface CommandCodeModelMetadata {
  imageModelIds: readonly string[]
  reasoningEfforts: Readonly<Record<string, readonly string[]>>
}

export interface ModelMetadataDiff {
  versionChanged: boolean
  addedImageModelIds: readonly string[]
  removedImageModelIds: readonly string[]
  addedReasoningModelIds: readonly string[]
  removedReasoningModelIds: readonly string[]
  changedReasoningModelIds: readonly string[]
}

interface PackedPackage {
  filename: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right))
}

function parsePackedPackage(value: unknown): PackedPackage {
  if (!Array.isArray(value) || value.length !== 1 || !isRecord(value[0])) {
    throw new Error("Expected npm pack to return one package")
  }

  const filename = value[0].filename
  if (typeof filename !== "string" || filename.length === 0) {
    throw new Error("Expected npm pack to return a tarball filename")
  }

  return { filename }
}

export function parsePackageVersion(value: unknown): string {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(value)) {
    throw new Error("Expected npm view to return one semantic version")
  }
  return value
}

export function parseModelsReference(markdown: string): {
  modelIds: readonly string[]
  reasoningEfforts: Readonly<Record<string, readonly string[]>>
} {
  const modelIds = new Set<string>()
  const reasoningEfforts: Record<string, readonly string[]> = {}

  for (const line of markdown.split("\n")) {
    const match = /^\| `([^`]+)` \| [^|]* \| [^|]* \| ([^|]*) \|/.exec(line)
    if (!match) continue

    const modelId = match[1]
    const effortsColumn = match[2]?.trim()
    if (!modelId || !effortsColumn) throw new Error(`Could not parse model row: ${line}`)
    if (modelIds.has(modelId)) throw new Error(`Duplicate model id in reference: ${modelId}`)
    modelIds.add(modelId)

    if (effortsColumn === "—") continue

    const efforts = effortsColumn.split(",").map((effort) => effort.trim())
    if (efforts.length === 0 || efforts.some((effort) => !VALID_EFFORTS.has(effort))) {
      throw new Error(`Unexpected reasoning efforts for ${modelId}: ${effortsColumn}`)
    }
    reasoningEfforts[modelId] = efforts
  }

  if (modelIds.size === 0) throw new Error("No model rows found in Command Code reference")

  return {
    modelIds: sorted(modelIds),
    reasoningEfforts: Object.fromEntries(
      Object.entries(reasoningEfforts).sort(([left], [right]) => left.localeCompare(right)),
    ),
  }
}

export function parseKnownTextOnlyModelIds(bundle: string): readonly string[] {
  const markerIndex = bundle.indexOf(TEXT_ONLY_MARKER)
  if (markerIndex < 0) {
    throw new Error("Could not find Command Code's isKnownTextOnlyModel catalog")
  }

  const setStart = bundle.lastIndexOf("new Set([", markerIndex)
  if (setStart < 0) throw new Error("Could not find the text-only model set")

  const arrayStart = setStart + "new Set(".length
  const arrayEnd = markerIndex - 1
  const literal = bundle.slice(arrayStart, arrayEnd)
  const parsed: unknown = JSON.parse(literal)
  if (!isStringArray(parsed)) throw new Error("Expected the text-only model catalog to be strings")

  return sorted(new Set(parsed))
}

export function commandCodeModelMetadataFromContents(
  modelsReference: string,
  cliBundle: string,
): CommandCodeModelMetadata {
  const reference = parseModelsReference(modelsReference)
  const textOnlyModelIds = new Set(parseKnownTextOnlyModelIds(cliBundle))

  return {
    imageModelIds: reference.modelIds.filter((modelId) => !textOnlyModelIds.has(modelId)),
    reasoningEfforts: reference.reasoningEfforts,
  }
}

export function currentModelMetadata(): CommandCodeModelMetadata {
  return {
    imageModelIds: sorted(Object.keys(MODEL_INPUT_MODALITIES)),
    reasoningEfforts: Object.fromEntries(
      Object.entries(MODEL_EFFORTS)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([modelId, efforts]) => [modelId, [...efforts]]),
    ),
  }
}

export function diffModelMetadata(
  current: CommandCodeModelMetadata,
  upstream: CommandCodeModelMetadata,
  currentVersion = COMMAND_CODE_CLI_VERSION,
  upstreamVersion = COMMAND_CODE_CLI_VERSION,
): ModelMetadataDiff {
  const currentImages = new Set(current.imageModelIds)
  const upstreamImages = new Set(upstream.imageModelIds)
  const currentReasoningIds = Object.keys(current.reasoningEfforts)
  const upstreamReasoningIds = Object.keys(upstream.reasoningEfforts)
  const currentReasoningSet = new Set(currentReasoningIds)
  const upstreamReasoningSet = new Set(upstreamReasoningIds)

  return {
    versionChanged: currentVersion !== upstreamVersion,
    addedImageModelIds: sorted(
      upstream.imageModelIds.filter((modelId) => !currentImages.has(modelId)),
    ),
    removedImageModelIds: sorted(
      current.imageModelIds.filter((modelId) => !upstreamImages.has(modelId)),
    ),
    addedReasoningModelIds: sorted(
      upstreamReasoningIds.filter((modelId) => !currentReasoningSet.has(modelId)),
    ),
    removedReasoningModelIds: sorted(
      currentReasoningIds.filter((modelId) => !upstreamReasoningSet.has(modelId)),
    ),
    changedReasoningModelIds: sorted(
      upstreamReasoningIds.filter(
        (modelId) =>
          currentReasoningSet.has(modelId) &&
          JSON.stringify(current.reasoningEfforts[modelId]) !==
            JSON.stringify(upstream.reasoningEfforts[modelId]),
      ),
    ),
  }
}

export function hasModelMetadataDiff(diff: ModelMetadataDiff): boolean {
  return (
    diff.versionChanged ||
    Object.entries(diff).some(([key, modelIds]) => key !== "versionChanged" && modelIds.length > 0)
  )
}

function formatList(modelIds: readonly string[]): string {
  return modelIds.length > 0 ? modelIds.map((modelId) => `\`${modelId}\``).join(", ") : "None"
}

function formatReasoningChanges(
  modelIds: readonly string[],
  current: CommandCodeModelMetadata,
  upstream: CommandCodeModelMetadata,
): string {
  if (modelIds.length === 0) return "None"
  return modelIds
    .map(
      (modelId) =>
        `\`${modelId}\`: \`${(current.reasoningEfforts[modelId] ?? []).join(", ")}\` → \`${(
          upstream.reasoningEfforts[modelId] ?? []
        ).join(", ")}\``,
    )
    .join("<br>")
}

function quoted(value: string): string {
  return JSON.stringify(value)
}

function recordEntries(
  values: Readonly<Record<string, readonly string[]>>,
): readonly [string, readonly string[]][] {
  return Object.entries(values).sort(([left], [right]) => left.localeCompare(right))
}

export function renderCommandCodeCatalog(
  packageVersion: string,
  metadata: CommandCodeModelMetadata,
): string {
  const imageEntries = sorted(metadata.imageModelIds)
    .map((modelId) => `  ${quoted(modelId)}: ["text", "image"],`)
    .join("\n")
  const reasoningEntries = recordEntries(metadata.reasoningEfforts)
    .map(
      ([modelId, efforts]) =>
        `  ${quoted(modelId)}: [${efforts.map((effort) => quoted(effort)).join(", ")}],`,
    )
    .join("\n")

  return `export const COMMAND_CODE_CLI_VERSION = ${quoted(packageVersion)}\n\nexport type CommandCodeInputType = "text" | "image"\nexport type CommandCodeReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max"\n\n/**\n * Generated from command-code@${packageVersion} by \`npm run sync:commandcode-catalog\`.\n * Do not edit manually.\n */\nexport const MODEL_INPUT_MODALITIES: Readonly<Record<string, readonly CommandCodeInputType[]>> = {\n${imageEntries}\n}\n\nexport const MODEL_EFFORTS: Readonly<Record<string, readonly CommandCodeReasoningEffort[]>> = {\n${reasoningEntries}\n}\n`
}

function updateDocumentedCatalogVersion(
  contents: string,
  packageVersion: string,
  context: string,
): string {
  const pattern = /command-code@\d+\.\d+\.\d+(?:[-+][^`\s,]+)?/
  if (!pattern.test(contents)) throw new Error(`Could not find the ${context} catalog version`)
  return contents.replace(pattern, `command-code@${packageVersion}`)
}

export function updateReadmeCatalogVersion(readme: string, packageVersion: string): string {
  return updateDocumentedCatalogVersion(readme, packageVersion, "README")
}

async function writeSynchronizedCatalog(
  packageVersion: string,
  metadata: CommandCodeModelMetadata,
): Promise<void> {
  const readme = await readFile(README_PATH, "utf-8")
  await Promise.all([
    writeFile(CATALOG_SOURCE_PATH, renderCommandCodeCatalog(packageVersion, metadata), "utf-8"),
    writeFile(README_PATH, updateReadmeCatalogVersion(readme, packageVersion), "utf-8"),
  ])
}

function metadataReport(
  packageVersion: string,
  current: CommandCodeModelMetadata,
  upstream: CommandCodeModelMetadata,
  diff: ModelMetadataDiff,
): string {
  const status = hasModelMetadataDiff(diff) ? "❌ Drift detected" : "✅ Metadata is current"
  return [
    "## Command Code static model metadata",
    "",
    `**${status}**`,
    "",
    `- Repository snapshot: \`command-code@${COMMAND_CODE_CLI_VERSION}\``,
    `- Inspected package: \`command-code@${packageVersion}\``,
    `- Image-capable models: ${current.imageModelIds.length} repository / ${upstream.imageModelIds.length} upstream`,
    `- Reasoning models: ${Object.keys(current.reasoningEfforts).length} repository / ${Object.keys(upstream.reasoningEfforts).length} upstream`,
    "",
    "| Change | Models |",
    "| --- | --- |",
    `| CLI version | ${diff.versionChanged ? `\`${COMMAND_CODE_CLI_VERSION}\` → \`${packageVersion}\`` : "Current"} |`,
    `| New image support | ${formatList(diff.addedImageModelIds)} |`,
    `| Removed image support | ${formatList(diff.removedImageModelIds)} |`,
    `| New reasoning metadata | ${formatList(diff.addedReasoningModelIds)} |`,
    `| Removed reasoning metadata | ${formatList(diff.removedReasoningModelIds)} |`,
    `| Changed reasoning efforts | ${formatReasoningChanges(diff.changedReasoningModelIds, current, upstream)} |`,
    "",
  ].join("\n")
}

async function resolvePackageSpec(
  packageSpec: string,
  directory: string,
  npmCacheDirectory: string,
): Promise<string> {
  if (packageSpec !== "command-code@latest") return packageSpec

  const { stdout } = await execFileAsync(
    "npm",
    ["view", packageSpec, "version", "--json", "--prefer-online", "--cache", npmCacheDirectory],
    {
      cwd: directory,
      encoding: "utf-8",
    },
  )
  return `command-code@${parsePackageVersion(JSON.parse(stdout) as unknown)}`
}

async function inspectPackedPackage(packageSpec: string): Promise<{
  packageVersion: string
  metadata: CommandCodeModelMetadata
}> {
  const directory = await mkdtemp(join(tmpdir(), "pi-commandcode-model-check-"))
  const npmCacheDirectory = join(directory, "npm-cache")

  try {
    const resolvedPackageSpec = await resolvePackageSpec(packageSpec, directory, npmCacheDirectory)
    const { stdout } = await execFileAsync(
      "npm",
      ["pack", resolvedPackageSpec, "--json", "--prefer-online", "--cache", npmCacheDirectory],
      {
        cwd: directory,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      },
    )
    const packed = parsePackedPackage(JSON.parse(stdout) as unknown)
    await execFileAsync("tar", ["-xzf", packed.filename], { cwd: directory })

    const packageDirectory = join(directory, "package")
    const packageJsonContents = await readFile(join(packageDirectory, "package.json"), "utf-8")
    const packageJson: unknown = JSON.parse(packageJsonContents)
    if (!isRecord(packageJson) || typeof packageJson.version !== "string") {
      throw new Error("Expected command-code package.json to contain a version")
    }

    const [modelsReference, cliBundle] = await Promise.all([
      readFile(join(packageDirectory, MODELS_REFERENCE_PATH), "utf-8"),
      readFile(join(packageDirectory, CLI_BUNDLE_PATH), "utf-8"),
    ])

    return {
      packageVersion: packageJson.version,
      metadata: commandCodeModelMetadataFromContents(modelsReference, cliBundle),
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const write = process.argv.includes("--write")
  const packageSpec =
    process.argv.find((argument) => argument.startsWith("command-code@")) ?? "command-code@latest"
  const current = currentModelMetadata()
  const upstreamPackage = await inspectPackedPackage(packageSpec)
  const diff = diffModelMetadata(
    current,
    upstreamPackage.metadata,
    COMMAND_CODE_CLI_VERSION,
    upstreamPackage.packageVersion,
  )
  const report = metadataReport(
    upstreamPackage.packageVersion,
    current,
    upstreamPackage.metadata,
    diff,
  )

  console.log(report)

  if (write) {
    await writeSynchronizedCatalog(upstreamPackage.packageVersion, upstreamPackage.metadata)
    console.log(`Synchronized static metadata with command-code@${upstreamPackage.packageVersion}.`)
    return
  }

  if (hasModelMetadataDiff(diff)) {
    throw new Error(
      `Static model metadata differs from command-code@${upstreamPackage.packageVersion}. Update src/models.ts and the snapshot version.`,
    )
  }
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1]
  return entrypoint !== undefined && pathToFileURL(resolve(entrypoint)).href === import.meta.url
}

if (isMainModule()) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
