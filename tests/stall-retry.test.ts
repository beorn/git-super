/**
 * @failure A stalled read-only git call is not retried, so an operation making
 *          ~90 sequential calls cannot complete against a flaky origin.
 * @level   l0
 * @consumer vendor/git-super/src/process.ts — createLocalGitProcess wraps its
 *           single-shot spawn in withStallRetry
 * @reach   repo-invariant
 *
 * Measured 2026-08-21: one `yrd queue run` makes ~90 git calls and the per-call
 * stall rate against origin was 20-40%. P(all 90 succeed) is then about 1e-14,
 * which is why the queue landed nothing for hours and why no queue-specific bug
 * was ever needed to explain it. These tests pin the policy that fixes it.
 */
import { afterEach, describe, expect, test, vi } from "vitest"
import type { GitProcess, GitProcessRequest, GitProcessResult } from "../src/process.ts"
import { isRetryableRead, withStallRetry } from "../src/process.ts"

/** A GitProcess that replays a scripted list of results and records its calls. */
function scripted(results: readonly GitProcessResult[]): GitProcess & { calls: GitProcessRequest[] } {
  const calls: GitProcessRequest[] = []
  let index = 0
  return {
    calls,
    run(request) {
      calls.push(request)
      const result = results[Math.min(index, results.length - 1)]
      index += 1
      return Promise.resolve(result as GitProcessResult)
    },
  }
}

const STALL: GitProcessResult = { code: 143, stdout: "", stderr: "", timedOut: true }
const OK: GitProcessResult = { code: 0, stdout: "abc123\trefs/heads/main", stderr: "" }
const REAL_FAILURE: GitProcessResult = { code: 128, stdout: "", stderr: "fatal: repository not found" }

const req = (args: readonly string[]): GitProcessRequest => ({ repo: "/tmp/repo", args, timeoutMs: 1000 })

afterEach(() => {
  vi.restoreAllMocks()
})

describe("withStallRetry", () => {
  test("retries a stalled ls-remote and returns the eventual success", async () => {
    const announced = vi.spyOn(console, "error").mockImplementation(() => {})
    const inner = scripted([STALL, OK])
    const result = await withStallRetry(inner).run(req(["ls-remote", "--refs", "origin", "main"]))
    expect(result.code).toBe(0)
    expect(inner.calls).toHaveLength(2)
    expect(announced).toHaveBeenCalledOnce()
    expect(announced).toHaveBeenCalledWith(expect.stringContaining("retry 2/3"))
  })

  test("retries a stalled fetch — it only advances remote-tracking refs", async () => {
    const announced = vi.spyOn(console, "error").mockImplementation(() => {})
    const inner = scripted([STALL, STALL, OK])
    const result = await withStallRetry(inner).run(req(["fetch", "origin"]))
    expect(result.code).toBe(0)
    expect(inner.calls).toHaveLength(3)
    expect(announced).toHaveBeenCalledTimes(2)
    expect(announced).toHaveBeenNthCalledWith(1, expect.stringContaining("retry 2/3"))
    expect(announced).toHaveBeenNthCalledWith(2, expect.stringContaining("retry 3/3"))
  })

  test("gives up after the attempt cap and reports the stall rather than hiding it", async () => {
    const announced = vi.spyOn(console, "error").mockImplementation(() => {})
    const inner = scripted([STALL])
    const result = await withStallRetry(inner).run(req(["ls-remote", "origin"]))
    expect(result.timedOut).toBe(true)
    expect(inner.calls).toHaveLength(3)
    expect(announced).toHaveBeenCalledTimes(2)
    expect(announced).toHaveBeenNthCalledWith(1, expect.stringContaining("retry 2/3"))
    expect(announced).toHaveBeenNthCalledWith(2, expect.stringContaining("retry 3/3"))
  })

  // The dangerous direction. A stalled mutation may ALREADY have reached the
  // remote, so re-running it could act twice.
  test("never retries a mutation, even when it stalls", async () => {
    for (const verb of ["push", "commit", "merge", "update-ref"]) {
      const inner = scripted([STALL, OK])
      const result = await withStallRetry(inner).run(req([verb, "origin", "main"]))
      expect(inner.calls, `${verb} must not be retried`).toHaveLength(1)
      expect(result.timedOut).toBe(true)
    }
  })

  // An exit code is git ANSWERING the question. Re-asking would paper over it.
  test("never retries a non-zero exit that is not a stall", async () => {
    const inner = scripted([REAL_FAILURE, OK])
    const result = await withStallRetry(inner).run(req(["ls-remote", "origin"]))
    expect(result.code).toBe(128)
    expect(inner.calls).toHaveLength(1)
  })

  test("passes a successful first call straight through", async () => {
    const inner = scripted([OK])
    await withStallRetry(inner).run(req(["ls-remote", "origin"]))
    expect(inner.calls).toHaveLength(1)
  })
})

describe("isRetryableRead", () => {
  test("classifies by the VERB, not by flag position", () => {
    expect(isRetryableRead(["--refs", "ls-remote"])).toBe(true)
    expect(isRetryableRead(["ls-remote", "--exit-code", "origin", "main"])).toBe(true)
    expect(isRetryableRead(["fetch", "--prune"])).toBe(true)
  })

  test("rejects mutations and anything unrecognised", () => {
    for (const verb of ["push", "commit", "merge", "update-ref", "notes", "gc"]) {
      expect(isRetryableRead([verb]), `${verb} must not be retryable`).toBe(false)
    }
    expect(isRetryableRead([])).toBe(false)
    expect(isRetryableRead(["--all"])).toBe(false)
  })
})
