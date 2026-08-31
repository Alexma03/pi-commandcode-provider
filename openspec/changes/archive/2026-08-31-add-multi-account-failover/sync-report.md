# Sync Report: add-multi-account-failover

Status: **PASS**

## Sync context

- Artifact store: `openspec` (authoritative)
- Sync mode: archive-time sync fallback, explicitly requested by the parent archive task because no prior `sync-report.md` existed.
- Source change: `openspec/changes/add-multi-account-failover/specs/`
- Canonical destination: `openspec/specs/`
- Existing canonical specs: none; each verified change spec was treated as the complete domain spec and copied additively.
- Destructive merge: none; no existing canonical requirement was replaced or removed.
- Same-domain active changes: none reported by native status and filesystem inspection.

## Domains synced

| Domain | Source | Canonical | Operation | Integrity |
| --- | --- | --- | --- | --- |
| account-management | `openspec/changes/add-multi-account-failover/specs/account-management/spec.md` | `openspec/specs/account-management/spec.md` | full copy | `cmp` pass |
| failover-runtime | `openspec/changes/add-multi-account-failover/specs/failover-runtime/spec.md` | `openspec/specs/failover-runtime/spec.md` | full copy | `cmp` pass |
| process-coordination | `openspec/changes/add-multi-account-failover/specs/process-coordination/spec.md` | `openspec/specs/process-coordination/spec.md` | full copy | `cmp` pass |

## Content operations

All 16 requirements were added to previously absent canonical domain files.

- ADDED: all requirements in the three copied domain specifications (listed in the archive report).
- MODIFIED: none.
- REMOVED: none.

## Hash evidence

### Source

- account-management: `2d496b0b63241c56144e7d79fbbe5cf025384df45561fc0cb91fe58425c34360`
- failover-runtime: `75050539e273156c438a5055e9417287672685abd03b36f1109fd40266463f16`
- process-coordination: `dab105f1d57907248097ed255e9a05c07c501747252f0d6c667b02399e0ab246`

### Canonical copies

- account-management: `2d496b0b63241c56144e7d79fbbe5cf025384df45561fc0cb91fe58425c34360`
- failover-runtime: `75050539e273156c438a5055e9417287672685abd03b36f1109fd40266463f16`
- process-coordination: `dab105f1d57907248097ed255e9a05c07c501747252f0d6c667b02399e0ab246`

No canonical spec content was dropped, merged destructively, or rewritten during sync.
