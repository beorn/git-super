/**
 * @failure git-super worktree remove --repo <super> refuses a clean component worktree as not registered in the super (28393).
 * @level l1
 * @consumer WIP sweep retiring landed vendor component worktrees; yrd env close delegates to this verb
 * @testonly none
 */
import { existsSync } from "node:fs"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { superWorktreeRemove } from "../src/worktree-remove.ts"
import { addNestedAlphaSubmodule, canonicalTmpdir, createProductFixture, createRepository, git } from "./fixture.ts"

describe("git-super worktree remove of a vendor component worktree (28393)", () => {
  it("retires a clean linked worktree registered only in the submodule gitdir", async () => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-component-remove-"))
    try {
      const fixture = createProductFixture(root)
      const alpha = join(fixture.product, "packages/alpha")
      const componentWt = join(root, "alpha-wt")
      git(alpha, "worktree", "add", "--detach", componentWt)
      expect(git(alpha, "worktree", "list", "--porcelain")).toContain(componentWt)
      expect(git(fixture.product, "worktree", "list", "--porcelain")).not.toContain(componentWt)

      const result = await superWorktreeRemove({
        repo: fixture.product,
        path: componentWt,
        retain: join(root, "retained"),
      })

      expect(result.state, result.detail?.message ?? JSON.stringify(result)).toBe("updated")
      expect(existsSync(componentWt)).toBe(false)
      expect(git(alpha, "worktree", "list", "--porcelain")).not.toContain(componentWt)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("refuses a dirty component worktree and keeps it", async () => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-component-soiled-"))
    try {
      const fixture = createProductFixture(root)
      const alpha = join(fixture.product, "packages/alpha")
      const componentWt = join(root, "alpha-wt")
      git(alpha, "worktree", "add", "--detach", componentWt)
      await writeFile(join(componentWt, "keep.txt"), "keep this change\n")

      const result = await superWorktreeRemove({
        repo: fixture.product,
        path: componentWt,
        retain: join(root, "retained"),
      })

      expect(result.state).toBe("failed")
      expect(result.detail?.message ?? "").toContain("keep.txt")
      expect(existsSync(componentWt)).toBe(true)
      expect(git(alpha, "worktree", "list", "--porcelain")).toContain(componentWt)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("refuses a path whose gitdir sits outside the super's modules store", async () => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-component-foreign-"))
    try {
      const fixture = createProductFixture(root)
      const other = join(root, "other")
      createRepository(other, "other.ts", "export const other = 1\n")
      const outsider = join(root, "other-wt")
      git(other, "worktree", "add", "--detach", outsider)

      const result = await superWorktreeRemove({
        repo: fixture.product,
        path: outsider,
        retain: join(root, "retained"),
      })

      expect(result.state).toBe("failed")
      expect(result.detail?.message ?? "").toMatch(/gitdir .* outside /iu)
      expect(existsSync(outsider)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("keeps a borrowed component worktree when noRehome is set", async () => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-component-borrow-"))
    try {
      const fixture = addNestedAlphaSubmodule(createProductFixture(root))
      const alpha = join(fixture.product, "packages/alpha")
      const lender = join(root, "alpha-lender")
      const borrower = join(root, "alpha-borrower")
      git(alpha, "worktree", "add", "--detach", lender)
      git(alpha, "worktree", "add", "--detach", borrower)
      git(lender, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "apps/maddoc")
      git(borrower, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "apps/maddoc")
      const lenderObjects = join(git(join(lender, "apps/maddoc"), "rev-parse", "--absolute-git-dir").trim(), "objects")
      const borrowerGitDir = git(join(borrower, "apps/maddoc"), "rev-parse", "--absolute-git-dir").trim()
      const borrowerObjects = join(borrowerGitDir, "objects")
      await rm(borrowerObjects, { recursive: true, force: true })
      await symlink(lenderObjects, borrowerObjects, "dir")

      const result = await superWorktreeRemove({
        repo: fixture.product,
        path: lender,
        retain: join(root, "retained"),
        noRehome: true,
      })

      expect(result.state).toBe("unchanged")
      expect(result.reason).toBe("borrowed")
      expect(result.borrowers).toEqual([borrower])
      expect(existsSync(lender)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
