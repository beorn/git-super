import { afterEach, describe, expect, test, vi } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLocalGitProcess } from "../src/process.ts"
import * as processPort from "git-super/process"
import type { SupervisedProcess } from "git-super/process"
import { advanceRepository, canonicalTmpdir, createRepository, git } from "./fixture.ts"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("GitProcess", () => {
  // Gate A: graph-process tests intentionally scrub Git variables and decode text.
  // They cannot prove a selected executable preserves the caller's raw request.
  test.each([false, true])(
    "delegated CLI preserves native bytes and closes its control endpoint (protocol=%s)",
    async (protocol) => {
      const root = mkdtempSync(join(canonicalTmpdir(), "git-super-native-bytes-"))
      roots.push(root)
      writeFileSync(
        join(root, "git"),
        `#!${process.execPath}
import { writeSync } from 'node:fs'
// Bun can reuse numeric fd3 internally after exec. It must not be the control endpoint.
try { writeSync(3, 'native inherited control\\n') }
catch (error) { if (!['EBADF', 'EINVAL'].includes(error.code)) throw error }
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
        const child = Bun.spawn(
          [
            process.execPath,
            join(import.meta.dirname, "../bin/git-super"),
            ...(protocol ? ["--protocol-fd=3"] : []),
            ...args,
          ],
          {
            cwd: root,
            env,
            stdio: protocol ? [new Blob([input]), "pipe", "pipe", "pipe"] : [new Blob([input]), "pipe", "pipe"],
          },
        )
        const fd = child.stdio[3]
        const control =
          protocol && typeof fd === "number"
            ? new Response(Bun.file(fd).stream()).bytes().then(
                (bytes) => ({ bytes: Buffer.from(bytes).toString() }),
                (error) => ({ error: String(error) }),
              )
            : undefined
        if (protocol) {
          if (typeof fd !== "number") throw new Error("Test did not open the requested control descriptor")
          writeSync(fd, JSON.stringify({ version: 1, token: "native-fd-token" }) + "\n")
        }
        const [code, stdout, stderr, controlBytes] = await Promise.all([
          child.exited,
          new Response(child.stdout).bytes(),
          new Response(child.stderr).bytes(),
          control,
        ])
        expect(code, Buffer.from(stderr).toString()).toBe(19)
        expect(Buffer.from(stdout)).toEqual(
          Buffer.concat([
            Buffer.from(JSON.stringify({ args, cwd: root, config: "0", dir: "keep-this" }) + "\n"),
            input,
          ]),
        )
        expect(Buffer.from(stderr)).toEqual(Buffer.from([32, 255, 0, 13, 10, 32]))
        expect(controlBytes).toEqual(
          protocol
            ? { bytes: JSON.stringify({ version: 1, token: "native-fd-token", ready: true }) + "\n" }
            : undefined,
        )
      }
    },
  )

  test("an explicitly requested missing control endpoint fails before native execution", () => {
    const result = Bun.spawnSync(
      [process.execPath, join(import.meta.dirname, "../bin/git-super"), "--protocol-fd=3", "--version"],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 2000,
      },
    )
    expect(result.exitCode).toBe(1)
    expect(result.stdout.toString()).toBe("")
    expect(result.stderr.toString()).toContain("control descriptor 3")
    expect(result.stderr.toString()).toContain("readable duplex")
  })

  // Sixth-item contract: closing before native delegation must also preserve a
  // launch error. Byte-preservation cases use a present executable and miss it.
  test("native launch failure after readiness retains its error without a false producer refusal", async () => {
    const root = mkdtempSync(join(canonicalTmpdir(), "git-super-control-native-failure-"))
    roots.push(root)
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dirname, "../bin/git-super"), "--protocol-fd=3", "opaque"],
      {
        cwd: root,
        env: { ...process.env, PATH: root },
        stdio: ["ignore", "pipe", "pipe", "pipe"],
      },
    )
    const fd = child.stdio[3]
    if (typeof fd !== "number") throw new Error("Test did not open the requested control descriptor")
    const control = new Response(Bun.file(fd).stream()).text()
    writeSync(fd, JSON.stringify({ version: 1, token: "launch-failure" }) + "\n")
    const [code, stdout, stderr, frames] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      control,
    ])
    expect({ code, stdout, frames }).toEqual({
      code: 1,
      stdout: "",
      frames: JSON.stringify({ version: 1, token: "launch-failure", ready: true }) + "\n",
    })
    expect(stderr).toBe("git-super: native Git executable 'git' was not found on PATH\n")
  })

  // Sixth-item greeting validation must precede execution and report its
  // expected endpoint. Native byte tests only exercise a valid greeting.
  test.each([
    ["invalid UTF-8", Buffer.from([255, 10])],
    ["invalid JSON", Buffer.from("{\n")],
    ["unknown version", Buffer.from('{"version":2,"token":"test"}\n')],
    ["oversized greeting", Buffer.from(JSON.stringify({ version: 1, token: "x".repeat(64 * 1024) }) + "\n")],
  ])("invalid control greeting (%s) fails before command execution", async (_label, greeting) => {
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dirname, "../bin/git-super"), "--protocol-fd=3", "--version"],
      {
        stdio: ["ignore", "pipe", "pipe", "pipe"],
      },
    )
    const fd = child.stdio[3]
    if (typeof fd !== "number") throw new Error("Test did not open the requested control descriptor")
    const control = new Response(Bun.file(fd).stream()).text()
    writeSync(fd, greeting)
    const [code, stdout, stderr, frames] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      control,
    ])
    expect({ code, stdout, frames }).toEqual({ code: 1, stdout: "", frames: "" })
    expect(stderr).toContain("git-super: control descriptor 3")
  })

  test("a second greeting after readiness is a visible protocol defect", async () => {
    const root = mkdtempSync(join(canonicalTmpdir(), "git-super-control-duplicate-"))
    roots.push(root)
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dirname, "../bin/git-super"),
        "--protocol-fd=3",
        "--repo",
        join(root, "absent"),
        "status",
        "--json",
      ],
      {
        stdio: ["ignore", "pipe", "pipe", "pipe"],
      },
    )
    const fd = child.stdio[3]
    if (typeof fd !== "number") throw new Error("Test did not open the requested control descriptor")
    const reader = Bun.file(fd).stream().getReader()
    const greeting = JSON.stringify({ version: 1, token: "duplicate" }) + "\n"
    writeSync(fd, greeting)
    let frames = ""
    while (!frames.includes("\n")) {
      const next = await reader.read()
      if (next.done) throw new Error("Producer closed before readiness")
      frames += Buffer.from(next.value).toString()
    }
    expect(JSON.parse(frames)).toEqual({ version: 1, token: "duplicate", ready: true })
    writeSync(fd, greeting)
    while (true) {
      const next = await reader.read()
      if (next.done) break
      frames += Buffer.from(next.value).toString()
    }
    reader.releaseLock()
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, stdout }).toEqual({ code: 1, stdout: "" })
    expect(stderr).toContain("unexpected input after the greeting")
    expect(frames).toBe(JSON.stringify({ version: 1, token: "duplicate", ready: true }) + "\n")
  })

  // Native exec closure cannot prove the enriched producer keeps its endpoint
  // while excluding Git and hooks; this real hook refuses after composition.
  test("enriched execution retains its refusal endpoint while its Git hook cannot write to it", async () => {
    const root = mkdtempSync(join(canonicalTmpdir(), "git-super-control-hook-"))
    roots.push(root)
    const base = createRepository(root, "base.txt", "base\n")
    git(root, "switch", "-q", "-c", "candidate")
    const candidate = advanceRepository(root, "candidate.txt", "candidate\n")
    git(root, "switch", "-q", "main")
    const marker = join(root, ".git", "hook-control-evidence")
    writeFileSync(
      join(root, ".git", "hooks", "pre-commit"),
      `#!${process.execPath}
import { writeSync, writeFileSync } from 'node:fs'
let outcome = 'inherited'
try { writeSync(3, 'hook forged control\\n') }
catch (error) {
  if (!['EBADF', 'EINVAL'].includes(error.code)) throw error
  outcome = 'excluded'
}
writeFileSync(${JSON.stringify(marker)}, outcome)
process.stderr.write('hook-policy-refused\\n')
process.exitCode = 23
`,
      { mode: 0o755 },
    )
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dirname, "../bin/git-super"),
        "--protocol-fd=3",
        "--repo",
        root,
        "merge",
        candidate,
      ],
      {
        stdio: ["ignore", "pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Git Super Test",
          GIT_AUTHOR_EMAIL: "git-super@example.test",
          GIT_COMMITTER_NAME: "Git Super Test",
          GIT_COMMITTER_EMAIL: "git-super@example.test",
        },
      },
    )
    const fd = child.stdio[3]
    if (typeof fd !== "number") throw new Error("Test did not open the requested control descriptor")
    const control = new Response(Bun.file(fd).stream()).text()
    writeSync(fd, JSON.stringify({ version: 1, token: "hook-refusal" }) + "\n")
    const [code, stdout, stderr, frames] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      control,
    ])
    expect(code, stderr).toBeGreaterThan(0)
    expect({ stdout, head: git(root, "rev-parse", "HEAD"), hook: readFileSync(marker, "utf8") }).toEqual({
      stdout: "",
      head: base,
      hook: "excluded",
    })
    expect(stderr).toContain("hook-policy-refused")
    expect(
      frames
        .trimEnd()
        .split("\n")
        .map((frame) => JSON.parse(frame)),
    ).toEqual([
      { version: 1, token: "hook-refusal", ready: true },
      {
        version: 1,
        token: "hook-refusal",
        refusal: "unjudged",
        message: expect.stringContaining("hook-policy-refused"),
      },
    ])
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
