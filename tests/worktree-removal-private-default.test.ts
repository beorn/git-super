/**
 * @failure A worktree removal that names no excluded submodule deletes a declared-private submodule store it never proved (28661).
 * @level l1
 * @consumer yrd env close · queue bay cleanup · worktree reapers and cleanup sweeps · a hand run
 * @reach fs-walk <fixture-only: synthetic repositories under the temp root>
 * @testonly none
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { createLocalGitWorktreeStore } from "../src/worktree.ts"
import { assertNoPrivateStoreAcrossPrune, PrivateStoreRefusalError } from "../src/worktree-removal.ts"
import type { GitProcess } from "../src/process.ts"
import { canonicalTmpdir, createRepository, git } from "./fixture.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * A checkout that carries a submodule its own `.gitmodules` declares `private = true`, plus the
 * absolute Git store the removal would destroy. The declaration is the ONLY difference from an
 * ordinary submodule: no caller passes an exclusion list here.
 */
function privateFixture(root: string): { repo: string; linked: string; excluded: string; name: string; store: string } {
  const repo = join(root, "product")
  const component = join(root, "component")
  createRepository(repo, "root.txt", "root\n")
  createRepository(component, "component.txt", "component\n")
  const excluded = "vendor/private"
  const name = "private-store"
  git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "--name", name, component, excluded)
  git(repo, "config", "-f", ".gitmodules", `submodule.${name}.private`, "true")
  git(repo, "add", ".gitmodules")
  git(repo, "commit", "-q", "-m", "declare the private submodule")
  const linked = join(root, "linked")
  git(repo, "worktree", "add", "-q", "--detach", linked, "HEAD")
  git(linked, "-c", "protocol.file.allow=always", "submodule", "update", "--init", excluded)
  const store = git(linked, "rev-parse", "--path-format=absolute", "--git-path", `modules/${name}`).trim()
  return { repo, linked, excluded, name, store }
}

// The red this file exists for: the caller names no exclusion, so `assertExcludedRemovalCustody`
// returns early (worktree-removal.ts:93) and the declared-private store is removed unproved.
it("refuses a removal with no exclusion list when the target declares a private submodule store", async () => {
  const root = mkdtempSync(join(canonicalTmpdir(), "git-super-private-default-"))
  roots.push(root)
  const { repo, linked, excluded, store } = privateFixture(root)
  expect(existsSync(store)).toBe(true)
  const checkout = join(linked, excluded)
  expect(existsSync(checkout)).toBe(true)

  const error = await createLocalGitWorktreeStore({ repo })
    .remove(linked)
    .then(
      () => undefined,
      (cause: unknown) => cause,
    )

  expect(error, "a removal naming no exclusion must not delete a declared-private store").toBeInstanceOf(Error)
  expect(String(error)).toContain(store)
  expect(existsSync(store)).toBe(true)
  expect(existsSync(linked)).toBe(true)
})

// The deinit'd shape is the one my env-close fixture measured destroying a store with exit 0: the
// checkout is empty, so nothing in the working tree shows the store is about to go.
it("refuses a removal with no exclusion list when a declared-private store outlives a deinit'd checkout", async () => {
  const root = mkdtempSync(join(canonicalTmpdir(), "git-super-private-default-deinit-"))
  roots.push(root)
  const { repo, linked, excluded, store } = privateFixture(root)
  git(linked, "submodule", "deinit", "-f", "--", excluded)
  expect(existsSync(store)).toBe(true)

  const error = await createLocalGitWorktreeStore({ repo })
    .remove(linked)
    .then(
      () => undefined,
      (cause: unknown) => cause,
    )

  expect(error, "an emptied checkout must not license deleting the store inside it").toBeInstanceOf(Error)
  expect(String(error)).toContain(store)
  expect(existsSync(store)).toBe(true)
  expect(existsSync(linked)).toBe(true)
})

// The already-protected shape keeps working: an explicit exclusion still removes and still proves custody.
it("still removes an ordinary worktree that declares no private submodule", async () => {
  const root = mkdtempSync(join(canonicalTmpdir(), "git-super-private-default-public-"))
  roots.push(root)
  const repo = join(root, "product")
  createRepository(repo, "root.txt", "root\n")
  const linked = join(root, "linked")
  git(repo, "worktree", "add", "-q", "--detach", linked, "HEAD")

  await createLocalGitWorktreeStore({ repo }).remove(linked)
  expect(existsSync(linked)).toBe(false)
})

// The third shape: the checkout is ALREADY gone, so every guard that reads the checkout is blind, and prune
// is exactly the command that then deletes the admin dir holding the store.
it("refuses a prune whose own preview includes an admin dir holding a private store", async () => {
  const root = mkdtempSync(join(canonicalTmpdir(), "git-super-private-default-prune-"))
  roots.push(root)
  const { repo, linked, store } = privateFixture(root)
  rmSync(linked, { recursive: true, force: true })
  expect(existsSync(store)).toBe(true)

  const error = await createLocalGitWorktreeStore({ repo })
    .prune()
    .then(
      () => undefined,
      (cause: unknown) => cause,
    )

  expect(error, "prune must judge what it would delete before deleting it").toBeInstanceOf(Error)
  expect(String(error)).toContain(store)
  expect(existsSync(store)).toBe(true)
})

// A prune with nothing private in its preview still prunes: the refusal is not a freeze on pruning.
it("still prunes an admin dir whose store belongs to no private submodule", async () => {
  const root = mkdtempSync(join(canonicalTmpdir(), "git-super-private-default-prune-public-"))
  roots.push(root)
  const repo = join(root, "product")
  const component = join(root, "component")
  createRepository(repo, "root.txt", "root\n")
  createRepository(component, "component.txt", "component\n")
  git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "--name", "dep", component, "vendor/dep")
  git(repo, "commit", "-q", "-am", "add the public submodule")
  const linked = join(root, "linked")
  git(repo, "worktree", "add", "-q", "--detach", linked, "HEAD")
  git(linked, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "vendor/dep")
  const admin = join(repo, ".git", "worktrees", "linked")
  expect(existsSync(admin)).toBe(true)
  rmSync(linked, { recursive: true, force: true })

  await createLocalGitWorktreeStore({ repo }).prune()

  expect(existsSync(admin)).toBe(false)
})

// Custody ruling (b): a store is private for what it holds, not for how old the target's HEAD is. The target
// here is checked out BEFORE the declaration, and main carries it, so the target's own HEAD declares nothing.
it("refuses when only current main declares the store private (custody ruling (b))", async () => {
  const root = mkdtempSync(join(canonicalTmpdir(), "git-super-private-default-main-"))
  roots.push(root)
  const repo = join(root, "product")
  const component = join(root, "component")
  createRepository(repo, "root.txt", "root\n")
  createRepository(component, "component.txt", "component\n")
  const excluded = "vendor/dep"
  const name = "dep"
  git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "--name", name, component, excluded)
  git(repo, "commit", "-q", "-am", "add the submodule without declaring it private")
  const linked = join(root, "linked")
  git(repo, "worktree", "add", "-q", "--detach", linked, "HEAD")
  git(linked, "-c", "protocol.file.allow=always", "submodule", "update", "--init", excluded)
  const store = git(linked, "rev-parse", "--path-format=absolute", "--git-path", `modules/${name}`).trim()
  // Declare it private on the repository's MAIN, leaving the target's own HEAD untouched.
  git(repo, "config", "-f", ".gitmodules", `submodule.${name}.private`, "true")
  git(repo, "add", ".gitmodules")
  git(repo, "commit", "-q", "-m", "declare the submodule private on main")
  expect(existsSync(store)).toBe(true)

  const error = await createLocalGitWorktreeStore({ repo })
    .remove(linked)
    .then(
      () => undefined,
      (cause: unknown) => cause,
    )

  expect(error, "main's declaration decides even where the target HEAD predates it").toBeInstanceOf(Error)
  expect(String(error)).toContain(store)
  expect(existsSync(store)).toBe(true)
})

// C1: the preview is this guard's ONLY source for what prune would delete, so a line it cannot parse refuses
// the prune instead of being skipped — and the refusal names the line's KIND, never any of its text.
it("refuses a prune preview it cannot fully parse, and repeats none of the line", async () => {
  const root = mkdtempSync(join(canonicalTmpdir(), "git-super-prune-unparsed-"))
  roots.push(root)
  const repo = join(root, "product")
  createRepository(repo, "root.txt", "root\n")
  const sentinel = "PRIVATE-SENTINEL-PATH"
  let previewEnv: NodeJS.ProcessEnv | undefined
  const process: GitProcess = {
    async run(request) {
      if (request.args[0] === "worktree") {
        previewEnv = request.env
        return { code: 0, stdout: "", stderr: `warning: something odd about ${sentinel}\n` }
      }
      return { code: 0, stdout: `${join(repo, ".git")}\n`, stderr: "" }
    },
  }
  const error = await assertNoPrivateStoreAcrossPrune(process, { repository: repo }).then(
    () => undefined,
    (cause: unknown) => cause,
  )
  expect(error, "an unparsed preview cannot be proven to name every admin dir Git would delete").toBeInstanceOf(Error)
  expect(String(error)).toContain("warning line")
  expect(String(error)).not.toContain(sentinel)
  // The other half of C1: the preview is read in a fixed locale, or a translated Git refuses every prune.
  expect(previewEnv?.LC_ALL).toBe("C")
})

it("judges an unparsed preview line on stdout too, and names the stream", async () => {
  const root = mkdtempSync(join(canonicalTmpdir(), "git-super-prune-unparsed-stdout-"))
  roots.push(root)
  const repo = join(root, "product")
  createRepository(repo, "root.txt", "root\n")
  const process: GitProcess = {
    async run(request) {
      if (request.args[0] === "worktree") return { code: 0, stdout: "Removing but no reason follows\n", stderr: "" }
      return { code: 0, stdout: `${join(repo, ".git")}\n`, stderr: "" }
    },
  }
  const error = await assertNoPrivateStoreAcrossPrune(process, { repository: repo }).then(
    () => undefined,
    (cause: unknown) => cause,
  )
  expect(error).toBeInstanceOf(Error)
  expect(String(error)).toContain("stdout")
  expect(String(error)).toContain("malformed")
})

// C4: the refusal is TYPED, so a caller that must discard a tree can tell "these bytes must not be deleted"
// from "git failed" and skip the tree instead of wedging on message text. Both removal shapes carry it.
it("refuses with a typed refusal on the plain removal and on the prune", async () => {
  const root = mkdtempSync(join(canonicalTmpdir(), "git-super-typed-refusal-"))
  roots.push(root)
  const { repo, linked, store } = privateFixture(root)
  const removal = await createLocalGitWorktreeStore({ repo })
    .remove(linked)
    .then(
      () => undefined,
      (cause: unknown) => cause,
    )
  expect(removal).toBeInstanceOf(PrivateStoreRefusalError)
  expect(existsSync(store)).toBe(true)

  rmSync(linked, { recursive: true, force: true })
  const pruning = await createLocalGitWorktreeStore({ repo })
    .prune()
    .then(
      () => undefined,
      (cause: unknown) => cause,
    )
  expect(pruning).toBeInstanceOf(PrivateStoreRefusalError)
  expect(existsSync(store)).toBe(true)
})
