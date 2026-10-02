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
import { superPull, superPush } from "../src/index.ts"
import { acquireExclusive } from "../src/exclusive.ts"
import { createLocalGitWorktreeStore } from "../src/worktree.ts"
import { advanceRepository, bumpProductSubmodules, canonicalTmpdir, createProductFixture, git } from "./fixture.ts"

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

// A rev-parse probe cannot establish the library's mutation graph or the real flock adapter.
test("library pulls real submodules, refuses a stale push lease and creates a worktree after lock contention", async () => {
  const root = mkdtempSync(join(canonicalTmpdir(), "git-super-library-graph-"))
  roots.push(root)
  const fixture = createProductFixture(root)
  const remote = join(root, "remote.git")
  git(root, "clone", "--bare", fixture.product, remote)
  const checkout = join(root, "checkout")
  git(root, "-c", "protocol.file.allow=always", "clone", "--recurse-submodules", remote, checkout)
  const base = git(checkout, "rev-parse", "HEAD")
  const target = bumpProductSubmodules(fixture)
  git(fixture.product, "push", remote, "main:main")
  const pulled = await superPull({ repo: checkout, repository: "origin", refspecs: ["main"], ffOnly: true })
  expect(pulled.state, JSON.stringify(pulled)).toBe("updated")
  expect(git(checkout, "rev-parse", "HEAD")).toBe(target)
  expect(git(join(checkout, "packages/alpha"), "rev-parse", "HEAD")).toBe(git(fixture.alpha, "rev-parse", "HEAD"))
  const wanted = advanceRepository(checkout, "local.txt", "local\n")
  const rejected = await superPush({
    repo: checkout,
    remote: "origin",
    refspecs: ["HEAD:refs/heads/main"],
    recurseSubmodules: "check",
    forceWithLease: [`refs/heads/main:${base}`],
  })
  expect(rejected.state, JSON.stringify(rejected)).toBe("failed")
  expect(git(remote, "rev-parse", "main")).toBe(target)
  const common = git(checkout, "rev-parse", "--path-format=absolute", "--git-common-dir")
  const holder = await acquireExclusive(join(common, "yrd-worktree-mutations"), { timeoutMs: 0 }, "test holder")
  const reports: string[] = []
  const store = createLocalGitWorktreeStore({ repo: checkout, report: (line) => reports.push(line) })
  const linked = join(root, "linked")
  const adding = store.add({ kind: "detached", path: linked, ref: "HEAD" }).then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  )
  try {
    const deadline = Date.now() + 1000
    while (!reports.join("").includes("test holder") && Date.now() < deadline) await delay(5)
    expect(reports.join(""), "worktree did not reach the contended real flock").toContain("test holder")
  } finally {
    holder.release()
  }
  const added = await adding
  if (!added.ok) throw added.error
  expect(git(linked, "rev-parse", "HEAD")).toBe(wanted)
  expect(git(checkout, "worktree", "list", "--porcelain")).toContain(linked)
}, 15000)
