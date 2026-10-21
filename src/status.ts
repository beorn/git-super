import { driveSync, statusTraversal } from "./status-traversal.ts"
import { lstatSync } from "node:fs"
import { join } from "node:path"
import type { ConsultedRepository, NotCompared } from "./diff.ts"
export type { ConsultedRepository } from "./diff.ts"
import { inspectUninitializedCheckout, validateExcludedSubmodules } from "./git.ts"

export type SuperStatusOptions = Readonly<{ repo: string; indexFile?: string; excludedSubmodules?: readonly string[] }>

/** Inspect selected checkout metadata without following an ancestor or reading Git pointer/store bytes. */
export function inspectExcludedCheckout(root: string, path: string) {
  validateExcludedSubmodules([path])
  let ancestor = root
  let unsafeAncestor: string | undefined
  for (const part of path.split("/").slice(0, -1)) {
    ancestor = join(ancestor, part)
    const metadata = lstatSync(ancestor, { throwIfNoEntry: false })
    if (metadata === undefined) break
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      unsafeAncestor = ancestor
      break
    }
  }
  const state = unsafeAncestor === undefined ? inspectUninitializedCheckout(join(root, path)) : "unsafe-ancestor"
  const checkout: NonNullable<NotCompared["exclusion"]>["checkout"] =
    state === "non-directory"
      ? "content"
      : state === "nonempty"
        ? lstatSync(join(root, path, ".git"), { throwIfNoEntry: false }) === undefined
          ? "content"
          : "checkout"
        : state
  return { state, checkout, unsafeAncestor }
}

/** Classify parent identity from frozen native evidence and checkout metadata, without any Git or filesystem reads. */
export function classifyExcludedPath(
  path: string,
  parents: NonNullable<NotCompared["exclusion"]>["parents"],
  checkout: NonNullable<NotCompared["exclusion"]>["checkout"],
): NonNullable<NotCompared["exclusion"]> {
  validateExcludedSubmodules([path])
  if (parents.length === 0 || parents.some((parent) => parent.path !== path)) {
    throw new Error(
      `missing selected parent evidence for excluded ${path}; collect its frozen parent identity before classification`,
    )
  }
  const declared = parents.every(
    (parent) =>
      parent.treeEntry?.mode === "160000" && parent.treeEntry.type === "commit" && parent.declarations.length === 1,
  )
  const absent =
    parents.every(
      (parent) =>
        parent.treeEntry === null &&
        parent.declarations.length === 0 &&
        (parent.index === undefined || parent.index.entries.length === 0),
    ) &&
    (checkout === "absent" || checkout === "empty")
  return { classification: declared ? "declared" : absent ? "absent" : "unclassified", parents, checkout }
}

export type SuperStatusResult = Readonly<{
  records: readonly string[]
  consultedRepositories: readonly ConsultedRepository[]
  notCompared: readonly NotCompared[]
  /** Gitlinks whose checkout is absent or an empty directory AND whose module repository is gone --
   * they hold nothing, so they are not dirty records and not a problem. Two other shapes are a
   * `submoduleProblems` entry naming that repository's own command: a checkout directory that exists
   * WITH contents, and a checkout with no files whose module repository survives at
   * `<git-dir>/modules/<name>` (`deinit` and `rm -rf` both keep it). */
  uninitializedSubmodules: readonly string[]
  /** Named uncertainty is observable, but never sufficient evidence for worktree removal. */
  submoduleProblems: readonly Readonly<{
    kind: "repository-not-consulted" | "diff-unreadable"
    path: string
    reason: string
    gitDir?: string
  }>[]
}>

export function superStatus(options: SuperStatusOptions): SuperStatusResult {
  return driveSync(statusTraversal(options))
}
