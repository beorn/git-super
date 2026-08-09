/**
 * @failure Git-super's policy wrapper can diverge from the shared crash-safe
 * flock core and lose holder diagnostics or same-process exclusion.
 * @level l1
 * @consumer Yrd worktree mutation store
 */

import { mkdtemp, readFile, rm } from "node:fs/promises"
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
      await expect(acquireExclusive(dir, { timeoutMs: 0 }, "second mutation")).rejects.toThrow(
        /holder=first mutation.*operation=second mutation/u,
      )
    } finally {
      first.release()
    }

    const successor = await acquireExclusive(dir, { timeoutMs: 0 }, "successor")
    successor.release()
    await rm(dir, { recursive: true, force: true })
  })
})
