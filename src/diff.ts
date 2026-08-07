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

type RawDiffRow = Readonly<{
  path: string
  status: string
  oldMode: string
  newMode: string
  oldPin: string
  newPin: string
}>

function nulFields(value: string): string[] {
  return value.split("\0").filter(Boolean)
}

function parseRawDiff(raw: string): RawDiffRow[] {
  const fields = nulFields(raw)
  const rows: RawDiffRow[] = []
  for (let index = 0; index < fields.length; index += 2) {
    const header = fields[index]
    const path = fields[index + 1]
    if (header === undefined || path === undefined) throw new Error("git super: malformed NUL-delimited raw diff")
    const match = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z][0-9]*)$/u.exec(header)
    if (!match) throw new Error(`git super: malformed raw diff row ${JSON.stringify(header)}`)
    const [, oldMode, newMode, oldPin, newPin, status] = match
    if (
      oldMode === undefined ||
      newMode === undefined ||
      oldPin === undefined ||
      newPin === undefined ||
      status === undefined
    ) {
      throw new Error(`git super: incomplete raw diff row ${JSON.stringify(header)}`)
    }
    rows.push({
      path,
      oldMode,
      newMode,
      oldPin,
      newPin,
      status,
    })
  }
  return rows
}

function commonDiffArgs(options: SuperDiffOptions): string[] {
  return [
    "--no-renames",
    ...(options.cached ? ["--cached"] : []),
    ...(options.diffFilter === undefined ? [] : [`--diff-filter=${options.diffFilter}`]),
    ...(options.refs ?? []),
  ]
}

function prefixPath(root: string, path: string): string {
  return posix.join(root, path)
}

type RecursiveNameStatusOptions = Readonly<{
  repo: string
  prefix: string
  refs?: readonly string[]
  cached?: boolean
  diffFilter?: string
  consulted: ConsultedRepository
}>

export type RecursiveNameStatusResult = Readonly<{
  entries: readonly Readonly<{ path: string; status: string }>[]
  consultedRepositories: readonly ConsultedRepository[]
}>

/** Internal recursive primitive shared by `diff` and `status`. */
export function recursiveNameStatusDiff(options: RecursiveNameStatusOptions): RecursiveNameStatusResult {
  const root = repositoryRoot(options.repo)
  const common = commonDiffArgs(options)
  const unfilteredOptions: SuperDiffOptions = {
    repo: options.repo,
    ...(options.refs === undefined ? {} : { refs: options.refs }),
    ...(options.cached === true ? { cached: true } : {}),
  }
  const filteredRows = parseRawDiff(runGit(root, ["diff", "--raw", "-z", "--abbrev=40", ...common]))
  const boundaryRows =
    options.diffFilter === undefined
      ? filteredRows
      : parseRawDiff(runGit(root, ["diff", "--raw", "-z", "--abbrev=40", ...commonDiffArgs(unfilteredOptions)]))
  const gitlinks = boundaryRows.filter((row) => row.oldMode === "160000" || row.newMode === "160000")
  const entries = filteredRows
    .filter((row) => row.oldMode !== "160000" && row.newMode !== "160000")
    .map((row) => ({ path: prefixPath(options.prefix, row.path), status: row.status }))
  const consultedRepositories: ConsultedRepository[] = [options.consulted]

  for (const move of gitlinks) {
    if (
      move.oldMode !== "160000" ||
      move.newMode !== "160000" ||
      move.oldPin === ZERO_OID ||
      move.newPin === ZERO_OID
    ) {
      throw new Error(
        `git super: ${prefixPath(options.prefix, move.path)} is an added or removed gitlink; ` +
          "no old/new commit range exists for expansion",
      )
    }
    const nestedPrefix = prefixPath(options.prefix, move.path)
    const nestedRoot = repositoryRoot(join(root, move.path))
    const nested = recursiveNameStatusDiff({
      repo: nestedRoot,
      prefix: nestedPrefix,
      refs: [`${move.oldPin}..${move.newPin}`],
      ...(options.diffFilter === undefined ? {} : { diffFilter: options.diffFilter }),
      consulted: {
        path: nestedPrefix,
        root: nestedRoot,
        from: move.oldPin,
        to: move.newPin,
      },
    })
    entries.push(...nested.entries)
    consultedRepositories.push(...nested.consultedRepositories)
  }

  return { entries, consultedRepositories }
}

function uniqueRepositories(repositories: readonly ConsultedRepository[]): ConsultedRepository[] {
  const seen = new Set<string>()
  return repositories.filter((repository) => {
    const key = `${repository.path}\0${repository.root}\0${repository.from ?? ""}\0${repository.to ?? ""}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function superDiff(options: SuperDiffOptions): SuperDiffResult {
  const root = repositoryRoot(options.repo)
  const consulted = { path: ".", root } as const
  const shared = {
    repo: root,
    prefix: "",
    ...(options.refs === undefined ? {} : { refs: options.refs }),
    ...(options.cached === true ? { cached: true } : {}),
  } as const
  const changed = recursiveNameStatusDiff({
    ...shared,
    ...(options.diffFilter === undefined ? {} : { diffFilter: options.diffFilter }),
    consulted,
  })
  const deleted = recursiveNameStatusDiff({
    ...shared,
    diffFilter: "D",
    consulted,
  })

  return {
    paths: [...new Set(changed.entries.map(({ path }) => path))].sort(),
    deletedPaths: [...new Set(deleted.entries.map(({ path }) => path))].sort(),
    consultedRepositories: uniqueRepositories([...changed.consultedRepositories, ...deleted.consultedRepositories]),
  }
}
