import { existsSync, lstatSync, readdirSync, type Dirent } from "node:fs"
import { isAbsolute, join, relative, sep } from "node:path"
import { spawnSync } from "node:child_process"

/**
 * A module repository under a slot's own `<git-dir>/modules/`, which removal destroys with the slot, and the
 * custody it holds. A store is only released when every commit it holds is held by a remote-tracking ref too.
 */
export type ModuleStore = Readonly<{
  /** The store's path relative to `modules/`: git's own submodule name, or the path default. */
  name: string
  gitDir: string
  /** Short HEAD, so a refusal and a report name the same commit a reader sees in `git log`. */
  head?: string
  /** The remote whose tracking refs proved the store held nothing unique, when any exist. */
  remote?: string
  /** Commits reachable from the store's own refs that no remote-tracking ref holds. */
  uniqueCommits: number
}>

/** What one removal's module-store inspection found: every store it will destroy, already proven reproducible. */
export type ModuleInventory = Readonly<{ released: readonly ModuleStore[] }>

/** The facts a refusal and a report both name. */
export type StoreCustody = Readonly<{ uniqueCommits: number; remote?: string; head?: string }>

type Capture = Readonly<{ status: number; stdout: string; stderr: string }>

const STORE_TIMEOUT_MS = 30_000

/**
 * A store's `core.worktree` points at a checkout that removal may already have emptied or deleted, so every
 * read is `--bare` against the store itself. A store that does not answer inside the removal bound is
 * unreadable, never empty (fail closed).
 */
function storeGit(gitDir: string, args: readonly string[]): Capture {
  const result = spawnSync("git", ["--git-dir", gitDir, "--bare", ...args], {
    encoding: "utf8",
    timeout: STORE_TIMEOUT_MS,
  })
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

/**
 * Every entry under `modules/`, in git's own layout: a directory holding HEAD, objects/ and config is a module
 * repository, and the walk never descends into one (nested submodules live at `<store>/modules/` and ride with
 * that store). Namespace directories between the root and a store are transparent; anything else is handed back
 * as a non-store entry rather than guessed at.
 */
function* moduleEntries(
  root: string,
  path = root,
): Generator<Readonly<{ name: string; path: string; store: boolean }>> {
  const entries: Dirent[] = readEntries(path)
  for (const entry of entries) {
    const candidate = join(path, entry.name)
    if (!entry.isDirectory()) {
      yield { name: relative(root, candidate), path: candidate, store: false }
      continue
    }
    if (isStore(candidate)) {
      yield { name: relative(root, candidate), path: candidate, store: true }
      continue
    }
    const children = [...moduleEntries(root, candidate)]
    if (children.length === 0) {
      yield { name: relative(root, candidate), path: candidate, store: false }
      continue
    }
    yield* children
  }
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

/** The refs whose commits the store keeps: HEAD, every branch, every tag, and every stash entry. */
function localWants(gitDir: string): string[] {
  const wants = new Set<string>()
  const head = storeGit(gitDir, ["rev-parse", "--verify", "--quiet", "HEAD"])
  if (head.status === 0 && head.stdout.trim() !== "") wants.add(head.stdout.trim())
  const refs = storeGit(gitDir, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/tags"])
  if (refs.status !== 0) {
    throw new Error(`module store ${gitDir} has unreadable refs (${refs.stderr.trim()}); worktree preserved`)
  }
  for (const ref of refs.stdout.split("\n").filter((line) => line.trim() !== "")) {
    const resolved = storeGit(gitDir, ["rev-parse", "--verify", "--quiet", `${ref.trim()}^{commit}`])
    if (resolved.status !== 0 || resolved.stdout.trim() === "") {
      throw new Error(
        `module store ${gitDir} has a ref ${ref.trim()} that does not resolve to a commit; worktree preserved`,
      )
    }
    wants.add(resolved.stdout.trim())
  }
  // Stash entries are commits reachable only through refs/stash's reflog, so its tip alone is not enough.
  const hasStash = storeGit(gitDir, ["reflog", "exists", "refs/stash"])
  if (hasStash.status === 0) {
    const entries = storeGit(gitDir, ["reflog", "show", "--format=%H", "refs/stash"])
    if (entries.status !== 0) {
      throw new Error(
        `module store ${gitDir} has an unreadable stash reflog (${entries.stderr.trim()}); worktree preserved`,
      )
    }
    for (const sha of entries.stdout.split("\n").filter((line) => line.trim() !== "")) wants.add(sha.trim())
  } else if (hasStash.status !== 1) {
    throw new Error(
      `module store ${gitDir} has an unreadable stash ref (${hasStash.stderr.trim()}); worktree preserved`,
    )
  }
  return [...wants]
}

/**
 * The one definition of "unique work" both removal refusals use: the commits a store's own refs hold that no
 * remote-tracking ref holds, and the remote whose tracking refs were compared. A store with no remote-tracking
 * refs has nothing proving its bytes exist elsewhere, so every commit it holds counts as unique.
 */
export function moduleStoreCustody(gitDir: string): StoreCustody {
  const wants = localWants(gitDir)
  const head = storeGit(gitDir, ["rev-parse", "--verify", "--quiet", "HEAD"])
  const headShort = head.status === 0 && head.stdout.trim() !== "" ? head.stdout.trim().slice(0, 12) : undefined
  const tracking = storeGit(gitDir, ["for-each-ref", "--format=%(refname)", "refs/remotes"])
  if (tracking.status !== 0) {
    throw new Error(
      `module store ${gitDir} has unreadable remote-tracking refs (${tracking.stderr.trim()}); worktree preserved`,
    )
  }
  const remotes = [
    ...new Set(
      tracking.stdout
        .split("\n")
        .filter((ref) => ref.trim().startsWith("refs/remotes/"))
        .map((ref) => ref.trim().slice("refs/remotes/".length).split("/")[0])
        .filter((remote): remote is string => remote !== undefined && remote !== ""),
    ),
  ]
  if (wants.length === 0) return facts(0, remotes[0], headShort)
  const args = ["rev-list", "--count", ...wants]
  if (remotes.length > 0) args.push("--not", "--remotes")
  const counted = storeGit(gitDir, args)
  if (counted.status !== 0) {
    throw new Error(`module store ${gitDir} could not be counted (${counted.stderr.trim()}); worktree preserved`)
  }
  const count = Number.parseInt(counted.stdout.trim(), 10)
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(
      `module store ${gitDir} reported no usable commit count (${JSON.stringify(counted.stdout)}); worktree preserved`,
    )
  }
  return facts(count, remotes[0], headShort)
}

/** `exactOptionalPropertyTypes` forbids an explicit `undefined`, and a store may genuinely have neither. */
function facts(uniqueCommits: number, remote: string | undefined, head: string | undefined): StoreCustody {
  return {
    uniqueCommits,
    ...(remote === undefined ? {} : { remote }),
    ...(head === undefined ? {} : { head }),
  }
}

/** The one predicate #30563's surviving-repository refusal uses: a store holds nothing unique when this is 0. */
export function moduleStoreUniqueCommits(gitDir: string): number {
  return moduleStoreCustody(gitDir).uniqueCommits
}

/** The refusal text both callers share, so one definition of the protected bytes reaches a reader once. */
export function describeModuleStore(name: string, gitDir: string, custody: StoreCustody): string {
  return (
    `module store ${name} at ${gitDir} holds ${String(custody.uniqueCommits)} commit(s) no remote-tracking ref holds` +
    `${custody.remote === undefined ? " (no remote-tracking refs to compare)" : ` (compared against ${custody.remote})`}` +
    `${custody.head === undefined ? "" : `, HEAD ${custody.head}`}; worktree preserved. Push the commits, or save ` +
    `the store with \`git --git-dir ${gitDir} bundle create <file> --all\` — then remove the saved-elsewhere store and retry`
  )
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
 * declares are the ones status consults, so they are skipped here. Every other module repository is released
 * only when it holds no commit that exists nowhere else, and every released store is named by the caller. A
 * non-store entry, a store holding unique commits, and an unreadable store all refuse and preserve the slot.
 *
 * `excludedStores` are paths a caller has already taken custody of; they are never judged here.
 *
 * `unclaimedExclusions` are excluded paths with no declaration identity left at HEAD and nothing on disk. A
 * caller's custody claim cannot reach a store nothing names, so any unreferenced store here stays unclaimed:
 * it refuses exactly as before 30580 rather than being judged reproducible on the caller's behalf.
 */
export function inspectModuleStores(
  checkout: string,
  gitDir: string,
  excludedStores: readonly string[] = [],
  unclaimedExclusions: readonly string[] = [],
): ModuleInventory {
  const modules = join(gitDir, "modules")
  const state = lstatSync(modules, { throwIfNoEntry: false })
  if (state === undefined) return { released: [] }
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw new Error(
      `worktree module directory ${modules} is not a directory; worktree preserved before store inspection`,
    )
  }
  const skipped = [...referencedModuleStores(checkout), ...excludedStores]
  const released: ModuleStore[] = []
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
    const custody = moduleStoreCustody(entry.path)
    if (custody.uniqueCommits > 0) throw new Error(describeModuleStore(entry.name, entry.path, custody))
    released.push({
      name: entry.name,
      gitDir: entry.path,
      uniqueCommits: 0,
      ...(custody.head === undefined ? {} : { head: custody.head }),
      ...(custody.remote === undefined ? {} : { remote: custody.remote }),
    })
  }
  return { released }
}

/** One line per released store, so removal never destroys a module repository silently. */
export function describeReleasedStores(stores: readonly ModuleStore[]): string[] {
  return stores.map((store) => {
    const where =
      store.remote === undefined
        ? "no remote-tracking refs exist and it holds no commit"
        : `every commit is held by ${store.remote}`
    return `module store ${store.name} released: ${where}${store.head === undefined ? "" : `, HEAD ${store.head}`}`
  })
}
