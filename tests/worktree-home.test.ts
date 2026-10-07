/**
 * @failure worktree homes multiplied because each caller hardcoded its own,
 *          and the pool path came from two readers that could disagree.
 * @level   l1
 * @consumer src/worktree-add.ts — every worktree path composition
 * @bead    @i/4-supervision/24306, @i/26-environments/worktree-create-and-in
 *
 * Operator 2026-09-11: one home, `/hh/var/wt/`, flat at the item level.
 * @cto 2026-10-07 (ebf2cc43 / 0590fb81): ONE declaration chain —
 * repo `worktree.poolRoot` > `HH_WORKTREE_HOME` > `DEFAULT_WORKTREE_HOME` —
 * read from the repo's COMMON config, with a relative value resolved against
 * the MAIN worktree root. Callers stop composing a home and start asking for
 * one; nothing reaches the live default in a test.
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import { DEFAULT_WORKTREE_HOME, POOL_ROOT_CONFIG_KEY, WORKTREE_HOME_ENV, worktreeHomeRoot } from "git-super"

const scratch: string[] = []

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args as string[], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "git-super-home-"))
  scratch.push(dir)
  return dir
}

function makeRepo(): string {
  const dir = makeDir()
  git(dir, ["init", "-q", "-b", "main"])
  git(dir, ["config", "user.email", "t@example.test"])
  git(dir, ["config", "user.name", "t"])
  writeFileSync(join(dir, "seed.txt"), "seed\n")
  git(dir, ["add", "seed.txt"])
  git(dir, ["commit", "-qm", "seed"])
  return dir
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("worktreeHomeRoot — one declaration, one chain (24306 / P1 pool-path)", () => {
  test("an undeclared repo with no env resolves to the ruled default", () => {
    expect(worktreeHomeRoot({ repo: makeRepo(), env: {} })).toBe(DEFAULT_WORKTREE_HOME)
    expect(DEFAULT_WORKTREE_HOME).toBe("/hh/var/wt")
  })

  test("a caller without a repo refuses — there is no default reached without one", () => {
    // @ts-expect-error — omitting the repo is a type error and a runtime refusal
    expect(() => worktreeHomeRoot({})).toThrow(/requires the repo/)
    expect(() => worktreeHomeRoot({ repo: "" })).toThrow(/requires the repo/)
  })

  test("an absolute env override wins over the default, so tests never write into the live home", () => {
    expect(worktreeHomeRoot({ repo: makeRepo(), env: { [WORKTREE_HOME_ENV]: "/tmp/wt-home" } })).toBe("/tmp/wt-home")
  })

  test("an empty env override falls through rather than becoming a relative home", () => {
    expect(worktreeHomeRoot({ repo: makeRepo(), env: { [WORKTREE_HOME_ENV]: "" } })).toBe(DEFAULT_WORKTREE_HOME)
  })

  test("a relative env override is refused: a home that depends on cwd is another home", () => {
    expect(() => worktreeHomeRoot({ repo: makeRepo(), env: { [WORKTREE_HOME_ENV]: "wt" } })).toThrow(WORKTREE_HOME_ENV)
    expect(() => worktreeHomeRoot({ repo: makeRepo(), env: { [WORKTREE_HOME_ENV]: "wt" } })).toThrow("absolute")
  })

  test("a path with no .git entry has no declaration, so it falls to the next tier", () => {
    expect(worktreeHomeRoot({ repo: "/no/such/repo/anywhere", env: { [WORKTREE_HOME_ENV]: "/tmp/wt-home" } })).toBe(
      "/tmp/wt-home",
    )
    expect(worktreeHomeRoot({ repo: "/no/such/repo/anywhere", env: {} })).toBe(DEFAULT_WORKTREE_HOME)
  })

  test("the repo declaration beats the env override", () => {
    const repo = makeRepo()
    git(repo, ["config", POOL_ROOT_CONFIG_KEY, "/tmp/pool-declared"])
    expect(worktreeHomeRoot({ repo, env: { [WORKTREE_HOME_ENV]: "/tmp/wt-env" } })).toBe("/tmp/pool-declared")
  })

  test("a relative declaration resolves against the MAIN worktree root", () => {
    const repo = makeRepo()
    git(repo, ["config", POOL_ROOT_CONFIG_KEY, ".worktrees"])
    expect(worktreeHomeRoot({ repo, env: {} })).toBe(join(repo, ".worktrees"))
  })

  test("a set-but-empty declaration is a loud error, never a silent fall to another tier", () => {
    const repo = makeRepo()
    git(repo, ["config", POOL_ROOT_CONFIG_KEY, ""])
    expect(() => worktreeHomeRoot({ repo, env: {} })).toThrow(/worktree\.poolRoot is set but empty/)
    expect(() => worktreeHomeRoot({ repo, env: { [WORKTREE_HOME_ENV]: "/tmp/wt-env" } })).toThrow(
      /worktree\.poolRoot is set but empty/,
    )
  })

  test("a relative declaration is refused where the common dir is not <root>/.git (row v: submodule)", () => {
    const superRepo = makeRepo()
    const child = makeRepo()
    git(superRepo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", child, "sub"])
    const sub = join(superRepo, "sub")

    git(sub, ["config", POOL_ROOT_CONFIG_KEY, ".worktrees"])
    expect(() => worktreeHomeRoot({ repo: sub, env: {} })).toThrow(/absolute/)

    git(sub, ["config", POOL_ROOT_CONFIG_KEY, "/tmp/pool-absolute"])
    expect(worktreeHomeRoot({ repo: sub, env: {} })).toBe("/tmp/pool-absolute")
  })
})

describe("the declaration is read from the COMMON config, never a linked worktree's (row iii/iv)", () => {
  test("a --worktree poolRoot does not shadow the common declaration, and a relative value resolves against the main root", () => {
    const repo = makeRepo()
    git(repo, ["config", POOL_ROOT_CONFIG_KEY, ".worktrees"])
    git(repo, ["config", "extensions.worktreeConfig", "true"])
    const linked = join(makeDir(), "linked")
    git(repo, ["worktree", "add", "-q", linked, "-b", "linked"])
    git(linked, ["config", "--worktree", POOL_ROOT_CONFIG_KEY, "/tmp/shadow-pool"])

    expect(worktreeHomeRoot({ repo: linked, env: {} })).toBe(join(repo, ".worktrees"))
    expect(worktreeHomeRoot({ repo, env: {} })).toBe(join(repo, ".worktrees"))
  })

  test("under the pinned test env, an undeclared temp repo never resolves under /hh/var/wt", () => {
    // The root globalSetup pins HH_WORKTREE_HOME to the run's temp root, so a
    // reader can never reach the live default. This is the leak guard; a
    // standalone run without the pin gets the same guarantee from a local pin.
    const pinned = process.env[WORKTREE_HOME_ENV]
    const isolated = pinned ?? makeDir()
    if (pinned === undefined) process.env[WORKTREE_HOME_ENV] = isolated
    try {
      expect(worktreeHomeRoot({ repo: makeRepo() })).toBe(isolated)
      expect(worktreeHomeRoot({ repo: makeRepo() })).not.toBe(DEFAULT_WORKTREE_HOME)
    } finally {
      if (pinned === undefined) delete process.env[WORKTREE_HOME_ENV]
    }
  })
})
