# Pre-proposal gate — add-multi-account-failover

Status: product decisions confirmed. Proposal may start.

Research lane: unselected. Repository evidence from `explore.md` is the current evidence base.

## Confirmed intent

- Manage multiple separately authorized Command Code accounts in the fork.
- Prefer a primary account, fail over when quota is exhausted or an eligible account/provider connection fails, and return automatically after recovery.
- Keep credentials local and out of Git, OpenSpec, diagnostics, and logs.
- Preserve existing single-account behavior when no account pool is configured.
- Never replay after content-bearing stream output or side effects.
- Never retry indefinitely or repeat an account within one logical request.

## Confirmed product decisions

1. **Credential UX and local storage**: provide extension-managed multi-login commands backed by a private local credential store with mode-0600 permissions. Credentials never enter Git or OpenSpec.
2. **Failure classes**: allow failover for quota exhaustion, network/timeouts, HTTP 408/429, eligible provider 5xx responses, and account-specific 401/403 authentication failures. Generic request, policy, content, schema, context-overflow, and tool failures remain ineligible.
3. **Breadth and visibility**: before content output, try each healthy configured account at most once per logical request. Apply account cooldowns, return automatically to the primary account after recovery, and keep switching silent during normal operation. Expose only redacted state through an explicit status command.

## Gatekeeper cleanup resolution

The delegated exploration created an untracked `.codegraph/` index outside its allowed write surface. The user explicitly selected removal, and the generated index has been deleted. Only authorized OpenSpec artifacts remain uncommitted.

## Safety invariants already fixed

- Generic request, policy, content, context-overflow, schema, and tool failures never trigger account failover.
- A request may switch accounts only before the first `thinking_start`, `text_start`, or `toolcall_start` event reaches the host.
- No credential value may be printed, persisted in an SDD artifact, or included in telemetry.
