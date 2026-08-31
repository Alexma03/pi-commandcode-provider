import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { describe, it } from "node:test"

import { createAccountStore } from "../src/account-store.ts"
import { createAccountService, type AccountService } from "../src/accounts.ts"
import { createCoordinationStore } from "../src/coordination.ts"
import { createFailoverStream } from "../src/failover.ts"
import { createStreamCommandCode } from "../src/core.ts"
import type { AssistantMessageEvent, StreamOptions } from "../src/types.ts"
import { collectEvents, createTestEventStream, makeContext, makeModel } from "./helpers.ts"

const execFileAsync = promisify(execFile)
const KEY_A = "cc_test_placeholder_e2e_primary"
const KEY_B = "cc_test_placeholder_e2e_fallback"
const ID_A = "11111111-1111-4111-8111-111111111111"
const ID_B = "22222222-2222-4222-8222-222222222222"

type PrimaryFailure = 429 | 408 | 502 | 401 | "connection-reset" | "success"

interface E2EServer {
  readonly baseUrl: string
  setPrimaryFailure(failure: PrimaryFailure): void
  requests(): readonly string[]
  close(): Promise<void>
}

function successBody(text: string): string {
  return [
    `data: ${JSON.stringify({ type: "text-delta", text })}\n`,
    `data: ${JSON.stringify({ type: "finish", finishReason: "stop" })}\n`,
  ].join("")
}

async function startE2EServer(): Promise<E2EServer> {
  let primaryFailure: PrimaryFailure = "success"
  const seenRequests: string[] = []
  const server: Server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/alpha/generate") {
      response.writeHead(404)
      response.end("not found")
      return
    }

    const authorization = request.headers.authorization ?? ""
    const account = authorization === `Bearer ${KEY_A}` ? "primary" : "fallback"
    seenRequests.push(account)
    request.on("data", () => {})
    request.on("end", () => {
      if (account === "primary" && primaryFailure !== "success") {
        if (primaryFailure === "connection-reset") {
          response.destroy()
          return
        }
        response.writeHead(primaryFailure, { "content-type": "application/json" })
        response.end(
          JSON.stringify({
            error: {
              code: primaryFailure === 401 ? "account_unauthorized" : "transient_failure",
              message: `upstream Authorization: Bearer ${KEY_A}`,
            },
          }),
        )
        return
      }

      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end(successBody(`served-by-${account}`))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("mock server did not bind")
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    setPrimaryFailure(failure) {
      primaryFailure = failure
    },
    requests: () => [...seenRequests],
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "commandcode-multi-account-e2e-"))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function createPool(
  root: string,
  now: { value: number },
  options: { coordination?: boolean } = {},
): Promise<AccountService> {
  let nextId = 0
  const store = createAccountStore({
    stateDir: root,
    uuid: () => [ID_A, ID_B][nextId++] ?? ID_B,
    now: () => now.value,
  })
  const coordination = options.coordination
    ? createCoordinationStore({ stateDir: root, now: () => now.value })
    : undefined
  const service = createAccountService({
    store,
    coordination,
    now: () => now.value,
    probeAccount: async () => ({ kind: "available" }),
  })
  await service.add({ apiKey: KEY_A, keyName: "primary", login: "primary" })
  await service.add({ apiKey: KEY_B, keyName: "fallback", login: "fallback" })
  return service
}

function streamFor(
  service: AccountService,
  apiBase: string,
  now: { value: number },
  diagnostics: string[],
) {
  const generate = createStreamCommandCode({
    createStream: createTestEventStream,
    calculateCost: () => {},
    apiBase,
    fetchImpl: fetch,
    env: {},
    authPaths: [],
    cwd: () => "/repo",
    now: () => now.value,
    uuid: () => "44444444-4444-4444-8444-444444444444",
    delay: async () => {},
  })
  return createFailoverStream({
    accounts: service,
    createStream: createTestEventStream,
    streamLegacy: () => {
      diagnostics.push("legacy")
      return generate(makeModel(), makeContext(), {})
    },
    streamAccount: (_account, model, context, options?: StreamOptions) =>
      generate(model, context, options),
  })
}

function crossProcessPlanScript(): string {
  return `
    import { createAccountStore } from ${JSON.stringify(new URL("../src/account-store.ts", import.meta.url).href)};
    import { createAccountService } from ${JSON.stringify(new URL("../src/accounts.ts", import.meta.url).href)};
    import { createCoordinationStore } from ${JSON.stringify(new URL("../src/coordination.ts", import.meta.url).href)};
    const root = process.env.ACCOUNT_STATE_ROOT;
    const service = createAccountService({
      store: createAccountStore({ stateDir: root }),
      coordination: createCoordinationStore({ stateDir: root, now: () => 3_000_000 }),
      now: () => 3_000_000,
    });
    const plan = await service.planLogicalRequest();
    process.stdout.write(JSON.stringify(plan.attempts.map((account) => account.id)));
  `
}

describe("hermetic multi-account failover", () => {
  it("silently switches after every verified pre-content failure class", async () => {
    const server = await startE2EServer()
    try {
      for (const failure of [429, 408, 502, "connection-reset", 401] as const) {
        await withRoot(async (root) => {
          const now = { value: 2_000_000 }
          const service = await createPool(root, now)
          const diagnostics: string[] = []
          server.setPrimaryFailure(failure)
          const stream = streamFor(service, `${server.baseUrl}`, now, diagnostics)
          const events = await collectEvents(stream(makeModel(), makeContext(), {}))

          assert.deepEqual(
            events.map((event) => event.type),
            ["start", "text_start", "text_delta", "text_end", "done"],
            String(failure),
          )
          assert.deepEqual(server.requests().slice(-2), ["primary", "fallback"], String(failure))
          assert.deepEqual(diagnostics, [])
          assert.ok(service.getHealth(ID_A), `primary should be cooled after ${failure}`)
          assert.doesNotMatch(JSON.stringify(events), /cc_test_placeholder|Bearer/i)
        })
      }
    } finally {
      await server.close()
    }
  })

  it("returns to primary after cooldown recovery and shares cooldowns with a child process", async () => {
    const server = await startE2EServer()
    try {
      await withRoot(async (root) => {
        const now = { value: 3_000_000 }
        const service = await createPool(root, now, { coordination: true })
        const diagnostics: string[] = []
        server.setPrimaryFailure(429)
        const stream = streamFor(service, server.baseUrl, now, diagnostics)
        const first = await collectEvents(stream(makeModel(), makeContext(), {}))
        assert.equal(first.at(-1)?.type, "done")

        const child = await execFileAsync(
          process.execPath,
          ["--import", "tsx/esm", "--input-type=module", "-e", crossProcessPlanScript()],
          {
            cwd: new URL("..", import.meta.url).pathname,
            env: { ...process.env, ACCOUNT_STATE_ROOT: root },
          },
        )
        assert.deepEqual(JSON.parse(child.stdout), [ID_B])
        assert.equal(child.stderr, "")
        assert.doesNotMatch(
          `${child.stdout}\n${child.stderr}`,
          /cc_test_placeholder|Bearer|\/home\//i,
        )

        now.value += 5 * 60 * 1000
        server.setPrimaryFailure("success")
        const fallbackAfterExpiry = await collectEvents(stream(makeModel(), makeContext(), {}))
        assert.equal(fallbackAfterExpiry.at(-1)?.type, "done")
        let recoveredPlan = await service.planLogicalRequest()
        for (
          let turn = 0;
          turn < 1_000 && !recoveredPlan.attempts.some((account) => account.id === ID_A);
          turn += 1
        ) {
          await new Promise<void>((resolve) => setImmediate(resolve))
          recoveredPlan = await service.planLogicalRequest()
        }
        assert.deepEqual(
          recoveredPlan.attempts.map((account) => account.id),
          [ID_A, ID_B],
        )
        const recovered = await collectEvents(stream(makeModel(), makeContext(), {}))
        assert.equal(recovered.at(-1)?.type, "done")
        assert.equal(server.requests().at(-1), "primary")
        assert.deepEqual(diagnostics, [])
      })
    } finally {
      await server.close()
    }
  })
})
