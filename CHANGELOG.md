# Changelog

## Unreleased

- Reformat `/commandcode-quota` output into a dashboard layout: credits remaining/used with a percentage, monthly/purchased/free sources, plan, month-to-date cost/requests/tokens, and API key name, while keeping the 5-hour/weekly usage windows and full-detail link.
- Optionally show an aggregate token count and API key name when the usage endpoints report them.
- Fix `/commandcode-quota` on Oh My Pi: OMP surfaces an unresolved `$COMMANDCODE_API_KEY` placeholder through the model registry, which previously caused a 401 on the quota endpoints. The command now filters placeholders and falls back to the env/auth-file key resolver, matching the stream path.
- Fix `/commandcode-quota` usage windows so the 5-hour and weekly limits actually render: the API reports `windowLimits` as a top-level sibling of `credits` (not nested inside it), and its `resetAt` is in milliseconds, not seconds. Both are now parsed correctly, giving real "resets in …" countdowns instead of omitting the section or showing a huge day count.
- Prefer Command Code's Provider API (`/provider/v1/chat/completions` and `/provider/v1/messages`) and automatically fall back to the existing `/alpha/generate` transport only when the Provider API returns `403 upgrade_required` for a Go-plan account.
- Remember the detected transport for the running process, re-detect it when credentials change, prevent stale in-flight requests from overwriting the new credential's transport, and never fall back for unrelated authentication, permission, rate-limit, network, or server failures.
- Use Pi's native OpenAI- and Anthropic-compatible providers for Provider API streaming, including adaptive thinking for current reasoning-capable Claude models, while preserving the existing hardened generate transport, dynamic model discovery, offline cache, refresh/status commands, pricing, and OAuth credentials.
- Let `/login` use browser authentication, an explicit API-key prompt, or a directly pasted API key.
- Add optional zero-data-retention headers through `COMMANDCODE_ZDR=1`.
- Refresh GPT-5.6 Terra and Luna display prices after their temporary 50% promotion ended, and display the current DeepSeek V4 off-peak rates for its time-dependent pricing.
- Add isolated live E2E profiles for separate Go-plan and Provider-API credentials, including an explicit selected-transport assertion and packed-package validation.

## 0.5.1 - 2026-08-11

- Add model-specific image input capabilities from the `command-code@1.15.1` catalog and forward user and tool-result images using the current Command Code wire format.
- Update the Command Code client version header to `1.15.1`.

### Contributors

- @DiyarD — reported missing vision support for GPT-5.6 Luna, Muse Spark 1.2, and other vision-capable models.

## 0.5.0 - 2026-08-07

- Stop replaying completed assistant reasoning traces to Command Code while preserving visible text and completed tool calls in follow-up request history.
- Add `/commandcode-refresh` and `/commandcode-status` commands for safe model-catalog refreshes and redacted diagnostics.
- Bound model discovery to a configurable 10-second timeout so a slow Provider API cannot block pi startup; timed-out discovery uses the validated cache when available.
- Normalize Command Code context overflow failures so pi can auto-compact and retry, while leaving unrelated rate-limit and capacity errors unchanged.
- Keep the legacy `/alpha/generate` integration explicitly text-only: image input and image tool results are rejected instead of being silently dropped, and models do not claim image capability until the protocol exposes documented support and limits.
- Replace blanket reasoning metadata with model-specific Command Code effort support. Known models expose a `thinkingLevelMap`, and selected supported Pi levels are forwarded as `params.reasoning_effort`; unsupported or unknown models do not receive reasoning request fields.
- Add repository commands for testing the current checkout either in a logged-out, automatically cleaned-up pi environment or with existing credentials and only Command Code models enabled.
- Refresh display pricing for the current Command Code model catalog, remove expired Qwen promotional rates, add current free and discounted models, and require review when temporary prices expire.
- Use the host-provided `pi-ai` and `pi-coding-agent` core packages instead of installing private runtime copies, including for local and out-of-store development checkouts.
- Fix cached input tokens being counted twice.

### Contributors

- @IfkumRfnl — fixed cached input token accounting.

## 0.4.3 - 2026-08-02

- Allow pi to start when model discovery is unavailable. The provider now caches the last successfully fetched model catalog so previously discovered Command Code models remain selectable offline; a first offline start without a cache keeps Command Code unavailable until `/reload` succeeds.

### Contributors

- @k3-2o — reported that the model-list fetch blocked pi startup when offline.

## 0.4.2 - 2026-07-05

- Fix Oh My Pi extension validation by avoiding the missing `calculateCost` export from OMP's legacy `pi-ai` shim.
- Add a regression test that locks the local Command Code cost calculation to pi-ai's upstream `calculateCost` behavior.

### Contributors

- @CoderTCY — reported the Oh My Pi installation failure.

## 0.4.1 - 2026-06-16

- Use the explicit `$COMMANDCODE_API_KEY` provider registration syntax expected by newer pi versions, removing the startup deprecation warning while keeping legacy placeholder compatibility.
- Refresh development dependency lockfile entries to resolve npm audit findings for `tsx`/`esbuild` and `protobufjs`.

### Contributors

- @plumj-am — fixed the pi provider `apiKey` deprecation warning.
- @cad0p — reported retry/deprecation-related issues that helped validate the current behavior.
- @bl4zee1g — reported provider availability concerns that prompted additional local/live validation.

## 0.4.0 - 2026-06-02

- Add retry mechanism for transient HTTP errors (429, 5xx) and stream-level errors, configurable via pi `settings.json` `retry.provider` fields (`timeoutMs`, `maxRetries`, `maxRetryDelayMs`). Supports exponential backoff with jitter and `Retry-After` header.

## 0.3.1 - 2026-05-29

- Bump CLI version header to `0.29.0` for Command Code API parity.
- Harden PR security pipeline CI configuration.

## 0.3.0 - 2026-05-28

- Add OMP (Oh My Pi) provider compatibility: support `~/.omp/agent/auth.json` auth path, handle OMP's env-var-name-as-apiKey quirk, convert OMP system prompt arrays to text.
- Close open thinking blocks before starting text or tool output to prevent event ordering issues when upstream omits `reasoning-end`.
- Correct DeepSeek V4 Pro discount as permanent (no expiry), not time-limited.
- Correct DeepSeek V4 Flash cache-read rate to $0.028/M and add xiaomi/mimo models to pricing table.
- Upgrade pi dependencies from `@mariozechner` 0.72.0 to `@earendil-works` 0.75.5.
- Move `pi-coding-agent` to optional peerDependencies.

## 0.2.0 - 2026-05-27

- Stream `reasoning-delta` events incrementally instead of buffering the full thinking block until `reasoning-end`. Emits `thinking_start`, `thinking_delta`, and `thinking_end` events as they arrive so the UI can show reasoning in real time.
- Close open text blocks on `reasoning-start` and `reasoning-delta` so thinking and text never overlap in the output.
- Add live display pricing (`MODEL_COSTS`) for known Command Code models. Cost falls back to zero for models not yet in the price table until the Provider API exposes pricing directly.
- Fetch models from the Command Code Provider API at startup (inherited from upstream 0.1.1) and overlay the static cost table.

## 0.1.1 - 2026-05-26

- Align Command Code generate requests with CLI `0.27.2` headers and payload shape.
- Support official Command Code CLI auth files using the `command-code` credential key.
- Handle `reasoning-start` and ignore streamed `tool-result` events.
- Cap generated `max_tokens` by the selected model and the Command Code output limit.

## 0.1.0 - 2026-05-05

- Initial public release.
