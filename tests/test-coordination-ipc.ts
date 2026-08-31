import assert from "node:assert/strict"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { describe, it } from "node:test"

import { createAccountStore } from "../src/account-store.ts"
import {
  createCoordinationStore,
  parseCoordination,
  type CoordinationSnapshot,
} from "../src/coordination.ts"

const execFileAsync = promisify(execFile)
const ID_A = "11111111-1111-4111-8111-111111111111"
const ID_B = "22222222-2222-4222-8222-222222222222"
const KEY_SHAPED = "cc_test_placeholder_coordination_ipc"

function childScript(): string {
  return `
    import { createAccountStore } from ${JSON.stringify(new URL("../src/account-store.ts", import.meta.url).href)};
    import { createAccountService } from ${JSON.stringify(new URL("../src/accounts.ts", import.meta.url).href)};
    import { createCoordinationStore } from ${JSON.stringify(new URL("../src/coordination.ts", import.meta.url).href)};
    const root = process.env.COORDINATION_ROOT;
    const now = Number(process.env.COORDINATION_NOW);
    const action = process.env.COORDINATION_ACTION;
    const id = process.env.COORDINATION_ID;
    const nonce = process.env.COORDINATION_NONCE;
    if (!root || !Number.isFinite(now) || !id) throw new Error("invalid fixture environment");
    const store = createCoordinationStore({
      stateDir: root,
      now: () => now,
      uuid: () => nonce ?? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      nonce: () => nonce ?? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      probeWindowMs: 30_000,
      leaseTtlMs: 30_000,
      isProcessAlive: () => "alive",
    });
    if (action === "failure") {
      await store.recordCooldown(id, {
        failureClass: process.env.COORDINATION_CLASS === "rate-limit" ? "rate-limit" : "transient",
        failedAt: now,
        cooldownUntil: Number(process.env.COORDINATION_UNTIL),
        nextProbeAt: Number(process.env.COORDINATION_UNTIL),
      });
      process.stdout.write("failure-complete\\n");
    } else if (action === "lease") {
      const lease = await store.acquireProbe(id);
      process.stdout.write(JSON.stringify({ acquired: lease !== undefined, nonce: lease?.nonce }) + "\\n");
    } else if (action === "hold") {
      const lease = await store.acquireProbe(id);
      process.stdout.write(JSON.stringify({ acquired: lease !== undefined, nonce: lease?.nonce }) + "\\n");
      await new Promise(() => {});
    } else if (action === "plan") {
      const service = createAccountService({
        store: createAccountStore({ stateDir: root, now: () => now }),
        coordination: store,
        now: () => now,
        probeAccount: async () => ({ kind: "unknown" }),
      });
      const plan = await service.planLogicalRequest();
      process.stdout.write(JSON.stringify({ attempts: plan.attempts.map((attempt) => attempt.id), unavailableUntil: plan.unavailableUntil }) + "\\n");
      await service.shutdown();
    } else {
      throw new Error("unknown fixture action");
    }
  `
}

async function runChild(
  root: string,
  action: string,
  overrides: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(
    process.execPath,
    ["--import", "tsx/esm", "--input-type=module", "-e", childScript()],
    {
      cwd: new URL("..", import.meta.url).pathname,
      env: {
        ...process.env,
        COORDINATION_ROOT: root,
        COORDINATION_ACTION: action,
        COORDINATION_ID: ID_A,
        COORDINATION_NOW: "1000",
        COORDINATION_UNTIL: "2000",
        COORDINATION_NONCE: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        ...overrides,
      },
    },
  )
}

function waitForLine(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = ""
    const onData = (chunk: Buffer) => {
      output += chunk.toString()
      const line = output.split("\n")[0]
      if (line) {
        child.stdout?.off("data", onData)
        resolve(line)
      }
    }
    child.stdout?.on("data", onData)
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (!output && code !== null) reject(new Error(`holder exited with ${code}/${signal ?? ""}`))
    })
  })
}

function startHolder(root: string, now: number, nonce: string): ChildProcess {
  return spawn(
    process.execPath,
    ["--import", "tsx/esm", "--input-type=module", "-e", childScript()],
    {
      cwd: new URL("..", import.meta.url).pathname,
      env: {
        ...process.env,
        COORDINATION_ROOT: root,
        COORDINATION_ACTION: "hold",
        COORDINATION_ID: ID_A,
        COORDINATION_NOW: String(now),
        COORDINATION_UNTIL: String(now),
        COORDINATION_NONCE: nonce,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
}

describe("cross-process coordination fixtures", () => {
  it("converges simultaneous initial failures to valid later-deadline state", async () => {
    const root = await mkdtemp(join(tmpdir(), "commandcode-coordination-ipc-"))
    try {
      const children = await Promise.all([
        runChild(root, "failure", {
          COORDINATION_UNTIL: "3000",
          COORDINATION_NONCE: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        }),
        runChild(root, "failure", {
          COORDINATION_UNTIL: "5000",
          COORDINATION_CLASS: "rate-limit",
          COORDINATION_NONCE: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        }),
      ])
      assert.deepEqual(
        children.map((child) => child.stdout.trim()),
        ["failure-complete", "failure-complete"],
      )
      assert.doesNotMatch(
        children.map((child) => child.stderr).join("\n"),
        /placeholder|Bearer|https?:|\/home\//i,
      )
      const store = createCoordinationStore({ stateDir: root })
      const loaded = await store.load()
      assert.equal(loaded.kind, "loaded")
      if (loaded.kind !== "loaded") return
      assert.equal(loaded.snapshot.cooldowns[ID_A]?.cooldownUntil, 5000)
      assert.equal(loaded.snapshot.cooldowns[ID_A]?.epoch, 2)
      const raw = await readFile(store.coordinationPath, "utf8")
      assert.doesNotMatch(raw, new RegExp(KEY_SHAPED))
      assert.doesNotThrow(() => parseCoordination(raw))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("has one deterministic lease winner while the loser does not wait for a probe", async () => {
    const root = await mkdtemp(join(tmpdir(), "commandcode-coordination-ipc-"))
    try {
      const seed = createCoordinationStore({ stateDir: root, now: () => 1000 })
      await seed.recordCooldown(ID_A, {
        failureClass: "transient",
        failedAt: 0,
        cooldownUntil: 1000,
        nextProbeAt: 1000,
      })
      const results = await Promise.all([
        runChild(root, "lease", { COORDINATION_NONCE: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
        runChild(root, "lease", { COORDINATION_NONCE: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
      ])
      const parsed = results.map(
        (child) => JSON.parse(child.stdout) as { acquired: boolean; nonce?: string },
      )
      assert.equal(parsed.filter((result) => result.acquired).length, 1)
      const winner = parsed.find((result) => result.acquired)
      assert.ok(winner?.nonce)
      const loaded = await seed.load()
      assert.equal(loaded.kind, "loaded")
      if (loaded.kind !== "loaded") return
      assert.equal(loaded.snapshot.leases[ID_A]?.nonce, winner?.nonce)
      assert.equal(loaded.snapshot.cooldowns[ID_A]?.nextProbeAt, 31_000)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("takes over a killed holder after the injected TTL without sleep races", async () => {
    const root = await mkdtemp(join(tmpdir(), "commandcode-coordination-ipc-"))
    let holder: ChildProcess | undefined
    try {
      const seed = createCoordinationStore({ stateDir: root, now: () => 1000 })
      await seed.recordCooldown(ID_A, {
        failureClass: "transient",
        failedAt: 0,
        cooldownUntil: 1000,
        nextProbeAt: 1000,
      })
      holder = startHolder(root, 1000, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      assert.deepEqual(JSON.parse(await waitForLine(holder)), {
        acquired: true,
        nonce: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      })
      holder.kill("SIGKILL")
      await new Promise<void>((resolve) => holder?.once("exit", () => resolve()))

      const takeover = await runChild(root, "lease", {
        COORDINATION_NOW: "32001",
        COORDINATION_NONCE: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      })
      assert.deepEqual(JSON.parse(takeover.stdout), {
        acquired: true,
        nonce: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      })
      const loaded = await seed.load()
      assert.equal(loaded.kind, "loaded")
      if (loaded.kind !== "loaded") return
      assert.equal(loaded.snapshot.leases[ID_A]?.nonce, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
    } finally {
      if (holder && holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL")
      await rm(root, { recursive: true, force: true })
    }
  })

  it("keeps healthy fallback planning independent and reports all accounts unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "commandcode-coordination-ipc-"))
    let holder: ChildProcess | undefined
    try {
      const ids = [ID_A, ID_B]
      const accountStore = createAccountStore({
        stateDir: root,
        now: () => 1000,
        uuid: () => ids.shift() ?? ID_B,
      })
      await accountStore.addAccount({
        label: "alpha",
        credential: { kind: "api-key", value: "cc_test_alpha" },
      })
      await accountStore.addAccount({
        label: "bravo",
        credential: { kind: "api-key", value: "cc_test_bravo" },
      })
      const seed = createCoordinationStore({ stateDir: root, now: () => 1000 })
      await seed.recordCooldown(ID_A, {
        failureClass: "transient",
        failedAt: 0,
        cooldownUntil: 1000,
        nextProbeAt: 1000,
      })
      holder = startHolder(root, 1000, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      assert.equal((JSON.parse(await waitForLine(holder)) as { acquired: boolean }).acquired, true)

      const fallback = JSON.parse(
        (await runChild(root, "plan", { COORDINATION_NOW: "1001" })).stdout,
      ) as { attempts: string[]; unavailableUntil?: number }
      assert.deepEqual(fallback.attempts, [ID_B])

      await seed.recordCooldown(ID_B, {
        failureClass: "rate-limit",
        failedAt: 1001,
        cooldownUntil: 2001,
        nextProbeAt: 2001,
      })
      const unavailable = JSON.parse(
        (await runChild(root, "plan", { COORDINATION_NOW: "1001" })).stdout,
      ) as { attempts: string[]; unavailableUntil?: number }
      assert.deepEqual(unavailable.attempts, [])
      assert.equal(unavailable.unavailableUntil, 2001)

      const loaded = await seed.load()
      assert.equal(loaded.kind, "loaded")
      if (loaded.kind !== "loaded") return
      assert.equal(loaded.snapshot.leases[ID_A]?.nonce, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      assert.equal(loaded.snapshot.cooldowns[ID_B]?.cooldownUntil, 2001)
    } finally {
      if (holder && holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL")
      await rm(root, { recursive: true, force: true })
    }
  })
})

void ID_B
void ({} as CoordinationSnapshot)
