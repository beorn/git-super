import { existsSync, lstatSync, readdirSync, type Dirent } from "node:fs"
import { isAbsolute, join, relative, sep } from "node:path"
import { spawnSync } from "node:child_process"
import { archiveRefFor } from "./archive-ref.ts"

/**
 * A module repository under a slot's own `<git-dir>/modules/`, which removal destroys with the slot, and the
 * work it holds that nothing durable names. The operator's value test (2026-10-21) decides what happens to it:
 * work not on the store's remote main and not under an archive ref is value — archive it first, then remove.
 */
export type ModuleStore = Readonly<{
  /** The store's path relative to `modules/`: git's own submodule name, or the path default. */
  name: string
  gitDir: string
  /** Short HEAD, so a report names the same commit a reader sees in `git log`. */
  head?: string
  /** The remote that will hold the archive, when the store has one. */
  remote?: string
  /** Commits the store's own refs hold that its remote main and archive refs do not. */
  valueCommits: number
  /** The refs holding those commits, with the archive name each is pushed under. */
  refs: readonly Readonly<{ source: string; label: string }>[]
  /** Archive refs this removal created, in the order they were pushed. */
  archived: readonly string[]
}>

/** What one removal's module-store inspection found, before anything is pushed or deleted. */
export type ModuleInventory = Readonly<{ stores: readonly ModuleStore[] }>

/** Where an archive push may land: the store's remote, the day, and the actor that owns the ref. */
export type ModuleArchiveTarget = Readonly<{ actor: string; date: string }>

type Capture = Readonly<{ status: number; stdout: string; stderr: string }>

const STORE_TIMEOUT_MS = 30_000
const ARCHIVE_PUSH_TIMEOUT_MS = 120_000

/**
 * A store's `core.worktree` points at a checkout that removal may already have emptied or deleted, so every
 * read is `--bare` against the store itself. A store that does not answer inside the bound is unreadable,
 * never empty (fail closed).
 */
function storeGit(gitDir: string, args: readonly string[], timeout = STORE_TIMEOUT_MS): Capture {
  const result = spawnSync("git", ["--git-dir", gitDir, "--bare", ...args], { encoding: "utf8", timeout })
  if (result.error !== undefined) {
    throw new Error(
      `module store ${gitDir} could not be read (git ${args[0] ?? ""}: ${result.error.message}); worktree preserved`,
      { cause: result.error },
    )
  }
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

function within(parent: string, candidate: string): boolean {
  const part = relative(parent, candidate)
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part))
}

function isStore(path: string): boolean {
  return existsSync(join(path, "HEAD")) && existsSync(join(path, "objects")) && existsSync(join(path, "config"))
}

function readEntries(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true })
  } catch (error) {
    throw new Error(
      `module directory ${path} could not be read, so the slot's stores are unknown: ${error instanceof Error ? error.message : String(error)}; worktree preserved`,
      { cause: error },
    )
  }
}

/**
 * Every entry under `modules/`, in git's own layout: a directory holding HEAD, objects/ and config is a module
 * repository, and the walk never descends into one (nested submodules live at `<store>/modules/` and ride with
 * that store). Namespace directories between the root and a store are transparent; anything else is handed back
 * as a non-store entry rather than guessed at.
 */
function* moduleEntries(root: string, path = root): Generator<Readonly<{ name: string; path: string; store: boolean }>> {
  for (const entry of readEntries(path)) {
    const candidate = join(path, entry.name)
    if (!entry.isDirectory()) {
      yield { name: relative(root, candidate), path: candidate, store: false }
      continue
    }
    if (isStore(candidate)) {
      yield { name: relative(root, candidate), path: candidate, store: true }
      continue
    }
    // An empty namespace directory holds nothing, so it is safe to release with the slot; a directory with
    // contents recurses, and anything inside it that is not a store still refuses.
    yield* moduleEntries(root, candidate)
  }
}

function refsMatching(gitDir: string, prefixes: readonly string[]): string[] {
  const listed = storeGit(gitDir, ["for-each-ref", "--format=%(refname)", ...prefixes])
  if (listed.status !== 0) {
    throw new Error(`module store ${gitDir} has unreadable refs (${listed.stderr.trim()}); worktree preserved`)
  }
  return listed.stdout.split("\n").filter((ref) => ref.trim() !== "")
}

/** The durable refs the value test subtracts: the store's remote main and any archive ref, local or fetched. */
function durableRefs(gitDir: string): string[] {
  return refsMatching(gitDir, ["refs/remotes", "refs/archive"]).filter(
    (ref) => /^refs\/remotes\/[^/]+\/main$/u.test(ref) || /(?:^|\/)archive\//u.test(ref),
  )
}

/** The store's own refs that could hold work: HEAD, every branch, every tag, and every stash entry. */
function localRefs(gitDir: string): string[] {
  const refs = refsMatching(gitDir, ["refs/heads", "refs/tags"])
  const head = storeGit(gitDir, ["rev-parse", "--verify", "--quiet", "HEAD"])
  const headTip = head.status === 0 ? head.stdout.trim() : ""
  // Stash entries are commits reachable only through refs/stash's reflog, so its tip alone is not enough.
  const hasStash = storeGit(gitDir, ["reflog", "exists", "refs/stash"])
  const stash: string[] = []
  if (hasStash.status === 0) {
    const entries = storeGit(gitDir, ["reflog", "show", "--format=%H", "refs/stash"])
    if (entries.status !== 0) {
      throw new Error(
        `module store ${gitDir} has an unreadable stash reflog (${entries.stderr.trim()}); worktree preserved`,
      )
    }
    for (const [index, sha] of entries.stdout.split("\n").filter((line) => line.trim() !== "").entries()) {
      stash.push(`${sha.trim()}|stash/${String(index + 1)}`)
    }
  } else if (hasStash.status !== 1) {
    throw new Error(`module store ${gitDir} has an unreadable stash ref (${hasStash.stderr.trim()}); worktree preserved`)
  }
  // `source|archive-name`; a stash has no ref name of its own, so its commit is pushed under a numbered name.
  return [
    ...(headTip === "" ? [] : [`${headTip}|HEAD`]),
    ...refs.map((ref) => `${ref}|${ref.replace(/^refs\/(heads|tags)\//u, "$1/")}`),
    ...stash,
  ]
}

/** The remote an archive may be pushed to: `origin` when configured, otherwise the one configured remote. */
function storeRemote(gitDir: string): string | undefined {
  const remotes = storeGit(gitDir, ["config", "--get-regexp", "^remote\\..*\\.url$"])
  if (remotes.status !== 0) return undefined
  const names = remotes.stdout
    .split("\n")
    .map((line) => /^remote\.([^.]+)\.url\b/u.exec(line.trim())?.[1])
    .filter((name): name is string => name !== undefined && name !== "")
  return names.includes("origin") ? "origin" : names[0]
}

function count(gitDir: string, wants: readonly string[], exclusions: readonly string[]): number {
  if (wants.length === 0) return 0
  const args = ["rev-list", "--count", ...wants, ...(exclusions.length === 0 ? [] : ["--not", ...exclusions])]
  const counted = storeGit(gitDir, args)
  if (counted.status !== 0) {
    throw new Error(`module store ${gitDir} could not be counted (${counted.stderr.trim()}); worktree preserved`)
  }
  const value = Number.parseInt(counted.stdout.trim(), 10)
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `module store ${gitDir} reported no usable commit count (${JSON.stringify(counted.stdout)}); worktree preserved`,
    )
  }
  return value
}

/**
 * The one value predicate removal and #30563's status check share (operator 2026-10-21): the commits a store's
 * own refs hold that are not reachable from its remote main or from any archive ref. A store with no
 * remote-tracking refs and no archive refs has nothing proving its bytes exist elsewhere, so every commit it
 * holds counts as value.
 */
export function moduleStoreValue(
  gitDir: string,
): Readonly<{
  valueCommits: number
  refs: readonly Readonly<{ source: string; label: string }>[]
  remote?: string
  head?: string
}> {
  const exclusions = durableRefs(gitDir)
  const local = localRefs(gitDir)
  const chart = local.map((entry) => {
    const [source, label] = entry.split("|")
    if (source === undefined || label === undefined) throw new Error(`module store ${gitDir}: malformed ref entry`)
    return { source, label, value: count(gitDir, [source], exclusions) }
  })
  const valueCommits = count(
    gitDir,
    local.map((entry) => entry.split("|")[0] ?? ""),
    exclusions,
  )
  const head = storeGit(gitDir, ["rev-parse", "--verify", "--quiet", "HEAD"])
  const headShort = head.status === 0 && head.stdout.trim() !== "" ? head.stdout.trim().slice(0, 12) : undefined
  const remote = storeRemote(gitDir)
  return {
    valueCommits,
    refs: chart
      .filter((entry) => entry.value > 0)
      .map((entry) => ({ source: entry.source, label: entry.label })),
    ...(remote === undefined ? {} : { remote }),
    ...(headShort === undefined ? {} : { head: headShort }),
  }
}

/** The one predicate #30563's surviving-repository check uses: a store holds nothing of value at 0. */
export function moduleStoreValueCommits(gitDir: string): number {
  return moduleStoreValue(gitDir).valueCommits
}

/** The module names a slot's own HEAD declares, read from the committed `.gitmodules` rather than a working file. */
function headModuleNames(checkout: string): string[] {
  const blob = spawnSync("git", ["-C", checkout, "cat-file", "-e", "HEAD:.gitmodules"], {
    encoding: "utf8",
    timeout: STORE_TIMEOUT_MS,
  })
  // 128 is git's answer for a commit that carries no `.gitmodules` at all: no declarations, not unreadable.
  if (blob.status !== 0) {
    if (blob.status === 128 && blob.error === undefined) return []
    throw new Error(
      `HEAD:.gitmodules in ${checkout} could not be read, so the slot's own stores are unknown: ${(blob.error?.message ?? blob.stderr ?? "").trim()}; worktree preserved`,
      { cause: blob.error },
    )
  }
  const listing = spawnSync(
    "git",
    ["-C", checkout, "config", "-z", "--blob", "HEAD:.gitmodules", "--get-regexp", "^submodule\\..*\\.path$"],
    { encoding: "utf8", timeout: STORE_TIMEOUT_MS },
  )
  // Exit 1 means the commit declares no submodule paths; any other failure leaves the declarations unread.
  if (listing.status !== 0 && listing.status !== 1) {
    throw new Error(
      `HEAD:.gitmodules in ${checkout} could not be parsed, so the slot's own stores are unknown: ${(listing.error?.message ?? listing.stderr ?? "").trim()}; worktree preserved`,
      { cause: listing.error },
    )
  }
  const names: string[] = []
  for (const record of (listing.stdout ?? "").split("\0")) {
    const newline = record.indexOf("\n")
    if (newline < 0) continue
    const name = record
      .slice(0, newline)
      .replace(/^submodule\./u, "")
      .replace(/\.path$/u, "")
    if (name !== "") names.push(name)
  }
  return names
}

/** Each declared module's own store inside this slot, whether or not its checkout still exists. */
function referencedModuleStores(checkout: string): string[] {
  const stores: string[] = []
  for (const name of headModuleNames(checkout)) {
    const resolved = spawnSync(
      "git",
      ["-C", checkout, "rev-parse", "--path-format=absolute", "--git-path", `modules/${name}`],
      { encoding: "utf8", timeout: STORE_TIMEOUT_MS },
    )
    if (resolved.status !== 0) {
      throw new Error(
        `module store for declared submodule ${name} could not be resolved in ${checkout}: ${(resolved.error?.message ?? resolved.stderr ?? "").trim()}; worktree preserved`,
        { cause: resolved.error },
      )
    }
    const store = (resolved.stdout ?? "").trim()
    if (store === "" || !isAbsolute(store)) {
      throw new Error(
        `module store for declared submodule ${name} resolved to ${JSON.stringify(store)} in ${checkout}; worktree preserved`,
      )
    }
    if (existsSync(store)) stores.push(store)
  }
  return stores
}

/**
 * Enumerate a slot's own `modules/` inventory before removal, on every removal. The stores HEAD's `.gitmodules`
 * declares are the ones status consults, so they are skipped here. Every other module repository is reported
 * with the work it holds that its remote main and archive refs do not: value to archive, or nothing to discard.
 * A non-store entry, an unreadable store, and an unclaimed excluded store still stop removal and preserve the slot.
 *
 * `excludedStores` are paths a caller has already taken custody of; they are never judged here.
 *
 * `unclaimedExclusions` are excluded paths with no declaration identity left at HEAD and nothing on disk. A
 * caller's custody claim cannot reach a store nothing names, so any unreferenced store here stays unclaimed and
 * refuses exactly as before 30580 rather than being judged on the caller's behalf.
 */
export function inspectModuleStores(
  checkout: string,
  gitDir: string,
  excludedStores: readonly string[] = [],
  unclaimedExclusions: readonly string[] = [],
): ModuleInventory {
  const modules = join(gitDir, "modules")
  const state = lstatSync(modules, { throwIfNoEntry: false })
  if (state === undefined) return { stores: [] }
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw new Error(
      `worktree module directory ${modules} is not a directory; worktree preserved before store inspection`,
    )
  }
  const skipped = [...referencedModuleStores(checkout), ...excludedStores]
  const stores: ModuleStore[] = []
  for (const entry of moduleEntries(modules)) {
    if (skipped.some((store) => within(entry.path, store))) continue
    if (!entry.store) {
      throw new Error(
        `worktree module entry ${entry.path} is not a Git store; worktree preserved so its contents can be inspected and moved deliberately`,
      )
    }
    if (unclaimedExclusions.length > 0) {
      throw new Error(
        `excluded ${unclaimedExclusions.join(", ")}: target-owned store ${entry.path} has no included parent identity; worktree preserved before store inspection; preserve the store outside the slot's checkout and git dir before retrying removal`,
      )
    }
    const value = moduleStoreValue(entry.path)
    stores.push({
      name: entry.name,
      gitDir: entry.path,
      valueCommits: value.valueCommits,
      refs: value.refs,
      archived: [],
      ...(value.head === undefined ? {} : { head: value.head }),
      ...(value.remote === undefined ? {} : { remote: value.remote }),
    })
  }
  return { stores }
}

/**
 * Archive every store's value on its own remote, and only then let removal proceed. A push that fails, a store
 * with value and no remote, and an unreadable store all stop the removal and name the store: this is an error,
 * never a gate, and no store is deleted on a partial archive. A store with nothing to archive is left for
 * removal to discard, and its report says why that is safe.
 */
export function archiveModuleStores(
  stores: readonly ModuleStore[],
  target: ModuleArchiveTarget,
): readonly ModuleStore[] {
  return stores.map((store) => {
    if (store.valueCommits === 0) return store
    if (store.remote === undefined) {
      throw new Error(
        `module store ${store.name} holds ${String(store.valueCommits)} commit(s) no remote main or archive ref holds, and it has no remote to archive them to; worktree preserved. Add a remote, or save the store with \`git --git-dir ${store.gitDir} bundle create <file> --all\`, before retrying removal`,
      )
    }
    const archived: string[] = []
    for (const ref of store.refs) {
      const destination = archiveRefFor(`${store.name}/${ref.label}`, target.actor, target.date)
      const pushed = storeGit(
        store.gitDir,
        ["push", "--force", store.remote, `${ref.source}:${destination}`],
        ARCHIVE_PUSH_TIMEOUT_MS,
      )
      if (pushed.status !== 0) {
        throw new Error(
          `module store ${store.name} could not be archived: git push ${ref.source} -> ${destination} on ${store.remote} failed (${pushed.stderr.trim() || `exit ${String(pushed.status)}`}); worktree preserved after archiving ${archived.length === 0 ? "nothing" : archived.join(", ")}`,
        )
      }
      archived.push(destination)
    }
    return { ...store, archived }
  })
}

/** One line per store, so a removal never destroys (or archives) a module repository silently. */
export function describeModuleStores(stores: readonly ModuleStore[]): string[] {
  return stores.map((store) => {
    const head = store.head === undefined ? "" : `, HEAD ${store.head}`
    if (store.valueCommits === 0) {
      const where = store.remote === undefined ? "no remote main exists" : `${store.remote} main and archive refs hold it`
      return `module store ${store.name} released: ${where}, 0 commits unique${head}`
    }
    const where = store.archived.length === 0 ? "an archive push still pending" : store.archived.join(", ")
    return `module store ${store.name} archived: ${String(store.valueCommits)} commit(s) to ${where}${head}`
  })
}
