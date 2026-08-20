import { join } from "node:path"
import type { ConsultedRepository } from "./diff.ts"
import { gitError, repositoryRoot, runGit, tryGit } from "./git.ts"

export type SuperIsAncestorOptions = Readonly<{
  repo: string
  ancestor: string
  descendant: string
}>

export type SuperIsAncestorResult = Readonly<{
  isAncestor: boolean
  owningRepository: string
  comparedTo: string
  consultedRepositories: readonly ConsultedRepository[]
}>

type TreeGitlink = Readonly<{ path: string; pin: string }>

function objectExists(root: string, revision: string): boolean {
  return tryGit(root, ["cat-file", "-e", `${revision}^{commit}`]).exitCode === 0
}

function isAncestor(root: string, ancestor: string, descendant: string): boolean {
  const result = tryGit(root, ["merge-base", "--is-ancestor", ancestor, descendant])
  if (result.exitCode === 0) return true
  if (result.exitCode === 1) return false
  throw gitError(root, ["merge-base", "--is-ancestor", ancestor, descendant], result.exitCode, result.stderr)
}

/**
 * Whether a repository's OWN refs reach a commit.
 *
 * Ownership, not mere presence. A superproject's object store accumulates its
 * submodules' commits — through a stray fetch, shared alternates, or a
 * component branch pushed onto the superproject's remote — and `cat-file -e`
 * cannot tell those apart from its own history. Reachability can: an object
 * that arrived sideways is named by no ref.
 */
function reachableFromAnyRef(root: string, revision: string): boolean {
  return tryGit(root, ["name-rev", "--no-undefined", revision]).exitCode === 0
}

function treeGitlinks(root: string, ref: string): TreeGitlink[] {
  const fields = runGit(root, ["ls-tree", "-r", "-z", ref]).split("\0").filter(Boolean)
  return fields
    .map((field) => {
      const match = /^160000 commit ([0-9a-f]{40})\t(.+)$/u.exec(field)
      return match ? { pin: match[1]!, path: match[2]! } : undefined
    })
    .filter((value): value is TreeGitlink => value !== undefined)
    .sort((left, right) => left.path.localeCompare(right.path))
}

export function superIsAncestor(options: SuperIsAncestorOptions): SuperIsAncestorResult {
  const root = repositoryRoot(options.repo)
  const consultedRepositories: ConsultedRepository[] = [{ path: ".", root }]

  runGit(root, ["rev-parse", "--verify", `${options.descendant}^{commit}`])
  const owners: Array<{ path: string; root: string; target: string }> = []
  // The superproject is a CANDIDATE owner, never an automatic one. Returning
  // here on object presence alone is the defect this replaces: a submodule sha
  // sitting in the root store resolved to ".", compared an unrelated history
  // against the superproject tip, and returned a confident `false` — reporting
  // landed work as not landed. That manufactured a "km-revert" finding against
  // a rescue ref whose pin had only ever moved forward.
  const presentAtRoot = objectExists(root, options.ancestor)
  if (presentAtRoot && reachableFromAnyRef(root, options.ancestor)) {
    owners.push({ path: ".", root, target: options.descendant })
  }
  for (const gitlink of treeGitlinks(root, options.descendant)) {
    const nestedRoot = repositoryRoot(join(root, gitlink.path))
    consultedRepositories.push({ path: gitlink.path, root: nestedRoot, to: gitlink.pin })
    if (!objectExists(nestedRoot, options.ancestor)) continue
    owners.push({ path: gitlink.path, root: nestedRoot, target: gitlink.pin })
  }
  if (owners.length === 0) {
    // The breadcrumb for the case that used to answer silently and wrongly.
    // "Present but unreachable" is a different problem from "absent", and a
    // reader who is told only "no owner" will go looking in the wrong place.
    const orphaned = presentAtRoot
      ? " — the object IS in the superproject's store but no ref reaches it, so the superproject does not own it either;" +
        " run the comparison inside the repository the commit belongs to (git -C <submodule>)"
      : ""
    throw new Error(`git super: no consulted repository owns commit ${options.ancestor}${orphaned}`)
  }
  if (owners.length > 1) {
    // Named, never silently preferred. Picking one here is how the wrong
    // object store wins an argument it should not have been in.
    throw new Error(
      `git super: commit ${options.ancestor} is ambiguous across ${owners.map(({ path }) => path).join(", ")}` +
        " — compare it inside the repository you mean (git -C <path> merge-base --is-ancestor)",
    )
  }
  const owner = owners[0]!
  return {
    isAncestor: isAncestor(owner.root, options.ancestor, owner.target),
    owningRepository: owner.path,
    comparedTo: owner.target,
    consultedRepositories,
  }
}
