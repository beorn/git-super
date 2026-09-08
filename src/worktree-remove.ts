import { resolve } from "node:path"
import { gitSuperResult, type GitSuperResult } from "./result.ts"
import { createLocalGitWorktreeStore } from "./worktree.ts"
import type { WorktreeRemovalProof } from "./worktree-removal.ts"

export type SuperWorktreeRemoveOptions = Readonly<{
  repo: string
  path: string
  retain: string
  report?: (message: string) => void
}>

export type SuperWorktreeRemoveResult = GitSuperResult & Readonly<{ path: string; proof?: WorktreeRemovalProof }>

/** Retention and cleanliness are owned by the same store that performs native removal. */
export async function superWorktreeRemove(options: SuperWorktreeRemoveOptions): Promise<SuperWorktreeRemoveResult> {
  const repo = resolve(options.repo)
  const path = resolve(options.path)
  let proof: WorktreeRemovalProof | undefined
  try {
    const store = createLocalGitWorktreeStore({ repo })
    await store.remove(path, {
      retention: {
        root: options.retain,
        report: (retained) => {
          proof = retained
          options.report?.(`worktree removal proof ${JSON.stringify(retained)}\n`)
        },
      },
    })
    return {
      ...gitSuperResult([{ repository: repo, state: "updated", refs: [] }]),
      path,
      ...(proof === undefined ? {} : { proof }),
    }
  } catch (error) {
    const detail = {
      code: "worktree-remove-failed",
      phase: proof === undefined ? "retention" : "remove",
      message: `worktree ${path} could not be removed: ${error instanceof Error ? error.message : String(error)}`,
      remedy:
        "Resolve the reported condition and inspect git worktree list before retrying; retained stores are never removed automatically.",
    }
    return {
      ...gitSuperResult(
        [{ repository: repo, state: proof === undefined ? "failed" : "unknown", refs: [], detail }],
        detail,
      ),
      path,
      ...(proof === undefined ? {} : { proof }),
    }
  }
}
