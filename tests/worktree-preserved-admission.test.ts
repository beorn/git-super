/**
 * @failure 29073: a dirty worktree is removable with NO proof its bytes were preserved, or a
 *          preserved ref living in the WRONG store silently admits an unrelated store's dirt.
 * @level l1
 * @consumer yrd env close --preserve, which composes the worktree preserve before removal
 * @reach fs-walk <fixture-only: isolated mkdtemp Git repositories the test builds and removes itself>
 * @testonly none
 */
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createLocalGitWorktreeStore } from "../src/worktree.ts"
import { superWorktreeRemove } from "../src/worktree-remove.ts"
import { canonicalTmpdir, createProductFixture, createRepository, git } from "./fixture.ts"

const REF = "refs/heads/wip/preserve-test"

/** Commit what is dirty in `store` under `ref` WITHOUT touching its index or worktree (29073 admit knob). */
function preserveDirtyRef(store: string, file: string, ref = REF): string {
  git(store, "add", file)
  const tree = git(store, "write-tree")
  const commit = git(store, "commit-tree", tree, "-p", "HEAD", "-m", "preserve")
  git(store, "update-ref", ref, commit)
  return commit
}

async function linkedWithSubmodules() {
  const root = await mkdtemp(join(canonicalTmpdir(), "git-super-preserved-"))
  const fixture = createProductFixture(root)
  const linked = join(root, "linked")
  const store = createLocalGitWorktreeStore({ repo: fixture.product })
  await store.add({ kind: "detached", path: linked, ref: "HEAD" })
  git(linked, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive")
  return { root, fixture, linked, alpha: join(linked, "packages/alpha"), retain: join(root, "retained") }
}

describe("git-super worktree remove --preserved admits dirt only against a ref in that store (29073)", () => {
  it("admits ROOT-only dirt against a root-store ref and keeps the preserved bytes", async () => {
    const { root, fixture, linked, retain } = await linkedWithSubmodules()
    try {
      await writeFile(join(linked, "root-dirt.txt"), "root preserved\n")
      const commit = preserveDirtyRef(linked, "root-dirt.txt")

      const result = await superWorktreeRemove({ repo: fixture.product, path: linked, retain, preserved: [REF] })

      expect(result.state, result.detail?.message ?? "").toBe("updated")
      expect(existsSync(linked)).toBe(false)
      // The dirty bytes survive removal in the commit the admitted ref names.
      expect(git(fixture.product, "show", `${commit}:root-dirt.txt`).trim()).toBe("root preserved")
    } finally {
      // raw-delete-allow: the fixture tree this test made under its own mkdtemp root
      await rm(root, { recursive: true, force: true })
    }
  })

  it("admits COMPONENT-only dirt against a component-store ref", async () => {
    const { root, fixture, linked, alpha, retain } = await linkedWithSubmodules()
    try {
      await writeFile(join(alpha, "READY"), "component preserved\n")
      preserveDirtyRef(alpha, "READY")

      const result = await superWorktreeRemove({ repo: fixture.product, path: linked, retain, preserved: [REF] })

      expect(result.state, result.detail?.message ?? "").toBe("updated")
      expect(existsSync(linked)).toBe(false)
      // Retention ran and left its durable proof for the component store it copied.
      expect(result.proof?.manifest).toBeDefined()
      expect(existsSync(result.proof!.manifest)).toBe(true)
    } finally {
      // raw-delete-allow: the fixture tree this test made under its own mkdtemp root
      await rm(root, { recursive: true, force: true })
    }
  })

  it("admits ROOT and COMPONENT dirt together, each against its own store's ref", async () => {
    const { root, fixture, linked, alpha, retain } = await linkedWithSubmodules()
    try {
      await writeFile(join(linked, "root-dirt.txt"), "root preserved\n")
      await writeFile(join(alpha, "READY"), "component preserved\n")
      // The preserve convention writes the SAME ref name into every dirty store.
      preserveDirtyRef(linked, "root-dirt.txt")
      preserveDirtyRef(alpha, "READY")

      const result = await superWorktreeRemove({ repo: fixture.product, path: linked, retain, preserved: [REF] })

      expect(result.state, result.detail?.message ?? "").toBe("updated")
      expect(existsSync(linked)).toBe(false)
    } finally {
      // raw-delete-allow: the fixture tree this test made under its own mkdtemp root
      await rm(root, { recursive: true, force: true })
    }
  })

  it("refuses ROOT dirt when the named ref resolves only in the COMPONENT store", async () => {
    const { root, fixture, linked, alpha, retain } = await linkedWithSubmodules()
    try {
      await writeFile(join(linked, "root-dirt.txt"), "root preserved\n")
      // The ref exists, but it is a commit in the component store, never the root's.
      preserveDirtyRef(alpha, "alpha.ts")

      const result = await superWorktreeRemove({ repo: fixture.product, path: linked, retain, preserved: [REF] })

      expect(result.state).toBe("failed")
      expect(result.detail?.message ?? "").toContain("is dirty")
      expect(result.detail?.message ?? "").toContain("root-dirt.txt")
      expect(existsSync(linked)).toBe(true)
    } finally {
      // raw-delete-allow: the fixture tree this test made under its own mkdtemp root
      await rm(root, { recursive: true, force: true })
    }
  })

  it("refuses dirt when no named ref exists, exactly as before --preserved", async () => {
    const { root, fixture, linked, retain } = await linkedWithSubmodules()
    try {
      await writeFile(join(linked, "root-dirt.txt"), "root preserved\n")

      const result = await superWorktreeRemove({
        repo: fixture.product,
        path: linked,
        retain,
        preserved: ["refs/heads/wip/does-not-exist"],
      })

      expect(result.state).toBe("failed")
      expect(result.detail?.message ?? "").toContain("is dirty")
      expect(existsSync(linked)).toBe(true)
      expect(git(fixture.product, "worktree", "list", "--porcelain")).toContain(linked)
    } finally {
      // raw-delete-allow: the fixture tree this test made under its own mkdtemp root
      await rm(root, { recursive: true, force: true })
    }
  })

  it("admits ROOT-only dirt in a tree with NO .gitmodules through the same gate", async () => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-preserved-nosub-"))
    try {
      const repo = join(root, "repo")
      createRepository(repo, "readme.md", "hello\n")
      expect(git(repo, "ls-tree", "HEAD", "--", ".gitmodules").trim()).toBe("")
      const linked = join(root, "linked")
      git(repo, "worktree", "add", "--detach", linked, "HEAD")
      await writeFile(join(linked, "root-dirt.txt"), "root preserved\n")
      const commit = preserveDirtyRef(linked, "root-dirt.txt")

      const result = await superWorktreeRemove({
        repo,
        path: linked,
        retain: join(root, "retained"),
        preserved: [REF],
      })

      expect(result.state, result.detail?.message ?? "").toBe("updated")
      expect(existsSync(linked)).toBe(false)
      expect(git(repo, "show", `${commit}:root-dirt.txt`).trim()).toBe("root preserved")
    } finally {
      // raw-delete-allow: the fixture tree this test made under its own mkdtemp root
      await rm(root, { recursive: true, force: true })
    }
  })
})
