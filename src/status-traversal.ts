import { lstatSync, readFileSync, statSync } from "node:fs"
import { isAbsolute, join, posix, resolve } from "node:path"
import type { ConsultedRepository, NotCompared, SuperDiffOptions, RecursiveNameStatusResult } from "./diff.ts"
import type { SuperStatusOptions, SuperStatusResult } from "./status.ts"
import type { Git } from "./worktree.ts"
import {
  gitError,
  inspectUninitializedCheckout,
  isSubmoduleExcluded,
  probeRepository,
  tryGit,
  validateExcludedSubmodules,
} from "./git.ts"
import { parseIndexEntries } from "./index-entries.ts"
import { joinCommitSubmodules, parseCommitSubmoduleConfig, type CommitSubmodule } from "./commit-graph.ts"
import { pinRef } from "./objects.ts"
import { shellQuote } from "./shell-command.ts"
import { resolveSubmoduleOrigin } from "./submodule-origin.ts"
import { moduleStoreValue } from "./module-store-custody.ts"

const ZERO_OID = "0".repeat(40)
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
type StatusGitRequest = Readonly<{ cwd: string; args: readonly string[]; indexFile?: string; reportOnly?: true }>
type StatusGitResult = Readonly<{ status: number; stdout: string; stderr: string }>
type Traversal<T> = Generator<StatusGitRequest, T, StatusGitResult>

function* queryGit(cwd: string, args: readonly string[], indexFile?: string): Traversal<StatusGitResult> {
  return yield { cwd, args, ...(indexFile === undefined ? {} : { indexFile }) }
}
function* gitText(cwd: string, args: readonly string[], indexFile?: string): Traversal<string> {
  const result = yield* queryGit(cwd, args, indexFile)
  if (result.status !== 0) throw gitError(cwd, args, result.status, result.stderr)
  return result.stdout
}
function* discoverRoot(cwd: string): Traversal<string> {
  return (yield* gitText(cwd, ["rev-parse", "--show-toplevel"])).trim()
}
/** The module repository a gitlink's checkout re-attaches to, when it still exists.
 * `git submodule deinit` leaves the directory empty and `rm -rf` leaves none, but BOTH
 * keep `<git-dir>/modules/<name>` with its local branches, unpushed commits and stashes:
 * that checkout does not hold nothing, and removal would delete the repository with the
 * slot. The name comes from .gitmodules, defaulting to the path itself (git's own default);
 * a .gitmodules that cannot be read is `unreadable`, never "no declarations". */
type ModuleLookup =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "repository"; dir: string }>
  | Readonly<{ kind: "unreadable"; reason: string }>
function* moduleRepository(root: string, path: string): Traversal<ModuleLookup> {
  // NUL-terminated pairs keep a name or path containing spaces intact; `key\nvalue\0`.
  const listing = yield* queryGit(root, [
    "config",
    "-z",
    "-f",
    ".gitmodules",
    "--get-regexp",
    "^submodule\\..*\\.path$",
  ])
  // `git config` exits 1 for a missing file and for no matching key -- both mean "no declarations".
  // Any other status (a malformed file exits 128) leaves them UNREAD, which is never "holds
  // nothing": `git mv` keeps the old name, so a renamed submodule's repository would be missed.
  if (listing.status !== 0 && listing.status !== 1) {
    return {
      kind: "unreadable",
      reason: `git config -f .gitmodules exited ${listing.status}: ${listing.stderr.trim()}`,
    }
  }
  const declarations = listing.stdout.split("\0").flatMap((entry) => {
    const newline = entry.indexOf("\n")
    return newline < 0 ? [] : [{ key: entry.slice(0, newline), value: entry.slice(newline + 1) }]
  })
  const declared = declarations.find((candidate) => candidate.value === path)
  // Undeclared gitlinks still have git's default module name, which is the path itself: check
  // that name rather than assuming no repository exists. Never an unchecked "holds nothing".
  const name = declared === undefined ? path : declared.key.replace(/^submodule\./u, "").replace(/\.path$/u, "")
  const expected = (yield* gitText(root, ["rev-parse", "--git-path", `modules/${name}`])).trim()
  const absolute = isAbsolute(expected) ? expected : resolve(root, expected)
  return lstatSync(absolute, { throwIfNoEntry: false }) === undefined
    ? { kind: "none" }
    : { kind: "repository", dir: absolute }
}
function* readIndexGitlinks(cwd: string, indexFile?: string) {
  return parseIndexEntries(
    yield* gitText(cwd, ["ls-files", "--stage", "-z"], indexFile),
    (field) =>
      new Error("git super: malformed native index entry " + JSON.stringify(field) + "; reread ls-files --stage -z"),
  )
    .filter((entry) => entry.mode === "160000")
    .map((entry) => ({ path: entry.path, indexPin: entry.stage === 0 ? entry.oid : undefined }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

/** Required native transport faults end the traversal; report-only reads reach their owning catch. */
export function driveSync<T>(traversal: Traversal<T>): T {
  let step = traversal.next()
  while (!step.done) {
    const request = step.value
    try {
      const result = tryGit(request.cwd, [...request.args], request.indexFile)
      step = traversal.next({ status: result.exitCode, stdout: result.stdout, stderr: result.stderr })
    } catch (error) {
      if (request.reportOnly) {
        step = traversal.throw(error)
        continue
      }
      // A forced close discards the return value; it is never an observation.
      try {
        traversal.return(undefined as never)
      } finally {
        throw error
      }
    }
  }
  return step.value
}
/** Caller-owned async execution; each request carries its own index and explicit operation bound. */
async function driveAsync<T>(traversal: Traversal<T>, git: Pick<Git, "run">, timeoutMs: number): Promise<T> {
  let step = traversal.next()
  while (!step.done) {
    const request = step.value
    try {
      const result = await git.run(
        request.cwd,
        request.args,
        true,
        timeoutMs,
        request.indexFile === undefined ? undefined : { env: { GIT_INDEX_FILE: request.indexFile } },
      )
      step = traversal.next({ status: result.code, stdout: result.stdout, stderr: result.stderr.trim() })
    } catch (error) {
      if (request.reportOnly) {
        step = traversal.throw(error)
        continue
      }
      try {
        traversal.return(undefined as never)
      } finally {
        throw error
      }
    }
  }
  return step.value
}
export function statusWithGit(
  options: SuperStatusOptions,
  git: Pick<Git, "run">,
  timeoutMs: number,
): Promise<SuperStatusResult> {
  return driveAsync(statusTraversal(options), git, timeoutMs)
}

function nulFields(value: string): string[] {
  return value.split("\0").filter(Boolean)
}

type RawDiffRow = Readonly<{
  path: string
  status: string
  oldMode: string
  newMode: string
  oldPin: string
  newPin: string
}>

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

export function commonDiffArgs(options: SuperDiffOptions): string[] {
  return [
    "--no-renames",
    options.excludedSubmodules?.length ? "--ignore-submodules=dirty" : "--ignore-submodules=none",
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

function* recordedGitlink(
  root: string,
  ref: string,
  path: string,
  purpose: "--component-base" | "comparison target" = "--component-base",
): Traversal<string | undefined> {
  const result: StatusGitResult = yield {
    cwd: root,
    args: ["ls-tree", "-z", ref, "--", path],
    ...(purpose === "comparison target" ? { reportOnly: true } : {}),
  }
  if (result.status !== 0) {
    throw new Error(
      `git super: ${purpose} ${ref} does not resolve in ${root}: ${result.stderr.trim() || `git ls-tree exited ${result.status}`}`,
    )
  }
  const row = result.stdout.split("\0").find((line) => line.length > 0)
  if (row === undefined) return undefined
  const [meta] = row.split("\t")
  const [mode, type, oid] = (meta ?? "").split(" ")
  return mode === "160000" && type === "commit" && oid !== undefined ? oid : undefined
}

function expandableGitlink(row: RawDiffRow, path: string): RawDiffRow {
  const gitlinkBefore = row.oldMode === "160000"
  const gitlinkAfter = row.newMode === "160000"
  const absentBefore = row.oldMode === "000000"
  if (gitlinkBefore && gitlinkAfter && row.oldPin !== ZERO_OID && row.newPin !== ZERO_OID) return row
  if (absentBefore && gitlinkAfter) {
    if (row.newPin === ZERO_OID) {
      throw new Error(
        `git super: ${path} is an added gitlink whose new pin git reports as zero; no commit exists to expand`,
      )
    }
    return { ...row, oldMode: "160000", oldPin: EMPTY_TREE }
  }
  if (gitlinkBefore && (row.newMode === "000000" || row.newPin === ZERO_OID)) {
    throw new Error(`git super: ${path} is a removed gitlink; no new commit exists to expand its deleted files from`)
  }
  if (gitlinkBefore) {
    throw new Error(`git super: ${path} changed from a gitlink to a file; no commit range exists for expansion`)
  }
  throw new Error(`git super: ${path} changed from a file to a gitlink; no old commit exists to expand from`)
}

function* initializedCheckout(root: string, move: RawDiffRow, path: string, added: boolean): Traversal<string> {
  const directory = join(root, move.path)
  const discovered = yield* queryGit(directory, ["rev-parse", "--show-toplevel"])
  const prefix = discovered.status === 0 ? yield* queryGit(directory, ["rev-parse", "--show-prefix"]) : undefined
  const probe =
    discovered.status === 0 && prefix?.status === 0
      ? probeRepository(discovered.stdout.trim(), prefix.stdout)
      : undefined
  if (probe === undefined || probe.kind === "absent") {
    throw new Error(
      `git super: ${path} is ${added ? "an added" : "a moved"} gitlink at ${move.newPin}; its checkout is not initialized`,
    )
  }
  return probe.root
}

function* comparisonSubmodules(root: string, options: SuperDiffOptions): Traversal<Map<string, CommitSubmodule>> {
  const selected = (yield* rangeTraversal(root, options))?.to ?? options.refs?.[0] ?? "HEAD"
  const frozen = (yield* gitText(root, ["rev-parse", `${selected}^{tree}`])).trim()
  const tree = parseRawDiff(
    yield* gitText(root, [
      "diff",
      "--raw",
      "-z",
      "--abbrev=40",
      "--no-renames",
      "--ignore-submodules=dirty",
      EMPTY_TREE,
      frozen,
    ]),
  )
  const gitlinks = new Map(tree.filter(({ newMode }) => newMode === "160000").map(({ path, newPin }) => [path, newPin]))
  if (gitlinks.size === 0) return new Map()
  const configured = yield* gitText(root, [
    "config",
    "--null",
    "--blob",
    `${frozen}:.gitmodules`,
    "--get-regexp",
    "^submodule\\..*\\.(path|url|branch)$",
  ])
  return new Map(
    joinCommitSubmodules(gitlinks, parseCommitSubmoduleConfig(configured, frozen), frozen).map((entry) => [
      entry.path,
      entry,
    ]),
  )
}

export function* diffTraversal(options: RecursiveNameStatusOptions): Traversal<RecursiveNameStatusResult> {
  const root = yield* discoverRoot(options.repo)
  const common = commonDiffArgs(options)
  const unfilteredOptions: SuperDiffOptions = {
    repo: options.repo,
    ...(options.excludedSubmodules === undefined ? {} : { excludedSubmodules: options.excludedSubmodules }),
    ...(options.refs === undefined ? {} : { refs: options.refs }),
    ...(options.cached === true ? { cached: true } : {}),
  }
  const filteredRows = parseRawDiff(yield* gitText(root, ["diff", "--raw", "-z", "--abbrev=40", ...common]))
  const boundaryRows =
    options.diffFilter === undefined
      ? filteredRows
      : parseRawDiff(yield* gitText(root, ["diff", "--raw", "-z", "--abbrev=40", ...commonDiffArgs(unfilteredOptions)]))
  const gitlinks = boundaryRows.filter((row) => row.oldMode === "160000" || row.newMode === "160000")
  const entries = filteredRows
    .filter((row) => row.oldMode !== "160000" && row.newMode !== "160000")
    .map((row) => ({ path: prefixPath(options.prefix, row.path), status: row.status }))
  const consultedRepositories: ConsultedRepository[] = [options.consulted]
  const notCompared: NotCompared[] = []
  const descriptors =
    options.excludedSubmodules?.length || gitlinks.some(({ newMode }) => newMode === "160000")
      ? yield* comparisonSubmodules(root, options)
      : new Map<string, CommitSubmodule>()
  if (options.excludedSubmodules?.length) {
    const working = !options.cached && (options.refs?.length ?? 0) <= 1 && !options.refs?.[0]?.includes("..")
    const candidates = working
      ? yield* readIndexGitlinks(root)
      : [...descriptors.values()].map(({ path, target }) => ({ path, indexPin: target }))
    for (const { path, indexPin } of candidates) {
      if (!working && !isSubmoduleExcluded(prefixPath(options.prefix, path), options.excludedSubmodules)) continue
      if (gitlinks.some((row) => row.path === path)) continue
      if (indexPin === undefined) {
        notCompared.push({
          path: prefixPath(options.prefix, path),
          reason: "unreadable",
          message: "unmerged gitlink has no resolved index pin",
        })
        continue
      }
      gitlinks.push({ path, oldMode: "160000", newMode: "160000", oldPin: indexPin, newPin: indexPin, status: "M" })
    }
  }

  for (const gitlink of gitlinks) {
    if (isSubmoduleExcluded(prefixPath(options.prefix, gitlink.path), options.excludedSubmodules)) {
      notCompared.push({
        path: prefixPath(options.prefix, gitlink.path),
        reason: "excluded",
        message: "component excluded, not compared",
      })
      continue
    }
    if (gitlink.oldMode === "160000" && gitlink.newMode === "000000") {
      notCompared.push({
        path: prefixPath(options.prefix, gitlink.path),
        reason: "removed",
        message: "component removed, not compared",
      })
      continue
    }
    const move = expandableGitlink(gitlink, prefixPath(options.prefix, gitlink.path))
    const isDirtySubmodule = move.oldPin === move.newPin
    const nestedPrefix = prefixPath(options.prefix, move.path)
    const nestedRoot = yield* initializedCheckout(root, move, nestedPrefix, gitlink.oldPin === ZERO_OID)
    let targetComparison: ConsultedRepository["targetComparison"]
    let nestedTarget: RecursiveNameStatusOptions["targetContext"]
    const target = options.targetContext
    if (target !== undefined) {
      const identity = { target: target.target, commit: target.commit }
      if ("error" in target) {
        targetComparison = { ...identity, kind: "unavailable", error: target.error }
        nestedTarget = target
      } else {
        try {
          const recordedTarget = yield* recordedGitlink(root, target.ref, move.path, "comparison target")
          if (recordedTarget !== undefined) {
            nestedTarget = { ...identity, ref: recordedTarget }
            if (move.newPin === recordedTarget) targetComparison = { ...identity, kind: "at-target" }
          }
        } catch (error) {
          const cause = error instanceof Error ? error.message : String(error)
          targetComparison = { ...identity, kind: "unavailable", error: cause }
          nestedTarget = { ...identity, error: cause }
        }
      }
    }
    // 29363: a composed base replaces the range's old endpoint with the pin the base ref records for this
    // component; a working-tree comparison (old == new) has no range to rebase.
    const recorded =
      options.componentBase === undefined || isDirtySubmodule
        ? undefined
        : yield* recordedGitlink(root, options.componentBase, gitlink.path)
    const unreadable: { pin: string; result: StatusGitResult }[] = []
    for (const pin of new Set([move.oldPin, move.newPin, ...(recorded === undefined ? [] : [recorded])])) {
      if (pin === EMPTY_TREE || pin === ZERO_OID) continue
      const result = yield* queryGit(nestedRoot, ["cat-file", "-e", `${pin}^{commit}`])
      if (result.status !== 0) unreadable.push({ pin, result })
    }
    if (unreadable.length > 0) {
      const descriptor = descriptors.get(move.path)
      const declaredUrl = descriptor?.url
      const relativeUrl = declaredUrl?.startsWith("./") || declaredUrl?.startsWith("../")
      const parentOrigin = relativeUrl ? yield* queryGit(root, ["remote", "get-url", "origin"]) : undefined
      const url =
        declaredUrl === undefined || (relativeUrl && parentOrigin?.status !== 0)
          ? undefined
          : resolveSubmoduleOrigin(root, parentOrigin?.stdout.trim(), declaredUrl)
      const remedy =
        url === undefined
          ? declaredUrl === undefined
            ? `Frozen .gitmodules in ${root} has no remote URL for ${move.path}; restore that descriptor before fetching.`
            : `Cannot resolve frozen relative URL ${declaredUrl} for ${move.path}: git remote get-url origin in ${root} failed (${parentOrigin?.stderr}); restore that parent origin before fetching.`
          : unreadable
              .map(({ pin }) =>
                [
                  "git",
                  "-C",
                  nestedRoot,
                  "fetch",
                  "--no-tags",
                  "--no-recurse-submodules",
                  "--no-write-fetch-head",
                  url,
                  `${pin}:${pinRef(pin)}`,
                ]
                  .map(shellQuote)
                  .join(" "),
              )
              .join("\n")
      notCompared.push({
        path: nestedPrefix,
        reason: "unreadable",
        objectIds: unreadable.map(({ pin }) => pin),
        ...(url === undefined ? {} : { remote: url }),
        message: `cannot read component objects in ${nestedRoot}: ${unreadable.map(({ pin, result }) => `${pin} (${result.stderr || `git cat-file exited ${result.status}`})`).join("; ")}`,
        remedy,
      })
      continue
    }
    const from =
      recorded === undefined ? move.oldPin : yield* composedFrom(nestedRoot, nestedPrefix, recorded, move.newPin)
    const nested = yield* diffTraversal({
      repo: nestedRoot,
      ...(options.excludedSubmodules === undefined ? {} : { excludedSubmodules: options.excludedSubmodules }),
      prefix: nestedPrefix,
      ...(nestedTarget === undefined ? {} : { targetContext: nestedTarget }),
      ...(recorded === undefined ? {} : { componentBase: recorded }),
      ...(isDirtySubmodule
        ? {
            refs: [move.oldPin],
            ...(options.diffFilter === undefined ? {} : { diffFilter: options.diffFilter }),
            consulted: {
              path: nestedPrefix,
              root: nestedRoot,
              ...(targetComparison === undefined ? {} : { targetComparison }),
              from: move.oldPin,
            },
          }
        : {
            refs: [`${from}..${move.newPin}`],
            ...(options.diffFilter === undefined ? {} : { diffFilter: options.diffFilter }),
            consulted: {
              path: nestedPrefix,
              root: nestedRoot,
              ...(targetComparison === undefined ? {} : { targetComparison }),
              from,
              to: move.newPin,
            },
          }),
    })
    entries.push(...nested.entries)
    consultedRepositories.push(...nested.consultedRepositories)
    notCompared.push(...nested.notCompared)
  }

  return { entries, consultedRepositories, notCompared }
}

function* composedFrom(nestedRoot: string, path: string, recorded: string, newPin: string): Traversal<string> {
  const result = yield* queryGit(nestedRoot, ["merge-base", recorded, newPin])
  if (result.status !== 0) {
    throw new Error(
      `git super: ${path} is pinned at ${newPin}, which shares no history with the pin ${recorded} the composed base records; nothing can be measured between them (${result.stderr.trim() || `git merge-base exited ${result.status}`})`,
    )
  }
  return result.stdout.trim()
}

function rangeRefs(options: SuperDiffOptions): Readonly<{ from: string; to: string; symmetric: boolean }> | undefined {
  const refs = options.refs ?? []
  if (refs.length === 2) {
    const [from, to] = refs
    if (from !== undefined && to !== undefined) return { from, to, symmetric: false }
  }
  const single = refs.length === 1 ? refs[0] : undefined
  if (single === undefined) return undefined
  const symmetric = /^(.+?)\.{3}(.+)$/u.exec(single)
  if (symmetric?.[1] !== undefined && symmetric[2] !== undefined) {
    const [, left, right] = symmetric
    return { from: left, to: right, symmetric: true }
  }
  const twoDot = /^(.+?)\.{2}(.+)$/u.exec(single)
  if (twoDot?.[1] !== undefined && twoDot[2] !== undefined) {
    return { from: twoDot[1], to: twoDot[2], symmetric: false }
  }
  return undefined
}

export function* rangeTraversal(
  root: string,
  options: SuperDiffOptions,
): Traversal<Readonly<{ from: string; to: string }> | undefined> {
  const selected = rangeRefs(options)
  if (selected === undefined) return undefined
  return {
    from: selected.symmetric
      ? (yield* gitText(root, ["merge-base", selected.from, selected.to])).trim()
      : selected.from,
    to: selected.to,
  }
}

/** Resolve the target once; child comparisons carry the pin its parent tree records. */
export function* targetTraversal(
  root: string,
  options: SuperDiffOptions,
): Traversal<RecursiveNameStatusOptions["targetContext"]> {
  if (options.cached === true) return undefined
  const selected = rangeRefs(options)
  if (selected?.symmetric !== true) return undefined
  const commit = (yield* gitText(root, ["rev-parse", "--verify", selected.from + "^{commit}"])).trim()
  return { target: selected.from, commit, ref: commit }
}

function* headGitlinks(root: string): Traversal<Map<string, string>> {
  const head = yield* queryGit(root, ["rev-parse", "--verify", "--quiet", "HEAD"])
  // An unborn repository has no HEAD tree; its indexed additions still remain explicit dirt.
  if (head.status === 1 && head.stderr === "") return new Map()
  if (head.status !== 0) {
    throw gitError(root, ["rev-parse", "--verify", "--quiet", "HEAD"], head.status, head.stderr)
  }
  const result = new Map<string, string>()
  for (const field of nulFields(yield* gitText(root, ["ls-tree", "-r", "-z", "HEAD"]))) {
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

function* diffRecords(
  root: string,
  from: string,
  to: string,
  column: "index" | "worktree",
  prefix: string,
  excludedSubmodules: readonly string[],
): Traversal<Readonly<{ records: string[]; notCompared: readonly NotCompared[] }>> {
  if (from === to) return { records: [], notCompared: [] }
  let result: RecursiveNameStatusResult
  try {
    result = yield* diffTraversal({
      repo: root,
      prefix,
      refs: [`${from}..${to}`],
      consulted: { path: prefix, root, from, to },
      excludedSubmodules,
    })
  } catch (error) {
    // Comparison failed, but the selected checkout can still be consulted.
    // Preserve the exact query and failure as uncertainty, never clean status.
    return {
      records: [],
      notCompared: [
        {
          path: prefix,
          reason: "unreadable",
          message: `cannot compare ${from}..${to} in ${root}: ${error instanceof Error ? error.message : String(error)}`,
          remedy: "hydrate the selected pins and repeat the comparison",
        },
      ],
    }
  }
  return {
    notCompared: result.notCompared,
    records: result.entries.map(({ status, path }) => {
      const code = status[0] ?? "M"
      return `${column === "index" ? code : " "}${column === "worktree" ? code : " "} ${path}`
    }),
  }
}

function* statusRepository(
  root: string,
  prefix: string,
  consulted: ConsultedRepository,
  indexFile?: string,
  excludedSubmodules: readonly string[] = [],
): Traversal<SuperStatusResult> {
  const gitlinks = yield* readIndexGitlinks(root, indexFile)
  const indexed = new Map(gitlinks.map(({ path, indexPin }) => [path, indexPin]))
  const head = yield* headGitlinks(root)
  const paths = [...new Set([...head.keys(), ...indexed.keys()])].sort((left, right) => left.localeCompare(right))
  const checkedOutGitlinks = new Set<string>()
  const rootRecords = parsePorcelain(
    yield* gitText(
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
    yield* gitText(
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
        kind: "diff-unreadable",
        path: nestedPrefix,
        reason: `unmerged gitlink ${child} has no resolved index pin; resolve its conflict before removal`,
      })
    }
    try {
      const childState = lstatSync(child, { throwIfNoEntry: false })
      // A checkout with no files holds nothing -- unless its module repository survives,
      // because removal would delete that repository (with its local branches, unpushed
      // commits and stashes) along with the slot. Recorded as a problem, naming either the
      // re-attach command that reuses the existing repository instead of cloning, or the
      // .gitmodules that could not be read (30563).
      const classifyHoldingNothing = function* (): Traversal<void> {
        const module = yield* moduleRepository(root, path)
        if (module.kind === "repository") {
          // A surviving repository protects bytes, not existence (30580): when every commit it holds is
          // held by its remote's default branch or archive refs, read from that remote now, the empty
          // checkout really does hold nothing. One predicate decides this here and in removal's `modules/`
          // inventory. A store or remote that cannot be read is still a problem, never "holds nothing".
          let value: ReturnType<typeof moduleStoreValue>
          try {
            value = moduleStoreValue(module.dir)
          } catch (error) {
            submoduleProblems.push({
              kind: "repository-not-consulted",
              path: nestedPrefix,
              reason: `${child} holds no files, but its repository exists at ${module.dir} and what it holds is unknown: ${error instanceof Error ? error.message : String(error)}; re-attach it: git -C ${root} submodule update --init ${path}`,
              gitDir: module.dir,
            })
            return
          }
          if (value.valueCommits === 0) {
            uninitializedSubmodules.push(nestedPrefix)
            return
          }
          submoduleProblems.push({
            kind: "repository-not-consulted",
            path: nestedPrefix,
            reason:
              `${child} holds no files, but its repository exists at ${module.dir} and holds ${String(value.valueCommits)} commit(s) that neither its remote's default branch nor any archive ref there holds` +
              `${value.remote === undefined ? " (it has no remote)" : ` (remote ${value.remote}${value.defaultBranch === undefined ? "" : ` ${value.defaultBranch}`})`}` +
              `${value.head === undefined ? "" : `, HEAD ${value.head}`}` +
              `; re-attach it: git -C ${root} submodule update --init ${path}`,
            gitDir: module.dir,
          })
          return
        }
        if (module.kind === "unreadable") {
          submoduleProblems.push({
            kind: "repository-not-consulted",
            path: nestedPrefix,
            reason: `${child} holds no files, but ${root}/.gitmodules could not be read, so whether its module repository survives is unknown: ${module.reason}; repair .gitmodules before removal`,
          })
          return
        }
        uninitializedSubmodules.push(nestedPrefix)
      }
      if (childState === undefined) {
        yield* classifyHoldingNothing()
        continue
      }
      symbolicCheckout = childState.isSymbolicLink()
      const metadata = join(child, ".git")
      const metadataState = lstatSync(metadata, { throwIfNoEntry: false })
      if (metadataState?.isFile()) {
        const pointer = /^gitdir: (.+)\r?\n?$/u.exec(readFileSync(metadata, "utf8").trim())?.[1]
        if (pointer !== undefined) gitDir = resolve(child, pointer)
      }
      const nestedRoot = yield* discoverRoot(child)
      const probe = probeRepository(nestedRoot, yield* gitText(child, ["rev-parse", "--show-prefix"]))
      if (childState.isSymbolicLink()) {
        submoduleProblems.push({
          kind: "repository-not-consulted",
          path: nestedPrefix,
          reason: `checkout ${child} is a symbolic link; preserve its target before removal`,
        })
        continue
      }
      if (probe.kind === "absent") {
        if (inspectUninitializedCheckout(child) !== "empty") {
          throw new Error(
            `uninitialized directory ${child} is not empty and has no repository of its own; move its files out of it, then run: ` +
              `git -C ${root} submodule update --init ${path}`,
          )
        }
        yield* classifyHoldingNothing()
        continue
      }
      const checkoutPin = (yield* gitText(nestedRoot, ["rev-parse", "HEAD"])).trim()
      const headPin = head.get(path)
      const indexPin = indexed.get(path)
      if (headPin !== undefined && indexPin !== undefined) {
        const indexDiff = yield* diffRecords(nestedRoot, headPin, indexPin, "index", nestedPrefix, excludedSubmodules)
        const indexRecords = indexDiff.records
        for (const observation of indexDiff.notCompared) {
          notCompared.push(observation)
          if (observation.reason === "unreadable") {
            submoduleProblems.push({
              kind: "diff-unreadable",
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
        if (indexPin !== checkoutPin) nestedRecords.push(` M ${nestedPrefix}`)
      }
      const nested = yield* statusRepository(
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
        kind: "repository-not-consulted",
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

export function* statusTraversal(options: SuperStatusOptions): Traversal<SuperStatusResult> {
  validateExcludedSubmodules(options.excludedSubmodules)
  const root = yield* discoverRoot(options.repo)
  const indexFile = options.indexFile
  if (indexFile !== undefined) {
    if (!isAbsolute(indexFile)) throw new Error(`git super status: --index-file must be absolute: ${indexFile}`)
    try {
      if (!statSync(indexFile).isFile()) throw new Error("not a file")
    } catch (error) {
      throw new Error(`git super status: --index-file is not a readable file: ${indexFile}`, { cause: error })
    }
  }
  return yield* statusRepository(
    root,
    "",
    { path: ".", root, ...(indexFile === undefined ? {} : { indexFile }) },
    indexFile,
    options.excludedSubmodules,
  )
}
