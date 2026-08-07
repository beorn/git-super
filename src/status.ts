import { join, posix } from "node:path"
import { recursiveNameStatusDiff, type ConsultedRepository } from "./diff.ts"
import { repositoryRoot, runGit } from "./git.ts"

export type SuperStatusOptions = Readonly<{ repo: string }>

export type SuperStatusResult = Readonly<{
  records: readonly string[]
  consultedRepositories: readonly ConsultedRepository[]
}>

type Gitlink = Readonly<{ path: string; indexPin: string }>

function nulFields(value: string): string[] {
  return value.split("\0").filter(Boolean)
}

function indexGitlinks(root: string): Gitlink[] {
  const fields = nulFields(runGit(root, ["ls-files", "--stage", "-z"]))
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

function statusRepository(root: string, prefix: string, consulted: ConsultedRepository): SuperStatusResult {
  const gitlinks = indexGitlinks(root)
  const gitlinkPaths = new Set(gitlinks.map(({ path }) => path))
  const rootRecords = parsePorcelain(
    runGit(root, ["-c", "status.renames=false", "status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  )
    .filter((record) => !gitlinkPaths.has(record.slice(3)))
    .map((record) => prefixPorcelain(record, prefix))
  const consultedRepositories: ConsultedRepository[] = [consulted]
  const nestedRecords: string[] = []

  for (const gitlink of gitlinks) {
    const nestedRoot = repositoryRoot(join(root, gitlink.path))
    const nestedPrefix = posix.join(prefix, gitlink.path)
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
  }

  return {
    records: [...new Set([...rootRecords, ...nestedRecords])].sort((left, right) =>
      left.slice(3).localeCompare(right.slice(3)),
    ),
    consultedRepositories,
  }
}

export function superStatus(options: SuperStatusOptions): SuperStatusResult {
  const root = repositoryRoot(options.repo)
  return statusRepository(root, "", { path: ".", root })
}
