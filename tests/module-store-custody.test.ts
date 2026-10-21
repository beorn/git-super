/**
 * Removal destroys a slot's own `<git-dir>/modules/` tree. A module repository no gitlink in the slot's HEAD
 * names — a submodule dropped in a later commit, or an undeclared gitlink whose store uses another name — was
 * destroyed with its local branches, unpushed commits and stashes. The operator's value test (2026-10-21) says
 * work not on the store's remote main and not under an archive ref is value: archive it first, then remove.
 *
 * @failure A slot's module repository holding work nothing durable names is deleted with the slot; a store
 *          that is fully reproducible is destroyed without being named; or a failed archive does not stop it.
 * @level   l1
 * @consumer git-super worktree removal, bearly worktree remove, yrd environment close
 * @testonly none
 * @reach fs-walk <fixture-only: linked worktrees and module stores under mkdtempSync(canonicalTmpdir())>
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import {
  archiveModuleStores,
  describeModuleStores,
  inspectModuleStores,
  moduleStoreValue,
} from "../src/module-store-custody.ts"
import { superStatus } from "../src/status.ts"
import { createLocalGitWorktreeStore } from "../src/worktree.ts"
import { advanceRepository, canonicalTmpdir, createProductFixture, git } from "./fixture.ts"

const roots: string[] = []
const DATE = "2026-10-21"

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

/** A commit inside the slot's alpha checkout that nothing but this store holds. */
function localCommit(child: string): string {
  writeFileSync(join(child, "local.txt"), "bytes that exist only here\n")
  git(child, "add", "-A")
  git(child, "commit", "-q", "-m", "local work")
  return git(child, "rev-parse", "HEAD").trim()
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
  throw new Error("expected the removal to stop, and it proceeded")
}

describe("slot module store custody", () => {
  test("an unreferenced store holding local work is archived on its remote before removal", async () => {
    const slot = await linkedSlot(fixtureRoot("module-archive"))
    const tip = localCommit(slot.child)
    dropAlphaFromHead(slot.linked)
    const inventory = inspectModuleStores(slot.linked, slot.gitDir)
    expect(inventory.stores).toEqual([
      expect.objectContaining({ name: "packages/alpha", valueCommits: 1, remote: "origin", head: tip.slice(0, 12) }),
    ])
    const archived = archiveModuleStores(inventory.stores, { actor: "dev-test", date: DATE })
    expect(archived[0]!.archived).toEqual([`refs/archive/${DATE}/dev-test/packages/alpha/HEAD`])
    expect(git(slot.fixture.alpha, "rev-parse", `refs/archive/${DATE}/dev-test/packages/alpha/HEAD`).trim()).toBe(tip)
    expect(describeModuleStores(archived)).toEqual([
      `module store packages/alpha archived: 1 commit(s) to refs/archive/${DATE}/dev-test/packages/alpha/HEAD, HEAD ${tip.slice(0, 12)}`,
    ])
    await slot.store.remove(slot.linked)
    expect(existsSync(slot.linked)).toBe(false)
  })

  test("a store whose work is all on its remote main is released and named", async () => {
    const slot = await linkedSlot(fixtureRoot("module-released"))
    const tip = git(slot.child, "rev-parse", "HEAD").trim()
    dropAlphaFromHead(slot.linked)
    const inventory = inspectModuleStores(slot.linked, slot.gitDir)
    expect(inventory.stores).toEqual([
      expect.objectContaining({ name: "packages/alpha", valueCommits: 0, remote: "origin" }),
    ])
    const archived = archiveModuleStores(inventory.stores, { actor: "dev-test", date: DATE })
    expect(archived[0]!.archived).toEqual([])
    expect(describeModuleStores(archived)).toEqual([
      `module store packages/alpha released: origin main and archive refs hold it, 0 commits unique, HEAD ${tip.slice(0, 12)}`,
    ])
    await slot.store.remove(slot.linked)
    expect(existsSync(slot.linked)).toBe(false)
  })

  test("a commit only on another remote branch is value, not reproducible (operator value test)", async () => {
    const slot = await linkedSlot(fixtureRoot("module-other-branch"))
    const tip = localCommit(slot.child)
    git(slot.child, "push", "-q", "origin", "HEAD:refs/heads/side-work")
    git(slot.child, "fetch", "-q", "origin")
    dropAlphaFromHead(slot.linked)
    const value = moduleStoreValue(join(slot.modules, "packages/alpha"))
    expect(value.valueCommits).toBe(1)
    const archived = archiveModuleStores(inspectModuleStores(slot.linked, slot.gitDir).stores, {
      actor: "dev-test",
      date: DATE,
    })
    expect(archived[0]!.archived).toEqual([`refs/archive/${DATE}/dev-test/packages/alpha/HEAD`])
    expect(git(slot.fixture.alpha, "rev-parse", `refs/archive/${DATE}/dev-test/packages/alpha/HEAD`).trim()).toBe(tip)
  })

  test("a stash-only commit is value and is archived as its own entry", async () => {
    const slot = await linkedSlot(fixtureRoot("module-stash"))
    writeFileSync(join(slot.child, "alpha.ts"), "export const alpha = 999\n")
    git(slot.child, "stash", "push", "-q", "-m", "only in the stash")
    const stashTip = git(slot.child, "rev-parse", "refs/stash").trim()
    dropAlphaFromHead(slot.linked)
    const inventory = inspectModuleStores(slot.linked, slot.gitDir)
    expect(inventory.stores[0]!.valueCommits).toBeGreaterThan(0)
    expect(inventory.stores[0]!.refs).toContainEqual({ source: stashTip, label: "stash/1" })
    const archived = archiveModuleStores(inventory.stores, { actor: "dev-test", date: DATE })
    expect(archived[0]!.archived).toContain(`refs/archive/${DATE}/dev-test/packages/alpha/stash/1`)
    expect(git(slot.fixture.alpha, "rev-parse", `refs/archive/${DATE}/dev-test/packages/alpha/stash/1`).trim()).toBe(
      stashTip,
    )
  })

  test("an undeclared store under another name is archived under that name", async () => {
    const slot = await linkedSlot(fixtureRoot("module-undeclared"))
    const tip = localCommit(slot.child)
    dropAlphaFromHead(slot.linked)
    mkdirSync(join(slot.modules, "components"), { recursive: true })
    renameSync(join(slot.modules, "packages/alpha"), join(slot.modules, "components/outer"))
    const archived = archiveModuleStores(inspectModuleStores(slot.linked, slot.gitDir).stores, {
      actor: "dev-test",
      date: DATE,
    })
    expect(archived).toEqual([
      expect.objectContaining({ name: "components/outer", valueCommits: 1 }),
    ])
    expect(archived[0]!.archived).toEqual([`refs/archive/${DATE}/dev-test/components/outer/HEAD`])
    expect(git(slot.fixture.alpha, "rev-parse", `refs/archive/${DATE}/dev-test/components/outer/HEAD`).trim()).toBe(tip)
  })

  test("a fully mapped slot passes the inventory and still removes", async () => {
    const slot = await linkedSlot(fixtureRoot("module-mapped"))
    expect(inspectModuleStores(slot.linked, slot.gitDir)).toEqual({ stores: [] })
    await slot.store.remove(slot.linked)
    expect(existsSync(slot.linked)).toBe(false)
    expect(existsSync(slot.modules)).toBe(false)
  })

  test("an unreadable store stops removal before anything is deleted", async () => {
    const slot = await linkedSlot(fixtureRoot("module-unreadable"))
    dropAlphaFromHead(slot.linked)
    writeFileSync(join(slot.modules, "packages/alpha/config"), "not a git config\n")
    const message = refusal(() => inspectModuleStores(slot.linked, slot.gitDir))
    expect(message).toContain("worktree preserved")
    expect(message).toMatch(/unreadable refs|could not be read|could not be counted/)
  })

  test("a store holding value with no remote stops removal, naming the store", async () => {
    const slot = await linkedSlot(fixtureRoot("module-remoteless"))
    localCommit(slot.child)
    dropAlphaFromHead(slot.linked)
    const store = join(slot.modules, "packages/alpha")
    git(slot.fixture.product, "--git-dir", store, "config", "--remove-section", "remote.origin")
    const inventory = inspectModuleStores(slot.linked, slot.gitDir)
    expect(inventory.stores[0]!.remote).toBeUndefined()
    const message = refusal(() => archiveModuleStores(inventory.stores, { actor: "dev-test", date: DATE }))
    expect(message).toContain("module store packages/alpha holds 1 commit(s)")
    expect(message).toContain("has no remote to archive them to")
    expect(message).toContain("bundle create")
  })

  test("a caller-proved excluded store is never judged, and an unclaimed exclusion still stops removal", async () => {
    const slot = await linkedSlot(fixtureRoot("module-excluded"))
    const claimed = join(slot.modules, "packages/alpha")
    mkdirSync(join(slot.modules, "components"), { recursive: true })
    cpSync(claimed, join(slot.modules, "components/outer"), { recursive: true })
    expect(inspectModuleStores(slot.linked, slot.gitDir, [claimed]).stores).toEqual([
      expect.objectContaining({ name: "components/outer", valueCommits: 0 }),
    ])
    const message = refusal(() => inspectModuleStores(slot.linked, slot.gitDir, [claimed], ["vendor/private"]))
    expect(message).toContain("excluded vendor/private: target-owned store")
    expect(message).toContain("has no included parent identity")
  })

  test("an empty checkout whose store is on remote main holds nothing; a local commit there still refuses (30563)", async () => {
    const pushed = createProductFixture(fixtureRoot("module-status-pushed"))
    const pushedChild = join(pushed.product, "packages/alpha")
    const advanced = advanceRepository(pushed.alpha, "alpha.ts", "export const alpha = 42\n")
    git(pushedChild, "fetch", "-q", "origin")
    git(pushedChild, "checkout", "-q", advanced)
    rmSync(pushedChild, { recursive: true, force: true })
    const admitted = superStatus({ repo: pushed.product })
    expect(admitted.uninitializedSubmodules).toContain("packages/alpha")
    expect(admitted.submoduleProblems).toEqual([])

    const local = createProductFixture(fixtureRoot("module-status-local"))
    const localChild = join(local.product, "packages/alpha")
    writeFileSync(join(localChild, "local.txt"), "bytes that exist only here\n")
    git(localChild, "add", "-A")
    git(localChild, "commit", "-q", "-m", "local work")
    rmSync(localChild, { recursive: true, force: true })
    const stopped = superStatus({ repo: local.product })
    expect(stopped.uninitializedSubmodules).toEqual([])
    expect(stopped.submoduleProblems).toHaveLength(1)
    expect(stopped.submoduleProblems[0]!.reason).toContain("holds 1 commit(s) that neither its remote main")
    expect(stopped.submoduleProblems[0]!.reason).toContain("submodule update --init packages/alpha")
  })
})
