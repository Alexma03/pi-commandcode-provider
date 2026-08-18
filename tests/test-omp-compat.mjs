#!/usr/bin/env node
/**
 * OMP compatibility smoke test.
 *
 * Uses an isolated HOME/PI_CODING_AGENT_DIR so the test does not depend on or
 * mutate the user's real ~/.omp state. The Command Code API base is pointed at
 * a deterministic local mock server so print mode can exercise the provider
 * without touching the real API.
 */

import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { accessSync, constants, mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_DIR = resolve(__dirname, "..")
const EXT_PATH = resolve(PROJECT_DIR, "index.ts")
const TEST_MODEL = "deepseek/deepseek-v4-flash"

function findOmpBinary() {
  if (process.env.OMP_BIN) return process.env.OMP_BIN
  const candidates = (process.env.PATH ?? "").split(delimiter).map((entry) => resolve(entry, "omp"))
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Try next PATH entry.
    }
  }
  return undefined
}

const OMP_BIN = findOmpBinary()
if (!OMP_BIN) {
  console.log("[omp-compat] SKIP - omp is not on PATH")
  process.exit(0)
}

const tempHome = mkdtempSync(join(tmpdir(), "omp-cc-home-"))
let requestCount = 0
let modelListRequestCount = 0
let lastRequestBody
let lastRequestHeaders = {}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/provider/v1/models") {
    modelListRequestCount += 1
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" })
    res.end(
      JSON.stringify({
        object: "list",
        data: [
          {
            id: TEST_MODEL,
            object: "model",
            created: 1779824324,
            owned_by: "command-code",
            name: "DeepSeek V4 Flash",
            context_length: 1_000_000,
          },
          {
            id: "Qwen/Qwen3.7-Max",
            object: "model",
            created: 1779824324,
            owned_by: "command-code",
            name: "Qwen 3.7 Max",
            context_length: 1_000_000,
          },
        ],
      }),
    )
    return
  }

  if (req.method !== "POST" || req.url !== "/provider/v1/chat/completions") {
    res.writeHead(404)
    res.end("Not found")
    return
  }

  requestCount += 1
  lastRequestHeaders = Object.fromEntries(
    Object.entries(req.headers).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.join(", ") : (value ?? ""),
    ]),
  )

  let body = ""
  req.on("data", (chunk) => {
    body += chunk.toString("utf-8")
  })
  req.on("end", () => {
    try {
      lastRequestBody = JSON.parse(body)
    } catch {
      lastRequestBody = undefined
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Transfer-Encoding": "chunked",
    })
    res.write(
      `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "mock-omp-ok" }, finish_reason: null }] })}\n\n`,
    )
    res.write(
      `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    )
    res.write(
      `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
    )
    res.end("data: [DONE]\n\n")
  })
})

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const address = server.address()
const port = typeof address === "object" && address ? address.port : 0
const apiBase = `http://127.0.0.1:${port}`

function runOmp(args, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    const child = spawn(OMP_BIN, args, {
      cwd: PROJECT_DIR,
      env: {
        ...process.env,
        HOME: tempHome,
        USERPROFILE: tempHome,
        PI_CODING_AGENT_DIR: join(tempHome, ".omp", "agent"),
        COMMANDCODE_API_KEY: "mock-key",
        COMMANDCODE_API_BASE: `${apiBase}/provider/v1`,
        COMMANDCODE_MODELS_URL: `${apiBase}/provider/v1/models`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill()
      resolve({
        code: -1,
        stdout,
        stderr: `${stderr}\nTIMEOUT after ${timeoutMs}ms`,
      })
    }, timeoutMs)
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf-8")
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf-8")
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

try {
  console.log("[omp-compat] list models through real extension")
  modelListRequestCount = 0
  const result = await runOmp(["-e", EXT_PATH, "--list-models"])
  assert.equal(result.code, 0, result.stderr)
  const listOutput = result.stdout || result.stderr
  assert.match(listOutput, /commandcode/)
  assert.match(listOutput, /deepseek\/deepseek-v4-flash/)
  assert.equal(modelListRequestCount, 1)
  assert.doesNotThrow(() =>
    accessSync(join(tempHome, ".omp", "agent", "commandcode-models.json"), constants.R_OK),
  )
  assert.doesNotMatch(result.stdout + result.stderr, /Failed to load extension/)

  console.log("[omp-compat] print mode through real extension and mock API")
  requestCount = 0
  const print = await runOmp(
    ["-e", EXT_PATH, "-p", "say mock token", "--model", `commandcode/${TEST_MODEL}`],
    30_000,
  )
  assert.equal(print.code, 0, print.stderr)
  assert.match(print.stdout, /mock-omp-ok/)
  assert.equal(requestCount, 1)
  assert.equal(
    lastRequestHeaders.authorization,
    "Bearer mock-key",
    "should send the resolved env-var value, not the literal var name",
  )
  assert.equal(lastRequestBody?.model, TEST_MODEL)
  assert.ok(Array.isArray(lastRequestBody?.messages))

  console.log("[omp-compat] PASS")
} finally {
  await new Promise((resolve) => server.close(resolve))
  rmSync(tempHome, { recursive: true, force: true })
}
