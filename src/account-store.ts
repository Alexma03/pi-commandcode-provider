import { randomUUID } from "node:crypto"
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { performance } from "node:perf_hooks"

export const ACCOUNT_STORE_FORMAT = "pi-commandcode-account-store"
export const ACCOUNT_STORE_VERSION = 1
export const MAX_ACCOUNT_STORE_BYTES = 1024 * 1024
export const MAX_ACCOUNTS = 64
export const MAX_CREDENTIAL_LENGTH = 8192
export const MAX_LABEL_LENGTH = 256

const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const DEFAULT_LOCK_TTL_MS = 30_000
const DEFAULT_LOCK_WAIT_MS = 5_000
const DEFAULT_READ_RETRIES = 3
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface StoredAccountCredential {
  readonly kind: "api-key"
  readonly value: string
}

export interface StoredAccount {
  readonly id: string
  readonly label: string
  readonly credential: StoredAccountCredential
  readonly createdAt: number
  readonly updatedAt: number
}

export interface AccountStoreSnapshot {
  readonly format: typeof ACCOUNT_STORE_FORMAT
  readonly version: typeof ACCOUNT_STORE_VERSION
  readonly revision: number
  readonly primaryAccountId: string | null
  readonly accounts: readonly StoredAccount[]
}

export type AccountStoreUnavailableReason = "permissions" | "corrupt" | "unsupported" | "io"

export type AccountStoreLoad =
  | { readonly kind: "absent" }
  | { readonly kind: "loaded"; readonly snapshot: AccountStoreSnapshot }
  | { readonly kind: "unavailable"; readonly reason: AccountStoreUnavailableReason }

export class AccountStoreParseError extends Error {
  constructor(readonly reason: "corrupt" | "unsupported") {
    super(reason === "unsupported" ? "Unsupported account store version" : "Corrupt account store")
    this.name = "AccountStoreParseError"
  }
}

class PrivatePathError extends Error {
  constructor() {
    super("Private account state is unavailable")
    this.name = "PrivatePathError"
  }
}

export type ProcessLiveness = "alive" | "dead" | "unknown"

interface PrivatePathOptions {
  readonly uid?: () => number | undefined
  readonly warning?: (message: string) => void
}

export interface AtomicWriteOptions {
  readonly uuid?: () => string
  readonly onStep?: (
    step: "open" | "write" | "sync" | "chmod" | "close" | "rename" | "directory-sync",
  ) => void
}

export interface PrivateLockOptions extends PrivatePathOptions {
  readonly uuid?: () => string
  readonly pid?: () => number
  readonly processStartedAt?: () => number
  readonly now?: () => number
  readonly isProcessAlive?: (pid: number, processStartedAt: number) => ProcessLiveness
  readonly ttlMs?: number
  readonly lockWaitMs?: number
  readonly delay?: (milliseconds: number) => Promise<void>
  /** Deterministic interleaving seam after owner validation and before retirement. */
  readonly afterOwnerRead?: () => Promise<void>
}

export interface PrivateLock {
  readonly nonce: string
  release(): Promise<boolean>
}

export interface AccountStoreOptions extends PrivatePathOptions {
  readonly stateDir?: string
  readonly getAgentDir?: () => string
  readonly uuid?: () => string
  readonly nonce?: () => string
  readonly now?: () => number
  readonly pid?: () => number
  readonly processStartedAt?: () => number
  readonly isProcessAlive?: PrivateLockOptions["isProcessAlive"]
  readonly lockTtlMs?: number
  readonly lockWaitMs?: number
  readonly lockDelay?: (milliseconds: number) => Promise<void>
  readonly readRetries?: number
  readonly beforeRead?: (attempt: number) => Promise<void>
}

export interface NewStoredAccount {
  readonly label: string
  readonly credential: StoredAccountCredential
}

export interface AccountMutationOptions {
  readonly validate?: (account: NewStoredAccount) => Promise<void>
}

export interface AccountStore {
  readonly stateRoot: string
  readonly storePath: string
  readonly locksPath: string
  readonly lockPath: string
  load(): Promise<AccountStoreLoad>
  addAccount(account: NewStoredAccount, options?: AccountMutationOptions): Promise<StoredAccount>
  removeAccount(id: string): Promise<void>
  setPrimary(id: string): Promise<void>
}

interface LockOwner {
  readonly nonce: string
  readonly pid: number
  readonly processStartedAt: number
  readonly acquiredAt: number
  readonly expiresAt: number
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
    // Diagnostics must not make private-state handling fail.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
}

function encodedBytes(value: string): number {
  return Buffer.byteLength(value, "utf8")
}

function decodeStoreInput(value: unknown): unknown {
  if (typeof value === "string" || value instanceof Uint8Array) {
    const text = typeof value === "string" ? value : Buffer.from(value).toString("utf8")
    if (encodedBytes(text) > MAX_ACCOUNT_STORE_BYTES) throw new AccountStoreParseError("corrupt")
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new AccountStoreParseError("corrupt")
    }
  }

  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined || encodedBytes(serialized) > MAX_ACCOUNT_STORE_BYTES) {
      throw new AccountStoreParseError("corrupt")
    }
    return JSON.parse(serialized) as unknown
  } catch (error) {
    if (error instanceof AccountStoreParseError) throw error
    throw new AccountStoreParseError("corrupt")
  }
}

export function parseAccountStore(value: unknown): AccountStoreSnapshot {
  const decoded = decodeStoreInput(value)
  if (!isRecord(decoded)) throw new AccountStoreParseError("corrupt")
  if (decoded.format !== ACCOUNT_STORE_FORMAT) throw new AccountStoreParseError("corrupt")
  if (decoded.version !== ACCOUNT_STORE_VERSION) throw new AccountStoreParseError("unsupported")
  if (
    typeof decoded.revision !== "number" ||
    !Number.isSafeInteger(decoded.revision) ||
    decoded.revision < 0
  ) {
    throw new AccountStoreParseError("corrupt")
  }
  if (!Array.isArray(decoded.accounts) || decoded.accounts.length > MAX_ACCOUNTS) {
    throw new AccountStoreParseError("corrupt")
  }

  const ids = new Set<string>()
  const accounts: StoredAccount[] = decoded.accounts.map((candidate) => {
    if (!isRecord(candidate)) throw new AccountStoreParseError("corrupt")
    if (
      typeof candidate.id !== "string" ||
      !UUID_PATTERN.test(candidate.id) ||
      ids.has(candidate.id)
    ) {
      throw new AccountStoreParseError("corrupt")
    }
    ids.add(candidate.id)
    if (!boundedString(candidate.label, MAX_LABEL_LENGTH)) {
      throw new AccountStoreParseError("corrupt")
    }
    if (!isRecord(candidate.credential) || candidate.credential.kind !== "api-key") {
      throw new AccountStoreParseError("corrupt")
    }
    if (!boundedString(candidate.credential.value, MAX_CREDENTIAL_LENGTH)) {
      throw new AccountStoreParseError("corrupt")
    }
    if (!isFiniteTimestamp(candidate.createdAt) || !isFiniteTimestamp(candidate.updatedAt)) {
      throw new AccountStoreParseError("corrupt")
    }
    return {
      id: candidate.id,
      label: candidate.label,
      credential: { kind: "api-key", value: candidate.credential.value },
      createdAt: candidate.createdAt,
      updatedAt: candidate.updatedAt,
    }
  })

  const primaryAccountId = decoded.primaryAccountId
  if (accounts.length === 0) {
    if (primaryAccountId !== null) throw new AccountStoreParseError("corrupt")
  } else if (typeof primaryAccountId !== "string" || !ids.has(primaryAccountId)) {
    throw new AccountStoreParseError("corrupt")
  }

  return {
    format: ACCOUNT_STORE_FORMAT,
    version: ACCOUNT_STORE_VERSION,
    revision: decoded.revision,
    primaryAccountId: primaryAccountId as string | null,
    accounts,
  }
}

async function inspectPrivatePath(
  path: string,
  kind: "directory" | "file",
  options: PrivatePathOptions,
): Promise<"absent" | "ready"> {
  let stats
  try {
    stats = await lstat(path)
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return "absent"
    throw error
  }

  const validKind = kind === "directory" ? stats.isDirectory() : stats.isFile()
  if (stats.isSymbolicLink() || !validKind) throw new PrivatePathError()

  const expectedUid = (options.uid ?? currentUid)()
  if (expectedUid !== undefined && stats.uid !== expectedUid) throw new PrivatePathError()

  const requiredMode = kind === "directory" ? PRIVATE_DIRECTORY_MODE : PRIVATE_FILE_MODE
  if ((stats.mode & 0o777) !== requiredMode) {
    try {
      await chmod(path, requiredMode)
    } catch {
      throw new PrivatePathError()
    }
    warnSafely(options.warning, "Corrected insecure Command Code account-state permissions.")
  }
  return "ready"
}

export async function ensurePrivateDirectory(
  path: string,
  options: PrivatePathOptions = {},
): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error
  }
  if ((await inspectPrivatePath(path, "directory", options)) !== "ready") {
    throw new PrivatePathError()
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle: FileHandle | undefined
  try {
    handle = await open(path, "r")
    await handle.sync()
  } catch (error) {
    if (
      !isNodeError(error, "EINVAL") &&
      !isNodeError(error, "ENOTSUP") &&
      !isNodeError(error, "EISDIR") &&
      !isNodeError(error, "EBADF")
    ) {
      throw error
    }
  } finally {
    await handle?.close().catch(() => {})
  }
}

export async function writePrivateFileAtomically(
  path: string,
  contents: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const uuid = options.uuid ?? randomUUID
  const temporaryPath = join(dirname(path), `.${basename(path)}.${uuid()}.tmp`)
  let handle: FileHandle | undefined
  try {
    handle = await open(temporaryPath, "wx", PRIVATE_FILE_MODE)
    options.onStep?.("open")
    await handle.writeFile(contents)
    options.onStep?.("write")
    await handle.sync()
    options.onStep?.("sync")
    await handle.chmod(PRIVATE_FILE_MODE)
    options.onStep?.("chmod")
    await handle.close()
    handle = undefined
    options.onStep?.("close")
    await rename(temporaryPath, path)
    options.onStep?.("rename")
    await syncDirectory(dirname(path))
    options.onStep?.("directory-sync")
  } catch (error) {
    await handle?.close().catch(() => {})
    await rm(temporaryPath, { force: true }).catch(() => {})
    throw error
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

function parseLockOwner(value: unknown): LockOwner | undefined {
  if (!isRecord(value)) return undefined
  const keys = Object.keys(value).sort()
  if (keys.join("\0") !== "acquiredAt\0expiresAt\0nonce\0pid\0processStartedAt") return undefined
  if (typeof value.nonce !== "string" || !UUID_PATTERN.test(value.nonce)) return undefined
  if (typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0) {
    return undefined
  }
  if (
    !isFiniteTimestamp(value.processStartedAt) ||
    !isFiniteTimestamp(value.acquiredAt) ||
    !isFiniteTimestamp(value.expiresAt)
  ) {
    return undefined
  }
  return {
    nonce: value.nonce,
    pid: value.pid,
    processStartedAt: value.processStartedAt,
    acquiredAt: value.acquiredAt,
    expiresAt: value.expiresAt,
  }
}

interface LockGeneration {
  readonly owner: LockOwner
  readonly directoryPath: string
  readonly ownerPath: string
}

function lockGenerationName(nonce: string): string {
  return `owner-${nonce}`
}

async function readLockGeneration(
  lockPath: string,
  options: PrivatePathOptions,
): Promise<LockGeneration | undefined> {
  try {
    if ((await inspectPrivatePath(lockPath, "directory", options)) !== "ready") return undefined
    const entries = await readdir(lockPath)
    if (entries.length !== 1 || !entries[0].startsWith("owner-")) return undefined
    const nonce = entries[0].slice("owner-".length)
    if (!UUID_PATTERN.test(nonce)) return undefined
    const directoryPath = join(lockPath, entries[0])
    if ((await inspectPrivatePath(directoryPath, "directory", options)) !== "ready") {
      return undefined
    }
    const ownerPath = join(directoryPath, "owner.json")
    if ((await inspectPrivatePath(ownerPath, "file", options)) !== "ready") return undefined
    const owner = parseLockOwner(JSON.parse(await readFile(ownerPath, "utf8")) as unknown)
    if (!owner || owner.nonce !== nonce) return undefined
    return { owner, directoryPath, ownerPath }
  } catch {
    return undefined
  }
}

async function writeLockOwner(directoryPath: string, owner: LockOwner): Promise<void> {
  const ownerPath = join(directoryPath, "owner.json")
  const handle = await open(ownerPath, "wx", PRIVATE_FILE_MODE)
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`)
    await handle.sync()
    await handle.chmod(PRIVATE_FILE_MODE)
  } finally {
    await handle.close()
  }
}

async function installLockGeneration(lockPath: string, owner: LockOwner): Promise<boolean> {
  const candidatePath = `${lockPath}.candidate-${owner.nonce}`
  const generationPath = join(candidatePath, lockGenerationName(owner.nonce))
  await mkdir(candidatePath, { mode: PRIVATE_DIRECTORY_MODE })
  try {
    await mkdir(generationPath, { mode: PRIVATE_DIRECTORY_MODE })
    await writeLockOwner(generationPath, owner)
    try {
      await rename(candidatePath, lockPath)
      return true
    } catch (error) {
      if (isNodeError(error, "EEXIST") || isNodeError(error, "ENOTEMPTY")) return false
      if (isNodeError(error, "EPERM")) {
        try {
          await lstat(lockPath)
          return false
        } catch (inspectionError) {
          if (!isNodeError(inspectionError, "ENOENT")) throw inspectionError
        }
      }
      throw error
    }
  } finally {
    await rm(candidatePath, { recursive: true, force: true })
  }
}

async function cleanupRetiredGeneration(lockPath: string, nonce: string): Promise<boolean> {
  const directoryPath = join(lockPath, `retired-${nonce}`)
  const ownerPath = join(directoryPath, "owner.json")
  try {
    await unlink(ownerPath)
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error
  }
  try {
    await rmdir(directoryPath)
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      if (isNodeError(error, "ENOTEMPTY")) return false
      throw error
    }
  }
  try {
    await rmdir(lockPath)
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return true
    if (isNodeError(error, "ENOTEMPTY")) return false
    throw error
  }
  return true
}

async function cleanupInterruptedRetirement(
  lockPath: string,
  options: PrivatePathOptions,
): Promise<boolean> {
  try {
    if ((await inspectPrivatePath(lockPath, "directory", options)) !== "ready") return false
    const entries = await readdir(lockPath)
    if (entries.length === 0) {
      try {
        await rmdir(lockPath)
        return true
      } catch (error) {
        if (isNodeError(error, "ENOENT")) return true
        if (isNodeError(error, "ENOTEMPTY")) return false
        throw error
      }
    }
    if (entries.length !== 1 || !entries[0].startsWith("retired-")) return false
    const nonce = entries[0].slice("retired-".length)
    if (!UUID_PATTERN.test(nonce)) return false
    return cleanupRetiredGeneration(lockPath, nonce)
  } catch {
    return false
  }
}

async function retireLockGeneration(lockPath: string, nonce: string): Promise<boolean> {
  const directoryPath = join(lockPath, lockGenerationName(nonce))
  const retiredPath = join(lockPath, `retired-${nonce}`)
  try {
    await rename(directoryPath, retiredPath)
  } catch (error) {
    if (isNodeError(error, "ENOENT") || isNodeError(error, "EEXIST")) return false
    throw error
  }
  await cleanupRetiredGeneration(lockPath, nonce)
  return true
}

async function recoverStaleLock(lockPath: string, nonce: string): Promise<boolean> {
  return retireLockGeneration(lockPath, nonce)
}

function defaultDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export async function acquirePrivateLock(
  lockPath: string,
  options: PrivateLockOptions = {},
): Promise<PrivateLock> {
  const uuid = options.uuid ?? randomUUID
  const now = options.now ?? Date.now
  const pid = options.pid ?? (() => process.pid)
  const processStartedAt = options.processStartedAt ?? defaultProcessStartedAt
  const isProcessAlive = options.isProcessAlive ?? defaultProcessLiveness
  const ttlMs = options.ttlMs ?? DEFAULT_LOCK_TTL_MS
  const lockWaitMs = options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS
  const delay = options.delay ?? defaultDelay
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || !Number.isFinite(lockWaitMs) || lockWaitMs < 0) {
    throw new Error("Invalid Command Code lock timing")
  }
  const readNow = (): number => {
    const value = now()
    if (!Number.isFinite(value) || value < 0) throw new Error("Invalid Command Code lock clock")
    return value
  }
  const startedWaitingAt = performance.now()

  const tryInstall = async (): Promise<PrivateLock | undefined> => {
    const acquiredAt = readNow()
    const nonce = uuid()
    if (!UUID_PATTERN.test(nonce)) throw new Error("Invalid Command Code lock nonce")
    const owner: LockOwner = {
      nonce,
      pid: pid(),
      processStartedAt: processStartedAt(),
      acquiredAt,
      expiresAt: acquiredAt + ttlMs,
    }
    if (!parseLockOwner(owner)) throw new Error("Invalid Command Code lock owner")
    if (!(await installLockGeneration(lockPath, owner))) return undefined
    return {
      nonce,
      release: () => releasePrivateLock(lockPath, nonce, options),
    }
  }

  for (;;) {
    await cleanupInterruptedRetirement(lockPath, options)
    const installed = await tryInstall()
    if (installed) return installed

    const generation = await readLockGeneration(lockPath, options)
    await options.afterOwnerRead?.()
    const stale =
      generation !== undefined &&
      (generation.owner.expiresAt <= readNow() ||
        isProcessAlive(generation.owner.pid, generation.owner.processStartedAt) === "dead")
    if (stale && (await recoverStaleLock(lockPath, generation.owner.nonce))) {
      const recoveredInstall = await tryInstall()
      if (recoveredInstall) return recoveredInstall
    } else if (!generation && (await cleanupInterruptedRetirement(lockPath, options))) {
      const cleanupInstall = await tryInstall()
      if (cleanupInstall) return cleanupInstall
    }

    const elapsedWaitMs = performance.now() - startedWaitingAt
    if (elapsedWaitMs >= lockWaitMs) {
      throw new Error("Command Code account store lock is busy")
    }
    await delay(Math.min(25, Math.max(1, lockWaitMs - elapsedWaitMs)))
  }
}

export async function releasePrivateLock(
  lockPath: string,
  nonce: string,
  options: PrivateLockOptions = {},
): Promise<boolean> {
  if (!UUID_PATTERN.test(nonce)) return false
  const generation = await readLockGeneration(lockPath, options)
  await options.afterOwnerRead?.()
  if (!generation || generation.owner.nonce !== nonce) return false
  return retireLockGeneration(lockPath, nonce)
}

function emptySnapshot(): AccountStoreSnapshot {
  return {
    format: ACCOUNT_STORE_FORMAT,
    version: ACCOUNT_STORE_VERSION,
    revision: 0,
    primaryAccountId: null,
    accounts: [],
  }
}

function validateNewAccount(account: NewStoredAccount): void {
  if (!boundedString(account.label, MAX_LABEL_LENGTH)) {
    throw new Error("Invalid account label")
  }
  if (
    account.credential.kind !== "api-key" ||
    !boundedString(account.credential.value, MAX_CREDENTIAL_LENGTH)
  ) {
    throw new Error("Invalid account credential")
  }
}

async function ensurePrivateTextFile(path: string, contents: string, options: PrivatePathOptions) {
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
  if ((await inspectPrivatePath(path, "file", options)) !== "ready") throw new PrivatePathError()
  if ((await readFile(path, "utf8")) !== contents) {
    await writePrivateFileAtomically(path, contents)
  }
}

async function cleanupAccountTemps(stateRoot: string): Promise<void> {
  let names: string[]
  try {
    names = await readdir(stateRoot)
  } catch {
    return
  }
  await Promise.all(
    names
      .filter((name) => name.startsWith(".accounts.json.") && name.endsWith(".tmp"))
      .map((name) => rm(join(stateRoot, name), { force: true })),
  )
}

function serializeSnapshot(snapshot: AccountStoreSnapshot): string {
  const serialized = `${JSON.stringify(snapshot, null, 2)}\n`
  if (encodedBytes(serialized) > MAX_ACCOUNT_STORE_BYTES) {
    throw new Error("Command Code account store exceeds its size limit")
  }
  return serialized
}

export function createAccountStore(options: AccountStoreOptions): AccountStore {
  const resolvedStateRoot =
    options.stateDir ??
    (options.getAgentDir ? join(options.getAgentDir(), "commandcode") : undefined)
  if (!resolvedStateRoot) throw new Error("Account store requires stateDir or getAgentDir")
  const stateRoot: string = resolvedStateRoot

  const storePath = join(stateRoot, "accounts.json")
  const locksPath = join(stateRoot, "locks")
  const lockPath = join(locksPath, "accounts.lock")
  const uuid = options.uuid ?? randomUUID
  const nonce = options.nonce ?? randomUUID
  const now = options.now ?? Date.now
  const readRetries = Math.max(1, options.readRetries ?? DEFAULT_READ_RETRIES)
  const privateOptions: PrivatePathOptions = { uid: options.uid, warning: options.warning }

  async function load(): Promise<AccountStoreLoad> {
    for (let attempt = 0; attempt < readRetries; attempt += 1) {
      await options.beforeRead?.(attempt)
      try {
        if ((await inspectPrivatePath(stateRoot, "directory", privateOptions)) === "absent") {
          return { kind: "absent" }
        }
        if ((await inspectPrivatePath(storePath, "file", privateOptions)) === "absent") {
          if (attempt + 1 < readRetries) continue
          return { kind: "absent" }
        }
        const stats = await lstat(storePath)
        if (stats.size > MAX_ACCOUNT_STORE_BYTES) {
          return { kind: "unavailable", reason: "corrupt" }
        }
        return { kind: "loaded", snapshot: parseAccountStore(await readFile(storePath)) }
      } catch (error) {
        if (error instanceof PrivatePathError) {
          warnSafely(options.warning, "Command Code account state has unsafe permissions.")
          return { kind: "unavailable", reason: "permissions" }
        }
        if (error instanceof AccountStoreParseError) {
          return { kind: "unavailable", reason: error.reason }
        }
        if (isNodeError(error, "ENOENT") && attempt + 1 < readRetries) continue
        return { kind: "unavailable", reason: "io" }
      }
    }
    return { kind: "unavailable", reason: "io" }
  }

  async function ensureScaffold(): Promise<void> {
    await ensurePrivateDirectory(stateRoot, privateOptions)
    await ensurePrivateDirectory(locksPath, privateOptions)
    await ensurePrivateTextFile(join(stateRoot, ".gitignore"), "*\n", privateOptions)
  }

  function lockOptions(): PrivateLockOptions {
    return {
      uid: options.uid,
      warning: options.warning,
      uuid: nonce,
      pid: options.pid,
      processStartedAt: options.processStartedAt,
      now,
      isProcessAlive: options.isProcessAlive,
      ttlMs: options.lockTtlMs,
      lockWaitMs: options.lockWaitMs,
      delay: options.lockDelay,
    }
  }

  async function mutate<T>(
    operation: (snapshot: AccountStoreSnapshot) => [AccountStoreSnapshot, T],
  ) {
    await ensureScaffold()
    const lock = await acquirePrivateLock(lockPath, lockOptions())
    try {
      await cleanupAccountTemps(stateRoot)
      const current = await load()
      if (current.kind === "unavailable") {
        throw new Error(`Command Code account store is unavailable (${current.reason})`)
      }
      const [next, result] = operation(
        current.kind === "loaded" ? current.snapshot : emptySnapshot(),
      )
      const parsed = parseAccountStore(next)
      await writePrivateFileAtomically(storePath, serializeSnapshot(parsed), { uuid: nonce })
      return result
    } finally {
      await lock.release()
    }
  }

  return {
    stateRoot,
    storePath,
    locksPath,
    lockPath,
    load,
    async addAccount(account, mutationOptions = {}) {
      validateNewAccount(account)
      try {
        await mutationOptions.validate?.(account)
      } catch {
        throw new Error("Command Code account validation failed")
      }
      return mutate((snapshot) => {
        const existing = snapshot.accounts.find(
          (candidate) => candidate.credential.value === account.credential.value,
        )
        const updatedAt = now()
        if (existing) {
          const updated: StoredAccount = { ...existing, label: account.label, updatedAt }
          return [
            {
              ...snapshot,
              revision: snapshot.revision + 1,
              accounts: snapshot.accounts.map((candidate) =>
                candidate.id === existing.id ? updated : candidate,
              ),
            },
            updated,
          ]
        }

        if (snapshot.accounts.length >= MAX_ACCOUNTS) {
          throw new Error("Command Code account store is full")
        }
        const created: StoredAccount = {
          id: uuid(),
          label: account.label,
          credential: { ...account.credential },
          createdAt: updatedAt,
          updatedAt,
        }
        const accounts = [...snapshot.accounts, created]
        return [
          {
            ...snapshot,
            revision: snapshot.revision + 1,
            primaryAccountId: snapshot.primaryAccountId ?? created.id,
            accounts,
          },
          created,
        ]
      })
    },
    async removeAccount(id) {
      await mutate((snapshot) => {
        if (!snapshot.accounts.some((account) => account.id === id)) {
          throw new Error("Unknown Command Code account")
        }
        const accounts = snapshot.accounts.filter((account) => account.id !== id)
        return [
          {
            ...snapshot,
            revision: snapshot.revision + 1,
            primaryAccountId:
              snapshot.primaryAccountId === id
                ? (accounts[0]?.id ?? null)
                : snapshot.primaryAccountId,
            accounts,
          },
          undefined,
        ]
      })
    },
    async setPrimary(id) {
      await mutate((snapshot) => {
        const selected = snapshot.accounts.find((account) => account.id === id)
        if (!selected) throw new Error("Unknown Command Code account")
        return [
          {
            ...snapshot,
            revision: snapshot.revision + 1,
            primaryAccountId: id,
            accounts: [selected, ...snapshot.accounts.filter((account) => account.id !== id)],
          },
          undefined,
        ]
      })
    },
  }
}
