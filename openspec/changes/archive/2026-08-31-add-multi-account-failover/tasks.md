# Implementation Tasks: add-multi-account-failover

Status: applied — all work units and parent gates complete; ready for verify
Change ID: `add-multi-account-failover`
Test runner: `npm test` (typecheck + TypeScript unit suites + Node.js Pi/OMP suites; non-live)
Delivery strategy: `ask-on-risk` (per `openspec/config.yaml`; risk decision resolved by the user as `feature-branch-chain`)

## Review Workload Forecast

| Field                                    | Value                                                                                                                                                                                               |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope breadth (qualitative)              | Large and cross-cutting: 5 new modules, 9 narrowly modified files, and 7 focused new/extended test suites spanning storage/atomicity, process coordination, streaming orchestration, and command UX |
| Review-load risk (qualitative)           | High — dense atomicity/security invariants, cross-process concurrency proofs, and stream event-buffering semantics each demand focused reviewer attention                                           |
| Suggested split                          | Six natural cohesive work units (WU 1 → WU 6) behind a feasibility gate (WU 0); tests stay with their implementation; no unit is split or compressed for size reasons                               |
| Chained PRs recommended                  | Yes — for reviewer cognitive load and domain cohesion, not because of any numeric threshold                                                                                                         |
| Delivery strategy                        | ask-on-risk — risk decision resolved by the user; implementation route is `feature-branch-chain`                                                                                                    |
| Chain strategy                           | feature-branch-chain — current `feat/multi-account-failover` is the tracker                                                                                                                         |
| Integration target                       | `custom/main`; `main` remains the upstream mirror                                                                                                                                                   |
| Branch/commit/PR creation for this phase | None                                                                                                                                                                                                |

```text
Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
Integration target: custom/main (main remains upstream mirror)
Tracker: feat/multi-account-failover
Next route: verify
WU 0 feasibility: positive and parent-confirmed for later WU 3
```

Sizing policy note (per explicit user instruction): this plan intentionally contains **no numeric changed-line estimates and no numeric review-budget thresholds**. Work-unit boundaries and the chained recommendation are justified solely by qualitative complexity, density, cohesion, affected domains, interface/test burden, and reviewer cognitive load. `Decision needed before apply: No` records that the user has resolved the qualitative delivery path; it does not reduce the architectural breadth or review risk.

Parent-owned lifecycle rows remain byte-for-byte unchanged; the resolved chain context above is authoritative for the next apply route.

## Corrected semantics enforced by this plan

These are binding for every work unit and every test written under them:

1. **Caller cancellation is terminal.** A caller-originated abort never fails over, never retries, and never records cooldown or penalty; provenance is tracked by signal identity, never by timing or message text.
2. **Pool mode forces `maxRetries: 0` per selected account.** The failover coordinator owns the whole logical-request attempt budget; no lower layer retries the same credential; legacy mode keeps caller-supplied retry options and Retry-After timing unchanged.
3. **`upgrade_required` provider-to-generate negotiation is transport negotiation, not an account retry.** It consumes exactly one account selection, keeps `maxRetries: 0` on both legs, and only a terminal failure after negotiation reaches the coordinator.
4. **Process leases coordinate only recovery/availability probes.** Healthy-account selection and ordinary generation traffic never acquire a lock, lease, or single-flight gate — intra-process or cross-process.
5. **No message guessing.** Classification consumes only the structured `TransportFailure` shape captured before error formatting; unknown signals default to `never-failover`; extending the body/reason allowlist requires a new tested machine-field pattern.
6. **Observable legacy compatibility.** With an absent or valid-empty store, events, errors, key precedence, command behavior, retry timing, provider name, apiBase, and compat metadata are observably equivalent to the pre-change path; internal wiring may differ.
7. **Feature gating is structural.** Pool generation routing is wired in the final work unit only, after the orchestrator, coordination contract, and probes all exist and verify; earlier chain units remain inert for routing.

## Global constraints (apply to every work unit)

- **Allowed edit surfaces** are listed per work unit below and are cumulative; nothing outside them may be mutated. `src/core.ts` receives only the narrow structured-failure hook; `src/converters.ts`, `src/models.ts`, `src/pricing.ts`, `src/cost.ts`, `src/json-schema.ts`, `src/overflow.ts`, `src/auth-server.ts` stay untouched.
- **Strict TDD** (`config.yaml: strict_tdd: true`): every behavior task lands as RED → GREEN → TRIANGULATE → REFACTOR with recorded evidence (see below). No implementation line before its failing test exists.
- **Secrets:** no credential material in code, tests, fixtures, logs, notifications, state metadata, or OpenSpec artifacts. Tests use synthetic placeholders (`COMMAND_CODE_PLACEHOLDER_KEYS`) and mock servers only. **No live credentials and no real-account quota exhaustion are required anywhere in this plan.**
- **Lockfiles/dependencies:** `package-lock.json` must remain byte-identical for the entire change. No new runtime or dev dependencies — Node built-ins only (`node:crypto`, `node:fs/promises`, `node:os`, `node:path`, `node:child_process` for fixtures). `package.json` edits are limited to script registrations.
- **Private state:** all state files under `join(getAgentDir(), "commandcode")` with `stateDir` injection for tests; directories `0700`, files `0600` from creation; symlink, non-regular-file, and permissive-mode refusal everywhere.
- **Test seams:** injectable `stateDir`, wall clock, UUID/nonce generation, PID/liveness check, lock delay, fetch, and stream creation; real temporary directories and real child-process fixtures; injected clocks instead of sleeps.

### Strict TDD evidence expectations (recorded per work unit)

- **RED:** write the failing test first; record the focused command and the exact failing assertion before implementing.
- **GREEN:** minimal implementation; record the focused command and exact pass.
- **TRIANGULATE:** add at least one distinguishing scenario per requirement cluster (a second failure class, a second abort origin, a concurrent writer, a second command path) and re-run.
- **REFACTOR:** only after green + triangulated; `npm run typecheck` + `npm run format:check` + focused suite re-run with observable behavior unchanged.
- **Unit evidence:** focused test command + exact result; runtime harness command/scenario + exact result or explicit `N/A` with reason; rollback boundary naming the exact removable files/behavior (independent of commit creation).

### Dependency order

WU 0 → WU 1 → WU 2 → WU 3 → WU 4 → WU 5 → WU 6 (linear; keeps writes single-threaded and each unit independently reviewable and revertible). WU 3 depends only on the WU 0 verdict plus existing transport files, but is kept after WU 2 to preserve the review chain and single-writer discipline.

---

## Work Unit 0 — Baseline and native-capture feasibility gate

**Edit surfaces:** none (verification and recorded evidence only).

- [x] Record the baseline commit HEAD and `git status --porcelain` output, preserving any dirty worktree state unchanged per `apply.preserve_dirty_worktree`. <!-- sdd-owner: implementation -->
- [x] Install exact dependencies with `npm ci` and verify afterwards that `package.json` and `package-lock.json` are byte-identical (`git status --porcelain package.json package-lock.json` empty); never run a lockfile-mutating install. <!-- sdd-owner: implementation -->
- [x] Run baseline `npm test` and `npm run format:check`; record exact results as the observable-equivalence baseline (confirms the non-live suite needs no live credentials in this environment). <!-- sdd-owner: implementation -->
- [x] Feasibility probe: inspect `node_modules/@earendil-works/pi-ai` OpenAI-completions and Anthropic-messages provider paths and verify that the custom `fetch` injected by `src/transport.ts` observes, before SDK conversion: non-OK HTTP status plus normalized headers, bounded machine fields (`code`, `type`) from cloned error bodies, thrown fetch/network error classes, wrapped response-body read failures, and distinguishable caller-signal vs provider-request-signal aborts. <!-- sdd-owner: implementation -->
- [x] Record the feasibility verdict with concrete file/symbol references; if any required structured signal is unreachable, STOP apply and surface the upstream structured-outcome-hook blocker for `@earendil-works/pi-ai` — do not proceed to WU 3–6 and do not substitute message parsing. <!-- sdd-owner: implementation -->

Spec trace: failover-runtime#Failure Classification (verified-signal prerequisite); design §6.3 and §15 stop condition.

---

## Work Unit 1 — Private filesystem primitives and versioned account store

**Edit surfaces:** `src/account-store.ts` (new), `tests/test-account-store.ts` (new), `.gitignore`, `package.json` (script registration only), `mise.toml` (project-local toolchain pins only).

- [x] Reproducibility setup: add project-local `mise.toml` pins for Node `20.20.2` (the repository CI major) and npm `11.19.0`; run every Node/npm command through `mise exec`; do not change any dependency or lockfile. <!-- sdd-owner: implementation -->
- [x] RED in `tests/test-account-store.ts`: failing strict-parser tests for the version-1 schema — format/version/revision, finite timestamps, unique UUID IDs, exactly one valid primary, recognized credential kind, bounded strings and account count, 1 MiB cap, unknown version refused without migration. <!-- sdd-owner: implementation -->
- [x] RED: failing discriminated-load tests — `absent` / `loaded` / `unavailable(reason)` — plus state-root resolution `join(getAgentDir(), "commandcode")` with injected `stateDir` and no file/dir creation when absent. <!-- sdd-owner: implementation -->
- [x] RED: failing permission tests — directories `0700` and files/temp/lock-owner files `0600` from creation, permissive store corrected-or-refused with redacted warning (never read while refusing), symlink and non-regular-file refusal, POSIX ownership check. <!-- sdd-owner: implementation -->
- [x] RED: failing atomicity tests — `open("wx", 0600)` temp sibling + full write + `fsync` + `chmod` + rename, directory fsync where supported, atomically installed `0700` lock generation with nested `owner-<nonce>/owner.json` `0600` holding only nonce/PID/process-start/expiry, generation-matched release and stale recovery through a nonce-specific `retired-<nonce>` transition (TTL expiry or demonstrable dead PID; `EPERM`/ambiguous treated as live), interrupted-retirement cleanup (including an empty lock root after final generation cleanup), monotonic bounded wait accounting, delayed old-owner removal that cannot delete a successor generation, and bounded read retry across the rename race. <!-- sdd-owner: implementation -->
- [x] RED: failing real child-process coordination tests — two spawned child processes performing concurrent add/set-primary mutations under one lock converge with no lost updates and no torn files; a crash between credential write and coordination prune leaves only a credential-free orphan record that readers ignore. <!-- sdd-owner: implementation -->
- [x] GREEN: implement `src/account-store.ts` — strict parser, load/mutate protocol (validate remote first, lock, re-read, apply by ID, revision increment, atomic replace), lock primitive, stale-lock recovery — exposing only the stable store surface. <!-- sdd-owner: implementation -->
- [x] GREEN: add gitignore coverage — `commandcode/.gitignore` containing `*` inside the state root and a defensive `.pi/agent/commandcode/` rule in the repository `.gitignore`. <!-- sdd-owner: implementation -->
- [x] TRIANGULATE: corruption/edge variants (oversized file, non-object JSON, duplicate IDs, valid store with zero accounts → valid-empty legacy) and a second concurrent-writer interleaving with different mutation order. <!-- sdd-owner: implementation -->
- [x] REFACTOR: extract shared private-fs helpers (lock, temp-write, permission checks) for reuse by `src/coordination.ts`; register the suite in `package.json` `test`/`test:unit` scripts; run `npm run typecheck` + `npm run format:check` + full suite re-run. <!-- sdd-owner: implementation -->
- [x] Secret scan: assert the intended private `accounts.json` contains only synthetic test credentials, while `owner.json`, coordination metadata, warnings, errors, child output, and all other changed surfaces contain no key material; reuse the `stderrHasSecrets`-style patterns from `tests/test-pi-local.mjs`. <!-- sdd-owner: implementation -->
- [x] Record WU 1 evidence: focused test command + exact result, runtime harness scenario or explicit `N/A` + reason, and the rollback boundary (remove `src/account-store.ts`, `tests/test-account-store.ts`, `.gitignore` lines, script entries — no behavior depends on this unit yet). <!-- sdd-owner: implementation -->

Spec trace: account-management#Private Local Credential Store (all three scenarios: 0600 creation, permissive refusal, no credential material outside the store); process-coordination#Cross-Process Lease and Cooldown Contract (privacy/atomicity primitives groundwork); design §3.1–§3.4.

---

## Work Unit 2 — Validated login identity, account service core, management commands

**Edit surfaces:** `src/oauth.ts`, `src/quota.ts` (identity-parsing export), `src/accounts.ts` (new), `src/account-commands.ts` (new), `index.ts` (command registration only), `tests/test-account-commands.ts` (new), `package.json` (scripts).

- [x] RED in `tests/test-account-commands.ts`: failing identity-validation tests — reusable acquisition flow (refactored `src/oauth.ts`) returns the validated API key plus normalized `keyName`/`login`; unrecognized `whoami` identity rejected for pool storage; paste-marker/control-character sanitization; browser-callback failure falls back to paste; no credential accepted via slash arguments, autocomplete, notifications, or command history. <!-- sdd-owner: implementation -->
- [x] RED: failing account-service-core tests — `mode()` returns legacy (absent/valid-empty, no state files created), pool (with revision), or unavailable (fail-closed with redacted remediation, never silently empty); add dedupes by credential compared only in private memory under the lock and returns the existing ID with an updated label; remove deletes credential then prunes state; set-primary reorders and fails redacted on unknown ID; label fallback rules (`keyName` → `login` → `Account <short id>`, control-character stripping, credential-equal label replaced). <!-- sdd-owner: implementation -->
- [x] RED: failing command tests — the four `/commandcode-account-add`, `/commandcode-accounts`, `/commandcode-account-remove`, `/commandcode-account-primary` commands; interactive `ctx.ui.select()`/confirm adapters returning hidden IDs; idle-wait before mutation (status exempt); missing/ambiguous/cancelled/stale selections produce redacted errors; success notifies only the redacted label and generated ID. <!-- sdd-owner: implementation -->
- [x] GREEN: implement `src/oauth.ts` refactor (host `/login` keeps its credential return shape and host-owned auth file writes), `src/accounts.ts` core, `src/account-commands.ts`, `src/quota.ts` identity export, and `index.ts` command registration. The generation path is untouched in this unit: the pool is never consulted for request routing. <!-- sdd-owner: implementation -->
- [x] TRIANGULATE: invalid-credential rejection mid-flow leaves the store byte-unchanged; removal cascades to per-account state; two command mutations from child processes preserve revision integrity and ordering. <!-- sdd-owner: implementation -->
- [x] REFACTOR: register new suites in `package.json` scripts; typecheck + format + focused re-runs. <!-- sdd-owner: implementation -->
- [x] Legacy equivalence evidence: existing `npm run test:unit` and `tests/test-pi-local.mjs` pass unchanged with commands registered; assert host-owned auth files (`~/.commandcode/auth.json`, `~/.pi/agent/auth.json`, `~/.omp/agent/auth.json`) keep unchanged mtime and content across all command flows. <!-- sdd-owner: implementation -->
- [x] Secret scan of command output, notifications, errors, and completion data. <!-- sdd-owner: implementation -->
- [x] Record WU 2 evidence: focused commands + results, harness scenario or `N/A`, rollback boundary (remove command files/registration and the oauth refactor; store remains inert and unused by routing). <!-- sdd-owner: implementation -->

Spec trace: account-management#Extension-Managed Account Commands (add / add-invalid / remove / set-primary scenarios), #Redacted Account Listing (basic redacted rows), #Single-Account Backward Compatibility (empty-pool fallback + "Host-owned auth files are never written" + "Existing auth-file shapes still parse"); design §5, §2.2 (oauth, quota), §3.3.

---

## Work Unit 3 — Structured failure capture and the closed classifier

**Edit surfaces:** `src/types.ts`, `src/core.ts` (structured hook only), `src/transport.ts` (native capture adapter), `src/failover.ts` (classifier only, new), `tests/test-failover.ts` (new), extensions to `tests/test-retry.ts`, `tests/test-abort.ts`, `tests/test-transport.ts`, `package.json` (scripts). Prerequisite: WU 0 feasibility verdict is positive.

- [x] RED in `tests/test-retry.ts`/`tests/test-abort.ts`: failing `onTerminalFailure` hook tests — the callback fires exactly once per terminal failure, before the terminal `error` event is pushed, carrying the full `TransportFailure` shape (source, phase, kind, status, retryAfterMs, providerCode, providerType, streamReason, abortOrigin); HTTP status and parsed `Retry-After` are recorded before body formatting; fetch failures retain their error class; stream reasons are set at the point they are understood. <!-- sdd-owner: implementation -->
- [x] RED: failing abort-origin tests — caller-signal initiation records `caller`; provider-created request-signal abort while the caller signal is still open records runtime-owned timeout/abort; an `aborted` event without recorded runtime provenance defaults to caller/unknown and never fails over; no timing, ordering, or message-text heuristics anywhere. <!-- sdd-owner: implementation -->
- [x] RED: failing forced-`maxRetries: 0` semantics in `tests/test-retry.ts` — with the coordinator forcing zero, retry-delay calculation, cap-rejection errors, and injected `delay()` are all skipped and the original response remains the terminal failure (a large `Retry-After` is preserved as provenance, never converted into a legacy retry-cap error); with an absent pool and caller-supplied `maxRetries > 0`, existing same-account retry count, Retry-After capping, timing, events, and errors are unchanged. <!-- sdd-owner: implementation -->
- [x] RED: failing native-capture tests in `tests/test-transport.ts` — the wrapped fetch records non-OK status/normalized headers/bounded machine fields for both selected native APIs (OpenAI completions, Anthropic messages); a wrapped response-body read failure is captured as network/stream provenance before SDK conversion; caller and provider signals are observed separately. <!-- sdd-owner: implementation -->
- [x] RED: failing classifier tables in `tests/test-failover.ts` — eligible exactly {HTTP 408, 429, 5xx, non-caller network/connection failure, runtime-owned timeout/abort, account-scoped 401/403}; ineligible exactly {caller cancellation, other 4xx, payload/request/schema/context-overflow/tool/policy/content errors, unknown stream errors, unrecognized combinations}; unknown defaults to `never-failover`; the classifier's input type structurally excludes raw bodies and user-facing messages (compile-level no-message-guessing guarantee). <!-- sdd-owner: implementation -->
- [x] RED: failing `upgrade_required` negotiation tests — the JSON check runs before classification; the provider attempt and captured 403 are discarded; generate is retried with the same credential under `maxRetries: 0`; the pair counts as exactly one account selection with no reselection permitted; other 401/403 responses are account-scoped only on the authenticated Command Code generation endpoint before a stream was accepted. <!-- sdd-owner: implementation -->
- [x] GREEN: implement the `src/core.ts` hook (with `src/types.ts` option additions), the `src/transport.ts` native capture adapter (kept local to `transport.ts`), and the pure `classifyFailure()` in `src/failover.ts`. <!-- sdd-owner: implementation -->
- [x] TRIANGULATE: second stream-reason variant (`truncated` vs `upstream-connection`), a second runtime-abort source, and a `Retry-After` metadata extraction variant; extend `tests/test-quota.ts` only if capture touches quota transport. <!-- sdd-owner: implementation -->
- [x] REFACTOR: register suites in `package.json` scripts; typecheck + format + full focused re-runs; confirm legacy retry/abort suites pass byte-equivalently. <!-- sdd-owner: implementation -->
- [x] Record WU 3 evidence: focused commands + results, harness scenario or `N/A`, rollback boundary (hook default is a no-op and capture adapter is inert without pool wiring, so revert removes classification/capture without changing legacy behavior). <!-- sdd-owner: implementation -->

Spec trace: failover-runtime#Failure Classification (Verified-eligible / Caller-cancellation / Internal-timeout-vs-caller-abort / Ineligible / Unknown-default / Auth-401-403 / Retry-After-capture scenarios); design §6.1–§6.4.

---

## Work Unit 4 — Account planning, per-account transport registry, buffered failover stream, process-local cooldowns

**Edit surfaces:** `src/accounts.ts` (planning + health API), `src/failover.ts` (`createFailoverStream`), `src/transport.ts` (per-account router instances), `tests/test-accounts.ts` (new), `tests/test-failover-stream.ts` (new), `package.json` (scripts). No `index.ts` wiring yet — routing stays inert.

- [x] RED in `tests/test-accounts.ts`: failing plan tests — `planLogicalRequest()` returns primary-first healthy attempts in stored order, excluding cooling, probe-due, probing, removed, and already-tried accounts; `isStillConfigured(id, revision)` revalidates membership per attempt; `recordEligibleFailure` applies the injectable defaults table (transient 408/5xx/network/timeout 60s, 429 5min, account-auth 15min, 15min maximum contribution); `recordSuccess` clears process-local penalty; N concurrent in-process failures on one account converge to one consistent record. <!-- sdd-owner: implementation -->
- [x] RED: failing attempt-budget tests — even when input options request `maxRetries > 0`, every selected account receives cloned options with `apiKey` overridden and `maxRetries: 0` forced through both generate and native paths; the tried-set is marked before transport creation so no error path can reselect; each account is attempted at most once per logical request. <!-- sdd-owner: implementation -->
- [x] RED: failing buffer/commit tests in `tests/test-failover-stream.ts` — failed pre-content attempts emit neither `start` nor error; the winning attempt commits exactly one `start`; the first `thinking_start`/`text_start`/`toolcall_start` commits the buffer and pipes the rest; pre-content `done` commits one `start` + `done` + success; a post-content failure forwards a redacted error with no switch; `toolcall_start` commits before host-side tool execution so side effects are never followed by a switch. <!-- sdd-owner: implementation -->
- [x] RED: failing terminal-path tests — an eligible pre-content terminal failure consumes the structured callback for that same attempt, completes stream cleanup and the bounded cooldown update (no retry delay, no same-account retry), then immediately selects the next healthy untried account; an ineligible pre-content error commits that attempt's one `start` + terminal error and stops; caller cancellation terminates immediately, attempts no other account, and records no cooldown or penalty; pool exhaustion commits the last eligible attempt's buffered `start` + redacted terminal error; all-accounts-cooling emits one synthetic redacted unavailable error with the earliest retry time. <!-- sdd-owner: implementation -->
- [x] RED: failing cooldown-scheduling tests — a 429's cooldown is `max(base429, capped Retry-After)` used only as scheduling metadata (generation never sleeps on it); updates converge by later deadline with an epoch increment; expiry schedules bounded non-blocking recovery while the triggering request keeps the account excluded; recognized recovery re-enables later selection; success clears state; the second back-to-back request selects B after A is parked. <!-- sdd-owner: implementation -->
- [x] RED: failing intra-process concurrency tests — N concurrent logical requests proceed in parallel with no probe, lock, or cross-request waiting while selecting independently (spec "Concurrent requests are not serialized", process-local half). <!-- sdd-owner: implementation -->
- [x] GREEN: implement the planning/health API in `src/accounts.ts`, per-account router instances in `src/transport.ts` (existing router behavior reused, per-key memory reset per account), and `createFailoverStream()` in `src/failover.ts` with the legacy branch piping the existing router with the original options untouched. <!-- sdd-owner: implementation -->
- [x] TRIANGULATE: removal race (account removed mid-plan → per-attempt revalidation skips it), primary reorder applying from the next logical request, and a legacy-mode request asserting zero classifier/cooldown/attempt-budget participation. <!-- sdd-owner: implementation -->
- [x] REFACTOR: register suites in `package.json` scripts; typecheck + format + re-runs; existing `tests/test-transport.ts` and `tests/test-stream.ts` pass unchanged. <!-- sdd-owner: implementation -->
- [x] Record WU 4 evidence: focused commands + results, harness scenario or `N/A`, rollback boundary (module-level stream factory with no entry-point wiring; revert removes rotation behavior with zero runtime effect). <!-- sdd-owner: implementation -->

Spec trace: failover-runtime#Primary-First Selection With Bounded Rotation (all three scenarios), #Content Boundary and Side-Effect Guard (both scenarios), #Account Cooldown (parks/expiry/success-clears), #Automatic Primary Recovery (return-to-primary), #Silent Operation (switch invisibility), process-coordination#Process-Local Coordination (non-serialization + convergence + process-local-only scenarios); design §4, §7, §8.

---

## Work Unit 5 — Cross-process coordination and fenced recovery probes

**Edit surfaces:** `src/coordination.ts` (new), `src/accounts.ts` (opportunistic probe scheduling + recovery application), `src/quota.ts` (pure availability interpretation), `tests/test-coordination.ts` (new), `tests/test-coordination-ipc.ts` (new, child-process fixtures), `package.json` (scripts).

- [x] RED in `tests/test-coordination.ts`: failing schema/parser tests — credential-free `coordination.json` (format/version/revision, cooldown records with epoch/failureClass/failedAt/cooldownUntil/nextProbeAt, lease records with nonce/pid/processStartedAt/acquiredAt/expiresAt/cooldownEpoch/fence and nothing else), strict bounded parse, the same permissions/lock/temp/rename protocol as the store, and corrupt-file handling that atomically quarantines to a mode-0600 nonce name and replaces with a valid empty record plus a redacted warning. <!-- sdd-owner: implementation -->
- [x] RED: failing cooldown-propagation tests — process-local state updates immediately and the bounded atomic shared mutation completes before failover finishes; concurrent writers merge by account with later-deadline-wins and epoch increments; readers merge disk and process-local records conservatively (an older in-flight success never erases a newer concurrent failure); two child processes writing simultaneously converge atomically with no torn content. <!-- sdd-owner: implementation -->
- [x] RED: failing lease tests — acquisition is rejected when cooldown is not due, `nextProbeAt` is in the future, or a fresh lease exists; expired or demonstrably dead (`ESRCH`) leases are recovered via atomic tombstone rename; a new nonce/expiry/cooldown-epoch/monotonic-fence plus `nextProbeAt = now + probeWindow` is written in one atomic replacement; result application reacquires the lock and succeeds only if nonce, fence, and cooldown epoch still match (a newer failure fences out a stale successful probe); release is compare-by-nonce and cannot release a successor's lease. <!-- sdd-owner: implementation -->
- [x] RED: failing healthy-traffic non-serialization tests — no lock or lease is acquired to select or send traffic to a healthy account; while one process holds a probe lease, other processes issue ordinary logical requests on fallback accounts immediately without acquiring the lease or waiting. <!-- sdd-owner: implementation -->
- [x] RED: failing degraded-mode tests — an uncorrectable coordination permission or corruption switches to process-local cooldown only after a visible redacted degradation warning (never silent divergence); a `0644` coordination file is corrected-or-refused per the process-coordination permission scenario. <!-- sdd-owner: implementation -->
- [x] RED: failing probe/recovery tests — a request that notices an expired cooled account opportunistically schedules a non-blocking bounded probe (existing 15s quota/whoami transport bound) and immediately serves on a healthy fallback; auth/transient recovery requires a valid recognized account response; quota recovery requires recognized positive credits or an unexhausted numeric window; missing/ambiguous data never proves recovery; the 5-minute injectable quota snapshot TTL; explicit `/commandcode-quota` updates the same cache as a recovery signal with no response-message-signature assumptions. <!-- sdd-owner: implementation -->
- [x] GREEN: implement `src/coordination.ts` (propagation, fenced leases, stale recovery, quarantine), probe scheduling/application in `src/accounts.ts`, and the pure availability interpretation in `src/quota.ts`. <!-- sdd-owner: implementation -->
- [x] TRIANGULATE in `tests/test-coordination-ipc.ts` with real child processes, injected clocks, and no sleeps: deterministic single-winner lease contention between two processes; a killed holder whose lease is taken over after TTL; simultaneous initial-failure propagation converging; interaction with the all-accounts-unavailable path. <!-- sdd-owner: implementation -->
- [x] REFACTOR: register suites in `package.json` scripts; typecheck + format + re-runs. <!-- sdd-owner: implementation -->
- [x] Secret scan: assert `coordination.json`, quarantine files, lease metadata, warnings, and test output contain only opaque UUIDs, timestamps, nonces, and class names — no credentials, labels, URLs, or workspace paths. <!-- sdd-owner: implementation -->
- [x] Record WU 5 evidence: focused commands + results, harness scenario or `N/A`, rollback boundary (coordination degrades to process-local by design; revert leaves WU 4 behavior functional). <!-- sdd-owner: implementation -->

Spec trace: process-coordination#Cross-Process Lease and Cooldown Contract (all seven scenarios), #Stale-Lease Recovery (all three), #Deterministic Test Scenarios (both), #Process-Local Coordination (single-flight probing); failover-runtime#Automatic Primary Recovery (probe-driven recovery); design §8, §9.

---

## Work Unit 6 — Final wiring, status, quota command, docs, hardening, activation

**Edit surfaces:** `index.ts` (pool-stream wiring + lifecycle cleanup), `src/runtime.ts` (status summary + lifecycle), `src/quota-command.ts` (pool selection), `README.md`, `package.json` (scripts finalization), full existing test surfaces (read/run only). This unit flips the structural gate: pool routing activates here because orchestrator, coordination, and probes are all present and verified.

- [x] RED: failing wiring tests — a valid non-empty store selects the pool stream; an absent or valid-empty store selects the legacy branch with the entire options object unchanged (caller-supplied `maxRetries`, Retry-After handling, key precedence); an unavailable store fails closed for pool generation and management with a redacted remediation message and is never silently treated as empty nor allowed to fall back to a legacy credential. <!-- sdd-owner: implementation -->
- [x] RED: failing lifecycle tests — exactly one `AccountService` per extension instance created in `index.ts`; lazy initialization with no directory, timer, watcher, or network activity for an absent pool; `session_shutdown` aborts outstanding probes and releases leases; primary changes apply from the next logical request; process-local `active` semantics documented in output without claiming a global active account. <!-- sdd-owner: implementation -->
- [x] RED: failing status/quota tests — `/commandcode-accounts` renders ID, order, redacted label, process-local active marker, health (`healthy`/`cooling`/`probe due`/`probing`), cooldown remaining, and snapshot age with no key fragment; `/commandcode-status` appends only a summary plus coordination warning; `/commandcode-quota` with a pool selects the primary by default or an explicit account ID, keeps the quota endpoint's non-fatal 429 behavior, and never invents generation quota messages; provider name `commandcode`, `apiBase`/model URL/cache, and `compat` metadata assertions unchanged. <!-- sdd-owner: implementation -->
- [x] GREEN: implement the wiring in `index.ts`, `src/runtime.ts`, and `src/quota-command.ts`, enabling automatic primary return after cooldown expiry + success or quota-verified recovery. <!-- sdd-owner: implementation -->
- [x] Legacy observable-equivalence sweep: run the complete existing suites — `npm run test:unit`, `tests/test-pi-local.mjs`, `tests/test-omp-compat.mjs`, `tests/test-pi-isolated.mjs` — and record unchanged passes against the WU 0 baseline (same events, errors, key resolution, command behavior, timing); internal-wiring-only differences are permitted, observable differences are not. <!-- sdd-owner: implementation -->
- [x] Multi-account end-to-end evidence (hermetic mock server, non-live): primary fails with each of 429 / 408 / 502 / connection-reset / account-401 before content → silent switch → success on the next healthy account; auto-return to primary after cooldown + success; cross-process cooldown visibility via a second child process; assert stdout/stderr contain no switch notifications or diagnostics. <!-- sdd-owner: implementation -->
- [x] Secret-scanning and audit sweep: run the repository's Gitleaks and Semgrep (`pi-extension-audit`) gates on the full diff (record explicit unavailability if tooling is absent, with the test-level secret assertions standing in); assert no `Bearer \S+` or key-shaped values across notifications, thrown errors, state metadata, stdout/stderr, and status output; synthetic placeholders only. <!-- sdd-owner: implementation -->
- [x] Package-manifest and lockfile check: `git diff package.json` shows script registrations only (zero dependency changes in any manifest section), `package-lock.json` is byte-identical to the WU 0 baseline, and `tests/test-package-manifest.ts` passes. <!-- sdd-owner: implementation -->
- [x] Docs: update `README.md` with the four account commands, pool behavior (primary preference, silent bounded failover, cooldowns, automatic recovery), the state directory location/permissions and deletion-as-rollback story, the degraded-coordination warning meaning, and the single-account compatibility guarantee; run `npm run format:check` green. <!-- sdd-owner: implementation -->
- [x] Final non-live suite evidence: run the full `npm test` and record the exact result; confirm no live credential values and no real-account quota exhaustion were used anywhere; record per-unit evidence (commands, results, rollback boundaries) is complete. <!-- sdd-owner: implementation -->

Spec trace: failover-runtime#Single-Account Compatibility (all scenarios), #Redaction of All Failover Output (terminal-error redaction), #Silent Operation; account-management#Single-Account Backward Compatibility (all three scenarios); design §10, §11, §12, §16.

---

## Parent-owned actions (review and lifecycle gates — grouped separately)

- [x] Confirm the WU 0 native-capture feasibility verdict before authorizing WU 3; if negative, halt and surface the upstream `@earendil-works/pi-ai` structured-outcome-hook blocker to the user — no message-parsing fallback is acceptable. <!-- sdd-owner: parent -->
- [x] Start or reuse bounded review for each completed work unit before its commit lands in the chain; record reviewer-load observations qualitatively per unit. <!-- sdd-owner: parent -->
- [x] Decide the chain strategy together with the user before any PR or branch creation; resolved as `feature-branch-chain` targeting `custom/main`, with `feat/multi-account-failover` as the tracker, and do not mix strategies afterwards. <!-- sdd-owner: parent -->
- [x] Final lifecycle gate: verify the structural feature gate held (pool routing active only in WU 6 with the full outcome verified), that each unit kept its tests, evidence, and rollback boundary, and that release happens only after the complete spec outcome — not a partial product — is verified. <!-- sdd-owner: parent -->
