/**
 * Gate 4 of the #27443(b) retirement proof: the candidate's own Git contents, per component.
 *
 * `Effective(g)` is Git's complete loose+packed+alternate OID set from
 * `cat-file --batch-all-objects --batch-check` (it FOLLOWS alternates, so it is not the owned
 * set). `IndependentStores(g,R)` is the union of the effective sets of external alternate and
 * objects-link targets that are present, independently owned and disjoint from `R`.
 * `AtRisk(g) = Effective(g) \ IndependentStores(g,R)`. `Roots(g)` is every ref, reflog old/new,
 * pseudo-ref and index OID.
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
}

export interface GitRunOptions {
  /** Hard per-child deadline. A child that outlives it is killed and reported `timedOut`. */
  readonly timeoutMs?: number
}

export type GitRun = (args: readonly string[], options?: GitRunOptions) => GitRunResult

/** Streams a git child's stdout as bounded lines; the seam tests use to fake a large or broken output. */
export type GitStreamFactory = (args: readonly string[], options?: GitStreamOptions) => GitLineStream

/** The production line stream: a real child, killed at its byte/line cap or deadline. */
export const defaultGitStream: GitStreamFactory = gitLineStream

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
  readonly effective: number
  readonly independent: number
  /** OIDs reachable in this component but not in any independent store; the gate 5 input. */
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

export interface ContentsScanOptions {
  /** Directory for the content-addressed sidecars; must be outside `E` and `R`. */
  readonly sidecarDir: string
  readonly run?: GitRun
  readonly stream?: GitStreamFactory
  readonly bounds?: ContentsBounds
  readonly clock?: () => number
}

const PSEUDO_REFS = [
  "FETCH_HEAD",
  "ORIG_HEAD",
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REBASE_HEAD",
  "BISECT_HEAD",
  "BISECT_LOG",
]
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
  const result = spawnSync("git", [...args], {
    encoding: "utf8",
    maxBuffer: 1 << 30,
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
    // SIGKILL, not the default SIGTERM: a child that traps or ignores SIGTERM would otherwise run
    // to natural completion and the "hard" deadline would not be hard.
    killSignal: "SIGKILL",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
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
    const store = stack.pop()!
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

/**
 * Yields one `<oid>\t<source>` line per root OID the component records: refs, HEAD, reflog
 * old/new, pseudo-refs and the index. Zero OIDs are excluded (the creation record of a reflog and
 * a symbolic HEAD both name them, and neither is an object the store must carry). Unreadable or
 * malformed root state throws; `scanContents` reports that as `unknown`.
 */
function* rootOidLines(gitDir: string, run: GitRun): Generator<string> {
  const refs = run([`--git-dir=${gitDir}`, "for-each-ref", "--format=%(objectname) %(refname)"])
  if (refs.code !== 0) throw new UnknownError(`for-each-ref failed in ${gitDir}: ${refs.stderr.trim()}`)
  for (const line of refs.stdout.split("\n")) {
    if (line === "") continue
    const [oid, name] = line.split(" ")
    if (oid === undefined || !HEX40.test(oid)) {
      throw new UnknownError(`malformed for-each-ref row in ${gitDir}: ${line.slice(0, 120)}`)
    }
    if (!ZERO_OID.test(oid)) yield `${oid}\tref ${name ?? ""}`.trimEnd()
  }
  const head = run([`--git-dir=${gitDir}`, "rev-parse", "HEAD"])
  if (head.code === 0) {
    const oid = head.stdout.trim()
    if (HEX40.test(oid) && !ZERO_OID.test(oid)) yield `${oid}\tHEAD`
  } else if (!/unknown revision|Needed a single revision|ambiguous argument/u.test(head.stderr)) {
    throw new UnknownError(`rev-parse HEAD failed in ${gitDir}: ${head.stderr.trim()}`)
  }
  const logs = join(gitDir, "logs")
  if (existsSync(logs)) {
    for (const path of reflogFiles(logs)) {
      let content: string
      try {
        content = readFileSync(path, "utf8")
      } catch (error) {
        throw new UnknownError(`cannot read reflog ${path}: ${error instanceof Error ? error.message : String(error)}`)
      }
      for (const line of content.split("\n")) {
        if (line === "") continue
        const [old, next] = line.split(" ")
        if (old === undefined || next === undefined || !HEX40.test(old) || !HEX40.test(next)) {
          throw new UnknownError(`malformed reflog record in ${path}: ${line.slice(0, 120)}`)
        }
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
  const index = run([`--git-dir=${gitDir}`, "ls-files", "--stage"])
  if (index.code === 0) {
    for (const line of index.stdout.split("\n")) {
      if (line === "") continue
      const oid = line.split(/\s+/u)[1]
      if (oid !== undefined && HEX40.test(oid)) yield `${oid}\tindex`
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

async function scanComponent(
  component: string,
  copyRoot: string,
  removal: readonly string[],
  run: GitRun,
  stream: GitStreamFactory,
  bounds: ContentsBounds,
  clock: () => number,
  sidecarDir: string,
): Promise<ComponentContents> {
  const started = clock()
  const gitDir = join(copyRoot, component)
  const remaining = (): number => {
    const left = started + bounds.componentMs - clock()
    if (left <= 0) {
      throw new UnknownError(`${component}: the ${bounds.componentMs} ms component bound is already exhausted`)
    }
    return left
  }
  const rootsRef = await externalSortToSidecar(rootOidLines(gitDir, run), {
    dir: sidecarDir,
    runLines: DEFAULT_SORT_RUN_LINES,
  })
  const objects = join(gitDir, "objects")
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
    [`--git-dir=${gitDir}`, `--work-tree=${copyRoot}`, "cat-file", "--batch-all-objects", "--batch-check"],
    { timeoutMs: remaining(), maxLines: bounds.maxEffectiveOids + 1 },
  )
  const independentStreams = [...independentStores]
    .sort()
    .map((store) =>
      stream(
        [
          `--git-dir=${join(store, "..")}`,
          `--work-tree=${copyRoot}`,
          "cat-file",
          "--batch-all-objects",
          "--batch-check",
        ],
        { timeoutMs: remaining(), maxLines: bounds.maxEffectiveOids + 1 },
      ),
    )
  const atRiskWriter = new SidecarWriter(sidecarDir, "txt")
  const missingWriter = new SidecarWriter(sidecarDir, "txt")
  let effective = 0
  let independent = 0
  let atRisk = 0
  let missing = 0
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
        { label: "roots", lines: readLines(rootsRef.path), keyOf: oidKey },
      ],
      (key, groups) => {
        const effectiveLines = groups.filter((group) => group.label === "effective").flatMap((group) => group.lines)
        const independentLines = groups
          .filter((group) => group.label.startsWith("independent:"))
          .flatMap((group) => group.lines)
        const rootLines = groups.filter((group) => group.label === "roots").flatMap((group) => group.lines)
        if (effectiveLines.length > 0) effective += 1
        if (independentLines.length > 0) independent += 1
        const rootSources = [...new Set(rootLines.map((line) => line.slice(line.indexOf("\t") + 1)))].join(", ")
        if (effectiveLines.length > 0 && independentLines.length === 0) {
          const first = effectiveLines[0]!
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
    )
    for (const source of [effectiveStream, ...independentStreams]) {
      const outcome = await source.outcome
      assertStreamComplete(outcome, {
        timedOut: `${component}: a git child exceeded the ${bounds.componentMs} ms component bound`,
        capped: `${component}: object list exceeded the ${bounds.maxEffectiveOids} cap`,
        failed: `${component}: cat-file failed: ${outcome.stderr.trim()}`,
      })
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
  if (elapsedMs > bounds.componentMs) {
    throw new UnknownError(`${component} exceeded the ${bounds.componentMs} ms component bound after ${effective} OIDs`)
  }
  return {
    component,
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
    for (const component of componentsFromManifest(entries)) {
      components.push(await scanComponent(component, copyRoot, removal, run, stream, bounds, clock, options.sidecarDir))
    }
  } catch (error) {
    return {
      status: "unknown",
      detail: error instanceof Error ? error.message : String(error),
      components,
    }
  }
  const blocked = components.filter((entry) => entry.missingRoots > 0)
  if (blocked.length > 0) {
    const first = blocked[0]!
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
