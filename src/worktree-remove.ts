import { realpathSync } from "node:fs"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { runGit } from "./git.ts"
import { gitSuperResult, type GitSuperResult } from "./result.ts"
import { createLocalGitWorktreeStore } from "./worktree.ts"
import type { CompactionResult } from "./retention-compact.ts"
import type { PrivateStoreDiscard, WorktreeRemovalProof } from "./worktree-removal.ts"
import type { NotCompared } from "./diff.ts"

function within(parent: string, path: string): boolean {
  const part = relative(parent, path)
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part))
}

/** A linked worktree of a submodule is registered under the super's modules store, not the super worktree list (28393). */
function owningComponentRepository(superRepo: string, path: string): string | undefined {
  const gitdir = realpathSync(runGit(path, ["rev-parse", "--absolute-git-dir"]).trim())
  const common = realpathSync(runGit(superRepo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim())
  const modules = join(common, "modules")
  if (!within(modules, gitdir)) {
    throw new Error(`worktree ${path} gitdir ${gitdir} is outside ${modules}`)
  }
  const owner = realpathSync(runGit(gitdir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim())
  if (!within(modules, owner)) {
    throw new Error(`worktree ${path} gitdir ${gitdir} is outside ${modules}`)
  }
  return owner
}

export type SuperWorktreeRemoveOptions = Readonly<{
  repo: string
  path: string
  retain: string
  report?: (message: string) => void
  excludedSubmodules?: readonly string[]
  noRehome?: boolean
  /**
   * The operator's explicit decision to delete a declared-private submodule store on purpose (28661 gate
   * `git-worktree-private-store`). The reason is REQUIRED by the guard; the actor is resolved by the caller and
   * `null` records plainly that none could be named.
   */
  discardPrivateStore?: Readonly<{ reason: string; actor?: string | null }>
}>

export type SuperWorktreeRemoveResult = GitSuperResult &
  Readonly<{
    path: string
    proof?: WorktreeRemovalProof
    notCompared: readonly NotCompared[]
    reason?: "borrowed"
    borrowers?: readonly string[]
    /** Stores this removal deleted on purpose, present only when the override ran. */
    discardedStores?: readonly PrivateStoreDiscard[]
    /** Present when a retained copy was compacted after native --force; failure does not fail the removal. */
    compaction?: CompactionResult
  }>

/** Retention and cleanliness are owned by the same store that performs native removal. */
export async function superWorktreeRemove(options: SuperWorktreeRemoveOptions): Promise<SuperWorktreeRemoveResult> {
  const repo = resolve(options.repo)
  const path = resolve(options.path)
  let proof: WorktreeRemovalProof | undefined
  let removalReturned = false
  const discarded: PrivateStoreDiscard[] = []
  try {
    const store = createLocalGitWorktreeStore({
      repo,
      // The override journals BEFORE the store goes, and the line names the actor or says there is none: a
      // discard nobody can read the cause of later is a mistake with extra steps (@cto 2026-10-11).
      journal: (record) => {
        discarded.push(record)
        // F1 (@cto 0d4c5e3a): this line is written BEFORE the deletion, so it says "discarding", not "discarded" —
        // a removal that then fails must not read as a completed deletion. The stores that actually went are named
        // in the result's own discardedStores, which exists only after the removal returned.
        options.report?.(
          `git-super: @gate/git-worktree-private-store: discarding store ${record.store} (${record.path}) ` +
            `actor=${record.actor ?? "(no actor token)"} reason=${JSON.stringify(record.reason)} ` +
            `(journaled before deletion)\n`,
        )
      },
    })
    if (!(await store.inspect(path)).registered) {
      const owner = owningComponentRepository(repo, path)
      if (owner !== undefined && owner !== repo) {
        return await superWorktreeRemove({ ...options, repo: owner })
      }
    }
    const outcome = await store.remove(path, {
      ...(options.excludedSubmodules === undefined ? {} : { excludedSubmodules: options.excludedSubmodules }),
      ...(options.noRehome === undefined ? {} : { noRehome: options.noRehome }),
      ...(options.discardPrivateStore === undefined ? {} : { discardPrivateStore: options.discardPrivateStore }),
      retention: {
        root: options.retain,
        report: (retained) => {
          proof = retained
          options.report?.(`worktree removal proof ${JSON.stringify(retained)}\n`)
        },
      },
    })
    if (outcome !== undefined && "borrowers" in outcome) {
      return {
        ...gitSuperResult([{ repository: repo, state: "unchanged", refs: [] }]),
        path,
        notCompared: [],
        reason: "borrowed",
        borrowers: outcome.borrowers,
      }
    }
    removalReturned = true
    if (proof === undefined) throw new Error(`worktree ${path} removal returned without its required retention proof`)
    return {
      ...gitSuperResult([{ repository: repo, state: "updated", refs: [] }]),
      path,
      notCompared: proof.notCompared,
      proof,
      ...(outcome !== undefined && "compaction" in outcome ? { compaction: outcome.compaction } : {}),
      ...(discarded.length === 0 ? {} : { discardedStores: discarded }),
    }
  } catch (error) {
    const detail = {
      code: "worktree-remove-failed",
      phase: removalReturned || proof !== undefined ? "remove" : "retention",
      message: `worktree ${path} could not be removed: ${error instanceof Error ? error.message : String(error)}`,
      remedy:
        "Resolve the reported condition and inspect git worktree list before retrying; retained stores are never removed automatically.",
    }
    return {
      ...gitSuperResult(
        [{ repository: repo, state: removalReturned || proof !== undefined ? "unknown" : "failed", refs: [], detail }],
        detail,
      ),
      path,
      notCompared: proof === undefined ? [] : proof.notCompared,
      ...(proof === undefined ? {} : { proof }),
    }
  }
}
