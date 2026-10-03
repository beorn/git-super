import { fstatSync, lstatSync, readFileSync } from "node:fs"
import { mkdir, realpath } from "node:fs/promises"
import { join } from "node:path"
import { tryAcquireFlock } from "@bearly/flock"
import { fullJitter } from "@bearly/pacing"
import { setTimeout as delay } from "node:timers/promises"

export type Exclusive = Readonly<{
  run<Result>(
    operation: (held?: WriterLock) => Promise<Result>,
    options?: Readonly<{ holder?: string; held?: WriterLock }>,
  ): Promise<Result>
}>

export type ExclusiveOptions = Readonly<{
  timeoutMs?: number
  pollIntervalMs?: number
  signal?: AbortSignal
  /** Called once, when the first acquire finds the lock held, with who holds it (24907). */
  onContended?: (holder: string) => void
}>

export type WriterLock = Readonly<{ release(): void }>

// Provenance of the existing owner's issued handles, never a second lock authority.
const issuedLocks = new WeakMap<WriterLock, { directory: string; active: boolean; fd: number }>()

function inspectHeld(lock: WriterLock, directory: string): void {
  const issued = issuedLocks.get(lock)
  if (issued === undefined || !issued.active || issued.directory !== directory) {
    throw new Error(`git-super: invalid held writer custody for ${directory}`)
  }
  const opened = fstatSync(issued.fd)
  const named = lstatSync(join(directory, "writer.lock"))
  if (!named.isFile() || named.dev !== opened.dev || named.ino !== opened.ino) {
    throw new Error(`git-super: held writer custody changed identity in ${directory}`)
  }
}

// A queue merge held this lock for over 53 s and made submit fail at 30 s;
// post-merge test 825324 also lost a worktree add after 30,006 ms. The wait is
// strictly less than a caller's per-call cap minus the work after acquiring:
// yrd bounds one root-v1 git call at 5 minutes, and a wait equal to that cap
// IS the cap — yrd would kill `git super worktree add` still waiting or mid-add
// after taking the lock, leaving a half-added worktree (25274, @cto 297a8976).
// The inequality is pinned against yrd's constant by the host's test.
export const DEFAULT_MUTATION_LOCK_WAIT_MS = 4 * 60_000

/**
 * Acquire the repository-scoped writer lock used by both the former Yrd store
 * and git-super. Keeping `<common-dir>/yrd-worktree-mutations/writer.lock`
 * unchanged makes mixed-version callers mutually exclusive during cutover.
 */
export function createExclusive(dir: string, options: ExclusiveOptions = {}): Exclusive {
  return {
    async run(operation, runOptions = {}) {
      const holder = runOptions.holder?.trim()
      if (holder !== undefined && (holder === "" || /\r|\n/u.test(holder))) {
        throw new TypeError("git-super: exclusive holder must be a non-empty single line")
      }
      if (runOptions.held !== undefined) {
        options.signal?.throwIfAborted()
        inspectHeld(runOptions.held, await realpath(dir))
        return operation(runOptions.held)
      }
      const lock = await acquireExclusive(dir, options, holder)
      try {
        return await operation(lock)
      } finally {
        lock.release()
      }
    },
  }
}

export async function acquireExclusive(
  dir: string,
  options: ExclusiveOptions = {},
  holder?: string,
): Promise<WriterLock> {
  const aborted = (): void => {
    if (options.signal?.aborted) {
      throw new Error(`git-super: writer lock acquisition aborted: ${dir}`, { cause: options.signal.reason })
    }
  }
  aborted()
  await mkdir(dir, { recursive: true })
  const directory = await realpath(dir)
  const path = join(directory, "writer.lock")
  const timeoutMs = Math.max(0, options.timeoutMs ?? 30_000)
  const pollMs = Math.max(1, options.pollIntervalMs ?? 10)
  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs

  let contended = false
  while (true) {
    aborted()
    const body = JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      ...(holder === undefined ? {} : { holder }),
    })
    const lock = tryAcquireFlock(path, { body })
    if (lock !== null) {
      const issued = { directory, active: true, fd: lock.fd }
      const writer: WriterLock = {
        release() {
          lock.release()
          issued.active = false
        },
      }
      issuedLocks.set(writer, issued)
      try {
        aborted()
        inspectHeld(writer, directory)
        return writer
      } catch (error) {
        writer.release()
        throw error
      }
    }
    const now = Date.now()
    if (!contended) {
      contended = true
      const held = describeHolder(path, now)
      options.onContended?.(`${held.holder} (${held.owner}, age ${held.age})`)
    }
    if (now >= deadline) throw busy(path, now, now - startedAt, timeoutMs, holder)
    aborted()
    try {
      await delay(Math.min(pollMs, 1 + Math.floor(fullJitter(pollMs, pollMs, 0))), undefined, {
        signal: options.signal,
      })
    } catch (error) {
      aborted()
      throw error
    }
  }
}

function busy(path: string, now: number, waitedMs: number, timeoutMs: number, contender?: string): Error {
  const { owner, holder, age } = describeHolder(path, now)
  return new Error(
    `git-super: worktree mutation lock is busy after ${waitedMs}ms ` +
      `(timeout=${timeoutMs}ms; holder=${holder}; age=${age}; owner=${owner}; contender=pid:${process.pid}` +
      `${contender === undefined ? "" : ` operation=${contender}`}; ${path})`,
  )
}

/** Who the lock file says holds the lock; diagnostic only, never lock authority. */
function describeHolder(path: string, now: number): Readonly<{ owner: string; holder: string; age: string }> {
  let owner = "another process"
  let holder = "unknown operation"
  let age = "unknown"
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown; holder?: unknown; startedAt?: unknown }
    if (typeof value.pid === "number") owner = `pid:${value.pid}`
    if (typeof value.holder === "string" && value.holder.trim() !== "") holder = value.holder
    if (typeof value.startedAt === "string") {
      const startedAt = Date.parse(value.startedAt)
      if (Number.isFinite(startedAt) && startedAt <= now) age = `${now - startedAt}ms`
    }
  } catch {
    // silent-fallback-allow: this only describes a lock the caller already
    // FAILED to take — for the "lock is busy" error being thrown, or the
    // contention line a pull reports while it waits — so no failure is
    // hidden, only its detail; the unreadable case still says "unknown
    // operation" and "another process" in that text. The lock file can
    // legitimately vanish or be half-written between the failed acquire and
    // this read, and in that race the caller still needs the busy report
    // rather than a JSON parse error standing in for it. Rethrowing would
    // replace a real diagnosis with a worse one. Diagnostic metadata never
    // decides authoritative lock ownership.
  }
  return { owner, holder, age }
}
