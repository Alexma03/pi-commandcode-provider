# Exploration — add-multi-account-failover

Status: exploration complete (read-only; no production code or tests written).
Branch: `feat/multi-account-failover` checked out at upstream `main` commit `6f367515`; the working tree has no product drift. The only uncommitted files are authorized OpenSpec artifacts: `openspec/config.yaml` (created by sdd-init before this change) and `openspec/changes/add-multi-account-failover/` (this exploration, including this file). No prior OpenSpec _change_ existed before this one.
Security note: this artifact contains no credentials. The fork's CI blocks hardcoded API keys (Gitleaks) and Semgrep flags extension attack patterns; treat every account credential as external input.
Next recommended: research (exploration) is not selected as an implementation route. Route to the mandatory pre-proposal product-decision gate: resolve the open product decisions listed in §5 (notably whether account-specific authentication failures trigger one bounded failover switch) with the user, then produce the proposal. Do not proceed to proposal while these blockers remain.

## 1. Product intent and non-goals (confirmed)

- Support multiple separately authorized Command Code accounts/API keys in this fork.
- Prefer the primary account; fail over to another account when quota is exhausted; automatically return to primary when availability recovers.
- Also attempt bounded account failover for selected provider/connectivity failures so one unhealthy account does not unnecessarily stop work.
- Never hide generic client/request/policy/content/tool errors (other 4xx, context overflow, tool errors, schema errors must surface and never trigger account failover).
- Account-specific authentication failures (401/403 tied to the active account's credential, e.g. invalid or expired key) are an **unresolved product decision**: whether they surface immediately or trigger exactly one bounded switch to the next healthy account must be decided at the pre-proposal gate; this is not a confirmed non-goal.
- Never loop indefinitely; retry an account at most once per logical request.
- Transparent replay only before user-visible stream output or side effects; identify the exact current stream boundary.
- Account credentials must stay local: never in Git, OpenSpec, or logs.
- Preserve Pi provider compatibility and existing single-account behavior (default `maxRetries: 0`, transport router, quota command).
- Multiple concurrent subagents must not create uncontrolled retry storms.

## 2. Architecture map (current checkout, not the installed v0.6.0)

Entry point `index.ts` (default export, Pi `ExtensionAPI`):

1. Resolves `apiBase` (`COMMANDCODE_API_BASE` or provider base) and models URL/cache; builds the runtime.
2. `createProviderConfig()` — the provider config registered with the host under name `"commandcode"`. Its `apiKey` field is a display placeholder (`getConfiguredApiKey() ?? "$COMMAND_CODE_API_KEY"`); the _real_ key is resolved per request by the host and/or by `core.ts`. It also wires `oauth: { name, login, refreshToken, getApiKey }` used by the host `/login` flow, and per-model `baseUrl`, `compat`, `cost`, `reasoning` metadata.
3. `transport` — `createCommandCodeTransportRouter` decides per API key between the native Provider API (via `streamNativeProvider` from `@earendil-works/pi-ai/compat`) and the custom `generate` transport (`createStreamCommandCode` from `core.ts`). It remembers the decision per `options.apiKey` and re-detects when the key changes; fallback happens only for HTTP 403 with `error.code === "upgrade_required"`.
4. `pi.on("message_end")` — normalizes context-overflow errors via `normalizeCommandCodeMessage` (overflow.ts) so pi/OMP can compact and retry; scoped to provider `commandcode`.
5. `registerCommandCodeQuota(pi, ...)` — registers `/commandcode-quota`.
6. `createCommandCodeRuntime(...)` — registers `/commandcode-refresh` and `/commandcode-status`, loads the model catalog (live → cache → empty with warnings), and re-registers the provider when the catalog changes.

### 2.1 Authentication resolution (current behavior)

- `index.ts` reads `getConfiguredApiKey()` from `src/api-key.ts` for the display `apiKey`; per-request real keys come from the host registry.
- `src/converters.ts` `getApiKey({env, authPaths, homeDir})` — used by `core.ts`: env `COMMAND_CODE_API_KEY` → legacy `COMMANDCODE_API_KEY` → `~/.commandcode/auth.json`, `~/.omp/agent/auth.json`, `~/.pi/agent/auth.json`; parses plain `apiKey`, `commandcode`, `command-code` string or credential records (`{type:"api",key}` / `{type:"oauth",access}`). Auth files are read synchronously and shared across all concurrent requests.
- `src/api-key.ts` `getConfiguredApiKey()` — near-identical duplicate for the provider-config display key and the quota command fallback.
- `src/oauth.ts` — `/login` flow: browser login (Studio POSTs key to `src/auth-server.ts` local callback server) or pasted key, validated via `/alpha/whoami`; stores credentials with far-future expiry in the host auth file; `refreshToken` is a no-op (keys never expire). `getApiKey(credentials)` returns `credentials.access`.
- `src/quota-command.ts` — reads the host registry key via `ctx.modelRegistry.getApiKeyForProvider("commandcode")`, falls back to `pickCommandCodeApiKey(registryKey, getConfiguredKey())`, honoring placeholder detection (`COMMAND_CODE_PLACEHOLDER_KEYS`).

Key observation: **today there is exactly one logical account** — the host registry returns one key; `core.ts` picks the single key; the transport remembers one decision per key value; quota runs against one key. There is no enumeration, no pool, no per-account state, and no ordering concept.

### 2.2 Provider registration and transport selection

- One provider `"commandcode"` is registered by `runtime.ts`; `runtime.ts` re-registers with fresh model metadata after catalog refresh.
- `transport.ts` holds mutable per-key state (`transport: "unknown"|"provider"|"generate"`, `apiKey`); resets on key change; `stream()` re-detects by probing the Provider API, swallowing provider events if `upgrade_required` is detected, then switching to `streamGenerate`; errors during probe are pushed as `error` events.
- `apiForModelId(model.id)` selects `anthropic-messages` (claude-\*) vs `openai-completions`; `baseUrlForModel` maps base URL per API.

### 2.3 Request path and retry/error classification (core.ts `createStreamCommandCode`)

Sequence per request: resolve key → build body → `onPayload` hook → HTTP POST `${apiBase}/alpha/generate` → `onResponse` hook → read SSE stream → parse events → `done`/`error`.

Retry classification (all inside `core.ts`):

- HTTP-level retry: only `status === 429 || 500 <= status < 600` (`isRetryableStatus`). Honors `Retry-After` with a cap; `maxRetries` defaults to **0** (no retries), `maxRetryDelayMs` default 60 s.
- Timeout retry: per-attempt `timeoutMs` aborts; a timed-out attempt can be retried.
- Stream-level retry: on stream error events/truncation/mid-stream timeout, retries only if `output.content.length === 0` and attempts remain; the code explicitly resets `textBlock`, `thinkingIdx`, `stopReason`, `errorMessage`, `finished` before retry.
- **The replay boundary today is `output.content.length === 0`**: nothing has been pushed to the output stream (no `text_start`/`thinking_start`/`toolcall_start`) and no side effect has happened. The first visible event is `stream.push({type:"start", ...})` which is _always_ pushed before the HTTP attempt; content events (`text_start`, `thinking_start`, `toolcall_start`) are the real user-visible boundary. This boundary also gates the transport router: after an `upgrade_required` fallback, only the _generate_ attempt's events are forwarded (provider probe events are suppressed).
- Errors are never retried for 400/401/403 (except transport-specific 403 `upgrade_required`) and never for content already emitted. `redactCommandCodeErrorText` runs on every error message before it leaves the module.

Error classification vocabulary used today: HTTP status, `Retry-After`, `rawFinishReason` network/connection/upstream-error regex, stream `error` events, `AbortError`, timeout error, and context-overflow normalization (`overflow.ts`). There is **no quota-exhaustion classification** in the request path: quota is only read by the `/commandcode-quota` command; nothing pre-checks or reacts to `billing/credits` or window limits during generation.

### 2.4 Quota handling

`quota.ts` `fetchCommandCodeQuota({apiKey, baseUrl, fetchImpl, timeoutMs, extraHeaders})`:

- `GET /alpha/whoami` → `{account: {login, orgId, keyName}}`; then `GET /alpha/billing/credits?orgId=`, `GET /alpha/billing/subscriptions?orgId=`, `GET /alpha/usage/summary?orgId=&since=` in parallel with per-endpoint non-fatal degradation; overall 15 s deadline; errors classified `config|http|network|timeout`; blocking = 401/403; 429 on billing endpoints is non-fatal.
- `quota-types.ts` defines `CommandCodeQuota`, `CommandCodeCredits`, `CommandCodeWindowLimit` (fiveHour/weekly windows), `CommandCodeSubscription`, `CommandCodeUsageSummary`, `CommandCodeQuotaResult`.
- `quota-format.ts` formats; `quota-command.ts` registers `/commandcode-quota` with key resolution and redaction (`redactValue`).
- No request-time enforcement: nothing consults quota during generation.

### 2.5 Stream event timing (exact boundary)

`core.ts` emits in order: `start` (always, before HTTP) → optional `thinking_start/delta/end` → optional `text_start/delta/end` → optional `toolcall_start/delta/end` → `done` or `error`. Content begins at the first `text_start`/`thinking_start`/`toolcall_start` push, which currently happens only after `handleEvent` receives an upstream event. Therefore the safe transparent-replay window is **before the first content-bearing event (`text_start`/`thinking_start`/`toolcall_start`) is pushed downstream**, which today is exactly the `output.content.length === 0` check. `start` is safe to emit multiple times only if the consumer tolerates a re-issued `start` (the existing retry loop already re-pushes `start` per attempt). `message_end` normalization (overflow) runs host-side after `done`/`error`.

### 2.6 Commands and UI

- `/commandcode-refresh` (runtime.ts), `/commandcode-status` (runtime.ts, redacted diagnostics), `/commandcode-quota` (quota-command.ts). Notifications via `ctx.ui.notify`; redaction via `redactDiagnosticText`/`redactValue`; `waitForIdle` used before refresh/quota.
- No command today lists accounts, sets primary, or shows failover state.

### 2.7 Package boundaries

- `package.json` v0.6.0, ESM, NodeNext TS strict, files = `index.ts`, `src/`, `scripts/`, docs. Peers: `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent` (optional, `*`). No runtime deps; no lifecycle scripts (CI enforces).
- Tests: `npm run test:unit` (tsx, src-facing), `npm test` adds `node` integration mjs (pi-local, pi-isolated, pi-authenticated, omp-compat); live E2E excluded (`test-live-e2e.mjs`, profile runner `scripts/live-e2e-profile.mjs` with GO/GOAT/PROVIDER keys from files/env).
- Security gates in CI: typecheck, tests, prettier, CodeQL, Semgrep (`pi-extension-audit.yaml`), Gitleaks, dependency review. `tests/` is allowlisted by Gitleaks.

## 3. Design pressure and candidate seams

The deepest, most stable seam for an **account pool / failover coordinator** is a new module that owns:

- **Account enumeration & ordering**: read keys from env (primary `COMMAND_CODE_API_KEY`/`COMMANDCODE_API_KEY`) and from the same auth files (`~/.commandcode/auth.json`, `~/.pi/agent/auth.json`, `~/.omp/agent/auth.json`) **extended with an account list** (e.g. optional array field; must remain backward compatible: existing shapes keep working and are treated as the single primary). Keep raw values out of logs/artifacts; expose only redacted identifiers (e.g. `keyName`, `login` from quota whoami).
- **Per-account state**: quota snapshot (credits/window limits), cooldown/penalty state, last-error classification, transport decision (delegate to transport router keyed by per-account key — it already resets on key change).
- **Selection policy**: prefer primary; on quota exhaustion (account marked exhausted), rotate to the next healthy account; on recovery signal (success or quota refresh showing availability) return to primary. Bounded: one account retry per logical request; no infinite loops.
- **Request orchestration**: wrap `streamGenerate`/`streamProvider` so a _pre-output_ failure (HTTP 429/quota-classified, selected connectivity/provider failure, or per-attempt timeout) can transparently replay on another account — only while no content-bearing event has been pushed (see 2.5). After the first content event, surface the error and never switch.
- **Concurrency control**: a per-account lease/penalty map so N concurrent subagents cannot hammer a failing account (cooldown window, and only one failover probe per account at a time).

Where the seams attach (current code):

1. **Key resolution** — `src/converters.ts` `getApiKey` + `src/api-key.ts` `getConfiguredApiKey` are the two single-key resolvers; extend or add a sibling `src/accounts.ts` that enumerates keys while keeping the existing functions as "primary only" for backward compatibility (quota command, provider display, tests).
2. **Per-request key** — `core.ts` resolves the key inside `run()` before building the request. A pool coordinator needs the key _selected_ before `streamGenerate` executes; cleanest insertion is in `index.ts` (a `streamCommandCode` wrapper) or as a new `streamFailover` in `transport.ts`'s router, which already owns per-key transport decisions and the `upgrade_required` fallback pattern (a precedent for "discard first attempt, retry differently, replay events").
3. **Failure classification** — add a pure classifier (status + body + event reason → `"quota" | "retryable-provider" | "retryable-network" | "client" | "auth" | "other"`) in a new module, reusing `isRetryableStatus`, `Retry-After`, `rawFinishReason`, and quota-window data. Generic client/request/policy failures (other 4xx, context-overflow, tool errors, schema errors) are never account-failover triggers. Account-specific authentication failures (401/403) must be tagged distinctly (`"auth"`) and classified separately from generic client errors; whether `"auth"` may trigger exactly one bounded failover switch is an open product decision to resolve at the pre-proposal gate — the classifier shape must keep it a policy flag rather than hardcode it. The existing transport-only `upgrade_required` 403 fallback stays as-is.
4. **Quota data** — `quota.ts` already returns per-account quota; a lightweight cached snapshot per account (TTL, e.g. a few minutes) with `fetchImpl` injection makes it testable without network.
5. **Transport** — `transport.ts` reset-on-key-change gives per-account transport memory for free; the pool should call `reset()` or rely on per-key state when switching.
6. **Commands** — extend `runtime.ts` command registration or `quota-command.ts` with a `/commandcode-accounts` (or status-line addition) that shows redacted account order, active account, per-account health; must never print keys.
7. **Testing** — `tests/helpers.ts` `createTestDeps` + `startMockCommandCodeServer` are the hermetic unit seams; `tests/test-transport.ts` is the seam for the router extension; `tests/test-quota.ts` for quota classification; `tests/test-pi-local.mjs` is the real-extension integration surface (mock server can simulate per-key quota responses); `scripts/live-e2e-profile.mjs` already supports multiple keys for optional live validation.

## 4. Smallest credible design (recommended next step)

Add `src/accounts.ts` (pool: enumeration, ordering, per-account state, cooldown, selection) + a failover orchestrator in `src/transport.ts` (or a thin new `src/failover.ts` consumed by the router) + pure classifier in `src/failover.ts`; wire in `index.ts` only (transport construction and quota-key resolution), keeping `core.ts` byte-for-byte untouched initially. Rationale: `core.ts` is the largest, most tested module; its existing "retry only before content" logic is the correct replay gate and can be reused by the orchestrator at the transport layer (which sees events before forwarding). This preserves single-account behavior when no account list is configured (the pool degrades to exactly today's path).

## 5. Exact risks, unknowns, and test surfaces

### Risks

- **Key leakage**: new enumeration must never print/format keys; logs and status output must use redacted identifiers; CI Gitleaks/Semgrep will flag real-looking keys in the diff; tests must assert no key material in error paths (existing pattern: `doesNotMatch(... /Bearer \S+/)`, `stderrHasSecrets`).
- **Replay semantics**: re-issuing `start` after an account switch could confuse hosts that treat `start` as terminal; must validate the host contract for duplicate `start` and rely on the `output.content.length === 0` gate; never replay after `text_start`/`thinking_start`/`toolcall_start` or after a tool result side effect.
- **Retry storms**: N concurrent subagents each failing primary would otherwise multiply requests; needs per-account cooldown + single-flight failover probes + the "one account retry per logical request" bound (attempt at most 2 accounts total per request: primary + one failover).
- **Quota staleness/race**: cached quota can be stale; window limits may lag; the failover trigger must be primarily request-response classified (429/quota error body), with quota snapshots as a secondary signal; never block on quota fetch inside the request path.
- **Transport re-detection churn**: switching accounts resets transport to `unknown`, causing a Provider API probe per switch; acceptable but must be tested (existing stale-request test pattern in `test-transport.ts`).
- **Auth-failure handling (open product decision)**: an invalid/expired failover key must never cause unbounded switching or be silently hidden — if the pool cannot serve the request, it must surface as a real error. Whether a 401/403 on the active account triggers exactly one bounded switch to the next healthy account (and whether an auth-failing account receives a cooldown) is unresolved and must be decided at the pre-proposal gate before any spec. Generic client/request/policy failures (other 4xx, context overflow, tool errors) never fail over, as confirmed.
- **Auth-file format**: extending `auth.json` with a list must not break existing single-key shapes consumed by pi/OMP itself; the extension must only _read_ additional fields, never write them (pi owns the file).
- **Compatibility**: `maxRetries: 0` default and existing transport/quota behavior must remain byte-identical when no accounts are configured; provider name stays `commandcode`.

### Unknowns (evidence needed before spec)

- Exact error body/signature Command Code returns on quota exhaustion (message text and/or status) — must be validated with a live GOAT/GO account or documented body samples before finalizing classification rules; current code has no quota-error pattern to reuse.
- Whether the host registry (`getApiKeyForProvider`) can ever return multiple keys, or whether the pool must be configured via env/auth-file only.
- Whether re-emitting `start` on a switched attempt is tolerated by pi/OMP hosts (unit + pi-local tests can verify with the mock server).
- Whether `streamNativeProvider` (Provider API path) surfaces per-attempt timeout/retry knobs compatible with per-account switching (current router only forwards options).
- Exact TTL/cooldown values for "return to primary when availability recovers" (needs a concrete recovery signal: successful request on a failover account and/or quota refresh showing primary availability).
- **Product decision (proposal blocker)**: should account-specific authentication failures (401/403 from invalid/expired credentials) trigger exactly one bounded failover switch, or surface immediately? The user confirmed rotation for quota plus selected connection/provider/account failures; credential-auth handling was not specified and must be resolved at the pre-proposal product-decision gate.

### Likely test surfaces

- New `tests/test-accounts.ts` (pure: enumeration, ordering, cooldown, selection, placeholder handling, redaction) — hermetic, no network.
- New `tests/test-failover.ts` (classifier + orchestrator with mock server: primary 429 → failover success before content; failover after content never happens; generic 4xx/context-overflow/tool errors never fail over; auth-failure failover behavior asserted per the pending product decision; bounded at one account retry; cooldown prevents storms; recovery returns to primary).
- Extended `tests/test-transport.ts` (router-level account switching with per-key transport memory).
- Extended `tests/test-quota.ts` (per-account quota snapshot + exhaustion classification).
- Integration: `tests/test-pi-local.mjs` mock server with per-key quota/generate responses; optional `scripts/live-e2e-profile.mjs` multi-key run.
- Security: assert no key material in status/quota/failover output; CI Gitleaks + Semgrep must pass on the diff.

## 6. Files touched in later phases (forecast; nothing changed now)

- New: `src/accounts.ts` (pool), `src/failover.ts` (classifier + orchestrator), `tests/test-accounts.ts`, `tests/test-failover.ts`.
- Modified: `index.ts` (wire pool into transport + quota key resolution), `src/transport.ts` (failover orchestration hook), possibly `src/quota-command.ts`/`src/runtime.ts` (accounts status command), `README.md` (env/auth-file account list docs), `tests/helpers.ts` (multi-key mock support), `tests/test-transport.ts`, `tests/test-pi-local.mjs`.
- Untouched by design: `src/core.ts` (replay gate reused, not rewritten), `src/oauth.ts`, `src/auth-server.ts`, `src/models.ts`, `src/cost.ts`, `src/pricing.ts`, `src/json-schema.ts`, `src/overflow.ts` (may gain a classifier helper only if shared).
