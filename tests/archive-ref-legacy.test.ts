/**
 * @reach fs-walk <fixture-only: builds one mkdtempSync(tmpdir()) Git repo with archive refs>
 */
import { afterEach, describe, expect, test } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import * as archive from "../src/archive-ref.ts"
import { createLocalGitWorktreeStore } from "../src/worktree.ts"
import { canonicalTmpdir, createRepository, git } from "./fixture.ts"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function repositoryWithArchiveRefs(refs: readonly string[]): { repo: string; base: string } {
  const root = mkdtempSync(join(canonicalTmpdir(), "git-super-archive-legacy-"))
  roots.push(root)
  const repo = join(root, "product")
  const base = createRepository(repo, "readme.md", "base\n")
  for (const ref of refs) git(repo, "update-ref", ref, base)
  return { repo, base }
}

describe("archive custody names", () => {
  /**
   * @failure A store carrying one legacy archive name made readArchiveRows throw for the WHOLE store,
   *          so every branch retirement in it refused even for unrelated branches (30263). The four
   *          shapes measured in the estate: a dated ref whose actor carries @, an undated actor/branch,
   *          a bundles custody ref, and a preserve custody ref.
   * @level l1 (a real Git repo holding all four archive shapes)
   * @consumer every yrd drop and branch retirement in a store with legacy custody
   * @testonly none
   */
  test("reads legacy custody shapes instead of refusing the whole store", () => {
    const { repo, base } = repositoryWithArchiveRefs([
      "refs/archive/2026-10-19/dev-brain/task/30263",
      "refs/archive/2026-10-09/@dev/13/vendor_yrd-cto-s7-int",
      "refs/archive/luna1/30158",
      "refs/archive/bundles/2026-10-14/task_dev9-x__dev-wt9_vendor_git-super.bundle/1",
      "refs/archive/preserve-mac-cleanup-ci-22530-54db-20260801-20260926/eb38fa44fa",
    ])

    const rows = archive.readArchiveRows(repo)

    const branchOf = (ref: string) => rows.find((row) => row.ref === ref)?.branch
    expect(branchOf("refs/archive/2026-10-19/dev-brain/task/30263")).toBe("task/30263")
    // A seat-qualified actor cannot say where the actor ends, so it is evidence, not branch custody.
    expect(branchOf("refs/archive/2026-10-09/@dev/13/vendor_yrd-cto-s7-int")).toBeUndefined()
    // Pre-dated custody is ambiguous about its actor in the same way.
    expect(branchOf("refs/archive/luna1/30158")).toBeUndefined()
    // Bundle and preservation custody are evidence, but never branch custody.
    expect(branchOf("refs/archive/bundles/2026-10-14/task_dev9-x__dev-wt9_vendor_git-super.bundle/1")).toBeUndefined()
    expect(branchOf("refs/archive/preserve-mac-cleanup-ci-22530-54db-20260801-20260926/eb38fa44fa")).toBeUndefined()
    // Exactly one row claims the branch, so custody matching cannot become ambiguous.
    expect(rows.filter((row) => row.branch === "task/30263")).toHaveLength(1)
    expect(archive.findArchiveRefFor(repo, "task/30263", base)).toBe("refs/archive/2026-10-19/dev-brain/task/30263")
  })

  /**
   * @failure The relaxed parser must not become a silent one: a name matching no known shape is still
   *          corruption and must name itself, not be skipped (30263 keeps 28577's invariant).
   * @level l1 (a real Git repo with one unclassifiable archive ref)
   * @consumer every custody read, so a broken archive is visible rather than ignored
   * @testonly none
   */
  test("still refuses a name that matches no known shape", () => {
    const { repo } = repositoryWithArchiveRefs(["refs/archive/unknown"])

    expect(() => archive.readArchiveRows(repo)).toThrow(/malformed archive name refs\/archive\/unknown/u)
  })

  /**
   * @failure Chief's GO on 30263: the fix is only real if a branch retirement still runs beside an
   *          unrelated legacy ref. The read must not refuse the store, and the retire must delete the
   *          branch while keeping the archive and the legacy evidence.
   * @level l1 (a real store removeBranch + findArchiveRefFor over a repo holding an unrelated legacy ref)
   * @consumer every caller retiring a branch in a store that carries legacy custody
   * @testonly none
   */
  test("retires a branch beside an unrelated legacy ref", async () => {
    const { repo, base } = repositoryWithArchiveRefs(["refs/archive/luna1/30158"])
    git(repo, "checkout", "-q", "-b", "task/30263")
    writeFileSync(join(repo, "work.ts"), "unique work\n")
    git(repo, "add", "work.ts")
    git(repo, "commit", "-q", "-m", "unique work on task/30263")
    const tip = git(repo, "rev-parse", "HEAD")
    const archiveRef = "refs/archive/2026-10-19/dev-brain/task/30263"
    git(repo, "update-ref", archiveRef, tip)
    git(repo, "checkout", "-q", "main")

    expect(archive.findArchiveRefFor(repo, "task/30263", tip)).toBe(archiveRef)
    await createLocalGitWorktreeStore({ repo }).removeBranch({
      branch: "task/30263",
      tip,
      verify: { ref: archiveRef, oid: tip },
    })

    expect(git(repo, "for-each-ref", "--format=%(refname)", "refs/heads/task/30263")).toBe("")
    expect(git(repo, "rev-parse", "--verify", archiveRef)).toBe(tip)
    // The unrelated legacy evidence is untouched.
    expect(git(repo, "rev-parse", "--verify", "refs/archive/luna1/30158")).toBe(base)
  })
})
