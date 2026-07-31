import { join, posix } from "node:path"
import { repositoryRoot, runGit } from "./git.ts"

const ZERO_OID = "0".repeat(40)

export type ConsultedRepository = Readonly<{
  path: string
  root: string
  from?: string
  to?: string
}>

export type SuperDiffOptions = Readonly<{
  repo: string
  refs?: readonly string[]
  cached?: boolean
  diffFilter?: string
}>

export type SuperDiffResult = Readonly<{
  paths: readonly string[]
  deletedPaths: readonly string[]
  consultedRepositories: readonly ConsultedRepository[]
}>

type GitlinkMove = Readonly<{
  path: string
  oldPin: string
  newPin: string
}>

function nulFields(value: string): string[] {
  return value.split("\0").filter(Boolean)
}

function parseGitlinkMoves(raw: string): GitlinkMove[] {
  const fields = nulFields(raw)
  const moves: GitlinkMove[] = []
  for (let index = 0; index < fields.length; index += 2) {
    const header = fields[index]
    const path = fields[index + 1]
    if (header === undefined || path === undefined) throw new Error("git super: malformed NUL-delimited raw diff")
    const match = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z][0-9]*)$/u.exec(header)
    if (!match) throw new Error(`git super: malformed raw diff row ${JSON.stringify(header)}`)
    const oldMode = match[1]!
    const newMode = match[2]!
    const oldPin = match[3]!
    const newPin = match[4]!
    if (oldMode !== "160000" && newMode !== "160000") continue
    if (oldMode !== "160000" || newMode !== "160000" || oldPin === ZERO_OID || newPin === ZERO_OID) {
      throw new Error(`git super: ${path} is an added or removed gitlink; no old/new commit range exists for expansion`)
    }
    moves.push({ path, oldPin, newPin })
  }
  return moves
}

function commonDiffArgs(options: SuperDiffOptions): string[] {
  return [
    "--no-renames",
    ...(options.cached ? ["--cached"] : []),
    ...(options.diffFilter === undefined ? [] : [`--diff-filter=${options.diffFilter}`]),
    ...(options.refs ?? []),
  ]
}

function deletedDiffArgs(options: SuperDiffOptions): string[] {
  return ["--no-renames", ...(options.cached ? ["--cached"] : []), "--diff-filter=D", ...(options.refs ?? [])]
}

function prefixPath(root: string, path: string): string {
  return posix.join(root, path)
}

export function superDiff(options: SuperDiffOptions): SuperDiffResult {
  const root = repositoryRoot(options.repo)
  const common = commonDiffArgs(options)
  const raw = runGit(root, ["diff", "--raw", "-z", "--abbrev=40", ...common])
  const gitlinks = parseGitlinkMoves(raw)
  const gitlinkPaths = new Set(gitlinks.map(({ path }) => path))
  const rootPaths = nulFields(runGit(root, ["diff", "--name-only", "-z", ...common])).filter(
    (path) => !gitlinkPaths.has(path),
  )
  const rootDeletedPaths = nulFields(runGit(root, ["diff", "--name-only", "-z", ...deletedDiffArgs(options)])).filter(
    (path) => !gitlinkPaths.has(path),
  )
  const consultedRepositories: ConsultedRepository[] = [{ path: ".", root }]
  const nestedPaths: string[] = []
  const nestedDeletedPaths: string[] = []

  for (const move of gitlinks) {
    const nestedRoot = repositoryRoot(join(root, move.path))
    const nestedRange = `${move.oldPin}..${move.newPin}`
    const nestedCommon = [
      "--no-renames",
      ...(options.diffFilter === undefined ? [] : [`--diff-filter=${options.diffFilter}`]),
      nestedRange,
    ]
    const paths = nulFields(runGit(nestedRoot, ["diff", "--name-only", "-z", ...nestedCommon]))
    nestedPaths.push(...paths.map((path) => prefixPath(move.path, path)))
    const deleted = nulFields(
      runGit(nestedRoot, ["diff", "--name-only", "-z", "--no-renames", "--diff-filter=D", nestedRange]),
    )
    nestedDeletedPaths.push(...deleted.map((path) => prefixPath(move.path, path)))
    consultedRepositories.push({
      path: move.path,
      root: nestedRoot,
      from: move.oldPin,
      to: move.newPin,
    })
  }

  return {
    paths: [...new Set([...rootPaths, ...nestedPaths])].sort(),
    deletedPaths: [...new Set([...rootDeletedPaths, ...nestedDeletedPaths])].sort(),
    consultedRepositories,
  }
}
