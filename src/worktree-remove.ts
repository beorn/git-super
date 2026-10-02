import { resolve } from "node:path"
import { gitSuperResult, type GitSuperResult } from "./result.ts"
import { createLocalGitWorktreeStore } from "./worktree.ts"
import type { WorktreeRemovalProof } from "./worktree-removal.ts"
import type { NotCompared } from "./diff.ts"

export type SuperWorktreeRemoveOptions = Readonly<{
  repo: string
  path: string
  retain: string
  report?: (message: string) => void
  excludedSubmodules?: readonly string[]
}>

export type SuperWorktreeRemoveResult = GitSuperResult &
  Readonly<{
    path: string
    proof?: WorktreeRemovalProof
    notCompared: readonly NotCompared[]
  }>

/** Retention and cleanliness are owned by the same store that performs native removal. */
export async function superWorktreeRemove(options: SuperWorktreeRemoveOptions): Promise<SuperWorktreeRemoveResult> {
  const repo = resolve(options.repo)
  const path = resolve(options.path)
  let proof: WorktreeRemovalProof | undefined
  let removalReturned = false
  try {
    const store = createLocalGitWorktreeStore({ repo })
    await store.remove(path, {
      ...(options.excludedSubmodules === undefined ? {} : { excludedSubmodules: options.excludedSubmodules }),
      retention: {
        root: options.retain,
        report: (retained) => {
          proof = retained
          options.report?.(`worktree removal proof ${JSON.stringify(retained)}\n`)
        },
      },
    })
    removalReturned = true
    if (proof === undefined) throw new Error(`worktree ${path} removal returned without its required retention proof`)
    return {
      ...gitSuperResult([{ repository: repo, state: "updated", refs: [] }]),
      path,
      notCompared: proof.notCompared,
      proof,
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
