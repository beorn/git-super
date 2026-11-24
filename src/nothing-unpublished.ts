/**
 * The creation-side lever for the retained-module estate (#38198, @cto 2026-11-24T18:14Z, from #34127's measurement).
 *
 * The sweep cannot keep up by proving: one nightly run spends its whole shared proof budget (960 s) and retires about
 * seven entries, while roughly 230 retained copies are created every day. Matching that creation rate would need some
 * eight and a half hours of proof a night, so the cheaper direction is not to create the copy at all when there is
 * nothing in the environment that only that copy holds.
 *
 * ONE predicate, two callers. `worktree remove --retain` asks before it writes the retained copy, and the retention
 * batch asks first — before its byte-evidence gates — as the cheap proof for an entry it already holds. Both live in
 * this package, so there is one implementation and one answer.
 *
 * The predicate is "every head is reachable from a published remote ref, and the worktree is clean":
 *
 * - heads: every branch in the worktree, the detached HEAD when there is one, and the same in every initialized
 *   submodule — an environment is not publishable while a component holds an unpublished commit.
 * - published: `rev-list <heads> --not --remotes` prints nothing. Remote-tracking refs are refreshed first, because a
 *   stale `refs/remotes` would answer "unpublished" for work that is already on the remote, and a missing one would
 *   answer "published" for work that is not.
 * - clean: `status --porcelain --untracked-files=all` prints nothing, so an uncommitted edit, a staged change, or an
 *   untracked file keeps the copy. The clean requirement is what makes "nothing unpublished" also mean "nothing to
 *   keep": with everything committed AND published, the environment holds no work that exists nowhere else.
 * - custody refs: in every store the removal deletes — the module stores of a worktree (per-worktree ones included)
 *   and, for the sweep, every store of the retained copy — `refs/stash` or any `refs/notes/*` means the store is NOT
 *   eligible, named as "<store> holds <ref>" (#38246, @cto 2026-11-24T21:28Z). A stash and a note are commits no
 *   branch and no remote names, so a copy-less removal would lose them. Reflogs stay OUT of this rule by decision:
 *   work must be committed and pushed to count, and a reflog is not custody — it records where a ref has been, not
 *   work that a remote holds.
 *
 * Unknown is never "nothing to keep". A failed fetch, absent remote-tracking refs, an unreadable submodule, or any
 * error the git calls raise all return `unknown` with the reason, and both callers retain on unknown. A predicate that
 * guessed on a broken read would delete the one copy of somebody's work.
 */

import { lstatSync } from "node:fs"
import { moduleStorePaths } from "./module-store-custody.ts"

/** The slice of git this module needs: run one git command in one directory and return its stdout. */
export interface PredicateGit {
  readonly text: (cwd: string, args: readonly string[]) => Promise<string>
}

/** What the predicate decides, and the evidence behind it, so a caller can log one honest line either way. */
export type NothingUnpublishedVerdict =
  | {
      /**
       * Every head is on a remote, the worktree is clean, and no store the removal deletes holds a stash or a note:
       * a retained copy would hold nothing unique.
       */
      readonly state: "published"
      readonly heads: readonly string[]
      /** The remote-tracking refs that contain the heads, named so "where did my work go" has an answer. */
      readonly provedBy: readonly string[]
    }
  | {
      /** Something in the environment exists nowhere else: the copy must be written (creation) or kept (sweep). */
      readonly state: "unpublished"
      readonly heads: readonly string[]
      readonly reason: string
    }
  | {
      /** The question could not be answered: retain, and log this reason rather than a clean verdict. */
      readonly state: "unknown"
      readonly heads: readonly string[]
      readonly reason: string
    }

export interface NothingUnpublishedInput {
  readonly git: PredicateGit
  /**
   * The environment (worktree) root to read. Absent for a retained copy, which holds stores and no checkout; at
   * least one of `path` and `modulesRoot` must be given, and neither default is an empty census.
   */
  readonly path?: string
  /**
   * Whether a clean working tree is part of the proof. True for a live environment (creation): an uncommitted edit or an
   * untracked file is work that exists nowhere else. False for a retained copy (the sweep): the copy holds stores, not a
   * checkout, so its heads against the remote refs are the whole question and running `status` there would prove
   * nothing while costing a store walk per entry.
   */
  readonly checkWorktree?: boolean
  /**
   * Refresh remote-tracking refs. The creation path passes one that fetches this environment. A rejection is
   * `unknown`, never a clean verdict. The sweep passes none: a copy's own `refs/remotes` are the snapshot the
   * retention wrote, and a store without them answers `unknown` rather than paying one fetch per entry.
   */
  readonly refreshRemotes?: () => Promise<void>
  /**
   * Confirm every proving ref on its remote with one `ls-remote` per remote URL, before answering `published`
   * (@cto 2026-11-24T22:12Z, #38246). The sweep sets it: its `refs/remotes` were written when the copy was made, so a
   * branch deleted or force-moved since still reads as published on that snapshot and the commits it held may now
   * exist nowhere. A proving ref the remote no longer advertises, or no longer reaches, answers `unknown` and the entry
   * takes the full gates. The creation path leaves it off: its remotes were fetched at removal time.
   */
  readonly confirmRemoteRefs?: boolean
  /**
   * The modules root of every Git store the removal deletes, in Git's own layout: `<git-dir>/modules` of a live
   * worktree (Git resolves the per-worktree one, so a slot's own stores are included) and the retained copy's
   * `modules/` for the sweep. Every store under it is read, named or not, because removal deletes it either way.
   */
  readonly modulesRoot?: string
}

const nonEmpty = (line: string): boolean => line.trim() !== ""

const lines = (text: string): string[] => text.split("\n").filter(nonEmpty)

/** `fetch --all --prune --quiet` in one directory: remote-tracking refs are the evidence, so they must be current. */
export function fetchRemotesIn(git: PredicateGit, cwd: string): () => Promise<void> {
  return async () => {
    await git.text(cwd, ["fetch", "--all", "--prune", "--quiet"])
  }
}

/** One repository's own refs read, with a store's arguments already shaped by the caller. */
type ReadRefs = (repository: string, args: readonly string[]) => Promise<string>

/** One repository's own heads, including the detached HEAD when the worktree is on one. */
async function headsOf(read: ReadRefs, repository: string): Promise<string[]> {
  const heads = lines(await read(repository, ["for-each-ref", "--format=%(refname)", "refs/heads"]))
  const detached = (await read(repository, ["rev-parse", "--abbrev-ref", "HEAD"])).trim() === "HEAD"
  return detached ? [...heads, "HEAD"] : heads
}

/**
 * Every initialized submodule, all depths, as absolute paths. `--quiet` suppresses Git's "Entering '<path>'" notes, so
 * stdout is the `pwd` of each submodule, one per line — the note form is accepted too because an unquiet Git prints it
 * and a parser that only understood one of the two shapes would silently see NO submodule, which is the one answer that
 * must never be silent here: it would let the copy be skipped while a component held unpublished work.
 */
async function submodulesOf(git: PredicateGit, cwd: string): Promise<string[]> {
  const text = await git.text(cwd, ["submodule", "foreach", "--recursive", "--quiet", "pwd"])
  const paths = lines(text).map((line) => {
    const trimmed = line.trim()
    return /^Entering '(.+)'$/u.exec(trimmed)?.[1] ?? trimmed
  })
  return [...new Set(paths.map((path) => (path.startsWith("/") ? path : `${cwd}/${path}`)))]
}

/**
 * Every store under one modules root, or none when the root does not exist. A root that is not a plain directory, a
 * non-store entry inside it, or an unreadable directory throws, and the caller answers `unknown`: a walk that lost a
 * store would let the copy holding it be skipped.
 */
function storesUnder(modulesRoot: string): string[] {
  const state = lstatSync(modulesRoot, { throwIfNoEntry: false })
  if (state === undefined) return []
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw new Error(`modules root ${modulesRoot} is not a plain directory`)
  }
  return moduleStorePaths(modulesRoot)
}

export async function nothingUnpublished(input: NothingUnpublishedInput): Promise<NothingUnpublishedVerdict> {
  const { git, path } = input
  const checkWorktree = input.checkWorktree ?? true
  const heads: string[] = []
  const readHeads: { repository: string; head: string }[] = []
  try {
    if (path === undefined && input.modulesRoot === undefined) {
      throw new Error("neither an environment to read nor a modules root was given")
    }
    if (input.refreshRemotes !== undefined) await input.refreshRemotes()
    // The worktree and its submodule checkouts answer the publication question; the module stores are read on their
    // own as well, because a store with no checkout (a submodule never initialized) is deleted with the slot too.
    const stores = input.modulesRoot === undefined ? [] : storesUnder(input.modulesRoot)
    const storeSet = new Set(stores)
    // A store is read through an explicit --git-dir and --work-tree, never `-C alone`: a copy's own config still names
    // the removed checkout as `core.worktree`, and git chdir's there before running anything (a real retained entry
    // failed exactly that way: "cannot chdir to .../34127-runtime-root/ag"). Naming both makes the read answer about
    // the store on disk, whatever its config remembers.
    const read: ReadRefs = async (repository, args) =>
      storeSet.has(repository)
        ? git.text(repository, [`--git-dir=${repository}`, `--work-tree=${repository}`, ...args])
        : git.text(repository, args)
    const repositories = [...(path === undefined ? [] : [path, ...(await submodulesOf(git, path))]), ...stores]
    for (const repository of repositories) {
      // #38246: a stash or a note is a commit no branch and no remote names. Reflogs are excluded by rule (see the
      // module doc): work must be committed and pushed to count, and a reflog is not custody.
      if (storeSet.has(repository)) {
        const custodyRef = lines(
          await read(repository, ["for-each-ref", "--format=%(refname)", "refs/stash", "refs/notes"]),
        )[0]
        if (custodyRef !== undefined) {
          return { state: "unpublished", heads, reason: `${repository} holds ${custodyRef}` }
        }
      }
      const here = await headsOf(read, repository)
      for (const head of here) {
        heads.push(repository === path ? head : `${repository}:${head}`)
        readHeads.push({ repository, head })
      }
      // A stale or absent refs/remotes cannot witness anything; absent is unknown, never "nothing to keep".
      if (lines(await read(repository, ["for-each-ref", "--format=%(refname)", "refs/remotes"])).length === 0) {
        return {
          state: "unknown",
          heads,
          reason: `${repository} has no remote-tracking refs, so publication cannot be proved`,
        }
      }
      if (checkWorktree) {
        const dirty = lines(await read(repository, ["status", "--porcelain", "--untracked-files=all"]))
        if (dirty.length > 0) {
          return {
            state: "unpublished",
            heads,
            reason: `${repository} is not clean: ${dirty[0] as string}${dirty.length > 1 ? ` (and ${String(dirty.length - 1)} more)` : ""}`,
          }
        }
      }
      if (here.length > 0) {
        const unpublished = lines(await read(repository, ["rev-list", ...here, "--not", "--remotes"]))
        if (unpublished.length > 0) {
          return {
            state: "unpublished",
            heads,
            reason: `${repository} holds ${String(unpublished.length)} commit(s) reachable from no remote ref (e.g. ${(unpublished[0] as string).slice(0, 12)})`,
          }
        }
      }
    }
    // An empty census proves nothing, so it is never a clean verdict: no head anywhere means there is no question to
    // answer here, and both callers keep the copy.
    if (heads.length === 0) {
      return {
        state: "unknown",
        heads,
        reason: `${path ?? input.modulesRoot ?? "the input"} holds no head to prove`,
      }
    }
    const proved = await provedBy(read, readHeads)
    if (input.confirmRemoteRefs === true) await confirmRemoteRefs(read, proved.pairs)
    return { state: "published", heads, provedBy: proved.refs }
  } catch (error) {
    return { state: "unknown", heads, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The remote-tracking refs that contain each head read, for the one line each skip or retirement logs. Symbolic
 * aliases (`origin/HEAD` -> `origin/main`) are skipped: a receipt that says "proved by origin/HEAD" names a pointer,
 * not the ref that actually holds the work.
 */
async function provedBy(
  read: ReadRefs,
  readHeads: readonly Readonly<{ repository: string; head: string }>[],
): Promise<
  Readonly<{ refs: string[]; pairs: readonly Readonly<{ repository: string; head: string; ref: string }>[] }>
> {
  const proved = new Set<string>()
  const pairs: { repository: string; head: string; ref: string }[] = []
  for (const { repository, head } of readHeads) {
    const refs = lines(
      // `--exclude` drops the symbolic `origin/HEAD` alias: naming it in a receipt names a pointer, not the ref that
      // actually holds the work.
      await read(repository, [
        "for-each-ref",
        "--contains",
        head,
        "--exclude=refs/remotes/*/HEAD",
        "--format=%(refname)",
        "refs/remotes",
      ]),
    )
    if (refs.length > 0) {
      proved.add(refs[0] as string)
      pairs.push({ repository, head, ref: refs[0] as string })
    }
  }
  return { refs: [...proved].sort(), pairs }
}

/**
 * Every proving ref must still be advertised by its remote, and the commit it advertises must still reach the head
 * (@cto 2026-11-24T22:12Z, #38246). One `ls-remote` per distinct remote URL: a copy's stores usually share one remote,
 * so eighteen components still cost one network read. A ref that is gone, or moved to a commit that no longer contains
 * the head, throws, and the caller answers `unknown` — never `published` on a stale snapshot. The ancestry check runs in
 * the store that holds the head; objects missing from the copy is an unknown too, which keeps the entry.
 */
async function confirmRemoteRefs(
  read: ReadRefs,
  pairs: readonly Readonly<{ repository: string; head: string; ref: string }>[],
): Promise<void> {
  const advertised = new Map<string, Map<string, string>>()
  const headOids = new Map<string, string>()
  for (const { repository, head, ref } of pairs) {
    const parsed = /^refs\/remotes\/([^/]+)\/(.+)$/u.exec(ref)
    if (parsed === null) {
      throw new Error(
        `${repository}: ${ref} proves ${head} and is not a remote-tracking ref, so no remote can confirm it`,
      )
    }
    const remote = parsed[1] as string
    const branch = parsed[2] as string
    const url = (await read(repository, ["remote", "get-url", remote])).trim()
    if (url === "") throw new Error(`${repository}: remote ${remote} has no URL, so ${ref} cannot be confirmed`)
    // The head's own commit first: it is a local read, and it is what the remote answer is compared against.
    const key = `${repository}\u0000${head}`
    let oid = headOids.get(key)
    if (oid === undefined) {
      oid = (await read(repository, ["rev-parse", head])).trim()
      headOids.set(key, oid)
    }
    let refs = advertised.get(url)
    if (refs === undefined) {
      refs = new Map<string, string>()
      for (const line of lines(await read(repository, ["ls-remote", remote]))) {
        const [sha, name] = line.split("\t")
        if (sha !== undefined && name !== undefined) refs.set(name, sha)
      }
      advertised.set(url, refs)
    }
    const branchRef = `refs/heads/${branch}`
    const at = refs.get(branchRef)
    if (at === undefined) {
      throw new Error(`${remote} no longer advertises ${branchRef}, so ${repository}:${head} is not proved published`)
    }
    if (at === oid) continue
    try {
      await read(repository, ["merge-base", "--is-ancestor", oid, at])
    } catch {
      throw new Error(
        `${remote} ${branchRef} now points at ${at}, which does not reach ${repository}:${head} (${oid}); the copy cannot be proved published`,
      )
    }
  }
}

/** One line for a skip (creation) or a cheap-pass retirement (sweep); the same words answer "where did my work go". */
export function describeVerdict(env: string, verdict: NothingUnpublishedVerdict, checkWorktree = true): string {
  const heads = verdict.heads.length === 0 ? "no heads" : verdict.heads.join(", ")
  if (verdict.state === "published") {
    const clean = checkWorktree ? " and the worktree is clean" : ""
    return `nothing-unpublished: ${env} heads ${heads} are on ${verdict.provedBy.join(", ") || "remote refs"}${clean}, and no store it deletes holds a stash or a note`
  }
  return `nothing-unpublished: ${env} ${verdict.state} (${verdict.reason}); heads ${heads}`
}
