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
  stat?: boolean
  patch?: boolean
}>

export type DiffFileStat = Readonly<{
  /** Relative to the OWNING repository (`repository` below), not the superproject root. */
  path: string
  /** `null` (never a fake `0`) for a binary file — a real zero-line text change cannot be told apart from "no count available" otherwise. */
  added: number | null
  deleted: number | null
  binary: boolean
}>

export type DiffTotals = Readonly<{
  files: number
  added: number
  deleted: number
}>

/** A gitlink pointer bump inside one repository's OWN diff — excluded from that repository's `files`/`totals` (never counted as product lines) and reported here instead. */
export type PointerMove = Readonly<{
  path: string
  from: string
  to: string
}>

export type RepositoryDiffStat = Readonly<{
  repository: string
  /** The endpoints these `files`/`totals` were MEASURED over, never the expression as typed. A moved-gitlink entry always carries its exact pins. Root carries the pair Git compared: `a..b` and two ref args as given, `a...b` as `{merge-base(a,b), b}`; omitted when root's refs are not a clean two-endpoint pair (`--cached`, a working-tree diff, 3+ ref args) rather than reporting a guess. */
  range?: Readonly<{ from: string; to: string }>
  files: readonly DiffFileStat[]
  totals: DiffTotals
  pointerMoves: readonly PointerMove[]
}>

export type RepositoryDiffPatch = Readonly<{
  repository: string
  range?: Readonly<{ from: string; to: string }>
  /** Verbatim `git diff -p` text, in that repository's OWN paths — not rewritten to superproject-relative. */
  patch: string
}>

export type SuperDiffResult = Readonly<{
  paths: readonly string[]
  deletedPaths: readonly string[]
  consultedRepositories: readonly ConsultedRepository[]
  stats?: readonly RepositoryDiffStat[]
  patches?: readonly RepositoryDiffPatch[]
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

/**
 * The endpoints Git ACTUALLY measured for root's own refs — never the expression as typed.
 *
 * `a..b` and two ref args measure exactly `a` to `b`, so those are reported as given.
 * `a...b` does NOT: Git measures `merge-base(a,b)..b`, so the left endpoint is resolved
 * here with `git merge-base`. Reporting `{a, b}` for a symmetric request claimed every
 * left-only commit as a deletion that no diff in the run had measured.
 *
 * Omitted (never guessed) when the refs are not a clean two-endpoint pair: `--cached`,
 * a working-tree diff, 3+ ref args.
 */
function rootRange(root: string, options: SuperDiffOptions): Readonly<{ from: string; to: string }> | undefined {
  const refs = options.refs ?? []
  if (refs.length === 2) {
    const [from, to] = refs
    if (from !== undefined && to !== undefined) return { from, to }
  }
  const single = refs.length === 1 ? refs[0] : undefined
  if (single === undefined) return undefined
  const symmetric = /^(.+?)\.{3}(.+)$/u.exec(single)
  if (symmetric?.[1] !== undefined && symmetric[2] !== undefined) {
    const [, left, right] = symmetric
    return { from: runGit(root, ["merge-base", left, right]).trim(), to: right }
  }
  const twoDot = /^(.+?)\.{2}(.+)$/u.exec(single)
  if (twoDot?.[1] !== undefined && twoDot[2] !== undefined) return { from: twoDot[1], to: twoDot[2] }
  return undefined
}

function entryRange(
  entry: ConsultedRepository,
  options: SuperDiffOptions,
): Readonly<{ from: string; to: string }> | undefined {
  if (entry.from !== undefined && entry.to !== undefined) return { from: entry.from, to: entry.to }
  return rootRange(entry.root, options)
}

/** Diff args comparing one repository's exact pin move, or (for root) the original options. */
function rangeArgsFor(entry: ConsultedRepository, options: SuperDiffOptions): string[] {
  if (entry.from !== undefined && entry.to !== undefined) {
    return [
      "--no-renames",
      ...(options.diffFilter === undefined ? [] : [`--diff-filter=${options.diffFilter}`]),
      `${entry.from}..${entry.to}`,
    ]
  }
  return commonDiffArgs(options)
}

/** True when no OTHER consulted repository sits between `entryPath` and `candidatePath` in the nesting tree. */
function isDirectChild(entryPath: string, candidatePath: string, all: readonly ConsultedRepository[]): boolean {
  const prefix = entryPath === "." ? "" : `${entryPath}/`
  if (candidatePath === entryPath || !candidatePath.startsWith(prefix)) return false
  return !all.some(
    (other) =>
      other.path !== entryPath &&
      other.path !== candidatePath &&
      other.path.startsWith(prefix) &&
      candidatePath.startsWith(`${other.path}/`),
  )
}

/** This repository's OWN direct gitlink children that moved — excluded from ITS `files`/`totals`, reported separately so gitlink SHA churn is never counted as product lines. */
function pointerMovesFor(entry: ConsultedRepository, all: readonly ConsultedRepository[]): PointerMove[] {
  const prefix = entry.path === "." ? "" : `${entry.path}/`
  return all
    .filter((candidate): candidate is ConsultedRepository & { from: string; to: string } => {
      return (
        candidate.from !== undefined && candidate.to !== undefined && isDirectChild(entry.path, candidate.path, all)
      )
    })
    .map((candidate) => ({ path: candidate.path.slice(prefix.length), from: candidate.from, to: candidate.to }))
}

function parseNumstat(
  raw: string,
): readonly Readonly<{ path: string; added: number | null; deleted: number | null; binary: boolean }>[] {
  return nulFields(raw).map((record) => {
    const match = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/u.exec(record)
    if (!match || match[1] === undefined || match[2] === undefined || match[3] === undefined) {
      throw new Error(`git super: malformed numstat row ${JSON.stringify(record)}`)
    }
    const [, added, deleted, path] = match
    const binary = added === "-" || deleted === "-"
    return { path, added: binary ? null : Number(added), deleted: binary ? null : Number(deleted), binary }
  })
}

function computeRepositoryStat(
  entry: ConsultedRepository,
  options: SuperDiffOptions,
  all: readonly ConsultedRepository[],
): RepositoryDiffStat {
  const pointerMoves = pointerMovesFor(entry, all)
  const excluded = new Set(pointerMoves.map((move) => move.path))
  const raw = runGit(entry.root, ["diff", "--numstat", "-z", ...rangeArgsFor(entry, options)])
  const files = parseNumstat(raw).filter((file) => !excluded.has(file.path))
  const totals = files.reduce<{ files: number; added: number; deleted: number }>(
    (accumulator, file) => ({
      files: accumulator.files + 1,
      added: accumulator.added + (file.added ?? 0),
      deleted: accumulator.deleted + (file.deleted ?? 0),
    }),
    { files: 0, added: 0, deleted: 0 },
  )
  const range = entryRange(entry, options)
  return {
    repository: entry.path,
    ...(range === undefined ? {} : { range }),
    files,
    totals,
    pointerMoves,
  }
}

function computeRepositoryPatch(entry: ConsultedRepository, options: SuperDiffOptions): RepositoryDiffPatch {
  const patch = runGit(entry.root, ["diff", "-p", ...rangeArgsFor(entry, options)])
  const range = entryRange(entry, options)
  return {
    repository: entry.path,
    ...(range === undefined ? {} : { range }),
    patch,
  }
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
  const consultedRepositories = uniqueRepositories([...changed.consultedRepositories, ...deleted.consultedRepositories])

  return {
    paths: [...new Set(changed.entries.map(({ path }) => path))].sort(),
    deletedPaths: [...new Set(deleted.entries.map(({ path }) => path))].sort(),
    consultedRepositories,
    ...(options.stat === true
      ? { stats: consultedRepositories.map((entry) => computeRepositoryStat(entry, options, consultedRepositories)) }
      : {}),
    ...(options.patch === true
      ? { patches: consultedRepositories.map((entry) => computeRepositoryPatch(entry, options)) }
      : {}),
  }
}
