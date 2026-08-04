/**
 * Regression test for the local cost calculation.
 *
 * The provider ships its own cost function because Oh My Pi's legacy pi-ai
 * shim does not export `calculateCost` (see issue #24). This test locks the
 * local implementation to pi-ai's documented per-million-token arithmetic
 * without installing another pi-ai runtime next to the extension.
 */

import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { calculateCommandCodeCost } from "../src/cost.ts"
import type { Usage } from "../src/types.ts"

interface CostTable {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

const COST_FIXTURES: Record<string, CostTable> = {
  "zero-cost-model": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "deepseek/deepseek-v4-pro": {
    input: 0.435,
    output: 0.87,
    cacheRead: 0.003625,
    cacheWrite: 0,
  },
  "Qwen/Qwen3.7-Max": { input: 1.25, output: 3.75, cacheRead: 0.25, cacheWrite: 1.56 },
  "gpt-5.5": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
}

const USAGE_CASES = [
  { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
  { input: 812, output: 187, cacheRead: 52_000, cacheWrite: 3_100 },
  { input: 1_000_000, output: 65_536, cacheRead: 998_877, cacheWrite: 123_456 },
  { input: 7, output: 999_999_999, cacheRead: 0.5, cacheWrite: 42 },
]

function commandCodeModel(id: string, cost: CostTable) {
  return {
    id,
    api: "commandcode-custom",
    provider: "commandcode",
    cost,
    maxTokens: 65_536,
  }
}

function freshUsage(tokens: (typeof USAGE_CASES)[number]): Usage {
  return {
    ...tokens,
    totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function expectedCost(cost: CostTable, tokens: (typeof USAGE_CASES)[number]): Usage["cost"] {
  const input = (cost.input / 1_000_000) * tokens.input
  const output = (cost.output / 1_000_000) * tokens.output
  const cacheRead = (cost.cacheRead / 1_000_000) * tokens.cacheRead
  const cacheWrite = (cost.cacheWrite * tokens.cacheWrite) / 1_000_000
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
  }
}

describe("calculateCommandCodeCost()", () => {
  it("applies per-million-token rates to all cost fields", () => {
    for (const [id, cost] of Object.entries(COST_FIXTURES)) {
      const model = commandCodeModel(id, cost)

      for (const tokens of USAGE_CASES) {
        const usage = freshUsage(tokens)
        calculateCommandCodeCost(model, usage)

        assert.deepEqual(
          usage.cost,
          expectedCost(cost, tokens),
          `${id} cost for tokens=${JSON.stringify(tokens)}`,
        )
      }
    }
  })

  it("writes the total as the sum of all cost components", () => {
    const model = commandCodeModel("claude-sonnet-4-6", COST_FIXTURES["claude-sonnet-4-6"])
    const usage = freshUsage({ input: 1_000, output: 500, cacheRead: 10_000, cacheWrite: 2_000 })

    calculateCommandCodeCost(model, usage)

    assert.equal(
      usage.cost.total,
      usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite,
    )
    assert.ok(usage.cost.total > 0)
  })
})
