/**
 * @failure Node library consumers cannot resolve Git or receive the named Bun CLI refusal.
 * @level l2
 * @consumer Git-super library users on Node and Bun.
 * @testonly none
 * process.test.ts owns the Bun CLI/fd3 lifecycle; its Bun launch helpers cannot run under Node.
 */
import { afterEach, expect, test, vi } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { setTimeout as delay } from "node:timers/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { createLocalGitProcess, delegateNativeGit, nativeGitExecutable, readNativeGit } from "../src/process.ts"

const roots: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test("library resolves executable Git on the inherited PATH, skipping non-executable entries", () => {
  const executable = nativeGitExecutable()
  expect(execFileSync(executable, ["--version"], { encoding: "utf8" })).toMatch(/^git version /u)
  if (typeof Bun !== "undefined") {
    const bunExecutable = Bun.which("git", { PATH: process.env.PATH ?? "" })
    expect(bunExecutable).not.toBeNull()
    expect(realpathSync(executable)).toBe(realpathSync(bunExecutable as string))
  }
  const root = mkdtempSync(join(tmpdir(), "git-super-library-path-"))
  roots.push(root)
  const first = join(root, "first")
  const second = join(root, "second")
  mkdirSync(first)
  mkdirSync(second)
  writeFileSync(join(first, "git"), "not executable", { mode: 0o644 })
  symlinkSync(executable, join(second, "git"))
  vi.stubEnv("PATH", `${first}:${second}`)
  expect(nativeGitExecutable()).toBe(join(second, "git"))
  if (typeof Bun !== "undefined") expect(nativeGitExecutable()).toBe(Bun.which("git", { PATH: `${first}:${second}` }))
})

test("library names a missing Git and refuses executable recursion", () => {
  const root = mkdtempSync(join(tmpdir(), "git-super-library-missing-"))
  roots.push(root)
  vi.stubEnv("PATH", root)
  expect(() => nativeGitExecutable()).toThrow("native Git executable 'git' was not found on PATH")
  symlinkSync(join(import.meta.dirname, "../bin/git-super"), join(root, "git"))
  expect(() => nativeGitExecutable()).toThrow("native Git resolves to git-super itself")
})

// Node must refuse delegation while Bun must remain eligible; process.test.ts owns fd3/native exec lifetime.
test("native delegation allows Bun and gives Node the named CLI floor refusal", async () => {
  let stdout = ""
  let stderr = ""
  const out = {
    write: (value: string | Uint8Array) => {
      stdout += Buffer.from(value).toString()
    },
  }
  const err = {
    write: (value: string | Uint8Array) => {
      stderr += Buffer.from(value).toString()
    },
  }
  if (typeof Bun === "undefined") {
    await expect(delegateNativeGit(["--version"], out, err, false)).rejects.toThrow("Bun CLI requires Bun >=1.3.14")
    expect({ stdout, stderr }).toEqual({ stdout: "", stderr: "" })
  } else {
    expect(await delegateNativeGit(["--version"], out, err, false)).toBe(0)
    expect(stdout).toMatch(/^git version /u)
    expect(stderr).toBe("")
  }
})

function installGit(body: string): string {
  const root = mkdtempSync(join(tmpdir(), "git-super-library-child-"))
  roots.push(root)
  writeFileSync(join(root, "git"), `#!${process.execPath}\n${body}\n`, { mode: 0o755 })
  vi.stubEnv("PATH", root)
  return root
}

// The existing Bun-only CLI suite cannot execute the library transport on Node.
// Real children witness pipe capacity, async exec failure and process settlement without a test-only port.
test("raw and local library captures preserve their distinct environment and stdin policies", async () => {
  const root = installGit(`
const input = []
for await (const chunk of process.stdin) input.push(Buffer.from(chunk))
process.stdout.write(JSON.stringify({ args: process.argv.slice(2), dir: process.env.GIT_DIR, policy: process.env.GIT_CONFIG_COUNT, locale: process.env.LC_ALL }) + "\\n")
process.stdout.write(Buffer.concat(input))
process.stderr.write(" raw stderr \\n")
`)
  vi.stubEnv("GIT_DIR", "/inherited-pointer")
  vi.stubEnv("GIT_CONFIG_COUNT", "0")
  vi.stubEnv("LC_ALL", "caller-locale")
  const raw = await readNativeGit(["opaque"])
  expect(raw).toEqual({
    code: 0,
    stdout:
      JSON.stringify({ args: ["opaque"], dir: "/inherited-pointer", policy: "0", locale: "caller-locale" }) + "\n",
    stderr: " raw stderr \n",
  })
  const input = "a\u0000λ\n".repeat(32768)
  const local = await createLocalGitProcess().run({ repo: root, args: ["opaque"], stdin: input })
  expect(local).toEqual({
    code: 0,
    stdout: JSON.stringify({ args: ["-C", root, "opaque"], policy: "0", locale: "caller-locale" }) + "\n" + input,
    stderr: "raw stderr",
  })
})

test("an early stdin close cannot replace the Git exit result with EPIPE", async () => {
  const root = installGit('process.stderr.write("native refusal\\n"); process.exit(23)')
  const result = await createLocalGitProcess().run({ repo: root, args: ["opaque"], stdin: "x".repeat(1024 * 1024) })
  expect(result).toEqual({ code: 23, stdout: "", stderr: "native refusal" })
})

test("a signaled native child reports the signal as a failure", async () => {
  const root = installGit('process.kill(process.pid, "SIGTERM")')
  const result = await createLocalGitProcess().run({ repo: root, args: ["opaque"] })
  expect(result.code).not.toBe(0)
  expect(result.signal).toBe("SIGTERM")
  expect(result.failure).toContain("SIGTERM")
})

test("an asynchronous executable launch error settles with a named failure", async () => {
  const root = installGit("")
  writeFileSync(join(root, "git"), "#!/git-super-test-missing-interpreter\n", { mode: 0o755 })
  const result = await createLocalGitProcess().run({ repo: root, args: ["opaque"] })
  expect(result.code).not.toBe(0)
  expect(result.failure).toContain("ENOENT")
})

test("abort before launch refuses and abort during launch settles the real child", async () => {
  const root = installGit(`
import { writeFileSync } from "node:fs"
writeFileSync(process.env.MARKER, String(process.pid))
setInterval(() => {}, 1000)
`)
  const marker = join(root, "started")
  const before = new AbortController()
  before.abort()
  const git = createLocalGitProcess()
  const refused = await git.run({ repo: root, args: ["opaque"], signal: before.signal, env: { MARKER: marker } })
  expect(refused.code).not.toBe(0)
  expect(refused.failure).toMatch(/abort/iu)
  expect(existsSync(marker)).toBe(false)
  const during = new AbortController()
  const running = git.run({
    repo: root,
    args: ["opaque"],
    signal: during.signal,
    timeoutMs: 2000,
    env: { MARKER: marker },
  })
  try {
    const deadline = Date.now() + 1000
    while (!existsSync(marker) && Date.now() < deadline) await delay(5)
    expect(existsSync(marker), "native child did not launch").toBe(true)
  } finally {
    during.abort()
  }
  const stopped = await running
  expect(stopped.code).not.toBe(0)
  expect(stopped.failure).toMatch(/abort|SIGTERM/iu)
})
