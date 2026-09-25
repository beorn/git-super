/**
 * @failure Git-super's policy wrapper can diverge from the shared crash-safe
 * flock core and lose holder diagnostics or same-process exclusion.
 * @level l1
 * @consumer Yrd worktree mutation store
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test, vi } from "vitest"
import { acquireExclusive, DEFAULT_MUTATION_LOCK_WAIT_MS } from "../src/exclusive.ts"

describe("exclusive writer policy", () => {
  /**
   * @failure The shared wait stops at the old 30 s bound while a real holder is still present (25274).
   * @level l1
   * @consumer Yrd submit merge and post-merge worktree add
   */
  test("retries the shared lock wait after 30 seconds virtual and completes on release", async () => {
    const dir = await mkdtemp(join(tmpdir(), "git-super-exclusive-"))
    const first = await acquireExclusive(dir, { timeoutMs: 0 }, "queue merge")
    const seen: string[] = []
    let released = false
    const release = () => {
      if (released) return
      released = true
      first.release()
    }
    vi.useFakeTimers({ toFake: ["Date"] })
    let waiting: ReturnType<typeof acquireExclusive> | undefined
    try {
      const startedAt = Date.now()
      waiting = acquireExclusive(
        dir,
        {
          timeoutMs: DEFAULT_MUTATION_LOCK_WAIT_MS,
          pollIntervalMs: 5,
          onContended: (holder) => seen.push(holder),
        },
        "submit merge",
      )
      const settled = waiting.then(
        (lock) => ({ kind: "acquired" as const, lock }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      )
      for (let poll = 0; poll < 100 && seen.length === 0; poll += 1) await Bun.sleep(10)
      expect(seen).toEqual([expect.stringContaining("queue merge")])
      vi.setSystemTime(startedAt + 31_000)
      // Leave the real lock held across more than one 5 ms poll at the advanced time.
      await Bun.sleep(20)
      release()
      const outcome = await settled
      expect(outcome.kind).toBe("acquired")
      if (outcome.kind === "acquired") outcome.lock.release()
      expect(Date.now() - startedAt).toBeGreaterThan(30_000)
    } finally {
      release()
      if (waiting !== undefined) await Promise.allSettled([waiting])
      vi.useRealTimers()
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("retains holder diagnostics and releases for the next writer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "git-super-exclusive-"))
    const first = await acquireExclusive(dir, { timeoutMs: 0 }, "first mutation")
    try {
      expect(JSON.parse(await readFile(join(dir, "writer.lock"), "utf8"))).toMatchObject({
        pid: process.pid,
        holder: "first mutation",
      })
      const startedAt = Date.now()
      await expect(acquireExclusive(dir, { timeoutMs: 25 }, "second mutation")).rejects.toThrow(
        /lock is busy after \d+ms \(timeout=25ms; holder=first mutation; age=\d+ms;.*operation=second mutation/u,
      )
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(25)
    } finally {
      first.release()
    }

    const successor = await acquireExclusive(dir, { timeoutMs: 0 }, "successor")
    successor.release()
    await rm(dir, { recursive: true, force: true })
  })

  /**
   * @failure A pull killed while waiting for the writer lock leaves no trace of who held it (24907).
   * @level l1
   * @consumer a caller that bounds a pull and must name what it waited on
   */
  test("names the holder once, when the first acquire finds the lock held", async () => {
    const dir = await mkdtemp(join(tmpdir(), "git-super-exclusive-"))
    const first = await acquireExclusive(dir, { timeoutMs: 0 }, "first mutation")
    const contended: string[] = []
    try {
      await expect(
        acquireExclusive(dir, { timeoutMs: 40, onContended: (holder) => contended.push(holder) }, "second mutation"),
      ).rejects.toThrow(/lock is busy/u)
      expect(contended).toEqual([
        expect.stringMatching(new RegExp(`^first mutation \\(pid:${process.pid}, age \\d+ms\\)$`, "u")),
      ])
    } finally {
      first.release()
    }
    const uncontended: string[] = []
    const free = await acquireExclusive(
      dir,
      { timeoutMs: 0, onContended: (holder) => uncontended.push(holder) },
      "free",
    )
    free.release()
    expect(uncontended).toEqual([])
    await rm(dir, { recursive: true, force: true })
  })

  /**
   * @failure A legacy or unreadable holder timestamp becomes a fabricated age in a timeout refusal.
   * @level l1
   * @consumer Yrd worktree mutation store
   */
  test.each([undefined, "invalid", "9999-01-01T00:00:00.000Z"])(
    "reports unknown age when holder metadata has no usable start time: %j",
    async (startedAt) => {
      const dir = await mkdtemp(join(tmpdir(), "git-super-exclusive-"))
      const lock = await acquireExclusive(dir, { timeoutMs: 0 }, "legacy writer")
      try {
        await writeFile(
          join(dir, "writer.lock"),
          JSON.stringify({ pid: process.pid, holder: "legacy writer", startedAt }),
        )
        await expect(acquireExclusive(dir, { timeoutMs: 0 }, "contender")).rejects.toThrow(
          /holder=legacy writer; age=unknown;.*operation=contender/u,
        )
      } finally {
        lock.release()
        await rm(dir, { recursive: true, force: true })
      }
    },
  )
})
