import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs"
import { isAbsolute, join, posix, resolve } from "node:path"
import { recursiveNameStatusDiff, type ConsultedRepository } from "./diff.ts"
import { gitError, indexGitlinks, probeRepository, repositoryRoot, runGit, tryGit } from "./git.ts"

export type SuperStatusOptions = Readonly<{ repo: string; indexFile?: string }>

export type SuperStatusResult = Readonly<{
  records: readonly string[]
  consultedRepositories: readonly ConsultedRepository[]
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

function diffRecords(root: string, from: string, to: string, column: "index" | "worktree", prefix: string): string[] {
  if (from === to) return []
  return recursiveNameStatusDiff({
    repo: root,
    prefix,
    refs: [`${from}..${to}`],
    consulted: { path: prefix, root, from, to },
  }).entries.map(({ status, path }) => {
    const code = status[0] ?? "M"
    return `${column === "index" ? code : " "}${column === "worktree" ? code : " "} ${path}`
  })
}

function statusRepository(
  root: string,
  prefix: string,
  consulted: ConsultedRepository,
  indexFile?: string,
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
    runGit(root, ["diff", "--cached", "--name-status", "-z", "--no-renames", "--ignore-submodules=none"], indexFile),
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

  for (const path of paths) {
    const child = join(root, path)
    const nestedPrefix = posix.join(prefix, path)
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
        if (readdirSync(child).length > 0) {
          throw new Error(
            `directory ${child} is not empty and has no repository of its own; preserve its files before removal`,
          )
        }
        uninitializedSubmodules.push(nestedPrefix)
        continue
      }
      const checkoutPin = runGit(nestedRoot, ["rev-parse", "HEAD"]).trim()
      const headPin = head.get(path)
      const indexPin = indexed.get(path)
      if (headPin !== undefined && indexPin !== undefined) {
        const indexRecords = diffRecords(nestedRoot, headPin, indexPin, "index", nestedPrefix)
        const checkoutRecords = diffRecords(nestedRoot, indexPin, checkoutPin, "worktree", nestedPrefix)
        // A pointer move can have an unchanged tree; its commit identity is still dirt.
        nestedRecords.push(...indexRecords)
        if (headPin !== indexPin && indexRecords.length === 0) nestedRecords.push(`M  ${nestedPrefix}`)
        nestedRecords.push(...checkoutRecords)
        if (indexPin !== checkoutPin && checkoutRecords.length === 0) nestedRecords.push(` M ${nestedPrefix}`)
      }
      const nested = statusRepository(nestedRoot, nestedPrefix, {
        path: nestedPrefix,
        root: nestedRoot,
        ...(indexPin === undefined ? {} : { from: indexPin }),
        to: checkoutPin,
      })
      nestedRecords.push(...nested.records)
      consultedRepositories.push(...nested.consultedRepositories)
      uninitializedSubmodules.push(...nested.uninitializedSubmodules)
      submoduleProblems.push(...nested.submoduleProblems)
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
      ...new Set([...rootRecords.filter((record) => !checkedOutGitlinks.has(record.slice(3))), ...nestedRecords]),
    ].sort((left, right) => left.slice(3).localeCompare(right.slice(3))),
    consultedRepositories,
    uninitializedSubmodules,
    submoduleProblems,
  }
}

export function superStatus(options: SuperStatusOptions): SuperStatusResult {
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
  return statusRepository(root, "", { path: ".", root, ...(indexFile === undefined ? {} : { indexFile }) }, indexFile)
}
