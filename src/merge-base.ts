import { join } from "node:path"
import type { ConsultedRepository } from "./diff.ts"
import { GitError, repositoryRoot, runGit, tryGit } from "./git.ts"

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
  throw new GitError(root, ["merge-base", "--is-ancestor", ancestor, descendant], result.exitCode, result.stderr)
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
  if (objectExists(root, options.ancestor)) {
    return {
      isAncestor: isAncestor(root, options.ancestor, options.descendant),
      owningRepository: ".",
      comparedTo: options.descendant,
      consultedRepositories,
    }
  }

  runGit(root, ["rev-parse", "--verify", `${options.descendant}^{commit}`])
  const owners: Array<{ path: string; root: string; target: string }> = []
  for (const gitlink of treeGitlinks(root, options.descendant)) {
    const nestedRoot = repositoryRoot(join(root, gitlink.path))
    consultedRepositories.push({ path: gitlink.path, root: nestedRoot, to: gitlink.pin })
    if (!objectExists(nestedRoot, options.ancestor)) continue
    owners.push({ path: gitlink.path, root: nestedRoot, target: gitlink.pin })
  }
  if (owners.length === 0) {
    throw new Error(`git super: no consulted repository owns commit ${options.ancestor}`)
  }
  if (owners.length > 1) {
    throw new Error(
      `git super: commit ${options.ancestor} is ambiguous across ${owners.map(({ path }) => path).join(", ")}`,
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
