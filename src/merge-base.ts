import { join } from "node:path"
import type { ConsultedRepository, NotCompared } from "./diff.ts"
import {
  gitError,
  isSubmoduleExcluded,
  probeRepository,
  repositoryRoot,
  runGit,
  tryGit,
  validateExcludedSubmodules,
} from "./git.ts"
import { readPrivateSubmodulePaths } from "./commit-graph.ts"
import { createLocalGitProcess } from "./process.ts"

export type SuperIsAncestorOptions = Readonly<{
  repo: string
  ancestor: string
  descendant: string
  excludedSubmodules?: readonly string[]
}>

export type SuperIsAncestorResult = Readonly<{
  isAncestor: boolean
  owningRepository: string
  comparedTo: string
  consultedRepositories: readonly ConsultedRepository[]
  notCompared: readonly NotCompared[]
}>

type TreeGitlink = Readonly<{ path: string; pin: string }>

const HEX_PREFIX = /^[0-9a-f]{4,40}$/u

/**
 * The commit an ancestor spelling names, decided in the --repo root ONLY.
 *
 * Ownership below is a question about an object, so a NAME has to become an
 * oid before any store is consulted: a ref name such as origin/main resolves in
 * every repository that has that remote, and asking each nested store whether
 * it "has" the name made km's own origin/main ambiguous across km and its
 * nested apps/maddoc, so the equality half of every pin measurement was refused
 * (2026-09-05 to 2026-09-10, @i/1-instruments/24411). A hex prefix is an object
 * spelling and keeps the presence-based ownership; a name that does not resolve
 * in the root is its own refusal, naming the repository it looked in, never a
 * fall-through to a name-based search of the nested stores.
 */
function resolveAncestorInRoot(root: string, ancestor: string): string {
  if (HEX_PREFIX.test(ancestor)) return ancestor
  const resolved = tryGit(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ancestor}^{commit}`])
  if (resolved.exitCode === 0 && resolved.stdout.trim() !== "") return resolved.stdout.trim()
  throw new Error(
    `git super: ancestor '${ancestor}' is a name, and it does not resolve to a commit in ${root}` +
      ` (git rev-parse --verify ${ancestor}^{commit} exited ${resolved.exitCode}${resolved.stderr ? `: ${resolved.stderr}` : ""}).` +
      " Ownership is decided on an oid and a name is resolved only in the --repo root:" +
      " name the commit by its sha, or run inside the repository that owns the ref",
  )
}

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

/**
 * The paths one commit's `.gitmodules` declares `private = true`, read from the commit alone through the single
 * reader, and only when a refusal must name a cure.
 *
 * A manifest that cannot be read leaves the set empty, so the cure list is INCOMPLETE rather than the refusal being
 * replaced by a manifest-read failure. The empty set never suppresses the refusal; it only narrows which cures the
 * message can name.
 */
async function readDeclaredPrivatePaths(root: string, commit: string): Promise<ReadonlySet<string>> {
  try {
    return new Set(await readPrivateSubmodulePaths(createLocalGitProcess(), root, commit))
  } catch {
    // silent-fallback-allow: a `.gitmodules` that cannot be read narrows the cure list to "initialize"; the
    // ancestry refusal still fires, and it never answers a different question or hides the child.
    return new Set()
  }
}

export async function superIsAncestor(options: SuperIsAncestorOptions): Promise<SuperIsAncestorResult> {
  validateExcludedSubmodules(options.excludedSubmodules)
  const root = repositoryRoot(options.repo)
  const consultedRepositories: ConsultedRepository[] = [{ path: ".", root }]

  runGit(root, ["rev-parse", "--verify", `${options.descendant}^{commit}`])
  const ancestor = resolveAncestorInRoot(root, options.ancestor)
  const spelled = ancestor === options.ancestor ? ancestor : `${options.ancestor} (${ancestor})`
  const owners: Array<{ path: string; root: string; target: string }> = []
  const notCompared: NotCompared[] = []
  // The superproject is a CANDIDATE owner, never an automatic one. Returning
  // here on object presence alone is the defect this replaces: a submodule sha
  // sitting in the root store resolved to ".", compared an unrelated history
  // against the superproject tip, and returned a confident `false` — reporting
  // landed work as not landed. That manufactured a "km-revert" finding against
  // a rescue ref whose pin had only ever moved forward.
  const presentAtRoot = objectExists(root, ancestor)
  if (presentAtRoot && reachableFromAnyRef(root, ancestor)) {
    owners.push({ path: ".", root, target: options.descendant })
  }
  let declaredPrivatePaths: ReadonlySet<string> | undefined
  const isDeclaredPrivate = async (path: string): Promise<boolean> => {
    declaredPrivatePaths ??= await readDeclaredPrivatePaths(root, options.descendant)
    return declaredPrivatePaths.has(path)
  }
  for (const gitlink of treeGitlinks(root, options.descendant)) {
    if (isSubmoduleExcluded(gitlink.path, options.excludedSubmodules)) {
      notCompared.push({ path: gitlink.path, reason: "excluded", message: "component excluded, not compared" })
      continue
    }
    try {
      const child = join(root, gitlink.path)
      const nestedRoot = repositoryRoot(child)
      if (probeRepository(nestedRoot, runGit(child, ["rev-parse", "--show-prefix"])).kind === "absent") {
        // A declared-private child must never be initialized, so the refusal the fleet reads must name the
        // exclusion that works beside the initialize cure this message used to print alone (27272).
        throw new Error(
          (await isDeclaredPrivate(gitlink.path))
            ? `not initialized; ${gitlink.path} is declared private, so exclude it with --exclude-submodule ${gitlink.path}, or initialize it, before searching its commit ownership`
            : `not initialized; initialize ${gitlink.path} before searching its commit ownership`,
        )
      }
      if (!objectExists(nestedRoot, gitlink.pin)) {
        throw new Error(`comparison pin ${gitlink.pin} is unreadable in ${nestedRoot}`)
      }
      consultedRepositories.push({ path: gitlink.path, root: nestedRoot, to: gitlink.pin })
      if (!objectExists(nestedRoot, ancestor)) continue
      owners.push({ path: gitlink.path, root: nestedRoot, target: gitlink.pin })
    } catch (error) {
      notCompared.push({
        path: gitlink.path,
        reason: "unreadable",
        objectIds: [gitlink.pin],
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  if (notCompared.some(({ reason }) => reason === "unreadable")) {
    throw new Error(
      `git super: ancestry unknown for ${spelled}; searched ${root} and included components:\n${notCompared.map(({ path, message }) => `${path}: ${message}`).join("\n")}`,
    )
  }
  if (owners.length === 0) {
    // The breadcrumb for the case that used to answer silently and wrongly.
    // "Present but unreachable" is a different problem from "absent", and a
    // reader who is told only "no owner" will go looking in the wrong place.
    const orphaned = presentAtRoot
      ? " — the object IS in the superproject's store but no ref reaches it, so the superproject does not own it either;" +
        " run the comparison inside the repository the commit belongs to (git -C <submodule>)"
      : ""
    throw new Error(`git super: no consulted repository owns commit ${spelled}${orphaned}`)
  }
  if (owners.length > 1) {
    // Named, never silently preferred. Picking one here is how the wrong
    // object store wins an argument it should not have been in.
    throw new Error(
      `git super: commit ${spelled} is ambiguous across ${owners.map(({ path }) => path).join(", ")}` +
        " — compare it inside the repository you mean (git -C <path> merge-base --is-ancestor)",
    )
  }
  const owner = owners[0]!
  return {
    isAncestor: isAncestor(owner.root, ancestor, owner.target),
    owningRepository: owner.path,
    comparedTo: owner.target,
    consultedRepositories,
    notCompared,
  }
}
