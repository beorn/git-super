/**
 * Gate 4 of the #27443(b) retirement proof: the candidate's own Git contents, per component.
 *
 * `Effective(g)` is Git's complete loose+packed+alternate OID set from
 * `cat-file --batch-all-objects --batch-check` (it FOLLOWS alternates, so it is not the owned
 * set). `IndependentStores(g,R)` is the union of the effective sets of external alternate and
 * objects-link targets that are present, independently owned and disjoint from `R`.
 * `AtRisk(g) = Effective(g) \ IndependentStores(g,R)`. `Roots(g)` is every ref, reflog old/new,
 * pseudo-ref and index OID, except gitlink entries whose commits belong to the child component.
 *
 * `retention` mode reports `AtRisk(g)`'s commits: what removing `E` destroys. `complete-commit` mode
 * reports what removing `E` destroys OR un-references, so it adds every borrowed commit reachable from
 * `Roots(g)` — a commit a lender also holds still becomes prunable once the reference naming it is gone
 * — and leaves lender debris, which this removal neither destroys nor un-references, out (@cto ruling
 * 2026-10-29, #31738).
 *
 * Every large set is streamed: the two object sets are compared by a k-way merge over the sorted
 * `cat-file` streams (already OID-sorted) and the roots, and the result lands in content-addressed
 * sidecars rather than in a Set/Map/array. Peak memory is the sort run buffer plus one line per
 * source, so a 4,000,000-OID component no longer costs hundreds of MB of heap. Read-only: it runs
 * git queries and reads files; it never writes, prunes or gc's. A malformed row, an unreadable
 * index, a failed git command, an unwritable sidecar or a cap hit is `unknown`; a root OID the
 * component's own store no longer carries is a violated condition.
 */
import { spawnSync } from "node:child_process"
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs"
import { isAbsolute, join, relative, sep } from "node:path"
import { alternateEntries } from "./alternates.ts"
import type { ManifestEntry } from "./worktree-removal.ts"
import {
  assertStreamComplete,
  DEFAULT_SORT_RUN_LINES,
  MAX_LINE_LENGTH,
  externalSortToSidecar,
  gitLineStream,
  mergeSorted,
  oidKey,
  readLines,
  SidecarWriter,
  type GitLineStream,
  type GitStreamOptions,
  type SidecarRef,
} from "./retention-stream.ts"

export interface GitRunResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
  /** True when the runner killed the child at `GitRunOptions.timeoutMs`, not on the child's own exit. */
  readonly timedOut?: boolean
  /**
   * 37792 (@cto 2026-11-22 9573ed64): set by a caller whose factory clamped this child's timeout to a SHARED proof
   * deadline instead of the command's own bound. A kill classified here is a scheduling result, never a store
   * refusing to be read, so a later entry must not inherit it.
   */
  readonly sharedDeadlineCut?: boolean
}

export interface GitRunOptions {
  /** Hard per-child deadline. A child that outlives it is killed and reported `timedOut`. */
  readonly timeoutMs?: number
  readonly executable?: string
  readonly env?: NodeJS.ProcessEnv
  readonly signal?: AbortSignal
  readonly killSignal?: NodeJS.Signals
}

export type GitRun = (args: readonly string[], options?: GitRunOptions) => GitRunResult | Promise<GitRunResult>

/** Streams a git child's stdout as bounded lines; the seam tests use to fake a large or broken output. */
export type GitStreamFactory = (args: readonly string[], options?: GitStreamOptions) => GitLineStream

/** The production line stream: a real child, killed at its byte/line cap or deadline. */
export const defaultGitStream: GitStreamFactory = (args, options = {}) =>
  gitLineStream(args, {
    ...options,
    ...(options.env === undefined
      ? {}
      : {
          env: {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_TERMINAL_PROMPT: "0",
            GIT_OPTIONAL_LOCKS: "0",
            ...options.env,
          },
        }),
  })

export interface ContentsBounds {
  /** 4,000,000 effective OIDs per candidate component in the contract's initial pass. */
  readonly maxEffectiveOids: number
  /** 120 s per candidate component in the contract's initial pass. */
  readonly componentMs: number
}

export const DEFAULT_CONTENTS_BOUNDS: ContentsBounds = { maxEffectiveOids: 4_000_000, componentMs: 120_000 }

export interface ComponentContents {
  /** The component git directory, relative to the retained copy root. */
  readonly component: string
  /** Actual component Git directory when supplied by a live census adapter. */
  readonly gitDir?: string
  readonly effective: number
  readonly independent: number
  /** Gate 5 input: at-risk objects in retention mode, or every effective commit in complete mode. */
  readonly atRisk: number
  /**
   * The sorted at-risk sidecar: one `<oid>\t<objectType>\t<source>` line per at-risk OID. Its
   * own sha256 is the certificate's `atRiskDigest`.
   */
  readonly atRiskSidecar: SidecarRef
  /** Root OIDs (refs, reflogs, pseudo-refs, index) that are NOT in the store's effective set. */
  readonly missingRoots: number
  /** The first 100 missing root OIDs, for the inline refusal; the full list is the sidecar. */
  readonly missingRootsSample: readonly string[]
  readonly missingRootsSidecar?: SidecarRef | undefined
  readonly elapsedMs: number
}

export interface ContentsScan {
  readonly status: "pass" | "blocked" | "unknown"
  readonly detail: string
  readonly components: readonly ComponentContents[]
}

/**
 * 37854 (@cto turn46-ref-observations): one row of a complete `for-each-ref` enumeration - the ref, the object it
 * names, and that object's type. Contents and the head census root the SAME ref list; their own consumers apply their
 * own validation and namespace rules to these raw rows.
 */
export interface RefObservationRow {
  readonly ref: string
  readonly oid: string
  /**
   * Undefined when the ref's object is gone: `%(objecttype)` is FATAL for the whole listing in that case (measured:
   * exit 128, "missing object <oid> for refs/<...>"), so the rows then come from the safe listing and a consumer that
   * needs the type reads again and refuses exactly as it always did.
   */
  readonly type?: string
}

/** Complete raw ref enumerations, keyed by retained copy and worktree Git directory, scoped to ONE verification pass. */
export type RefObservations = Map<string, readonly RefObservationRow[]>

/** The typed listing both gates want; fatal for a store holding a ref whose object is gone. */
const TYPED_REF_FORMAT = "%(refname)%09%(objectname)%09%(objecttype)"
/** The listing that survives a ref whose object is gone, and so is all the contents gate may rely on. */
const SAFE_REF_FORMAT = "%(refname)%09%(objectname)"

/** The key that keeps two copies bearing the same component name from sharing one enumeration. */
export function refObservationKey(copyRoot: string, gitDir: string): string {
  return `${copyRoot}\u0000${gitDir}`
}

/**
 * 37854 (@cto turn46-ref-observations): read a component's refs ONCE for both gates of one pass. Only a complete,
 * successful listing is stored: a partial, timed-out or failed read is never reused, and because the scope belongs to
 * one pass (a held pass builds its own), a ref that moved is read again there.
 */
export async function observeRefs(
  run: GitRun,
  gitDir: string,
  options: Readonly<{
    readonly observations?: RefObservations
    readonly key: string
    readonly runOptions?: GitRunOptions
    readonly label?: string
    /** Git context prepended to the read (`--git-dir`/`--work-tree`); absent when the runner is already bound. */
    readonly context?: readonly string[]
    /** A consumer that cannot work without the object type: it re-reads strictly rather than accept untyped rows. */
    readonly requireTypes?: boolean
  }>,
): Promise<readonly RefObservationRow[]> {
  const seen = options.observations?.get(options.key)
  const label = options.label ?? `for-each-ref in ${gitDir}`
  const context = options.context ?? []
  const read = async (format: string): Promise<GitRunResult> =>
    run([...context, "for-each-ref", "refs/", `--format=${format}`], options.runOptions ?? {})
  const parse = (text: string, withType: boolean): RefObservationRow[] => {
    const rows: RefObservationRow[] = []
    for (const line of text.split("\n")) {
      if (line === "") continue
      const [ref, oid, type] = line.split("\t")
      if (ref === undefined || oid === undefined || (withType && type === undefined)) {
        throw new UnknownError(`${label}: malformed ref row ${JSON.stringify(line.slice(0, 120))}`)
      }
      rows.push(withType ? { ref, oid, type: type as string } : { ref, oid })
    }
    return rows
  }
  const typed = async (): Promise<readonly RefObservationRow[]> => {
    const result = await read(TYPED_REF_FORMAT)
    refuseSuccessfulStderr(result, label)
    if (result.timedOut === true) throw new UnknownError(`${label}: the listing was cut at its deadline`)
    if (result.code !== 0) {
      throw new UnknownError(`${label} failed: ${result.stderr.trim() || `exit ${String(result.code)}`}`)
    }
    return parse(result.stdout, true)
  }
  if (seen !== undefined) {
    const untyped = options.requireTypes === true && seen.some((row) => row.type === undefined)
    return untyped ? await typed() : seen
  }
  let rows: readonly RefObservationRow[]
  try {
    rows = await typed()
  } catch (error) {
    if (options.requireTypes === true) throw error
    // A ref whose object is gone turns the typed listing fatal for the whole store. The safe listing still names every
    // ref, which is all the contents gate needs; it never invents a type for a consumer that would need one.
    const safe = await read(SAFE_REF_FORMAT)
    refuseSuccessfulStderr(safe, label)
    if (safe.timedOut === true) throw new UnknownError(`${label}: the listing was cut at its deadline`)
    if (safe.code !== 0) {
      throw new UnknownError(`${label} failed: ${safe.stderr.trim() || `exit ${String(safe.code)}`}`)
    }
    rows = parse(safe.stdout, false)
  }
  options.observations?.set(options.key, rows)
  return rows
}

export interface ContentsScanOptions {
  /** Directory for the content-addressed sidecars; must be outside `E` and `R`. */
  readonly sidecarDir: string
  readonly run?: GitRun
  readonly stream?: GitStreamFactory
  /**
   * `complete-commit` keeps every commit this removal destroys OR un-references: the owned commits of
   * `AtRisk(g)` (independent-store subtraction, dangling included) plus every borrowed commit reachable
   * from `Roots(g)`, whose reference the removal would take away (#31738, @cto ruling 2026-10-29).
   */
  readonly sourceMode?: "retention" | "complete-commit"
  /** Explicit source Git identities from the live recursive census; otherwise use the manifest adapter. */
  readonly sources?: readonly ComponentGitSource[]
  /** Shared absolute proof deadline in the same clock domain as `clock`; exhaustion is unknown. */
  readonly deadline?: number
  readonly bounds?: ContentsBounds
  readonly clock?: () => number
  /**
   * 37854 (@cto turn46): complete raw ref enumerations shared with the head census inside one verification pass, so
   * one copy's refs are listed once instead of once per gate.
   */
  readonly refObservations?: RefObservations
}

export interface ComponentGitSource {
  readonly component: string
  readonly gitDir: string
  readonly workTree: string
}

// FETCH_HEAD is not a root (#31771, @cto aacb2ac9): like a remote-tracking ref it records what origin
// advertised, not this environment's own knowledge, so a commit only it names is not at risk here.
const PSEUDO_REFS = ["ORIG_HEAD", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REBASE_HEAD", "BISECT_HEAD", "BISECT_LOG"]
const REMOTE_TRACKING_REFS = "refs/remotes/"
const HEX40 = /^[0-9a-f]{40}$/u
const ZERO_OID = /^0+$/u
const MISSING_INLINE = 100

/** A proof step that could not complete; `scanContents` reports it as `unknown`, never a crash. */
class UnknownError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UnknownError"
  }
}

function within(parent: string, path: string): boolean {
  const part = relative(parent, path)
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part))
}

export function defaultGitRun(args: readonly string[], options: GitRunOptions = {}): GitRunResult {
  // spawnSync requires a non-negative integer and treats 0 as "no timeout"; clamp to >=1 ms so a
  // zero or fractional bound still kills a hung child instead of throwing or disarming the guard.
  const timeoutMs = options.timeoutMs === undefined ? undefined : Math.max(1, Math.ceil(options.timeoutMs))
  const result = spawnSync(options.executable ?? "git", [...args], {
    encoding: "utf8",
    maxBuffer: 1 << 30,
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
    // SIGKILL, not the default SIGTERM: a child that traps or ignores SIGTERM would otherwise run
    // to natural completion and the "hard" deadline would not be hard.
    killSignal: options.killSignal ?? "SIGKILL",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      ...options.env,
    },
  })
  // spawnSync reports a timeout kill as ETIMEDOUT on `error`, with `status` null. Reporting it as a
  // named signal keeps a hung child from being confused with a genuine non-zero exit; a timeout is
  // never a success, so `code` is forced nonzero even if the killed child happened to exit 0.
  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT"
  return {
    code: timedOut ? 1 : (result.status ?? 1),
    stdout: result.stdout ?? "",
    stderr: timedOut ? `git ${args[0] ?? ""} timed out after ${timeoutMs} ms` : (result.stderr ?? ""),
    ...(timedOut ? { timedOut: true } : {}),
  }
}

/**
 * A read-only proof query that exits 0 while writing to stderr has NOT read cleanly: Git reports an
 * unusable alternate, an ignored object store or a broken ref on stderr without a non-zero exit, and
 * the stdout that follows is shorter than the store. Any successful `run` carrying stderr output is
 * `unknown`, never a clean source. Non-zero results keep their own named error at the call site.
 */
export function refuseSuccessfulStderr(result: GitRunResult, label: string): void {
  if (result.code === 0 && result.stderr.trim() !== "") {
    throw new UnknownError(`${label} exited 0 with unexpected stderr: ${result.stderr.trim()}`)
  }
}

/** Every nested component git directory the full manifest records, not a fixed list of names. */
export function componentsFromManifest(entries: Readonly<Record<string, ManifestEntry>>): string[] {
  const names = new Set<string>()
  for (const key of Object.keys(entries)) {
    const parts = key.split("/")
    const at = parts.indexOf("objects")
    if (at === -1) continue
    names.add(parts.slice(0, at).join("/"))
  }
  return [...names].sort()
}

/** Strict transitive alternates closure of one object dir: every link present, no cycle back into R. */
function closure(
  objects: string,
  removal: readonly string[],
  seen: Set<string>,
): { status: "ok"; stores: string[] } | { status: "unknown"; detail: string } {
  const stores: string[] = []
  const stack = [objects]
  while (stack.length > 0) {
    const store = stack.pop()
    if (store === undefined) break
    if (seen.has(store)) continue
    seen.add(store)
    stores.push(store)
    const file = join(store, "info", "alternates")
    if (!existsSync(file)) continue
    let content: string
    try {
      content = readFileSync(file, "utf8")
    } catch (error) {
      return {
        status: "unknown",
        detail: `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    for (const target of alternateEntries(content, store)) {
      if (!existsSync(target) || !statSync(target).isDirectory()) {
        return { status: "unknown", detail: `${file} names a missing alternate ${target}` }
      }
      if (removal.some((root) => within(root, target))) {
        return { status: "unknown", detail: `alternate ${target} resolves inside the removal set` }
      }
      stack.push(target)
    }
  }
  return { status: "ok", stores }
}

export type ReflogEntry = Readonly<{ oldOid: string; newOid: string; message: string }>

function parseReflogEntry(path: string, line: string): ReflogEntry {
  const [oldOid, newOid] = line.split(" ")
  // The ident may contain a TAB. Only the committer timezone delimits the message.
  const metadata = line.match(/^[^ ]+ [^ ]+ .*?> -?\d+ [+-]\d{4}(?:\t(.*))?$/u)
  if (oldOid === undefined || newOid === undefined || !HEX40.test(oldOid) || !HEX40.test(newOid) || metadata === null) {
    throw new UnknownError(`malformed reflog record in ${path}: ${line.slice(0, 120)}`)
  }
  // Git omits the TAB when the creation record has no message.
  return { oldOid, newOid, message: metadata[1] ?? "" }
}

/** Read Git's raw reflog records once; retention and author provenance share this decoder. */
export function* readReflogEntries(path: string): Generator<ReflogEntry> {
  let content: string
  try {
    content = readFileSync(path, "utf8")
  } catch (error) {
    throw new UnknownError(`cannot read reflog ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  for (const line of content.split("\n")) {
    if (line === "") continue
    yield parseReflogEntry(path, line)
  }
}

/**
 * Yields one `<oid>\t<source>` line per root OID the component records: refs, HEAD, reflog
 * old/new, pseudo-refs and the index. Remote-tracking refs (`refs/remotes/**`), their reflogs
 * (`logs/refs/remotes/**`) and FETCH_HEAD are not roots: they mirror origin's knowledge, so a borrowed
 * commit only they name is not this environment's to keep, while an owned commit stays at risk
 * whatever the roots (#31771, @cto aacb2ac9). Zero OIDs are excluded (the creation record of a reflog and
 * a symbolic HEAD both name them, and neither is an object the store must carry). Unreadable or
 * malformed root state throws; `scanContents` reports that as `unknown`.
 */
async function* rootOidLines(
  gitDir: string,
  run: GitRun,
  options: {
    readonly completeMode: boolean
    readonly deadline: number | undefined
    readonly clock: () => number
    readonly maxEffectiveOids: number
    /** 37854 (@cto turn46): the pass's shared enumerations and this copy's key; absent means read directly. */
    readonly observations?: RefObservations
    readonly refKey: string
    /**
     * Read the gitdir as a detached store: a retained copy still records `core.worktree` for the checkout
     * its removal deleted, and plain `--git-dir` dies on chdir to that missing path ("cannot chdir"), so
     * gate 4 refused stores it could read (#34920, @cto 34920-ranking-and-bare-r2 §2). `--work-tree=<gitDir>`
     * selects the command context only: it rewrites no config and keeps the `core.worktree` evidence. Not
     * `--bare`: git 2.53 (the host's /usr/bin/git) still chdirs to the recorded worktree under `--bare` and dies,
     * while 2.56 does not, so `--bare` made gate 4 depend on which git a PATH resolves. The same context as gate 5's
     * atStore and retention-compact's runAtGitDir.
     */
    readonly detached: boolean
  },
): AsyncGenerator<string> {
  const at = options.detached ? [`--git-dir=${gitDir}`, `--work-tree=${gitDir}`] : [`--git-dir=${gitDir}`]
  const refs = await observeRefs(run, gitDir, {
    ...(options.observations === undefined ? {} : { observations: options.observations }),
    key: options.refKey,
    context: at,
  })
  for (const { ref: name, oid } of refs) {
    if (!HEX40.test(oid)) {
      throw new UnknownError(`malformed for-each-ref row in ${gitDir}: ${name} ${oid.slice(0, 120)}`)
    }
    if (name.startsWith(REMOTE_TRACKING_REFS)) continue
    if (!ZERO_OID.test(oid)) yield `${oid}\tref ${name}`.trimEnd()
  }
  const head = await run([...at, "rev-parse", "HEAD"])
  refuseSuccessfulStderr(head, `rev-parse HEAD in ${gitDir}`)
  if (head.code === 0) {
    const oid = head.stdout.trim()
    if (HEX40.test(oid) && !ZERO_OID.test(oid)) yield `${oid}\tHEAD`
  } else if (!/unknown revision|Needed a single revision|ambiguous argument/u.test(head.stderr)) {
    throw new UnknownError(`rev-parse HEAD failed in ${gitDir}: ${head.stderr.trim()}`)
  }
  const logs = join(gitDir, "logs")
  if (existsSync(logs)) {
    let reflogLines = 0
    for (const path of reflogFiles(logs)) {
      if (relative(logs, path).split(sep).join("/").startsWith(REMOTE_TRACKING_REFS)) continue
      const entries: Iterable<ReflogEntry> | AsyncIterable<ReflogEntry> = options.completeMode
        ? (async function* () {
            for await (const line of readLines(path, {
              ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
              clock: options.clock,
              maxLineLength: MAX_LINE_LENGTH,
              maxLines: Math.max(0, options.maxEffectiveOids - reflogLines),
            })) {
              reflogLines += 1
              yield parseReflogEntry(path, line)
            }
          })()
        : readReflogEntries(path)
      for await (const { oldOid: old, newOid: next } of entries) {
        const source = `reflog ${relative(gitDir, path)}`
        if (!ZERO_OID.test(old)) yield `${old}\t${source}`
        if (!ZERO_OID.test(next)) yield `${next}\t${source}`
      }
    }
  }
  for (const name of PSEUDO_REFS) {
    const path = join(gitDir, name)
    if (!existsSync(path) || !statSync(path).isFile()) continue
    const content = readFileSync(path, "utf8")
    const found = (content.match(/[0-9a-f]{40}/gu) ?? []).filter((oid) => HEX40.test(oid))
    if (found.length === 0 && content.trim() !== "") {
      throw new UnknownError(`pseudo-ref ${path} holds no object id`)
    }
    for (const oid of found) yield `${oid}\tpseudo-ref ${name}`
  }
  const index = await run([...at, "ls-files", "--stage"])
  refuseSuccessfulStderr(index, `ls-files --stage in ${gitDir}`)
  if (index.code === 0) {
    for (const line of index.stdout.split("\n")) {
      if (line === "") continue
      const match = line.match(/^(\d{6}) ([0-9a-f]{40}) ([0-3])\t(.+)$/u)
      if (match === null) throw new UnknownError(`malformed ls-files --stage row in ${gitDir}: ${line.slice(0, 120)}`)
      const [, mode, oid] = match
      // A mode-160000 index entry is a submodule commit ID stored by that child repository.
      // It is not an object the superproject's own object database must carry.
      if (mode !== "160000" && oid !== undefined && !ZERO_OID.test(oid)) yield `${oid}\tindex`
    }
  } else if (/index file smaller|bad index|unknown index|fatal: index/u.test(index.stderr)) {
    throw new UnknownError(`unreadable index in ${gitDir}: ${index.stderr.trim()}`)
  }
}

function reflogFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) reflogFiles(path, found)
    else if (entry.isFile()) found.push(path)
  }
  return found
}

/** Validates a `cat-file --batch-all-objects --batch-check` stream, yielding `<oid>\t<type>` lines. */
async function* validatedOidLines(stream: GitLineStream, label: string): AsyncGenerator<string> {
  for await (const line of stream.lines) {
    const [oid, type, size] = line.split(" ")
    if (oid === undefined || type === undefined || size === undefined || !HEX40.test(oid)) {
      throw new UnknownError(`${label}: malformed cat-file row: ${line.slice(0, 120)}`)
    }
    if (type !== "commit" && type !== "tree" && type !== "blob" && type !== "tag") {
      throw new UnknownError(`${label}: cat-file reported unsupported object type '${type}' for ${oid}`)
    }
    if (!/^\d+$/u.test(size)) {
      throw new UnknownError(`${label}: cat-file reported malformed object size '${size}' for ${oid}`)
    }
    yield `${oid}\t${type}`
  }
}

async function scanComponentGitDir(
  source: ComponentGitSource,
  removal: readonly string[],
  run: GitRun,
  stream: GitStreamFactory,
  bounds: ContentsBounds,
  clock: () => number,
  sidecarDir: string,
  sourceMode: "retention" | "complete-commit",
  deadline: number | undefined,
  exposeGitDir: boolean,
  observations: RefObservations | undefined,
  refKey: string,
): Promise<ComponentContents> {
  const { component, gitDir, workTree } = source
  const started = clock()
  const remaining = (): number => {
    const left = Math.min(started + bounds.componentMs, deadline ?? Number.POSITIVE_INFINITY) - clock()
    if (left <= 0) throw new UnknownError(`${component}: the component bound or shared proof deadline is exhausted`)
    return left
  }
  // Every synchronous root query carries the component's REMAINING budget, so a stalled
  // for-each-ref/rev-parse/ls-files yields `unknown` at the bound instead of blocking the scan
  // (the streamed object lists are bounded the same way, below).
  const proofEnv =
    sourceMode === "complete-commit" ? { GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" } : undefined
  const componentRun: GitRun = async (args, runOptions = {}) =>
    run(sourceMode === "complete-commit" ? ["--no-replace-objects", ...args] : args, {
      ...runOptions,
      timeoutMs: Math.min(runOptions.timeoutMs ?? Number.POSITIVE_INFINITY, remaining()),
      ...(proofEnv === undefined ? {} : { env: { ...runOptions.env, ...proofEnv } }),
    })
  const rootsRef = await externalSortToSidecar(
    rootOidLines(gitDir, componentRun, {
      completeMode: sourceMode === "complete-commit",
      deadline,
      clock,
      maxEffectiveOids: bounds.maxEffectiveOids,
      ...(observations === undefined ? {} : { observations }),
      refKey,
      // Retention mode reads retained copies, whose checkout is gone; complete-commit mode reads live
      // environment stores during removal and keeps its context unchanged.
      detached: sourceMode === "retention",
    }),
    {
      dir: sidecarDir,
      runLines: DEFAULT_SORT_RUN_LINES,
      deadline,
      clock,
    },
  )
  const objects = join(gitDir, "objects")
  // The alternate closure decides which objects this removal would DESTROY, in both modes: complete-commit
  // mode inventories a copy that may borrow, and a borrower's removal loses none of the lender's objects
  // (#31738, @cto ruling 2026-10-29 — the at-risk set is what the removal destroys or un-references).
  const closureResult = closure(objects, removal, new Set())
  if (closureResult.status !== "ok") throw new UnknownError(`${component}: ${closureResult.detail}`)
  // IndependentStores(g,R) also includes an actual external `objects`-symlink target: its store
  // survives E and those objects are borrowed, never owned (contract gate 4). Dropping the
  // component's own initial store while keeping the link target is the whole correction.
  const independentStores = new Set<string>()
  for (const store of closureResult.stores) {
    if (store === objects) continue
    independentStores.add(store)
  }
  const linkMetadata = lstatSync(objects, { throwIfNoEntry: false })
  if (linkMetadata?.isSymbolicLink() === true) {
    let linkTarget: string
    try {
      linkTarget = realpathSync(objects)
      if (!statSync(linkTarget).isDirectory()) throw new Error("target is not a directory")
    } catch (error) {
      throw new UnknownError(
        `${component}: objects link ${objects} is dangling or not a directory: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (removal.some((root) => within(root, linkTarget))) {
      throw new UnknownError(`${component}: objects link target ${linkTarget} resolves inside the removal set`)
    }
    independentStores.add(linkTarget)
  }
  const effectiveStream = stream(
    [
      ...(sourceMode === "complete-commit" ? ["--no-replace-objects"] : []),
      `--git-dir=${gitDir}`,
      `--work-tree=${workTree}`,
      "cat-file",
      "--batch-all-objects",
      "--batch-check",
    ],
    {
      timeoutMs: Math.min(bounds.componentMs, remaining()),
      maxLines: bounds.maxEffectiveOids,
      ...(proofEnv === undefined ? {} : { env: proofEnv }),
    },
  )
  const independentStreams = [...independentStores].sort().map((store) =>
    stream(
      [
        ...(sourceMode === "complete-commit" ? ["--no-replace-objects"] : []),
        `--git-dir=${join(store, "..")}`,
        `--work-tree=${workTree}`,
        "cat-file",
        "--batch-all-objects",
        "--batch-check",
      ],
      {
        timeoutMs: Math.min(bounds.componentMs, remaining()),
        maxLines: bounds.maxEffectiveOids,
        ...(proofEnv === undefined ? {} : { env: proofEnv }),
      },
    ),
  )
  // Complete-commit mode also keeps borrowed commits THIS environment references: a commit reachable
  // from its refs, HEAD, reflog old/new or a commit-typed pseudo-ref is un-referenced by the removal and
  // becomes prunable, so it stays at risk even when a lender holds the object. Index stage roots are blobs
  // and stay in the missing-root check only (@cto ruling 2026-10-29, #31738).
  //
  // The walk reads the sorted root sidecar one line at a time and writes it to `rev-list`'s stdin, so the
  // root list is never materialized. `--missing=print` keeps a store that has lost an object from aborting
  // the walk: what it cannot resolve comes back as `?<oid>` (measured, git 2.56) and is left out of the
  // reachable set. A lost ROOT is the root-integrity refusal below; a lost ancestor is `unknown`, because
  // this component's own closure is incomplete and its at-risk set cannot be trusted.
  const walkMissing: string[] = []
  let walkMissingCount = 0
  const rootReachable =
    sourceMode !== "complete-commit"
      ? undefined
      : await externalSortToSidecar(
          (async function* () {
            const roots = (async function* (): AsyncGenerator<string> {
              for await (const line of readLines(rootsRef.path)) {
                const [oid, source] = line.split("\t")
                if (oid === undefined || source === "index") continue
                yield `${oid}\n`
              }
            })()
            const reachable = stream(
              ["--no-replace-objects", `--git-dir=${gitDir}`, "rev-list", "--stdin", "--missing=print"],
              {
                timeoutMs: Math.min(bounds.componentMs, remaining()),
                maxLines: bounds.maxEffectiveOids,
                stdin: roots,
                ...(proofEnv === undefined ? {} : { env: proofEnv }),
              },
            )
            for await (const line of reachable.lines) {
              if (line === "") continue
              if (line.startsWith("?")) {
                walkMissingCount += 1
                if (walkMissing.length < MISSING_INLINE) walkMissing.push(line.slice(1))
                continue
              }
              yield line
            }
            const outcome = await reachable.outcome
            const cause = [outcome.stdinError, outcome.stderr.trim()].filter(
              (part): part is string => part !== undefined && part !== "",
            )
            assertStreamComplete(outcome, {
              timedOut: `${component}: rev-list of component roots exceeded the ${bounds.componentMs} ms bound`,
              capped: `${component}: rev-list of component roots exceeded the ${bounds.maxEffectiveOids} cap`,
              failed: `${component}: rev-list of component roots failed: ${cause.join("; ")}`,
              warned: `${component}: rev-list of component roots exited 0 with stderr: ${outcome.stderr.trim()}`,
            })
          })(),
          { dir: sidecarDir, runLines: DEFAULT_SORT_RUN_LINES, deadline, clock },
        )
  const atRiskWriter = new SidecarWriter(sidecarDir, "txt")
  const missingWriter = new SidecarWriter(sidecarDir, "txt")
  let effective = 0
  let independent = 0
  let atRisk = 0
  let missing = 0
  let merged = 0
  const missingRootsSample: string[] = []
  try {
    await mergeSorted(
      [
        { label: "effective", lines: validatedOidLines(effectiveStream, component), keyOf: oidKey },
        ...independentStreams.map((source, index) => ({
          label: `independent:${index}`,
          lines: validatedOidLines(source, `independent store ${index} of ${component}`),
          keyOf: oidKey,
        })),
        ...(rootReachable === undefined
          ? []
          : [{ label: "root-reachable", lines: readLines(rootReachable.path), keyOf: oidKey }]),
        { label: "roots", lines: readLines(rootsRef.path), keyOf: oidKey },
      ],
      (key, groups) => {
        if ((merged++ & 1023) === 0) remaining()
        const effectiveLines = groups.filter((group) => group.label === "effective").flatMap((group) => group.lines)
        const independentLines = groups
          .filter((group) => group.label.startsWith("independent:"))
          .flatMap((group) => group.lines)
        const rootLines = groups.filter((group) => group.label === "roots").flatMap((group) => group.lines)
        if (effectiveLines.length > 0) effective += 1
        if (independentLines.length > 0) independent += 1
        const rootSources = [...new Set(rootLines.map((line) => line.slice(line.indexOf("\t") + 1)))].join(", ")
        const rootReachableLines = groups
          .filter((group) => group.label === "root-reachable")
          .flatMap((group) => group.lines)
        const first = effectiveLines[0]
        if (
          first !== undefined &&
          (sourceMode === "complete-commit"
            ? first.endsWith("\tcommit") && (independentLines.length === 0 || rootReachableLines.length > 0)
            : independentLines.length === 0)
        ) {
          const type = first.slice(first.indexOf("\t") + 1)
          atRisk += 1
          atRiskWriter.add(`${key}\t${type}\t${rootSources === "" ? "owned" : rootSources}`)
        }
        if (rootLines.length > 0 && effectiveLines.length === 0) {
          missing += 1
          if (missingRootsSample.length < MISSING_INLINE) missingRootsSample.push(key)
          missingWriter.add(`${key}\t${rootSources}`)
        }
      },
      { deadline, clock },
    )
    for (const source of [effectiveStream, ...independentStreams]) {
      const outcome = await source.outcome
      assertStreamComplete(outcome, {
        timedOut: `${component}: a git child exceeded the ${bounds.componentMs} ms component bound`,
        capped: `${component}: object list exceeded the ${bounds.maxEffectiveOids} cap`,
        failed: `${component}: cat-file failed: ${outcome.stderr.trim()}`,
        warned: `${component}: cat-file exited 0 with stderr: ${outcome.stderr.trim()}`,
      })
    }
    // Every root resolved and the component's own store still lost an ancestor: `blocked` would name the
    // wrong thing, and a partial closure must never be read as a complete at-risk set.
    if (missing === 0 && walkMissingCount > 0) {
      throw new UnknownError(
        `${component}: rev-list cannot resolve ${walkMissingCount} object(s) reachable from component roots, e.g. ${walkMissing[0] ?? "none sampled"}`,
      )
    }
  } catch (error) {
    atRiskWriter.abort()
    missingWriter.abort()
    throw error
  }
  const atRiskSidecar = await atRiskWriter.finish()
  let missingRootsSidecar: SidecarRef | undefined
  if (missing > 0) missingRootsSidecar = await missingWriter.finish()
  else missingWriter.abort()
  const elapsedMs = clock() - started
  if (elapsedMs > bounds.componentMs || (deadline !== undefined && clock() > deadline)) {
    throw new UnknownError(`${component} exceeded the ${bounds.componentMs} ms component bound after ${effective} OIDs`)
  }
  return {
    component,
    ...(exposeGitDir ? { gitDir } : {}),
    effective,
    independent,
    atRisk,
    atRiskSidecar,
    missingRoots: missing,
    missingRootsSample,
    ...(missingRootsSidecar === undefined ? {} : { missingRootsSidecar }),
    elapsedMs,
  }
}

/**
 * Scan every component's candidate contents. A `blocked` result names the first 100 missing root
 * OIDs inline and records the full list in a sidecar; any unreadable, malformed, capped or
 * unwritable step is `unknown` with the observed cause, never a silent pass.
 */
export async function scanContents(
  copyRoot: string,
  entries: Readonly<Record<string, ManifestEntry>>,
  removal: readonly string[],
  options: ContentsScanOptions,
): Promise<ContentsScan> {
  const run = options.run ?? defaultGitRun
  const stream = options.stream ?? defaultGitStream
  const bounds = options.bounds ?? DEFAULT_CONTENTS_BOUNDS
  const clock = options.clock ?? Date.now
  const components: ComponentContents[] = []
  try {
    const sources =
      options.sources ??
      componentsFromManifest(entries).map((component) => ({
        component,
        gitDir: join(copyRoot, component),
        workTree: copyRoot,
      }))
    if (options.sourceMode === "complete-commit" && sources.length === 0) {
      throw new UnknownError("complete-commit source inventory is empty")
    }
    for (const source of sources) {
      components.push(
        await scanComponentGitDir(
          source,
          removal,
          run,
          stream,
          bounds,
          clock,
          options.sidecarDir,
          options.sourceMode ?? "retention",
          options.deadline,
          options.sources !== undefined || options.sourceMode === "complete-commit",
          options.refObservations,
          refObservationKey(copyRoot, source.gitDir ?? join(copyRoot, source.component)),
        ),
      )
    }
  } catch (error) {
    return {
      status: "unknown",
      detail: error instanceof Error ? error.message : String(error),
      components,
    }
  }
  const blocked = components.filter((entry) => entry.missingRoots > 0)
  const first = blocked[0]
  if (first !== undefined) {
    return {
      status: "blocked",
      detail: `${blocked.length} component(s) name root OIDs their own store no longer carries, e.g. ${first.component}: ${first.missingRootsSample.join(", ")}`,
      components,
    }
  }
  const atRisk = components.reduce((total, entry) => total + entry.atRisk, 0)
  return {
    status: "pass",
    detail: `${components.length} component(s); ${atRisk} at-risk OID(s) for gate 5 custody`,
    components,
  }
}
