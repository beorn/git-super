/**
 * @failure Git-super's policy wrapper can diverge from the shared crash-safe
 * flock core and lose holder diagnostics or same-process exclusion.
 * @level l1
 * @consumer Yrd worktree mutation store
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { acquireExclusive } from "../src/exclusive.ts"

describe("exclusive writer policy", () => {
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
