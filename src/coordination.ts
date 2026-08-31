import { randomUUID } from "node:crypto"
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises"
import { join } from "node:path"

import {
  acquirePrivateLock,
  ensurePrivateDirectory,
  writePrivateFileAtomically,
  type AtomicWriteOptions,
  type ProcessLiveness,
  type PrivateLock,
} from "./account-store.ts"

export const COORDINATION_FORMAT = "pi-commandcode-coordination"
export const COORDINATION_VERSION = 1
export const MAX_COORDINATION_BYTES = 1024 * 1024
export const MAX_COORDINATION_ACCOUNTS = 64
export const DEFAULT_PROBE_WINDOW_MS = 30_000
export const DEFAULT_LEASE_TTL_MS = 30_000
export const DEFAULT_COORDINATION_LOCK_TTL_MS = 10_000
export const DEFAULT_COORDINATION_LOCK_WAIT_MS = 5_000
export const DEFAULT_COORDINATION_READ_RETRIES = 3

const PRIVATE_FILE_MODE = 0o600
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const FAILURE_CLASSES = new Set<CoordinationFailureClass>([
  "transient",
  "rate-limit",
  "account-auth",
])

type PrivatePathKind = "directory" | "file"

export type CoordinationFailureClass = "transient" | "rate-limit" | "account-auth"

export interface CoordinationCooldown {
  readonly epoch: number
  readonly failureClass: CoordinationFailureClass
  readonly failedAt: number
  readonly cooldownUntil: number
  readonly nextProbeAt: number
}

export interface CoordinationLease {
  readonly nonce: string
  readonly pid: number
  readonly processStartedAt: number
  readonly acquiredAt: number
  readonly expiresAt: number
  readonly cooldownEpoch: number
  readonly fence: number
}

export interface CoordinationSnapshot {
  readonly format: typeof COORDINATION_FORMAT
  readonly version: typeof COORDINATION_VERSION
  readonly revision: number
  readonly cooldowns: Readonly<Record<string, CoordinationCooldown>>
  readonly leases: Readonly<Record<string, CoordinationLease>>
}

export type CoordinationLoad =
  | { readonly kind: "absent" }
  | { readonly kind: "loaded"; readonly snapshot: CoordinationSnapshot }
  | { readonly kind: "unavailable"; readonly reason: CoordinationUnavailableReason }

export type CoordinationUnavailableReason = "permissions" | "corrupt" | "unsupported" | "io"

export class CoordinationParseError extends Error {
  constructor(readonly reason: "corrupt" | "unsupported") {
    super(
      reason === "unsupported" ? "Unsupported coordination version" : "Corrupt coordination state",
    )
    this.name = "CoordinationParseError"
  }
}

export class CoordinationUnavailableError extends Error {
  constructor(readonly reason: CoordinationUnavailableReason) {
    super(`Command Code coordination is unavailable (${reason})`)
    this.name = "CoordinationUnavailableError"
  }
}

export interface CoordinationCooldownUpdate {
  readonly failureClass: CoordinationFailureClass
  readonly failedAt: number
  readonly cooldownUntil: number
  readonly nextProbeAt: number
}

export type CoordinationProbeResult =
  | { readonly kind: "available" }
  | { readonly kind: "unavailable"; readonly update: CoordinationCooldownUpdate }
  | { readonly kind: "unknown" }

export interface CoordinationAtomicWriteOptions {
  readonly onStep?: AtomicWriteOptions["onStep"]
}

export interface CoordinationStoreOptions {
  readonly stateDir: string
  readonly uid?: () => number | undefined
  readonly uuid?: () => string
  /** Nonce source for the short metadata lock. */
  readonly nonce?: () => string
  readonly now?: () => number
  readonly pid?: () => number
  readonly processStartedAt?: () => number
  readonly isProcessAlive?: (pid: number, processStartedAt: number) => ProcessLiveness
  readonly warning?: (message: string) => void
  readonly lockTtlMs?: number
  readonly lockWaitMs?: number
  readonly lockDelay?: (milliseconds: number) => Promise<void>
  readonly readRetries?: number
  readonly beforeRead?: (attempt: number) => Promise<void>
  readonly probeWindowMs?: number
  readonly leaseTtlMs?: number
  readonly onWriteStep?: AtomicWriteOptions["onStep"]
}

export interface CoordinationStore {
  readonly stateRoot: string
  readonly coordinationPath: string
  readonly locksPath: string
  readonly lockPath: string
  load(): Promise<CoordinationLoad>
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

interface PrivatePathOptions {
  readonly uid?: () => number | undefined
  readonly warning?: (message: string) => void
}

interface ReadSnapshot {
  readonly kind: "absent" | "loaded" | "parse-error" | "error"
  readonly snapshot?: CoordinationSnapshot
  readonly error?: unknown
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}

function currentUid(): number | undefined {
  return process.platform === "win32" ? undefined : process.geteuid?.()
}

function warnSafely(warning: ((message: string) => void) | undefined, message: string): void {
  try {
    warning?.(message)
  } catch {
    // Diagnostics must never turn a local-state warning into a request failure.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function isSafeCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function encodedBytes(value: string): number {
  return Buffer.byteLength(value, "utf8")
}

function decodeCoordinationInput(value: unknown): unknown {
  if (typeof value === "string" || value instanceof Uint8Array) {
    const text = typeof value === "string" ? value : Buffer.from(value).toString("utf8")
    if (encodedBytes(text) > MAX_COORDINATION_BYTES) throw new CoordinationParseError("corrupt")
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new CoordinationParseError("corrupt")
    }
  }

  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined || encodedBytes(serialized) > MAX_COORDINATION_BYTES) {
      throw new CoordinationParseError("corrupt")
    }
    return JSON.parse(serialized) as unknown
  } catch (error) {
    if (error instanceof CoordinationParseError) throw error
    throw new CoordinationParseError("corrupt")
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function parseCooldown(value: unknown): CoordinationCooldown {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["cooldownUntil", "epoch", "failedAt", "failureClass", "nextProbeAt"])
  ) {
    throw new CoordinationParseError("corrupt")
  }
  if (
    !isSafeCounter(value.epoch) ||
    typeof value.failureClass !== "string" ||
    !FAILURE_CLASSES.has(value.failureClass as CoordinationFailureClass) ||
    !isFiniteTimestamp(value.failedAt) ||
    !isFiniteTimestamp(value.cooldownUntil) ||
    !isFiniteTimestamp(value.nextProbeAt)
  ) {
    throw new CoordinationParseError("corrupt")
  }
  return {
    epoch: value.epoch,
    failureClass: value.failureClass as CoordinationFailureClass,
    failedAt: value.failedAt,
    cooldownUntil: value.cooldownUntil,
    nextProbeAt: value.nextProbeAt,
  }
}

function parseLease(value: unknown): CoordinationLease {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "acquiredAt",
      "cooldownEpoch",
      "expiresAt",
      "fence",
      "nonce",
      "pid",
      "processStartedAt",
    ])
  ) {
    throw new CoordinationParseError("corrupt")
  }
  if (
    typeof value.nonce !== "string" ||
    !UUID_PATTERN.test(value.nonce) ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    !isFiniteTimestamp(value.processStartedAt) ||
    !isFiniteTimestamp(value.acquiredAt) ||
    !isFiniteTimestamp(value.expiresAt) ||
    value.expiresAt < value.acquiredAt ||
    !isSafeCounter(value.cooldownEpoch) ||
    typeof value.fence !== "number" ||
    !Number.isSafeInteger(value.fence) ||
    value.fence <= 0
  ) {
    throw new CoordinationParseError("corrupt")
  }
  return {
    nonce: value.nonce,
    pid: value.pid,
    processStartedAt: value.processStartedAt,
    acquiredAt: value.acquiredAt,
    expiresAt: value.expiresAt,
    cooldownEpoch: value.cooldownEpoch,
    fence: value.fence,
  }
}

function parseRecordMap<T>(
  value: unknown,
  parseEntry: (entry: unknown) => T,
): Readonly<Record<string, T>> {
  if (!isRecord(value)) throw new CoordinationParseError("corrupt")
  const entries = Object.entries(value)
  if (entries.length > MAX_COORDINATION_ACCOUNTS) throw new CoordinationParseError("corrupt")
  const parsed: Record<string, T> = {}
  for (const [accountId, entry] of entries) {
    if (!UUID_PATTERN.test(accountId)) throw new CoordinationParseError("corrupt")
    parsed[accountId] = parseEntry(entry)
  }
  return parsed
}

export function parseCoordination(value: unknown): CoordinationSnapshot {
  const decoded = decodeCoordinationInput(value)
  if (!isRecord(decoded)) throw new CoordinationParseError("corrupt")
  if (
    !exactKeys(decoded, ["cooldowns", "format", "leases", "revision", "version"]) ||
    decoded.format !== COORDINATION_FORMAT
  ) {
    throw new CoordinationParseError("corrupt")
  }
  if (decoded.version !== COORDINATION_VERSION) throw new CoordinationParseError("unsupported")
  if (!isSafeCounter(decoded.revision)) throw new CoordinationParseError("corrupt")
  return {
    format: COORDINATION_FORMAT,
    version: COORDINATION_VERSION,
    revision: decoded.revision,
    cooldowns: parseRecordMap(decoded.cooldowns, parseCooldown),
    leases: parseRecordMap(decoded.leases, parseLease),
  }
}

class PrivateCoordinationPathError extends Error {
  constructor() {
    super("Private Command Code coordination state is unavailable")
    this.name = "PrivateCoordinationPathError"
  }
}

async function inspectPrivatePath(
  path: string,
  kind: PrivatePathKind,
  options: PrivatePathOptions,
): Promise<"absent" | "ready"> {
  let stats
  try {
    stats = await lstat(path)
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return "absent"
    throw error
  }
  if (stats.isSymbolicLink() || (kind === "directory" ? !stats.isDirectory() : !stats.isFile())) {
    throw new PrivateCoordinationPathError()
  }
  const expectedUid = (options.uid ?? currentUid)()
  if (expectedUid !== undefined && stats.uid !== expectedUid)
    throw new PrivateCoordinationPathError()
  const expectedMode = kind === "directory" ? 0o700 : PRIVATE_FILE_MODE
  if ((stats.mode & 0o777) !== expectedMode) {
    try {
      await chmod(path, expectedMode)
    } catch {
      throw new PrivateCoordinationPathError()
    }
    warnSafely(options.warning, "Corrected insecure Command Code coordination permissions.")
  }
  return "ready"
}

async function ensurePrivateTextFile(
  path: string,
  contents: string,
  options: PrivatePathOptions,
  onStep?: AtomicWriteOptions["onStep"],
): Promise<void> {
  try {
    const handle = await open(path, "wx", PRIVATE_FILE_MODE)
    try {
      await handle.writeFile(contents)
      await handle.sync()
      await handle.chmod(PRIVATE_FILE_MODE)
    } finally {
      await handle.close()
    }
    return
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error
  }
  if ((await inspectPrivatePath(path, "file", options)) !== "ready") {
    throw new PrivateCoordinationPathError()
  }
  if ((await readFile(path, "utf8")) !== contents) {
    await writePrivateFileAtomically(path, contents, { onStep })
  }
}

function defaultProcessStartedAt(): number {
  return Math.max(0, Math.floor(Date.now() - process.uptime() * 1000))
}

function defaultProcessLiveness(pid: number): ProcessLiveness {
  try {
    process.kill(pid, 0)
    return "alive"
  } catch (error) {
    if (isNodeError(error, "ESRCH")) return "dead"
    return "unknown"
  }
}

function emptyCoordination(): CoordinationSnapshot {
  return {
    format: COORDINATION_FORMAT,
    version: COORDINATION_VERSION,
    revision: 0,
    cooldowns: {},
    leases: {},
  }
}

function serializeCoordination(snapshot: CoordinationSnapshot): string {
  const serialized = `${JSON.stringify(snapshot, null, 2)}\n`
  if (encodedBytes(serialized) > MAX_COORDINATION_BYTES) {
    throw new Error("Command Code coordination state exceeds its size limit")
  }
  return serialized
}

function validAccountId(accountId: string): void {
  if (!UUID_PATTERN.test(accountId)) throw new Error("Invalid coordination account id")
}

function validCooldownUpdate(update: CoordinationCooldownUpdate): void {
  if (
    !FAILURE_CLASSES.has(update.failureClass) ||
    !isFiniteTimestamp(update.failedAt) ||
    !isFiniteTimestamp(update.cooldownUntil) ||
    !isFiniteTimestamp(update.nextProbeAt)
  ) {
    throw new Error("Invalid coordination cooldown")
  }
}

function nextRevision(snapshot: CoordinationSnapshot): number {
  if (snapshot.revision >= Number.MAX_SAFE_INTEGER) {
    throw new Error("Command Code coordination revision exhausted")
  }
  return snapshot.revision + 1
}

function mergedCooldown(
  previous: CoordinationCooldown | undefined,
  update: CoordinationCooldownUpdate,
): CoordinationCooldown {
  const epoch = (previous?.epoch ?? 0) + 1
  if (!previous || update.cooldownUntil >= previous.cooldownUntil) {
    return { ...update, epoch }
  }
  return { ...previous, epoch }
}

function sameLease(left: CoordinationLease | undefined, right: CoordinationLease): boolean {
  return (
    left?.nonce === right.nonce &&
    left.fence === right.fence &&
    left.cooldownEpoch === right.cooldownEpoch
  )
}

function staleLease(
  lease: CoordinationLease,
  now: number,
  isProcessAlive: (pid: number, processStartedAt: number) => ProcessLiveness,
): boolean {
  if (lease.expiresAt <= now) return true
  try {
    return isProcessAlive(lease.pid, lease.processStartedAt) === "dead"
  } catch {
    return false
  }
}

export function createCoordinationStore(options: CoordinationStoreOptions): CoordinationStore {
  const stateRoot = options.stateDir
  const coordinationPath = join(stateRoot, "coordination.json")
  const locksPath = join(stateRoot, "locks")
  const lockPath = join(locksPath, "coordination.lock")
  const leaseUuid = options.uuid ?? randomUUID
  const lockUuid = options.nonce ?? randomUUID
  const now = options.now ?? Date.now
  const pid = options.pid ?? (() => process.pid)
  const processStartedAt = options.processStartedAt ?? defaultProcessStartedAt
  const isProcessAlive = options.isProcessAlive ?? defaultProcessLiveness
  const probeWindowMs = Math.max(0, options.probeWindowMs ?? DEFAULT_PROBE_WINDOW_MS)
  const leaseTtlMs = Math.max(1, options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS)
  const readRetries = Math.max(1, options.readRetries ?? DEFAULT_COORDINATION_READ_RETRIES)
  const privateOptions: PrivatePathOptions = { uid: options.uid, warning: options.warning }

  async function readExistingSnapshot(): Promise<ReadSnapshot> {
    for (let attempt = 0; attempt < readRetries; attempt += 1) {
      await options.beforeRead?.(attempt)
      try {
        const root = await inspectPrivatePath(stateRoot, "directory", privateOptions)
        if (root === "absent") return { kind: "absent" }
        const file = await inspectPrivatePath(coordinationPath, "file", privateOptions)
        if (file === "absent") {
          if (attempt + 1 < readRetries) continue
          return { kind: "absent" }
        }
        const stats = await lstat(coordinationPath)
        if (stats.size > MAX_COORDINATION_BYTES) {
          return { kind: "parse-error", error: new CoordinationParseError("corrupt") }
        }
        return { kind: "loaded", snapshot: parseCoordination(await readFile(coordinationPath)) }
      } catch (error) {
        if (error instanceof CoordinationParseError) return { kind: "parse-error", error }
        if (error instanceof PrivateCoordinationPathError) return { kind: "error", error }
        if (isNodeError(error, "ENOENT") && attempt + 1 < readRetries) continue
        return { kind: "error", error }
      }
    }
    return { kind: "error", error: new Error("Coordination read retry limit exceeded") }
  }

  async function ensureScaffold(): Promise<void> {
    await ensurePrivateDirectory(stateRoot, privateOptions)
    await ensurePrivateDirectory(locksPath, privateOptions)
    await ensurePrivateTextFile(
      join(stateRoot, ".gitignore"),
      "*\n",
      privateOptions,
      options.onWriteStep,
    )
  }

  function lockOptions() {
    return {
      warning: options.warning,
      uuid: lockUuid,
      pid,
      processStartedAt,
      now,
      isProcessAlive,
      ttlMs: options.lockTtlMs ?? DEFAULT_COORDINATION_LOCK_TTL_MS,
      lockWaitMs: options.lockWaitMs ?? DEFAULT_COORDINATION_LOCK_WAIT_MS,
      delay: options.lockDelay,
    } as const
  }

  async function cleanupTemporaryFiles(): Promise<void> {
    let names: string[]
    try {
      names = await readdir(stateRoot)
    } catch {
      return
    }
    await Promise.all(
      names
        .filter((name) => name.startsWith(".coordination.json.") && name.endsWith(".tmp"))
        .map((name) => rm(join(stateRoot, name), { force: true })),
    )
  }

  async function quarantineCorrupt(): Promise<void> {
    for (;;) {
      const quarantinePath = `${coordinationPath}.corrupt-${leaseUuid()}`
      try {
        await rename(coordinationPath, quarantinePath)
        await chmod(quarantinePath, PRIVATE_FILE_MODE)
        // A corrupt file is not trusted enough to preserve verbatim: it may contain
        // arbitrary provider output or credential material. Keep only a safe marker
        // in the private tombstone before installing a clean record.
        let quarantineHandle: Awaited<ReturnType<typeof open>> | undefined
        try {
          quarantineHandle = await open(quarantinePath, "w", PRIVATE_FILE_MODE)
          await quarantineHandle.writeFile("corrupt\\n")
          await quarantineHandle.sync()
          await quarantineHandle.chmod(PRIVATE_FILE_MODE)
        } finally {
          await quarantineHandle?.close().catch(() => {})
        }
        warnSafely(
          options.warning,
          "Command Code coordination state was corrupt; it was quarantined and reset.",
        )
        return
      } catch (error) {
        if (isNodeError(error, "EEXIST")) continue
        if (isNodeError(error, "ENOENT")) return
        throw error
      }
    }
  }

  async function repairCorruptUnderLock(): Promise<CoordinationSnapshot> {
    const current = await readExistingSnapshot()
    if (current.kind === "loaded") return current.snapshot!
    if (current.kind === "absent") return emptyCoordination()
    if (
      current.kind === "parse-error" &&
      (current.error as CoordinationParseError).reason === "corrupt"
    ) {
      await quarantineCorrupt()
      await writePrivateFileAtomically(
        coordinationPath,
        serializeCoordination(emptyCoordination()),
        { uuid: lockUuid, onStep: options.onWriteStep },
      )
      return emptyCoordination()
    }
    if (current.kind === "parse-error") {
      throw new CoordinationUnavailableError((current.error as CoordinationParseError).reason)
    }
    throw new CoordinationUnavailableError("permissions")
  }

  async function mutate<T>(
    operation: (snapshot: CoordinationSnapshot) => [CoordinationSnapshot, T],
  ): Promise<T> {
    await ensureScaffold()
    const lock: PrivateLock = await acquirePrivateLock(lockPath, lockOptions())
    try {
      await cleanupTemporaryFiles()
      const current = await repairCorruptUnderLock()
      const [next, result] = operation(current)
      const parsed = parseCoordination(next)
      await writePrivateFileAtomically(coordinationPath, serializeCoordination(parsed), {
        uuid: lockUuid,
        onStep: options.onWriteStep,
      })
      return result
    } finally {
      await lock.release()
    }
  }

  async function load(): Promise<CoordinationLoad> {
    let current: ReadSnapshot
    try {
      current = await readExistingSnapshot()
    } catch (error) {
      warnSafely(options.warning, "Command Code coordination state could not be read safely.")
      return { kind: "unavailable", reason: "io" }
    }
    if (current.kind === "absent") return { kind: "absent" }
    if (current.kind === "loaded") return { kind: "loaded", snapshot: current.snapshot! }
    if (current.kind === "parse-error") {
      const parseError = current.error as CoordinationParseError
      if (parseError.reason === "unsupported") {
        return { kind: "unavailable", reason: "unsupported" }
      }
      try {
        await ensureScaffold()
        const lock = await acquirePrivateLock(lockPath, lockOptions())
        try {
          const repaired = await repairCorruptUnderLock()
          return { kind: "loaded", snapshot: repaired }
        } finally {
          await lock.release()
        }
      } catch (error) {
        if (error instanceof CoordinationUnavailableError) {
          return { kind: "unavailable", reason: error.reason }
        }
        warnSafely(options.warning, "Command Code coordination state could not be repaired safely.")
        return { kind: "unavailable", reason: "io" }
      }
    }
    warnSafely(options.warning, "Command Code coordination state has unsafe permissions.")
    return { kind: "unavailable", reason: "permissions" }
  }

  return {
    stateRoot,
    coordinationPath,
    locksPath,
    lockPath,
    load,
    async recordCooldown(accountId, update) {
      validAccountId(accountId)
      validCooldownUpdate(update)
      return mutate((snapshot) => {
        const nextRecord = mergedCooldown(snapshot.cooldowns[accountId], update)
        const cooldowns = { ...snapshot.cooldowns, [accountId]: nextRecord }
        return [
          {
            ...snapshot,
            revision: nextRevision(snapshot),
            cooldowns,
          },
          nextRecord,
        ]
      })
    },
    async acquireProbe(accountId) {
      validAccountId(accountId)
      return mutate((snapshot) => {
        const cooldown = snapshot.cooldowns[accountId]
        const currentTime = now()
        if (!cooldown || cooldown.cooldownUntil > currentTime) {
          return [snapshot, undefined]
        }
        const existing = snapshot.leases[accountId]
        if (existing) {
          if (!staleLease(existing, currentTime, isProcessAlive)) return [snapshot, undefined]
        } else if (cooldown.nextProbeAt > currentTime) {
          return [snapshot, undefined]
        }
        const fence = Math.max(
          snapshot.revision + 1,
          ...Object.values(snapshot.leases).map((lease) => lease.fence + 1),
        )
        const lease: CoordinationLease = {
          nonce: leaseUuid(),
          pid: pid(),
          processStartedAt: processStartedAt(),
          acquiredAt: currentTime,
          expiresAt: currentTime + leaseTtlMs,
          cooldownEpoch: cooldown.epoch,
          fence,
        }
        const nextCooldown: CoordinationCooldown = {
          ...cooldown,
          nextProbeAt: currentTime + probeWindowMs,
        }
        const next: CoordinationSnapshot = {
          ...snapshot,
          revision: nextRevision(snapshot),
          cooldowns: { ...snapshot.cooldowns, [accountId]: nextCooldown },
          leases: { ...snapshot.leases, [accountId]: lease },
        }
        return [next, lease]
      })
    },
    async applyProbeResult(accountId, lease, result) {
      validAccountId(accountId)
      if (!UUID_PATTERN.test(lease.nonce)) throw new Error("Invalid coordination lease")
      return mutate((snapshot) => {
        const currentLease = snapshot.leases[accountId]
        const currentCooldown = snapshot.cooldowns[accountId]
        if (!sameLease(currentLease, lease) || currentCooldown?.epoch !== lease.cooldownEpoch) {
          return [snapshot, false]
        }
        if (result.kind === "available") {
          const cooldowns = { ...snapshot.cooldowns }
          const leases = { ...snapshot.leases }
          delete cooldowns[accountId]
          delete leases[accountId]
          return [{ ...snapshot, revision: nextRevision(snapshot), cooldowns, leases }, true]
        }
        const leases = { ...snapshot.leases }
        delete leases[accountId]
        if (result.kind === "unknown" || !currentCooldown) {
          return [{ ...snapshot, revision: nextRevision(snapshot), leases }, true]
        }
        validCooldownUpdate(result.update)
        const cooldowns = {
          ...snapshot.cooldowns,
          [accountId]: mergedCooldown(currentCooldown, result.update),
        }
        return [{ ...snapshot, revision: nextRevision(snapshot), cooldowns, leases }, true]
      })
    },
    async releaseProbe(accountId, nonce) {
      validAccountId(accountId)
      if (!UUID_PATTERN.test(nonce)) return false
      return mutate((snapshot) => {
        const current = snapshot.leases[accountId]
        if (!current || current.nonce !== nonce) return [snapshot, false]
        const leases = { ...snapshot.leases }
        delete leases[accountId]
        return [{ ...snapshot, revision: nextRevision(snapshot), leases }, true]
      })
    },
    async pruneAccount(accountId) {
      validAccountId(accountId)
      await mutate((snapshot) => {
        const cooldowns = { ...snapshot.cooldowns }
        const leases = { ...snapshot.leases }
        const changed = accountId in cooldowns || accountId in leases
        delete cooldowns[accountId]
        delete leases[accountId]
        return [
          changed ? { ...snapshot, revision: nextRevision(snapshot), cooldowns, leases } : snapshot,
          undefined,
        ]
      })
    },
  }
}
