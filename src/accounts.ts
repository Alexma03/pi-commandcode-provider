import { MAX_LABEL_LENGTH, type AccountStore, type AccountStoreSnapshot } from "./account-store.ts"
// WU 5 introduces the shared coordination store; before then the service is
// process-local and these types are structurally inlined so WU 2 stays coherent.
type CoordinationFailureClass = "transient" | "rate-limit" | "account-auth"
interface CoordinationCooldown {
  readonly epoch: number
  readonly failureClass: CoordinationFailureClass
  readonly failedAt: number
  readonly cooldownUntil: number
  readonly nextProbeAt: number
}
interface CoordinationLease {
  readonly nonce: string
  readonly pid: number
  readonly processStartedAt: number
  readonly acquiredAt: number
  readonly expiresAt: number
  readonly cooldownEpoch: number
  readonly fence: number
}
interface CoordinationSnapshot {
  readonly format: string
  readonly version: number
  readonly revision: number
  readonly cooldowns: Readonly<Record<string, CoordinationCooldown>>
  readonly leases: Readonly<Record<string, CoordinationLease>>
}
interface CoordinationCooldownUpdate {
  readonly failureClass: CoordinationFailureClass
  readonly failedAt: number
  readonly cooldownUntil: number
  readonly nextProbeAt: number
}
type CoordinationProbeResult =
  | { readonly kind: "available" }
  | { readonly kind: "unavailable"; readonly update: CoordinationCooldownUpdate }
  | { readonly kind: "unknown" }
interface CoordinationStore {
  load(): Promise<
    | { readonly kind: "absent" }
    | { readonly kind: "loaded"; readonly snapshot: CoordinationSnapshot }
    | { readonly kind: "unavailable"; readonly reason: string }
  >
  recordCooldown(
    accountId: string,
    update: CoordinationCooldownUpdate,
  ): Promise<CoordinationCooldown>
  acquireProbe(accountId: string): Promise<CoordinationLease | undefined>
  applyProbeResult(
    accountId: string,
    lease: CoordinationLease,
    result: CoordinationProbeResult,
  ): Promise<boolean>
  releaseProbe(accountId: string, nonce: string): Promise<boolean>
  pruneAccount(accountId: string): Promise<void>
}
import type { AcquiredCommandCodeAccount } from "./oauth.ts"
import {
  createQuotaSnapshotCache,
  fetchCommandCodeQuota,
  interpretCommandCodeAvailability,
  type QuotaAvailability,
  type QuotaSnapshot,
  type QuotaSnapshotCache,
} from "./quota.ts"
import type { CommandCodeQuota, CommandCodeQuotaResult } from "./quota-types.ts"
import { redactDiagnosticText } from "./runtime.ts"
// WU 3 introduces the structured TransportFailure shape in types.ts; until then
// the eligible-failure input structurally matches its future fields.
type TransportFailureKind = "http" | "network" | "abort" | "stream" | "unknown"
type TransportFailurePhase = "payload" | "request" | "response" | "stream"
interface TransportFailure {
  readonly source?: "generate" | "native"
  readonly phase?: TransportFailurePhase
  readonly kind?: TransportFailureKind
  readonly status?: number
  readonly retryAfterMs?: number
  readonly providerCode?: string
  readonly providerType?: string
  readonly streamReason?: "upstream-connection" | "truncated"
  readonly abortOrigin?: "caller" | "runtime-timeout" | "runtime-abort"
}

export type AccountMode =
  | { readonly kind: "legacy" }
  | { readonly kind: "pool"; readonly revision: number }
  | { readonly kind: "unavailable"; readonly message: string }

export type AccountHealth = "healthy" | "cooling" | "probe-due" | "probing"
export type AccountFailureClass = "transient" | "rate-limit" | "account-auth"

export interface AccountPublicView {
  readonly id: string
  readonly label: string
  readonly order: number
  readonly primary: boolean
}

export interface AccountStatusView extends AccountPublicView {
  readonly active: boolean
  readonly health: AccountHealth
  /** Remaining cooldown in milliseconds, not a credential-bearing value. */
  readonly retryAfter?: number
  /** Age of the process-local normalized quota snapshot, when one exists. */
  readonly quotaSnapshotAge?: number
}

export interface AccountAttempt {
  readonly id: string
  readonly label: string
  /** Internal transport boundary only. Never return this from a public view. */
  readonly apiKey: string
}

export interface LogicalRequestPlan {
  readonly revision: number
  readonly attempts: readonly AccountAttempt[]
  readonly unavailableUntil?: number
}

export type PlanLogicalRequestOptions =
  | { readonly tried?: ReadonlySet<string> }
  | ReadonlySet<string>

export interface AccountCooldownDefaults {
  readonly transientMs: number
  readonly rateLimitMs: number
  readonly accountAuthMs: number
  readonly maximumMs: number
}

export const DEFAULT_ACCOUNT_COOLDOWNS: AccountCooldownDefaults = Object.freeze({
  transientMs: 60_000,
  rateLimitMs: 5 * 60_000,
  accountAuthMs: 15 * 60_000,
  maximumMs: 15 * 60_000,
})

export type EligibleFailure = Omit<Partial<TransportFailure>, "kind"> & {
  readonly kind?: TransportFailure["kind"] | "network" | "timeout" | AccountFailureClass
  readonly failureClass?: AccountFailureClass | "network" | "timeout"
}

export interface AccountHealthSnapshot {
  readonly id: string
  readonly health: AccountHealth
  readonly epoch: number
  readonly failureClass?: AccountFailureClass
  readonly failedAt?: number
  readonly cooldownUntil?: number
  readonly retryAfterMs?: number
  readonly nextProbeAt?: number
}

export type AccountProbeResult =
  | { readonly kind: "available" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "unknown" }
  | CommandCodeQuotaResult

export interface AccountProbeOptions {
  readonly signal: AbortSignal
  readonly timeoutMs: number
  readonly failureClass: AccountFailureClass
}

export type AccountQuotaRefreshResult =
  | {
      readonly ok: true
      readonly quota: CommandCodeQuota
      readonly fetchedAt: number
      readonly availability: QuotaAvailability
    }
  | { readonly ok: false; readonly error: { readonly message: string; readonly kind: string } }

export interface AccountService {
  mode(): Promise<AccountMode>
  planLogicalRequest(options?: PlanLogicalRequestOptions): Promise<LogicalRequestPlan>
  isStillConfigured(id: string, revision: number): Promise<boolean>
  recordEligibleFailure(id: string, failure: EligibleFailure): Promise<void>
  recordSuccess(id: string, attemptStartedAt: number): Promise<void>
  getHealth(id: string): AccountHealthSnapshot | undefined
  add(acquired: AcquiredCommandCodeAccount): Promise<AccountPublicView>
  remove(id: string): Promise<void>
  setPrimary(id: string): Promise<void>
  listStatus(): Promise<readonly AccountStatusView[]>
  refreshQuota(id: string): Promise<AccountQuotaRefreshResult>
  getQuotaSnapshot(id: string): QuotaSnapshot | undefined
  /** Test/future-coordination seam for representing probe state locally. */
  setProbeState?(id: string, state: "probe-due" | "probing" | undefined): void
  shutdown(): Promise<void>
}

export interface AccountServiceOptions {
  readonly store: AccountStore
  readonly pruneAccountState?: (id: string) => Promise<void>
  readonly coordination?: CoordinationStore | null
  readonly warning?: (message: string) => void
  readonly probeAccount?: (
    account: AccountAttempt,
    options: AccountProbeOptions,
  ) => Promise<AccountProbeResult>
  /** Alias accepted by tests and future host wiring. */
  readonly probe?: (
    account: AccountAttempt,
    options: AccountProbeOptions,
  ) => Promise<AccountProbeResult>
  readonly fetchQuota?: typeof fetchCommandCodeQuota
  readonly quotaCache?: QuotaSnapshotCache
  readonly apiBase?: string
  readonly fetchImpl?: typeof fetch
  readonly headers?: Record<string, string>
  readonly probeTimeoutMs?: number
  readonly probeWindowMs?: number
  readonly leaseTtlMs?: number
  readonly quotaSnapshotTtlMs?: number
  readonly now?: () => number
  readonly clock?: () => number
  readonly cooldownDefaults?: Partial<AccountCooldownDefaults>
  /** Alias accepted by tests and later coordination integration. */
  readonly cooldowns?: Partial<AccountCooldownDefaults>
  readonly transientCooldownMs?: number
  readonly rateLimitCooldownMs?: number
  readonly accountAuthCooldownMs?: number
  readonly maximumCooldownMs?: number
}

interface LocalPenalty {
  readonly failureClass: AccountFailureClass
  readonly failedAt: number
  readonly cooldownUntil: number
  readonly nextProbeAt?: number
  readonly epoch: number
  readonly retryAfterMs?: number
}

function sanitizeLabel(value: string | undefined, credential: string): string | undefined {
  if (!value) return undefined
  const sanitized = Array.from(value)
    .filter((character) => {
      const code = character.charCodeAt(0)
      return code > 31 && code !== 127
    })
    .join("")
    .trim()
    .slice(0, MAX_LABEL_LENGTH)
  if (
    !sanitized ||
    sanitized.includes(credential) ||
    redactDiagnosticText(sanitized) !== sanitized
  ) {
    return undefined
  }
  return sanitized
}

function finiteNonNegative(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback
}

function cooldownDefaults(options: AccountServiceOptions): AccountCooldownDefaults {
  const configured = {
    ...DEFAULT_ACCOUNT_COOLDOWNS,
    ...options.cooldowns,
    ...options.cooldownDefaults,
  }
  return Object.freeze({
    transientMs: finiteNonNegative(
      options.transientCooldownMs ?? configured.transientMs,
      DEFAULT_ACCOUNT_COOLDOWNS.transientMs,
    ),
    rateLimitMs: finiteNonNegative(
      options.rateLimitCooldownMs ?? configured.rateLimitMs,
      DEFAULT_ACCOUNT_COOLDOWNS.rateLimitMs,
    ),
    accountAuthMs: finiteNonNegative(
      options.accountAuthCooldownMs ?? configured.accountAuthMs,
      DEFAULT_ACCOUNT_COOLDOWNS.accountAuthMs,
    ),
    maximumMs: finiteNonNegative(
      options.maximumCooldownMs ?? configured.maximumMs,
      DEFAULT_ACCOUNT_COOLDOWNS.maximumMs,
    ),
  })
}

function failureClassFor(failure: EligibleFailure): AccountFailureClass {
  if (failure.failureClass === "rate-limit") return "rate-limit"
  if (failure.failureClass === "account-auth") return "account-auth"
  const kind = (failure as { readonly kind?: string }).kind
  if (failure.status === 429 || kind === "rate-limit") return "rate-limit"
  if (failure.status === 401 || failure.status === 403 || kind === "account-auth") {
    return "account-auth"
  }
  return "transient"
}

function failureDuration(
  failureClass: AccountFailureClass,
  defaults: AccountCooldownDefaults,
  retryAfterMs: number | undefined,
): number {
  const base =
    failureClass === "rate-limit"
      ? defaults.rateLimitMs
      : failureClass === "account-auth"
        ? defaults.accountAuthMs
        : defaults.transientMs
  const boundedBase = Math.min(defaults.maximumMs, base)
  const boundedRetryAfter = failureClass === "rate-limit" ? finiteNonNegative(retryAfterMs, 0) : 0
  return Math.min(defaults.maximumMs, Math.max(boundedBase, boundedRetryAfter))
}

function currentPenalty(
  penalties: ReadonlyMap<string, LocalPenalty>,
  id: string,
  now: number,
): LocalPenalty | undefined {
  const penalty = penalties.get(id)
  return penalty && penalty.cooldownUntil > now ? penalty : undefined
}

function views(
  snapshot: AccountStoreSnapshot,
  activeAccountId: string | undefined,
  penalties: ReadonlyMap<string, LocalPenalty>,
  probeStates: ReadonlyMap<string, "probe-due" | "probing">,
  quotaCache: QuotaSnapshotCache,
  now: number,
): readonly AccountStatusView[] {
  const configuredActiveId = snapshot.accounts.some((account) => account.id === activeAccountId)
    ? activeAccountId
    : (snapshot.accounts.find((account) => !currentPenalty(penalties, account.id, now))?.id ??
      snapshot.accounts[0]?.id)
  return snapshot.accounts.map((account, index) => {
    const penalty = penalties.get(account.id)
    const state = probeStates.get(account.id)
    const cooling = currentPenalty(penalties, account.id, now)
    const probeRetryAt = penalty?.nextProbeAt
    const retryAfter = cooling
      ? Math.max(0, cooling.cooldownUntil - now)
      : probeRetryAt !== undefined && probeRetryAt > now
        ? Math.max(0, probeRetryAt - now)
        : undefined
    const health =
      state ??
      (cooling
        ? "cooling"
        : probeRetryAt !== undefined && probeRetryAt > now
          ? "cooling"
          : "healthy")
    const snapshotAge = quotaCache.age(account.id)
    return {
      id: account.id,
      label: redactDiagnosticText(account.label),
      order: index + 1,
      primary: account.id === snapshot.primaryAccountId,
      active: account.id === configuredActiveId,
      health,
      ...(retryAfter !== undefined ? { retryAfter } : {}),
      ...(snapshotAge !== undefined ? { quotaSnapshotAge: snapshotAge } : {}),
    }
  })
}

function unavailableError(): Error {
  return new Error(
    "Command Code account pool is unavailable; inspect its private state permissions.",
  )
}

function freezeAttempt(account: AccountAttempt): AccountAttempt {
  return Object.freeze(account)
}

function freezePlan(plan: LogicalRequestPlan): LogicalRequestPlan {
  return Object.freeze({
    ...plan,
    attempts: Object.freeze([...plan.attempts]),
  })
}

export function createAccountService(options: AccountServiceOptions): AccountService {
  let activeAccountId: string | undefined
  let coordinationDegraded = false
  let stopped = false
  const penalties = new Map<string, LocalPenalty>()
  const sharedCooldowns = new Map<string, CoordinationCooldown>()
  const sharedLeases = new Map<string, CoordinationLease>()
  const probeStates = new Map<string, "probe-due" | "probing">()
  const probeLeases = new Map<string, CoordinationLease>()
  const probeControllers = new Map<string, AbortController>()
  const probeTasks = new Map<string, Promise<void>>()
  const now = options.now ?? options.clock ?? Date.now
  const defaults = cooldownDefaults(options)
  // WU 4 services remain process-local unless the host explicitly supplies the
  // shared coordinator. An unsafe coordinator is disabled for this service instance.
  let coordination = options.coordination === null ? undefined : options.coordination
  const quotaCache =
    options.quotaCache ??
    createQuotaSnapshotCache({
      now,
      ttlMs: options.quotaSnapshotTtlMs,
    })
  const fetchQuota = options.fetchQuota ?? fetchCommandCodeQuota
  const probeCallback = options.probeAccount ?? options.probe
  const probeTimeoutMs = finiteNonNegative(options.probeTimeoutMs, 15_000)

  function warn(message: string): void {
    try {
      options.warning?.(redactDiagnosticText(message))
    } catch {
      // A warning callback must never interrupt account traffic.
    }
  }

  function degradeCoordination(): void {
    if (coordinationDegraded) return
    coordinationDegraded = true
    coordination = undefined
    sharedCooldowns.clear()
    sharedLeases.clear()
    for (const [id, state] of probeStates) {
      if (state === "probe-due" && !probeTasks.has(id)) probeStates.delete(id)
    }
    warn("Command Code cross-process coordination is unavailable; using process-local cooldowns.")
  }

  function penaltyFromCooldown(cooldown: CoordinationCooldown): LocalPenalty {
    return {
      failureClass: cooldown.failureClass,
      failedAt: cooldown.failedAt,
      cooldownUntil: cooldown.cooldownUntil,
      nextProbeAt: cooldown.nextProbeAt,
      epoch: cooldown.epoch,
    }
  }

  function setPenalty(id: string, penalty: LocalPenalty): void {
    penalties.set(id, penalty)
  }

  function mergeCoordination(snapshot: CoordinationSnapshot): void {
    const currentTime = now()
    for (const [id, cooldown] of Object.entries(snapshot.cooldowns) as Array<
      [string, CoordinationCooldown]
    >) {
      sharedCooldowns.set(id, cooldown)
      const local = penalties.get(id)
      if (
        !local ||
        cooldown.cooldownUntil > local.cooldownUntil ||
        (cooldown.cooldownUntil === local.cooldownUntil && cooldown.epoch >= local.epoch)
      ) {
        setPenalty(id, penaltyFromCooldown(cooldown))
      }
    }
    for (const id of [...sharedCooldowns.keys()]) {
      if (id in snapshot.cooldowns) continue
      const previousShared = sharedCooldowns.get(id)
      sharedCooldowns.delete(id)
      const local = penalties.get(id)
      if (
        previousShared &&
        local !== undefined &&
        local.epoch === previousShared.epoch &&
        local.failedAt === previousShared.failedAt &&
        local.cooldownUntil === previousShared.cooldownUntil
      ) {
        penalties.delete(id)
        if (!probeTasks.has(id)) probeStates.delete(id)
      }
    }
    sharedLeases.clear()
    for (const [id, lease] of Object.entries(snapshot.leases) as Array<
      [string, CoordinationLease]
    >) {
      sharedLeases.set(id, lease)
    }

    const ids = new Set([...sharedCooldowns.keys(), ...sharedLeases.keys(), ...probeStates.keys()])
    for (const id of ids) {
      const cooldown = sharedCooldowns.get(id)
      const lease = sharedLeases.get(id)
      const state = probeStates.get(id)
      if (lease && cooldown && lease.cooldownEpoch === cooldown.epoch) {
        probeStates.set(id, "probing")
        continue
      }
      if (state === "probing" && !probeTasks.has(id)) probeStates.delete(id)
      if (
        cooldown &&
        cooldown.cooldownUntil <= currentTime &&
        cooldown.nextProbeAt <= currentTime &&
        !lease &&
        !probeTasks.has(id)
      ) {
        probeStates.set(id, "probe-due")
      } else if (
        cooldown &&
        cooldown.nextProbeAt > currentTime &&
        !probeTasks.has(id) &&
        probeStates.get(id) === "probe-due"
      ) {
        probeStates.delete(id)
      }
    }
  }

  async function syncCoordination(): Promise<void> {
    if (!coordination) return
    try {
      const loaded = await coordination.load()
      if (loaded.kind === "unavailable") {
        degradeCoordination()
        return
      }
      if (loaded.kind === "absent") return
      mergeCoordination(loaded.snapshot)
    } catch {
      degradeCoordination()
    }
  }

  function probeUpdate(failureClass: AccountFailureClass): CoordinationCooldownUpdate {
    const failedAt = now()
    const cooldownUntil = failedAt + failureDuration(failureClass, defaults, undefined)
    return { failureClass, failedAt, cooldownUntil, nextProbeAt: cooldownUntil }
  }

  function normalizeProbeResult(
    result: AccountProbeResult | undefined,
    failureClass: AccountFailureClass,
  ): CoordinationProbeResult {
    if (result && typeof result === "object") {
      if ("kind" in result && result.kind === "available") return { kind: "available" }
      if ("kind" in result && result.kind === "unavailable") {
        return { kind: "unavailable", update: probeUpdate(failureClass) }
      }
      if ("kind" in result && result.kind === "unknown") return { kind: "unknown" }
      if ("ok" in result) {
        const availability = interpretCommandCodeAvailability(result, failureClass)
        if (availability === "available") return { kind: "available" }
        if (availability === "unavailable") {
          return { kind: "unavailable", update: probeUpdate(failureClass) }
        }
      }
    }
    return { kind: "unknown" }
  }

  async function runProbe(
    account: AccountAttempt,
    failureClass: AccountFailureClass,
    controller: AbortController,
  ): Promise<CoordinationProbeResult> {
    const cached = quotaCache.getFresh(account.id)
    if (cached) {
      const availability = interpretCommandCodeAvailability(cached.quota, failureClass)
      if (availability === "available") return { kind: "available" }
      if (availability === "unavailable") {
        return { kind: "unavailable", update: probeUpdate(failureClass) }
      }
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
        resolve(undefined)
      }, probeTimeoutMs)
      timer.unref?.()
    })
    let resolveAbort: (() => void) | undefined
    const aborted = new Promise<undefined>((resolve) => {
      resolveAbort = () => resolve(undefined)
    })
    const onAbort = () => resolveAbort?.()
    if (controller.signal.aborted) onAbort()
    else controller.signal.addEventListener("abort", onAbort, { once: true })
    try {
      const request = probeCallback
        ? probeCallback(account, {
            signal: controller.signal,
            timeoutMs: probeTimeoutMs,
            failureClass,
          })
        : fetchQuota({
            apiKey: account.apiKey,
            baseUrl: options.apiBase,
            fetchImpl: options.fetchImpl,
            extraHeaders: options.headers,
            timeoutMs: probeTimeoutMs,
            cache: quotaCache,
            cacheKey: account.id,
            now,
            accountOnly: failureClass !== "rate-limit",
          })
      const result = await Promise.race([request, timeout, aborted])
      if (timedOut || controller.signal.aborted || result === undefined) return { kind: "unknown" }
      return normalizeProbeResult(result, failureClass)
    } catch {
      return { kind: "unknown" }
    } finally {
      controller.signal.removeEventListener("abort", onAbort)
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  function scheduleProbe(account: AccountAttempt, failureClass: AccountFailureClass): void {
    if (stopped || probeTasks.has(account.id)) return
    probeStates.set(account.id, "probe-due")
    let task: Promise<void> | undefined
    task = (async () => {
      let coordinator = coordination
      let lease: CoordinationLease | undefined
      let controller: AbortController | undefined
      const expectedLocalEpoch = penalties.get(account.id)?.epoch
      try {
        if (coordinator) {
          try {
            lease = await coordinator.acquireProbe(account.id)
          } catch {
            degradeCoordination()
            coordinator = undefined
          }
          if (coordinator && !lease) {
            await syncCoordination()
            if (!sharedCooldowns.has(account.id)) probeStates.delete(account.id)
            return
          }
        }

        if (stopped) {
          if (coordinator && lease) await coordinator.releaseProbe(account.id, lease.nonce)
          return
        }
        const configured = await options.store.load()
        if (
          configured.kind !== "loaded" ||
          !configured.snapshot.accounts.some((candidate) => candidate.id === account.id)
        ) {
          if (coordinator && lease) await coordinator.releaseProbe(account.id, lease.nonce)
          return
        }

        if (lease) probeLeases.set(account.id, lease)
        probeStates.set(account.id, "probing")
        controller = new AbortController()
        probeControllers.set(account.id, controller)
        const result = await runProbe(account, failureClass, controller)
        if (stopped) return
        const latest = await options.store.load()
        if (
          stopped ||
          latest.kind !== "loaded" ||
          !latest.snapshot.accounts.some((candidate) => candidate.id === account.id)
        ) {
          return
        }

        if (coordinator && lease) {
          let applied = false
          try {
            applied = await coordinator.applyProbeResult(account.id, lease, result)
          } catch {
            degradeCoordination()
          }
          if (applied && result.kind === "available") {
            penalties.delete(account.id)
            sharedCooldowns.delete(account.id)
            probeStates.delete(account.id)
          }
          if (!coordinationDegraded) await syncCoordination()
        } else if (penalties.get(account.id)?.epoch !== expectedLocalEpoch) {
          probeStates.delete(account.id)
        } else if (result.kind === "available") {
          penalties.delete(account.id)
          probeStates.delete(account.id)
        } else {
          const previous = penalties.get(account.id)
          const update =
            result.kind === "unavailable"
              ? result.update
              : probeUpdate(previous?.failureClass ?? failureClass)
          setPenalty(account.id, {
            failureClass: update.failureClass,
            failedAt: update.failedAt,
            cooldownUntil: update.cooldownUntil,
            nextProbeAt: update.nextProbeAt,
            epoch: (previous?.epoch ?? 0) + 1,
          })
          probeStates.delete(account.id)
        }
      } catch {
        probeStates.delete(account.id)
        if (coordinator) degradeCoordination()
      } finally {
        if (coordinator && lease && probeLeases.get(account.id)?.nonce === lease.nonce) {
          try {
            await coordinator.releaseProbe(account.id, lease.nonce)
          } catch {
            if (!stopped) degradeCoordination()
          }
          probeLeases.delete(account.id)
        }
        if (controller && probeControllers.get(account.id) === controller) {
          probeControllers.delete(account.id)
        }
        if (task && probeTasks.get(account.id) === task) probeTasks.delete(account.id)
        if (
          probeStates.get(account.id) === "probing" &&
          !probeLeases.has(account.id) &&
          !sharedCooldowns.has(account.id)
        ) {
          probeStates.delete(account.id)
        }
      }
    })()
    probeTasks.set(account.id, task)
    void task.catch(() => {})
  }

  async function loadedSnapshot(): Promise<AccountStoreSnapshot | undefined> {
    const loaded = await options.store.load()
    if (loaded.kind === "unavailable") throw unavailableError()
    return loaded.kind === "loaded" ? loaded.snapshot : undefined
  }

  function healthFor(id: string): AccountHealthSnapshot | undefined {
    const penalty = penalties.get(id)
    const probeState = probeStates.get(id)
    if (!penalty && !probeState) return undefined
    return {
      id,
      health: probeState ?? (penalty && penalty.cooldownUntil > now() ? "cooling" : "healthy"),
      epoch: penalty?.epoch ?? 0,
      ...(penalty?.failureClass ? { failureClass: penalty.failureClass } : {}),
      ...(penalty?.failedAt !== undefined ? { failedAt: penalty.failedAt } : {}),
      ...(penalty?.cooldownUntil !== undefined ? { cooldownUntil: penalty.cooldownUntil } : {}),
      ...(penalty?.nextProbeAt !== undefined ? { nextProbeAt: penalty.nextProbeAt } : {}),
      ...(penalty?.retryAfterMs !== undefined ? { retryAfterMs: penalty.retryAfterMs } : {}),
    }
  }

  async function applyQuotaRecovery(
    id: string,
    availability: QuotaAvailability,
    account: AccountAttempt,
  ): Promise<void> {
    if (availability !== "available") return
    await syncCoordination()
    const penalty = penalties.get(id)
    if (!penalty) return
    if (!coordination) {
      penalties.delete(id)
      probeStates.delete(id)
      return
    }
    const coordinator = coordination
    let lease = probeLeases.get(id)
    const shared = sharedCooldowns.get(id)
    if (!lease && shared && shared.cooldownUntil <= now() && shared.nextProbeAt <= now()) {
      try {
        lease = await coordinator.acquireProbe(id)
      } catch {
        degradeCoordination()
        return
      }
      if (lease) {
        probeLeases.set(id, lease)
        probeStates.set(id, "probing")
      }
    }
    if (!lease) return
    try {
      if (await coordinator.applyProbeResult(id, lease, { kind: "available" })) {
        penalties.delete(id)
        sharedCooldowns.delete(id)
        probeStates.delete(id)
      }
    } catch {
      degradeCoordination()
    } finally {
      try {
        await coordinator.releaseProbe(id, lease.nonce)
      } catch {
        if (!coordinationDegraded) degradeCoordination()
      }
      if (probeLeases.get(id)?.nonce === lease.nonce) probeLeases.delete(id)
    }
    void account
  }

  return {
    async mode() {
      const loaded = await options.store.load()
      if (loaded.kind === "unavailable") {
        return { kind: "unavailable", message: unavailableError().message }
      }
      if (loaded.kind === "absent" || loaded.snapshot.accounts.length === 0) {
        return { kind: "legacy" }
      }
      return { kind: "pool", revision: loaded.snapshot.revision }
    },

    async planLogicalRequest(planOptions = {}) {
      const loaded = await options.store.load()
      if (loaded.kind === "unavailable") throw unavailableError()
      if (loaded.kind === "absent" || loaded.snapshot.accounts.length === 0) {
        return freezePlan({
          revision: loaded.kind === "loaded" ? loaded.snapshot.revision : 0,
          attempts: [],
        })
      }

      await syncCoordination()
      const snapshot = loaded.snapshot
      const tried =
        planOptions instanceof Set
          ? planOptions
          : "tried" in planOptions
            ? (planOptions.tried ?? new Set<string>())
            : new Set<string>()
      const primaryIndex = snapshot.accounts.findIndex(
        (account) => account.id === snapshot.primaryAccountId,
      )
      const ordered =
        primaryIndex > 0
          ? [
              snapshot.accounts[primaryIndex]!,
              ...snapshot.accounts.slice(0, primaryIndex),
              ...snapshot.accounts.slice(primaryIndex + 1),
            ]
          : [...snapshot.accounts]
      const attempts: AccountAttempt[] = []
      let unavailableUntil: number | undefined
      let hadUntriedAccount = false
      const currentTime = now()

      const noteUnavailable = (deadline: number | undefined) => {
        if (deadline === undefined) return
        unavailableUntil =
          unavailableUntil === undefined ? deadline : Math.min(unavailableUntil, deadline)
      }

      for (const account of ordered) {
        if (tried.has(account.id)) continue
        hadUntriedAccount = true
        const penalty = currentPenalty(penalties, account.id, currentTime)
        const rawPenalty = penalties.get(account.id)
        const shared = sharedCooldowns.get(account.id)
        const sharedLease = sharedLeases.get(account.id)
        const state = probeStates.get(account.id)
        const attempt = freezeAttempt({
          id: account.id,
          label: redactDiagnosticText(account.label),
          apiKey: account.credential.value,
        })

        if (shared) {
          if (shared.cooldownUntil > currentTime) {
            noteUnavailable(shared.cooldownUntil)
            continue
          }
          if (shared.nextProbeAt > currentTime) {
            noteUnavailable(shared.nextProbeAt)
            continue
          }
          if (state || sharedLease || probeTasks.has(account.id)) {
            noteUnavailable(shared.nextProbeAt)
            if (!probeTasks.has(account.id)) scheduleProbe(attempt, shared.failureClass)
            continue
          }
          probeStates.set(account.id, "probe-due")
          scheduleProbe(attempt, shared.failureClass)
          continue
        }

        if (penalty) {
          noteUnavailable(penalty.cooldownUntil)
          continue
        }
        if (state || probeTasks.has(account.id)) {
          noteUnavailable(rawPenalty?.nextProbeAt ?? rawPenalty?.cooldownUntil)
          continue
        }
        if (rawPenalty) {
          if ((rawPenalty.nextProbeAt ?? rawPenalty.cooldownUntil) > currentTime) {
            noteUnavailable(rawPenalty.nextProbeAt ?? rawPenalty.cooldownUntil)
            continue
          }
          scheduleProbe(attempt, rawPenalty.failureClass)
          continue
        }
        attempts.push(attempt)
      }

      return freezePlan({
        revision: snapshot.revision,
        attempts,
        ...(attempts.length === 0 && hadUntriedAccount && unavailableUntil !== undefined
          ? { unavailableUntil }
          : {}),
      })
    },

    async isStillConfigured(id, revision) {
      const loaded = await options.store.load()
      if (loaded.kind !== "loaded") {
        if (loaded.kind === "absent") {
          penalties.delete(id)
          sharedCooldowns.delete(id)
          sharedLeases.delete(id)
          probeStates.delete(id)
          quotaCache.clear(id)
        }
        return false
      }
      if (revision > loaded.snapshot.revision) return false
      const configured = loaded.snapshot.accounts.some((account) => account.id === id)
      if (!configured) {
        penalties.delete(id)
        sharedCooldowns.delete(id)
        sharedLeases.delete(id)
        probeControllers.get(id)?.abort()
        probeStates.delete(id)
        quotaCache.clear(id)
      }
      return configured
    },

    async recordEligibleFailure(id, failure) {
      const failureClass = failureClassFor(failure)
      const failedAt = now()
      const retryAfterMs =
        failure.retryAfterMs !== undefined && Number.isFinite(failure.retryAfterMs)
          ? Math.max(0, failure.retryAfterMs)
          : undefined
      const recordedRetryAfterMs = failureClass === "rate-limit" ? retryAfterMs : undefined
      const duration = failureDuration(failureClass, defaults, recordedRetryAfterMs)
      const proposedUntil = failedAt + duration
      const previous = penalties.get(id)
      const useIncomingDeadline = previous === undefined || proposedUntil >= previous.cooldownUntil
      const cooldownUntil = Math.max(previous?.cooldownUntil ?? 0, proposedUntil)
      const nextProbeAt = Math.max(previous?.nextProbeAt ?? 0, cooldownUntil)
      setPenalty(id, {
        failureClass: useIncomingDeadline ? failureClass : previous!.failureClass,
        failedAt: useIncomingDeadline ? failedAt : previous!.failedAt,
        cooldownUntil,
        nextProbeAt,
        epoch: (previous?.epoch ?? 0) + 1,
        ...(useIncomingDeadline && recordedRetryAfterMs !== undefined
          ? { retryAfterMs: recordedRetryAfterMs }
          : previous?.retryAfterMs !== undefined
            ? { retryAfterMs: previous.retryAfterMs }
            : {}),
      })
      probeControllers.get(id)?.abort()
      probeStates.delete(id)

      if (!coordination) return
      try {
        const shared = await coordination.recordCooldown(id, {
          failureClass,
          failedAt,
          cooldownUntil: proposedUntil,
          nextProbeAt: proposedUntil,
        })
        sharedCooldowns.set(id, shared)
        setPenalty(id, {
          ...penaltyFromCooldown(shared),
          ...(recordedRetryAfterMs !== undefined ? { retryAfterMs: recordedRetryAfterMs } : {}),
        })
      } catch {
        degradeCoordination()
      }
    },

    async recordSuccess(id, attemptStartedAt) {
      const penalty = penalties.get(id)
      if (!penalty || penalty.failedAt < attemptStartedAt) {
        penalties.delete(id)
        probeStates.delete(id)
        activeAccountId = id
      }
    },

    getHealth: healthFor,

    async add(acquired) {
      const selectedLabel =
        sanitizeLabel(acquired.keyName, acquired.apiKey) ??
        sanitizeLabel(acquired.login, acquired.apiKey)
      let stored = await options.store.addAccount({
        label: selectedLabel ?? "Account",
        credential: { kind: "api-key", value: acquired.apiKey },
      })
      if (!selectedLabel) {
        stored = await options.store.addAccount({
          label: `Account ${stored.id.slice(0, 8)}`,
          credential: { kind: "api-key", value: acquired.apiKey },
        })
      }
      const snapshot = await loadedSnapshot()
      const view = snapshot
        ? views(snapshot, activeAccountId, penalties, probeStates, quotaCache, now()).find(
            (account) => account.id === stored.id,
          )
        : undefined
      if (!view) throw unavailableError()
      return view
    },

    async remove(id) {
      try {
        await options.store.removeAccount(id)
      } catch {
        throw new Error("Unknown Command Code account")
      }
      probeControllers.get(id)?.abort()
      const probeTask = probeTasks.get(id)
      if (probeTask) await probeTask.catch(() => {})
      penalties.delete(id)
      sharedCooldowns.delete(id)
      sharedLeases.delete(id)
      probeLeases.delete(id)
      probeStates.delete(id)
      quotaCache.clear(id)
      if (activeAccountId === id) activeAccountId = undefined
      try {
        await coordination?.pruneAccount(id)
      } catch {
        degradeCoordination()
      }
      await options.pruneAccountState?.(id)
    },

    async setPrimary(id) {
      try {
        await options.store.setPrimary(id)
      } catch {
        throw new Error("Unknown Command Code account")
      }
    },

    async listStatus() {
      const snapshot = await loadedSnapshot()
      if (!snapshot) return []
      await syncCoordination()
      return views(snapshot, activeAccountId, penalties, probeStates, quotaCache, now())
    },

    async refreshQuota(id) {
      const snapshot = await loadedSnapshot()
      const account = snapshot?.accounts.find((candidate) => candidate.id === id)
      if (!account) {
        return {
          ok: false,
          error: { kind: "config", message: "Unknown Command Code account" },
        }
      }
      await syncCoordination()
      const fetchedAt = now()
      const result = await fetchQuota({
        apiKey: account.credential.value,
        baseUrl: options.apiBase,
        fetchImpl: options.fetchImpl,
        extraHeaders: options.headers,
        cache: quotaCache,
        cacheKey: id,
        now: () => fetchedAt,
      })
      if (!result.ok) return { ok: false, error: result.error }
      quotaCache.set(id, result.quota, fetchedAt)
      const failureClass = penalties.get(id)?.failureClass ?? "rate-limit"
      const availability = interpretCommandCodeAvailability(result, failureClass)
      const attempt: AccountAttempt = freezeAttempt({
        id,
        label: redactDiagnosticText(account.label),
        apiKey: account.credential.value,
      })
      await applyQuotaRecovery(id, availability, attempt)
      return { ok: true, quota: result.quota, fetchedAt, availability }
    },

    getQuotaSnapshot(id) {
      return quotaCache.get(id)
    },

    setProbeState(id, state) {
      if (state === undefined) probeStates.delete(id)
      else probeStates.set(id, state)
    },

    async shutdown() {
      stopped = true
      for (const controller of probeControllers.values()) controller.abort()
      const tasks = [...probeTasks.values()]
      const releases = [...probeLeases].map(([id, lease]) =>
        coordination?.releaseProbe(id, lease.nonce).catch(() => false),
      )
      await Promise.allSettled([...tasks, ...releases])
      probeControllers.clear()
      probeLeases.clear()
      probeTasks.clear()
      sharedLeases.clear()
      probeStates.clear()
    },
  }
}
