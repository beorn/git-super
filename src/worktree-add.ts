import { resolve } from "node:path"
import type { ConditionalLogger } from "loggily"
import { gitSuperResult, type GitResultDetail, type GitSuperResult } from "./result.ts"
import { materializeSubmodulesFromLocalWorktreeParallel } from "./submodules.ts"
import { createLocalGitWorktreeStore, type GitWorktreeStore } from "./worktree.ts"

/**
 * How many gitlinks may open their own connection to their configured remote.
 *
 * Unbounded HERE and nowhere else. The materializer defaults to zero because
 * its usual caller has a healthy reference store and a fallback is an incident;
 * this command's whole contract is the opposite — a pin the reference lacks is
 * expected, and refusing it would leave the caller with no way to create a
 * worktree for a commit whose submodules the reference has never seen.
 */
const UNBOUNDED_REMOTE_FALLBACKS = Number.POSITIVE_INFINITY

/**
 * The three-way split the report line prints. The partition is EXACT: every
 * gitlink this run resolved lands in exactly one bucket, and
 * `borrowed + fetched + absent === considered`.
 *
 * It is a projection of the materializer's five counters, not a second
 * measurement:
 *
 * - `borrowed` = `borrowed - warmed` — already present in the reference's store.
 * - `fetched` = `remoteFallbacks + warmed` — had to come over the network.
 * - `absent` = `unreferenced` — the reference offered no store for it at all.
 *
 * `warmed` is a SUBSET of the materializer's `borrowed`: the pins that only
 * became borrowable after one fetch into the reference. Reporting those as
 * "borrowed" would print "0 fetched" for a run that went to the network for
 * every single pin, which is precisely the quiet reading this split exists to
 * prevent.
 */
export type WorktreeGitlinkCounts = Readonly<{
  considered: number
  borrowed: number
  fetched: number
  absent: number
}>

export type SuperWorktreeAddOptions = Readonly<{
  repo: string
  path: string
  commit: string
  /** Whose object stores the gitlinks borrow from; defaults to `repo`. */
  reference?: string
  env?: NodeJS.ProcessEnv
  log?: ConditionalLogger
}>

export type SuperWorktreeAddResult = GitSuperResult &
  Readonly<{
    path: string
    /** The commit as the caller wrote it, before Git resolved it. */
    requested: string
    /** The resolved object ID; absent only when the worktree never came up. */
    commit?: string
    /** Whether the commit records a `.gitmodules` at all. */
    gitmodules?: boolean
    gitlinks?: WorktreeGitlinkCounts
  }>

const NO_GITLINKS: WorktreeGitlinkCounts = { considered: 0, borrowed: 0, fetched: 0, absent: 0 }

function detail(code: string, phase: string, message: string, remedy?: string): GitResultDetail {
  return { code, phase, message, ...(remedy === undefined ? {} : { remedy }) }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function at(path: string, requested: string, commit: string | undefined): string {
  const resolved = commit === undefined ? requested : commit
  const original = commit === undefined || commit === requested ? "" : ` (${requested})`
  return `worktree add ${path} at ${resolved}${original}`
}

function counts(gitlinks: WorktreeGitlinkCounts): string {
  return (
    `${String(gitlinks.considered)} gitlink${gitlinks.considered === 1 ? "" : "s"} ` +
    `(${String(gitlinks.borrowed)} borrowed, ${String(gitlinks.fetched)} fetched, ${String(gitlinks.absent)} absent)`
  )
}

/**
 * Undo the worktree, and say which of the two states we are in.
 *
 * A rollback that fails is NOT the same failure as the one that triggered it:
 * the first leaves nothing behind, the second leaves a half-materialized tree
 * standing. Collapsing them into one "failed" is how a caller retries into an
 * existing path and gets a second, unrelated error.
 */
async function rollback(store: GitWorktreeStore, path: string): Promise<string | undefined> {
  try {
    await store.remove(path, { operation: `git super worktree add rollback ${path}` })
    return undefined
  } catch (error) {
    return message(error)
  }
}

/**
 * Create a detached worktree and materialize every gitlink the commit records.
 *
 * Mechanics only: it chooses no path, no naming, no lease, and no lifetime. The
 * one policy it does hold is atomicity — either the worktree stands with all of
 * its submodules materialized, or it does not stand at all.
 */
export async function superWorktreeAdd(options: SuperWorktreeAddOptions): Promise<SuperWorktreeAddResult> {
  const repo = resolve(options.repo)
  const path = resolve(options.path)
  const reference = options.reference === undefined ? repo : resolve(options.reference)
  const env = options.env
  const store = createLocalGitWorktreeStore({ repo, ...(env === undefined ? {} : { env }) })

  const failed = (
    state: "failed" | "unknown",
    failure: GitResultDetail,
    commit?: string,
    gitmodules?: boolean,
  ): SuperWorktreeAddResult => ({
    ...gitSuperResult([{ repository: repo, state, detail: failure, refs: [] }], failure),
    path,
    requested: options.commit,
    ...(commit === undefined ? {} : { commit }),
    ...(gitmodules === undefined ? {} : { gitmodules }),
  })

  try {
    await store.add({ kind: "detached", path, ref: options.commit, operation: `git super worktree add ${path}` })
  } catch (error) {
    return failed(
      "failed",
      detail(
        "worktree-add-failed",
        "add",
        `${at(path, options.commit, undefined)} failed before the worktree existed.\n${message(error)}`,
        "Resolve the reported Git condition, then rerun the same git super worktree add command.",
      ),
    )
  }

  let commit: string | undefined
  let gitmodules: boolean | undefined
  try {
    commit = await store.git.text(path, ["rev-parse", "HEAD"])
    // `optionalText` and NOT `run(..., allowFailure)`: an absent `.gitmodules`
    // is a real answer, but a stalled or timed-out repository is not, and
    // `allowFailure` returns both as one non-zero code. That collapse would
    // report "plain worktree add" for a superproject whose submodules were
    // never even enumerated — a passing exit for a check that never looked.
    gitmodules = (await store.git.optionalText(path, ["cat-file", "-e", "HEAD:.gitmodules"])) !== undefined
    if (!gitmodules) {
      const report = `${at(path, options.commit, commit)}: no .gitmodules at this commit; plain worktree add`
      return {
        ...gitSuperResult(
          [{ repository: repo, state: "updated", refs: [] }],
          detail("worktree-added", "report", report),
        ),
        path,
        requested: options.commit,
        commit,
        gitmodules,
        gitlinks: NO_GITLINKS,
      }
    }
    const materialized = await materializeSubmodulesFromLocalWorktreeParallel({
      worktree: path,
      referenceWorktree: reference,
      maxRemoteFallbacks: UNBOUNDED_REMOTE_FALLBACKS,
      ...(env === undefined ? {} : { env }),
      ...(options.log === undefined ? {} : { log: options.log }),
    })
    if (materialized.exitCode !== 0) {
      throw new Error(
        materialized.stderr.trim() ||
          materialized.stdout.trim() ||
          `git-super: submodule materialization exited ${String(materialized.exitCode)}`,
      )
    }
    const gitlinks: WorktreeGitlinkCounts = {
      considered: materialized.considered,
      borrowed: materialized.borrowed - materialized.warmed,
      fetched: materialized.remoteFallbacks + materialized.warmed,
      absent: materialized.unreferenced,
    }
    const report = `${at(path, options.commit, commit)}: ${counts(gitlinks)}`
    return {
      ...gitSuperResult([{ repository: repo, state: "updated", refs: [] }], detail("worktree-added", "report", report)),
      path,
      requested: options.commit,
      commit,
      gitmodules,
      gitlinks,
    }
  } catch (error) {
    const reason = message(error)
    const undone = await rollback(store, path)
    if (undone === undefined) {
      return failed(
        "failed",
        detail(
          "worktree-materialize-failed",
          "materialize",
          `${at(path, options.commit, commit)} failed; the worktree was removed.\n${reason}`,
          "Repair the reported submodule condition, then rerun the same git super worktree add command.",
        ),
        commit,
        gitmodules,
      )
    }
    return failed(
      "unknown",
      detail(
        "worktree-rollback-failed",
        "rollback",
        `${at(path, options.commit, commit)} failed AND the worktree could not be removed; ` +
          `'${path}' is left half-materialized.\n${reason}\nrollback: ${undone}`,
        `Inspect '${path}', remove it with 'git -C ${repo} worktree remove --force ${path}', then rerun.`,
      ),
      commit,
      gitmodules,
    )
  }
}
