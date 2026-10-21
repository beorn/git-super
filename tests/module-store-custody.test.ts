/**
 * Removal destroys a slot's own `<git-dir>/modules/` tree. Before 30580 it did so without ever looking at the
 * stores no HEAD declaration names, so a submodule dropped in a later commit — or an undeclared gitlink whose
 * store uses another name — took its local branches, unpushed commits and stashes with it. The inventory now
 * walks every removal and releases a store only when every commit it holds is held by a remote-tracking ref.
 *
 * @failure A slot's module repository holding unpushed commits, a stash, or bytes no remote holds is deleted
 *          with the slot, and a store that is fully reproducible is destroyed without being named.
 * @level   l1
 * @consumer git-super worktree removal, bearly worktree remove, yrd environment close
 * @testonly none
 * @reach fs-walk <fixture-only: linked worktrees and module stores under mkdtempSync(canonicalTmpdir())>
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { describeReleasedStores, inspectModuleStores } from "../src/module-store-custody.ts"
import { superStatus } from "../src/status.ts"
import { createLocalGitWorktreeStore } from "../src/worktree.ts"
import { canonicalTmpdir, createProductFixture, git } from "./fixture.ts"

const roots: string[] = []

afterEach(() => {
  // raw-delete-allow: teardown of this file's own mkdtempSync fixture roots under tmpdir.
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixtureRoot(label: string): string {
  const root = mkdtempSync(join(canonicalTmpdir(), `git-super-${label}-`))
  roots.push(root)
  return root
}

/** A linked slot with its own `modules/packages/alpha` store, exactly as a pool slot carries one. */
async function linkedSlot(root: string) {
  const fixture = createProductFixture(root)
  const store = createLocalGitWorktreeStore({ repo: fixture.product })
  const linked = join(root, "slot")
  await store.add({ kind: "detached", path: linked, ref: "HEAD" })
  git(linked, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "packages/alpha")
  const gitDir = git(linked, "rev-parse", "--absolute-git-dir").trim()
  const modules = join(gitDir, "modules")
  return { fixture, store, linked, gitDir, modules, child: join(linked, "packages/alpha") }
}

/** The commit inside the slot's alpha checkout that no remote holds, if one was made. */
function unpushedCommit(child: string): string {
  writeFileSync(join(child, "unpushed.txt"), "bytes that exist only here\n")
  git(child, "add", "-A")
  git(child, "commit", "-q", "-m", "unpushed work")
  return git(child, "rev-parse", "--short=12", "HEAD").trim()
}

/** Make alpha a store nothing in the slot's HEAD declares, as dropping the submodule in a later commit does. */
function dropAlphaFromHead(linked: string): void {
  git(linked, "submodule", "deinit", "-f", "--", "packages/alpha")
  git(linked, "rm", "-fq", "packages/alpha")
  git(linked, "commit", "-q", "-m", "drop alpha")
}

function refusal(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error("expected a refusal, and the removal was admitted")
}

describe("slot module store inventory", () => {
  test("an unreferenced store holding an unpushed commit refuses, naming the store and the count", async () => {
    const slot = await linkedSlot(fixtureRoot("module-unique"))
    const tip = unpushedCommit(slot.child)
    dropAlphaFromHead(slot.linked)
    const message = refusal(() => inspectModuleStores(slot.linked, slot.gitDir))
    expect(message).toContain("module store packages/alpha")
    expect(message).toContain("holds 1 commit(s) no remote-tracking ref holds")
    expect(message).toContain("compared against origin")
    expect(message).toContain(`HEAD ${tip}`)
    expect(message).toContain("bundle create")
    expect(existsSync(join(slot.modules, "packages/alpha"))).toBe(true)
  })

  test("a store whose every commit is on its remote is released, and the report names it", async () => {
    const slot = await linkedSlot(fixtureRoot("module-pushed"))
    const tip = unpushedCommit(slot.child)
    // A branch the remote keeps but the slot's own HEAD does not: the store's commit is reproducible.
    git(slot.child, "push", "-q", "origin", "HEAD:refs/heads/pushed-work")
    git(slot.child, "fetch", "-q", "origin")
    dropAlphaFromHead(slot.linked)
    const inventory = inspectModuleStores(slot.linked, slot.gitDir)
    expect(inventory.released).toEqual([
      expect.objectContaining({ name: "packages/alpha", uniqueCommits: 0, remote: "origin", head: tip }),
    ])
    expect(describeReleasedStores(inventory.released)).toEqual([
      `module store packages/alpha released: every commit is held by origin, HEAD ${tip}`,
    ])
  })

  test("a stash-only commit is unique work and refuses", async () => {
    const slot = await linkedSlot(fixtureRoot("module-stash"))
    writeFileSync(join(slot.child, "alpha.ts"), "export const alpha = 999\n")
    git(slot.child, "stash", "push", "-q", "-m", "only in the stash")
    dropAlphaFromHead(slot.linked)
    const message = refusal(() => inspectModuleStores(slot.linked, slot.gitDir))
    expect(message).toContain("module store packages/alpha")
    expect(message).toMatch(/holds [1-9][0-9]* commit\(s\) no remote-tracking ref holds/)
  })

  test("an undeclared store under another name refuses, naming its path", async () => {
    const slot = await linkedSlot(fixtureRoot("module-undeclared"))
    unpushedCommit(slot.child)
    dropAlphaFromHead(slot.linked)
    mkdirSync(join(slot.modules, "components"), { recursive: true })
    renameSync(join(slot.modules, "packages/alpha"), join(slot.modules, "components/outer"))
    const message = refusal(() => inspectModuleStores(slot.linked, slot.gitDir))
    expect(message).toContain("module store components/outer")
    expect(message).toContain("holds 1 commit(s)")
  })

  test("a fully mapped slot passes the inventory and still removes", async () => {
    const slot = await linkedSlot(fixtureRoot("module-mapped"))
    expect(inspectModuleStores(slot.linked, slot.gitDir)).toEqual({ released: [] })
    await slot.store.remove(slot.linked)
    expect(existsSync(slot.linked)).toBe(false)
    expect(existsSync(slot.modules)).toBe(false)
  })

  test("an unreadable store refuses instead of counting as empty", async () => {
    const slot = await linkedSlot(fixtureRoot("module-unreadable"))
    dropAlphaFromHead(slot.linked)
    writeFileSync(join(slot.modules, "packages/alpha/config"), "not a git config\n")
    const message = refusal(() => inspectModuleStores(slot.linked, slot.gitDir))
    expect(message).toContain("worktree preserved")
    expect(message).toMatch(/unreadable refs|could not be read|could not be counted/)
  })

  test("a caller-proved excluded store is never judged, and an unclaimed exclusion still refuses", async () => {
    const slot = await linkedSlot(fixtureRoot("module-excluded"))
    const claimed = join(slot.modules, "packages/alpha")
    mkdirSync(join(slot.modules, "components"), { recursive: true })
    cpSync(claimed, join(slot.modules, "components/outer"), { recursive: true })
    expect(inspectModuleStores(slot.linked, slot.gitDir, [claimed])).toEqual({
      released: [expect.objectContaining({ name: "components/outer", uniqueCommits: 0 })],
    })
    const message = refusal(() => inspectModuleStores(slot.linked, slot.gitDir, [claimed], ["vendor/private"]))
    expect(message).toContain("excluded vendor/private: target-owned store")
    expect(message).toContain("has no included parent identity")
  })

  test("an empty checkout whose store is fully pushed holds nothing, and a unique commit still refuses (30563)", () => {
    const pushed = createProductFixture(fixtureRoot("module-status-pushed"))
    const pushedChild = join(pushed.product, "packages/alpha")
    writeFileSync(join(pushedChild, "pushed.txt"), "on the remote\n")
    git(pushedChild, "add", "-A")
    git(pushedChild, "commit", "-q", "-m", "pushed work")
    git(pushedChild, "push", "-q", "origin", "HEAD:refs/heads/pushed-work")
    git(pushedChild, "fetch", "-q", "origin")
    rmSync(pushedChild, { recursive: true, force: true })
    const admitted = superStatus({ repo: pushed.product })
    expect(admitted.uninitializedSubmodules).toContain("packages/alpha")
    expect(admitted.submoduleProblems).toEqual([])

    const unique = createProductFixture(fixtureRoot("module-status-unique"))
    const uniqueChild = join(unique.product, "packages/alpha")
    writeFileSync(join(uniqueChild, "unpushed.txt"), "bytes that exist only here\n")
    git(uniqueChild, "add", "-A")
    git(uniqueChild, "commit", "-q", "-m", "unpushed work")
    rmSync(uniqueChild, { recursive: true, force: true })
    const refused = superStatus({ repo: unique.product })
    expect(refused.uninitializedSubmodules).toEqual([])
    expect(refused.submoduleProblems).toHaveLength(1)
    expect(refused.submoduleProblems[0]!.reason).toContain("holds 1 commit(s) no remote-tracking ref holds")
    expect(refused.submoduleProblems[0]!.reason).toContain("submodule update --init packages/alpha")
  })
})
