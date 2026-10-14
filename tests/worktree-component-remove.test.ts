/**
 * @failure git-super worktree remove --repo <super> refuses a clean component worktree as not registered in the super (28393).
 * @level l1
 * @consumer WIP sweep retiring landed vendor component worktrees; yrd env close delegates to this verb
 * @testonly none
 */
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { tryAcquireFlock } from "@bearly/flock"
import { createGitWorktreeStore } from "../src/worktree.ts"
import { createLocalGitProcess } from "../src/process.ts"
import { superWorktreeRemove } from "../src/worktree-remove.ts"
import { addNestedAlphaSubmodule, canonicalTmpdir, createProductFixture, createRepository, git } from "./fixture.ts"

describe("git-super worktree remove of a vendor component worktree (28393)", () => {
  /**
   * @failure Root removal leaves linked child registrations behind or hides partial cleanup failures (29340).
   * @level l1 @consumer every Git Super root remover, including Yrd native environment close
   * The Yrd journey proves ref/copy custody; this table owns nested native registration and failure sequencing.
   */
  it.each(["released", "held", "rebound", "failed", "post-remove-failed"] as const)(
    "cleans only destroyed nested registrations after root removal: %s",
    async (mode) => {
      const root = await mkdtemp(join(canonicalTmpdir(), "git-super-nested-release-"))
      let lease: ReturnType<typeof tryAcquireFlock> | undefined
      try {
        const fixture = addNestedAlphaSubmodule(createProductFixture(root))
        const target = join(root, "target")
        git(fixture.product, "worktree", "add", "--detach", target)
        const alpha = join(target, "packages/alpha")
        const leaf = join(alpha, "apps/maddoc")
        git(fixture.alpha, "worktree", "add", "-b", "task/child", alpha, "HEAD")
        git(fixture.leaf, "worktree", "add", "-b", "task/leaf", leaf, "HEAD")
        const leafAdmin = git(leaf, "rev-parse", "--absolute-git-dir")
        const leafTip = git(leaf, "rev-parse", "HEAD")
        const pointer = await Bun.file(join(leaf, ".git")).text()
        if (mode === "held") {
          const directory = join(leafAdmin, "yrd-worktree-mutations")
          await mkdir(directory, { recursive: true })
          lease = tryAcquireFlock(join(directory, "writer.lock"), { body: "native child holder" })
          expect(lease).not.toBeNull()
        }
        const local = createLocalGitProcess()
        let rootRemoved = false
        let rebound = false
        const store = createGitWorktreeStore({
          repo: fixture.product,
          gitProcess: {
            async run(request) {
              const removing = request.args.includes("worktree") && request.args.includes("remove")
              if (mode === "failed" && removing && request.args.includes(leaf)) {
                return { code: 1, stdout: "", stderr: "fixture child cleanup failure" }
              }
              const result = await local.run(request)
              if (mode === "post-remove-failed" && removing && request.args.includes(leaf) && result.code === 0) {
                throw new Error("fixture failed after child removal")
              }
              if (removing && request.args.includes(target) && result.code === 0) rootRemoved = true
              if (mode === "rebound" && rootRemoved && !rebound && request.args.includes("list")) {
                rebound = true
                await mkdir(leaf, { recursive: true })
                await writeFile(join(leaf, ".git"), pointer)
                await writeFile(join(leaf, "rebound.txt"), "new checkout owner\n")
              }
              return result
            },
          },
        })
        const outcome = await store.remove(target).then(
          () => ({ ok: true, error: "" }),
          (cause: unknown) => ({ ok: false, error: String(cause) }),
        )
        expect(existsSync(join(target, ".git"))).toBe(false)
        expect((await store.inspect(target)).registered).toBe(false)
        const leafRegistered = git(fixture.leaf, "worktree", "list", "--porcelain").includes(`worktree ${leaf}\n`)
        if (mode === "released") {
          expect(outcome).toEqual({ ok: true, error: "" })
          expect(leafRegistered).toBe(false)
          expect(git(fixture.alpha, "worktree", "list", "--porcelain")).not.toContain(`worktree ${alpha}\n`)
        } else {
          expect(outcome.ok).toBe(false)
          expect(outcome.error).toContain("root removed; child")
          expect(outcome.error).toContain(leaf)
          expect(outcome.error).toContain("recoverDestroyed")
          expect(leafRegistered).toBe(mode !== "post-remove-failed")
          if (mode === "post-remove-failed") expect(outcome.error).toContain("registration removed; cleanup incomplete")
          if (mode === "held") expect(outcome.error).toContain("native child holder")
          if (mode === "failed") expect(outcome.error).toContain("fixture child cleanup failure")
          if (mode === "rebound") expect(await Bun.file(join(leaf, "rebound.txt")).text()).toBe("new checkout owner\n")
        }
        expect(git(fixture.leaf, "rev-parse", "refs/heads/task/leaf")).toBe(leafTip)
      } finally {
        lease?.release()
        // raw-delete-allow: this row's isolated mkdtemp fixture, never an authored checkout
        await rm(root, { recursive: true, force: true })
      }
    },
  )

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
      // raw-delete-allow: the fixture tree this test made under its own mkdtemp root
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
      // raw-delete-allow: the fixture tree this test made under its own mkdtemp root
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
      // raw-delete-allow: the fixture tree this test made under its own mkdtemp root
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
      // raw-delete-allow: the fixture tree this test made under its own mkdtemp root
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
      // raw-delete-allow: the fixture tree this test made under its own mkdtemp root
      await rm(root, { recursive: true, force: true })
    }
  })
})
