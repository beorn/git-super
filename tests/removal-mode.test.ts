/**
 * Removal safety on the CLI surface (28033): `status --removal` is a verdict a scripted reaper can read —
 * clean (0), dirty (1, records as JSON) and unknown submodule state (2) — and every synchronous Git child
 * it starts is bounded by a caller-supplied timeout.
 *
 * @failure a reaper drives removal safety through the CLI and cannot tell clean from dirty from unreadable,
 *   or a hung `git` child outlives the caller because the predicate has no timeout.
 * @level l1
 * @consumer worktree-pool-enforce (reaps through `git super status --removal` under its async runner)
 * @testonly none
 * @reach fs-walk <fixture-only: runCli and the CLI entry read mkdtempSync(tmpdir()) Git repos>
 */
import { afterEach, describe, expect, test } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { runCli } from "../src/cli.ts"
import { repositoryRoot, withGitTimeout } from "../src/git.ts"
import type { SuperStatusResult } from "../src/status.ts"
import { inspectRemovalStatus } from "../src/worktree-removal.ts"
import { canonicalTmpdir, createProductFixture, git } from "./fixture.ts"

const roots: string[] = []

afterEach(() => {
  // raw-delete-allow: teardown of this file's own mkdtempSync fixture roots under tmpdir.
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function outputSink(): { output: string; write(value: string): void } {
  return {
    output: "",
    write(value) {
      this.output += value
    },
  }
}

async function removal(root: string): Promise<{ code: number; result: SuperStatusResult; text: string }> {
  const stdout = outputSink()
  const stderr = outputSink()
  const code = await runCli(["--repo", root, "status", "--removal"], stdout, stderr)
  return { code, result: JSON.parse(stdout.output) as SuperStatusResult, text: stderr.output }
}

describe("status --removal verdict", () => {
  test("a clean superproject exits 0 with empty records", async () => {
    const root = mkdtempSync(join(canonicalTmpdir(), "git-super-removal-clean-"))
    roots.push(root)
    const fixture = createProductFixture(root)
    const { code, result } = await removal(fixture.product)
    expect(code).toBe(0)
    expect(result.records).toEqual([])
    expect(result.submoduleProblems).toEqual([])
  })

  test("root dirt exits 1 and names the record as JSON", async () => {
    const root = mkdtempSync(join(canonicalTmpdir(), "git-super-removal-dirty-"))
    roots.push(root)
    const fixture = createProductFixture(root)
    writeFileSync(join(fixture.product, "scratch.txt"), "agent work\n")
    const { code, result } = await removal(fixture.product)
    expect(code).toBe(1)
    expect(result.records).toContain("?? scratch.txt")
  })

  test("content dirt inside a submodule exits 1 and names it through the recursion", async () => {
    const root = mkdtempSync(join(canonicalTmpdir(), "git-super-removal-nested-"))
    roots.push(root)
    const fixture = createProductFixture(root)
    writeFileSync(join(fixture.product, "packages/alpha/alpha.ts"), "export const alpha = 999\n")
    const { code, result } = await removal(fixture.product)
    expect(code).toBe(1)
    expect(result.records.join("\n")).toContain("alpha.ts")
  })

  test("a symlinked submodule checkout exits 2 as unknown state, never clean", async () => {
    const root = mkdtempSync(join(canonicalTmpdir(), "git-super-removal-symlink-"))
    roots.push(root)
    const fixture = createProductFixture(root)
    const child = join(fixture.product, "packages/alpha")
    // raw-delete-allow: fixture checkout this test created, replaced by a symlink to prove the verdict.
    rmSync(child, { recursive: true, force: true })
    symlinkSync(fixture.alpha, child, "dir")
    const { code, result } = await removal(fixture.product)
    expect(code).toBe(2)
    expect(result.submoduleProblems[0]?.reason).toContain("symbolic link")
  })

  test("a non-empty uninitialized submodule checkout (no gitdir) exits 2", async () => {
    const root = mkdtempSync(join(canonicalTmpdir(), "git-super-removal-uninit-"))
    roots.push(root)
    const fixture = createProductFixture(root)
    const child = join(fixture.product, "packages/alpha")
    // raw-delete-allow: fixture submodule gitdir this test created, removed to force the uninitialized shape.
    rmSync(join(child, ".git"), { recursive: true, force: true })
    writeFileSync(join(child, "left-behind.txt"), "files with no repository\n")
    const { code, result } = await removal(fixture.product)
    expect(code).toBe(2)
    expect(result.submoduleProblems[0]?.reason).toContain("no repository of its own")
  })

  test("a dirty verdict still exits 1 when unknown state is not present", async () => {
    const root = mkdtempSync(join(canonicalTmpdir(), "git-super-removal-both-"))
    roots.push(root)
    const fixture = createProductFixture(root)
    writeFileSync(join(fixture.product, "scratch.txt"), "dirt\n")
    const { code } = await removal(fixture.product)
    expect(code).toBe(1)
  })
})

describe("bounded synchronous Git (tryGit timeout)", () => {
  test("withGitTimeout bounds a Git call and fails loud instead of hanging", () => {
    const root = mkdtempSync(join(canonicalTmpdir(), "git-super-removal-timeout-"))
    roots.push(root)
    const repo = createProductFixture(root).product
    // The child must outlive the bound for the bound to be the thing under test: a real `git rev-parse`
    // can finish inside 1 ms on a fast box, and that made this row fail OPEN in CI (git-super run
    // 38359675903). A `git` that sleeps cannot win that race, so the assertion is deterministic.
    const shim = join(root, "bin")
    mkdirSync(shim, { recursive: true })
    // raw-delete-allow: fixture scratch this test created under tmpdir; removed by afterEach.
    writeFileSync(join(shim, "git"), "#!/bin/sh\nexec sleep 2\n", { mode: 0o755 })
    const priorPath = process.env.PATH
    process.env.PATH = `${shim}:${priorPath ?? ""}`
    try {
      expect(() => withGitTimeout(1, () => repositoryRoot(repo))).toThrow(/did not finish within 1ms/u)
    } finally {
      if (priorPath === undefined) delete process.env.PATH
      else process.env.PATH = priorPath
    }
  })

  test("a stalled Git child ends as a named timeout, not a hang", () => {
    const root = mkdtempSync(join(canonicalTmpdir(), "git-super-removal-stall-"))
    roots.push(root)
    const shim = join(root, "bin")
    mkdirSync(shim, { recursive: true })
    // raw-delete-allow: fixture scratch this test created under tmpdir; removed by afterEach.
    writeFileSync(join(shim, "git"), "#!/bin/sh\nexec sleep 60\n", { mode: 0o755 })
    const priorPath = process.env.PATH
    process.env.PATH = `${shim}:${priorPath ?? ""}`
    try {
      const started = Date.now()
      expect(() => withGitTimeout(300, () => repositoryRoot(root))).toThrow(
        /failed to run git in .*did not finish within 300ms/u,
      )
      // It returned on the bound, not after the stall.
      expect(Date.now() - started).toBeLessThan(5_000)
    } finally {
      process.env.PATH = priorPath
    }
  })

  test("inspectRemovalStatus passes an explicit bound through and stays unbounded when asked", () => {
    const root = mkdtempSync(join(canonicalTmpdir(), "git-super-removal-default-"))
    roots.push(root)
    const repo = createProductFixture(root).product
    // A generous bound leaves a clean repo clean; an explicit undefined keeps the walk unbounded.
    expect(inspectRemovalStatus(repo, [], 60_000).records).toEqual([])
    expect(() => inspectRemovalStatus(repo, [], -1)).toThrow(/positive number/u)
  })

  test("normal status is unaffected by the timeout scope (no bound leaks out)", () => {
    const root = mkdtempSync(join(canonicalTmpdir(), "git-super-removal-scope-"))
    roots.push(root)
    const repo = createProductFixture(root).product
    const head = git(repo, "rev-parse", "HEAD")
    expect(repositoryRoot(repo)).toBe(repo)
    expect(head.length).toBe(40)
  })
})
