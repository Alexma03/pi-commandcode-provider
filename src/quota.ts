/**
 * Command Code usage/quota fetch layer for the `/commandcode-quota` command.
 *
 * Command Code exposes account usage through a set of authenticated alpha
 * endpoints (the same ones the `cmd` CLI `/usage` command uses):
 *
 * - `/alpha/whoami`               -> resolved account + optional org id
 * - `/alpha/billing/credits`      -> monthly/purchased/free credits + window limits
 * - `/alpha/billing/subscriptions`-> plan id, status, billing period
 * - `/alpha/usage/summary`        -> period totals (cost, request count, optional tokens)
 *
 * These endpoints are not part of the documented public Provider API
 * (`/provider/v1/*`) but are shipped with every `command-code` CLI release and
 * authenticate with the same API key the provider already uses. Fetches are
 * wrapped defensively so the quota command degrades to a readable error rather
 * than surfacing raw transport details.
 */

import { redactCommandCodeErrorText } from "./overflow.ts"

export const DEFAULT_API_BASE = "https://api.commandcode.ai"

export const QUOTA_TIMEOUT_MS = 15_000

/**
 * A single rolling usage window (the 5-hour or weekly cap on a plan's monthly
 * credits). Values are measured in credit value, not request count.
 */
export interface CommandCodeWindowLimit {
  window: "fiveHour" | "weekly"
  used: number
  cap: number
  /** Unix epoch seconds when this window resets, normalized from seconds or ms. */
  resetAt: number | null
}

/** Credits exposed by the `/alpha/billing/credits` endpoint. */
export interface CommandCodeCredits {
  monthlyCredits: number
  purchasedCredits: number
  freeCredits: number
  remainingCredits: number
  windowLimits: CommandCodeWindowLimit[]
}

/** Subscription/plan info exposed by `/alpha/billing/subscriptions`. */
export interface CommandCodeSubscription {
  planId: string | null
  status: string | null
  currentPeriodStart: string | null
  currentPeriodEnd: string | null
}

/** Period totals exposed by `/alpha/usage/summary`. */
export interface CommandCodeUsageSummary {
  totalCost: number
  totalCount: number
  /** Optional aggregate token count; only shown when the endpoint reports it. */
  totalTokens?: number
}

/** Fully normalized quota snapshot for display. */
export interface CommandCodeQuota {
  account: {
    login: string
    orgId: string | null
    /** Optional API key / account display name; falls back to login. */
    keyName?: string
  }
  credits: CommandCodeCredits | null
  subscription: CommandCodeSubscription | null
  summary: CommandCodeUsageSummary | null
}

export type CommandCodeQuotaResult =
  | { ok: true; quota: CommandCodeQuota }
  | { ok: false; error: { message: string; kind: "config" | "http" | "network" | "timeout" } }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function numberValue(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  return value >= 0 ? value : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

interface FetchOptions {
  apiKey: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** Extra HTTP headers merged after Content-Type/Authorization (e.g. ZDR). */
  extraHeaders?: Record<string, string>
}

function buildUrl(path: string, params: Record<string, string | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, value)
  }
  const query = search.toString()
  return `${path}${query ? `?${query}` : ""}`
}

/** Extract the WindowLimit array from the top-level `windowLimits` object. */
export function windowLimitsFromCredits(value: unknown): CommandCodeWindowLimit[] {
  if (!isRecord(value)) return []
  const limits: CommandCodeWindowLimit[] = []

  for (const [window, entry] of [
    ["fiveHour", value.fiveHour],
    ["weekly", value.weekly],
  ] as const) {
    if (!isRecord(entry)) continue
    const used = numberValue(entry.used) ?? 0
    const cap = numberValue(entry.cap) ?? 0
    if (cap <= 0 && used <= 0) continue
    limits.push({
      window,
      used,
      cap,
      resetAt: normalizeResetAt(entry.resetAt),
    })
  }

  return limits
}

/**
 * Normalize a `resetAt` value to epoch seconds. Accepts seconds (10-digit),
 * milliseconds (13-digit, live API), a numeric string, or an ISO timestamp
 * string, then converts ms -> s consistently. Invalid/negative values -> null.
 */
function normalizeResetAt(value: unknown): number | null {
  let num: number | undefined
  if (typeof value === "number" && Number.isFinite(value)) {
    num = value
  } else if (typeof value === "string" && value.length > 0) {
    const trimmed = value.trim()
    if (/^\d+$/.test(trimmed)) {
      num = Number(trimmed)
    } else {
      const parsed = Date.parse(trimmed)
      if (!Number.isNaN(parsed)) num = Math.round(parsed / 1000)
    }
  }
  if (num === undefined || num < 0) return null
  return num >= 1e12 ? Math.round(num / 1000) : num
}

function parseCredits(value: unknown): CommandCodeCredits | null {
  const credits = isRecord(value) ? value.credits : undefined
  if (!isRecord(credits)) return null

  // `windowLimits` is a top-level sibling of `credits` in the
  // `/alpha/billing/credits` response, not nested inside it.
  const windowLimits = isRecord(value) ? value.windowLimits : undefined

  const monthlyCredits = numberValue(credits.monthlyCredits) ?? 0
  const purchasedCredits = numberValue(credits.purchasedCredits) ?? 0
  const freeCredits = numberValue(credits.freeCredits) ?? 0

  return {
    monthlyCredits,
    purchasedCredits,
    freeCredits,
    remainingCredits: monthlyCredits + purchasedCredits + freeCredits,
    windowLimits: windowLimitsFromCredits(windowLimits),
  }
}

function parseSubscription(value: unknown): CommandCodeSubscription | null {
  const data = isRecord(value) ? value.data : undefined
  if (!isRecord(data)) return null

  return {
    planId: stringValue(data.planId) ?? null,
    status: stringValue(data.status) ?? null,
    currentPeriodStart: stringValue(data.currentPeriodStart) ?? null,
    currentPeriodEnd: stringValue(data.currentPeriodEnd) ?? null,
  }
}

function parseSummary(value: unknown): CommandCodeUsageSummary | null {
  if (!isRecord(value)) return null
  const totalTokens = numberValue(value.totalTokens) ?? numberValue(value.tokens)
  return {
    totalCost: numberValue(value.totalCost) ?? 0,
    totalCount: numberValue(value.totalCount) ?? 0,
    ...(totalTokens === undefined ? {} : { totalTokens }),
  }
}

function parseWhoami(value: unknown): {
  login: string
  orgId: string | null
  keyName?: string
} {
  const org = isRecord(value) ? value.org : undefined
  const user = isRecord(value) ? value.user : undefined

  const orgLogin = isRecord(org) ? stringValue(org.login) : undefined
  const orgId = isRecord(org) ? stringValue(org.id) : undefined
  const userLogin =
    (isRecord(user) ? stringValue(user.userName) : undefined) ??
    (isRecord(user) ? stringValue(user.name) : undefined)

  const keyName =
    stringValue(isRecord(user) ? user.keyName : undefined) ??
    stringValue(isRecord(user) ? user.displayName : undefined)

  return {
    login: orgLogin ?? userLogin ?? "Unknown account",
    orgId: orgId ?? null,
    ...(keyName === undefined ? {} : { keyName }),
  }
}

/**
 * Parse the `windowLimits` into a human-readable, header-safe line list that
 * the formatting layer appends. Split out so the pure shape is independently
 * testable.
 */
export function formatWindowLimits(
  limits: readonly CommandCodeWindowLimit[],
  now: () => number = Date.now,
): string[] {
  const labels: Record<CommandCodeWindowLimit["window"], string> = {
    fiveHour: "5-hour",
    weekly: "Weekly",
  }

  return limits.map((limit) => {
    const label = labels[limit.window] ?? limit.window
    const used = limit.used.toFixed(2)
    const cap = limit.cap.toFixed(2)
    const pct = limit.cap > 0 ? Math.round((limit.used / limit.cap) * 100) : 0
    const reset = limit.resetAt === null ? "" : ` (resets ${formatResetClock(limit.resetAt, now)})`
    return `${label}: ${used} / ${cap} credits (${pct}% used)${reset}`
  })
}

function formatResetClock(resetAtSeconds: number, now: () => number = Date.now): string {
  const date = new Date(resetAtSeconds * 1000)
  if (Number.isNaN(date.getTime())) return "unknown"
  const nowMs = now()
  const diffMs = date.getTime() - nowMs
  if (diffMs <= 0) return "soon"
  const minutes = Math.ceil(diffMs / 60_000)
  if (minutes < 60) return `in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rem = minutes % 60
  if (hours < 24) return rem > 0 ? `in ${hours}h ${rem}m` : `in ${hours}h`
  const days = Math.floor(hours / 24)
  return days === 1 ? "in 1 day" : `in ${days} days`
}

/** Derived credits view for the Remaining/Used layout. */
interface CreditView {
  /** Credits remaining (monthly + purchased + free). */
  remaining: number
  /** Dollars spent this period (totalCost). */
  spent: number
  /** Total pool used as the percentage denominator: remaining + spent. */
  pool: number
  /** Percent of the pool used, 0-100. */
  usedPercent: number
  hasCreditsInfo: boolean
}

function creditView(quota: CommandCodeQuota): CreditView {
  const credits = quota.credits
  const remaining = credits ? credits.remainingCredits : 0
  const spent = quota.summary?.totalCost ?? 0
  const pool = remaining + spent
  const hasCreditsInfo = Boolean(credits) || spent > 0
  return {
    remaining,
    spent,
    pool,
    usedPercent: hasCreditsInfo ? Math.round((pool > 0 ? spent / pool : 0) * 100) : 0,
    hasCreditsInfo,
  }
}

function creditDetailLine(credits: CommandCodeCredits | null): string {
  if (!credits) return ""
  const parts = [`monthly $${credits.monthlyCredits.toFixed(2)}`]
  parts.push(`purchased $${credits.purchasedCredits.toFixed(2)}`)
  if (credits.freeCredits > 0) parts.push(`free $${credits.freeCredits.toFixed(2)}`)
  return `Sources: ${parts.join(" / ")}`
}

function subscriptionLine(subscription: CommandCodeSubscription): string {
  const rank = subscription.planId ?? "Unknown"
  const plan = rank.replace(/[_-]+/g, " ").trim()
  const status = subscription.status ? ` (${subscription.status})` : ""
  return `Plan: ${plan}${status}`
}

function accountName(account: CommandCodeQuota["account"]): string {
  return account.keyName ?? account.login
}

/**
 * Render a normalized quota snapshot as clean, aligned, dashboard-style text
 * suitable for `ui.notify`. Pure so it can be unit tested without a runtime.
 */
export function formatQuota(quota: CommandCodeQuota, now: () => number = Date.now): string {
  const lines: string[] = []

  const credit = creditView(quota)
  if (credit.hasCreditsInfo) {
    lines.push("")
    lines.push("Credits")
    lines.push(padValue(`Remaining: $${credit.remaining.toFixed(2)} of $${credit.pool.toFixed(2)}`))
    lines.push(padValue(`Used: $${credit.spent.toFixed(2)}`))
    lines.push(`  ${credit.usedPercent}% used`)
  }

  const detail = creditDetailLine(quota.credits)
  if (detail) lines.push(detail)

  if (quota.subscription) lines.push(subscriptionLine(quota.subscription))

  if (quota.summary) {
    lines.push("")
    lines.push("Usage (this month)")
    lines.push(padValue(`Cost: $${quota.summary.totalCost.toFixed(2)}`))
    lines.push(padValue(`Requests: ${quota.summary.totalCount.toLocaleString("en-US")}`))
    if (quota.summary.totalTokens && quota.summary.totalTokens > 0) {
      lines.push(padValue(`Tokens: ${formatTokens(quota.summary.totalTokens)}`))
    }
  }

  lines.push("")
  lines.push("Username")
  lines.push(padValue(accountName(quota.account)))

  const limits = quota.credits?.windowLimits ?? []
  if (limits.length > 0) {
    lines.push("")
    lines.push("Usage windows:")
    lines.push(...formatWindowLimits(limits, now).map((line) => `  ${line}`))
  }

  lines.push("")
  lines.push(`Full detail: https://commandcode.ai/usage`)

  // Trim leading/trailing blank lines so sections stay cleanly separated.
  while (lines.length > 0 && lines[0].length === 0) lines.shift()
  while (lines.length > 0 && lines[lines.length - 1].length === 0) lines.pop()
  return lines.join("\n")
}

function padValue(value: string): string {
  return `  ${value}`
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000_000) return `${(tokens / 1_000_000_000).toFixed(1)}B`
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return String(tokens)
}

/**
 * Fetch the current account quota from Command Code.
 *
 * Resolution chain: whoami -> org id -> credits + subscription (parallel) ->
 * summary (needs the billing period start). Any individual endpoint failing
 * degrades gracefully: the remaining data is still reported, and a hard
 * failure (auth/config, network) is surfaced as a typed error.
 */
export async function fetchCommandCodeQuota(
  options: FetchOptions,
): Promise<CommandCodeQuotaResult> {
  if (!options.apiKey) {
    return {
      ok: false,
      error: { message: "No Command Code API key found", kind: "config" },
    }
  }

  const baseUrl = options.baseUrl ?? DEFAULT_API_BASE
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? QUOTA_TIMEOUT_MS

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${options.apiKey}`,
    ...options.extraHeaders,
  }

  // One overall deadline shared across the sequential phases (whoami -> billing
  // -> summary) so a slow or blackholed dependency cannot compound per-request
  // timeouts into a ~45s stall; the command reports within QUOTA_TIMEOUT_MS.
  const overallController = new AbortController()
  const overallTimer = setTimeout(() => overallController.abort(), timeoutMs)

  const request = async (path: string): Promise<unknown> => {
    // The overall deadline may already have fired (e.g. a prior phase consumed
    // the budget) — AbortSignal does not replay past abort events to listeners
    // added afterward, so check synchronously instead of relying on the listener.
    if (overallController.signal.aborted) {
      throw new QuotaTimeoutError()
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const onOverallAbort = () => controller.abort()
    overallController.signal.addEventListener("abort", onOverallAbort)
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method: "GET",
        headers,
        signal: controller.signal,
      })

      if (!response.ok) {
        let message = response.statusText
        if (response.status === 401 || response.status === 403) {
          message = "Command Code rejected the API key (401/403)"
        }
        return {
          __httpError: true,
          message,
          status: response.status,
          body: await response.text().catch(() => ""),
        }
      }
      return await response.json()
    } catch (error) {
      if (controller.signal.aborted) {
        throw new QuotaTimeoutError()
      }
      throw error
    } finally {
      clearTimeout(timer)
      overallController.signal.removeEventListener("abort", onOverallAbort)
    }
  }

  /** Optional-endpoint wrapper: never throws. Transport/timeout/parse failures
   *  become a sentinel so the rest of the dashboard still renders, matching the
   *  existing graceful degradation for HTTP 5xx responses. */
  const safeRequest = async (path: string): Promise<unknown> => {
    try {
      return await request(path)
    } catch (error) {
      return {
        __quotaError: true,
        message: errorMessage(error),
        kind: error instanceof QuotaTimeoutError ? "timeout" : "network",
      }
    }
  }

  try {
    const whoami = await request("/alpha/whoami")
    if (isHttpError(whoami)) return httpFailure(whoami, "whoami")
    const account = parseWhoami(whoami)

    const orgId = account.orgId ?? undefined
    const creditsPath = buildUrl("/alpha/billing/credits", { orgId })
    const subPath = buildUrl("/alpha/billing/subscriptions", { orgId })

    const [creditsRaw, subRaw] = await Promise.all([safeRequest(creditsPath), safeRequest(subPath)])

    // Hard auth/permission failures abort; everything else (including thrown
    // network/timeout/parse failures) degrades to a null section.
    if (isHttpError(creditsRaw) && isBlockingQuotaHttpError(creditsRaw)) {
      return httpFailure(creditsRaw, "credits")
    }
    if (isHttpError(subRaw) && isBlockingQuotaHttpError(subRaw)) {
      return httpFailure(subRaw, "subscription")
    }

    const credits =
      creditsRaw && !isHttpError(creditsRaw) && !isQuotaError(creditsRaw)
        ? parseCredits(creditsRaw)
        : null
    const subscription =
      subRaw && !isHttpError(subRaw) && !isQuotaError(subRaw) ? parseSubscription(subRaw) : null

    const since = subscription?.currentPeriodStart ?? undefined
    const summaryPath = buildUrl("/alpha/usage/summary", { orgId, since })
    const summaryRaw = await safeRequest(summaryPath)
    if (isHttpError(summaryRaw) && isBlockingQuotaHttpError(summaryRaw)) {
      return httpFailure(summaryRaw, "summary")
    }
    const summary =
      summaryRaw && !isHttpError(summaryRaw) && !isQuotaError(summaryRaw)
        ? parseSummary(summaryRaw)
        : null

    if (credits === null && subscription === null && summary === null) {
      if (overallController.signal.aborted) {
        return {
          ok: false,
          error: { message: "Command Code quota request timed out", kind: "timeout" },
        }
      }
      return {
        ok: false,
        error: {
          message: "Command Code returned no usage data for the account",
          kind: "http",
        },
      }
    }

    return {
      ok: true,
      quota: { account, credits, subscription, summary },
    }
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

class QuotaTimeoutError extends Error {
  constructor() {
    super("Command Code quota request timed out")
    this.name = "QuotaTimeoutError"
  }
}

interface HttpErrorShape {
  __httpError: true
  message: string
  status: number
  body: string
}

function isHttpError(value: unknown): value is HttpErrorShape {
  if (!isRecord(value) || value.__httpError !== true) return false
  return (
    typeof value.status === "number" &&
    typeof value.message === "string" &&
    typeof value.body === "string"
  )
}

/** Sentinel produced by safeRequest for thrown transport/timeout/parse failures. */
interface QuotaErrorShape {
  __quotaError: true
  message: string
  kind: "timeout" | "network"
}

function isQuotaError(value: unknown): value is QuotaErrorShape {
  if (!isRecord(value) || value.__quotaError !== true) return false
  return typeof value.message === "string" && (value.kind === "timeout" || value.kind === "network")
}

/**
 * Hard-failure HTTP statuses for the quota dashboard: authentication and
 * permission failures. Rate limiting (429) is deliberately NOT included — it
 * is a transient dependency condition that should degrade like other non-auth
 * endpoint failures, not abort the whole command.
 */
function isBlockingQuotaHttpError(error: HttpErrorShape): boolean {
  return error.status === 401 || error.status === 403
}

function httpFailure(error: HttpErrorShape, context: string): CommandCodeQuotaResult {
  const detail = error.body.trim().slice(0, 200)
  const message = detail
    ? `${context} request failed (${error.status}): ${detail}`
    : `${context} request failed (${error.status}): ${error.message}`
  return {
    ok: false,
    error: { message: redactValue(message), kind: "http" },
  }
}

/** Best-effort scrub of values that look like tokens/secrets from a message. */
export function redactValue(value: string): string {
  // Reuse the broader Command Code redaction (Bearer, credential key-value
  // fields, user_/cc_ tokens, query-string secrets, standalone keys) so quota
  // errors get the same protection as stream errors. Additionally catch
  // JSON-quoted credential fields ({"apiKey":"..."}) that the upstream pattern
  // requires to be adjacent to `=`/`:`.
  return redactCommandCodeErrorText(value)
    .replace(
      /("\s*(?:api[-_ ]?key|apikey|access[-_ ]?token|refresh[-_ ]?token|token|secret|password|authorization)\s*"\s*:\s*")([^"]{8,})/gi,
      "$1[redacted]",
    )
    .trim()
}
