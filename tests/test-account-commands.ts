import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, it } from "node:test"
import { promisify } from "node:util"

import { registerCommandCodeAccountCommands } from "../src/account-commands.ts"
import { createAccountStore, parseAccountStore } from "../src/account-store.ts"
import { createAccountService, type AccountService } from "../src/accounts.ts"
import { acquireCommandCodeAccount } from "../src/oauth.ts"
import { commandCodeIdentityFromWhoami } from "../src/quota.ts"

const execFileAsync = promisify(execFile)
const KEY_A = "cc_test_placeholder_account_alpha"
const KEY_B = "cc_test_placeholder_account_bravo"
const KEY_C = "cc_test_placeholder_account_charlie"
const KEY_D = "cc_test_placeholder_account_delta"
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "commandcode-accounts-"))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function commandChildScript(): string {
  return `
    import { registerCommandCodeAccountCommands } from ${JSON.stringify(new URL("../src/account-commands.ts", import.meta.url).href)};
    import { createAccountStore } from ${JSON.stringify(new URL("../src/account-store.ts", import.meta.url).href)};
    import { createAccountService } from ${JSON.stringify(new URL("../src/accounts.ts", import.meta.url).href)};
    let add;
    const api = { registerCommand(name, options) { if (name === "commandcode-account-add") add = options.handler; } };
    const service = createAccountService({ store: createAccountStore({ stateDir: process.env.ACCOUNT_STORE_ROOT }) });
    registerCommandCodeAccountCommands(api, {
      service,
      acquireAccount: async () => ({ apiKey: process.env.ACCOUNT_KEY, login: process.env.ACCOUNT_LABEL }),
    });
    if (!add) throw new Error("add command was not registered");
    await add("", {
      ui: {
        input: async () => undefined,
        select: async () => undefined,
        confirm: async () => true,
        notify: () => {},
      },
      waitForIdle: async () => {},
    });
    process.stdout.write("command-complete\\n");
  `
}

async function runCommandChild(root: string, key: string, label: string) {
  return execFileAsync(
    process.execPath,
    ["--import", "tsx/esm", "--input-type=module", "-e", commandChildScript()],
    {
      cwd: new URL("..", import.meta.url).pathname,
      env: {
        ...process.env,
        ACCOUNT_STORE_ROOT: root,
        ACCOUNT_KEY: key,
        ACCOUNT_LABEL: label,
      },
    },
  )
}

function identityResponse(identity: unknown, status = 200): Response {
  return new Response(JSON.stringify(identity), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("validated account acquisition", () => {
  it("normalizes recognized whoami identity and rejects unrecognized shapes", () => {
    assert.deepEqual(
      commandCodeIdentityFromWhoami({
        org: { id: "org-1", login: "  team-login  " },
        user: { keyName: "  primary-key  " },
      }),
      { login: "team-login", orgId: "org-1", keyName: "primary-key" },
    )
    assert.equal(commandCodeIdentityFromWhoami({ user: {} }), null)
    assert.equal(commandCodeIdentityFromWhoami({ org: { login: "\u0000\n" } }), null)
  })

  it("returns a sanitized API key plus identity without exposing it through callbacks", async () => {
    const prompts: string[] = []
    const authUrls: string[] = []
    const acquired = await acquireCommandCodeAccount(
      {
        onAuth: ({ url }) => authUrls.push(url),
        onPrompt: async ({ message }) => {
          prompts.push(message)
          return `\u001b[200~ ${KEY_A}\n\u001b[201~`
        },
      },
      {
        fetchImpl: async (_input, init) => {
          assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${KEY_A}`)
          return identityResponse({ user: { userName: "alex", keyName: "main" } })
        },
      },
    )

    assert.deepEqual(acquired, { apiKey: KEY_A, login: "alex", keyName: "main" })
    assert.equal(authUrls.length, 0)
    assert.doesNotMatch(prompts.join("\n"), new RegExp(KEY_A))
  })

  it("falls back from an unusable browser callback and still validates identity", async () => {
    const previousTimeout = process.env.COMMANDCODE_AUTH_TIMEOUT_MS
    const originalFetch = globalThis.fetch
    const prompts: string[] = []
    const authUrls: string[] = []
    let promptCount = 0
    try {
      process.env.COMMANDCODE_AUTH_TIMEOUT_MS = "1"
      globalThis.fetch = async () => {
        throw new Error("unexpected global fetch")
      }
      const acquired = await acquireCommandCodeAccount(
        {
          onAuth: ({ url }) => authUrls.push(url),
          onPrompt: async ({ message }) => {
            prompts.push(message)
            promptCount += 1
            return promptCount === 1 ? "" : KEY_A
          },
        },
        { fetchImpl: async () => identityResponse({ user: { userName: "alex" } }) },
      )
      assert.deepEqual(acquired, { apiKey: KEY_A, login: "alex" })
      assert.equal(authUrls.length, 1)
      assert.doesNotMatch(JSON.stringify({ prompts, authUrls }), new RegExp(KEY_A))
    } finally {
      globalThis.fetch = originalFetch
      if (previousTimeout === undefined) delete process.env.COMMANDCODE_AUTH_TIMEOUT_MS
      else process.env.COMMANDCODE_AUTH_TIMEOUT_MS = previousTimeout
    }
  })

  it("rejects invalid or unrecognized identity without returning credential material", async () => {
    for (const response of [
      () => identityResponse({ error: "denied" }, 401),
      () => identityResponse({ user: {} }),
    ]) {
      await assert.rejects(
        acquireCommandCodeAccount(
          {
            onAuth: () => {},
            onPrompt: async () => KEY_A,
          },
          { fetchImpl: async () => response() },
        ),
        (error: unknown) => error instanceof Error && !error.message.includes(KEY_A),
      )
    }
  })
})

describe("account service core", () => {
  it("keeps an absent or valid-empty store in legacy mode without creating files", async () => {
    await withTempRoot(async (agentRoot) => {
      const stateRoot = join(agentRoot, "commandcode")
      const service = createAccountService({ store: createAccountStore({ stateDir: stateRoot }) })
      assert.deepEqual(await service.mode(), { kind: "legacy" })
      await assert.rejects(stat(stateRoot), { code: "ENOENT" })

      const store = createAccountStore({ stateDir: stateRoot })
      const added = await store.addAccount({
        label: "temporary",
        credential: { kind: "api-key", value: KEY_A },
      })
      await store.removeAccount(added.id)
      assert.deepEqual(await createAccountService({ store }).mode(), { kind: "legacy" })
    })
  })

  it("fails closed on unavailable state with a redacted remediation", async () => {
    await withTempRoot(async (stateRoot) => {
      const store = createAccountStore({ stateDir: stateRoot })
      await writeFile(join(stateRoot, "accounts.json"), "not-json", { mode: 0o600 })
      const mode = await createAccountService({ store }).mode()
      assert.equal(mode.kind, "unavailable")
      if (mode.kind === "unavailable") {
        assert.match(mode.message, /unavailable/i)
        assert.doesNotMatch(mode.message, /not-json|placeholder|Bearer/i)
      }
    })
  })

  it("adds, deduplicates, labels, reorders, removes, and prunes by stable id", async () => {
    await withTempRoot(async (stateRoot) => {
      const pruned: string[] = []
      const store = createAccountStore({ stateDir: stateRoot })
      const service = createAccountService({
        store,
        pruneAccountState: async (id) => {
          pruned.push(id)
        },
      })

      const first = await service.add({ apiKey: KEY_A, keyName: " primary\u0000 ", login: "alex" })
      assert.match(first.id, ID_PATTERN)
      assert.equal(first.label, "primary")
      assert.ok(!("apiKey" in first) && !("credential" in first))

      const duplicate = await service.add({ apiKey: KEY_A, keyName: "renamed", login: "alex" })
      assert.equal(duplicate.id, first.id)
      assert.equal(duplicate.label, "renamed")

      const second = await service.add({ apiKey: KEY_B, login: "bravo" })
      assert.notEqual(second.id, first.id)
      await service.setPrimary(second.id)
      let listed = await service.listStatus()
      assert.deepEqual(
        listed.map((account) => [account.id, account.label, account.order, account.primary]),
        [
          [second.id, "bravo", 1, true],
          [first.id, "renamed", 2, false],
        ],
      )
      assert.equal(listed.filter((account) => account.active).length, 1)
      assert.equal(listed[0].active, true)
      assert.equal(listed[0].health, "healthy")
      assert.equal(listed[0].retryAfter, undefined)
      assert.doesNotMatch(JSON.stringify(listed), /cc_test_placeholder|Bearer/i)

      await service.remove(first.id)
      listed = await service.listStatus()
      assert.deepEqual(
        listed.map((account) => account.id),
        [second.id],
      )
      assert.deepEqual(pruned, [first.id])
      const loaded = await store.load()
      assert.equal(loaded.kind, "loaded")
      if (loaded.kind === "loaded") {
        assert.deepEqual(
          loaded.snapshot.accounts.map((account) => account.id),
          [second.id],
        )
      }
    })
  })

  it("uses an opaque-id fallback label and returns redacted unknown-id errors", async () => {
    await withTempRoot(async (stateRoot) => {
      const service = createAccountService({
        store: createAccountStore({ stateDir: stateRoot }),
      })
      const added = await service.add({
        apiKey: KEY_A,
        keyName: `unsafe-${KEY_A}`,
        login: "\u0000\n",
      })
      assert.equal(added.label, `Account ${added.id.slice(0, 8)}`)

      await assert.rejects(
        service.setPrimary("11111111-1111-4111-8111-111111111111"),
        (error: unknown) =>
          error instanceof Error &&
          /unknown .*account/i.test(error.message) &&
          !error.message.includes(KEY_A),
      )
    })
  })
})

type Handler = (args: string, context: CommandContext) => Promise<void>

class CommandApi {
  readonly commands = new Map<string, Handler>()

  registerCommand(name: string, options: { description: string; handler: Handler }): void {
    this.commands.set(name, options.handler)
  }
}

class CommandContext {
  readonly notifications: Array<{ message: string; type?: "info" | "warning" | "error" }> = []
  readonly inputs: string[] = []
  readonly selections: string[][] = []
  readonly confirmations: Array<{ title: string; message: string }> = []
  waitCalls = 0
  nextInput: string | undefined
  nextSelection: string | undefined
  nextConfirmation = true

  readonly ui = {
    input: async (_title: string, _placeholder?: string) => this.nextInput,
    select: async (_title: string, options: string[]) => {
      this.selections.push(options)
      return this.nextSelection
    },
    confirm: async (title: string, message: string) => {
      this.confirmations.push({ title, message })
      return this.nextConfirmation
    },
    notify: (message: string, type?: "info" | "warning" | "error") => {
      this.notifications.push({ message, type })
    },
  }

  async waitForIdle(): Promise<void> {
    this.waitCalls += 1
  }
}

async function commandFixture(
  run: (fixture: {
    api: CommandApi
    context: CommandContext
    service: AccountService
    stateRoot: string
  }) => Promise<void>,
): Promise<void> {
  await withTempRoot(async (stateRoot) => {
    const api = new CommandApi()
    const context = new CommandContext()
    const service = createAccountService({ store: createAccountStore({ stateDir: stateRoot }) })
    registerCommandCodeAccountCommands(api, {
      service,
      acquireAccount: async () => ({ apiKey: KEY_A, keyName: "primary", login: "alex" }),
    })
    await run({ api, context, service, stateRoot })
  })
}

describe("account management commands", () => {
  it("registers four commands and adds through interactive acquisition only", async () => {
    await commandFixture(async ({ api, context, service }) => {
      assert.deepEqual(
        [...api.commands.keys()],
        [
          "commandcode-account-add",
          "commandcode-accounts",
          "commandcode-account-remove",
          "commandcode-account-primary",
        ],
      )

      const add = api.commands.get("commandcode-account-add")
      assert.ok(add)
      await add(KEY_A, context)
      assert.equal((await service.listStatus()).length, 0)
      assert.equal(context.waitCalls, 0)
      assert.doesNotMatch(JSON.stringify(context.notifications), new RegExp(KEY_A))

      await add("", context)
      assert.equal(context.waitCalls, 1)
      const accounts = await service.listStatus()
      assert.equal(accounts.length, 1)
      assert.match(context.notifications.at(-1)?.message ?? "", new RegExp(accounts[0].id))
      assert.doesNotMatch(JSON.stringify(context.notifications), new RegExp(KEY_A))
    })
  })

  it("lists without waiting and selects hidden ids for primary and removal", async () => {
    await commandFixture(async ({ api, context, service }) => {
      const first = await service.add({ apiKey: KEY_A, keyName: "alpha", login: "alex" })
      const second = await service.add({ apiKey: KEY_B, keyName: "bravo", login: "bravo" })

      const list = api.commands.get("commandcode-accounts")
      const primary = api.commands.get("commandcode-account-primary")
      const remove = api.commands.get("commandcode-account-remove")
      assert.ok(list && primary && remove)

      await list("", context)
      assert.equal(context.waitCalls, 0)
      assert.doesNotMatch(context.notifications.at(-1)?.message ?? "", /cc_test_placeholder/i)

      await primary(second.id, context)
      assert.equal(context.waitCalls, 1)
      assert.equal((await service.listStatus())[0].id, second.id)

      const beforeSelectionCount = context.selections.length
      context.nextSelection = `2. alpha (${first.id})`
      await remove("", context)
      assert.equal(context.selections.length, beforeSelectionCount + 1)
      assert.ok(context.selections.at(-1)?.some((option) => option.includes(first.id)))

      assert.equal(context.confirmations.length, 1)
      assert.equal(context.waitCalls, 2)
      assert.deepEqual(
        (await service.listStatus()).map((account) => account.id),
        [second.id],
      )
      assert.doesNotMatch(
        JSON.stringify({
          notifications: context.notifications,
          selections: context.selections,
          confirmations: context.confirmations,
        }),
        /cc_test_placeholder/i,
      )
    })
  })

  it("renders human health, cooldown, quota age, and process-local active markers", async () => {
    const api = new CommandApi()
    const context = new CommandContext()
    const service = {
      listStatus: async () => [
        {
          id: "11111111-1111-4111-8111-111111111111",
          label: "primary",
          order: 1,
          primary: true,
          active: true,
          health: "probe-due" as const,
          retryAfter: 1_500,
          quotaSnapshotAge: 4_000,
        },
      ],
    } as unknown as AccountService
    registerCommandCodeAccountCommands(api, { service })

    const list = api.commands.get("commandcode-accounts")
    assert.ok(list)
    await list("", context)
    const output = context.notifications.at(-1)?.message ?? ""
    assert.match(output, /probe due/)
    assert.match(output, /process-local/)
    assert.match(output, /cooldown 1500ms/)
    assert.match(output, /quota snapshot age 4000ms/)
    assert.match(output, /11111111-1111-4111-8111-111111111111/)
    assert.doesNotMatch(output, /cc_test_placeholder|Bearer/i)
  })

  it("serializes two child-process command mutations without revision loss", async () => {
    await withTempRoot(async (stateRoot) => {
      const children = await Promise.all([
        runCommandChild(stateRoot, KEY_C, "charlie"),
        runCommandChild(stateRoot, KEY_D, "delta"),
      ])
      assert.deepEqual(
        children.map((child) => child.stdout.trim()),
        ["command-complete", "command-complete"],
      )
      assert.doesNotMatch(
        children.map((child) => child.stderr).join("\n"),
        /cc_test_placeholder|Bearer/i,
      )

      const store = createAccountStore({ stateDir: stateRoot })
      const parsed = parseAccountStore(await readFile(store.storePath, "utf8"))
      assert.equal(parsed.revision, 2)
      assert.deepEqual(
        new Set(parsed.accounts.map((account) => account.credential.value)),
        new Set([KEY_C, KEY_D]),
      )
    })
  })

  it("handles cancellation and stale ids with redacted errors", async () => {
    await commandFixture(async ({ api, context, service }) => {
      const remove = api.commands.get("commandcode-account-remove")
      const primary = api.commands.get("commandcode-account-primary")
      assert.ok(remove && primary)

      context.nextSelection = undefined
      await remove("", context)
      assert.equal(context.waitCalls, 0)
      assert.match(context.notifications.at(-1)?.message ?? "", /cancelled|no .*account/i)

      await service.add({ apiKey: KEY_A, keyName: "alpha", login: "alex" })
      await primary("11111111-1111-4111-8111-111111111111", context)
      assert.equal(context.waitCalls, 0)
      assert.equal(context.notifications.at(-1)?.type, "error")
      assert.doesNotMatch(JSON.stringify(context.notifications), /cc_test_placeholder|Bearer/i)
    })
  })

  it("leaves the account store byte-for-byte unchanged when acquisition fails", async () => {
    await withTempRoot(async (stateRoot) => {
      const store = createAccountStore({ stateDir: stateRoot })
      const service = createAccountService({ store })
      await service.add({ apiKey: KEY_A, keyName: "alpha", login: "alex" })
      const storePath = join(stateRoot, "accounts.json")
      const before = await readFile(storePath)
      const api = new CommandApi()
      const context = new CommandContext()
      registerCommandCodeAccountCommands(api, {
        service,
        acquireAccount: async () => {
          throw new Error(`Rejected ${KEY_B}`)
        },
      })

      const add = api.commands.get("commandcode-account-add")
      assert.ok(add)
      await add("", context)
      assert.deepEqual(await readFile(storePath), before)
      assert.equal(context.notifications.at(-1)?.type, "error")
      assert.doesNotMatch(JSON.stringify(context.notifications), /cc_test_placeholder|Bearer/i)
    })
  })

  it("redacts credential-like material from private-store labels at every output boundary", async () => {
    await withTempRoot(async (stateRoot) => {
      const store = createAccountStore({ stateDir: stateRoot })
      await store.addAccount({
        label: `unsafe-${KEY_A}`,
        credential: { kind: "api-key", value: KEY_B },
      })
      const api = new CommandApi()
      const context = new CommandContext()
      registerCommandCodeAccountCommands(api, {
        service: createAccountService({ store }),
      })

      const list = api.commands.get("commandcode-accounts")
      assert.ok(list)
      await list("", context)
      assert.match(context.notifications.at(-1)?.message ?? "", /\[redacted\]/i)
      assert.doesNotMatch(JSON.stringify(context.notifications), new RegExp(KEY_A))
    })
  })

  it("does not modify the three documented host-owned auth files", async () => {
    await withTempRoot(async (fakeHome) => {
      const sentinels = [
        join(fakeHome, ".commandcode", "auth.json"),
        join(fakeHome, ".pi", "agent", "auth.json"),
        join(fakeHome, ".omp", "agent", "auth.json"),
      ]
      for (const path of sentinels) {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, "host-owned-sentinel\n")
      }
      const before = await Promise.all(
        sentinels.map(async (path) => ({
          path,
          text: await readFile(path, "utf8"),
          mtime: (await stat(path)).mtimeMs,
        })),
      )

      const api = new CommandApi()
      const context = new CommandContext()
      registerCommandCodeAccountCommands(api, {
        service: createAccountService({
          store: createAccountStore({ stateDir: join(fakeHome, ".pi", "agent", "commandcode") }),
        }),
        acquireAccount: async () => ({ apiKey: KEY_A, keyName: "primary", login: "alex" }),
      })
      const add = api.commands.get("commandcode-account-add")
      assert.ok(add)
      await add("", context)

      for (const entry of before) {
        assert.equal(await readFile(entry.path, "utf8"), entry.text)
        assert.equal((await stat(entry.path)).mtimeMs, entry.mtime)
      }
    })
  })
})
