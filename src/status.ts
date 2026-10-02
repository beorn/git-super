import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs"
import { isAbsolute, join, posix, resolve } from "node:path"
import { recursiveNameStatusDiff, type ConsultedRepository, type NotCompared } from "./diff.ts"
export type { ConsultedRepository } from "./diff.ts"
import {
  gitError,
  indexGitlinks,
  isSubmoduleExcluded,
  probeRepository,
  repositoryRoot,
  runGit,
  tryGit,
  validateExcludedSubmodules,
} from "./git.ts"

export type SuperStatusOptions = Readonly<{ repo: string; indexFile?: string; excludedSubmodules?: readonly string[] }>

/** Checkout metadata only: never follow a symlink or read a Git pointer/store. */
export function inspectUninitializedCheckout(
  path: string,
): "absent" | "empty" | "nonempty" | "symlink" | "non-directory" {
  const state = lstatSync(path, { throwIfNoEntry: false })
  if (state === undefined) return "absent"
  if (state.isSymbolicLink()) return "symlink"
  if (!state.isDirectory()) return "non-directory"
  return readdirSync(path).length === 0 ? "empty" : "nonempty"
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
  /** Existing empty gitlink directories with no repository of their own; these are not dirty records. */
  uninitializedSubmodules: readonly string[]
  /** Named uncertainty is observable, but never sufficient evidence for worktree removal. */
  submoduleProblems: readonly Readonly<{ path: string; reason: string; gitDir?: string }>[]
}>

function nulFields(value: string): string[] {
  return value.split("\0").filter(Boolean)
}

function headGitlinks(root: string): Map<string, string> {
  const head = tryGit(root, ["rev-parse", "--verify", "--quiet", "HEAD"])
  // An unborn repository has no HEAD tree; its indexed additions still remain explicit dirt.
  if (head.exitCode === 1 && head.stderr === "") return new Map()
  if (head.exitCode !== 0) {
    throw gitError(root, ["rev-parse", "--verify", "--quiet", "HEAD"], head.exitCode, head.stderr)
  }
  const result = new Map<string, string>()
  for (const field of nulFields(runGit(root, ["ls-tree", "-r", "-z", "HEAD"]))) {
    const match = /^160000 commit ([0-9a-f]{40})\t(.+)$/u.exec(field)
    if (match?.[1] !== undefined && match[2] !== undefined) result.set(match[2], match[1])
  }
  return result
}

function parsePorcelain(value: string): string[] {
  const fields = nulFields(value)
  const records: string[] = []
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    if (field === undefined || field.length < 4) throw new Error("git super: malformed porcelain status")
    records.push(field)
    if (field[0] === "R" || field[0] === "C") index += 1
  }
  return records
}

function prefixPorcelain(record: string, prefix: string): string {
  return `${record.slice(0, 3)}${posix.join(prefix, record.slice(3))}`
}

function diffRecords(
  root: string,
  from: string,
  to: string,
  column: "index" | "worktree",
  prefix: string,
  excludedSubmodules: readonly string[],
): Readonly<{ records: string[]; notCompared: readonly NotCompared[] }> {
  if (from === to) return { records: [], notCompared: [] }
  const result = recursiveNameStatusDiff({
    repo: root,
    prefix,
    refs: [`${from}..${to}`],
    consulted: { path: prefix, root, from, to },
    excludedSubmodules,
  })
  return {
    notCompared: result.notCompared,
    records: result.entries.map(({ status, path }) => {
      const code = status[0] ?? "M"
      return `${column === "index" ? code : " "}${column === "worktree" ? code : " "} ${path}`
    }),
  }
}

function statusRepository(
  root: string,
  prefix: string,
  consulted: ConsultedRepository,
  indexFile?: string,
  excludedSubmodules: readonly string[] = [],
): SuperStatusResult {
  const gitlinks = indexGitlinks(root, indexFile)
  const indexed = new Map(gitlinks.map(({ path, indexPin }) => [path, indexPin]))
  const head = headGitlinks(root)
  const paths = [...new Set([...head.keys(), ...indexed.keys()])].sort((left, right) => left.localeCompare(right))
  const checkedOutGitlinks = new Set<string>()
  const rootRecords = parsePorcelain(
    runGit(
      root,
      [
        "--no-optional-locks",
        "-c",
        "status.renames=false",
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignore-submodules=all",
      ],
      indexFile,
    ),
  ).map((record) => prefixPorcelain(record, prefix))
  // --ignore-submodules=all suppresses staged pins too. Read the index without consulting child checkouts.
  const staged = nulFields(
    runGit(
      root,
      [
        "diff",
        "--cached",
        "--name-status",
        "-z",
        "--no-renames",
        excludedSubmodules.length ? "--ignore-submodules=dirty" : "--ignore-submodules=none",
      ],
      indexFile,
    ),
  )
  for (let index = 0; index < staged.length; index += 2) {
    const code = staged[index]
    const path = staged[index + 1]
    if (code === undefined || path === undefined) throw new Error("git super: malformed staged name-status diff")
    if (
      (head.has(path) || indexed.has(path)) &&
      !rootRecords.some(
        (record) => record[0] !== " " && record[0] !== "?" && record.slice(3) === posix.join(prefix, path),
      )
    ) {
      rootRecords.push(`${code[0]}  ${posix.join(prefix, path)}`)
    }
  }
  const consultedRepositories: ConsultedRepository[] = [consulted]
  const nestedRecords: string[] = []
  const uninitializedSubmodules: string[] = []
  const submoduleProblems: SuperStatusResult["submoduleProblems"][number][] = []
  const notCompared: NotCompared[] = []

  for (const path of paths) {
    const child = join(root, path)
    const nestedPrefix = posix.join(prefix, path)
    if (isSubmoduleExcluded(nestedPrefix, excludedSubmodules)) {
      notCompared.push({ path: nestedPrefix, reason: "excluded", message: "component excluded, not compared" })
      continue
    }
    let gitDir: string | undefined
    let symbolicCheckout = false
    if (indexed.has(path) && indexed.get(path) === undefined) {
      submoduleProblems.push({
        path: nestedPrefix,
        reason: `unmerged gitlink ${child} has no resolved index pin; resolve its conflict before removal`,
      })
      continue
    }
    try {
      const childState = lstatSync(child)
      symbolicCheckout = childState.isSymbolicLink()
      const metadata = join(child, ".git")
      const metadataState = lstatSync(metadata, { throwIfNoEntry: false })
      if (metadataState?.isFile()) {
        const pointer = /^gitdir: (.+)\r?\n?$/u.exec(readFileSync(metadata, "utf8").trim())?.[1]
        if (pointer !== undefined) gitDir = resolve(child, pointer)
      }
      const nestedRoot = repositoryRoot(child)
      const probe = probeRepository(nestedRoot, runGit(child, ["rev-parse", "--show-prefix"]))
      if (childState.isSymbolicLink()) {
        submoduleProblems.push({
          path: nestedPrefix,
          reason: `checkout ${child} is a symbolic link; preserve its target before removal`,
        })
        continue
      }
      if (probe.kind === "absent") {
        if (inspectUninitializedCheckout(child) !== "empty") {
          throw new Error(
            `uninitialized directory ${child} is not empty and has no repository of its own; preserve its files and initialize the submodule before removal`,
          )
        }
        uninitializedSubmodules.push(nestedPrefix)
        continue
      }
      const checkoutPin = runGit(nestedRoot, ["rev-parse", "HEAD"]).trim()
      const headPin = head.get(path)
      const indexPin = indexed.get(path)
      if (headPin !== undefined && indexPin !== undefined) {
        const indexDiff = diffRecords(nestedRoot, headPin, indexPin, "index", nestedPrefix, excludedSubmodules)
        const checkoutDiff = diffRecords(
          nestedRoot,
          indexPin,
          checkoutPin,
          "worktree",
          nestedPrefix,
          excludedSubmodules,
        )
        const indexRecords = indexDiff.records
        const checkoutRecords = checkoutDiff.records
        for (const observation of [...indexDiff.notCompared, ...checkoutDiff.notCompared]) {
          notCompared.push(observation)
          if (observation.reason === "unreadable") {
            submoduleProblems.push({
              path: observation.path,
              reason: `${observation.message}${observation.remedy ? `; ${observation.remedy}` : ""}`,
            })
          }
        }
        // A pointer move can have an unchanged tree; its commit identity is still dirt.
        nestedRecords.push(...indexRecords)
        if (headPin !== indexPin && indexRecords.length === 0 && indexDiff.notCompared.length === 0) {
          nestedRecords.push(`M  ${nestedPrefix}`)
        }
        nestedRecords.push(...checkoutRecords)
        if (indexPin !== checkoutPin && checkoutRecords.length === 0 && checkoutDiff.notCompared.length === 0) {
          nestedRecords.push(` M ${nestedPrefix}`)
        }
      }
      const nested = statusRepository(
        nestedRoot,
        nestedPrefix,
        {
          path: nestedPrefix,
          root: nestedRoot,
          ...(indexPin === undefined ? {} : { from: indexPin }),
          to: checkoutPin,
        },
        undefined,
        excludedSubmodules,
      )
      nestedRecords.push(...nested.records)
      consultedRepositories.push(...nested.consultedRepositories)
      uninitializedSubmodules.push(...nested.uninitializedSubmodules)
      submoduleProblems.push(...nested.submoduleProblems)
      notCompared.push(...nested.notCompared)
      if (headPin !== undefined && indexPin !== undefined) checkedOutGitlinks.add(nestedPrefix)
    } catch (error) {
      submoduleProblems.push({
        path: nestedPrefix,
        reason: `${child}: ${symbolicCheckout ? "symbolic link checkout; " : ""}${error instanceof Error ? error.message : String(error)}`,
        ...(gitDir === undefined ? {} : { gitDir }),
      })
    }
  }

  return {
    records: [
      ...new Set([
        ...rootRecords.filter(
          (record) =>
            !checkedOutGitlinks.has(record.slice(3)) && !isSubmoduleExcluded(record.slice(3), excludedSubmodules),
        ),
        ...nestedRecords,
      ]),
    ].sort((left, right) => left.slice(3).localeCompare(right.slice(3))),
    consultedRepositories,
    uninitializedSubmodules,
    submoduleProblems,
    notCompared: [...new Map(notCompared.map((entry) => [`${entry.path}\0${entry.reason}`, entry])).values()],
  }
}

export function superStatus(options: SuperStatusOptions): SuperStatusResult {
  validateExcludedSubmodules(options.excludedSubmodules)
  const root = repositoryRoot(options.repo)
  const indexFile = options.indexFile
  if (indexFile !== undefined) {
    if (!isAbsolute(indexFile)) throw new Error(`git super status: --index-file must be absolute: ${indexFile}`)
    try {
      if (!statSync(indexFile).isFile()) throw new Error("not a file")
    } catch (error) {
      throw new Error(`git super status: --index-file is not a readable file: ${indexFile}`, { cause: error })
    }
  }
  return statusRepository(
    root,
    "",
    { path: ".", root, ...(indexFile === undefined ? {} : { indexFile }) },
    indexFile,
    options.excludedSubmodules,
  )
}
