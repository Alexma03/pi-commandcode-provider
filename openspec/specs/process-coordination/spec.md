# Process Coordination Specification

Change: `add-multi-account-failover` (new capability; no canonical spec exists yet)

## Purpose

Define how account cooldown and failover coordination behave within one extension process and across concurrent processes (concurrent Pi subagents in separate child processes sharing the same workspace and account pool), including the cross-process lease/cooldown contract, atomicity, stale-lease recovery, and the privacy constraints on coordination state. Coordination governs only recovery/availability probes for accounts in cooldown; it never serializes or gates ordinary generation requests to healthy accounts.

## Terminology

- **Process-local coordination**: cooldown and single-flight state held in the memory of one extension (Node) process.
- **Cross-process coordination**: shared cooldown/lease state used by multiple concurrent extension processes operating on the same account pool.
- **Lease**: a mutual-exclusion grant held by one process for one account, bounding concurrent recovery/availability probes for that account within a coordination window.
- **Recovery/availability probe**: a bounded check to determine whether an account in cooldown has become healthy again (for example, when its cooldown expires). Probes are what leases and single-flight coordination govern.
- **Ordinary generation request**: a host-initiated logical request served on a healthy account. Ordinary requests are never probes and MUST NOT be serialized, gated, or metered by lease or single-flight coordination.
- **Stale lease**: a lease whose holder is no longer running (crashed or killed) or whose age exceeds the lease TTL. Stale leases MUST be recoverable.
- **Coordination state**: all durable data used for cross-process coordination (leases, cooldown records, timestamps, holder identity). Distinct from the credential store, though held within the same private local state boundary.

## Requirements

### Requirement: Process-Local Coordination

Within one extension process, the runtime MUST enforce per-account cooldown state using process-local memory and MUST apply single-flight coordination only to recovery/availability probes of accounts in cooldown. Single-flight MUST NOT serialize ordinary generation requests: concurrent logical requests in one process MUST proceed in parallel, each selecting from healthy accounts independently and each honoring the at-most-once-per-account bound per logical request. Concurrent logical requests that hit the same eligible failure on the same account (for example, before the first failure's cooldown is observable) MAY each fail over independently; the resulting cooldown state MUST converge to one consistent per-account record. At most one recovery probe per account per probe window MUST be issued within the process. When no cross-process coordination is active, the runtime MUST remain fully functional using process-local state alone.

#### Scenario: Concurrent requests are not serialized

- GIVEN one extension process with N concurrent logical requests while primary A is in cooldown and account B is healthy
- WHEN the requests run
- THEN all N requests proceed concurrently against B without waiting on a probe, a lock, or another request

#### Scenario: Single-flight probing within one process

- GIVEN account A is in cooldown in one extension process and A's cooldown expires while concurrent logical requests are being served on B
- WHEN the runtime probes whether A has recovered
- THEN at most one recovery probe for A is issued within the probe window (intra-process shared state asserted in tests)
- AND concurrent requests continue on B without waiting for the probe's result

#### Scenario: Concurrent initial failures converge

- GIVEN N concurrent logical requests in one process all fail on primary A with an eligible failure before content
- WHEN each request independently fails over to the next healthy account
- THEN each request remains bounded (each account at most once per logical request) and A's cooldown state converges to one consistent record

#### Scenario: Process-local-only operation is functional

- GIVEN an environment where cross-process coordination state is absent or not yet created
- WHEN a logical request triggers failover
- THEN coordination uses process-local state and failover behavior (selection, cooldown, at-most-once) still holds within that process

### Requirement: Cross-Process Lease and Cooldown Contract

When multiple extension processes share the same workspace and account pool, coordination MUST use a shared lease/cooldown mechanism stored in the private local state boundary (under the extension state directory, mode `0600`, git-ignored), not process memory. Cross-process leases and single-flight coordination MUST apply only to recovery/availability probes for accounts in cooldown (in particular when a cooldown expires); they MUST NOT serialize, gate, or meter ordinary generation requests to healthy accounts, and MUST NOT impose a per-account or per-window limit on ordinary request traffic.

The mechanism MUST provide: mutual exclusion per account for probes (a lease), shared cooldown visibility, atomic writes/locking so concurrent processes cannot corrupt state, and stale-lease recovery. Concurrent initial failures MAY occur across processes before shared cooldown state has propagated (each process may independently fail on the same account and fail over); concurrent updates to shared state MUST converge atomically to one consistent record. While one process holds a lease probing a recovering account, other processes MUST continue serving logical requests on healthy fallback accounts without acquiring the lease or waiting for the probe. Coordination state MUST contain only redacted account identifiers, timestamps, and a holder nonce or process identity — no credential material.

The specific primitive (file lease, lock file, or equivalent) is a design decision; this specification fixes the contract, not the implementation.

#### Scenario: Concurrent child processes share cooldown

- GIVEN two extension processes P1 and P2 share the pool, and P1 places primary A into cooldown after an eligible failure
- WHEN P2 evaluates account selection for a new logical request
- THEN P2 observes A's cooldown via the shared coordination state and selects the next healthy account

#### Scenario: Only one process probes an account per window

- GIVEN two extension processes share the pool and primary A is in cooldown
- WHEN both processes reach A's cooldown expiry within one coordination window and attempt to probe A's recovery
- THEN at most one process holds the lease and probes A; the other does not duplicate the probe
- AND the non-probing process continues serving ordinary logical requests on healthy fallback accounts without acquiring the lease or waiting for the probe

#### Scenario: Normal traffic is not serialized across processes

- GIVEN process P1 holds the lease probing recovering primary A and process P2 receives new logical requests
- WHEN P2 serves those requests on healthy account B
- THEN P2 issues them immediately, without acquiring the lease and without waiting for P1's probe to complete

#### Scenario: Concurrent initial failures converge atomically

- GIVEN processes P1 and P2 both issue logical requests on primary A before any shared cooldown record is visible, and both fail with eligible failures
- WHEN both processes update shared cooldown state for A
- THEN the updates converge atomically to one consistent cooldown record, with no torn, partially written, or interleaved-corrupt content
- AND both processes subsequently exclude A from selection while the cooldown holds

#### Scenario: Atomic update under concurrent writers

- GIVEN two extension processes update shared coordination state simultaneously
- WHEN both writes complete
- THEN the resulting state is a valid record reflecting a consistent serialization of the two updates, with no torn, partially written, or interleaved-corrupt content

#### Scenario: Coordination state is credential-free and private

- GIVEN shared coordination state exists on disk
- WHEN its contents are inspected
- THEN it contains only redacted account identifiers, timestamps, and holder identity/nonce
- AND the file mode is `0600` and the path is git-ignored
- AND the contents match no secret-scanning pattern

#### Scenario: Store permission failure refuses insecure read

- GIVEN shared coordination state exists with mode `0644`
- WHEN a process loads coordination state
- THEN the process either corrects the mode to `0600` or refuses to use the shared state with a redacted warning
- AND it MUST NOT silently continue using world-readable shared state, and MUST NOT fall back to silently divergent per-process state without warning

### Requirement: Stale-Lease Recovery

A lease whose holder has terminated, or whose age exceeds the lease TTL, MUST be treated as stale. A process encountering a stale lease MUST be able to recover it safely and take over coordination. Stale-lease recovery MUST NOT require manual intervention and MUST NOT corrupt concurrent valid leases. Lease TTL values MUST be bounded and configurable. A process that crashes or is killed MUST NOT leave the pool permanently locked.

#### Scenario: Crash recovery via lease TTL

- GIVEN process P1 holds a lease on account A and is then killed without releasing it
- WHEN process P2 encounters the lease after the lease TTL has elapsed
- THEN P2 recovers the stale lease, takes over coordination for A, and continues serving logical requests
- AND the pool is not permanently locked by the orphaned lease

#### Scenario: Valid lease is not stolen

- GIVEN process P1 holds a fresh, valid lease on account A
- WHEN process P2 evaluates the lease within the TTL
- THEN P2 does not steal or overwrite P1's lease

#### Scenario: Holder-terminated lease recovery

- GIVEN the lease record identifies a holder nonce/process identity that is demonstrably no longer running
- WHEN another process inspects the lease
- THEN the lease is treated as stale and recoverable even if its TTL has not fully elapsed

### Requirement: Deterministic Test Scenarios for Coordination

The coordination contract MUST be testable deterministically, including: crash recovery (kill of a lease holder), concurrent child processes contending for one account, store permission failure, and interaction with the all-accounts-unavailable path. Tests MUST use injected clocks and process fixtures; they MUST NOT require real timing races or live credentials.

#### Scenario: Deterministic crash-recovery test

- GIVEN a test fixture that creates a lease and simulates holder termination
- WHEN recovery runs with an injected clock advanced past the TTL
- THEN recovery succeeds deterministically and the test asserts the takeover without sleep-based races

#### Scenario: Deterministic concurrency test

- GIVEN two test processes contending for the same account's lease, driven by a fixture
- WHEN both attempt to acquire the lease
- THEN exactly one acquisition succeeds and the other observes the winner, deterministically
