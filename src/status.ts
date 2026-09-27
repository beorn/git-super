import { readdirSync, statSync } from "node:fs"
import { isAbsolute, join, posix } from "node:path"
import { recursiveNameStatusDiff, type ConsultedRepository } from "./diff.ts"
import { probeRepository, repositoryRoot, runGit } from "./git.ts"

export type SuperStatusOptions = Readonly<{ repo: string; indexFile?: string }>

export type SuperStatusResult = Readonly<{
  records: readonly string[]
  consultedRepositories: readonly ConsultedRepository[]
  /** Existing empty gitlink directories with no repository of their own; these are not dirty records. */
  uninitializedSubmodules: readonly string[]
}>

type Gitlink = Readonly<{ path: string; indexPin: string }>

function nulFields(value: string): string[] {
  return value.split("\0").filter(Boolean)
}

function indexGitlinks(root: string, indexFile?: string): Gitlink[] {
  const fields = nulFields(runGit(root, ["ls-files", "--stage", "-z"], indexFile))
  return fields
    .map((field) => {
      const match = /^160000 ([0-9a-f]{40}) 0\t(.+)$/u.exec(field)
      const indexPin = match?.[1]
      const path = match?.[2]
      return indexPin === undefined || path === undefined ? undefined : { indexPin, path }
    })
    .filter((value): value is Gitlink => value !== undefined)
    .sort((left, right) => left.path.localeCompare(right.path))
}

function treeGitlink(root: string, ref: string, path: string): string | undefined {
  const value = runGit(root, ["ls-tree", "-z", ref, "--", path])
  const match = /^160000 commit ([0-9a-f]{40})\t/u.exec(value)
  return match?.[1]
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
  const checkedOutGitlinks = new Set<string>()
  const rootRecords = parsePorcelain(
    runGit(root, ["-c", "status.renames=false", "status", "--porcelain=v1", "-z", "--untracked-files=all"], indexFile),
  ).map((record) => prefixPorcelain(record, prefix))
  const consultedRepositories: ConsultedRepository[] = [consulted]
  const nestedRecords: string[] = []
  const uninitializedSubmodules: string[] = []

  for (const gitlink of gitlinks) {
    const child = join(root, gitlink.path)
    const nestedRoot = repositoryRoot(child)
    const nestedPrefix = posix.join(prefix, gitlink.path)
    const probe = probeRepository(nestedRoot, runGit(child, ["rev-parse", "--show-prefix"]))
    if (probe.kind === "absent") {
      if (readdirSync(child).length > 0) {
        throw new Error(
          `git super: ${nestedPrefix} is not checked out and its directory ${child} is not empty; preserve its files before removal`,
        )
      }
      uninitializedSubmodules.push(nestedPrefix)
      continue
    }
    checkedOutGitlinks.add(nestedPrefix)
    const checkoutPin = runGit(nestedRoot, ["rev-parse", "HEAD"]).trim()
    const headPin = treeGitlink(root, "HEAD", gitlink.path)
    if (headPin === undefined) {
      throw new Error(`git super: ${nestedPrefix} is an added gitlink; status cannot infer an old commit range`)
    }
    nestedRecords.push(...diffRecords(nestedRoot, headPin, gitlink.indexPin, "index", nestedPrefix))
    nestedRecords.push(...diffRecords(nestedRoot, gitlink.indexPin, checkoutPin, "worktree", nestedPrefix))
    const nested = statusRepository(nestedRoot, nestedPrefix, {
      path: nestedPrefix,
      root: nestedRoot,
      from: gitlink.indexPin,
      to: checkoutPin,
    })
    nestedRecords.push(...nested.records)
    consultedRepositories.push(...nested.consultedRepositories)
    uninitializedSubmodules.push(...nested.uninitializedSubmodules)
  }

  return {
    records: [
      ...new Set([...rootRecords.filter((record) => !checkedOutGitlinks.has(record.slice(3))), ...nestedRecords]),
    ].sort((left, right) => left.slice(3).localeCompare(right.slice(3))),
    consultedRepositories,
    uninitializedSubmodules,
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
