import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { promisify } from "node:util"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
  ACCOUNT_STORE_FORMAT,
  ACCOUNT_STORE_VERSION,
  MAX_ACCOUNT_STORE_BYTES,
  MAX_ACCOUNTS,
  MAX_CREDENTIAL_LENGTH,
  MAX_LABEL_LENGTH,
  AccountStoreParseError,
  createAccountStore,
  ensurePrivateDirectory,
  parseAccountStore,
  releasePrivateLock,
  writePrivateFileAtomically,
  acquirePrivateLock,
  type AccountStoreSnapshot,
} from "../src/account-store.ts"

const execFileAsync = promisify(execFile)
const PLACEHOLDER_A = "cc_test_placeholder_alpha"
const PLACEHOLDER_B = "cc_test_placeholder_bravo"
const PLACEHOLDER_C = "cc_test_placeholder_charlie"
const IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
] as const

function lockOwnerPath(lockPath: string, nonce: string): string {
  return join(lockPath, `owner-${nonce}`, "owner.json")
}

async function installTestLock(
  lockPath: string,
  nonce: string,
  owner: Record<string, unknown>,
): Promise<void> {
  await mkdir(join(lockPath, `owner-${nonce}`), { recursive: true, mode: 0o700 })
  await writeFile(lockOwnerPath(lockPath, nonce), JSON.stringify(owner), { mode: 0o600 })
}

function account(
  id: string = IDS[0],
  value: string = PLACEHOLDER_A,
  label = "alpha",
): Record<string, unknown> {
  return {
    id,
    label,
    credential: { kind: "api-key", value },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  }
}

function snapshot(
  accounts: readonly Record<string, unknown>[] = [],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    format: ACCOUNT_STORE_FORMAT,
    version: ACCOUNT_STORE_VERSION,
    revision: 0,
    primaryAccountId: accounts.length > 0 ? accounts[0].id : null,
    accounts,
    ...overrides,
  }
}

function assertParseRejected(value: unknown, reason: AccountStoreParseError["reason"]): void {
  assert.throws(
    () => parseAccountStore(value),
    (error: unknown) => error instanceof AccountStoreParseError && error.reason === reason,
  )
}

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "commandcode-account-store-"))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function childScript(): string {
  return `
    import { createAccountStore } from ${JSON.stringify(new URL("../src/account-store.ts", import.meta.url).href)};
    const store = createAccountStore({ stateDir: process.env.ACCOUNT_STORE_ROOT });
    const action = process.env.ACCOUNT_STORE_ACTION;
    if (action === "add-c") {
      await store.addAccount({ label: "child-c", credential: { kind: "api-key", value: "cc_test_placeholder_charlie" } });
    } else if (action === "add-d-primary") {
      const account = await store.addAccount({ label: "child-d", credential: { kind: "api-key", value: "cc_test_placeholder_delta" } });
      await store.setPrimary(account.id);
    } else {
      throw new Error("unknown child action");
    }
    process.stdout.write("child-complete\\n");
  `
}

async function runChild(root: string, action: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(
    process.execPath,
    ["--import", "tsx/esm", "--input-type=module", "-e", childScript()],
    {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, ACCOUNT_STORE_ROOT: root, ACCOUNT_STORE_ACTION: action },
    },
  )
}

describe("account-store strict parser", () => {
  it("accepts a valid version-1 store and a valid empty store", () => {
    const parsed = parseAccountStore(snapshot([account()]))
    assert.equal(parsed.version, 1)
    assert.equal(parsed.primaryAccountId, IDS[0])
    assert.equal(parsed.accounts[0].credential.kind, "api-key")

    const empty = parseAccountStore(snapshot())
    assert.equal(empty.accounts.length, 0)
    assert.equal(empty.primaryAccountId, null)
  })

  it("rejects non-object JSON values", () => {
    assertParseRejected("null", "corrupt")
    assertParseRejected("[]", "corrupt")
    assertParseRejected('"string"', "corrupt")
  })

  it("rejects malformed format, version, and revision values", () => {
    assertParseRejected(snapshot([], { format: "other-store" }), "corrupt")
    assertParseRejected(snapshot([], { version: 2 }), "unsupported")
    assertParseRejected(snapshot([], { version: 0 }), "unsupported")
    assertParseRejected(snapshot([], { revision: -1 }), "corrupt")
    assertParseRejected(snapshot([], { revision: Number.NaN }), "corrupt")
    assertParseRejected(snapshot([], { revision: Number.POSITIVE_INFINITY }), "corrupt")
  })

  it("requires finite timestamps, UUID ids, unique ids, and one valid primary", () => {
    assertParseRejected(snapshot([account(IDS[0])], { primaryAccountId: IDS[1] }), "corrupt")
    assertParseRejected(snapshot([account("not-an-id")]), "corrupt")
    assertParseRejected(
      snapshot([account(IDS[0]), account(IDS[0], PLACEHOLDER_B, "bravo")]),
      "corrupt",
    )
    assertParseRejected(
      snapshot([account(IDS[0])], {
        accounts: [{ ...account(), createdAt: Number.NaN }],
      }),
      "corrupt",
    )
    assertParseRejected(
      snapshot([account(IDS[0])], {
        accounts: [{ ...account(), updatedAt: Number.POSITIVE_INFINITY }],
      }),
      "corrupt",
    )
  })

  it("requires recognized credentials and bounded account strings", () => {
    assertParseRejected(
      snapshot([{ ...account(), credential: { kind: "oauth", value: PLACEHOLDER_A } }]),
      "corrupt",
    )
    assertParseRejected(
      snapshot([{ ...account(), credential: { kind: "api-key", value: "" } }]),
      "corrupt",
    )
    assertParseRejected(
      snapshot([{ ...account(), label: "l".repeat(MAX_LABEL_LENGTH + 1) }]),
      "corrupt",
    )
    assertParseRejected(
      snapshot([
        {
          ...account(),
          credential: { kind: "api-key", value: "k".repeat(MAX_CREDENTIAL_LENGTH + 1) },
        },
      ]),
      "corrupt",
    )
    const tooMany = Array.from({ length: MAX_ACCOUNTS + 1 }, (_, index) =>
      account(`${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`, `cc_${index}`),
    )
    assertParseRejected(snapshot(tooMany), "corrupt")
  })

  it("enforces the one-megabyte encoded store cap and does not migrate unknown versions", () => {
    const oversized = JSON.stringify(
      snapshot([{ ...account(), label: "x".repeat(MAX_ACCOUNT_STORE_BYTES) }]),
    )
    assert.ok(new TextEncoder().encode(oversized).byteLength > MAX_ACCOUNT_STORE_BYTES)
    assertParseRejected(oversized, "corrupt")

    const unknown = JSON.stringify(snapshot([], { version: 99, extra: "must-not-migrate" }))
    assertParseRejected(unknown, "unsupported")
  })
})

describe("account-store load and private path", () => {
  it("returns absent without creating the state root or files", async () => {
    await withTempRoot(async (agentDir) => {
      const stateRoot = join(agentDir, "commandcode")
      const store = createAccountStore({ stateDir: stateRoot })
      assert.equal(store.stateRoot, stateRoot)
      assert.deepEqual(await store.load(), { kind: "absent" })
      await assert.rejects(stat(stateRoot), { code: "ENOENT" })
    })
  })

  it("resolves the production root below the injected agent directory", () => {
    const store = createAccountStore({ getAgentDir: () => "/tmp/injected-agent" })
    assert.equal(store.stateRoot, "/tmp/injected-agent/commandcode")
  })

  it("distinguishes loaded, corrupt, and unsupported stores", async () => {
    await withTempRoot(async (stateRoot) => {
      const store = createAccountStore({ stateDir: stateRoot })
      await store.addAccount({
        label: "alpha",
        credential: { kind: "api-key", value: PLACEHOLDER_A },
      })
      const loaded = await store.load()
      assert.equal(loaded.kind, "loaded")

      await writeFile(store.storePath, "not-json", { mode: 0o600 })
      const corrupt = await store.load()
      assert.deepEqual(corrupt, { kind: "unavailable", reason: "corrupt" })

      await writeFile(store.storePath, JSON.stringify(snapshot([], { version: 7 })), {
        mode: 0o600,
      })
      const unsupported = await store.load()
      assert.deepEqual(unsupported, { kind: "unavailable", reason: "unsupported" })
    })
  })
})

describe("account-store permissions and redaction", () => {
  it("creates private directories, store, local gitignore, and lock metadata", async () => {
    await withTempRoot(async (stateRoot) => {
      const store = createAccountStore({ stateDir: stateRoot, uuid: () => randomUUID() })
      const created = await store.addAccount({
        label: "alpha",
        credential: { kind: "api-key", value: PLACEHOLDER_A },
      })
      assert.ok(created.id)
      assert.equal((await stat(store.stateRoot)).mode & 0o777, 0o700)
      assert.equal((await stat(store.locksPath)).mode & 0o777, 0o700)
      assert.equal((await stat(store.storePath)).mode & 0o777, 0o600)
      assert.equal((await stat(join(store.stateRoot, ".gitignore"))).mode & 0o777, 0o600)
      const localGitignore = join(store.stateRoot, ".gitignore")
      assert.equal(await readFile(localGitignore, "utf8"), "*\n")
      await writeFile(localGitignore, "unsafe\n", { mode: 0o600 })
      await store.addAccount({
        label: "bravo",
        credential: { kind: "api-key", value: PLACEHOLDER_B },
      })
      assert.equal(await readFile(localGitignore, "utf8"), "*\n")
      assert.doesNotMatch(await readFile(store.storePath, "utf8"), /Bearer\s+\S+/i)
    })
  })

  it("corrects a permissive store before reading and emits only a redacted warning", async () => {
    await withTempRoot(async (stateRoot) => {
      const warnings: string[] = []
      const store = createAccountStore({
        stateDir: stateRoot,
        warning: (message) => warnings.push(message),
      })
      await store.addAccount({
        label: "alpha",
        credential: { kind: "api-key", value: PLACEHOLDER_A },
      })
      await import("node:fs/promises").then(({ chmod }) => chmod(store.storePath, 0o644))
      const loaded = await store.load()
      assert.equal(loaded.kind, "loaded")
      assert.equal((await stat(store.storePath)).mode & 0o777, 0o600)
      assert.ok(warnings.length > 0)
      assert.doesNotMatch(warnings.join("\n"), /placeholder|Bearer|api[-_ ]?key\s*[=:]/i)
    })
  })

  it("refuses symlink and non-regular store paths without reading them", async () => {
    await withTempRoot(async (stateRoot) => {
      const store = createAccountStore({ stateDir: stateRoot })
      await ensurePrivateDirectory(stateRoot)
      await import("node:fs/promises").then(({ symlink }) =>
        symlink("/etc/passwd", store.storePath),
      )
      assert.deepEqual(await store.load(), { kind: "unavailable", reason: "permissions" })
      await rm(store.storePath, { force: true })
      await import("node:fs/promises").then(({ mkdir }) => mkdir(store.storePath))
      assert.deepEqual(await store.load(), { kind: "unavailable", reason: "permissions" })
    })
  })

  it("validates POSIX ownership through the injected owner identity", async () => {
    await withTempRoot(async (stateRoot) => {
      const effectiveUid = process.geteuid?.()
      if (effectiveUid === undefined) return

      const store = createAccountStore({ stateDir: stateRoot, uid: () => effectiveUid })
      await ensurePrivateDirectory(stateRoot, { uid: () => effectiveUid })
      await writeFile(store.storePath, JSON.stringify(snapshot()), { mode: 0o600 })
      assert.deepEqual(await store.load(), {
        kind: "loaded",
        snapshot: parseAccountStore(snapshot()),
      })

      const foreign = createAccountStore({ stateDir: stateRoot, uid: () => effectiveUid + 1 })
      assert.deepEqual(await foreign.load(), { kind: "unavailable", reason: "permissions" })
    })
  })

  it("rejects validation before making any state-directory change", async () => {
    await withTempRoot(async (agentDir) => {
      const stateRoot = join(agentDir, "commandcode")
      const store = createAccountStore({ stateDir: stateRoot })
      await assert.rejects(
        store.addAccount(
          { label: "alpha", credential: { kind: "api-key", value: PLACEHOLDER_A } },
          {
            validate: async () => {
              throw new Error(`validation failed for ${PLACEHOLDER_A}`)
            },
          },
        ),
        (error: unknown) =>
          error instanceof Error &&
          /validation/i.test(error.message) &&
          !error.message.includes(PLACEHOLDER_A),
      )
      await assert.rejects(stat(stateRoot), { code: "ENOENT" })
    })
  })
})

describe("account-store atomic writes and locks", () => {
  it("writes through a private sibling temp file and syncs before rename", async () => {
    await withTempRoot(async (stateRoot) => {
      const store = createAccountStore({ stateDir: stateRoot, uuid: () => IDS[0] })
      await ensurePrivateDirectory(stateRoot)
      const steps: string[] = []
      await writePrivateFileAtomically(store.storePath, "atomic-content\n", {
        uuid: () => IDS[1],
        onStep: (step) => steps.push(step),
      })
      assert.equal(await readFile(store.storePath, "utf8"), "atomic-content\n")
      assert.deepEqual(steps, [
        "open",
        "write",
        "sync",
        "chmod",
        "close",
        "rename",
        "directory-sync",
      ])
      assert.equal((await stat(store.storePath)).mode & 0o777, 0o600)
    })
  })

  it("creates owner metadata privately, releases only a matching nonce, and removes the lock", async () => {
    await withTempRoot(async (stateRoot) => {
      const store = createAccountStore({ stateDir: stateRoot, uuid: () => IDS[0] })
      await ensurePrivateDirectory(store.stateRoot)
      await ensurePrivateDirectory(store.locksPath)
      const lock = await acquirePrivateLock(store.lockPath, {
        uuid: () => IDS[1],
        pid: () => 4242,
        processStartedAt: () => 1_700_000_000_000,
        now: () => 1_700_000_000_010,
        isProcessAlive: () => "alive",
      })
      const ownerPath = lockOwnerPath(store.lockPath, IDS[1])
      const owner = JSON.parse(await readFile(ownerPath, "utf8")) as Record<string, unknown>
      assert.deepEqual(Object.keys(owner).sort(), [
        "acquiredAt",
        "expiresAt",
        "nonce",
        "pid",
        "processStartedAt",
      ])
      assert.equal((await stat(ownerPath)).mode & 0o777, 0o600)
      assert.equal((await stat(join(store.lockPath, `owner-${IDS[1]}`))).mode & 0o777, 0o700)
      assert.equal((await stat(store.lockPath)).mode & 0o777, 0o700)
      assert.equal(owner.nonce, IDS[1])
      assert.equal(owner.pid, 4242)
      assert.doesNotMatch(JSON.stringify(owner), /cc_test_placeholder|Bearer/i)

      assert.equal(await releasePrivateLock(store.lockPath, IDS[2]), false)
      assert.ok((await stat(store.lockPath)).isDirectory())
      assert.equal(await lock.release(), true)
      await assert.rejects(stat(store.lockPath), { code: "ENOENT" })
      assert.equal(await lock.release(), false)
    })
  })

  it("rejects non-finite lock timing and clock injection", async () => {
    await withTempRoot(async (stateRoot) => {
      const store = createAccountStore({ stateDir: stateRoot })
      await ensurePrivateDirectory(store.stateRoot)
      await ensurePrivateDirectory(store.locksPath)
      await assert.rejects(acquirePrivateLock(store.lockPath, { ttlMs: Number.NaN }), /timing/i)
      await assert.rejects(
        acquirePrivateLock(store.lockPath, { lockWaitMs: Number.POSITIVE_INFINITY }),
        /timing/i,
      )
      await assert.rejects(acquirePrivateLock(store.lockPath, { now: () => Number.NaN }), /clock/i)
      await assert.rejects(stat(store.lockPath), { code: "ENOENT" })

      const frozenClock = () => 1_700_000_000_000
      const held = await acquirePrivateLock(store.lockPath, {
        uuid: () => IDS[0],
        now: frozenClock,
      })
      await assert.rejects(
        acquirePrivateLock(store.lockPath, {
          uuid: () => IDS[1],
          now: frozenClock,
          lockWaitMs: 10,
        }),
        /lock is busy/i,
      )
      await held.release()
    })
  })

  it("retires only the validated owner generation so a delayed releaser cannot delete a successor", async () => {
    await withTempRoot(async (stateRoot) => {
      const store = createAccountStore({ stateDir: stateRoot })
      await ensurePrivateDirectory(store.stateRoot)
      await ensurePrivateDirectory(store.locksPath)
      const first = await acquirePrivateLock(store.lockPath, { uuid: () => IDS[1] })

      let ownerValidated: (() => void) | undefined
      const validated = new Promise<void>((resolve) => {
        ownerValidated = resolve
      })
      let allowRemoval: (() => void) | undefined
      const removalGate = new Promise<void>((resolve) => {
        allowRemoval = resolve
      })
      const oldRelease = releasePrivateLock(store.lockPath, first.nonce, {
        afterOwnerRead: async () => {
          ownerValidated?.()
          await removalGate
        },
      })
      await validated

      let competingReleaseResult: boolean | undefined
      const successor = await releasePrivateLock(store.lockPath, first.nonce).then((released) => {
        competingReleaseResult = released
        return acquirePrivateLock(store.lockPath, {
          uuid: () => IDS[2],
          lockWaitMs: 1_000,
        })
      })
      assert.equal(competingReleaseResult, true)
      const owner = JSON.parse(
        await readFile(lockOwnerPath(store.lockPath, successor.nonce), "utf8"),
      ) as Record<string, unknown>
      assert.equal(owner.nonce, successor.nonce)

      allowRemoval?.()
      assert.equal(await oldRelease, false, "the delayed releaser must not retire its successor")
      assert.equal(
        (
          JSON.parse(
            await readFile(lockOwnerPath(store.lockPath, successor.nonce), "utf8"),
          ) as Record<string, unknown>
        ).nonce,
        successor.nonce,
      )
      await successor.release()
    })
  })

  it("finishes an interrupted generation retirement before installing a successor", async () => {
    await withTempRoot(async (stateRoot) => {
      const store = createAccountStore({ stateDir: stateRoot })
      await ensurePrivateDirectory(store.stateRoot)
      await ensurePrivateDirectory(store.locksPath)
      await installTestLock(store.lockPath, IDS[0], {
        nonce: IDS[0],
        pid: 1111,
        processStartedAt: 1_700_000_000_000,
        acquiredAt: 1_700_000_000_000,
        expiresAt: 1_700_000_000_100,
      })
      await rename(
        join(store.lockPath, `owner-${IDS[0]}`),
        join(store.lockPath, `retired-${IDS[0]}`),
      )

      const successor = await acquirePrivateLock(store.lockPath, {
        uuid: () => IDS[1],
        lockWaitMs: 0,
      })
      assert.equal(successor.nonce, IDS[1])
      assert.equal(
        (
          JSON.parse(await readFile(lockOwnerPath(store.lockPath, IDS[1]), "utf8")) as Record<
            string,
            unknown
          >
        ).nonce,
        IDS[1],
      )
      await successor.release()

      await mkdir(store.lockPath, { mode: 0o700 })
      const afterEmptyRoot = await acquirePrivateLock(store.lockPath, {
        uuid: () => IDS[2],
        lockWaitMs: 0,
      })
      assert.equal(afterEmptyRoot.nonce, IDS[2])
      await afterEmptyRoot.release()
    })
  })

  it("takes over expired or demonstrably dead locks but treats ambiguity and EPERM as live", async () => {
    await withTempRoot(async (stateRoot) => {
      const store = createAccountStore({ stateDir: stateRoot })
      await ensurePrivateDirectory(store.stateRoot)
      await ensurePrivateDirectory(store.locksPath)

      const expiredDir = store.lockPath
      await installTestLock(expiredDir, IDS[0], {
        nonce: IDS[0],
        pid: 1111,
        processStartedAt: 1_700_000_000_000,
        acquiredAt: 1_700_000_000_000,
        expiresAt: 1_700_000_000_100,
      })
      const takeover = await acquirePrivateLock(store.lockPath, {
        now: () => 1_700_000_001_000,
        uuid: () => IDS[1],
        isProcessAlive: () => "unknown",
        lockWaitMs: 0,
      })
      assert.equal(takeover.nonce, IDS[1])
      await takeover.release()

      await installTestLock(expiredDir, IDS[0], {
        nonce: IDS[0],
        pid: 1111,
        processStartedAt: 1_700_000_000_000,
        acquiredAt: 1_700_000_000_000,
        expiresAt: 1_700_000_010_000,
      })
      const deadTakeover = await acquirePrivateLock(store.lockPath, {
        now: () => 1_700_000_001_000,
        uuid: () => IDS[2],
        isProcessAlive: () => "dead",
        lockWaitMs: 0,
      })
      assert.equal(deadTakeover.nonce, IDS[2])
      await deadTakeover.release()

      await installTestLock(expiredDir, IDS[0], {
        nonce: IDS[0],
        pid: 1111,
        processStartedAt: 1_700_000_000_000,
        acquiredAt: 1_700_000_000_000,
        expiresAt: 1_700_010_000_000,
      })
      await assert.rejects(
        acquirePrivateLock(store.lockPath, {
          now: () => 1_700_000_001_000,
          uuid: () => IDS[3],
          isProcessAlive: () => "unknown",
          lockWaitMs: 0,
        }),
        /lock/i,
      )
      const stillOwner = JSON.parse(
        await readFile(lockOwnerPath(expiredDir, IDS[0]), "utf8"),
      ) as Record<string, unknown>
      assert.equal(stillOwner.nonce, IDS[0])
    })
  })

  it("retries a read across an atomic replacement and ignores orphan coordination metadata", async () => {
    await withTempRoot(async (stateRoot) => {
      const store = createAccountStore({ stateDir: stateRoot, readRetries: 3 })
      await store.addAccount({
        label: "alpha",
        credential: { kind: "api-key", value: PLACEHOLDER_A },
      })
      const movedPath = `${store.storePath}.rename-race`
      const loadedStore = createAccountStore({
        stateDir: stateRoot,
        readRetries: 3,
        beforeRead: async (attempt) => {
          if (attempt === 0) await rename(store.storePath, movedPath)
          if (attempt === 1) await rename(movedPath, store.storePath)
        },
      })
      const result = await loadedStore.load()
      assert.equal(result.kind, "loaded")
      if (result.kind === "loaded") assert.equal(result.snapshot.accounts[0].label, "alpha")

      await writeFile(
        join(stateRoot, "coordination.json"),
        JSON.stringify({ accountId: IDS[0], cooldownUntil: 9999999999999 }),
        { mode: 0o600 },
      )
      const again = await loadedStore.load()
      assert.equal(again.kind, "loaded")
      assert.doesNotMatch(
        await readFile(join(stateRoot, "coordination.json"), "utf8"),
        /placeholder/i,
      )
    })
  })
})

describe("account-store mutation protocol and process convergence", () => {
  it("increments revisions, deduplicates credentials under the lock, and mutates by stable id", async () => {
    await withTempRoot(async (stateRoot) => {
      let now = 1_700_000_000_000
      let ids = 0
      const store = createAccountStore({
        stateDir: stateRoot,
        now: () => now,
        uuid: () => IDS[ids++ % IDS.length],
      })
      const first = await store.addAccount({
        label: "alpha",
        credential: { kind: "api-key", value: PLACEHOLDER_A },
      })
      assert.equal(first.id, IDS[0])
      let loaded = await store.load()
      assert.equal(loaded.kind, "loaded")
      if (loaded.kind === "loaded") assert.equal(loaded.snapshot.revision, 1)

      now += 100
      const duplicate = await store.addAccount({
        label: "renamed",
        credential: { kind: "api-key", value: PLACEHOLDER_A },
      })
      assert.equal(duplicate.id, first.id)
      loaded = await store.load()
      assert.equal(loaded.kind, "loaded")
      if (loaded.kind === "loaded") {
        assert.equal(loaded.snapshot.revision, 2)
        assert.equal(loaded.snapshot.accounts.length, 1)
        assert.equal(loaded.snapshot.accounts[0].label, "renamed")
      }

      const second = await store.addAccount({
        label: "bravo",
        credential: { kind: "api-key", value: PLACEHOLDER_B },
      })
      await store.setPrimary(second.id)
      loaded = await store.load()
      assert.equal(loaded.kind, "loaded")
      if (loaded.kind === "loaded") {
        assert.equal(loaded.snapshot.primaryAccountId, second.id)
        assert.deepEqual(
          loaded.snapshot.accounts.map((item) => item.id),
          [second.id, first.id],
        )
      }

      await store.removeAccount(first.id)
      loaded = await store.load()
      assert.equal(loaded.kind, "loaded")
      if (loaded.kind === "loaded") {
        assert.deepEqual(
          loaded.snapshot.accounts.map((item) => item.id),
          [second.id],
        )
        assert.equal(loaded.snapshot.accounts[0].credential.value, PLACEHOLDER_B)
      }
    })
  })

  it("serializes concurrent child mutations without lost updates or torn JSON", async () => {
    await withTempRoot(async (stateRoot) => {
      const store = createAccountStore({ stateDir: stateRoot, uuid: () => randomUUID() })
      await store.addAccount({
        label: "alpha",
        credential: { kind: "api-key", value: PLACEHOLDER_A },
      })
      await store.addAccount({
        label: "bravo",
        credential: { kind: "api-key", value: PLACEHOLDER_B },
      })

      const children = await Promise.all([
        runChild(stateRoot, "add-c"),
        runChild(stateRoot, "add-d-primary"),
      ])
      assert.equal(children[0].stdout.trim(), "child-complete")
      assert.equal(children[1].stdout.trim(), "child-complete")
      assert.doesNotMatch(`${children[0].stderr}\n${children[1].stderr}`, /cc_test_placeholder/i)

      const raw = await readFile(store.storePath, "utf8")
      const parsed = parseAccountStore(raw)
      assert.equal(parsed.accounts.length, 4)
      assert.deepEqual(
        new Set(parsed.accounts.map((item) => item.credential.value)),
        new Set([PLACEHOLDER_A, PLACEHOLDER_B, PLACEHOLDER_C, "cc_test_placeholder_delta"]),
      )
      assert.equal(parsed.primaryAccountId, parsed.accounts[0].id)
    })
  })

  it("leaves no credential-bearing coordination orphan for readers after a simulated prune boundary", async () => {
    await withTempRoot(async (stateRoot) => {
      const store = createAccountStore({ stateDir: stateRoot })
      const first = await store.addAccount({
        label: "alpha",
        credential: { kind: "api-key", value: PLACEHOLDER_A },
      })
      await writeFile(
        join(stateRoot, "coordination.json"),
        JSON.stringify({
          accountId: first.id,
          epoch: 1,
          cooldownUntil: 1_700_000_001_000,
        }),
        { mode: 0o600 },
      )
      await store.removeAccount(first.id)
      const loaded = await store.load()
      assert.deepEqual(loaded, {
        kind: "loaded",
        snapshot: {
          format: ACCOUNT_STORE_FORMAT,
          version: ACCOUNT_STORE_VERSION,
          revision: 2,
          primaryAccountId: null,
          accounts: [],
        },
      })
      assert.doesNotMatch(
        await readFile(join(stateRoot, "coordination.json"), "utf8"),
        new RegExp(PLACEHOLDER_A),
      )
      assert.doesNotMatch((await store.load()).kind, /credential/i)
    })
  })
})

void assert // keep the RED test file syntactically complete before implementation
