/**
 * #31029 — dropping a local branch must never delete the ref a symbolic ref points at.
 *
 * `removeBranch` (src/worktree.ts:1723-1758) deletes with
 *   `update-ref --stdin` + `delete refs/heads/<branch> <tip>` and no `option no-deref`.
 * `update-ref` dereferences a symbolic ref by default, so when `refs/heads/<branch>` is a
 * symref the delete lands on its TARGET — measured on git 2.4x: deleting
 * `refs/heads/task/sym -> refs/heads/main` removes `refs/heads/main`, exits 0, and leaves the
 * symref dangling. Yrd reaches this through `retireLocalBranch`
 * (vendor/yrd packages/yrd-queue-core/src/local-branch-retirement.ts:272); a symref branch in a
 * return-worktree repository therefore retires `main` itself.
 *
 * These tests are the red half of the pair; product source is untouched by this file.
 */
import { spawnSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createLocalGitWorktreeStore } from "../src/worktree.ts"
import { canonicalTmpdir, createRepository, NO_BACKGROUND_MAINTENANCE } from "./fixture.ts"

function git(repo: string, args: readonly string[]): string {
  const result = spawnSync("git", [...NO_BACKGROUND_MAINTENANCE, "-C", repo, ...args], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`)
  return result.stdout
}

/** A ref read that reports absence instead of throwing, so a lost ref is an assertion, not an error. */
function refState(repo: string, ref: string): { present: boolean; oid: string; stderr: string } {
  const result = spawnSync("git", [...NO_BACKGROUND_MAINTENANCE, "-C", repo, "rev-parse", "--verify", ref], {
    encoding: "utf8",
  })
  return { present: result.status === 0, oid: result.stdout.trim(), stderr: result.stderr.trim() }
}

describe("#31029 branch removal must not follow a symbolic ref", () => {
  it("keeps refs/heads/main when the named branch is a symref to it", async () => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-symref-35029-"))
    try {
      const repo = join(root, "repo")
      const tip = createRepository(repo, "root.txt", "root\n")
      const store = createLocalGitWorktreeStore({ repo })
      const branch = "task/sym"
      git(repo, ["symbolic-ref", `refs/heads/${branch}`, "refs/heads/main"])
      expect(git(repo, ["symbolic-ref", `refs/heads/${branch}`]).trim()).toBe("refs/heads/main")

      let removalError: unknown = null
      try {
        await store.removeBranch({ branch, tip })
      } catch (error) {
        removalError = error
      }

      const main = refState(repo, "refs/heads/main")
      expect(main.present, `refs/heads/main must survive removing symref ${branch}: ${main.stderr}`).toBe(true)
      expect(main.oid).toBe(tip)
      if (removalError !== null) {
        expect(String(removalError)).not.toMatch(/refs\/heads\/main[^]*\b(?:removed|deleted)\b/iu)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("keeps the target when the symref names a branch other than main", async () => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-symref-other-35029-"))
    try {
      const repo = join(root, "repo")
      const tip = createRepository(repo, "root.txt", "root\n")
      const store = createLocalGitWorktreeStore({ repo })
      git(repo, ["branch", "release/keep"])
      git(repo, ["symbolic-ref", "refs/heads/task/sym", "refs/heads/release/keep"])

      await store.removeBranch({ branch: "task/sym", tip }).catch(() => undefined)

      const kept = refState(repo, "refs/heads/release/keep")
      expect(kept.present, `refs/heads/release/keep must survive removing its symref: ${kept.stderr}`).toBe(true)
      expect(kept.oid).toBe(tip)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("control: a plain branch is still deleted and main is untouched", async () => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-plain-35029-"))
    try {
      const repo = join(root, "repo")
      const tip = createRepository(repo, "root.txt", "root\n")
      const store = createLocalGitWorktreeStore({ repo })
      git(repo, ["branch", "task/plain"])

      await store.removeBranch({ branch: "task/plain", tip })

      expect(refState(repo, "refs/heads/task/plain").present).toBe(false)
      expect(refState(repo, "refs/heads/main").oid).toBe(tip)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
