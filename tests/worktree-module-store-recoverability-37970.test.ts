/**
 * @failure A landing's own module store can hold a ref whose commit exists in no surviving store, and removing the
 *   landing destroys the only copy of it (#37970).
 * @level l1
 * @consumer the shared-main landing reaper and every super remover that deletes a slot's module stores
 * @reach fs-walk <fixture-only: isolated Git repositories>
 * @testonly none
 */
import { existsSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createGitWorktreeStore } from "../src/worktree.ts"
import { createLocalGitProcess } from "../src/process.ts"
import { canonicalTmpdir, createProductFixture, git } from "./fixture.ts"

/** A linked worktree whose component store holds one branch that only that store knows. */
function slotWithLandingOnlyRef(root: string) {
  const fixture = createProductFixture(root)
  const target = join(root, "target")
  git(fixture.product, "worktree", "add", "--detach", target)
  git(target, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive")
  const alpha = join(target, "packages/alpha")
  git(alpha, "checkout", "-q", "-b", "tmp/landing-only")
  writeFileSync(join(alpha, "landing-only.txt"), "only here\n")
  git(alpha, "add", "landing-only.txt")
  git(alpha, "commit", "-q", "-m", "a commit only the landing store knows")
  return { fixture, target, alpha, sha: git(alpha, "rev-parse", "HEAD").trim() }
}

describe("#37970 module stores are proven recoverable before a slot is removed", () => {
  it("refuses, naming the ref and its sha, when its commit exists in no surviving store", async () => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-37970-unrecoverable-"))
    try {
      const { fixture, target, sha } = slotWithLandingOnlyRef(root)
      const store = createGitWorktreeStore({ repo: fixture.product, gitProcess: createLocalGitProcess() })
      const error = await store.remove(target).then(
        () => "",
        (cause: unknown) => String(cause),
      )
      expect(error).toContain("exist in no surviving store")
      expect(error).toContain("refs/heads/tmp/landing-only")
      expect(error).toContain(sha)
      expect(existsSync(target)).toBe(true)
    } finally {
      // raw-delete-allow: this isolated mkdtemp fixture owns every path beneath root
      await rm(root, { recursive: true, force: true })
    }
  })

  it("proceeds once the same ref's commit is present in the projection's store", async () => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-37970-recoverable-"))
    try {
      const { fixture, target, alpha } = slotWithLandingOnlyRef(root)
      git(
        join(fixture.product, "packages/alpha"),
        "fetch",
        "-q",
        alpha,
        "refs/heads/tmp/landing-only:refs/heads/tmp/landing-only",
      )
      const store = createGitWorktreeStore({ repo: fixture.product, gitProcess: createLocalGitProcess() })
      await store.remove(target)
      expect(existsSync(target)).toBe(false)
    } finally {
      // raw-delete-allow: this isolated mkdtemp fixture owns every path beneath root
      await rm(root, { recursive: true, force: true })
    }
  })
})
