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
import { isExactPublickeyRefusal, isRetryableRead, verboseSshRetryEnvironment, withStallRetry } from "../src/process.ts"

/** A GitProcess that replays a scripted list of results and records its calls. */
function scripted(
  results: readonly GitProcessResult[],
  config: GitProcessResult = { code: 1, stdout: "", stderr: "" },
): GitProcess & { calls: GitProcessRequest[] } {
  const calls: GitProcessRequest[] = []
  let index = 0
  return {
    calls,
    run(request) {
      calls.push(request)
      if (request.args.join(" ") === "config --get core.sshCommand") {
        return Promise.resolve(config)
      }
      const result = results[Math.min(index, results.length - 1)]
      index += 1
      return Promise.resolve(result as GitProcessResult)
    },
  }
}

const STALL: GitProcessResult = { code: 143, stdout: "", stderr: "", timedOut: true }
const OK: GitProcessResult = { code: 0, stdout: "abc123\trefs/heads/main", stderr: "" }
const REAL_FAILURE: GitProcessResult = { code: 128, stdout: "", stderr: "fatal: repository not found" }
const PUBLICKEY_REFUSAL: GitProcessResult = {
  code: 128,
  stdout: "",
  stderr: "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
}

const req = (args: readonly string[]): GitProcessRequest => ({ repo: "/tmp/repo", args, timeoutMs: 1000 })

afterEach(() => {
  vi.useRealTimers()
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

  test.each([1, 3] as const)("reports a stalled read after the selected %i attempt cap", async (attempts) => {
    const announced = vi.spyOn(console, "error").mockImplementation(() => {})
    const inner = scripted([STALL])
    const result = await withStallRetry(inner, { attempts }).run(req(["ls-remote", "origin"]))
    expect(result).toBe(STALL)
    expect(inner.calls).toHaveLength(attempts)
    expect(announced).toHaveBeenCalledTimes(attempts - 1)
    if (attempts === 3) {
      expect(announced).toHaveBeenNthCalledWith(1, expect.stringContaining("retry 2/3"))
      expect(announced).toHaveBeenNthCalledWith(2, expect.stringContaining("retry 3/3"))
    }
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

  // 25282: the first SSH refusal must be visible, then one read retry may
  // recover. Existing stall-only coverage misses this settled exit-128 case.
  test.each(["fetch", "ls-remote"])(
    "announces one publickey retry for %s and captures the offered key",
    async (verb) => {
      vi.useFakeTimers()
      const announced = vi.spyOn(console, "error").mockImplementation(() => {})
      const inner = scripted([PUBLICKEY_REFUSAL, OK])
      const original = req([verb, "origin"])
      const request = { ...original, env: { GIT_SSH_COMMAND: "ssh -i /tmp/fleet-key -o IdentitiesOnly=yes" } }
      const pending = withStallRetry(inner).run(request)
      await vi.advanceTimersByTimeAsync(5_000)
      expect((await pending).code).toBe(0)
      expect(inner.calls).toHaveLength(2)
      expect(inner.calls[0]).toEqual(request)
      expect(inner.calls[1]?.env?.GIT_SSH_COMMAND).toBe("ssh -i /tmp/fleet-key -o IdentitiesOnly=yes -v")
      expect(announced).toHaveBeenCalledOnce()
      expect(announced).toHaveBeenCalledWith(expect.stringContaining("Permission denied (publickey)."))
    },
  )

  test("a second publickey refusal remains a failure after exactly one announced retry", async () => {
    vi.useFakeTimers()
    const announced = vi.spyOn(console, "error").mockImplementation(() => {})
    const inner = scripted([PUBLICKEY_REFUSAL, PUBLICKEY_REFUSAL, OK])
    const pending = withStallRetry(inner).run(req(["ls-remote", "origin"]))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await pending).toBe(PUBLICKEY_REFUSAL)
    expect(inner.calls).toHaveLength(3)
    expect(announced).toHaveBeenCalledOnce()
  })

  test("reads core.sshCommand and retries with its identity flags intact", async () => {
    vi.useFakeTimers()
    const announced = vi.spyOn(console, "error").mockImplementation(() => {})
    const inner = scripted([PUBLICKEY_REFUSAL, OK], {
      code: 0,
      stdout: "/tmp/fleet-ssh --identity-marker\n",
      stderr: "",
    })
    const pending = withStallRetry(inner).run(req(["ls-remote", "origin"]))
    await vi.advanceTimersByTimeAsync(5_000)
    expect((await pending).code).toBe(0)
    expect(inner.calls.map((call) => call.args.join(" "))).toEqual([
      "ls-remote origin",
      "config --get core.sshCommand",
      "ls-remote origin",
    ])
    expect(inner.calls[2]?.env?.GIT_SSH_COMMAND).toBe("/tmp/fleet-ssh --identity-marker -v")
    expect(announced.mock.calls[0]?.[0]).toContain("/tmp/fleet-ssh --identity-marker -v")
  })

  test("a publickey refusal on a write never retries", async () => {
    const inner = scripted([PUBLICKEY_REFUSAL, OK])
    expect(await withStallRetry(inner).run(req(["push", "origin", "main"]))).toBe(PUBLICKEY_REFUSAL)
    expect(inner.calls).toHaveLength(1)
  })

  test.each([{ failure: "Git output capture is incomplete" }, { signal: "SIGTERM" }, { stalled: true }])(
    "an incomplete publickey result never retries: %j",
    async (incomplete) => {
      const first = { ...PUBLICKEY_REFUSAL, ...incomplete }
      const inner = scripted([first, OK])
      expect(await withStallRetry(inner).run(req(["fetch", "origin"]))).toBe(first)
      expect(inner.calls).toHaveLength(1)
    },
  )

  test("passes a successful first call straight through", async () => {
    const inner = scripted([OK])
    await withStallRetry(inner).run(req(["ls-remote", "origin"]))
    expect(inner.calls).toHaveLength(1)
  })
})

describe("verboseSshRetryEnvironment", () => {
  test("preserves Git's command precedence and quotes GIT_SSH as one program", () => {
    expect(
      verboseSshRetryEnvironment({ GIT_SSH_COMMAND: "ssh -i chosen", GIT_SSH: "/other" }, "ssh -i config").command,
    ).toBe("ssh -i chosen -v")
    expect(verboseSshRetryEnvironment({ GIT_SSH: "/tmp/one two's ssh" }, "ssh -i config").command).toBe(
      "ssh -i config -v",
    )
    expect(verboseSshRetryEnvironment({ GIT_SSH: "/tmp/one two's ssh" }, undefined).command).toBe(
      "'/tmp/one two'\\''s ssh' -v",
    )
    expect(verboseSshRetryEnvironment({}, undefined).command).toBe("ssh -v")
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

describe("isExactPublickeyRefusal", () => {
  // 25282: an arbitrary exit 128 or explanatory prose mentioning the phrase
  // must not be mistaken for OpenSSH's own exact refusal line.
  test("accepts only a settled non-zero exit containing the exact SSH refusal line", () => {
    expect(isExactPublickeyRefusal(PUBLICKEY_REFUSAL)).toBe(true)
    expect(isExactPublickeyRefusal({ code: 128, stderr: "Permission denied (publickey).\n" })).toBe(true)
    expect(isExactPublickeyRefusal({ code: 0, stderr: PUBLICKEY_REFUSAL.stderr })).toBe(false)
    expect(isExactPublickeyRefusal(REAL_FAILURE)).toBe(false)
    expect(isExactPublickeyRefusal({ code: 128, stderr: "fatal: Permission denied (publickey). maybe" })).toBe(false)
  })
})
