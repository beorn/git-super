/**
 * 24907 row 2 (@cto 73a0e53e): from the root merge until every repository is at the target, (a) no signal on either
 * real path stops the apply — SIGTERM to the top pid, or SIGINT to the process group — and (b) the backstop leaves no
 * process of the pull alive, and the next pull proceeds. The root's post-merge hook runs once, after the checkouts.
 */
import { afterEach, describe, expect, test } from "vitest"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { runCli } from "../src/cli.ts"
import { createLocalGitProcess } from "../src/process.ts"
import type { GitSuperResult } from "../src/result.ts"
import { bumpProductSubmodules, canonicalTmpdir as tmpdir, createProductFixture, git } from "./fixture.ts"

const roots: string[] = []
const gitSuperBin = fileURLToPath(new URL("../bin/git-super", import.meta.url))

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

type World = Readonly<{
  checkout: string
  target: string
  /** The submodule commits the target records: what "every repository at the target" means for them. */
  alphaTarget: string
  betaTarget: string
  marks: string
  /** PATH with a `git-super` that `git super` dispatches to: the real executable of this tree. */
  path: string
}>

/** A product checkout one bump behind its upstream, with hooks that record what they saw into `marks`. */
function world(name: string, hooks: Readonly<Record<string, string>>): World {
  const fixtureRoot = mkdtempSync(join(tmpdir(), `git-super-pull-signals-${name}-`))
  roots.push(fixtureRoot)
  const fixture = createProductFixture(fixtureRoot)
  const checkout = join(fixtureRoot, "checkout")
  git(fixtureRoot, "-c", "protocol.file.allow=always", "clone", "-q", "--recurse-submodules", fixture.product, checkout)
  const target = bumpProductSubmodules(fixture)
  const alphaTarget = git(fixture.product, "rev-parse", "HEAD:packages/alpha")
  const betaTarget = git(fixture.product, "rev-parse", "HEAD:vendor/beta")
  const marks = join(fixtureRoot, "marks")
  mkdirSync(marks)
  const hooksDir = join(checkout, ".git", "hooks")
  mkdirSync(hooksDir, { recursive: true })
  for (const [hook, body] of Object.entries(hooks)) {
    const file = join(hooksDir, hook)
    writeFileSync(file, `#!/bin/sh\nMARKS='${marks}'\n${body}\n`)
    chmodSync(file, 0o755)
  }
  const bin = join(fixtureRoot, "bin")
  mkdirSync(bin)
  symlinkSync(gitSuperBin, join(bin, "git-super"))
  return { checkout, target, alphaTarget, betaTarget, marks, path: `${bin}:${process.env["PATH"] ?? ""}` }
}

/** The post-merge hook: one line per run, naming both submodule HEADs as the hook sees them. */
const RECORD_POST_MERGE =
  'echo "$(git -C packages/alpha rev-parse HEAD) $(git -C vendor/beta rev-parse HEAD)" >> "$MARKS/post-merge"'

/**
 * Holds the root merge open: the reference-transaction hook, on the commit of the branch update the merge makes,
 * says so and sleeps, so a signal lands between the root merge and the submodule checkouts.
 */
const HOLD_ROOT_MERGE = [
  "hit=",
  'while read -r old new ref; do [ "$ref" = refs/heads/main ] && hit=1; done',
  'if [ "$1" = committed ] && [ -n "$hit" ]; then echo held >> "$MARKS/root-merge"; sleep 2; fi',
  "exit 0",
].join("\n")

function expectWhole(w: World): void {
  expect(git(w.checkout, "rev-parse", "HEAD")).toBe(w.target)
  expect(git(join(w.checkout, "packages/alpha"), "rev-parse", "HEAD")).toBe(w.alphaTarget)
  expect(git(join(w.checkout, "vendor/beta"), "rev-parse", "HEAD")).toBe(w.betaTarget)
  // Exactly once, and after the checkouts: the hook saw both submodules already at their targets.
  expect(readFileSync(join(w.marks, "post-merge"), "utf8")).toBe(`${w.alphaTarget} ${w.betaTarget}\n`)
}

async function until(condition: () => boolean, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(20)
  }
}

/** `git super pull` as ff-main runs it, in its own process group so the test can signal that group. */
function spawnPull(w: World) {
  return Bun.spawn(["git", "-C", w.checkout, "super", "--json", "pull", "--ff-only", "origin", "main"], {
    env: { ...process.env, PATH: w.path, GIT_SUPER_PROGRESS: "1" },
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  })
}

describe("git super pull: the apply is not stopped by a signal (24907 row 2)", () => {
  test("SIGTERM to the top pid mid-apply: the apply finishes, then the pull exits for it", async () => {
    const w = world("sigterm", { "reference-transaction": HOLD_ROOT_MERGE, "post-merge": RECORD_POST_MERGE })
    const pull = spawnPull(w)
    await until(() => existsSync(join(w.marks, "root-merge")), "the root merge to be held")
    process.kill(pull.pid, "SIGTERM")
    const [stdout, stderr] = await Promise.all([new Response(pull.stdout).text(), new Response(pull.stderr).text()])
    await pull.exited
    expect(stderr).toContain("git-super pull: deferring SIGTERM until the apply completes (phase apply-root)")
    expect(stderr).toContain("git-super pull: the apply is complete; exiting for the deferred SIGTERM")
    expect(JSON.parse(stdout)).toMatchObject({
      state: "updated",
      partial: false,
      deferredSignal: { signal: "SIGTERM", phase: "apply-root" },
    })
    expectWhole(w)
  })

  test("SIGINT to the process group mid-apply (a terminal's Ctrl-C): the apply finishes, then the pull exits", async () => {
    const w = world("sigint", { "reference-transaction": HOLD_ROOT_MERGE, "post-merge": RECORD_POST_MERGE })
    const pull = spawnPull(w)
    await until(() => existsSync(join(w.marks, "root-merge")), "the root merge to be held")
    // The group git, git-super and (without the fix) the apply's own children share.
    process.kill(-pull.pid, "SIGINT")
    const [stdout, stderr] = await Promise.all([new Response(pull.stdout).text(), new Response(pull.stderr).text()])
    await pull.exited
    expect(stderr).toContain("git-super pull: deferring SIGINT until the apply completes (phase apply-root)")
    expect(JSON.parse(stdout)).toMatchObject({ state: "updated", deferredSignal: { signal: "SIGINT" } })
    expectWhole(w)
  })

  test("the backstop kills every process of the pull, a group it knows only from the record included, and the next pull proceeds", async () => {
    // A post-merge hook that never ends: the backstop's case. It runs in its own group (the apply's), so only the
    // record in GIT_SUPER_APPLY_GROUPS lets the backstop reach it.
    const w = world("backstop", {
      "post-merge": `${RECORD_POST_MERGE}\necho $$ > "$MARKS/hook.pid"\nexec sleep 600`,
    })
    const result = await createLocalGitProcess().run({
      repo: w.checkout,
      args: ["super", "--json", "pull", "--ff-only", "origin", "main"],
      env: { PATH: w.path, GIT_SUPER_PROGRESS: "1" },
      timeoutMs: 1_500,
      backstopMs: 4_000,
    })
    expect(result.timedOut).toBe(true)
    // git's own group, then one per apply command: the root merge, each checkout and the hook, all recorded.
    expect(result.backstop).toMatch(
      /^backstop at 4000ms: SIGKILL to process group\(s\) [\d, ]+ \(4 recorded by the command\)$/u,
    )
    const hook = Number(readFileSync(join(w.marks, "hook.pid"), "utf8").trim())
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    await until(() => !alive(hook), "the hung hook to die")
    const groups = [...(result.backstop ?? "").matchAll(/(\d+)(?=[, ]|$)/gu)].map((match) => Number(match[1]))
    for (const group of groups.filter((value) => value > 4000)) {
      const members = Bun.spawnSync(["ps", "-o", "pid=", "-g", String(group)])
        .stdout.toString()
        .trim()
      expect(members, `process group ${String(group)} still has members`).toBe("")
    }
    // The checkouts finished before the hook: every repository is at the target, and the lock is free.
    expect(git(w.checkout, "rev-parse", "HEAD")).toBe(w.target)
    const stdout = {
      output: "",
      write(value: string) {
        this.output += value
      },
    }
    const stderr = {
      output: "",
      write(value: string) {
        this.output += value
      },
    }
    const next = await runCli(["--repo", w.checkout, "pull", "--ff-only", "origin", "main", "--json"], stdout, stderr)
    expect(next, stderr.output).toBe(0)
    expect(JSON.parse(stdout.output)).toMatchObject({ state: "unchanged" })
  })

  test("a failing post-merge hook leaves the pull applied, with a detail that says the hook failed", async () => {
    const w = world("hook-fails", { "post-merge": `${RECORD_POST_MERGE}\necho "deps repair failed" >&2\nexit 1` })
    const stdout = {
      output: "",
      write(value: string) {
        this.output += value
      },
    }
    const stderr = {
      output: "",
      write(value: string) {
        this.output += value
      },
    }
    const code = await runCli(["--repo", w.checkout, "pull", "--ff-only", "origin", "main", "--json"], stdout, stderr)
    expect(code, stderr.output).toBe(0)
    expect(JSON.parse(stdout.output)).toMatchObject({
      state: "updated",
      partial: false,
      detail: { code: "post-merge-hook-failed", phase: "post-merge-hook" },
    })
    expect((JSON.parse(stdout.output) as GitSuperResult).detail?.message).toContain("deps repair failed")
    expectWhole(w)
  })
})
