/**
 * @failure withStallRetry exists and is never reached — the policy is unit-clean
 *          while createLocalGitProcess still makes single-shot calls.
 * @level   l0
 * @consumer vendor/git-super/src/process.ts — createLocalGitProcess
 * @reach   repo-invariant
 *
 * A tested decorator is not a WIRED decorator. This repo spent an evening on
 * defects of exactly that shape — a `--hook` mode nothing installed, a drift
 * check excluding the surface it claimed to cover — so the retry policy gets a
 * test that its real caller reaches it, not only that it works in isolation.
 *
 * The stall is forced deterministically with `timeoutMs: 1`: no spawned process
 * completes in a millisecond, so the timer always fires and the retry path is
 * always taken. No network, no flakiness.
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createLocalGitProcess } from "../src/process.ts"

let repo: string

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "git-super-stall-"))
  const init = spawnSync("git", ["init", "-q", repo], { encoding: "utf8" })
  if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("createLocalGitProcess wiring", () => {
  test("REACHES the retry policy — a stalled read-only call is re-run and announced", async () => {
    const logged: string[] = []
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      logged.push(String(line))
    })

    const result = await createLocalGitProcess().run({
      repo,
      // A local path as the remote: no network involved. `timeoutMs: 1` is what
      // forces the stall, not the remote being unreachable.
      args: ["ls-remote", repo],
      timeoutMs: 1,
    })

    expect(result.timedOut, "a 1ms budget must time out").toBe(true)
    // STALL_ATTEMPTS is 3, so two retries are announced after the first attempt.
    expect(logged.filter((line) => line.includes("retry"))).toHaveLength(2)
    expect(logged[0]).toContain("stalled after 1ms")
  })

  test("does NOT reach the retry policy for a mutation", async () => {
    const logged: string[] = []
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      logged.push(String(line))
    })

    const result = await createLocalGitProcess().run({
      repo,
      args: ["push", repo, "main"],
      timeoutMs: 1,
    })

    expect(result.timedOut).toBe(true)
    expect(logged.filter((line) => line.includes("retry"))).toHaveLength(0)
  })
})
