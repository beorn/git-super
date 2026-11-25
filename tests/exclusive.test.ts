/**
 * @failure Git-super's policy wrapper can diverge from the shared crash-safe
 * flock core and lose holder diagnostics or same-process exclusion.
 * @level l1
 * @consumer Yrd worktree mutation store
 */

import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test, vi } from "vitest"
import { setTimeout as delay } from "node:timers/promises"
import { spawn } from "node:child_process"
import { tryAcquireFlock } from "@bearly/flock"
import { fileLockHolders, formatLockHolders } from "@bearly/flock/holders"
import { acquireExclusive, DEFAULT_MUTATION_LOCK_WAIT_MS, reapStaleWriterLease } from "../src/exclusive.ts"

vi.mock("node:timers/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:timers/promises")>()
  return { ...actual, setTimeout: vi.fn(actual.setTimeout) }
})

describe("exclusive writer policy", () => {
  // 25677: a contended writer must use a positive shared-jitter delay without exceeding its poll cap.
  test.each([10, 1.5])("keeps a contended poll within its %s ms delay cap", async (pollIntervalMs) => {
    const dir = await mkdtemp(join(tmpdir(), "git-super-exclusive-"))
    const first = await acquireExclusive(dir, { timeoutMs: 0 }, "holder")
    const delays: number[] = []
    let released = false
    vi.spyOn(Math, "random").mockReturnValue(0.999)
    vi.mocked(delay).mockImplementation(async (ms, value) => {
      if (typeof ms !== "number") throw new TypeError("git-super poll delay must be a number of milliseconds")
      delays.push(ms)
      first.release()
      released = true
      return value
    })
    try {
      const second = await acquireExclusive(dir, { timeoutMs: 100, pollIntervalMs }, "contender")
      second.release()
      expect(delays).toHaveLength(1)
      expect(delays[0]).toBeGreaterThan(0)
      expect(delays[0]).toBeLessThanOrEqual(pollIntervalMs)
    } finally {
      if (!released) first.release()
      vi.mocked(delay).mockRestore()
      vi.restoreAllMocks()
      await rm(dir, { recursive: true, force: true })
    }
  })

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
      for (let poll = 0; poll < 100 && seen.length === 0; poll += 1) await delay(10)
      expect(seen).toEqual([expect.stringContaining("queue merge")])
      vi.setSystemTime(startedAt + 31_000)
      // Leave the real lock held across more than one 5 ms poll at the advanced time.
      await delay(20)
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
        /lock is busy after \d+ms \(timeout=25ms; live holder(?:: .*?| unknown \(.*?\)); recorded note, not authority: holder=first mutation; age=\d+ms;.*operation=second mutation/u,
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
        expect.stringMatching(
          new RegExp(
            `^live holder.*; recorded note, not authority: first mutation \\(pid:${process.pid}, age \\d+ms\\)$`,
            "u",
          ),
        ),
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

  /**
   * @failure 33483: a worktree removal held the lease without rewriting the note, and store-pack's busy report named the
   *          note's day-dead pid as the holder; busy errors and progress (33459) must distinguish live ownership from history.
   * @level l1
   * @consumer store-pack (tools/lib/store-gc.ts), busy refusals and contention progress
   */
  test.skipIf(process.platform !== "linux")(
    "busy and progress reports distinguish live ownership from a stale note, including after release",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "git-super-exclusive-"))
      const lock = await acquireExclusive(dir, { timeoutMs: 0 }, "live remover")
      let released = false
      try {
        // A bodyless lease leaves the previous writer's note behind: a pid that is long gone.
        await writeFile(
          join(dir, "writer.lock"),
          JSON.stringify({ pid: 2_000_000_000, holder: "stale pack", startedAt: "2026-11-10T09:13:03.000Z" }),
        )
        const progress: { holder: string; refresh: () => string }[] = []
        const refusal = await acquireExclusive(
          dir,
          { timeoutMs: 0, onContended: (holder, refresh) => progress.push({ holder, refresh }) },
          "pack",
        ).catch((error: unknown) => error)
        expect(refusal).toBeInstanceOf(Error)
        const message = (refusal as Error).message
        expect(message).toContain(`live holder: locks: writer.lock ${process.pid}(self) FLOCK WRITE`)
        expect(message).toContain("recorded note, not authority: holder=stale pack;")
        expect(message.indexOf("live holder:")).toBeLessThan(message.indexOf("recorded note"))
        expect(progress).toHaveLength(1)
        expect(progress[0]!.holder).toContain(`live holder: locks: writer.lock ${process.pid}(self) FLOCK WRITE`)
        expect(progress[0]!.holder).toContain("recorded note, not authority:")
        lock.release()
        released = true
        expect(progress[0]!.refresh()).toContain("live holder: none found in the kernel lock table")
        expect(JSON.parse(await readFile(join(dir, "writer.lock"), "utf8"))).toMatchObject({ pid: 2_000_000_000 })
        const next = await acquireExclusive(dir, { timeoutMs: 0 }, "next writer")
        next.release()
      } finally {
        if (!released) lock.release()
        // raw-delete-allow: teardown of this test's own mkdtemp fixture under tmpdir, as the file's other cases do.
        await rm(dir, { recursive: true, force: true })
      }
    },
  )

  /**
   * @failure A contended wait keeps re-reporting the first poll's holder and a frozen age after that
   *          holder released the flock, so the operator reads a departed pid as the live blocker (30095).
   * @level l1
   * @consumer Yrd submit merge and post-merge worktree add
   */
  test("refreshes the recorded note on each tick rather than freezing its first description", async () => {
    const dir = await mkdtemp(join(tmpdir(), "git-super-exclusive-"))
    const lockPath = join(dir, "writer.lock")
    const first = await acquireExclusive(dir, { timeoutMs: 0 }, "first operation")
    const seen: { holder: string; refresh: () => string }[] = []
    const ticked: string[] = []
    let released = false
    vi.spyOn(Math, "random").mockReturnValue(0.999)
    vi.mocked(delay).mockImplementation(async () => {
      if (released) return
      // Only the diagnostic note changed; the live kernel holder is still this process.
      await writeFile(
        lockPath,
        JSON.stringify({
          pid: 424242,
          holder: "second operation",
          startedAt: new Date(Date.now() - 900).toISOString(),
        }),
      )
      const entry = seen[0]
      if (entry === undefined) throw new Error("contention was not reported before the poll delay")
      ticked.push(entry.refresh())
      first.release()
      released = true
    })
    try {
      const second = await acquireExclusive(
        dir,
        {
          timeoutMs: 1_000,
          pollIntervalMs: 10,
          onContended: (holder, refresh) => seen.push({ holder, refresh }),
        },
        "contender",
      )
      second.release()
      expect(seen).toHaveLength(1)
      expect(seen[0]?.holder).toContain("first operation")
      expect(ticked[0]).toContain("second operation")
      expect(ticked[0]).toContain("pid:424242")
      expect(ticked[0]).toMatch(/age \d+ms/u)
    } finally {
      if (!released) first.release()
      vi.mocked(delay).mockRestore()
      vi.restoreAllMocks()
      await rm(dir, { recursive: true, force: true })
    }
  })
  // #33010 (@cto 2026-11-25): a lease file outlives a killed writer and then reads as "held" to every later caller —
  // one such file (pid 2272903, dead, no flock) stopped the retained-store drain for an hour on 2026-11-25.
  describe("reaping a stale writer lease", async () => {
    const deadPid = async (): Promise<number> => {
      const child = spawn("true", [], { stdio: "ignore" })
      const pid = child.pid as number
      await new Promise<void>((resolve) => child.once("exit", () => resolve()))
      return pid
    }
    const lease = async (body: string): Promise<string> => {
      const dir = await mkdtemp(join(tmpdir(), "git-super-reap-"))
      const path = join(dir, "writer.lock")
      await writeFile(path, body)
      return path
    }

    test("reaps a lease whose recorded pid is dead and which holds no flock, naming pid and reason", async () => {
      const pid = await deadPid()
      const path = await lease(JSON.stringify({ pid, startedAt: new Date().toISOString(), holder: "git super push" }))
      const reap = reapStaleWriterLease(path)
      if (process.platform !== "linux") {
        // Without procfs there is no kernel holder proof, so a dead pid alone must never be treated as stale.
        expect(reap).toEqual({ reaped: false, why: "kernel holder lookup unavailable on this platform" })
        expect(await readFile(path, "utf8")).toContain(String(pid))
        return
      }
      expect(reap).toEqual({
        reaped: true,
        pid,
        detail: `reaped stale writer lease pid ${String(pid)}, dead, no flock`,
      })
      await expect(readFile(path, "utf8")).rejects.toThrow(/ENOENT/u)
    })

    test("leaves a lease whose recorded pid is alive alone", async () => {
      const path = await lease(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
      const reap = reapStaleWriterLease(path)
      expect(reap).toEqual({ reaped: false, why: `pid ${String(process.pid)} is alive` })
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ pid: process.pid })
    })

    test("leaves a lease it cannot attribute alone: an unreadable body is not stale by this rule", async () => {
      const path = await lease("not json")
      expect(reapStaleWriterLease(path)).toMatchObject({ reaped: false })
      expect(await readFile(path, "utf8")).toBe("not json")
    })

    // The lock the file names can still be owned by a live descriptor (an exec'd child, a passed fd) even when the
    // pid in the body is dead: that is a held lease, not a stale one.
    test("leaves a lease alone while a live process holds its flock", async () => {
      const dir = await mkdtemp(join(tmpdir(), "git-super-reap-"))
      const path = join(dir, "writer.lock")
      const holder = tryAcquireFlock(path, { body: JSON.stringify({ pid: await deadPid() }) })
      expect(holder).not.toBeNull()
      try {
        if (process.platform !== "linux") {
          // The flock is real, but only procfs can show it; the contract on this platform is the same refusal.
          expect(reapStaleWriterLease(path)).toMatchObject({
            reaped: false,
            why: expect.stringContaining("kernel holder"),
          })
          expect(existsSync(path)).toBe(true)
          return
        }
        // procfs publishes the row just after the syscall returns, so wait for the kernel to show it.
        await vi.waitFor(() => {
          const shown = formatLockHolders(fileLockHolders([path], { self: process.pid }))
          expect(shown).toContain("FLOCK")
        })
        expect(reapStaleWriterLease(path)).toMatchObject({ reaped: false, why: expect.stringContaining("flock") })
        expect(existsSync(path)).toBe(true)
      } finally {
        holder?.release()
      }
    })
  })
})
