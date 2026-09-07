import { afterEach, describe, expect, test, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLocalGitProcess } from "../src/process.ts"
import * as processPort from "git-super/process"
import type { SupervisedProcess } from "git-super/process"
import { canonicalTmpdir, createRepository } from "./fixture.ts"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("GitProcess", () => {
  // Gate A: graph-process tests intentionally scrub Git variables and decode text.
  // They cannot prove a selected executable preserves the caller's raw request.
  test("delegated CLI preserves argv, cwd, environment, empty/binary stdin, streams and exit", async () => {
    const root = mkdtempSync(join(canonicalTmpdir(), "git-super-native-bytes-"))
    roots.push(root)
    writeFileSync(
      join(root, "git"),
      `#!${process.execPath}
const input = await new Response(Bun.stdin.stream()).arrayBuffer()
process.stdout.write(JSON.stringify({args: process.argv.slice(2), cwd: process.cwd(), config: process.env.GIT_CONFIG_COUNT, dir: process.env.GIT_DIR}) + "\\n")
process.stdout.write(Buffer.from(input))
process.stderr.write(Buffer.from([32, 255, 0, 13, 10, 32]))
process.exitCode = 19
`,
      { mode: 0o755 },
    )
    const args = ["opaque", "", "two words", "--", "--json"]
    const env = { ...process.env, PATH: `${root}:${process.env.PATH}`, GIT_CONFIG_COUNT: "0", GIT_DIR: "keep-this" }
    for (const input of [Buffer.alloc(0), Buffer.from([0, 255, 195, 10, 32])]) {
      const child = Bun.spawn([process.execPath, join(import.meta.dirname, "../bin/git-super"), ...args], {
        cwd: root,
        env,
        stdin: new Blob([input]),
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).bytes(),
        new Response(child.stderr).bytes(),
      ])
      expect(code, Buffer.from(stderr).toString()).toBe(19)
      expect(Buffer.from(stdout)).toEqual(
        Buffer.concat([Buffer.from(JSON.stringify({ args, cwd: root, config: "0", dir: "keep-this" }) + "\n"), input]),
      )
      expect(Buffer.from(stderr)).toEqual(Buffer.from([32, 255, 0, 13, 10, 32]))
    }
  })

  test("delegation retains the native PID and cancellation, and refuses executable recursion", async () => {
    const root = mkdtempSync(join(canonicalTmpdir(), "git-super-native-lifetime-"))
    roots.push(root)
    const executable = join(root, "git")
    const cli = join(import.meta.dirname, "../bin/git-super")
    writeFileSync(
      executable,
      `#!${process.execPath}
process.stdout.write(String(process.pid) + "\\n")
setInterval(() => {}, 1000)
`,
      { mode: 0o755 },
    )
    const child = Bun.spawn([process.execPath, cli, "opaque"], {
      cwd: root,
      env: { ...process.env, PATH: `${root}:${process.env.PATH}` },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    try {
      const reader = child.stdout.getReader()
      const first = await reader.read()
      reader.releaseLock()
      expect(Buffer.from(first.value ?? []).toString()).toBe(`${child.pid}\n`)
      child.kill("SIGTERM")
      expect(await child.exited).toBe(143)
      expect(child.signalCode).toBe("SIGTERM")
      expect(await new Response(child.stderr).text()).toBe("")
    } finally {
      child.kill()
      await child.exited
    }
    const recursive = join(root, "recursive")
    // Reuse this fixture directory as a PATH entry, without replacing host Git.
    mkdirSync(recursive)
    symlinkSync(cli, join(recursive, "git"))
    const refused = Bun.spawnSync([process.execPath, cli, "opaque"], {
      cwd: root,
      env: { ...process.env, PATH: recursive },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 2000,
    })
    expect(refused.exitCode).toBe(1)
    expect(refused.stderr.toString()).toContain("native Git resolves to git-super itself")
    const missing = Bun.spawnSync([process.execPath, cli, "opaque"], {
      cwd: root,
      env: { ...process.env, PATH: join(root, "missing") },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(missing.exitCode).toBe(1)
    expect(missing.stderr.toString()).toContain("native Git executable 'git' was not found on PATH")
  })

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
