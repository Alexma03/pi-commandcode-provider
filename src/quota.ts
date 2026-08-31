import { redactCommandCodeErrorText } from "./overflow.ts"
import type {
  CommandCodeCredits,
  CommandCodeQuota,
  CommandCodeQuotaResult,
  CommandCodeQuotaSection,
  CommandCodeSubscription,
  CommandCodeUsageSummary,
  CommandCodeWindowLimit,
} from "./quota-types.ts"

export const DEFAULT_API_BASE = "https://api.commandcode.ai"
export const QUOTA_TIMEOUT_MS = 15_000

export const QUOTA_SNAPSHOT_TTL_MS = 5 * 60_000

export type QuotaAvailability = "available" | "unavailable" | "unknown"

export interface QuotaSnapshot {
  readonly quota: CommandCodeQuota
  readonly fetchedAt: number
}

export interface QuotaSnapshotCache {
  get(accountId: string): QuotaSnapshot | undefined
  getFresh(accountId: string): QuotaSnapshot | undefined
  age(accountId: string): number | undefined
  set(accountId: string, quota: CommandCodeQuota, fetchedAt?: number): void
  clear(accountId: string): void
}

export interface QuotaSnapshotCacheOptions {
  readonly now?: () => number
  readonly ttlMs?: number
}

export function createQuotaSnapshotCache(
  options: QuotaSnapshotCacheOptions = {},
): QuotaSnapshotCache {
  const now = options.now ?? Date.now
  const ttlMs = Math.max(0, options.ttlMs ?? QUOTA_SNAPSHOT_TTL_MS)
  const snapshots = new Map<string, QuotaSnapshot>()

  const age = (accountId: string): number | undefined => {
    const snapshot = snapshots.get(accountId)
    return snapshot ? Math.max(0, now() - snapshot.fetchedAt) : undefined
  }

  return {
    get(accountId) {
      return snapshots.get(accountId)
    },
    getFresh(accountId) {
      const snapshot = snapshots.get(accountId)
      return snapshot && Math.max(0, now() - snapshot.fetchedAt) < ttlMs ? snapshot : undefined
    },
    age,
    set(accountId, quota, fetchedAt = now()) {
      if (!accountId || !Number.isFinite(fetchedAt) || fetchedAt < 0) return
      snapshots.set(accountId, { quota, fetchedAt })
    },
    clear(accountId) {
      snapshots.delete(accountId)
    },
  }
}

function quotaFromResult(value: unknown): CommandCodeQuota | undefined {
  if (!isRecord(value)) return undefined
  if (value.ok === true && isRecord(value.quota)) return value.quota as unknown as CommandCodeQuota
  if ("account" in value && isRecord(value.account)) return value as unknown as CommandCodeQuota
  return undefined
}

function recognizedQuotaAccount(value: CommandCodeQuota): boolean {
  return (
    isRecord(value.account) &&
    typeof value.account.login === "string" &&
    value.account.login.length > 0
  )
}

export function interpretQuotaAvailability(value: unknown): QuotaAvailability {
  const quota = quotaFromResult(value)
  if (!quota || !recognizedQuotaAccount(quota)) return "unknown"
  const credits = quota.credits
  if (!isRecord(credits)) return "unknown"

  const remaining = numberValue(credits.remainingCredits)
  const windows = Array.isArray(credits.windowLimits)
    ? credits.windowLimits.filter(
        (window) =>
          isRecord(window) &&
          numberValue(window.used) !== undefined &&
          numberValue(window.cap) !== undefined,
      )
    : []
  if (remaining !== undefined && remaining > 0) return "available"
  if (
    windows.some(
      (window) =>
        isRecord(window) &&
        (numberValue(window.used) as number) < (numberValue(window.cap) as number),
    )
  ) {
    return "available"
  }
  if (remaining !== undefined || windows.length > 0) return "unavailable"
  return "unknown"
}

export function interpretAccountAvailability(value: unknown): QuotaAvailability {
  const quota = quotaFromResult(value)
  return quota && recognizedQuotaAccount(quota) ? "available" : "unknown"
}

export function interpretCommandCodeAvailability(
  value: unknown,
  failureClass: "transient" | "rate-limit" | "account-auth" = "rate-limit",
): QuotaAvailability {
  return failureClass === "rate-limit"
    ? interpretQuotaAvailability(value)
    : interpretAccountAvailability(value)
}

export interface FetchOptions {
  apiKey: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  extraHeaders?: Record<string, string>
  cache?: QuotaSnapshotCache
  cacheKey?: string
  now?: () => number
  /** Stop after validated identity; used by auth/transient recovery probes. */
  accountOnly?: boolean
}

interface HttpErrorShape {
  __httpError: true
  message: string
  status: number
  body: string
}

interface QuotaErrorShape {
  __quotaError: true
  kind: "timeout" | "network"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizeResetAt(value: unknown): number | null {
  let timestamp: number | undefined
  if (typeof value === "number" && Number.isFinite(value)) timestamp = value
  if (typeof value === "string" && value.length > 0) {
    const trimmed = value.trim()
    timestamp = /^\d+$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed)
  }
  if (timestamp === undefined || !Number.isFinite(timestamp) || timestamp < 0) return null
  return timestamp >= 1e12 ? Math.round(timestamp / 1000) : timestamp
}

export function windowLimitsFromCredits(value: unknown): CommandCodeWindowLimit[] {
  if (!isRecord(value)) return []
  const limits: CommandCodeWindowLimit[] = []
  for (const [window, entry] of [
    ["fiveHour", value.fiveHour],
    ["weekly", value.weekly],
  ] as const) {
    if (!isRecord(entry)) continue
    const used = numberValue(entry.used)
    const cap = numberValue(entry.cap)
    if (used === undefined || cap === undefined || (used === 0 && cap === 0)) continue
    limits.push({ window, used, cap, resetAt: normalizeResetAt(entry.resetAt) })
  }
  return limits
}

function parseCredits(value: unknown): CommandCodeCredits | null {
  if (!isRecord(value) || !isRecord(value.credits)) return null
  const credits = value.credits
  const monthlyCredits = numberValue(credits.monthlyCredits)
  const purchasedCredits = numberValue(credits.purchasedCredits)
  const freeCredits = numberValue(credits.freeCredits)
  if (monthlyCredits === undefined && purchasedCredits === undefined && freeCredits === undefined) {
    return null
  }
  const monthly = monthlyCredits ?? 0
  const purchased = purchasedCredits ?? 0
  const free = freeCredits ?? 0
  return {
    monthlyCredits: monthly,
    purchasedCredits: purchased,
    freeCredits: free,
    remainingCredits: monthly + purchased + free,
    windowLimits: windowLimitsFromCredits(value.windowLimits),
  }
}

function parseSubscription(value: unknown): CommandCodeSubscription | null {
  if (!isRecord(value) || !isRecord(value.data)) return null
  const data = value.data
  const planId = stringValue(data.planId)
  const status = stringValue(data.status)
  const currentPeriodStart = stringValue(data.currentPeriodStart)
  const currentPeriodEnd = stringValue(data.currentPeriodEnd)
  if (!planId && !status && !currentPeriodStart && !currentPeriodEnd) return null
  return {
    planId: planId ?? null,
    status: status ?? null,
    currentPeriodStart: currentPeriodStart ?? null,
    currentPeriodEnd: currentPeriodEnd ?? null,
  }
}

function parseSummary(value: unknown): CommandCodeUsageSummary | null {
  if (!isRecord(value)) return null
  const totalCost = numberValue(value.totalCost)
  const totalCount = numberValue(value.totalCount)
  if (totalCost === undefined || totalCount === undefined) return null
  const totalTokens = numberValue(value.totalTokens) ?? numberValue(value.tokens)
  return { totalCost, totalCount, ...(totalTokens === undefined ? {} : { totalTokens }) }
}

export interface CommandCodeIdentity {
  readonly login: string
  readonly orgId: string | null
  readonly keyName?: string
}

function normalizedIdentityString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const normalized = Array.from(value)
    .filter((character) => {
      const code = character.charCodeAt(0)
      return code > 31 && code !== 127
    })
    .join("")
    .trim()
  return normalized.length > 0 ? normalized : undefined
}

export function commandCodeIdentityFromWhoami(value: unknown): CommandCodeIdentity | null {
  if (!isRecord(value)) return null
  const org = isRecord(value.org) ? value.org : undefined
  const user = isRecord(value.user) ? value.user : undefined
  const login =
    (org ? normalizedIdentityString(org.login) : undefined) ??
    (user
      ? (normalizedIdentityString(user.userName) ?? normalizedIdentityString(user.name))
      : undefined)
  if (!login) return null
  const orgId = org ? normalizedIdentityString(org.id) : undefined
  const keyName = user
    ? (normalizedIdentityString(user.keyName) ?? normalizedIdentityString(user.displayName))
    : undefined
  return { login, orgId: orgId ?? null, ...(keyName ? { keyName } : {}) }
}

function buildUrl(path: string, params: Record<string, string | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value)
  }
  const query = search.toString()
  return `${path}${query ? `?${query}` : ""}`
}

function isHttpError(value: unknown): value is HttpErrorShape {
  return (
    isRecord(value) &&
    value.__httpError === true &&
    typeof value.message === "string" &&
    typeof value.status === "number" &&
    typeof value.body === "string"
  )
}

function isQuotaError(value: unknown): value is QuotaErrorShape {
  return (
    isRecord(value) &&
    value.__quotaError === true &&
    (value.kind === "timeout" || value.kind === "network")
  )
}

function isBlockingHttpError(error: HttpErrorShape): boolean {
  return error.status === 401 || error.status === 403
}

function httpFailure(error: HttpErrorShape, context: string): CommandCodeQuotaResult {
  const detail = error.body.trim().slice(0, 200)
  return {
    ok: false,
    error: {
      kind: "http",
      message: redactValue(
        `${context} request failed (${error.status}): ${detail || error.message}`,
      ),
    },
  }
}

class QuotaTimeoutError extends Error {}

export async function fetchCommandCodeQuota(
  options: FetchOptions,
): Promise<CommandCodeQuotaResult> {
  if (!options.apiKey) {
    return { ok: false, error: { message: "No Command Code API key found", kind: "config" } }
  }

  const baseUrl = options.baseUrl ?? DEFAULT_API_BASE
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? QUOTA_TIMEOUT_MS
  const overallController = new AbortController()
  const overallTimer = setTimeout(() => overallController.abort(), timeoutMs)
  const headers = {
    accept: "application/json",
    Authorization: `Bearer ${options.apiKey}`,
    ...options.extraHeaders,
  }

  const request = async (path: string): Promise<unknown> => {
    if (overallController.signal.aborted) throw new QuotaTimeoutError()
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method: "GET",
        headers,
        signal: overallController.signal,
      })
      if (!response.ok) {
        return {
          __httpError: true,
          message:
            response.status === 401 || response.status === 403
              ? "Command Code rejected the API key"
              : response.statusText,
          status: response.status,
          body: await response.text().catch(() => ""),
        } satisfies HttpErrorShape
      }
      return await response.json()
    } catch (error) {
      if (overallController.signal.aborted) throw new QuotaTimeoutError()
      throw error
    }
  }

  const safeRequest = async (path: string): Promise<unknown> => {
    try {
      return await request(path)
    } catch (error) {
      return {
        __quotaError: true,
        kind: error instanceof QuotaTimeoutError ? "timeout" : "network",
      } satisfies QuotaErrorShape
    }
  }

  try {
    const whoamiRaw = await request("/alpha/whoami")
    if (isHttpError(whoamiRaw)) return httpFailure(whoamiRaw, "whoami")
    const account = commandCodeIdentityFromWhoami(whoamiRaw)
    if (!account) {
      return {
        ok: false,
        error: { kind: "http", message: "Command Code returned an unrecognized account response" },
      }
    }

    if (options.accountOnly) {
      const quota: CommandCodeQuota = {
        account,
        credits: null,
        subscription: null,
        summary: null,
        unavailable: ["credits", "subscription", "usage"],
      }
      if (options.cache && options.cacheKey) {
        options.cache.set(options.cacheKey, quota, options.now?.())
      }
      return { ok: true, quota }
    }

    const orgId = account.orgId ?? undefined
    const [creditsRaw, subscriptionRaw] = await Promise.all([
      safeRequest(buildUrl("/alpha/billing/credits", { orgId })),
      safeRequest(buildUrl("/alpha/billing/subscriptions", { orgId })),
    ])
    if (isHttpError(creditsRaw) && isBlockingHttpError(creditsRaw)) {
      return httpFailure(creditsRaw, "credits")
    }
    if (isHttpError(subscriptionRaw) && isBlockingHttpError(subscriptionRaw)) {
      return httpFailure(subscriptionRaw, "subscription")
    }

    const unavailable: CommandCodeQuotaSection[] = []
    const credits =
      isHttpError(creditsRaw) || isQuotaError(creditsRaw) ? null : parseCredits(creditsRaw)
    if (!credits) unavailable.push("credits")
    const subscription =
      isHttpError(subscriptionRaw) || isQuotaError(subscriptionRaw)
        ? null
        : parseSubscription(subscriptionRaw)
    if (!subscription) unavailable.push("subscription")

    const summaryRaw = await safeRequest(
      buildUrl("/alpha/usage/summary", {
        orgId,
        since: subscription?.currentPeriodStart ?? undefined,
      }),
    )
    if (isHttpError(summaryRaw) && isBlockingHttpError(summaryRaw)) {
      return httpFailure(summaryRaw, "summary")
    }
    const summary =
      isHttpError(summaryRaw) || isQuotaError(summaryRaw) ? null : parseSummary(summaryRaw)
    if (!summary) unavailable.push("usage")

    if (!credits && !subscription && !summary) {
      return {
        ok: false,
        error: {
          kind: overallController.signal.aborted ? "timeout" : "http",
          message: overallController.signal.aborted
            ? "Command Code quota request timed out"
            : "Command Code returned no recognized usage data for the account",
        },
      }
    }

    const quota: CommandCodeQuota = {
      account,
      credits,
      subscription,
      summary,
      ...(unavailable.length > 0 ? { unavailable } : {}),
    }
    if (options.cache && options.cacheKey) {
      options.cache.set(options.cacheKey, quota, options.now?.())
    }
    return { ok: true, quota }
  } catch (error) {
    if (error instanceof QuotaTimeoutError || overallController.signal.aborted) {
      return {
        ok: false,
        error: { message: "Command Code quota request timed out", kind: "timeout" },
      }
    }
    return {
      ok: false,
      error: {
        message: redactValue(`Failed to fetch Command Code quota: ${errorMessage(error)}`),
        kind: "network",
      },
    }
  } finally {
    clearTimeout(overallTimer)
  }
}

export function redactValue(value: string): string {
  return redactCommandCodeErrorText(value)
    .replace(
      /("\s*(?:api[-_ ]?key|apikey|access[-_ ]?token|refresh[-_ ]?token|token|secret|password|authorization)\s*"\s*:\s*")([^"]{8,})/gi,
      "$1[redacted]",
    )
    .trim()
}
