import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
  commandCodeModelsFromApiResponse,
  commandCodeModelsFromCache,
  loadCommandCodeModels,
  type CommandCodeModel,
} from "../src/models.ts"

const API_RESPONSE = {
  object: "list",
  data: [
    {
      id: "Qwen/Qwen3.7-Max",
      object: "model",
      created: 1779824324,
      owned_by: "command-code",
      name: "Qwen 3.7 Max",
      context_length: 1_000_000,
    },
  ],
}

const EXPECTED_MODELS: readonly CommandCodeModel[] = [
  {
    id: "Qwen/Qwen3.7-Max",
    name: "Qwen 3.7 Max (CC)",
    reasoning: true,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
]

function successfulFetch(): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(API_RESPONSE), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
}

function failingFetch(message = "offline"): typeof fetch {
  return () => Promise.reject(new TypeError(message))
}

async function withTemporaryCache(
  run: (paths: { directory: string; cachePath: string }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-commandcode-models-"))
  try {
    await run({ directory, cachePath: join(directory, "models.json") })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe("commandCodeModelsFromApiResponse()", () => {
  it("converts the Provider API model list to pi models", () => {
    assert.deepEqual(commandCodeModelsFromApiResponse(API_RESPONSE), EXPECTED_MODELS)
  })

  it("rejects unexpected API shapes", () => {
    assert.throws(() => commandCodeModelsFromApiResponse({ object: "list", data: [{}] }))
  })
})

describe("commandCodeModelsFromCache()", () => {
  it("accepts the current cache format", () => {
    assert.deepEqual(
      commandCodeModelsFromCache({ version: 1, models: EXPECTED_MODELS }),
      EXPECTED_MODELS,
    )
  })

  it("rejects empty, invalid, and unsupported caches", () => {
    assert.throws(() => commandCodeModelsFromCache({ version: 1, models: [] }))
    assert.throws(() => commandCodeModelsFromCache({ version: 2, models: EXPECTED_MODELS }))
    assert.throws(() =>
      commandCodeModelsFromCache({
        version: 1,
        models: [{ ...EXPECTED_MODELS[0], contextWindow: -1 }],
      }),
    )
  })
})

describe("loadCommandCodeModels()", () => {
  it("returns live models and writes a validated cache", async () => {
    await withTemporaryCache(async ({ cachePath }) => {
      const result = await loadCommandCodeModels({
        cachePath,
        fetchImpl: successfulFetch(),
      })

      assert.deepEqual(result, { models: EXPECTED_MODELS, source: "live" })
      assert.deepEqual(
        commandCodeModelsFromCache(JSON.parse(await readFile(cachePath, "utf-8"))),
        EXPECTED_MODELS,
      )
    })
  })

  it("uses the last valid catalog when the refresh fails", async () => {
    await withTemporaryCache(async ({ cachePath }) => {
      await loadCommandCodeModels({ cachePath, fetchImpl: successfulFetch() })

      const result = await loadCommandCodeModels({
        cachePath,
        fetchImpl: failingFetch(),
      })

      assert.deepEqual(result.models, EXPECTED_MODELS)
      assert.equal(result.source, "cache")
      assert.match(result.warning ?? "", /offline/)
      assert.match(result.warning ?? "", /Using the cached catalog/)
    })
  })

  it("starts with an empty catalog when offline without a valid cache", async () => {
    await withTemporaryCache(async ({ cachePath }) => {
      const result = await loadCommandCodeModels({
        cachePath,
        fetchImpl: failingFetch(),
      })

      assert.deepEqual(result.models, [])
      assert.equal(result.source, "empty")
      assert.match(result.warning ?? "", /no valid cached catalog/)
      assert.match(result.warning ?? "", /until \/reload succeeds/)
    })
  })

  it("recovers live models after an empty offline start", async () => {
    await withTemporaryCache(async ({ cachePath }) => {
      const empty = await loadCommandCodeModels({
        cachePath,
        fetchImpl: failingFetch(),
      })

      assert.equal(empty.source, "empty")
      assert.deepEqual(empty.models, [])

      const recovered = await loadCommandCodeModels({
        cachePath,
        fetchImpl: successfulFetch(),
      })

      assert.deepEqual(recovered, { models: EXPECTED_MODELS, source: "live" })
      assert.deepEqual(
        commandCodeModelsFromCache(JSON.parse(await readFile(cachePath, "utf-8"))),
        EXPECTED_MODELS,
      )
    })
  })

  it("ignores a corrupt cache after a failed refresh", async () => {
    await withTemporaryCache(async ({ cachePath }) => {
      await writeFile(cachePath, "not json", "utf-8")

      const result = await loadCommandCodeModels({
        cachePath,
        fetchImpl: failingFetch(),
      })

      assert.deepEqual(result.models, [])
      assert.equal(result.source, "empty")
      assert.match(result.warning ?? "", /Unexpected token|JSON/)
    })
  })

  it("keeps live models usable when the cache cannot be written", async () => {
    await withTemporaryCache(async ({ directory }) => {
      const unwritableCachePath = join(directory, "cache-directory")
      await mkdir(unwritableCachePath)

      const result = await loadCommandCodeModels({
        cachePath: unwritableCachePath,
        fetchImpl: successfulFetch(),
      })

      assert.deepEqual(result.models, EXPECTED_MODELS)
      assert.equal(result.source, "live")
      assert.match(result.warning ?? "", /could not update/)
    })
  })

  it("falls back to cache for HTTP and response parsing failures", async () => {
    await withTemporaryCache(async ({ cachePath }) => {
      await loadCommandCodeModels({ cachePath, fetchImpl: successfulFetch() })

      for (const fetchImpl of [
        (() => Promise.resolve(new Response("boom", { status: 500 }))) as typeof fetch,
        (() =>
          Promise.resolve(
            new Response("not json", {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          )) as typeof fetch,
      ]) {
        const result = await loadCommandCodeModels({ cachePath, fetchImpl })
        assert.deepEqual(result.models, EXPECTED_MODELS)
        assert.equal(result.source, "cache")
      }
    })
  })
})
