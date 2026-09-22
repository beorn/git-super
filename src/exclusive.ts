import { readFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tryAcquireFlock } from "@bearly/flock"

export type Exclusive = Readonly<{
  run<Result>(operation: () => Promise<Result>, options?: Readonly<{ holder?: string }>): Promise<Result>
}>

export type ExclusiveOptions = Readonly<{
  timeoutMs?: number
  pollIntervalMs?: number
  /** Called once, when the first acquire finds the lock held, with who holds it (24907). */
  onContended?: (holder: string) => void
}>

export type WriterLock = Readonly<{ release(): void }>

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
  const backoff = (): Promise<void> => Bun.sleep(1 + Math.floor(Math.random() * pollMs))

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
      const held = describeHolder(path, now)
      options.onContended?.(`${held.holder} (${held.owner}, age ${held.age})`)
    }
    if (now >= deadline) throw busy(path, now, now - startedAt, timeoutMs, holder)
    await backoff()
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
