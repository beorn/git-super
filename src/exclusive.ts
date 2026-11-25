import { readFileSync, unlinkSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tryAcquireFlock } from "@bearly/flock"
import { fileLockHolders, formatLockHolders } from "@bearly/flock/holders"
import { fullJitter } from "@bearly/pacing"
import { setTimeout as delay } from "node:timers/promises"

export type Exclusive = Readonly<{
  run<Result>(operation: () => Promise<Result>, options?: Readonly<{ holder?: string }>): Promise<Result>
}>

export type ExclusiveOptions = Readonly<{
  timeoutMs?: number
  pollIntervalMs?: number
  /**
   * Called once, when the first acquire finds the lock held, with who holds it (24907) and a reader that
   * describes the lock again on each progress tick, so a long wait never re-reports a departed holder (30095).
   */
  onContended?: (holder: string, refresh: () => string) => void
}>

export type WriterLock = Readonly<{ release(): void }>

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
      const lock = await acquireExclusive(dir, options, holder)
      try {
        return await operation()
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
  await mkdir(dir, { recursive: true })
  const path = join(dir, "writer.lock")
  const timeoutMs = Math.max(0, options.timeoutMs ?? 30_000)
  const pollMs = Math.max(1, options.pollIntervalMs ?? 10)
  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs

  let contended = false
  while (true) {
    const body = JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      ...(holder === undefined ? {} : { holder }),
    })
    const lock = tryAcquireFlock(path, { body })
    if (lock !== null) return { release: () => lock.release() }
    const now = Date.now()
    if (!contended) {
      contended = true
      const describe = (at: number): string => {
        const held = describeRecordedLockHolder(path, at)
        return (
          `live ${describeLiveLockHolders(path)}; recorded note, not authority: ` +
          `${held.holder} (${held.owner}, age ${held.age})`
        )
      }
      options.onContended?.(describe(now), () => describe(Date.now()))
    }
    if (now >= deadline) throw busy(path, now, now - startedAt, timeoutMs, holder)
    await delay(Math.min(pollMs, 1 + Math.floor(fullJitter(pollMs, pollMs, 0))))
  }
}

/**
 * The one text a caller may match when the wait crossed a process boundary and only stderr survives
 * (#37624). The in-process route should prefer {@link isExclusiveBusy}; a CLI caller cannot see the class.
 */
export const BUSY_PREFIX = "git-super: worktree mutation lock is busy after "

/** True for the refusal {@link acquireExclusive} throws when its wait runs out (#37625 callers add a class, not a throw). */
export function isExclusiveBusy(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith(BUSY_PREFIX)
}

function busy(path: string, now: number, waitedMs: number, timeoutMs: number, contender?: string): Error {
  const { owner, holder, age } = describeRecordedLockHolder(path, now)
  return new Error(
    `${BUSY_PREFIX}${waitedMs}ms ` +
      `(timeout=${timeoutMs}ms; live ${describeLiveLockHolders(path)}; ` +
      `recorded note, not authority: holder=${holder}; age=${age}; owner=${owner}; contender=pid:${process.pid}` +
      `${contender === undefined ? "" : ` operation=${contender}`}; ${path})`,
  )
}

/**
 * Who holds `path` NOW, from the kernel's lock table (33483, @cto 37021b7f condition 4). A worktree removal takes
 * writer leases without rewriting the note, so the note can name a holder dead for a day while a live process holds
 * the lock; the busy report therefore leads with the kernel's answer and says so plainly when it finds no holder.
 */
function describeLiveLockHolders(path: string): string {
  const report = fileLockHolders([path], { self: process.pid })
  if (report.kind === "unknown") return `holder unknown (${report.reason})`
  const file = report.files[0]
  if (file === undefined || "absent" in file) return "holder: none found (lock file absent)"
  if ("unreadable" in file) return `holder unknown (${file.unreadable})`
  if (file.locks.every((lock) => lock.waiter)) return `holder: none found in the kernel lock table (${file.id})`
  return `holder: ${formatLockHolders(report)}`
}

/** How {@link reapStaleWriterLease} answers: reaped by name, or why it left the lease alone. */
export type StaleLeaseReap =
  | Readonly<{ reaped: true; pid: number; detail: string }>
  | Readonly<{ reaped: false; why: string }>

/**
 * Reap a writer lease whose recorded pid is dead and which no process holds a flock on (#33010, @cto 2026-11-25).
 *
 * A lease file outlives a killed writer, and every later caller then reads it as "held" — on 2026-11-25 one such file
 * (pid 2272903, dead, no flock in /proc/locks) kept the whole retained-store drain from deleting anything for an hour
 * and was only cleared by hand. Both facts are required before anything is removed: the body's pid must be dead AND
 * the kernel lock table must show no lock (and no waiter) on the file. A lease that cannot be attributed, a platform
 * without a lock table, and an unreadable body are all left in place with the reason — a lease nobody can explain is
 * not stale by this rule. The file is then unlinked, so the caller's next acquire creates it as its own.
 */
export function reapStaleWriterLease(path: string): StaleLeaseReap {
  let body: string
  try {
    body = readFileSync(path, "utf8")
  } catch (error) {
    return { reaped: false, why: `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}` }
  }
  let pid: unknown
  try {
    pid = (JSON.parse(body) as { pid?: unknown } | null)?.pid
  } catch {
    return { reaped: false, why: `${path} does not carry a writable lease body; not reaped` }
  }
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return { reaped: false, why: `${path} records no pid; not reaped` }
  }
  try {
    process.kill(pid, 0)
    return { reaped: false, why: `pid ${String(pid)} is alive` }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ESRCH") return { reaped: false, why: `pid ${String(pid)} cannot be shown dead (${String(code)})` }
  }
  if (process.platform !== "linux") {
    return { reaped: false, why: "kernel holder lookup unavailable on this platform" }
  }
  const holders = fileLockHolders([path], { self: process.pid })
  if (holders.kind === "unknown") return { reaped: false, why: `locks unknown (${holders.reason})` }
  const file = holders.files[0]
  if (file === undefined) return { reaped: false, why: `${path} was not observed; not reaped` }
  if ("absent" in file) return { reaped: false, why: `${path} vanished before it could be reaped` }
  if ("unreadable" in file) return { reaped: false, why: file.unreadable }
  if (file.locks.length > 0) return { reaped: false, why: `a flock is held: ${formatLockHolders(holders)}` }
  try {
    unlinkSync(path)
  } catch (error) {
    return { reaped: false, why: `cannot unlink ${path}: ${error instanceof Error ? error.message : String(error)}` }
  }
  return { reaped: true, pid, detail: `reaped stale writer lease pid ${String(pid)}, dead, no flock` }
}

/**
 * The holder RECORDED in the lock body — the last writer to name itself there, not live lock ownership. Diagnostic
 * only, never lock authority. Exported as the one owner parser so a contention report elsewhere reads the format its
 * writer owns (@hab/28846).
 */
export function describeRecordedLockHolder(
  path: string,
  now: number,
): Readonly<{ owner: string; holder: string; age: string }> {
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
