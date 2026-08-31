# Account Management Specification

Change: `add-multi-account-failover` (new capability; no canonical spec exists yet)

## Purpose

Define how the extension manages a local pool of separately authorized Command Code accounts: secure storage of credentials, extension-managed multi-login commands, redacted status surfaces, and backward compatibility with the existing single-account configuration.

## Terminology

- **Account**: one separately authorized Command Code credential (API key) together with its redacted identifier (`keyName` or `login` derived from `whoami`).
- **Account pool**: the ordered set of accounts configured for this extension instance. The pool is non-empty only when at least one account is stored in the extension-managed credential store.
- **Primary account**: the account the pool orders first and prefers for every logical request.
- **Credential material**: any value sufficient to authenticate an account (API key value, OAuth access/refresh token, or equivalent). Never confusable with the redacted identifier.

## Requirements

### Requirement: Private Local Credential Store

The extension MUST store account credentials for the pool in a file under the extension's local state directory. The store file MUST be created with mode `0600`. The store MUST be excluded from version control (git-ignored). Credential material MUST NOT be written to OpenSpec artifacts, logs, diagnostics, telemetry, or any test fixture. If the store file exists with permissions more permissive than `0600`, the extension MUST either correct the permissions or refuse to read the store with a redacted warning; it MUST NOT read a world-readable store.

#### Scenario: Store created with 0600

- GIVEN no account store exists
- WHEN the user adds the first account
- THEN the store file is created under the extension state directory with mode `0600`
- AND the store file path is covered by a gitignore rule so it is never committed

#### Scenario: Store permissions too permissive

- GIVEN the store file exists with mode `0644`
- WHEN the extension loads the account pool
- THEN the extension either corrects the mode to `0600` or refuses to read the store
- AND in both cases emits a warning containing no credential material
- AND never reads account credentials from the world-readable file while refusing

#### Scenario: No credential material outside the store

- GIVEN one or more accounts are configured
- WHEN any command output, log line, diagnostic, or error path is produced
- THEN the output contains no credential material (asserted by existing secret-scanning patterns, e.g. no `Bearer \S+` and no key-shaped values)

### Requirement: Extension-Managed Account Commands

The extension MUST provide commands to manage the pool: add/login an account, list accounts (redacted), remove/logout an account, and set the primary account. Add/login MUST validate the credential before storing it (for example via `whoami`) and, on success, MUST record the redacted identifier for status display. Remove MUST delete the account's credential and state from the store. Set-primary MUST reorder the pool so the named account is ordered first; set-primary on a non-existent account MUST fail with a redacted error.

#### Scenario: Add account

- GIVEN an authenticated Command Code credential supplied by the user
- WHEN the add/login command runs and the credential validates against `whoami`
- THEN the account is appended to the pool in the private store
- AND the command output shows only the redacted identifier (`keyName` or `login`), never credential material

#### Scenario: Add invalid credential

- GIVEN a credential that fails validation
- WHEN the add/login command runs
- THEN no account is added to the store
- AND the command surfaces a redacted error without credential material

#### Scenario: Remove account

- GIVEN a pool with accounts A (primary) and B
- WHEN the user removes account B
- THEN B's credential and per-account state are deleted from the store
- AND subsequent account lists do not show B

#### Scenario: Set primary

- GIVEN a pool with accounts A (primary) and B
- WHEN the user sets B as primary
- THEN B is ordered first for subsequent logical requests
- AND the redacted status output reflects the new order

### Requirement: Redacted Account Listing

The account list/status surface MUST display, per account, only redacted data: order position, redacted identifier, active/health state, and cooldown remaining (see the Failover Runtime Specification). It MUST NOT display credential material in any form, including partial or masked key values.

#### Scenario: List shows redacted fields only

- GIVEN a pool with two accounts, one healthy and one in cooldown
- WHEN the user runs the account list/status command
- THEN the output shows order, redacted identifiers, health state, and cooldown remaining
- AND the output matches no secret-scanning pattern and contains no credential material

### Requirement: Single-Account Backward Compatibility

When the pool is empty, account management MUST NOT alter existing single-account behavior: the existing env-key (`COMMAND_CODE_API_KEY` / legacy `COMMANDCODE_API_KEY`) and host auth-file resolution remain the sole key source and are treated as the primary account. Existing Pi/OMP-owned auth files (`~/.commandcode/auth.json`, `~/.pi/agent/auth.json`, `~/.omp/agent/auth.json`) MUST be read-only to this extension; the extension MUST NOT write, migrate, or reformat them.

#### Scenario: Empty pool falls back to existing key resolution

- GIVEN no account is stored in the extension store
- WHEN a logical request runs
- THEN the key is resolved exactly as before this change (env key or auth-file key, host registry precedence unchanged)
- AND request-path behavior is observably equivalent to the pre-change single-account path: same key resolution precedence, same emitted stream events and errors, same command behavior, and same transport semantics (internal implementation wiring may differ)

#### Scenario: Host-owned auth files are never written

- GIVEN accounts are added, removed, or reordered via extension commands
- WHEN the store is updated
- THEN no Pi/OMP-owned auth file is modified (file mtime and content unchanged)

#### Scenario: Existing auth-file shapes still parse

- GIVEN a legacy auth file containing a plain `apiKey`, a `commandcode`/`command-code` string, or a credential record
- WHEN the extension reads it as the primary account
- THEN parsing succeeds for all pre-existing shapes without error
