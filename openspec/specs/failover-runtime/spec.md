# Failover Runtime Specification

Change: `add-multi-account-failover` (new capability; no canonical spec exists yet)

## Purpose

Define the bounded, pre-output account failover behavior for generation requests: failure classification, account ordering and cooldown, automatic primary recovery, and preservation of single-account behavior when no pool is configured.

## Terminology

- **Logical request**: one host-initiated generation request, spanning all account-switch attempts until it completes with `done` or terminates with `error`.
- **Content boundary**: the point at which the first content-bearing stream event (`thinking_start`, `text_start`, or `toolcall_start`) is pushed to the host, or the point at which a side effect (e.g. a tool result) occurs. The pre-output window is everything before this boundary.
- **Healthy account**: an account that is configured, not in cooldown, and has not yet been tried in the current logical request.
- **Eligible failure**: a failure of a class that may trigger an account switch. All other failures are **ineligible** and MUST surface without any account switch.
- **Cooldown**: a bounded time window during which a failing account is not selected for new logical requests.
- **Primary account**: the pool's first-ordered account, preferred whenever it is healthy.
- **Caller cancellation**: any abort, `AbortError`, or cancellation signal originating from the host, the user, or the calling code, as opposed to aborts the runtime generates itself (for example, a per-attempt timeout deadline).
- **Recovery/availability probe**: a bounded check to determine whether an account in cooldown has become healthy again. Probes are what single-flight and lease coordination govern; ordinary generation requests are never probes and are never gated by probe coordination.

## Requirements

### Requirement: Primary-First Selection With Bounded Rotation

For each logical request, the runtime MUST attempt the primary account first whenever it is healthy. When an eligible failure occurs in the pre-output window, the runtime MUST switch to the next healthy account in pool order. Within one logical request, each account MUST be tried at most once. When no healthy account remains, the runtime MUST terminate the logical request with the last eligible error (redacted) and MUST NOT loop or retry indefinitely.

#### Scenario: Primary eligible failure switches before content

- GIVEN a pool of primary A and healthy account B, and a mock server returning 429 for A and success for B
- WHEN a logical request runs
- THEN the request is attempted on A first, fails with 429 before any content-bearing event, and is replayed on B
- AND the request completes successfully on B with normal output
- AND A is entered into cooldown

#### Scenario: Each account at most once per logical request

- GIVEN a pool of accounts A, B, C, all returning eligible failures before content
- WHEN a logical request runs
- THEN each account is attempted exactly once, in pool order
- AND after C fails, the logical request terminates with an error (redacted), with no second attempt on any account

#### Scenario: All accounts unavailable

- GIVEN every configured account is either in cooldown or has already failed with an eligible failure in this logical request
- WHEN the runtime needs the next account
- THEN the logical request terminates with the last eligible error, redacted
- AND no new attempts are made and no busy-loop occurs

### Requirement: Failure Classification

The runtime MUST classify each failure into `eligible-for-failover` or `never-failover` using only verified signals: HTTP status codes, network/timeout/abort error classes, stream error events, and an extensible body/reason allowlist. The classifier MUST NOT hardcode provider-specific quota-exhaustion message strings that have not been verified against live or mocked samples. The default for unrecognized failure signals MUST be `never-failover`.

Eligible classes MUST be exactly:

- HTTP `408`, `429`, and `5xx`;
- network errors and connection errors not initiated by the caller;
- internally generated per-attempt timeouts and internally generated aborts (for example, the runtime's own attempt deadline), provided the abort did not originate from caller cancellation;
- account-specific authentication failures (HTTP `401`/`403` attributable to the active account's credential).

Ineligible classes MUST be exactly: caller cancellation, generic client errors (other 4xx), request errors, policy/content errors, schema errors, context-overflow errors, and tool errors — including when they occur before the content boundary. Caller cancellation — any `AbortError`, abort signal, or cancellation originating from the host, the user, or the calling code — MUST be classified `never-failover` and MUST terminate the logical request immediately: no account switch, no attempt on any other account, no retry, and no cooldown or penalty state applied to the aborted account.

The runtime MUST distinguish caller cancellation from internally generated timeouts/aborts deterministically (for example, by tracking abort origin at initiation via distinct abort signals or recorded provenance), not by timing, ordering heuristics, or error-message string matching. Body/reason matching MUST use a narrow, documented, extensible allowlist; extending it MUST require adding a tested pattern, not loosening defaults.

#### Scenario: Verified eligible classes trigger switch

- GIVEN the mock server returns, in separate runs, each of `408`, `429`, `502`, a network connection reset, and an internally generated per-attempt timeout (runtime-owned deadline), all before content
- WHEN each failure is classified
- THEN each is classified `eligible-for-failover` and the runtime switches to the next healthy account

#### Scenario: Caller cancellation terminates immediately without switching

- GIVEN a pool of primary A and healthy account B, and the host aborts the logical request via a caller-owned abort signal after the request is sent to A but before any content-bearing event
- WHEN the abort is classified
- THEN it is classified `never-failover`
- AND the logical request terminates immediately with the cancellation error, with no attempt on B, no retry on A, and no cooldown or penalty state recorded against A

#### Scenario: Internal timeout is eligible; caller abort is not

- GIVEN two separate runs against primary A with healthy account B available, both failing before content
- WHEN run 1 fails via the runtime's internally generated per-attempt deadline and run 2 is aborted via the caller's abort signal
- THEN run 1 classifies the failure `eligible-for-failover`, switches to B, and places A into cooldown
- AND run 2 classifies the failure `never-failover`, terminates immediately with the cancellation error, attempts no other account, and records no cooldown for A

#### Scenario: Ineligible classes never switch, even pre-content

- GIVEN the mock server returns, in separate runs, each of a generic `400`, a `404`, a policy/content rejection, a schema error, a context-overflow error, and a tool error, all before content
- WHEN each failure is classified
- THEN each is classified `never-failover`
- AND the error surfaces to the host with no account switch and no retry

#### Scenario: Unknown failure defaults to never-failover

- GIVEN the mock server returns a failure whose status, error class, and body match no rule in the allowlist
- WHEN the failure is classified
- THEN it is classified `never-failover` and surfaces without an account switch

#### Scenario: Auth-specific 401/403 allows one bounded switch

- GIVEN primary A's credential is invalid and account B is healthy
- WHEN A returns an account-specific `401` before content
- THEN the runtime performs at most one switch to B (B, once tried, is not revisited)
- AND if B also fails with an eligible failure, the last eligible error surfaces redacted

#### Scenario: Retry-After honored with cap

- GIVEN a `429` response carries `Retry-After: 3600`
- WHEN the runtime applies the retry delay
- THEN the applied delay is capped at the configured maximum and does not block the logical request beyond that cap

### Requirement: Content Boundary and Side-Effect Guard

The runtime MUST NOT switch accounts after the first content-bearing stream event (`thinking_start`, `text_start`, or `toolcall_start`) has been pushed to the host, nor after any side effect has occurred. After the content boundary, any failure MUST surface as an error without replay on any account. Re-issuing the `start` event on a switched attempt is permitted only within the pre-output window, consistent with the existing retry loop's behavior.

#### Scenario: Failure after content never switches

- GIVEN the mock server accepts the request on primary A, delivers `text_start` and one text delta, then the stream errors mid-stream
- WHEN the failure occurs
- THEN no account switch occurs, no replay occurs, and the error is surfaced redacted to the host

#### Scenario: Tool side effect prevents switching

- GIVEN a `toolcall_start` has been pushed to the host for the request on primary A
- WHEN the attempt then fails with a class that would otherwise be eligible
- THEN no account switch occurs and the error surfaces redacted

### Requirement: Account Cooldown

When an account fails with an eligible failure, the runtime MUST place that account into cooldown for a bounded, configurable window. An account in cooldown MUST NOT be selected for new logical requests. Cooldown expiry MUST make the account eligible for a bounded, non-blocking recovery probe, but MUST NOT return it to generation selection until a recognized recovery result proves availability. The logical request that discovers an expired cooldown MUST continue immediately on a healthy fallback without waiting for the probe. A successful request on an account MUST clear that account's cooldown/penalty state. Quota-snapshot signals MUST be advisory only: the primary trigger for failover is response classification, and quota fetches MUST NOT block the request path.

#### Scenario: Cooldown parks a failing account

- GIVEN primary A returns `429` and account B succeeds
- WHEN two logical requests run back-to-back
- THEN the first request uses A then B; the second request selects B first because A is in cooldown

#### Scenario: Cooldown expiry schedules recovery before re-enabling account

- GIVEN account A is in cooldown with a short, test-configured window and account B is healthy
- WHEN time advances past the cooldown window and the next logical request begins
- THEN the runtime schedules at most one bounded recovery probe for A without waiting
- AND that triggering request selects B while A remains excluded
- AND A becomes eligible for a later logical request only after recognized recovery proves availability

#### Scenario: Success clears cooldown state

- GIVEN account A has penalty/cooldown state recorded from an earlier failure
- WHEN a logical request subsequently succeeds on A
- THEN A's cooldown/penalty state is cleared and A's health is reported healthy

### Requirement: Automatic Primary Recovery

When the primary account recovers, selection MUST return to the primary automatically, without user action. A recovery signal MUST be at least one of: a successful request on the primary, or a quota refresh indicating primary availability. The runtime MUST NOT require manual re-selection of the primary.

#### Scenario: Return to primary after cooldown and success

- GIVEN primary A is in cooldown after a `429` and account B is serving traffic
- WHEN A's cooldown expires and a subsequent logical request succeeds on A
- THEN later logical requests select A first again, with no user command issued

### Requirement: Silent Operation

During normal operation, account switching MUST be silent: no notification, log line, or user-visible output announces a switch. Account state (order, health, cooldown) MUST be visible only via the explicit redacted status/list surface defined in the Account Management Specification.

#### Scenario: Switch is invisible during normal operation

- GIVEN primary A fails with `429` and account B serves the request
- WHEN the switch occurs
- THEN the host receives only normal stream events and no switch-related notification or diagnostic output is emitted

### Requirement: Single-Account Compatibility

When the pool is empty, the failover runtime MUST be inert: the existing single-account request path (default `maxRetries: 0`, transport router, quota command) MUST remain observably equivalent to the pre-change implementation — emitted stream events and their ordering, surfaced errors, key resolution precedence, command behavior, and transport semantics MUST be indistinguishable from the pre-change path, while internal implementation wiring MAY differ. No account-selection, cooldown, or classification overhead may alter observable behavior. The provider name `commandcode`, `apiBase`/model URL/cache behavior, and `compat` metadata MUST remain unchanged.

#### Scenario: Empty pool preserves existing behavior

- GIVEN no accounts are stored in the extension store and the existing env/auth-file key resolves
- WHEN unit, transport, and pi-local integration tests from before this change run
- THEN they pass unchanged against the pre-change expectations (same events, errors, and key resolution)

### Requirement: Redaction of All Failover Output

Every error, diagnostic, or status value produced by the failover runtime MUST pass through the existing redaction utilities before leaving the module. No output may contain credential material, including in the last-eligible-error surfaced when all accounts are unavailable.

#### Scenario: Terminal error is redacted

- GIVEN all accounts fail with eligible failures and the last error body contains an `Authorization`-like value
- WHEN the terminal error surfaces to the host
- THEN the surfaced message matches no secret-scanning pattern (e.g. no `Bearer \S+`) and contains no key material
