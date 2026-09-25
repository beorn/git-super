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
import {
  coreSshCommandFromConfig,
  isExactPublickeyRefusal,
  isRetryableRead,
  isSshSessionDrop,
  verboseSshRetryEnvironment,
  withStallRetry,
} from "../src/process.ts"

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

  test("an abort during publickey backoff returns the first refusal without a second read", async () => {
    vi.useFakeTimers()
    vi.spyOn(console, "error").mockImplementation(() => {})
    const controller = new AbortController()
    const inner = scripted([PUBLICKEY_REFUSAL, OK])
    const pending = withStallRetry(inner).run({
      ...req(["fetch", "origin"]),
      env: { GIT_SSH_COMMAND: "ssh -i fleet-key" },
      signal: controller.signal,
    })
    await vi.advanceTimersByTimeAsync(1_000)
    controller.abort()
    expect(await pending).toBe(PUBLICKEY_REFUSAL)
    expect(inner.calls).toHaveLength(1)
  })

  test("attempts: 1 disables the publickey retry", async () => {
    const inner = scripted([PUBLICKEY_REFUSAL, OK])
    const result = await withStallRetry(inner, { attempts: 1 }).run(req(["fetch", "origin"]))
    expect(result).toBe(PUBLICKEY_REFUSAL)
    expect(inner.calls).toHaveLength(1)
  })

  test.each([
    ["exit 128", { code: 128, stdout: "", stderr: "fatal: broken config" }],
    ["timeout", { code: 1, stdout: "", stderr: "", timedOut: true }],
  ] as const)("returns the first refusal and announces an SSH config %s", async (_name, config) => {
    const announced = vi.spyOn(console, "error").mockImplementation(() => {})
    const inner = scripted([PUBLICKEY_REFUSAL, OK], config)
    const result = await withStallRetry(inner).run(req(["fetch", "origin"]))
    expect(result).toBe(PUBLICKEY_REFUSAL)
    expect(inner.calls.map((call) => call.args.join(" "))).toEqual(["fetch origin", "config --get core.sshCommand"])
    expect(announced.mock.calls[0]?.[0]).toContain("cannot read core.sshCommand")
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

test("an incomplete config lookup is never treated as an absent SSH command", () => {
  expect(coreSshCommandFromConfig({ code: 1, stdout: "", stderr: "" }, "/repo")).toBeUndefined()
  expect(() => coreSshCommandFromConfig({ code: 1, stdout: "", stderr: "", timedOut: true }, "/repo")).toThrow(
    "cannot read core.sshCommand",
  )
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

// 25616 row 2 (measured 2026-09-25): a read whose SSH session drops mid-read. A client of a shared ControlMaster
// connection prints only Git's own fatal lines; a direct connection names the close first.
const DROP_ADVICE = "\n\nPlease make sure you have the correct access rights\nand the repository exists.\n"
const MUX_DROP: GitProcessResult = {
  code: 128,
  stdout: "",
  stderr: `fatal: Could not read from remote repository.${DROP_ADVICE}`,
}
const MUX_DROP_MID_LISTING: GitProcessResult = {
  code: 128,
  stdout: "",
  stderr: "fatal: expected flush after ref listing\n",
}
const MUX_SELF_HEAL =
  "mux_client_request_session: session request failed: Session open refused by peer\n" +
  "ControlSocket /run/user/3001/hh-ssh/3f60e39f78041c85907e381d201d2a12511f0172 already exists, disabling multiplexing\n"
// The yrd evidence holds 440 of these (newlines flattened there): every real drop sample is this shape.
const DIRECT_DROP: GitProcessResult = {
  code: 128,
  stdout: "",
  stderr: `Connection to github.com closed by remote host.\nfatal: Could not read from remote repository.${DROP_ADVICE}`,
}

describe("a dropped SSH session is retried once (25616 row 2)", () => {
  test.each([
    ["a shared master's client", MUX_DROP],
    ["a shared master's client mid-listing", MUX_DROP_MID_LISTING],
    ["a direct connection", DIRECT_DROP],
  ] as const)("announces one retry of a read whose session dropped: %s", async (_name, drop) => {
    vi.useFakeTimers()
    const announced = vi.spyOn(console, "error").mockImplementation(() => {})
    const inner = scripted([drop, OK])
    const request = req(["ls-remote", "origin"])
    const pending = withStallRetry(inner).run(request)
    await vi.advanceTimersByTimeAsync(5_000)
    expect((await pending).code).toBe(0)
    expect(inner.calls).toEqual([request, request])
    expect(announced).toHaveBeenCalledOnce()
    expect(announced).toHaveBeenCalledWith(expect.stringContaining("SSH session dropped; retry 2/2 after 3000ms"))
  })

  test("a second drop remains a failure after exactly one announced retry", async () => {
    vi.useFakeTimers()
    const announced = vi.spyOn(console, "error").mockImplementation(() => {})
    const inner = scripted([MUX_DROP, MUX_DROP, OK])
    const pending = withStallRetry(inner).run(req(["fetch", "origin"]))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await pending).toBe(MUX_DROP)
    expect(inner.calls).toHaveLength(2)
    expect(announced).toHaveBeenCalledOnce()
  })

  test("a dropped write never retries, and attempts: 1 disables the retry", async () => {
    const write = scripted([MUX_DROP, OK])
    expect(await withStallRetry(write).run(req(["push", "origin", "main"]))).toBe(MUX_DROP)
    expect(write.calls).toHaveLength(1)
    const single = scripted([MUX_DROP, OK])
    expect(await withStallRetry(single, { attempts: 1 }).run(req(["fetch", "origin"]))).toBe(MUX_DROP)
    expect(single.calls).toHaveLength(1)
  })
})

describe("isSshSessionDrop", () => {
  test("accepts an exit 128 whose every line is a measured drop line", () => {
    expect([MUX_DROP, MUX_DROP_MID_LISTING, DIRECT_DROP].map(isSshSessionDrop)).toEqual([true, true, true])
  })

  // A refusal always prints a line of its own, so it is Git or the remote ANSWERING, and re-asking would hide it.
  test.each([
    ["the publickey refusal", PUBLICKEY_REFUSAL],
    [
      "a missing repository",
      {
        code: 128,
        stderr: `ERROR: Repository not found.\nfatal: Could not read from remote repository.${DROP_ADVICE}`,
      },
    ],
    // The yrd evidence's six real refusals of this shape.
    [
      "a refused connection",
      {
        code: 128,
        stderr: `ssh: connect to host github.com port 22: Connection refused\nfatal: Could not read from remote repository.${DROP_ADVICE}`,
      },
    ],
    [
      "a drop with one unknown line",
      { code: 128, stderr: `${DIRECT_DROP.stderr}fatal: the remote end hung up unexpectedly\n` },
    ],
    // Over ten sessions a master refuses the next one and ssh opens its own login; that call succeeds, so it is no drop.
    ["the mux self-heal that succeeded", { code: 0, stderr: MUX_SELF_HEAL }],
    ["the mux self-heal lines beside a drop", { code: 128, stderr: `${MUX_SELF_HEAL}${MUX_DROP.stderr}` }],
    [
      "an ssh wrapper's own refusal",
      {
        code: 128,
        stderr: `git-ssh-wrapper: XDG_RUNTIME_DIR is unset\nfatal: Could not read from remote repository.${DROP_ADVICE}`,
      },
    ],
    ["a local failure", REAL_FAILURE],
    ["a success", { code: 0, stderr: MUX_DROP.stderr }],
    ["another exit code", { code: 1, stderr: MUX_DROP.stderr }],
    ["an empty stderr", { code: 128, stderr: "\n" }],
  ] as const)("rejects %s", (_name, result) => {
    expect(isSshSessionDrop(result)).toBe(false)
  })
})
