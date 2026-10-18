import { driveSync, diffTraversal, rangeTraversal, targetTraversal, commonDiffArgs } from "./status-traversal.ts"
import { repositoryRoot, runGit, validateExcludedSubmodules } from "./git.ts"

export type ConsultedRepository = Readonly<{
  path: string
  root: string
  /** Explicit root index consulted by status when a hook uses a temporary commit index. */
  indexFile?: string
  /**
   * The old endpoint. A commit for a moved gitlink, or git's empty tree for one this range ADDED, which is measured
   * from nothing to its pin; a consumer running log or merge-base on it must check it is a commit first.
   */
  from?: string
  to?: string
  /** Equality with an explicit three-dot target's recorded pin; no claim about who made the change. */
  targetComparison?: Readonly<
    { target: string; commit: string } & ({ kind: "at-target" } | { kind: "unavailable"; error: string })
  >
}>

export type SuperDiffOptions = Readonly<{
  repo: string
  excludedSubmodules?: readonly string[]
  refs?: readonly string[]
  cached?: boolean
  diffFilter?: string
  stat?: boolean
  patch?: boolean
  /**
   * The composed base (29363): a root ref — `origin/main` for the scoped fix — whose recorded gitlinks are the
   * component mains a landing will carry. A moved gitlink it records is measured from `merge-base(recorded, new)`
   * to `new`, so the published component commits that composition pulls under a branch contribute nothing, an
   * authored-only pin measures exactly the authored commits, and a pin behind the published main measures nothing.
   * A gitlink the ref does not record keeps the range's own old endpoint (git's empty tree for an added one). The
   * recursion carries each component's recorded pin down, so a nested gitlink resolves against the published
   * parent tree. A ref that does not resolve, or a pin that shares no history with the recorded one, refuses.
   */
  componentBase?: string
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
  /** A commit, or git's empty tree for a gitlink this range added (see ConsultedRepository.from). */
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
  untrackedOnly?: boolean
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
  notCompared: readonly NotCompared[]
  stats?: readonly RepositoryDiffStat[]
  patches?: readonly RepositoryDiffPatch[]
}>

/** An explicit omission from a comparison, never evidence that a component is clean. */
export type NotCompared = Readonly<{
  path: string
  reason: "absent" | "removed" | "excluded" | "unreadable" | "inconsistent"
  message: string
  objectIds?: readonly string[]
  remedy?: string
  exclusion?: Readonly<{
    classification: "declared" | "absent" | "unclassified"
    parents: readonly (import("./commit-graph.ts").SelectedCommitPath &
      Readonly<{ repository: string; head: string }>)[]
    checkout: "absent" | "empty" | "checkout" | "content" | "symlink" | "unsafe-ancestor"
  }>
}>

function nulFields(value: string): string[] {
  return value.split("\0").filter(Boolean)
}

type RecursiveNameStatusOptions = Readonly<{
  repo: string
  excludedSubmodules?: readonly string[]
  prefix: string
  refs?: readonly string[]
  cached?: boolean
  diffFilter?: string
  consulted: ConsultedRepository
  /** See {@link SuperDiffOptions.componentBase}; at a nested level it is the parent component's recorded pin. */
  componentBase?: string
  targetContext?: Readonly<{ target: string; commit: string } & ({ ref: string } | { error: string })>
}>

/**
 * The gitlink `ref` records at `path` in `root`, or undefined when the ref carries no gitlink there (an added
 * component, or a path that is a file in that tree). A ref that does not resolve is an error, never "no pin": the
 * caller named it as the composed base, and measuring from the range's old endpoint instead would be the quiet
 * over-selection 29363 removes.
 */

export type RecursiveNameStatusResult = Readonly<{
  entries: readonly Readonly<{ path: string; status: string }>[]
  consultedRepositories: readonly ConsultedRepository[]
  notCompared: readonly NotCompared[]
}>

/**
 * The commit range one gitlink row expands over, or a refusal naming its case. An added gitlink is a move from git's
 * empty tree to its pin, so every file in it reads as added, as git's own --submodule=diff renders it (26972).
 */

/** The submodule's own repository root, refusing an uninitialized checkout instead of resolving to the parent. */

/** Parent-only frozen descriptors, using the existing raw-diff parser and graph-owned config join. */

/** Internal recursive primitive shared by `diff` and `status`. */
export function recursiveNameStatusDiff(options: RecursiveNameStatusOptions): RecursiveNameStatusResult {
  return driveSync(diffTraversal(options))
}

/**
 * The old endpoint a composed base gives a moved gitlink: the merge base of the pin the base ref records and the
 * branch's new pin, inside the component. A new pin ahead of the recorded one measures only the commits past it;
 * one behind or equal to it measures nothing. No common history is a refusal — the branch pin is not a descendant
 * of anything the published main carries, and a guess in either direction would be silent.
 */

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
  return driveSync(rangeTraversal(root, options))
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
      ...(options.excludedSubmodules?.length ? ["--ignore-submodules=dirty"] : []),
      ...(options.diffFilter === undefined ? [] : [`--diff-filter=${options.diffFilter}`]),
      `${entry.from}..${entry.to}`,
    ]
  }
  if (entry.from !== undefined) {
    return [
      "--no-renames",
      ...(options.excludedSubmodules?.length ? ["--ignore-submodules=dirty"] : []),
      ...(options.diffFilter === undefined ? [] : [`--diff-filter=${options.diffFilter}`]),
      entry.from,
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
        candidate.from !== undefined &&
        candidate.to !== undefined &&
        candidate.from !== candidate.to &&
        isDirectChild(entry.path, candidate.path, all)
      )
    })
    .map((candidate) => ({ path: candidate.path.slice(prefix.length), from: candidate.from, to: candidate.to }))
}

function directChildSubmodules(entry: ConsultedRepository, all: readonly ConsultedRepository[]): string[] {
  const prefix = entry.path === "." ? "" : `${entry.path}/`
  return all
    .filter((candidate) => isDirectChild(entry.path, candidate.path, all))
    .map((candidate) => candidate.path.slice(prefix.length))
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
  notCompared: readonly NotCompared[],
): RepositoryDiffStat {
  const pointerMoves = pointerMovesFor(entry, all)
  const excluded = new Set([...pointerMoves.map((move) => move.path), ...directChildSubmodules(entry, all)])
  const prefix = entry.path === "." ? "" : `${entry.path}/`
  for (const observation of notCompared) {
    if (observation.path.startsWith(prefix)) excluded.add(observation.path.slice(prefix.length))
  }
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
  const isWorkingTreeDiff = entry.from !== undefined && entry.to === undefined
  const untrackedOnly =
    isWorkingTreeDiff &&
    files.length === 0 &&
    pointerMoves.length === 0 &&
    runGit(entry.root, ["ls-files", "--others", "--exclude-standard"]).trim().length > 0
  return {
    repository: entry.path,
    ...(range === undefined ? {} : { range }),
    files,
    totals,
    pointerMoves,
    ...(untrackedOnly ? { untrackedOnly: true } : {}),
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

/**
 * A composed base is defined for a committed two-endpoint range and nothing else: a working-tree or index comparison
 * has no old endpoint to rebase onto the recorded pin, and a single ref is a tree, not a range. Refusing names the
 * accepted forms, so the caller cannot read a silently unrebased comparison as the composed one (@cto, 29363).
 */
function validateComponentBaseForm(root: string, options: SuperDiffOptions): void {
  if (options.componentBase === undefined) return
  const refs = options.refs ?? []
  const form =
    options.cached === true
      ? "an index comparison (--cached)"
      : refs.length === 0
        ? "a working-tree comparison"
        : refs.length > 2
          ? `${refs.length} refs`
          : rootRange(root, options) === undefined
            ? `a single ref (${refs[0]})`
            : undefined
  if (form === undefined) return
  throw new Error(
    `git super: --component-base ${options.componentBase} is defined for a committed two-endpoint range (A..B, A...B or two refs), not for ${form}; it measures each moved gitlink from the pin the ref records, and only a range has an old endpoint to replace`,
  )
}

export function superDiff(options: SuperDiffOptions): SuperDiffResult {
  validateExcludedSubmodules(options.excludedSubmodules)
  const root = repositoryRoot(options.repo)
  validateComponentBaseForm(root, options)
  const consulted = { path: ".", root } as const
  const targetContext = driveSync(targetTraversal(root, options))
  const shared = {
    repo: root,
    ...(options.excludedSubmodules === undefined ? {} : { excludedSubmodules: options.excludedSubmodules }),
    prefix: "",
    ...(options.refs === undefined ? {} : { refs: options.refs }),
    ...(options.cached === true ? { cached: true } : {}),
    ...(options.componentBase === undefined ? {} : { componentBase: options.componentBase }),
  } as const
  const changed = recursiveNameStatusDiff({
    ...shared,
    ...(targetContext === undefined ? {} : { targetContext }),
    ...(options.diffFilter === undefined ? {} : { diffFilter: options.diffFilter }),
    consulted,
  })
  const deleted = recursiveNameStatusDiff({
    ...shared,
    diffFilter: "D",
    consulted,
  })
  const consultedRepositories = uniqueRepositories([...changed.consultedRepositories, ...deleted.consultedRepositories])
  const notCompared = [
    ...new Map(
      [...changed.notCompared, ...deleted.notCompared].map((observation) => [
        `${observation.path}\0${observation.reason}`,
        observation,
      ]),
    ).values(),
  ]

  return {
    paths: [...new Set(changed.entries.map(({ path }) => path))].sort(),
    deletedPaths: [...new Set(deleted.entries.map(({ path }) => path))].sort(),
    consultedRepositories,
    notCompared,
    ...(options.stat === true
      ? {
          stats: consultedRepositories.map((entry) =>
            computeRepositoryStat(entry, options, consultedRepositories, notCompared),
          ),
        }
      : {}),
    ...(options.patch === true
      ? { patches: consultedRepositories.map((entry) => computeRepositoryPatch(entry, options)) }
      : {}),
  }
}
