import { existsSync, lstatSync, readdirSync, type Dirent } from "node:fs"
import { isAbsolute, join, relative, sep } from "node:path"
import { archiveRefFor } from "./archive-ref.ts"
import { tryGit, withGitTimeout } from "./git.ts"

/**
 * A module repository under a slot's own `<git-dir>/modules/`, which removal destroys with the slot, and the
 * work it holds that nothing durable names. The operator's value test (2026-10-21) decides what happens to it:
 * work not on the remote's default branch and not under its `refs/archive/*` is value — archive it first, then
 * remove. Both are read from the remote itself at removal time, never from the store's local copies of them.
 */
export type ModuleStore = Readonly<{
  /** The store's path relative to `modules/`: git's own submodule name, or the path default. */
  name: string
  gitDir: string
  /** Short HEAD, so a report names the same commit a reader sees in `git log`. */
  head?: string
  /** The remote that will hold the archive, when the store has one. */
  remote?: string
  /** The remote's default branch the value was measured against, when its HEAD names one. */
  defaultBranch?: string
  /** Commits the store's own refs hold that the remote's default branch and archive refs do not. */
  valueCommits: number
  /** The refs holding those commits, with the archive name each is pushed under. */
  refs: readonly Readonly<{ source: string; label: string }>[]
  /** The `refs/archive/*` names the remote already holds, so an archive push never takes one and replaces it. */
  remoteArchiveRefs: readonly string[]
  /** Archive refs this removal created, in the order they were pushed. */
  archived: readonly string[]
}>

/** What one removal's module-store inspection found, before anything is pushed or deleted. */
export type ModuleInventory = Readonly<{ stores: readonly ModuleStore[] }>

/** Where an archive push may land: the store's remote, the day, and the actor that owns the ref. */
export type ModuleArchiveTarget = Readonly<{ actor: string; date: string }>

type Capture = Readonly<{ status: number; stdout: string; stderr: string }>

const STORE_TIMEOUT_MS = 30_000
const REMOTE_READ_TIMEOUT_MS = 120_000
const ARCHIVE_PUSH_TIMEOUT_MS = 120_000

/**
 * Every git call here goes through the package's one runner, `tryGit`, which strips an inherited `GIT_DIR`,
 * `GIT_COMMON_DIR` or `GIT_OBJECT_DIRECTORY` (a git hook exports them) that would otherwise point a store read at
 * another repository's refs and objects. A call that cannot run, or does not finish inside its bound, names what
 * could not be read; it is never an empty answer (fail closed).
 */
function readGit(
  cwd: string,
  args: readonly string[],
  what: string,
  timeout = STORE_TIMEOUT_MS,
  input?: string,
): Capture {
  try {
    const result = withGitTimeout(timeout, () => tryGit(cwd, args, undefined, input))
    return { status: result.exitCode, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    throw new Error(
      `${what} could not be read: ${error instanceof Error ? error.message : String(error)}; worktree preserved`,
      {
        cause: error,
      },
    )
  }
}

/**
 * A store's `core.worktree` points at a checkout that removal may already have emptied or deleted. `--bare`
 * does not reach git's own subprocesses: `pack-objects` under a push and `unpack-objects` under a fetch re-read
 * `core.worktree` and die on `cannot chdir`. So the work tree is the store itself, an existing directory these
 * commands never write to, and git hands that to every subprocess.
 */
function storeGit(gitDir: string, args: readonly string[], timeout = STORE_TIMEOUT_MS, input?: string): Capture {
  return readGit(
    gitDir,
    ["--git-dir", gitDir, "--work-tree", gitDir, ...args],
    `module store ${gitDir}`,
    timeout,
    input,
  )
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
    // Name order, so stores are archived and reported in the same order on every filesystem.
    return readdirSync(path, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )
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
function* moduleEntries(
  root: string,
  path = root,
): Generator<Readonly<{ name: string; path: string; store: boolean }>> {
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

/** The object a store ref or sha names, so an archive name can carry it. */
function objectId(gitDir: string, source: string): string {
  const resolved = storeGit(gitDir, ["rev-parse", "--verify", "--quiet", source])
  const id = resolved.stdout.trim()
  if (resolved.status !== 0 || id === "") {
    throw new Error(
      `module store ${gitDir} could not resolve ${source} (${resolved.stderr.trim() || `exit ${String(resolved.status)}`}); worktree preserved`,
    )
  }
  return id
}

/** The commits among `shas` whose objects the store does not have yet. */
function missingObjects(gitDir: string, shas: readonly string[]): string[] {
  if (shas.length === 0) return []
  const checked = storeGit(gitDir, ["cat-file", "--batch-check"], STORE_TIMEOUT_MS, `${shas.join("\n")}\n`)
  if (checked.status !== 0) {
    throw new Error(
      `module store ${gitDir} could not be read (git cat-file: ${checked.stderr.trim()}); worktree preserved`,
    )
  }
  return checked.stdout
    .split("\n")
    .map((line) => /^(\S+) missing$/u.exec(line.trim())?.[1])
    .filter((sha): sha is string => sha !== undefined)
}

/**
 * The tips the value test subtracts, read from the store's remote now (operator 2026-10-21): the remote's default
 * branch, every `refs/archive/*` and every `refs/tags/*` it holds (a published tag is permanent and holds no
 * worktree work, @cto 2026-10-21). A local remote-tracking ref can be stale or name the wrong default, and a local
 * archive ref is not on the remote at all, so neither decides. Default-branch and archive tips whose objects the
 * store lacks are fetched first, because reachability needs them. Tags are never fetched: a tag tip the store
 * lacks is left out, so the work it would cover still counts as value. A remote that cannot be read stops
 * removal, with no fallback to the local copies.
 */
function remoteDurableTips(
  gitDir: string,
  remote: string,
): Readonly<{ defaultBranch?: string; tips: string[]; archiveRefs: string[] }> {
  const listed = storeGit(
    gitDir,
    ["ls-remote", "--symref", remote, "HEAD", "refs/archive/*", "refs/tags/*"],
    REMOTE_READ_TIMEOUT_MS,
  )
  if (listed.status !== 0) {
    throw new Error(
      `module store ${gitDir} could not be read: its remote ${remote} did not answer ls-remote (${listed.stderr.trim() || `exit ${String(listed.status)}`}), so its value is unknown; worktree preserved`,
    )
  }
  let defaultBranch: string | undefined
  let headTip: string | undefined
  const archive = new Map<string, string>()
  const tags = new Map<string, string>()
  for (const line of listed.stdout.split("\n")) {
    if (line.trim() === "") continue
    const [, target, symrefName] = /^ref: (\S+)\t(\S+)$/u.exec(line) ?? []
    if (target !== undefined && symrefName !== undefined) {
      if (symrefName === "HEAD" && target.startsWith("refs/heads/")) defaultBranch = target.slice("refs/heads/".length)
      continue
    }
    const [, sha, ref] = /^([0-9a-f]{40,64})\t(\S+)$/u.exec(line) ?? []
    if (sha === undefined || ref === undefined) {
      throw new Error(
        `module store ${gitDir}: ls-remote ${remote} answered an unreadable line ${JSON.stringify(line)}; worktree preserved`,
      )
    }
    // The `HEAD` pattern also matches every ref ending in `/HEAD`; only the remote's own HEAD is its default branch.
    if (ref === "HEAD") headTip = sha
    else if (ref.startsWith("refs/archive/")) archive.set(ref, sha)
    else if (ref.startsWith("refs/tags/")) {
      // An annotated tag lists its tag object, then its commit under `^{}`; the commit is what counts.
      const peeled = ref.endsWith("^{}")
      const name = peeled ? ref.slice(0, -"^{}".length) : ref
      if (peeled || !tags.has(name)) tags.set(name, sha)
    }
  }
  // A remote HEAD that is unborn or detached names no default branch, so only its archive refs are subtracted.
  const head =
    defaultBranch === undefined || headTip === undefined ? [] : [[`refs/heads/${defaultBranch}`, headTip] as const]
  const named = [...head, ...archive]
  const tips = [...new Set(named.map(([, sha]) => sha))]
  const missing = new Set(missingObjects(gitDir, tips))
  if (missing.size > 0) {
    const wanted = named.filter(([, sha]) => missing.has(sha)).map(([ref]) => ref)
    // An empty `--refmap` keeps this read from rewriting the store's own remote-tracking refs: only objects land.
    // A tip the remote rewrote meanwhile stays absent, and the count below then fails loudly on it.
    const fetched = storeGit(
      gitDir,
      [
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-recurse-submodules",
        "--no-write-fetch-head",
        "--no-auto-maintenance",
        "--refmap=",
        remote,
        ...wanted,
      ],
      REMOTE_READ_TIMEOUT_MS,
    )
    if (fetched.status !== 0) {
      throw new Error(
        `module store ${gitDir} could not be read: fetching ${wanted.join(", ")} from ${remote} failed (${fetched.stderr.trim() || `exit ${String(fetched.status)}`}), so its value is unknown; worktree preserved`,
      )
    }
  }
  const tagTips = [...new Set(tags.values())]
  const absentTags = new Set(missingObjects(gitDir, tagTips))
  return {
    ...(defaultBranch === undefined ? {} : { defaultBranch }),
    tips: [...new Set([...tips, ...tagTips.filter((sha) => !absentTags.has(sha))])],
    archiveRefs: [...archive.keys()],
  }
}

/** A ref that could hold work, and the name its commit is archived under. */
type LocalRef = Readonly<{ source: string; label: string }>

/**
 * The store's own refs that could hold work: HEAD, every branch, every tag, every local archive ref (it dies with
 * the store, so it holds work rather than proving it is kept), and every stash entry. A stash entry has no ref
 * name of its own, so its commit is archived under its position.
 */
function localRefs(gitDir: string): LocalRef[] {
  const refs = refsMatching(gitDir, ["refs/heads", "refs/tags", "refs/archive"])
  const head = storeGit(gitDir, ["rev-parse", "--verify", "--quiet", "HEAD"])
  const headTip = head.status === 0 ? head.stdout.trim() : ""
  // Stash entries are commits reachable only through refs/stash's reflog, so its tip alone is not enough.
  const hasStash = storeGit(gitDir, ["reflog", "exists", "refs/stash"])
  const stash: LocalRef[] = []
  if (hasStash.status === 0) {
    const entries = storeGit(gitDir, ["reflog", "show", "--format=%H", "refs/stash"])
    if (entries.status !== 0) {
      throw new Error(
        `module store ${gitDir} has an unreadable stash reflog (${entries.stderr.trim()}); worktree preserved`,
      )
    }
    for (const [index, sha] of entries.stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .entries()) {
      stash.push({ source: sha.trim(), label: `stash/${String(index + 1)}` })
    }
  } else if (hasStash.status !== 1) {
    throw new Error(
      `module store ${gitDir} has an unreadable stash ref (${hasStash.stderr.trim()}); worktree preserved`,
    )
  }
  return [
    ...(headTip === "" ? [] : [{ source: headTip, label: "HEAD" }]),
    ...refs.map((ref) => ({ source: ref, label: ref.replace(/^refs\/(heads|tags|archive)\//u, "$1/") })),
    ...stash,
  ]
}

/**
 * The remote an archive may be pushed to: `origin` when configured, otherwise the one configured remote. Removal
 * reads the same remote for its on-target proof of a component store (30715).
 */
export function storeRemote(gitDir: string): string | undefined {
  const remotes = storeGit(gitDir, ["config", "--get-regexp", "^remote\\..*\\.url$"])
  // Exit 1 is git's answer for "no remote configured"; any other failure leaves the configuration unread.
  if (remotes.status === 1) return undefined
  if (remotes.status !== 0) {
    throw new Error(
      `module store ${gitDir} could not be read: its remote configuration is unreadable (${remotes.stderr.trim()}); worktree preserved`,
    )
  }
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
 * own refs hold that are not reachable from its remote's default branch, any `refs/archive/*` or any `refs/tags/*`
 * on that remote, all read from the remote now. A store with no remote has nothing proving its bytes exist elsewhere,
 * so every commit it holds counts as value.
 */
export function moduleStoreValue(gitDir: string): Readonly<{
  valueCommits: number
  refs: readonly Readonly<{ source: string; label: string }>[]
  remote?: string
  defaultBranch?: string
  head?: string
  remoteArchiveRefs: readonly string[]
}> {
  const remote = storeRemote(gitDir)
  const durable = remote === undefined ? { tips: [], archiveRefs: [] } : remoteDurableTips(gitDir, remote)
  const exclusions = durable.tips
  const local = localRefs(gitDir)
  const valueCommits = count(
    gitDir,
    local.map((ref) => ref.source),
    exclusions,
  )
  const headShort = local.find((ref) => ref.label === "HEAD")?.source.slice(0, 12)
  return {
    valueCommits,
    refs: valueCommits === 0 ? [] : local.filter((ref) => count(gitDir, [ref.source], exclusions) > 0),
    remoteArchiveRefs: durable.archiveRefs,
    ...(remote === undefined ? {} : { remote }),
    ...(durable.defaultBranch === undefined ? {} : { defaultBranch: durable.defaultBranch }),
    ...(headShort === undefined ? {} : { head: headShort }),
  }
}

/** The module names a slot's own HEAD declares, read from the committed `.gitmodules` rather than a working file. */
function headModuleNames(checkout: string): string[] {
  const declarations = `HEAD:.gitmodules in ${checkout}`
  const blob = readGit(checkout, ["cat-file", "-e", "HEAD:.gitmodules"], declarations)
  // 128 is git's answer for a commit that carries no `.gitmodules` at all: no declarations, not unreadable.
  if (blob.status === 128) return []
  if (blob.status !== 0) {
    throw new Error(
      `${declarations} could not be read, so the slot's own stores are unknown: ${blob.stderr}; worktree preserved`,
    )
  }
  const listing = readGit(
    checkout,
    ["config", "-z", "--blob", "HEAD:.gitmodules", "--get-regexp", "^submodule\\..*\\.path$"],
    declarations,
  )
  // Exit 1 means the commit declares no submodule paths; any other failure leaves the declarations unread.
  if (listing.status !== 0 && listing.status !== 1) {
    throw new Error(
      `${declarations} could not be parsed, so the slot's own stores are unknown: ${listing.stderr}; worktree preserved`,
    )
  }
  const names: string[] = []
  for (const record of listing.stdout.split("\0")) {
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
    const what = `module store for declared submodule ${name} in ${checkout}`
    const resolved = readGit(checkout, ["rev-parse", "--path-format=absolute", "--git-path", `modules/${name}`], what)
    if (resolved.status !== 0) {
      throw new Error(`${what} could not be resolved: ${resolved.stderr}; worktree preserved`)
    }
    const store = resolved.stdout.trim()
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
 * with the work it holds that its remote's default branch and archive refs do not: value to archive, or nothing
 * to discard.
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
  const modules = modulesDirectory(gitDir)
  if (modules === undefined) return { stores: [] }
  return judgeStores(modules, [...referencedModuleStores(checkout), ...excludedStores], unclaimedExclusions)
}

/**
 * The inventory of a registration whose checkout is already gone (`recoverDestroyed` without retention): no
 * checkout is left to consult any store, so every store under `modules/` is judged, declared or not.
 */
export function inspectDestroyedModuleStores(gitDir: string): ModuleInventory {
  const modules = modulesDirectory(gitDir)
  return modules === undefined ? { stores: [] } : judgeStores(modules, [], [])
}

function modulesDirectory(gitDir: string): string | undefined {
  const modules = join(gitDir, "modules")
  const state = lstatSync(modules, { throwIfNoEntry: false })
  if (state === undefined) return undefined
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw new Error(
      `worktree module directory ${modules} is not a directory; worktree preserved before store inspection`,
    )
  }
  return modules
}

function judgeStores(
  modules: string,
  skipped: readonly string[],
  unclaimedExclusions: readonly string[],
): ModuleInventory {
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
      remoteArchiveRefs: value.remoteArchiveRefs,
      archived: [],
      ...(value.head === undefined ? {} : { head: value.head }),
      ...(value.remote === undefined ? {} : { remote: value.remote }),
      ...(value.defaultBranch === undefined ? {} : { defaultBranch: value.defaultBranch }),
    })
  }
  return { stores }
}

/**
 * Archive every store's value on its own remote, and only then let removal proceed. A push that fails, a store
 * with value and no remote, and an unreadable store all stop the removal and name the store: this is an error,
 * never a gate, and no store is deleted on a partial archive. A store with nothing to archive is left for
 * removal to discard, and its report says why that is safe.
 *
 * Stores go one at a time: `onStore` hears each as soon as it is done, and a stop names every archive already
 * made, so no archive is ever unannounced.
 */
export function archiveModuleStores(
  stores: readonly ModuleStore[],
  target: ModuleArchiveTarget,
  onStore: (store: ModuleStore) => void = () => {},
): readonly ModuleStore[] {
  const done: ModuleStore[] = []
  const madeBefore = () => done.flatMap((store) => store.archived)
  for (const store of stores) {
    const result = archiveModuleStore(store, target, madeBefore())
    done.push(result)
    onStore(result)
  }
  return done
}

function archiveModuleStore(store: ModuleStore, target: ModuleArchiveTarget, earlier: readonly string[]): ModuleStore {
  if (store.valueCommits === 0) return store
  if (store.remote === undefined) {
    throw new Error(
      `module store ${store.name} holds ${String(store.valueCommits)} commit(s), and it has no remote to archive them to; worktree preserved${earlier.length === 0 ? "" : ` after archiving ${earlier.join(", ")}`}. Add a remote, or save the store with \`git --git-dir ${store.gitDir} bundle create <file> --all\`, before retrying removal`,
    )
  }
  const taken = new Set(store.remoteArchiveRefs)
  const pushes = store.refs.map((ref) => {
    const named = archiveRefFor(`${store.name}/${ref.label}`, target.actor, target.date)
    // A name the remote already holds keeps another commit (the commits it holds are not value), so this one
    // takes its object's short id instead. An archive is never replaced, and the push needs no force; a name
    // taken in the meantime fails the push and stops the removal.
    const destination = taken.has(named) ? `${named}-${objectId(store.gitDir, ref.source).slice(0, 12)}` : named
    return { refspec: `${ref.source}:${destination}`, destination }
  })
  // One atomic push per store: every ref lands, or none does and the stop says so.
  const pushed = storeGit(
    store.gitDir,
    ["push", "--atomic", store.remote, ...pushes.map((push) => push.refspec)],
    ARCHIVE_PUSH_TIMEOUT_MS,
  )
  if (pushed.status !== 0) {
    throw new Error(
      `module store ${store.name} could not be archived: git push --atomic of ${String(pushes.length)} ref(s) to ${store.remote} failed (${pushed.stderr.trim() || `exit ${String(pushed.status)}`}); worktree preserved after archiving ${earlier.join(", ") || "nothing"}`,
    )
  }
  return { ...store, archived: pushes.map((push) => push.destination) }
}

/** One line per store, so a removal never destroys (or archives) a module repository silently. */
export function describeModuleStores(stores: readonly ModuleStore[]): string[] {
  return stores.map((store) => {
    const head = store.head === undefined ? "" : `, HEAD ${store.head}`
    if (store.valueCommits === 0) {
      const where =
        store.remote === undefined
          ? "it holds no commits and has no remote"
          : `${store.remote} ${store.defaultBranch === undefined ? "" : `${store.defaultBranch}, `}archive refs and tags hold it`
      return `module store ${store.name} released: ${where}, 0 commits unique${head}`
    }
    // Before the push (an inspection's removal plan) the line must not claim an archive that has not happened.
    if (store.archived.length === 0) {
      return `module store ${store.name} holds ${String(store.valueCommits)} commit(s) to archive${head}`
    }
    return `module store ${store.name} archived: ${String(store.valueCommits)} commit(s) to ${store.archived.join(", ")}${head}`
  })
}
