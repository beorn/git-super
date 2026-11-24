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
 *
 * Unknown is never "nothing to keep". A failed fetch, absent remote-tracking refs, an unreadable submodule, or any
 * error the git calls raise all return `unknown` with the reason, and both callers retain on unknown. A predicate that
 * guessed on a broken read would delete the one copy of somebody's work.
 */

/** The slice of git this module needs: run one git command in one directory and return its stdout. */
export interface PredicateGit {
  readonly text: (cwd: string, args: readonly string[]) => Promise<string>
}

/** What the predicate decides, and the evidence behind it, so a caller can log one honest line either way. */
export type NothingUnpublishedVerdict =
  | {
      /** Every head is on a remote and the worktree is clean: a retained copy would hold nothing unique. */
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
  /** The environment (worktree) root to read. */
  readonly path: string
  /**
   * Refresh remote-tracking refs. The sweep passes one that fetches the shared dev repository once for the run; the
   * creation path passes one that fetches this environment. A rejection is `unknown`, never a clean verdict.
   */
  readonly refreshRemotes?: () => Promise<void>
}

const nonEmpty = (line: string): boolean => line.trim() !== ""

const lines = (text: string): string[] => text.split("\n").filter(nonEmpty)

/** `fetch --all --prune --quiet` in one directory: remote-tracking refs are the evidence, so they must be current. */
export function fetchRemotesIn(git: PredicateGit, cwd: string): () => Promise<void> {
  return async () => {
    await git.text(cwd, ["fetch", "--all", "--prune", "--quiet"])
  }
}

/** One repository's own heads, including the detached HEAD when the worktree is on one. */
async function headsOf(git: PredicateGit, cwd: string): Promise<string[]> {
  const heads = lines(await git.text(cwd, ["for-each-ref", "--format=%(refname)", "refs/heads"]))
  const detached = (await git.text(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim() === "HEAD"
  return detached ? [...heads, "HEAD"] : heads
}

/** Initialized submodules, deepest first, as absolute paths; a submodule that cannot be listed is named by the throw. */
async function submodulesOf(git: PredicateGit, cwd: string): Promise<string[]> {
  const text = await git.text(cwd, ["submodule", "foreach", "--recursive", "--quiet", "pwd"])
  return lines(text)
    .map((line) => /^Entering '(.+)'$/u.exec(line.trim())?.[1])
    .filter((path): path is string => path !== undefined)
    .map((path) => (path.startsWith("/") ? path : `${cwd}/${path}`))
}

export async function nothingUnpublished(input: NothingUnpublishedInput): Promise<NothingUnpublishedVerdict> {
  const { git, path } = input
  const heads: string[] = []
  try {
    if (input.refreshRemotes !== undefined) await input.refreshRemotes()
    const repositories = [path, ...(await submodulesOf(git, path))]
    for (const repository of repositories) {
      const here = await headsOf(git, repository)
      for (const head of here) heads.push(repository === path ? head : `${repository}:${head}`)
      // A stale or absent refs/remotes cannot witness anything; absent is unknown, never "nothing to keep".
      if (lines(await git.text(repository, ["for-each-ref", "--format=%(refname)", "refs/remotes"])).length === 0) {
        return {
          state: "unknown",
          heads,
          reason: `${repository} has no remote-tracking refs, so publication cannot be proved`,
        }
      }
      const dirty = lines(await git.text(repository, ["status", "--porcelain", "--untracked-files=all"]))
      if (dirty.length > 0) {
        return {
          state: "unpublished",
          heads,
          reason: `${repository} is not clean: ${dirty[0] as string}${dirty.length > 1 ? ` (and ${String(dirty.length - 1)} more)` : ""}`,
        }
      }
      if (here.length > 0) {
        const unpublished = lines(await git.text(repository, ["rev-list", ...here, "--not", "--remotes"]))
        if (unpublished.length > 0) {
          return {
            state: "unpublished",
            heads,
            reason: `${repository} holds ${String(unpublished.length)} commit(s) reachable from no remote ref (e.g. ${(unpublished[0] as string).slice(0, 12)})`,
          }
        }
      }
    }
    return { state: "published", heads, provedBy: await provedBy(git, path) }
  } catch (error) {
    return { state: "unknown", heads, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** The remote-tracking refs that contain the worktree's heads, for the one line each skip or retirement logs. */
async function provedBy(git: PredicateGit, path: string): Promise<string[]> {
  const proved = new Set<string>()
  for (const head of await headsOf(git, path)) {
    const refs = lines(
      await git.text(path, ["for-each-ref", "--contains", head, "--format=%(refname)", "refs/remotes"]),
    )
    if (refs.length > 0) proved.add(refs[0] as string)
  }
  return [...proved].sort()
}

/** One line for a skip (creation) or a cheap-pass retirement (sweep); the same words answer "where did my work go". */
export function describeVerdict(env: string, verdict: NothingUnpublishedVerdict): string {
  const heads = verdict.heads.length === 0 ? "no heads" : verdict.heads.join(", ")
  if (verdict.state === "published") {
    return `nothing-unpublished: ${env} heads ${heads} are on ${verdict.provedBy.join(", ") || "remote refs"} and the worktree is clean`
  }
  return `nothing-unpublished: ${env} ${verdict.state} (${verdict.reason}); heads ${heads}`
}
