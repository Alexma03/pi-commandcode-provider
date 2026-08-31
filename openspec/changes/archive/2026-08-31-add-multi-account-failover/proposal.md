# Proposal: add-multi-account-failover

Status: draft — awaiting review
Change ID: add-multi-account-failover
Evidence base: `explore.md` + `preproposal.md` (product decisions confirmed; research lane unselected)

## Summary (intent)

Enable this fork to operate with multiple separately authorized Command Code accounts with automatic, bounded failover so an exhausted or transiently unhealthy account does not stop work. Prefer the primary account, fail over before any user-visible output when an eligible failure occurs, try each healthy configured account at most once per logical request, cool down failing accounts, and return automatically to primary after recovery. Keep credentials local and redacted, preserve single-account behavior when no pool is configured, and never replay after content or side effects.

Normal switching is silent; explicit status is redacted and on-demand.

## Business / user problem

Today the provider has a single logical account (host registry / env / auth file). Quota exhaustion, a transient provider/network failure, or an account-specific auth failure (expired/invalid key) on that one account blocks the entire session, even when the user owns other valid accounts/keys that could serve the request. Users lose continuity, retry manually, or duplicate setup work. Support and operational cost grows from avoidable interruptions and from ad-hoc workarounds to rotate keys by hand.

## Target users and situations

- Power users and teams who operate 2-5 Command Code accounts (personal + org, pooled keys, GO/GOAT/PROVIDER tiers) in one local checkout.
- Multi-agent sessions: several concurrent subagents issuing generation requests against the same provider in the same workspace.
- Moments: mid-task generation when primary hits quota or a transient 408/429/5xx/timeout or account 401/403; background refresh/quota checks; command-driven status inspection.
- Urgency: high when a long-running task is blocked by a recoverable account failure; low when inspecting account health via status.

## Current-state gap

- Single-key resolution: `src/converters.ts` + `src/api-key.ts` + `core.ts` resolve one key; `transport.ts` remembers one per-key transport decision; `quota.ts` checks one account. No enumeration, pool, ordering, health state, or cooldown.
- No request-time quota reaction: quota is only read by `/commandcode-quota`; generation never classifies or reacts to quota exhaustion.
- No account failover orchestration: pre-content retry exists but only within one account (`maxRetries:0` default, `output.content.length===0` gate). Generic client/policy/content/context/tool errors correctly do not retry, but there is no account-switch path.
- No extension-managed multi-login: keys come from env/auth files not owned by the extension; no private mode-0600 store or login commands for multiple accounts.
- No redacted multi-account status surface.

## Product outcome (what becomes possible)

After the first slice:

- User can add/remove multiple accounts via extension-managed login commands backed by a private local store (0600).
- Requests prefer primary; on eligible failure before content, the runtime silently switches to the next healthy account and completes the request if possible.
- After cooldown/recovery, traffic returns automatically to primary without user action.
- User can explicitly inspect redacted account health/order/active/cooldown via a status command; normal operation emits no account-switch noise.
- Single-account users see no behavior change.

This outcome is preserved in full. Delivery may be sequenced across reviewable work units (see Delivery and review workload), but acceptance criteria are not weakened to claim a single small diff.

## Scope — first product slice (complete outcome preserved; delivery slicing deferred)

The product scope below defines the complete first-slice outcome. It is not a claim that all items fit credibly in one under-400-line diff. Formal sizing and sequencing are deferred to `sdd-tasks` under `delivery_strategy=ask-on-risk`.

**In:**

- Private local credential store for the account pool (file under extension home, 0600, git-ignored, never written to OpenSpec/logs/telemetry). Extension-managed multi-login commands: add/login, list (redacted), remove/logout, set-primary. Backward compatible: existing single env/auth-file key is treated as primary when pool empty.
- Account pool module (`src/accounts.ts` proposed): enumeration, ordering (primary first), per-account state (health, cooldown until, last eligible error class, transport decision delegated to `transport.ts`), selection policy.
- Pure failure classifier (`src/failover.ts` proposed): maps verified signals to `eligible-for-failover` vs `never-failover`. Eligible: HTTP 408, 429, 5xx, network/timeout/AbortError, and account-specific 401/403. Ineligible: generic 4xx (other than above), context-overflow, schema, content/policy, tool errors. Body/reason matching is extensible and tested, not hardcoded to unverified quota strings — see Uncertainties.
- Failover orchestrator at the transport/router layer (no `core.ts` rewrite): only before first `thinking_start`/`text_start`/`toolcall_start` reaches the host (`output.content.length===0` gate). Tries each healthy account at most once per logical request; honors `Retry-After` (capped); cooldown to prevent retry storms with process-boundary-aware coordination (see Process boundaries); never replays after content or after side effects.
- Redacted status surface: extend `/commandcode-status` or add `/commandcode-accounts` showing order, active, health, cooldown remaining, quota snapshot age — values redacted (`redactValue`/`redactDiagnosticText` pattern), no key material.
- Tests: `test-accounts` (enumeration, ordering, redaction, placeholder handling), `test-failover` (classifier + orchestrator with mock server), extended `test-transport`/`test-quota` for pool integration; security assertions for no leakage; Gitleaks/Semgrep clean.

**Out (non-goals for this slice):**

- Cross-device sync or cloud backup of accounts.
- Secret-manager integrations (1Password, Vault, etc.).
- Unrelated provider refactors, model catalog changes, pricing/cost changes, or transport rewrites beyond the failover hook.
- Generic request/policy/tool/context failover: never triggers account switch (fixed invariant).
- Replay after content/side effects or unbounded/indefinite retries.
- Writing to `~/.pi/agent/auth.json` / `~/.commandcode/auth.json` shapes owned by Pi/OMP (read-only compatibility).

## Affected areas

| Area                                             | Impact                                                                                                          |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `index.ts`                                       | Wire pool into transport construction and quota/status key resolution; no change to provider name `commandcode` |
| `src/accounts.ts` (new)                          | Pool, ordering, cooldown, selection, redacted identifiers                                                       |
| `src/failover.ts` (new)                          | Classifier + orchestrator (bounded, pre-content, cooldown-aware)                                                |
| `src/transport.ts`                               | Failover hook; per-key transport memory reused (reset on key change)                                            |
| `src/quota*` / `quota-command.ts` / `runtime.ts` | Per-account quota snapshot (cached, TTL, non-blocking) + redacted status                                        |
| `README.md`                                      | Docs for multi-login commands and pool behavior                                                                 |
| `tests/*`                                        | New + extended hermetic tests; mock server multi-key support                                                    |

Untouched by design: `src/core.ts` replay gate reused, `src/oauth.ts`/`src/auth-server.ts`/`src/models.ts`/`src/cost.ts`/`src/pricing.ts`/`src/json-schema.ts`/`src/overflow.ts` (except optional shared helper if justified).

## Security and compliance constraints

- Credentials: env + private store only; file mode 0600; never committed, never in OpenSpec, never in diagnostics/logs/telemetry. Use `keyName`/`login` (from `whoami`) as redacted identifiers.
- Redaction: all user-visible output via `redactValue`/`redactDiagnosticText`; error paths assert no `Bearer \S+` or key material (existing `stderrHasSecrets` pattern).
- Audit: diff must pass Gitleaks and `pi-extension-audit` Semgrep; no hardcoded keys in tests (use synthetic placeholders from `COMMAND_CODE_PLACEHOLDER_KEYS`).
- Auth-file compatibility: read-only for Pi/OMP-owned files; extension store is separate.

## Compatibility expectations

- Single-account behavior preserved: empty pool → exactly today's path (`maxRetries:0`, transport router, quota command) byte-identical.
- Provider name `commandcode`, `apiBase`/model URL/cache, and `compat` metadata unchanged.
- Host `getApiKeyForProvider("commandcode")` single-key contract respected; pool is configured via extension store + env fallback, not via host multi-key return.
- `start` re-emission on switched attempt tolerated per existing retry loop; validated in tests.

## Operational implications

- Failover is silent in normal operation; only explicit status shows redacted state.
- Cooldown prevents storms: failing account is parked for a bounded window.
- Primary recovery: after a successful request on a failover account and/or a quota refresh showing primary health, selection returns to primary automatically.
- Quota snapshot is cached (short TTL, ~minutes) and never blocks the request path; classification is primarily response-driven.
- Observability: redacted counters/health in status; no credential-bearing telemetry.

### Process boundaries (explicit)

- **Intra-process (one extension instance):** in-memory per-account cooldown map + single-flight probe protects that process. This is sufficient and required for concurrent requests within one Node process.
- **Cross-process (concurrent Pi subagents in separate child processes sharing the same workspace/pool):** process-local memory cannot provide single-flight or shared cooldown. The design/spec must decide a safe cross-process lease/cooldown mechanism in the private local state boundary (same private boundary as the credential store — a file under the extension home, 0600, git-ignored). The mechanism must include stale-lease recovery (crash/kill safety), atomic writes/locks, and no credentials in lease metadata. This proposal does not prematurely prescribe an unsafe in-memory-only or naive file implementation; the choice is deferred to spec/design.

## Edge cases

- No accounts configured / only primary: no failover; current behavior.
- One healthy + N unhealthy: tries each healthy at most once; stops after pool exhausted and surfaces last eligible error (redacted).
- All accounts exhausted/cooldown: surface error, do not loop; cooldown expiry re-enables.
- Failure after content (`text_start`/`thinking_start`/`toolcall_start` already pushed) or after tool side effect: never switch accounts; surface error.
- Generic 4xx / context-overflow / schema / tool error: never switch, even pre-content.
- Auth 401/403 that is account-specific: eligible for one bounded switch (per confirmed decision); generic auth misconfiguration with no healthy alternative surfaces immediately (redacted).
- `Retry-After` present: honor capped delay per attempt; 429 on billing/quota endpoints remains non-fatal for snapshot.
- Permissions: store file not 0600 → fix permissions or warn and refuse to read; do not fall back to world-readable.
- Concurrent subagents (same process): in-memory per-account cooldown + single-flight ensures at most one probe per window. Concurrent subagents (separate processes): process-local memory is insufficient; spec/design must define the cross-process lease/cooldown protocol in the private local state boundary with stale-lease recovery, atomic writes, and no credentials in lease metadata.
- Stream truncation / mid-stream timeout before content: eligible to switch; after content: not.

## Risks and mitigations

| Risk                                                               | Mitigation                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Key leakage in logs/status/artifacts                               | Redacted IDs only; 0600 store; git-ignore; Gitleaks/Semgrep gates; tests assert no leakage                                                                                                                                                                                                                   |
| Replay semantics confusion (duplicate `start`)                     | Gate on `output.content.length===0`; reuse `core.ts` gate; verify host tolerates re-issued `start`                                                                                                                                                                                                           |
| Retry storms across concurrent subagents (including cross-process) | Intra-process: per-account cooldown + single-flight + at-most-once-per-account bound. Cross-process: spec/design must define a safe private-local-state lease/cooldown with stale-lease recovery, atomic writes/locks, and no credentials in lease metadata; proposal does not prescribe an unsafe mechanism |
| Stale quota / window race                                          | Quota as secondary signal; primary trigger is response classification; non-blocking fetch with TTL                                                                                                                                                                                                           |
| Transport re-detection churn                                       | Per-key memory in `transport.ts`; probe cost accepted and tested                                                                                                                                                                                                                                             |
| Infinite loops / unbounded switching                               | Hard bound: at most N attempts = healthy accounts; one logical request never revisits an account                                                                                                                                                                                                             |
| Auth-file format breakage                                          | Read additional fields only; never write Pi/OMP-owned files                                                                                                                                                                                                                                                  |
| Cross-process lease stale/corrupt                                  | Lease metadata holds only redacted account identifiers + timestamps + holder nonce; stale-lease TTL + atomic write/lock + recovery on crash; spec defines exact TTL and recovery semantics; no credential material in lease                                                                                  |
| Oversized single review unit                                       | Delivery slicing is deferred to `sdd-tasks` under `delivery_strategy=ask-on-risk` with explicit review-workload forecast; no acceptance criteria are weakened to fit one diff                                                                                                                                |

## Rollback

- Feature is additive and gated on pool presence. Rollback = revert pool/failover wiring; single-account path remains. No migration to undo (store is local and can be deleted). No data loss beyond local pool file. If delivery was chained, each work unit is independently revertible; later units depend on earlier pool/store units.

## Success criteria (measurable acceptance direction)

- Single-account regression: with empty pool, existing unit + `test-pi-local` + transport tests pass unchanged.
- Multi-account happy path: mock server primary 429/timeout/5xx/408/account-401 before content → silent switch → request succeeds on next healthy account; primary auto-recovery verified after cooldown/success.
- Guardrails: generic 4xx/context-overflow/tool/schema errors never trigger switch (even pre-content); after-content failures never switch; each account tried at most once per logical request.
- Storm control (intra-process): N concurrent requests failing primary in one process result in at most one probe per cooldown window per account (assert via intra-process shared state). Cross-process storm control is validated per the spec-defined private-local-state lease protocol once chosen; this proposal requires the spec to define that protocol rather than claiming process-local memory suffices cross-process.
- Security: no test or runtime output contains key material; `npm run test:unit` + `npm test` (non-live) pass; Gitleaks/Semgrep pass on diff. Lease/cooldown metadata, if file-backed, contains no credential material and is 0600/git-ignored.
- UX: `status`/`accounts` command shows redacted order/health/cooldown with no key material; normal operation emits no switch noise.

## Uncertainties (captured explicitly)

- Exact Command Code quota-exhaustion body/message signature has no verified sample in the current checkout. Classifier will rely on verified HTTP status/classes (408/429/5xx, network/timeout, account 401/403) and an extensible, tested body/reason matcher with a narrow allowlist that can be extended once live samples are validated (GO/GOAT/PROVIDER or mocked fixtures). This uncertainty does not weaken the outcome: status-based failover plus extensible matcher covers the required behavior and is testable without inventing signatures.
- Recovery TTL/cooldown durations and quota snapshot TTL are tunable constants validated in tests; final values are spec decisions, not proposal commitments.
- Cross-process lease/cooldown mechanism (file lease, lock file, or equivalent in the private local state boundary) including stale-lease TTL, atomic-write/lock primitive, and holder identity is a spec/design decision. The proposal fixes only the boundary (private local state, 0600, no credentials in metadata) and the requirement that spec define it with stale-lease recovery.

## Delivery and review workload

The store + multi-login commands + pool + classifier + orchestrator + cross-cutting tests/docs/status scope is unlikely to fit credibly in a single under-400-line review unit. The complete product outcome and acceptance criteria above are preserved; they are not reduced to fit one diff. Formal sizing, sequencing, and review-workload forecast are deferred to `sdd-tasks` under `delivery_strategy=ask-on-risk`, which will propose reviewable chained work units (for example: 1) private store + login/list/remove/primary commands, 2) pool + classifier, 3) orchestrator + transport hook + status, 4) hardening/cross-process lease + docs) before `apply`. `sdd-tasks` owns the final slice plan; this proposal does not pre-commit to one PR.

## Next step

Spec — define pool store schema, command UX, classifier taxonomy, orchestrator state machine (including intra-process vs cross-process coordination boundaries and the private-local-state lease contract), and test plan. Tasks will then forecast review workload and sequence the work under `delivery_strategy=ask-on-risk`.

## References

- `openspec/changes/add-multi-account-failover/explore.md`
- `openspec/changes/add-multi-account-failover/preproposal.md` (confirmed decisions)
