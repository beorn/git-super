import { realpathSync } from "node:fs"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { runGit } from "./git.ts"
import { gitSuperResult, type GitSuperResult } from "./result.ts"
import { createLocalGitWorktreeStore } from "./worktree.ts"
import type { WorktreeRemovalProof } from "./worktree-removal.ts"
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
}>

export type SuperWorktreeRemoveResult = GitSuperResult &
  Readonly<{
    path: string
    proof?: WorktreeRemovalProof
    notCompared: readonly NotCompared[]
    reason?: "borrowed"
    borrowers?: readonly string[]
  }>

/** Retention and cleanliness are owned by the same store that performs native removal. */
export async function superWorktreeRemove(options: SuperWorktreeRemoveOptions): Promise<SuperWorktreeRemoveResult> {
  const repo = resolve(options.repo)
  const path = resolve(options.path)
  let proof: WorktreeRemovalProof | undefined
  let removalReturned = false
  try {
    const store = createLocalGitWorktreeStore({ repo })
    if (!(await store.inspect(path)).registered) {
      const owner = owningComponentRepository(repo, path)
      if (owner !== undefined && owner !== repo) {
        return await superWorktreeRemove({ ...options, repo: owner })
      }
    }
    const outcome = await store.remove(path, {
      ...(options.excludedSubmodules === undefined ? {} : { excludedSubmodules: options.excludedSubmodules }),
      ...(options.noRehome === undefined ? {} : { noRehome: options.noRehome }),
      retention: {
        root: options.retain,
        report: (retained) => {
          proof = retained
          options.report?.(`worktree removal proof ${JSON.stringify(retained)}\n`)
        },
      },
    })
    if (outcome !== undefined) {
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
