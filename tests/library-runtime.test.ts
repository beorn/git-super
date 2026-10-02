/**
 * @failure Library consumers lose Git resolution, mutation/lock behavior, or detached-process cleanup across runtimes.
 * @level l2
 * @consumer Git-super library users on Node and Bun.
 * @testonly none
 * process.test.ts owns the Bun CLI/fd3 lifecycle; its Bun launch helpers cannot run under Node.
 */
import { afterEach, expect, test, vi } from "vitest"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { setTimeout as delay } from "node:timers/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
import {
  APPLY_GROUPS_ENV,
  createLocalGitProcess,
  delegateNativeGit,
  nativeGitExecutable,
  readNativeGit,
} from "../src/process.ts"
import { superPull, superPush } from "../src/index.ts"
import { acquireExclusive } from "../src/exclusive.ts"
import { createLocalGitWorktreeStore } from "../src/worktree.ts"
import { advanceRepository, bumpProductSubmodules, canonicalTmpdir, createProductFixture, git } from "./fixture.ts"

const roots: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// The CLI's static imports can fail before delegateNativeGit's library-level refusal.
test("the executable names its Bun requirement before loading CLI dependencies on Node", () => {
  const child = spawnSync(process.execPath, [join(import.meta.dirname, "../bin/git-super"), "--version"], {
    encoding: "utf8",
  })
  if (typeof Bun === "undefined") {
    expect(child.status).toBe(2)
    expect(child.stdout).toBe("")
    expect(child.stderr).toBe("git-super: Bun CLI requires Bun >=1.3.14\n")
  } else {
    expect(child.status).toBe(0)
    expect(child.stdout).toMatch(/git version/u)
  }
})

/**
 * The first `node` on PATH that is really Node. `bunx --bun` puts a `node` that runs Bun first on PATH, so a bare
 * `node` there proves nothing about Node; each candidate is asked whether `Bun` is defined.
 */
function realNode(): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(dir, "node")
    if (dir === "" || !existsSync(candidate)) continue
    const probe = spawnSync(candidate, ["-e", "process.stdout.write(typeof Bun)"], { encoding: "utf8" })
    if (probe.status === 0 && probe.stdout === "undefined") return candidate
  }
  return undefined
}

// 27074 (@cto 240b6f1e): the bin is declared Bun-only for release verification, so its refusal under Node must stay
// loud and name the cure whatever runtime runs this suite.
test("under Node the executable exits 2 and names its Bun requirement", () => {
  const node = realNode()
  expect(node, `a real Node (not Bun's node shim) is required on PATH=${process.env.PATH}`).toBeDefined()
  const child = spawnSync(node!, [join(import.meta.dirname, "../bin/git-super"), "--help"], { encoding: "utf8" })
  expect(child.error).toBeUndefined()
  expect(child.status).toBe(2)
  expect(child.stdout).toBe("")
  expect(child.stderr).toBe("git-super: Bun CLI requires Bun >=1.3.14\n")
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

// Bun's pull/CLI suite cannot witness Node's detached spawn or the library's group-record ownership.
test("detached library commands establish and record their actual process group", async () => {
  const root = installGit(`
import { execFileSync } from "node:child_process"
const group = Number(execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim())
process.stdout.write(JSON.stringify({ pid: process.pid, group }))
`)
  const record = join(root, "caller-groups")
  vi.stubEnv(APPLY_GROUPS_ENV, record)
  const result = await createLocalGitProcess().run({ repo: root, args: ["opaque"], detached: true, timeoutMs: 2000 })
  expect(result.code, JSON.stringify(result)).toBe(0)
  const child = JSON.parse(result.stdout) as { pid: number; group: number }
  expect(child.pid).toBeGreaterThan(1)
  expect(child.group).toBe(child.pid)
  expect(readFileSync(record, "utf8")).toBe(`${child.pid}\n`)
})

// A leader can exit on SIGTERM while an escaped descendant keeps its output pipes open.
// The backstop must survive that exit, read the descendant record, and finish draining under either runtime.
test("library backstop kills a recorded escaped group after the leader exits and removes its record", async () => {
  const root = installGit(`
import { appendFileSync, writeFileSync } from "node:fs"
import { spawn } from "node:child_process"
import { join } from "node:path"
const root = process.argv[3]
process.on("SIGTERM", () => { process.stdout.write("leader terminated\\n"); process.exit(0) })
const escaped = spawn(process.execPath, [join(root, "escaped.js")], { detached: true, stdio: "inherit" })
appendFileSync(process.env.GIT_SUPER_APPLY_GROUPS, String(escaped.pid) + "\\n")
writeFileSync(join(root, "children.json"), JSON.stringify({ leader: process.pid, escaped: escaped.pid, record: process.env.GIT_SUPER_APPLY_GROUPS }))
// Bound fixture lifetime even if the implementation regresses and never fires its backstop.
setTimeout(() => process.exit(99), 9000)
setInterval(() => {}, 600000)
`)
  writeFileSync(
    join(root, "escaped.js"),
    'process.stdout.write("escaped ready\\n"); setTimeout(() => process.exit(99), 9000); setInterval(() => {}, 600000)\n',
  )
  const result = await createLocalGitProcess().run({
    repo: root,
    args: [root],
    timeoutMs: 1500,
    backstopMs: 3000,
  })
  const children = JSON.parse(readFileSync(join(root, "children.json"), "utf8")) as {
    leader: number
    escaped: number
    record: string
  }
  try {
    expect(result.code, JSON.stringify(result)).toBe(0)
    expect(result.stdout).toContain("escaped ready\n")
    expect(result.stdout).toContain("leader terminated\n")
    expect(result.timedOut).toBe(true)
    expect(result.backstop).toBe(
      `backstop at 3000ms: SIGKILL to process group(s) ${children.leader}, ${children.escaped} (1 recorded by the command)`,
    )
    expect(existsSync(children.record)).toBe(false)
    // ps rather than a mocked kill report proves every named group has no remaining members.
    await vi.waitFor(
      () => {
        for (const group of [children.leader, children.escaped]) {
          const members = spawnSync("/bin/ps", ["-o", "pid=", "-g", String(group)], { encoding: "utf8" })
          if (members.error) throw members.error
          expect([0, 1]).toContain(members.status)
          expect(members.stdout.trim()).toBe("")
        }
      },
      { timeout: 5000, interval: 20 },
    )
  } finally {
    for (const group of [children.leader, children.escaped]) {
      try {
        process.kill(-group, "SIGKILL")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
      }
    }
  }
}, 12000)

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
