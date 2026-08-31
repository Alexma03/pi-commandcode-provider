# Technical Design: add-multi-account-failover

Status: proposed
Change: `add-multi-account-failover`
Scope: this repository; no runtime dependency is added

## 1. Design summary

The extension gains one deep account service that hides credential persistence, process-safe health coordination, ordering, and recovery scheduling. A pool-aware stream wrapper sits above the existing per-account transport router. In pool mode this wrapper owns the complete logical-request attempt budget: it disables lower-level same-account retries, selects each account at most once, buffers every account attempt until the first content-bearing event, discards failed pre-content attempts, and commits exactly one `start` plus the winning or terminal attempt. The existing single-account path is bypassed only when a valid, non-empty extension store exists.

The design intentionally changes stale proposal assumptions where required to match the authoritative specifications:

1. Caller cancellation is always terminal and never changes account health.
2. Compatibility means observable equivalence, not byte-identical implementation.
3. Cross-process leases coordinate only recovery/availability probes for cooled accounts; healthy generation traffic never acquires a lease.
4. Structured failure provenance requires a narrow hook in `src/core.ts` and a native-transport capture adapter. Classification is not reconstructed from user-facing error text.
5. In pool mode, one account attempt means one selection of one credential with `maxRetries: 0`. Same-account provider-to-generate transport negotiation for `upgrade_required` remains inside that selection and is not an account retry.

Only Node built-ins are used (`node:crypto`, `node:fs/promises`, `node:os`, and `node:path`).

## 2. Module boundaries

### 2.1 New modules

| Module                    | Stable interface                                                                          | Complexity hidden                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `src/account-store.ts`    | Load and atomically mutate a versioned account store                                      | path resolution, permissions, schema validation, lock directories, stale lock recovery, fsync/rename, corruption states |
| `src/coordination.ts`     | Read/update cooldowns and acquire/release fenced probe leases                             | process-local merge, cross-process locking, convergence, lease TTL, stale holders, permission handling                  |
| `src/accounts.ts`         | Account management, ordered request plans, health updates, status, opportunistic recovery | credentials, primary ordering, legacy mode, cooldown state machine, quota snapshot cache                                |
| `src/account-commands.ts` | Register add/list/remove/set-primary commands                                             | Pi prompt/select adapters, safe account selection, redacted notifications                                               |
| `src/failover.ts`         | Classify structured failures and create a pool-aware stream                               | bounded rotation, abort provenance, event buffering, terminal error selection                                           |

`accounts.ts` is the main deep module. Callers do not manipulate JSON records, lock files, cooldown epochs, or credential labels directly.

### 2.2 Existing modules with narrow changes

- `src/core.ts` emits a structured terminal-attempt outcome to an internal callback before it emits an `error` event. It also records abort origin explicitly in its retry machinery. Pool calls force `maxRetries: 0`; legacy calls preserve the supplied retry options. This structured hook is required because message parsing at the outer wrapper would be unsafe.
- `src/transport.ts` keeps the existing router behavior but adds per-account router instances and native failure capture. In pool mode it propagates the coordinator's `maxRetries: 0` through every selected transport. `upgrade_required` remains same-account provider-to-generate transport negotiation and is never treated as either an account failure or an additional account attempt.
- `src/oauth.ts` exposes the existing browser/paste acquisition flow as a reusable function returning the validated API key plus a normalized identity. Existing host `/login` delegates to it and keeps its current credential return shape.
- `src/quota.ts` exports normalized account identity parsing and a pure availability interpretation. It does not invent provider response strings.
- `src/quota-command.ts`, `src/runtime.ts`, and `index.ts` wire commands, status, quota selection, lifecycle cleanup, and the pool stream.

## 3. State directory and private files

### 3.1 Resolution

The state root is exactly:

```text
join(getAgentDir(), "commandcode")
```

`getAgentDir()` already honors Pi's configured agent directory (`PI_CODING_AGENT_DIR`) and the host's rebranded config directory. A `stateDir` dependency override is available only to tests. The extension does not use the current workspace, `$XDG_STATE_HOME`, or a repository directory because account health and credentials are account-global and must be shared by concurrent Pi processes.

The root contains:

```text
commandcode/
  .gitignore
  accounts.json
  coordination.json
  locks/
```

The state root and `locks/` are mode `0700`; every regular file, temporary file, and lock owner file is mode `0600`. The local `.gitignore` contains `*` so a custom agent directory placed inside a checkout still ignores the whole state subtree. The repository `.gitignore` also gains a defensive `.pi/agent/commandcode/` rule. Default installations remain outside Git.

Directories and files are checked with `lstat`; symlinks and non-regular files are refused. On POSIX, ownership must match the effective user. A permissive directory or file is corrected with `chmod` before any credential read. If correction fails, the file is not read and a redacted warning is returned.

### 3.2 Credential schema

`accounts.json` version 1 is:

```json
{
  "format": "pi-commandcode-account-store",
  "version": 1,
  "revision": 4,
  "primaryAccountId": "opaque UUID",
  "accounts": [
    {
      "id": "opaque UUID",
      "label": "normalized whoami keyName or login",
      "credential": { "kind": "api-key", "value": "credential material" },
      "createdAt": 1770000000000,
      "updatedAt": 1770000000000
    }
  ]
}
```

Account IDs are generated with `randomUUID()`. They are stable, non-secret identifiers and are never derived from, hashed from, or correlated with an API key. Coordination metadata therefore remains credential-free. Duplicate login compares credential values only in private memory while holding the account-store lock; no key hash is persisted. Re-adding the same key updates its label and returns its existing ID instead of creating a duplicate.

The stored label is selected from validated `whoami.keyName`, then `whoami.login`, then `Account <short account ID>`. Control characters are removed, length is capped, and existing redaction is applied. A label equal to the credential or reduced to an unsafe/empty value is replaced by the generated fallback. Output always applies redaction again and never shows partial or masked key material.

The parser is strict: format/version, finite timestamps/revision, unique UUID IDs, one valid primary, recognized credential kind, bounded strings, a bounded account count, and a 1 MiB file-size cap. Unknown fields may be ignored for forward-compatible readers, but an unknown version is not migrated.

### 3.3 Absence, corruption, and migration

Store loading returns a discriminated result:

```ts
type AccountStoreLoad =
  | { kind: "absent" }
  | { kind: "loaded"; snapshot: AccountStoreSnapshot }
  | { kind: "unavailable"; reason: "permissions" | "corrupt" | "unsupported" | "io" }
```

- `absent`, or a valid version-1 store with zero accounts, activates the existing single-account path without creating any state files.
- Existing Pi/OMP auth files remain read-only and are neither copied nor migrated.
- A corrupt, unsupported, insecure, or unreadable store fails closed for pool generation and management. It is not silently treated as empty, because that could unexpectedly send traffic through a legacy credential or overwrite recoverable accounts. Status reports a redacted remediation message; it never includes parsed file contents.
- There is no automatic schema migration in this slice. Rollback can leave or delete the local version-1 file; old extension versions ignore it.

### 3.4 Atomic mutation and process safety

All account mutations follow this protocol:

1. Validate remote credentials before taking a filesystem lock.
2. Build a complete private candidate directory containing `owner-<nonce>/owner.json`, then atomically rename that candidate to `locks/accounts.lock`. The lock and owner-generation directory are mode `0700`; `owner.json` is mode `0600` and contains only nonce, PID, process-start timestamp, and acquisition/expiry timestamps.
3. Re-read and validate the latest store while holding the lock.
4. Apply the mutation by stable account ID and increment `revision`.
5. Write a uniquely named sibling temporary file with `open("wx", 0600)`, write all bytes, `fsync` it, `chmod(0600)`, and rename it over `accounts.json`.
6. `fsync` the containing directory where supported, then release only a lock whose owner nonce still matches.

Readers do not take the mutation lock; atomic rename gives them either the previous or next complete revision. A bounded retry handles a transient rename/read race. Lock acquisition atomically installs a fully written nonce-specific owner generation. Release and stale recovery first rename only `owner-<validated nonce>` to `retired-<validated nonce>` inside the lock root, then clean that retired generation and remove the lock root only if it is still empty. The retired name makes cleanup resumable after a crash, and an empty root left between final generation cleanup and root removal is also recognized and removed safely before acquisition. Lock contention uses a monotonic elapsed clock rather than the injectable wall clock, so a frozen or regressing wall clock cannot defeat the bounded wait. If another actor already retired that generation and installed a successor, the old actor's nonce-specific owner path is absent and it stops without renaming or deleting the successor. `EPERM` or an ambiguous PID is treated as live until TTL expiry. Temporary credential files are private and are removed under the next lock.

Add, remove, and set-primary re-read under lock, so concurrent command processes serialize without lost updates. Removal commits the credential deletion first, then prunes coordination state. A crash between those writes can leave only an orphaned credential-free cooldown record, which readers ignore and later mutations garbage-collect. An in-flight request may finish with a credential already copied into memory, but every subsequent failover attempt revalidates membership; removal affects all future attempts and requests.

## 4. Account service API and lifecycle

The internal API is deliberately small:

```ts
type AccountId = string

type AccountMode =
  | { kind: "legacy" }
  | { kind: "pool"; revision: number }
  | { kind: "unavailable"; message: string }

interface AccountAttempt {
  readonly id: AccountId
  readonly label: string
  readonly apiKey: string // internal transport boundary only
}

interface LogicalRequestPlan {
  readonly revision: number
  readonly attempts: readonly AccountAttempt[]
  readonly unavailableUntil?: number
}

interface AccountService {
  mode(): Promise<AccountMode>
  planLogicalRequest(): Promise<LogicalRequestPlan>
  isStillConfigured(id: AccountId, revision: number): Promise<boolean>
  recordEligibleFailure(id: AccountId, failure: EligibleFailure): Promise<void>
  recordSuccess(id: AccountId, attemptStartedAt: number): Promise<void>
  add(acquired: AcquiredAccount): Promise<AccountPublicView>
  remove(id: AccountId): Promise<void>
  setPrimary(id: AccountId): Promise<void>
  listStatus(): Promise<readonly AccountStatusView[]>
  refreshQuota(id: AccountId): Promise<QuotaSnapshotResult>
  shutdown(): void
}
```

Raw credentials never appear in `AccountPublicView`, `AccountStatusView`, errors, or command completion data. `planLogicalRequest()` returns primary-first healthy accounts in stored order and excludes cooling, probe-due, probing, removed, and already-tried accounts. The failover wrapper owns the per-logical-request tried set.

One `AccountService` is created in `index.ts` per extension instance. It lazily reads the store and coordination revision. It creates no directory, timer, watcher, or network activity for an absent pool. Each logical request checks the atomically replaceable store so another process's add/remove/primary change becomes visible. Bounded probes start only when request or command activity discovers a due account. `session_shutdown` aborts outstanding probes; no long-lived startup resources are created.

Primary changes apply to the next logical request. `active` in status means the last successful account in this process, or the currently first selectable account if no request has succeeded. It is explicitly process-local; there is no false claim of one global active account.

## 5. Multi-login and command UX

The extension registers four explicit commands:

- `/commandcode-account-add`
- `/commandcode-accounts`
- `/commandcode-account-remove [account-id]`
- `/commandcode-account-primary [account-id]`

Add accepts no credential in slash arguments, autocomplete, notifications, or command history. It waits for the local agent to become idle, then adapts Pi's documented `ctx.ui.input()` and `ctx.ui.notify()` methods to the existing browser/paste callbacks:

1. The existing choice prompt offers browser, explicit paste, or directly pasted input.
2. Browser mode displays the safe authorization URL and uses the existing localhost callback/state validation; callback failure falls back to paste.
3. Paste input goes through existing paste-marker/control-character sanitization.
4. Both browser and paste results are validated through `/alpha/whoami` before storage. Validation returns normalized `keyName`/`login`; a successful HTTP status with an unrecognized identity is rejected for pool storage.
5. Only the redacted label and generated account ID are notified after the atomic write.

The host OAuth `/login` remains supported and still writes only the host-owned auth record. Refactoring shares acquisition/validation but does not redirect or migrate host credentials into the pool.

Remove and set-primary accept only a full opaque account ID. With no argument and interactive UI, `ctx.ui.select()` displays redacted label plus ID and returns the hidden selected ID; remove also asks for confirmation. Non-interactive contexts require the ID and still never accept a key. Management commands wait for local idle before mutation; status does not. Missing, ambiguous, cancelled, and stale selections produce redacted errors.

`/commandcode-accounts` displays ID, order, redacted label, process-local active marker, health (`healthy`, `cooling`, `probe due`, or `probing`), cooldown remaining, and process-local quota snapshot age. It never displays a key fragment. `/commandcode-status` appends only a summary and coordination warning; detailed account rows stay in the explicit account command.

## 6. Structured failure contract

### 6.1 Metadata

The classifier consumes only this internal shape:

```ts
type AbortOrigin = "caller" | "runtime-timeout" | "runtime-abort"

type TransportFailure = {
  source: "generate" | "native"
  phase: "payload" | "request" | "response" | "stream"
  kind: "http" | "network" | "abort" | "stream" | "unknown"
  status?: number
  retryAfterMs?: number
  providerCode?: string
  providerType?: string
  streamReason?: "upstream-connection" | "truncated"
  abortOrigin?: AbortOrigin
}
```

Raw bodies and user-facing messages are not classifier inputs. A bounded cloned error body may be parsed at the transport boundary only to extract documented machine fields (`code`, `type`); it is immediately discarded. New body/reason rules require an exact tested machine-field pattern in a narrow allowlist. There are no invented quota strings.

### 6.2 Generate transport hook and attempt budget

`src/core.ts` gains an internal `onTerminalFailure(failure)` option. Precise HTTP status and `Retry-After` are recorded before body formatting; fetch failures retain their error class; parsed stream events set a structured reason at the point they are understood. The callback runs exactly once when that invocation reaches its terminal failure and before the terminal `error` event is pushed. It does not classify, sleep, mutate cooldown, or initiate another request; the pool coordinator consumes the captured outcome when it consumes the corresponding terminal stream error.

In pool mode, the failover coordinator owns the complete attempt budget. For every selected account it clones the request options, overrides `apiKey`, and forces `maxRetries: 0` through both generate and native transport paths. No retry loop or provider adapter below the coordinator may retry the same credential. Consequently, the terminal-failure callback is delivered after that account's single invocation, not after a same-account retry sequence. The generate path records HTTP status and parsed `Retry-After` before retry-policy handling; when `maxRetries: 0`, it MUST skip retry-delay calculation, cap-rejection errors, and `delay()` entirely, preserving the original response as the terminal failure. On an eligible pre-content terminal failure, cleanup and the required bounded cooldown update occur without a retry delay, and the coordinator immediately selects the next healthy untried account. The coordinator caps the recorded `Retry-After` against the cooldown maximum and uses it only for `cooldownUntil`; pool-mode generation never sleeps on it.

Legacy/empty-pool mode does not install pool attempt-budget behavior. It passes the original request options unchanged, including any caller-supplied `maxRetries` and the existing capped `Retry-After` retry behavior, so same-account retries and their observable timing remain exactly as before.

### 6.3 Native provider capture

The native Provider API converts SDK errors into ordinary stream errors, so the outer layer cannot safely recover status or abort origin from `errorMessage`. `transport.ts` therefore wraps the injected `fetch` for the two currently selected native APIs (OpenAI completions and Anthropic messages):

- it records non-OK HTTP status, normalized headers, and bounded structured machine fields;
- it records thrown fetch/network errors by class;
- it wraps the returned response body so a read failure is captured as network/stream provenance before the SDK converts it;
- it observes the caller signal and the provider-created request signal separately.

If the caller signal initiated cancellation, provenance is `caller`. If the provider request signal aborts while the caller signal has not, provenance is runtime-owned timeout/abort. This is based on which signal initiated abort, not elapsed-time or message text. An `aborted` event without recorded runtime provenance defaults to caller/unknown and never fails over.

The existing `upgrade_required` JSON check runs before account classification. Its provider events and captured 403 are discarded, and generate is attempted with the same credential, with `maxRetries: 0` still in force. This provider-to-generate fallback is transport negotiation within one account attempt: it may issue one provider request followed by one generate request, but it consumes only one account selection and never permits reselection or same-account retry. Only a terminal failure after negotiation is reported to the pool coordinator; if eligible and pre-content, that failure moves to the next untried account. Other 401/403 responses are marked account-scoped only when they occurred on the authenticated Command Code generation endpoint before a stream was accepted; explicit transport-capability, request, policy, or content machine categories remain ineligible. Unknown attribution defaults to never-failover.

If a future native adapter stops supporting custom fetch or hides a failure before this capture boundary, that signal remains ineligible until `@earendil-works/pi-ai` exposes a narrow structured failure callback. The design does not compensate with message guessing.

### 6.4 Classification

`classifyFailure()` is pure and closed by default. Eligible results are exactly:

- HTTP 408;
- HTTP 429;
- HTTP 500-599;
- structured network/connection failure with no caller abort;
- runtime-owned timeout or abort;
- account-scoped 401/403.

Caller abort, every other 4xx, payload/request/schema/context/tool/policy/content error, an unknown stream error, and all unrecognized combinations return `never-failover`. Existing context-overflow normalization remains host-side and is not a failover signal.

## 7. Failover stream and event boundary

`createFailoverStream({ accounts, streamAccount, classify, createStream })` returns the host stream synchronously and performs this asynchronous flow:

1. Load mode. `legacy` directly pipes the existing legacy router with the original options, retry settings, Retry-After behavior, and key precedence; no pool classifier, attempt-budget override, or cooldown mutation participates.
2. In pool mode, capture an immutable primary-first plan and an empty tried set. The coordinator is the sole owner of the logical request's account-attempt budget.
3. Before every account attempt, check that the account still exists, add it to `tried`, clone the options, override `apiKey` with its credential, and force `maxRetries: 0`. Marking `tried` before transport creation ensures no error path can reselect that account.
4. Start that account once and consume its stream into an attempt buffer. `start` and all pre-content metadata stay buffered. An `upgrade_required` provider-to-generate fallback may occur inside this one account attempt as transport negotiation, but both legs keep `maxRetries: 0` and the account remains one tried entry.
5. On the first `thinking_start`, `text_start`, or `toolcall_start`, commit the buffered `start` once, forward the boundary event, and pipe the rest. Any later error is forwarded redacted with no switch.
6. A pre-content `done` commits one `start` and `done` and records success.
7. A pre-content ineligible error, caller cancellation, or unknown failure commits that attempt's one `start` and terminal error and stops. Caller cancellation immediately aborts stream work, attempts no other account, and records no cooldown or penalty.
8. On a pre-content eligible terminal error, consume the structured failure callback for that same attempt. Do not forward the failed buffer, invoke retry-delay/cap-rejection policy, sleep, or perform a same-account retry. Complete stream cleanup and the required bounded process-local/shared cooldown update; use capped `Retry-After` only when calculating `cooldownUntil`; then immediately select the next healthy untried account.
9. If no account remains, commit only the last eligible attempt's buffered `start` plus its redacted terminal error. If no attempt was possible because all accounts were cooling/probing, emit one synthetic redacted unavailable error with the earliest retry time.

This boundary is stronger than merely tolerating repeated `start`: failed pre-content attempts emit neither duplicate `start` nor intermediate error. Tool calls become committed at `toolcall_start`, before host-side execution, so an account is never switched after a possible side effect. Attempt cancellation and stream cleanup complete before the next account starts. The immediate-switch rule removes only retry-delay waiting; it does not bypass the bounded atomic cooldown propagation or fenced probe semantics in sections 8 and 9.

## 8. Cooldown and recovery state machine

Durable health states are derived from coordination records:

```text
healthy
  -- eligible terminal failure --> cooling
cooling
  -- cooldownUntil reached --> probe-due (still excluded from ordinary traffic)
probe-due
  -- fenced lease acquired --> probing
probing
  -- verified available --> healthy
  -- unavailable/eligible probe failure --> cooling with later deadline
  -- crash/lease expiry --> probe-due after stale recovery
```

A successful ordinary request clears process-local penalty state. Durable cooldown is cleared by a fenced successful probe; an ordinary request that began healthy does not clear a newer concurrent failure written by another process. This conservative rule prevents an older in-flight success from erasing newer health evidence.

Defaults are centralized and injectable:

| Setting                                     |             Default | Rationale                                                       |
| ------------------------------------------- | ------------------: | --------------------------------------------------------------- |
| transient 408/5xx/network/timeout cooldown  |          60 seconds | parks bursts without hiding recovery for long                   |
| 429 cooldown                                |           5 minutes | quota/rate failures usually need a longer pause                 |
| account-auth cooldown                       |          15 minutes | invalid credentials rarely recover immediately                  |
| maximum cooldown / Retry-After contribution |          15 minutes | all parking remains bounded                                     |
| recovery probe window                       |          30 seconds | bounds probe frequency across processes                         |
| probe lease TTL                             |          30 seconds | exceeds the bounded probe timeout and recovers crashes promptly |
| metadata lock TTL                           |          10 seconds | mutations contain no network calls and should be brief          |
| quota snapshot TTL                          |           5 minutes | status/recovery is useful without per-request quota traffic     |
| quota/probe timeout                         | existing 15 seconds | reuses the quota transport bound                                |

For a 429, cooldown is `max(base429, capped Retry-After)`; the cap applies even if legacy request retry capping is configured differently. In pool mode this value is scheduling metadata only: generation does not sleep before switching accounts. Cooldown updates converge by taking the later deadline and incrementing an account epoch. Quota snapshots are advisory and process-local. Generation never synchronously fetches quota on every request.

When a request notices an expired cooled account, it opportunistically schedules a non-blocking recovery probe and immediately serves on a healthy fallback. The probe uses the existing bounded quota/whoami flow. Auth/transient recovery requires a valid recognized account response; quota recovery additionally requires recognized positive credits or an unexhausted numeric window. Missing/ambiguous quota data does not prove recovery. Explicit `/commandcode-quota` updates the same cache and may provide a recovery signal. No response-message signature is assumed.

If all accounts are unavailable, the triggering request terminates rather than waiting for a probe. The user may retry after the asynchronous probe updates state.

## 9. Cross-process coordination

### 9.1 Schema

`coordination.json` contains no labels, workspace paths, URLs, errors, or credentials:

```json
{
  "format": "pi-commandcode-coordination",
  "version": 1,
  "revision": 12,
  "cooldowns": {
    "opaque account UUID": {
      "epoch": 3,
      "failureClass": "rate-limit",
      "failedAt": 1770000000000,
      "cooldownUntil": 1770000300000,
      "nextProbeAt": 1770000330000
    }
  },
  "leases": {
    "opaque account UUID": {
      "nonce": "random UUID",
      "pid": 1234,
      "processStartedAt": 1769999000000,
      "acquiredAt": 1770000300000,
      "expiresAt": 1770000330000,
      "cooldownEpoch": 3,
      "fence": 13
    }
  }
}
```

It uses the same strict permissions, bounded parser, lock-directory primitive, temp-file/fsync/rename protocol, and stale lock recovery as the account store. Corrupt coordination is credential-free: under the coordination lock it is atomically quarantined to a mode-0600 nonce name and replaced with a valid empty record, with a redacted warning. If permissions cannot be corrected, shared coordination is refused and the process continues with process-local cooldown only after emitting a visible redacted degradation warning; divergence is never silent.

### 9.2 Cooldown propagation

Eligible failure updates process-local state immediately, then performs a bounded atomic coordination mutation before failover completes. Concurrent writers merge by account ID: later cooldown deadline wins, latest failure metadata is selected only by the serialized mutation, and epoch increments. Readers merge disk and process-local records conservatively. Atomic rename prevents torn reads; the short metadata lock prevents lost updates.

No lock is acquired to select or send traffic to a healthy account. Concurrent ordinary requests, in one process or many, proceed independently. Concurrent initial failures may all occur before propagation, as allowed by the spec, but their updates converge.

### 9.3 Probe lease

Probe acquisition is one atomic coordination mutation under the short global metadata lock:

1. Re-read cooldown and lease state.
2. Reject acquisition if cooldown is not due, `nextProbeAt` is in the future, or a fresh lease exists.
3. Recover an expired or demonstrably dead lease.
4. Write a new nonce, expiry, cooldown epoch, and monotonic fence; set `nextProbeAt = now + probeWindow` in the same atomic replacement.
5. Return the credential only after the lease transaction succeeds.

Probe result application reacquires the metadata lock and succeeds only if nonce, fence, and cooldown epoch still match. A newer failure therefore fences out a stale successful probe. Release is compare-by-nonce; it cannot release a successor's lease. PID liveness permits early recovery only on a demonstrable local `ESRCH`; TTL is the portable crash guarantee.

Other processes that lose lease acquisition neither wait nor retry the lock in the request path. They keep the recovering account excluded and serve ordinary requests on healthy fallbacks. The global metadata lock may briefly serialize probe/cooldown metadata mutations across accounts, but it never gates healthy generation traffic.

## 10. Quota and status behavior

With an absent pool, `/commandcode-quota` keeps current host-registry and env/auth-file precedence and output. With a pool, no argument selects the configured primary; an optional account ID selects another stored account. The explicit quota command may wait for its own network result because the user requested it, but generation never does.

A successful quota fetch stores only an in-memory normalized snapshot keyed by opaque account ID. Snapshot age may be shown; raw quota bodies and org identifiers are not written to coordination state. A verified availability result can complete a fenced recovery probe. A quota endpoint's 429 remains non-fatal exactly as today and is not converted into an invented generation quota message.

All command, status, warning, and terminal-error strings pass through `redactValue`/`redactDiagnosticText` at the last output boundary. Internals persist failure classes, never provider bodies or formatted errors.

## 11. Compatibility and rollback

The compatibility branch is explicit: if `accounts.json` is absent or valid and empty, `index.ts` calls the same legacy transport stream with the entire `options` object unchanged, including the configured `maxRetries` value and existing Retry-After handling. Provider name, host key precedence, model metadata, API base, event order, default `maxRetries: 0`, quota behavior, transport fallback semantics, surfaced errors, and observable timing remain unchanged. No pool callback, classifier, cooldown update, or attempt-budget override participates. Internal asynchronous wiring may differ, but observable output must not.

Pool mode is additive. Host-owned auth files are never written. Existing `/login`, `/commandcode-refresh`, `/commandcode-status`, and `/commandcode-quota` remain available. Pool commands use distinct names and do not shadow Pi built-ins.

Rollback is code-only: revert pool/failover wiring and leave `getConfiguredApiKey` behavior intact. The private version-1 files can remain because old code does not read them, or the user can delete the state directory. No migration reversal or host-auth repair is required. If coordination is unavailable, process-local behavior remains functional with a visible degraded warning.

## 12. Security properties

- Credentials exist only in the private account file, short-lived login values, and internal attempt objects.
- External IDs are random UUIDs, never API-key hashes.
- No key fragment is shown as an identifier.
- Store and coordination paths reject symlinks, insecure modes, oversized files, and malformed schemas.
- Atomic temp files and lock owners use private modes from creation, not a later chmod alone.
- Error body parsing extracts bounded machine fields and never logs or persists the body.
- Status, thrown errors, notifications, and final stream errors are redacted at module exits.
- Normal failover emits no switch notification or diagnostic.
- Existing Gitleaks and Semgrep gates remain required; synthetic placeholders remain the only credential-like test values.

## 13. Test seams and verification design

Implementation exposes dependency injection for `stateDir`, wall clock, UUID/nonce generation, PID/liveness check, lock delay, fetch, and stream creation. Filesystem behavior is exercised with real temporary directories rather than a broad virtual filesystem abstraction. Child-process fixtures cover actual atomic `mkdir`/rename behavior. Injected clocks advance cooldown and lease TTL without sleeps.

Stable-interface verification should cover:

- strict version-1 parsing, absent-store legacy mode, permissions, symlink refusal, corruption, atomic replacement, stale lock takeover, and concurrent add/remove/primary mutations;
- identity validation and every browser/paste command path without ever accepting a key as a command argument;
- pure classifier tables, especially caller abort versus runtime timeout, account-scoped auth, unknown defaults, and no unverified body strings;
- pool attempt-budget ownership: even when input options request retries, every selected account receives `maxRetries: 0`, produces at most one terminal account attempt, and an eligible pre-content failure switches without a same-account retry;
- failure callback timing: one structured callback for the selected account's terminal failure, captured before its terminal stream error and consumed without callback-side sleep or routing;
- Retry-After separation: with pool `maxRetries: 0`, a large value preserves the original 429 terminal provenance instead of producing the legacy retry-cap error, is capped into cooldown metadata, never calls injected `delay`, does not delay fallback selection, and never causes the failed account to be revisited;
- legacy compatibility with nonzero retry options: empty-pool requests preserve existing same-account retry count, Retry-After timing, events, and errors unchanged;
- `upgrade_required` negotiation: provider then generate with the same credential counts as one account attempt, keeps `maxRetries: 0` on both legs, and switches accounts only after an eligible terminal generate failure;
- event buffering: failed attempts expose no `start` or error, the winner exposes one `start`, and post-content failure never switches;
- caller cancellation with retries requested still terminates immediately, attempts no other account, and writes no cooldown;
- per-request at-most-once ordering and removal/reorder races;
- local parallel healthy traffic, local probe single-flight, cross-process cooldown propagation, concurrent writer convergence, one fenced probe winner, crash recovery, and stale result fencing;
- quota cache TTL and proof-of-recovery rules without request-path quota fetches;
- observable single-account equivalence in existing unit, transport, Pi-local, authenticated, isolated, and OMP compatibility surfaces;
- secret assertions over notifications, errors, state metadata, stdout/stderr, and status.

Likely existing test files affected are `tests/helpers.ts`, `test-oauth.ts`, `test-runtime.ts`, `test-quota.ts`, `test-quota-command.ts`, `test-retry.ts`, `test-abort.ts`, `test-transport.ts`, and `test-pi-local.mjs`, with focused account/failover/coordination suites added. This section defines seams and evidence only; it is not an implementation task list.

## 14. Alternatives and trade-offs

### One JSON store versus credential and coordination files

Rejected: combining credentials, cooldowns, and leases in one file. It makes every health update rewrite credentials, expands lock contention, and unnecessarily exposes credential bytes to recovery coordination. Separate files permit credential-free frequent coordination and orphan cleanup after removal.

### API-key hash as account identity

Rejected. Even a one-way hash is derived from credential material and would put credential-correlated data into coordination/status surfaces. Random IDs are stable without that coupling.

### Lock-free rename only

Rejected. Rename prevents torn files but does not prevent lost updates from two read-modify-write processes. Atomic lock directories plus rename provide serialization without a dependency.

### Locking every generation request

Rejected. It would violate the process-coordination spec and create a throughput bottleneck. Healthy requests use lock-free snapshots; only cooldown mutations and recovery probes touch coordination locks.

### Treating cooldown expiry as an ordinary primary request

Rejected. Several processes would all send recovery traffic at once. Expiry makes a probe due; one fenced probe runs while ordinary traffic continues on fallback accounts.

### Synchronous quota preflight per request

Rejected. It adds latency, consumes quota endpoints, can itself rate-limit, and relies on stale advisory data. Response classification drives failover; quota is cached and used only for explicit status or recovery probes.

### Parsing final error messages

Rejected. Both local and native transports redact/format errors and lose provenance. The narrow core callback and native fetch/body capture preserve structured facts before formatting.

### Keeping same-account retries below pool failover

Rejected. Allowing `maxRetries > 0` inside a selected pool account would consume more than one try for that account, could sleep on Retry-After before a healthy fallback, and would contradict the logical request's at-most-once bound. Pool mode therefore trades repeated transient attempts on one credential for deterministic bounded rotation and faster eligible failover. Legacy/empty-pool mode retains the existing retry policy and timing unchanged. The `upgrade_required` provider-to-generate fallback is retained because it negotiates transport for one credential rather than retrying an account after terminal failure.

### Forwarding each attempt's `start`

Rejected even though existing retry behavior may tolerate it. Buffering until content or terminal completion gives a cleaner observable contract and guarantees no duplicate start/error from discarded accounts at modest pre-content memory cost.

### External lock/database dependency

Rejected for this local 2-5 account scope. SQLite or a lock package would add installation and supply-chain cost. Node atomic `mkdir`, private files, fencing, and rename are sufficient for the required local-process model.

## 15. File-level impact

Expected production/documentation surfaces for later implementation:

- New: `src/account-store.ts`, `src/coordination.ts`, `src/accounts.ts`, `src/account-commands.ts`, `src/failover.ts`.
- Modified narrowly: `index.ts`, `src/types.ts`, `src/core.ts`, `src/transport.ts`, `src/oauth.ts`, `src/quota.ts`, `src/quota-command.ts`, `src/runtime.ts`, `.gitignore`, and `README.md`.
- Test surfaces: the files named in section 13 plus focused new suites.
- Unchanged: model catalog, pricing/cost, JSON schema conversion, overflow normalization semantics, auth callback security model, and Pi/OMP-owned auth-file formats.

The exact native failure hook must remain local to `transport.ts`. If installed `pi-ai` behavior proves that a required native signal bypasses custom fetch/body capture, implementation must pause and propose a narrow upstream structured-outcome hook rather than broaden classification with message matching.

## 16. Review workload and chained delivery implications

The complete outcome is too cross-cutting for one credible 400-line review. Under ask-on-risk, implementation should be approved as a chained delivery before apply. Likely review boundaries are:

1. private filesystem primitives and versioned credential store;
2. reusable validated login identity plus account commands;
3. structured generate/native failure metadata and the closed classifier;
4. account service, per-account transport registry, and buffered failover stream;
5. cooldown coordination, fenced recovery probes, quota/status integration, docs, and end-to-end hardening.

These are dependency boundaries, not tasks. Earlier units should not be released as a partially active product: pool request routing is enabled only when the orchestrator and coordination contract are present, and the branch is delivered only after the full spec outcome is verified. If any boundary exceeds the 400-line review budget, the parent must ask before proceeding rather than reduce the product behavior or weaken security/concurrency evidence.
