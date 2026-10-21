/**
 * Removal destroys a slot's own `<git-dir>/modules/` tree. A module repository no gitlink in the slot's HEAD
 * names — a submodule dropped in a later commit, or an undeclared gitlink whose store uses another name — was
 * destroyed with its local branches, unpushed commits and stashes. The operator's value test (2026-10-21) says
 * work not on the store's remote main and not under an archive ref is value: archive it first, then remove.
 *
 * @failure A slot's module repository holding work nothing durable names is deleted with the slot; a store
 *          that is fully reproducible is destroyed without being named; value is judged from the store's own
 *          stale copies instead of its remote; or a failed archive or remote read does not stop it.
 * @level   l1
 * @consumer git-super worktree removal, bearly worktree remove, yrd environment close
 * @testonly none
 * @reach fs-walk <fixture-only: linked worktrees and module stores under mkdtempSync(canonicalTmpdir())>
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"
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

/** Land the child's HEAD on its remote's checked-out branch, as merging it upstream does; the store never fetches back. */
function landOnRemote(remote: string, child: string): void {
  git(remote, "fetch", "-q", child, "HEAD")
  git(remote, "merge", "-q", "--ff-only", "FETCH_HEAD")
}

/** Read a store directly, since its checkout is gone once the slot drops it. */
function storeGitOutput(cwd: string, store: string, ...args: string[]): string {
  return git(cwd, "--git-dir", store, "--bare", ...args)
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
    // The plan line an inspection prints before any push never claims the archive has happened.
    expect(describeModuleStores(inventory.stores)).toEqual([
      `module store packages/alpha holds 1 commit(s) to archive, HEAD ${tip.slice(0, 12)}`,
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
      `module store packages/alpha released: origin main, archive refs and tags hold it, 0 commits unique, HEAD ${tip.slice(0, 12)}`,
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

  test("work the remote's main took after the store last fetched is released, read from the remote (row 1)", async () => {
    const slot = await linkedSlot(fixtureRoot("module-remote-ahead"))
    const store = join(slot.modules, "packages/alpha")
    const stale = git(slot.child, "rev-parse", "refs/remotes/origin/main")
    const tip = localCommit(slot.child)
    landOnRemote(slot.fixture.alpha, slot.child)
    const beyond = advanceRepository(slot.fixture.alpha, "alpha.ts", "export const alpha = 7\n")
    dropAlphaFromHead(slot.linked)
    expect(storeGitOutput(slot.fixture.product, store, "rev-parse", "refs/remotes/origin/main")).toBe(stale)
    expect(() => storeGitOutput(slot.fixture.product, store, "cat-file", "-e", beyond)).toThrow()
    const inventory = inspectModuleStores(slot.linked, slot.gitDir)
    expect(inventory.stores).toEqual([
      expect.objectContaining({ name: "packages/alpha", valueCommits: 0, defaultBranch: "main" }),
    ])
    // The read fetched the missing tip's objects only; the store's own tracking ref is left as it was.
    expect(storeGitOutput(slot.fixture.product, store, "cat-file", "-t", beyond)).toBe("commit")
    expect(storeGitOutput(slot.fixture.product, store, "rev-parse", "refs/remotes/origin/main")).toBe(stale)
    expect(describeModuleStores(archiveModuleStores(inventory.stores, { actor: "dev-test", date: DATE }))).toEqual([
      `module store packages/alpha released: origin main, archive refs and tags hold it, 0 commits unique, HEAD ${tip.slice(0, 12)}`,
    ])
  })

  test("a remote whose default branch is master is measured against master, not a local main (row 1)", async () => {
    const slot = await linkedSlot(fixtureRoot("module-remote-master"))
    const tip = localCommit(slot.child)
    git(slot.fixture.alpha, "branch", "-m", "main", "master")
    landOnRemote(slot.fixture.alpha, slot.child)
    dropAlphaFromHead(slot.linked)
    const inventory = inspectModuleStores(slot.linked, slot.gitDir)
    expect(inventory.stores).toEqual([
      expect.objectContaining({ name: "packages/alpha", valueCommits: 0, defaultBranch: "master" }),
    ])
    expect(describeModuleStores(inventory.stores)).toEqual([
      `module store packages/alpha released: origin master, archive refs and tags hold it, 0 commits unique, HEAD ${tip.slice(0, 12)}`,
    ])
  })

  test("a commit only a local archive ref holds is value, because the remote does not hold it (row 1)", async () => {
    const slot = await linkedSlot(fixtureRoot("module-local-archive"))
    const tip = localCommit(slot.child)
    git(slot.child, "update-ref", `refs/archive/${DATE}/someone/kept`, tip)
    // HEAD leaves the commit, so nothing but the local archive ref holds it.
    git(slot.child, "checkout", "-q", "--detach", "HEAD~1")
    dropAlphaFromHead(slot.linked)
    const inventory = inspectModuleStores(slot.linked, slot.gitDir)
    expect(inventory.stores[0]!.valueCommits).toBe(1)
    const archived = archiveModuleStores(inventory.stores, { actor: "dev-test", date: DATE })
    const kept = `refs/archive/${DATE}/dev-test/packages/alpha/archive/${DATE}/someone/kept`
    expect(archived[0]!.archived).toEqual([kept])
    expect(git(slot.fixture.alpha, "rev-parse", kept).trim()).toBe(tip)
  })

  test("a second archive the same day never replaces the first; the new one takes its short id (row 1)", async () => {
    const slot = await linkedSlot(fixtureRoot("module-archive-twice"))
    const earlier = `refs/archive/${DATE}/dev-test/packages/alpha/HEAD`
    const first = localCommit(slot.child)
    git(slot.child, "push", "-q", "origin", `HEAD:${earlier}`)
    writeFileSync(join(slot.child, "second.txt"), "more bytes that exist only here\n")
    git(slot.child, "add", "-A")
    git(slot.child, "commit", "-q", "-m", "second local work")
    const second = git(slot.child, "rev-parse", "HEAD").trim()
    dropAlphaFromHead(slot.linked)
    const archived = archiveModuleStores(inspectModuleStores(slot.linked, slot.gitDir).stores, {
      actor: "dev-test",
      date: DATE,
    })
    expect(archived[0]!.archived).toEqual([`${earlier}-${second.slice(0, 12)}`])
    expect(git(slot.fixture.alpha, "rev-parse", earlier).trim()).toBe(first)
    expect(git(slot.fixture.alpha, "rev-parse", `${earlier}-${second.slice(0, 12)}`).trim()).toBe(second)
  })

  test("a commit the remote holds only under refs/archive is released (row 1)", async () => {
    const slot = await linkedSlot(fixtureRoot("module-remote-archive"))
    const store = join(slot.modules, "packages/alpha")
    const tip = localCommit(slot.child)
    git(slot.child, "push", "-q", "origin", "HEAD:refs/archive/2026-10-01/someone/packages/alpha/HEAD")
    dropAlphaFromHead(slot.linked)
    expect(storeGitOutput(slot.fixture.product, store, "for-each-ref", "refs/archive")).toBe("")
    const inventory = inspectModuleStores(slot.linked, slot.gitDir)
    expect(inventory.stores).toEqual([expect.objectContaining({ name: "packages/alpha", valueCommits: 0 })])
    expect(describeModuleStores(inventory.stores)).toEqual([
      `module store packages/alpha released: origin main, archive refs and tags hold it, 0 commits unique, HEAD ${tip.slice(0, 12)}`,
    ])
  })

  test("a local tag the remote holds is released, and a local-only tag is archived (row 1)", async () => {
    const slot = await linkedSlot(fixtureRoot("module-tags"))
    // An annotated tag the remote holds: ls-remote lists its tag object, and its commit under `^{}`.
    localCommit(slot.child)
    git(slot.child, "tag", "-a", "-m", "published", "v-published")
    git(slot.child, "push", "-q", "origin", "refs/tags/v-published")
    writeFileSync(join(slot.child, "preserved.txt"), "bytes only a local tag holds\n")
    git(slot.child, "add", "-A")
    git(slot.child, "commit", "-q", "-m", "preserved work")
    const preserved = git(slot.child, "rev-parse", "HEAD").trim()
    git(slot.child, "tag", "preserve/kept")
    git(slot.child, "checkout", "-q", "--detach", "HEAD~1")
    dropAlphaFromHead(slot.linked)
    const inventory = inspectModuleStores(slot.linked, slot.gitDir)
    expect(inventory.stores[0]).toEqual(
      expect.objectContaining({
        valueCommits: 1,
        refs: [{ source: "refs/tags/preserve/kept", label: "tags/preserve/kept" }],
      }),
    )
    const kept = `refs/archive/${DATE}/dev-test/packages/alpha/tags/preserve/kept`
    expect(archiveModuleStores(inventory.stores, { actor: "dev-test", date: DATE })[0]!.archived).toEqual([kept])
    expect(git(slot.fixture.alpha, "rev-parse", kept).trim()).toBe(preserved)
  })

  test("a store's archive lands whole or not at all: one rejected ref keeps every other ref off the remote", async () => {
    const slot = await linkedSlot(fixtureRoot("module-push-atomic"))
    localCommit(slot.child)
    git(slot.child, "branch", "side")
    dropAlphaFromHead(slot.linked)
    // An update hook judges each ref alone, so without an atomic push the HEAD archive would land by itself.
    writeFileSync(
      join(slot.fixture.alpha, ".git", "hooks", "update"),
      "#!/bin/sh\ncase \"$1\" in */heads/side) echo 'side refused' >&2; exit 1;; esac\n",
      { mode: 0o755 },
    )
    const stores = inspectModuleStores(slot.linked, slot.gitDir).stores
    expect(stores[0]!.refs.map((ref) => ref.label)).toEqual(["HEAD", "heads/side"])
    expect(refusal(() => archiveModuleStores(stores, { actor: "dev-test", date: DATE }))).toContain(
      "worktree preserved after archiving nothing",
    )
    expect(git(slot.fixture.alpha, "for-each-ref", "refs/archive")).toBe("")
  })

  test("a remote that cannot be read stops removal, naming the store, with no fallback to local copies (row 1)", async () => {
    const root = fixtureRoot("module-remote-unreadable")
    const slot = await linkedSlot(root)
    const store = join(slot.modules, "packages/alpha")
    dropAlphaFromHead(slot.linked)
    storeGitOutput(slot.fixture.product, store, "config", "remote.origin.url", join(root, "gone"))
    const message = refusal(() => inspectModuleStores(slot.linked, slot.gitDir))
    expect(message).toContain(`module store ${store} could not be read: its remote origin did not answer ls-remote`)
    expect(message).toContain("worktree preserved")
    await expect(slot.store.remove(slot.linked)).rejects.toThrow(/did not answer ls-remote/)
    expect(existsSync(slot.linked)).toBe(true)
    expect(existsSync(store)).toBe(true)
  })

  test("with no report sink an archive line goes to stderr and a release prints nothing; a sink gets both", async () => {
    const archivedSlot = await linkedSlot(fixtureRoot("module-stderr-archive"))
    const tip = localCommit(archivedSlot.child)
    dropAlphaFromHead(archivedSlot.linked)
    const releasedSlot = await linkedSlot(fixtureRoot("module-stderr-release"))
    dropAlphaFromHead(releasedSlot.linked)
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    let written: string[]
    try {
      await archivedSlot.store.remove(archivedSlot.linked)
      await releasedSlot.store.remove(releasedSlot.linked)
      written = stderr.mock.calls.map(([chunk]) => String(chunk)).filter((line) => line.startsWith("module store"))
    } finally {
      stderr.mockRestore()
    }
    expect(written).toEqual([
      expect.stringMatching(
        new RegExp(
          // With no archiveActor the slot's own checkout name is the actor, never a library name.
          `^module store packages/alpha archived: 1 commit\\(s\\) to refs/archive/\\d{4}-\\d{2}-\\d{2}/slot/packages/alpha/HEAD, HEAD ${tip.slice(0, 12)}\\n$`,
          "u",
        ),
      ),
    ])
    const sunk = await linkedSlot(fixtureRoot("module-sink-release"))
    const sunkTip = git(sunk.child, "rev-parse", "HEAD")
    dropAlphaFromHead(sunk.linked)
    const sink: string[] = []
    await createLocalGitWorktreeStore({ repo: sunk.fixture.product, report: (line) => sink.push(line) }).remove(
      sunk.linked,
    )
    expect(sink.filter((line) => line.startsWith("module store"))).toEqual([
      `module store packages/alpha released: origin main, archive refs and tags hold it, 0 commits unique, HEAD ${sunkTip.slice(0, 12)}\n`,
    ])
  })

  test("recovering a destroyed slot archives every store's value, declared or not, before its registration goes", async () => {
    const slot = await linkedSlot(fixtureRoot("module-destroyed"))
    // packages/alpha is still declared at HEAD, but no checkout is left to consult its store.
    const tip = localCommit(slot.child)
    // The remote's main moves on, so the value read must fetch into a store whose checkout path is gone.
    advanceRepository(slot.fixture.alpha, "alpha.ts", "export const alpha = 8\n")
    renameSync(slot.linked, `${slot.linked}-moved`)
    const sink: string[] = []
    await createLocalGitWorktreeStore({
      repo: slot.fixture.product,
      report: (line) => sink.push(line),
    }).recoverDestroyed(slot.linked)
    expect(await slot.store.inspect(slot.linked)).toEqual({ registered: false })
    expect(existsSync(slot.gitDir)).toBe(false)
    const lines = sink.filter((line) => line.startsWith("module store"))
    // The registration id names the actor, since no checkout is left to name it.
    expect(lines).toEqual([
      expect.stringMatching(/^module store packages\/alpha archived: 1 commit\(s\) to refs\/archive\/[\d-]+\/slot\//u),
    ])
    const archiveRef = /refs\/archive\/\S+\/packages\/alpha\/HEAD/u.exec(lines[0] ?? "")?.[0] ?? "no archive ref named"
    expect(git(slot.fixture.alpha, "rev-parse", archiveRef)).toBe(tip)
  })

  test("recovering a destroyed slot whose store's remote cannot be read keeps the registration", async () => {
    const root = fixtureRoot("module-destroyed-unreadable")
    const slot = await linkedSlot(root)
    const store = join(slot.modules, "packages/alpha")
    storeGitOutput(slot.fixture.product, store, "config", "remote.origin.url", join(root, "gone"))
    renameSync(slot.linked, `${slot.linked}-moved`)
    await expect(slot.store.recoverDestroyed(slot.linked)).rejects.toThrow(/did not answer ls-remote/)
    expect(existsSync(store)).toBe(true)
    expect(await slot.store.inspect(slot.linked)).toEqual(expect.objectContaining({ registered: true }))
  })

  test("prune recovers a destroyed slot, archiving its store's value first, and leaves a live slot (30616)", async () => {
    const root = fixtureRoot("module-prune")
    const slot = await linkedSlot(root)
    const tip = localCommit(slot.child)
    const live = join(root, "live")
    await slot.store.add({ kind: "detached", path: live, ref: "HEAD" })
    // Something other than git-super deleted the checkout, so only its registration still holds its stores.
    renameSync(slot.linked, `${slot.linked}-moved`)
    const sink: string[] = []
    await createLocalGitWorktreeStore({ repo: slot.fixture.product, report: (line) => sink.push(line) }).prune()
    expect(await slot.store.inspect(slot.linked)).toEqual({ registered: false })
    expect(existsSync(slot.gitDir)).toBe(false)
    expect(await slot.store.inspect(live)).toEqual(expect.objectContaining({ registered: true }))
    const lines = sink.filter((line) => line.startsWith("module store"))
    expect(lines).toEqual([expect.stringMatching(/^module store packages\/alpha archived: 1 commit\(s\) to /u)])
    const archiveRef = /refs\/archive\/\S+\/packages\/alpha\/HEAD/u.exec(lines[0] ?? "")?.[0] ?? "no archive ref named"
    expect(git(slot.fixture.alpha, "rev-parse", archiveRef)).toBe(tip)
  })

  test("prune keeps and names a destroyed slot it cannot recover, and still recovers the others (30616)", async () => {
    const root = fixtureRoot("module-prune-unreadable")
    const slot = await linkedSlot(root)
    const store = join(slot.modules, "packages/alpha")
    // Write the store's config file directly: an older git enters its core.worktree even under --git-dir --bare.
    git(slot.fixture.product, "config", "--file", join(store, "config"), "remote.origin.url", join(root, "gone"))
    const other = join(root, "other")
    await slot.store.add({ kind: "detached", path: other, ref: "HEAD" })
    renameSync(slot.linked, `${slot.linked}-moved`)
    renameSync(other, `${other}-moved`)
    const message = await slot.store.prune().then(
      () => "prune proceeded",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
    expect(message).toContain(`worktree ${slot.linked}`)
    expect(message).toContain("did not answer ls-remote")
    expect(existsSync(store)).toBe(true)
    expect(await slot.store.inspect(slot.linked)).toEqual(expect.objectContaining({ registered: true }))
    expect(await slot.store.inspect(other)).toEqual({ registered: false })
  })

  test("prune keeps a destroyed slot whose detached HEAD no ref holds, and names that HEAD (30616)", async () => {
    const slot = await linkedSlot(fixtureRoot("module-prune-detached"))
    // recoverDestroyed archives module stores, never the slot's own HEAD, so this commit has no other copy.
    git(slot.linked, "commit", "-q", "--allow-empty", "-m", "work only this slot's HEAD holds")
    const head = git(slot.linked, "rev-parse", "HEAD").trim()
    renameSync(slot.linked, `${slot.linked}-moved`)
    const message = await slot.store.prune().then(
      () => "prune proceeded",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
    expect(message).toContain(`worktree ${slot.linked}: detached HEAD ${head.slice(0, 12)} held by no ref`)
    expect(existsSync(slot.gitDir)).toBe(true)
    expect(await slot.store.inspect(slot.linked)).toEqual(expect.objectContaining({ registered: true }))
  })

  test("an archive push the remote rejects stops removal, naming the store, and the slot stays", async () => {
    const slot = await linkedSlot(fixtureRoot("module-push-rejected"))
    localCommit(slot.child)
    dropAlphaFromHead(slot.linked)
    const hook = join(slot.fixture.alpha, ".git", "hooks", "pre-receive")
    writeFileSync(hook, "#!/bin/sh\necho 'archive refused by fixture' >&2\nexit 1\n", { mode: 0o755 })
    const message = refusal(() =>
      archiveModuleStores(inspectModuleStores(slot.linked, slot.gitDir).stores, { actor: "dev-test", date: DATE }),
    )
    expect(message).toContain("module store packages/alpha could not be archived: git push")
    expect(message).toContain("worktree preserved after archiving nothing")
    await expect(slot.store.remove(slot.linked)).rejects.toThrow(/could not be archived/)
    expect(existsSync(slot.linked)).toBe(true)
    expect(existsSync(join(slot.modules, "packages/alpha"))).toBe(true)
  })

  test("a later store's rejected push still reports, and names, the archive an earlier store made", async () => {
    const root = fixtureRoot("module-push-second-rejected")
    const slot = await linkedSlot(root)
    localCommit(slot.child)
    dropAlphaFromHead(slot.linked)
    // A second undeclared store whose own remote refuses every push.
    const refusing = join(root, "refusing-remote")
    cpSync(slot.fixture.alpha, refusing, { recursive: true })
    writeFileSync(join(refusing, ".git", "hooks", "pre-receive"), "#!/bin/sh\necho 'refused' >&2\nexit 1\n", {
      mode: 0o755,
    })
    const zeta = join(slot.modules, "packages/zeta")
    cpSync(join(slot.modules, "packages/alpha"), zeta, { recursive: true })
    storeGitOutput(slot.fixture.product, zeta, "config", "remote.origin.url", refusing)
    const sink: string[] = []
    const removal = createLocalGitWorktreeStore({
      repo: slot.fixture.product,
      report: (line) => sink.push(line),
    }).remove(slot.linked)
    await expect(removal).rejects.toThrow(
      /module store packages\/zeta could not be archived: [\s\S]*worktree preserved after archiving refs\/archive\/[\d-]+\/slot\/packages\/alpha\/HEAD$/u,
    )
    expect(sink.filter((line) => line.startsWith("module store"))).toEqual([
      expect.stringMatching(/^module store packages\/alpha archived: 1 commit\(s\) to refs\/archive\/[\d-]+\/slot\//u),
    ])
    expect(existsSync(slot.linked)).toBe(true)
    expect(existsSync(zeta)).toBe(true)
  })

  test("a GIT_COMMON_DIR or GIT_OBJECT_DIRECTORY a git hook exports never redirects the value read", async () => {
    const slot = await linkedSlot(fixtureRoot("module-hook-environment"))
    const tip = localCommit(slot.child)
    dropAlphaFromHead(slot.linked)
    const outer = join(slot.fixture.product, ".git")
    vi.stubEnv("GIT_COMMON_DIR", outer)
    vi.stubEnv("GIT_OBJECT_DIRECTORY", join(outer, "objects"))
    let stores: ReturnType<typeof inspectModuleStores>["stores"]
    try {
      stores = inspectModuleStores(slot.linked, slot.gitDir).stores
    } finally {
      vi.unstubAllEnvs()
    }
    expect(stores).toEqual([
      expect.objectContaining({ name: "packages/alpha", valueCommits: 1, head: tip.slice(0, 12) }),
    ])
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
    expect(archived).toEqual([expect.objectContaining({ name: "components/outer", valueCommits: 1 })])
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
    // With no remote nothing proves any commit exists elsewhere: the base commit its leftover local
    // `refs/remotes/origin/main` names counts too, because that copy is not a remote.
    expect(message).toContain("module store packages/alpha holds 2 commit(s)")
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
    // The same store with a remote that cannot be read is unknown, never "holds nothing".
    const pushedStore = join(pushed.product, ".git/modules/packages/alpha")
    // Write the store's config file directly: its core.worktree names the removed checkout, and an older
    // git (CI's ubuntu-latest) still enters it under --git-dir --bare and dies with "cannot chdir".
    git(
      pushed.product,
      "config",
      "--file",
      join(pushedStore, "config"),
      "remote.origin.url",
      join(pushed.alpha, "..", "gone"),
    )
    const unread = superStatus({ repo: pushed.product })
    expect(unread.uninitializedSubmodules).not.toContain("packages/alpha")
    expect(unread.submoduleProblems).toHaveLength(1)
    expect(unread.submoduleProblems[0]!.reason).toContain("what it holds is unknown")
    expect(unread.submoduleProblems[0]!.reason).toContain("did not answer ls-remote")

    const local = createProductFixture(fixtureRoot("module-status-local"))
    const localChild = join(local.product, "packages/alpha")
    writeFileSync(join(localChild, "local.txt"), "bytes that exist only here\n")
    git(localChild, "add", "-A")
    git(localChild, "commit", "-q", "-m", "local work")
    rmSync(localChild, { recursive: true, force: true })
    const stopped = superStatus({ repo: local.product })
    expect(stopped.uninitializedSubmodules).toEqual([])
    expect(stopped.submoduleProblems).toHaveLength(1)
    expect(stopped.submoduleProblems[0]!.reason).toContain(
      "holds 1 commit(s) that neither its remote's default branch nor any archive ref there holds (remote origin main)",
    )
    expect(stopped.submoduleProblems[0]!.reason).toContain("submodule update --init packages/alpha")
  })
})
