/**
 * `git super branch retire <branch> --tip <sha>` (28989).
 *
 * The sweep can archive a branch and still be unable to retire it: `branch -d`
 * refuses an unmerged tip, `-D` is banned, and a raw `update-ref -d` writes no
 * receipt. This is the missing path — retire ONE local branch name whose exact
 * commit is already held by its archive ref.
 *
 * The invariant is `archive-ref.ts`'s, unchanged: a branch name is retired only
 * after its archive ref READS BACK as the pinned tip. This verb requires that
 * custody to ALREADY EXIST — it never creates one — so an unarchived or
 * mismatched branch is refused by name rather than half-archived. It deletes
 * `refs/heads/<b>` ONLY: the archive ref is never written, no remote ref is
 * touched, and a checked-out branch is refused by the same predicate the
 * retirement write uses.
 */
import { resolve } from "node:path"
import { ARCHIVE_REF_PREFIX, archiveRefFor } from "./archive-ref.ts"
import { tryGit } from "./git.ts"
import { gitSuperResult, type GitSuperResult } from "./result.ts"
import { createLocalGitWorktreeStore } from "./worktree.ts"

export type SuperBranchRetireOptions = Readonly<{
  repo: string
  branch: string
  tip: string
  /**
   * The archive ref whose readback must equal `tip`. Defaults to the canonical
   * `refs/archive/<date>/<actor>/<branch>` built from `actor` (and `date`).
   */
  archive?: string
  /** Actor segment for the canonical archive ref; required when `archive` is absent. */
  actor?: string
  /** UTC date (`YYYY-MM-DD`) for the canonical archive ref; defaults to today. */
  date?: string
  dryRun?: boolean
}>

export type SuperBranchRetireResult = GitSuperResult &
  Readonly<{
    branch: string
    tip: string
    archiveRef: string
    /** ISO 8601 timestamp of the decision this receipt records. */
    time: string
    dryRun: boolean
  }>

const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u

/** `rev-parse --verify` a ref, returning its oid or undefined when absent or unreadable. */
function oidOf(repo: string, ref: string): string | undefined {
  const result = tryGit(repo, ["rev-parse", "--verify", "--quiet", ref])
  if (result.exitCode !== 0) return undefined
  const oid = result.stdout.trim()
  return oid === "" ? undefined : oid
}

export async function superBranchRetire(options: SuperBranchRetireOptions): Promise<SuperBranchRetireResult> {
  const repo = resolve(options.repo)
  const branch = options.branch
  const tip = options.tip.trim()
  if (!FULL_OID.test(tip)) {
    throw new Error(`branch ${branch}: --tip must be a full SHA1 or SHA256 commit, got ${JSON.stringify(options.tip)}`)
  }
  if (tryGit(repo, ["check-ref-format", "--branch", branch]).exitCode !== 0) {
    throw new Error(`${JSON.stringify(branch)} is not a valid branch name`)
  }
  const archiveRef = resolveArchiveRef(options, branch)
  if (tryGit(repo, ["check-ref-format", archiveRef]).exitCode !== 0) {
    throw new Error(`branch ${branch}: ${JSON.stringify(archiveRef)} is not a valid ref name`)
  }
  if (!archiveRef.startsWith(`${ARCHIVE_REF_PREFIX}/`)) {
    throw new Error(`branch ${branch}: custody ref ${archiveRef} is outside ${ARCHIVE_REF_PREFIX}/`)
  }
  // The custody must EXIST and read back the exact tip; an archive is evidence, never assumed (28989).
  const archivedTip = oidOf(repo, archiveRef)
  if (archivedTip === undefined) {
    throw new Error(
      `branch ${branch}: no archive ref ${archiveRef} holds this commit; archive the branch at its tip ${tip} first, then retire it`,
    )
  }
  if (archivedTip !== tip) {
    throw new Error(
      `branch ${branch}: archive ref ${archiveRef} reads back ${archivedTip}, not the requested tip ${tip}; the mismatched archive is left untouched`,
    )
  }
  const branchRef = `refs/heads/${branch}`
  const currentTip = oidOf(repo, branchRef)
  if (currentTip === undefined) {
    throw new Error(`branch ${branch}: ${branchRef} is absent; nothing to retire`)
  }
  if (currentTip !== tip) {
    throw new Error(
      `branch ${branch}: ${branchRef} reads back ${currentTip}, not the requested tip ${tip}; an advanced branch is kept`,
    )
  }
  const time = new Date().toISOString()
  const store = createLocalGitWorktreeStore({ repo })
  const held = await store.branchHolder(branch)
  if (held !== undefined) throw new Error(held)
  if (options.dryRun === true) {
    return {
      ...gitSuperResult([{ repository: repo, state: "unchanged", refs: [] }]),
      branch,
      tip,
      archiveRef,
      time,
      dryRun: true,
    }
  }
  await store.removeArchivedBranch({ branch, tip, archiveRef })
  return {
    ...gitSuperResult([{ repository: repo, state: "updated", refs: [] }]),
    branch,
    tip,
    archiveRef,
    time,
    dryRun: false,
  }
}

function resolveArchiveRef(options: SuperBranchRetireOptions, branch: string): string {
  if (options.archive !== undefined && options.archive.trim() !== "") return options.archive.trim()
  const actor = options.actor?.trim()
  if (actor === undefined || actor === "") {
    throw new Error(
      `branch ${branch}: name the archive ref to require (--archive <ref>), or the actor whose canonical archive ref holds the tip (--actor <seat>)`,
    )
  }
  const date = options.date?.trim() ?? new Date().toISOString().slice(0, 10)
  return archiveRefFor(branch, actor, date)
}
