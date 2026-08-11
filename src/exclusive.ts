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
  const deadline = Date.now() + timeoutMs
  const backoff = (): Promise<void> => Bun.sleep(1 + Math.floor(Math.random() * pollMs))

  while (true) {
    const body = JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      ...(holder === undefined ? {} : { holder }),
    })
    const lock = tryAcquireFlock(path, { body })
    if (lock !== null) return { release: () => lock.release() }
    if (Date.now() >= deadline) throw busy(path, holder)
    await backoff()
  }
}

function busy(path: string, contender?: string): Error {
  let owner = "another process"
  let holder = "unknown operation"
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown; holder?: unknown }
    if (typeof value.pid === "number") owner = `pid:${value.pid}`
    if (typeof value.holder === "string" && value.holder.trim() !== "") holder = value.holder
  } catch {
    // silent-fallback-allow: this enriches an error that is ALREADY being
    // thrown, so the failure is never hidden — only its detail is. The lock
    // file can legitimately vanish or be half-written between the failed
    // acquire and this read, and in that race the caller still needs the
    // useful "lock is busy" error rather than a JSON parse error standing in
    // for it. Rethrowing would replace a real diagnosis with a worse one, and
    // logging would add noise to a path that is already reporting a failure.
    // Diagnostic metadata never decides authoritative lock ownership.
  }
  return new Error(
    `git-super: worktree mutation lock is busy (holder=${holder}; owner=${owner}; contender=pid:${process.pid}` +
      `${contender === undefined ? "" : ` operation=${contender}`}; ${path})`,
  )
}
