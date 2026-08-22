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
 * The stall is forced by a transport that CANNOT return — see STALLING_REMOTE.
 *
 * This header used to claim "no spawned process completes in a millisecond, so
 * the timer always fires ... no flakiness", and that claim was false. Both tests
 * raced a 1ms timer against a real local git call. The mutation lost 1 run in 30
 * (measured 2026-08-22, 30 consecutive runs) because the repo has no commits, so
 * `push main` failed at refspec validation in well under a millisecond and never
 * timed out at all. @ci rejected this commit on exactly that red and was right;
 * a single green run cannot disprove a race, and two separate single green runs
 * misled this repo about this very file on the same night.
 *
 * The lesson worth keeping: the `timedOut` assertion is a SETUP CONDITION, not
 * the subject. When it failed, the red read as "mutations get retried" when it
 * meant "this test could not stage its own precondition" — a failure that does
 * not state its own denominator. Both preconditions now say so in their message.
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createLocalGitProcess } from "../src/process.ts"

let repo: string

/**
 * A transport that never returns, so the 1ms budget ALWAYS wins.
 *
 * git delegates an `ssh://` remote entirely to `GIT_SSH_COMMAND`, so `sleep 30`
 * runs in ssh's place, ignores the host argument, and blocks. Nothing resolves
 * the hostname and nothing touches the network — ssh is never executed. The
 * child is killed at 1ms, so the 30s is a ceiling that is never reached.
 *
 * `ext::sleep 30` was tried first and is WORSE than what it replaced: git gates
 * the ext transport behind `protocol.ext.allow` and refuses it outright in some
 * invocations, which exits fast and never times out. Measured 26 failures in 50
 * against 1 in 30 for the original. Do not reintroduce it.
 */
const STALLING_REMOTE = "ssh://git@stall.invalid/repo.git"
const STALLING_ENV = { GIT_SSH_COMMAND: "sleep 30" } as const

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "git-super-stall-"))
  const init = spawnSync("git", ["init", "-q", "-b", "main", repo], { encoding: "utf8" })
  if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`)
  // `main` must EXIST as a ref, or `git push <remote> main` fails at local
  // refspec resolution ("src refspec main does not match any") before it opens
  // any transport at all — so the stalling transport never runs and the call
  // returns in microseconds. That, not the remote, was the original race.
  const seed = spawnSync(
    "git",
    [
      "-C",
      repo,
      "-c",
      "user.email=t@example.invalid",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "seed",
    ],
    { encoding: "utf8" },
  )
  if (seed.status !== 0) throw new Error(`git commit failed: ${seed.stderr}`)
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
      args: ["ls-remote", STALLING_REMOTE],
      env: STALLING_ENV,
      timeoutMs: 1,
    })

    expect(result.timedOut, "PRECONDITION, not the subject: the stalling transport must outlive the 1ms budget").toBe(
      true,
    )
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
      args: ["push", STALLING_REMOTE, "main"],
      env: STALLING_ENV,
      timeoutMs: 1,
    })

    // Was `["push", repo, "main"]` against an empty repo, which failed at refspec
    // validation in microseconds and left timedOut undefined 1 run in 30.
    expect(result.timedOut, "PRECONDITION, not the subject: the stalling transport must outlive the 1ms budget").toBe(
      true,
    )
    // THE SUBJECT: a stalled mutation is never re-run.
    expect(
      logged.filter((line) => line.includes("retry")),
      "a mutation must never be retried",
    ).toHaveLength(0)
  })
})
