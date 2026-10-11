/**
 * @failure A retained worktree removal copies a declared-private submodule store into retained-modules (28661; chief c8a3b06d).
 * @level l1
 * @consumer git super worktree remove --retain · yrd env close · the queue's merge-close
 * @reach fs-walk <fixture-only: synthetic repositories under the temp root>
 * @testonly none
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { join, sep } from "node:path"
import { afterEach, expect, it } from "vitest"
import { createLocalGitWorktreeStore } from "../src/worktree.ts"
import { manifest } from "../src/worktree-removal.ts"
import { canonicalTmpdir, createRepository, git } from "./fixture.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * A checkout with TWO initialized submodule stores: one its `.gitmodules` declares `private = true`, one it does
 * not. Retention must leave the private store behind and keep the ordinary one exactly as before.
 */
function mixedFixture(root: string): {
  repo: string
  linked: string
  privateStore: string
  publicStore: string
} {
  const repo = join(root, "product")
  const privateComponent = join(root, "component-private")
  const publicComponent = join(root, "component-public")
  createRepository(repo, "root.txt", "root\n")
  createRepository(privateComponent, "private.txt", "private\n")
  createRepository(publicComponent, "public.txt", "public\n")
  const privatePath = "vendor/private"
  const publicPath = "vendor/public"
  const privateName = "private-store"
  const publicName = "public-store"
  git(
    repo,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "--name",
    privateName,
    privateComponent,
    privatePath,
  )
  git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "--name", publicName, publicComponent, publicPath)
  git(repo, "config", "-f", ".gitmodules", "submodule." + privateName + ".private", "true")
  git(repo, "add", ".gitmodules")
  git(repo, "commit", "-q", "-m", "declare one private and one ordinary submodule")
  const linked = join(root, "linked")
  git(repo, "worktree", "add", "-q", "--detach", linked, "HEAD")
  git(linked, "-c", "protocol.file.allow=always", "submodule", "update", "--init", privatePath, publicPath)
  return {
    repo,
    linked,
    privateStore: git(linked, "rev-parse", "--path-format=absolute", "--git-path", "modules/" + privateName).trim(),
    publicStore: git(linked, "rev-parse", "--path-format=absolute", "--git-path", "modules/" + publicName).trim(),
  }
}

// The override deletes the private store on purpose; retention must NOT smuggle a copy of it into a durable
// non-private directory, while the ordinary store keeps being retained exactly as before.
it("leaves a declared-private store OUT of retained-modules and keeps the ordinary store", async () => {
  const root = mkdtempSync(join(canonicalTmpdir(), "git-super-private-retain-"))
  roots.push(root)
  const { repo, linked, privateStore, publicStore } = mixedFixture(root)
  expect(existsSync(privateStore)).toBe(true)
  expect(existsSync(publicStore)).toBe(true)
  const retain = join(root, "retained")
  const discarded: string[] = []
  await createLocalGitWorktreeStore({
    repo,
    journal: (record) => discarded.push(record.store),
  }).remove(linked, {
    retention: { root: retain, report: () => {} },
    discardPrivateStore: { reason: "abandoned unpushed draft", actor: "seat-under-test" },
  })

  const retainedRoot = join(retain, readdirSync(retain)[0]!)
  expect(existsSync(join(retainedRoot, "modules", "private-store"))).toBe(false)
  expect(existsSync(join(retainedRoot, "modules", "public-store"))).toBe(true)
  // The discard was journaled, and it names the store that is now genuinely gone rather than merely moved.
  expect(discarded).toContain(privateStore)
  expect(existsSync(privateStore)).toBe(false)
})

// @cto 2026-10-11: filtering the OUTPUT is not enough. The walk must never ENTER the private store, or the
// manifest has already read the store's own entry names. The injected reader records every directory asked for.
it("never enters a declared-private store while building a manifest", () => {
  const root = mkdtempSync(join(canonicalTmpdir(), "git-super-private-walk-"))
  roots.push(root)
  const { linked, privateStore } = mixedFixture(root)
  const gitDir = git(linked, "rev-parse", "--absolute-git-dir").trim()
  const common = git(linked, "rev-parse", "--path-format=absolute", "--git-common-dir").trim()
  const modules = join(gitDir, "modules")
  const asked: string[] = []
  const result = manifest(
    modules,
    { common, checkout: linked, gitDir, modules },
    true,
    false,
    (path) => path === privateStore || path.startsWith(privateStore + sep),
    (directory) => {
      asked.push(directory)
      return readdirSync(directory, { withFileTypes: true })
    },
  )
  expect(asked).not.toContain(privateStore)
  // Non-vacuity: the injected reader was actually used, so a pass cannot mean the seam was ignored.
  expect(asked.length).toBeGreaterThan(0)
  expect(asked.some((directory) => directory.startsWith(privateStore + sep))).toBe(false)
  expect(Object.keys(result.entries).some((key) => key.startsWith("private-store" + sep))).toBe(false)
  expect(Object.keys(result.entries).some((key) => key.startsWith("public-store" + sep))).toBe(true)
})
