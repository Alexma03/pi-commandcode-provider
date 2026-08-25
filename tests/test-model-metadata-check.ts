import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  commandCodeModelMetadataFromContents,
  diffModelMetadata,
  hasModelMetadataDiff,
  parseKnownTextOnlyModelIds,
  parseModelsReference,
  parsePackageVersion,
  renderCommandCodeCatalog,
  updateChangelogCatalogVersion,
  updateReadmeCatalogVersion,
  type CommandCodeModelMetadata,
} from "../.github/scripts/check-commandcode-model-metadata.ts"

const MODELS_REFERENCE = `
| Id (use EXACTLY this) | Name | Context | Efforts | $/1M in/out · cache read | Min plan | Best for |
|---|---|---|---|---|---|---|
| \`vision-model\` | Vision | 1M | low, high | $1/$2 | Go | images |
| \`text-model\` | Text | 200K | — | $1/$2 | Go | text |
`

const CLI_BUNDLE =
  'const catalog=new Set(["text-model"]),__name(isKnownTextOnlyModel,"isKnownTextOnlyModel")'

describe("Command Code model metadata checker", () => {
  it("parses model ids and reasoning efforts from the generated reference", () => {
    assert.deepEqual(parseModelsReference(MODELS_REFERENCE), {
      modelIds: ["text-model", "vision-model"],
      reasoningEfforts: { "vision-model": ["low", "high"] },
    })
  })

  it("extracts the text-only set from the bundled CLI catalog", () => {
    assert.deepEqual(parseKnownTextOnlyModelIds(CLI_BUNDLE), ["text-model"])
  })

  it("accepts one exact npm registry version and rejects stale-looking output shapes", () => {
    assert.equal(parsePackageVersion("1.32.2"), "1.32.2")
    assert.equal(parsePackageVersion("2.0.0-beta.1"), "2.0.0-beta.1")
    assert.throws(() => parsePackageVersion(["1.32.1", "1.32.2"]), /one semantic version/)
    assert.throws(() => parsePackageVersion("latest"), /one semantic version/)
  })

  it("derives image support by excluding known text-only models", () => {
    assert.deepEqual(commandCodeModelMetadataFromContents(MODELS_REFERENCE, CLI_BUNDLE), {
      imageModelIds: ["vision-model"],
      reasoningEfforts: { "vision-model": ["low", "high"] },
    })
  })

  it("reports additions, removals, and changed reasoning efforts", () => {
    const current: CommandCodeModelMetadata = {
      imageModelIds: ["removed-image", "stable-image"],
      reasoningEfforts: {
        "changed-reasoning": ["low"],
        "removed-reasoning": ["high"],
        "stable-reasoning": ["low", "high"],
      },
    }
    const upstream: CommandCodeModelMetadata = {
      imageModelIds: ["added-image", "stable-image"],
      reasoningEfforts: {
        "added-reasoning": ["max"],
        "changed-reasoning": ["low", "high"],
        "stable-reasoning": ["low", "high"],
      },
    }

    const diff = diffModelMetadata(current, upstream)

    assert.deepEqual(diff, {
      versionChanged: false,
      addedImageModelIds: ["added-image"],
      removedImageModelIds: ["removed-image"],
      addedReasoningModelIds: ["added-reasoning"],
      removedReasoningModelIds: ["removed-reasoning"],
      changedReasoningModelIds: ["changed-reasoning"],
    })
    assert.equal(hasModelMetadataDiff(diff), true)
  })

  it("reports CLI version drift even when model metadata is unchanged", () => {
    const metadata: CommandCodeModelMetadata = {
      imageModelIds: ["vision-model"],
      reasoningEfforts: { "vision-model": ["low"] },
    }

    const diff = diffModelMetadata(metadata, metadata, "1.32.2", "1.33.0")

    assert.equal(diff.versionChanged, true)
    assert.equal(hasModelMetadataDiff(diff), true)
  })

  it("renders a deterministic generated catalog and updates the README version", () => {
    assert.equal(
      renderCommandCodeCatalog("1.33.0", {
        imageModelIds: ["b-model", "a-model"],
        reasoningEfforts: {
          "b-model": ["high", "max"],
          "a-model": ["low"],
        },
      }),
      `export const COMMAND_CODE_CLI_VERSION = "1.33.0"

export type CommandCodeInputType = "text" | "image"
export type CommandCodeReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max"

/**
 * Generated from command-code@1.33.0 by \`npm run sync:commandcode-catalog\`.
 * Do not edit manually.
 */
export const MODEL_INPUT_MODALITIES: Readonly<Record<string, readonly CommandCodeInputType[]>> = {
  "a-model": ["text", "image"],
  "b-model": ["text", "image"],
}

export const MODEL_EFFORTS: Readonly<Record<string, readonly CommandCodeReasoningEffort[]>> = {
  "a-model": ["low"],
  "b-model": ["high", "max"],
}
`,
    )
    assert.equal(
      updateReadmeCatalogVersion(
        "The capability snapshot currently follows `command-code@1.32.2`.",
        "1.33.0",
      ),
      "The capability snapshot currently follows `command-code@1.33.0`.",
    )
    assert.equal(
      updateChangelogCatalogVersion(
        "- Refresh capabilities from `command-code@1.32.2`, including metadata.",
        "1.33.0",
      ),
      "- Refresh capabilities from `command-code@1.33.0`, including metadata.",
    )
  })

  it("rejects unexpected upstream structures instead of silently passing", () => {
    assert.throws(() => parseModelsReference("# no catalog"), /No model rows/)
    assert.throws(
      () => parseModelsReference(MODELS_REFERENCE.replace("low, high", "low, turbo")),
      /Unexpected reasoning efforts/,
    )
    assert.throws(() => parseKnownTextOnlyModelIds("const unrelated = true"), /Could not find/)
  })
})
