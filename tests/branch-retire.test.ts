/**
 * @reach fs-walk <fixture-only: runCli and CLI entry read mkdtempSync(tmpdir()) Git repos>
 */
import { afterEach, describe, expect, test } from "vitest"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { runCli } from "../src/cli.ts"
import { canonicalTmpdir, createRepository, git } from "./fixture.ts"

const roots: string[] = []

afterEach(() => {
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

type Fixture = Readonly<{
  repo: string
  base: string
  tip: string
  archiveRef: string
}>

/** A repository with `task/28989` carrying one unique commit, and an archive ref at the requested custody. */
function retireFixture(custody: "matching" | "mismatched" | "absent"): Fixture {
  const root = mkdtempSync(join(canonicalTmpdir(), "git-super-branch-retire-"))
  roots.push(root)
  const repo = join(root, "product")
  const base = createRepository(repo, "readme.md", "base\n")
  git(repo, "checkout", "-q", "-b", "task/28989")
  writeFileSync(join(repo, "work.ts"), "unique work\n")
  git(repo, "add", "work.ts")
  git(repo, "commit", "-q", "-m", "unique work on task/28989")
  const tip = git(repo, "rev-parse", "HEAD")
  const archiveRef = "refs/archive/2026-10-13/dev-brain/task/28989"
  if (custody === "matching") git(repo, "update-ref", archiveRef, tip)
  else if (custody === "mismatched") git(repo, "update-ref", archiveRef, base)
  git(repo, "checkout", "-q", "main")
  return { repo, base, tip, archiveRef }
}

function headOf(repo: string, ref: string): string {
  return git(repo, "for-each-ref", "--format=%(refname)", ref)
}

describe("branch retire", () => {
  /**
   * @failure A sweep cannot retire an archived branch with a unique commit: `branch -d` refuses and `-D` is banned (#28989).
   * @level l1
   * @consumer /pm-wip-sweep step 5 and every seat's archived-branch cleanup through `git super branch retire`
   * @testonly none
   */
  test("retires a branch whose archive ref reads back its exact tip, and keeps the archive", async () => {
    const fixture = retireFixture("matching")
    const stdout = outputSink()
    const stderr = outputSink()

    const code = await runCli(
      ["--repo", fixture.repo, "branch", "retire", "task/28989", "--tip", fixture.tip, "--archive", fixture.archiveRef],
      stdout,
      stderr,
    )

    expect(code, stderr.output).toBe(0)
    // The receipt names branch, tip, archive ref and time - the four facts the sweep records.
    expect(stdout.output).toContain(`retired task/28989 ${fixture.tip} ${fixture.archiveRef}`)
    // refs/heads is gone; the archive ref still reads back the tip (never deleted).
    expect(headOf(fixture.repo, "refs/heads/task/28989")).toBe("")
    expect(git(fixture.repo, "rev-parse", "--verify", fixture.archiveRef)).toBe(fixture.tip)
  })

  /**
   * @failure An unarchived branch must never be deleted: the archive is the evidence, never assumed (#28989).
   * @level l1
   * @consumer /pm-wip-sweep step 5
   * @testonly none
   */
  test("refuses an unarchived branch, naming the archive ref it expected", async () => {
    const fixture = retireFixture("absent")
    const stdout = outputSink()
    const stderr = outputSink()

    const code = await runCli(
      ["--repo", fixture.repo, "branch", "retire", "task/28989", "--tip", fixture.tip, "--archive", fixture.archiveRef],
      stdout,
      stderr,
    )

    expect(code).toBe(2)
    expect(stderr.output).toContain(fixture.archiveRef)
    expect(stderr.output).toContain("no archive ref")
    expect(headOf(fixture.repo, "refs/heads/task/28989")).toBe("refs/heads/task/28989")
    expect(existsSync(join(fixture.repo, ".git"))).toBe(true)
  })

  /**
   * @failure A mismatched archive must refuse loudly rather than delete the branch (#28989).
   * @level l1
   * @consumer /pm-wip-sweep step 5
   * @testonly none
   */
  test("refuses a mismatched archive ref, naming both oids, and leaves it untouched", async () => {
    const fixture = retireFixture("mismatched")
    const stdout = outputSink()
    const stderr = outputSink()

    const code = await runCli(
      ["--repo", fixture.repo, "branch", "retire", "task/28989", "--tip", fixture.tip, "--archive", fixture.archiveRef],
      stdout,
      stderr,
    )

    expect(code).toBe(2)
    expect(stderr.output).toContain(fixture.archiveRef)
    expect(stderr.output).toContain(fixture.tip)
    expect(stderr.output).toContain(fixture.base)
    // Nothing was deleted: the branch remains and the archive ref still holds its mismatched oid.
    expect(headOf(fixture.repo, "refs/heads/task/28989")).toBe("refs/heads/task/28989")
    expect(git(fixture.repo, "rev-parse", "--verify", fixture.archiveRef)).toBe(fixture.base)
  })

  /**
   * @failure A branch that advanced past its archived tip must be KEPT: that refusal protects unique work (#28989).
   * @level l1
   * @consumer /pm-wip-sweep step 5 — the advanced branch is the case that must never be deleted
   * @testonly none
   */
  test("refuses a branch that has advanced past its archived tip, naming both oids", async () => {
    const fixture = retireFixture("matching")
    // Advance the branch one commit past the archived tip.
    git(fixture.repo, "checkout", "-q", "task/28989")
    writeFileSync(join(fixture.repo, "more.ts"), "more work\n")
    git(fixture.repo, "add", "more.ts")
    git(fixture.repo, "commit", "-q", "-m", "advance past the archive")
    const advanced = git(fixture.repo, "rev-parse", "HEAD")
    git(fixture.repo, "checkout", "-q", "main")
    const stdout = outputSink()
    const stderr = outputSink()

    const code = await runCli(
      ["--repo", fixture.repo, "branch", "retire", "task/28989", "--tip", fixture.tip, "--archive", fixture.archiveRef],
      stdout,
      stderr,
    )

    expect(code).toBe(2)
    // Both oids are named: the requested (archived) tip and the branch's actual head.
    expect(stderr.output).toContain(fixture.tip)
    expect(stderr.output).toContain(advanced)
    // Neither the branch nor the archive moved.
    expect(git(fixture.repo, "rev-parse", "--verify", "refs/heads/task/28989")).toBe(advanced)
    expect(git(fixture.repo, "rev-parse", "--verify", fixture.archiveRef)).toBe(fixture.tip)
  })

  /**
   * @failure --dry-run must list the retirement without writing (#28989).
   * @level l1
   * @consumer /pm-wip-sweep step 5 (planning a retire before applying it)
   * @testonly none
   */
  test("--dry-run lists the retirement and writes nothing", async () => {
    const fixture = retireFixture("matching")
    const stdout = outputSink()
    const stderr = outputSink()

    const code = await runCli(
      [
        "--repo",
        fixture.repo,
        "branch",
        "retire",
        "task/28989",
        "--tip",
        fixture.tip,
        "--archive",
        fixture.archiveRef,
        "--dry-run",
      ],
      stdout,
      stderr,
    )

    expect(code, stderr.output).toBe(0)
    expect(stdout.output).toContain(`would-retire task/28989 ${fixture.tip} ${fixture.archiveRef}`)
    expect(headOf(fixture.repo, "refs/heads/task/28989")).toBe("refs/heads/task/28989")
  })

  /**
   * @failure A branch a worktree still holds must be refused, not deleted out from under it (#28989).
   * @level l1
   * @consumer /pm-wip-sweep step 5 and git-super's one worktree-hold predicate
   * @testonly none
   */
  test("refuses a branch checked out in a worktree", async () => {
    const fixture = retireFixture("matching")
    const linked = join(fixture.repo, "..", "linked")
    git(fixture.repo, "worktree", "add", "-q", linked, "task/28989")
    const stdout = outputSink()
    const stderr = outputSink()

    const code = await runCli(
      ["--repo", fixture.repo, "branch", "retire", "task/28989", "--tip", fixture.tip, "--archive", fixture.archiveRef],
      stdout,
      stderr,
    )

    expect(code).toBe(2)
    expect(stderr.output).toContain("checked out at")
    expect(headOf(fixture.repo, "refs/heads/task/28989")).toBe("refs/heads/task/28989")
  })

  /**
   * @failure The canonical archive path must be reachable without hand-building the ref (#28989).
   * @level l1
   * @consumer /pm-wip-sweep step 5
   * @testonly none
   */
  test("resolves the canonical archive ref from --actor and --date", async () => {
    const fixture = retireFixture("matching")
    const stdout = outputSink()
    const stderr = outputSink()

    const code = await runCli(
      [
        "--repo",
        fixture.repo,
        "branch",
        "retire",
        "task/28989",
        "--tip",
        fixture.tip,
        "--actor",
        "@dev/brain",
        "--date",
        "2026-10-13",
      ],
      stdout,
      stderr,
    )

    expect(code, stderr.output).toBe(0)
    expect(stdout.output).toContain(fixture.archiveRef)
    expect(headOf(fixture.repo, "refs/heads/task/28989")).toBe("")
  })
})
