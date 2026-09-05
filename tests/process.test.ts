import { afterEach, describe, expect, test, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLocalGitProcess } from "../src/process.ts"
import * as processPort from "git-super/process"
import type { SupervisedProcess } from "git-super/process"
import { createRepository } from "./fixture.ts"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("GitProcess", () => {
  test("adapts supervised requests with scrubbed defaults and explicit overrides", async () => {
    const signal = new AbortController().signal
    const overrideSignal = new AbortController().signal
    const run = vi.fn<SupervisedProcess["run"]>().mockResolvedValue({
      exitCode: 7,
      stdout: "out\n",
      stderr: "err\n",
      signal: "SIGTERM",
      timedOut: false,
      verdict: "EXITED",
    })
    const git = processPort.adaptProcessGit(
      { run },
      {
        env: { GIT_DIR: "/wrong", GIT_CONFIG_COUNT: "1", KEEP: "yes" },
        timeoutMs: 321,
        signal,
      },
    )

    expect(await git.run({ repo: "/repo", args: ["status"] })).toEqual({
      code: 7,
      stdout: "out\n",
      stderr: "err\n",
      signal: "SIGTERM",
      timedOut: false,
    })
    const environment = {
      KEEP: "yes",
      KM_NO_AUTO_SUBMODULE_UPDATE: "1",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      TZ: "UTC",
    }
    expect(run).toHaveBeenNthCalledWith(1, {
      argv: ["git", "-C", "/repo", "status"],
      cwd: "/repo",
      env: environment,
      timeoutMs: 321,
      signal,
    })

    await git.run({
      repo: "/other",
      args: ["patch-id", "--stable"],
      stdin: "diff\n",
      timeoutMs: 9,
      signal: overrideSignal,
      env: { EXTRA: "call", GIT_INDEX_FILE: "/explicit-index", GIT_TERMINAL_PROMPT: "1", LC_ALL: "other", TZ: "other" },
    })
    expect(run).toHaveBeenNthCalledWith(2, {
      argv: ["git", "-C", "/other", "patch-id", "--stable"],
      cwd: "/other",
      stdin: "diff\n",
      timeoutMs: 9,
      signal: overrideSignal,
      env: { ...environment, EXTRA: "call", GIT_INDEX_FILE: "/explicit-index" },
    })
    expect(processPort.cleanGitEnvironment({ GIT_DIR: "/wrong", KEEP: "yes" })).toEqual({
      KEEP: "yes",
      KM_NO_AUTO_SUBMODULE_UPDATE: "1",
    })
  })

  test.each([
    { verdict: "TIMED_OUT", timedOut: true, failure: "process verdict TIMED_OUT" },
    { verdict: "EXITED", sweepFailure: "child did not settle", failure: "child did not settle" },
    { verdict: "STALLED", stalled: true, sweepFailure: "child did not settle", failure: "child did not settle" },
  ])("preserves $verdict failure $failure", async ({ failure, ...metadata }) => {
    const result = { exitCode: 1, stdout: "out", stderr: "err", signal: null, timedOut: false, ...metadata }
    const git = processPort.adaptProcessGit({ run: async () => result }, { env: {} })
    expect(await git.run({ repo: "/repo", args: ["status"] })).toEqual({
      code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      signal: result.signal,
      timedOut: result.timedOut,
      ...("stalled" in metadata ? { stalled: metadata.stalled } : {}),
      failure,
    })
  })

  test("reports a bounded Git command timeout explicitly", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "git-super-process-timeout-"))
    roots.push(fixture)
    createRepository(fixture, "README.md", "one\n")

    const result = await createLocalGitProcess().run({
      repo: fixture,
      args: ["-c", "alias.pause=!sleep 1", "pause"],
      timeoutMs: 10,
    })

    expect(result.code).not.toBe(0)
    expect(result.timedOut).toBe(true)
  })
})
