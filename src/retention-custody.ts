/**
 * Gate 5 of the #27443(b) retirement proof: positive surviving custody for every at-risk OID.
 *
 * For each at-risk OID of every component, a durable witness must exist: a NAMED persistent
 * survivor ref in a store of the same object format whose reachable closure includes the OID,
 * whose alternate path closure is disjoint from the removal set `R`, and whose `fsck --full`
 * succeeds (cached once per pass). An existing alternate target, `cat-file -e`, a transient
 * reflog, or a bead is never a witness. Read-only: git queries and file reads only.
 *
 * The witness search is a MERGE, never a set: each durable ref's `rev-list --objects` output is
 * traversal-ordered, so it is externally sorted into a content-addressed sidecar, and the refs are
 * merged under a bounded fan-in into one OID -> ref-rank index. The at-risk stream is then
 * merge-joined against that index, so peak memory is the sort run buffer plus a line per stream,
 * not a 20,000,000-entry Map.
 */
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { alternateEntries } from "./alternates.ts"
import { tryGit, withGitTimeout } from "./git.ts"
import {
  assertStreamComplete,
  DEFAULT_SORT_RUN_LINES,
  externalSortToSidecar,
  mergeLabeledFiles,
  mergeSorted,
  oidKey,
  readLines,
  SidecarWriter,
  verifySidecar,
  type GitLineStream,
  type SidecarRef,
} from "./retention-stream.ts"
import {
  defaultGitRun,
  defaultGitStream,
  refuseSuccessfulStderr,
  type ComponentContents,
  type GitRun,
  type GitStreamFactory,
} from "./retention-contents.ts"

export interface CustodyBounds {
  /** 20,000,000 reachable OIDs per survivor graph in the contract's initial pass. */
  readonly maxReachableOids: number
  /** 300 s per survivor graph in the contract's initial pass. */
  readonly reachableMs: number
  /** 300 s per cached witness `fsck --full` in the contract's initial pass. */
  readonly fsckMs: number
}
export const DEFAULT_CUSTODY_BOUNDS: CustodyBounds = {
  maxReachableOids: 20_000_000,
  reachableMs: 300_000,
  fsckMs: 300_000,
}

export interface CustodyTarget {
  readonly component: string
  readonly oid: string
  readonly source: string
}

/** A durable survivor ref that witnessed at least one at-risk OID; the inline distinct identity. */
export interface WitnessIdentity {
  readonly store: string
  readonly ref: string
  readonly tip: string
  /** sha256 of this ref's sorted reachable-OID sidecar. */
  readonly graphDigest: string
}

export interface CustodyScan {
  readonly status: "pass" | "blocked" | "unknown"
  readonly detail: string
  /** The distinct (store, ref, tip) identities; bounded by the number of durable refs. */
  readonly witnesses: readonly WitnessIdentity[]
  /** The number of at-risk OIDs that found a durable witness. */
  readonly witnessCount: number
  readonly witnessSidecar?: SidecarRef | undefined
  /** The first 100 un-witnessed OIDs; the full list is `missingSidecar`. */
  readonly missing: readonly CustodyTarget[]
  readonly missingCount: number
  readonly missingSidecar?: SidecarRef | undefined
  /** At-risk commits a rebase removed that the published main graph still holds by patch-id. */
  readonly rebased?: readonly RebaseWitness[] | undefined
  /**
   * 34787 (@cto 34787-component-retention-ruling correction 4): when blocked, the exact loss per component: the
   * un-witnessed object count by type and the commit roots (the missing commits no other missing commit reaches),
   * each with its subject. It describes the complete `missingSidecar`; it never stands in for it.
   */
  readonly loss?: readonly MissingComponentLoss[] | undefined
}

/** 34787: one component's un-witnessed objects. `roots` is absent, with `rootsUnknown` saying why, when unproven. */
export interface MissingComponentLoss {
  readonly component: string
  readonly count: number
  readonly types: Readonly<Record<string, number>>
  readonly roots?: readonly Readonly<{ oid: string; subject: string }>[] | undefined
  readonly rootsUnknown?: string | undefined
}

/** 34787: the commit count past which commit roots are reported unknown rather than computed. */
const LOSS_ROOT_COMMIT_LIMIT = 10_000
/** 34787: the per-call bound on describing the loss; a slower call reports the roots unknown. */
const LOSS_GIT_TIMEOUT_MS = 120_000

/**
 * A refused at-risk commit whose stable patch-id equals that of a commit the published main graph
 * holds. The pair is carried out so a close receipt can name the landed commit that stands for the
 * refused one; a patch-id match alone is never a silent pass.
 */
export interface RebaseWitness {
  readonly component: string
  readonly oid: string
  readonly landedOid: string
  readonly ref: string
  readonly tip: string
}

export interface CustodyScanOptions {
  /** Directory for the content-addressed sidecars; must be outside `E` and `R`. */
  readonly sidecarDir: string
  readonly run?: GitRun
  readonly stream?: GitStreamFactory
  readonly bounds?: CustodyBounds
  readonly clock?: () => number
  /** Shared absolute proof deadline in the same clock domain as `clock`; exhaustion is unknown. */
  readonly deadline?: number
  /** When present, only this target branch and exact-suffix primary pin refs are durable witnesses. */
  readonly witnessPolicy?: Readonly<{ targetBranch: string }>
  /** Records a named span of this scan. The removal caller folds these into its phase log. */
  readonly onPhase?: (name: string, ms: number) => void
  /**
   * #35062: the run-owned witness index this scan shares with the other members of its proof phase. Absent, the scan
   * builds its own index in `sidecarDir`, as a single-entry verify always has.
   */
  readonly indexScope?: CustodyIndexScope
}

/** One built witness index: the ranked durable-ref records and the merged OID -> rank file every scan joins against. */
interface BuiltWitnessIndex {
  readonly records: readonly DurableRefRecord[]
  readonly formats: ReadonlyMap<string, string>
  readonly published: ReadonlyArray<Readonly<{ store: string; tip: string }>>
  readonly unsubtracted: readonly string[]
  readonly index: SidecarRef
}

/**
 * #35062 (@cto 34920-shared-index-ruling-1931 §2, 35047-existing-scope-0158 §1-2): one run-owned witness index for one
 * proof phase or held lease window, so the members of a retirement batch build it once instead of once each. Its key
 * is what fixes its meaning: the canonical witness stores, the removal set and the caller policy. The refs, tips,
 * object formats, traversal contexts and fsck results it holds are those its one build read, so a batch makes a new
 * scope for its held window and a held proof never joins against preliminary reads. Each scan still joins its own
 * at-risk rows and reports its own witnesses, coverage and loss. The index and certificate sidecars stay
 * content-addressed in `dir`; reusing the index re-reads its bytes against its digest first, so a missing or altered
 * file is unknown, never a smaller witness set. Nothing here outlives the run that made it.
 */
export class CustodyIndexScope {
  readonly dir: string
  private readonly builds = new Map<string, Promise<BuiltWitnessIndex>>()
  private readonly certificates = new Map<string, SidecarRef>()

  constructor(dir: string) {
    this.dir = dir
  }

  /** The index for `key`, built by `build` on first use; a failed build is not kept, so the next scan retries it. */
  async witnessIndex(key: string, build: () => Promise<BuiltWitnessIndex>): Promise<BuiltWitnessIndex> {
    const existing = this.builds.get(key)
    if (existing === undefined) {
      const pending = build()
      this.builds.set(key, pending)
      pending.catch(() => {
        if (this.builds.get(key) === pending) this.builds.delete(key)
      })
      return pending
    }
    const built = await existing
    await verifySidecar(built.index)
    return built
  }

  /** A full-closure certificate an earlier scan in this scope already walked, keyed by `gitDir<TAB>tip`. */
  certificate(key: string): SidecarRef | undefined {
    return this.certificates.get(key)
  }

  keepCertificate(key: string, certificate: SidecarRef): void {
    this.certificates.set(key, certificate)
  }
}

const HEX40 = /^[0-9a-f]{40}$/u
/** The only durable witness namespaces the contract admits: branches, tags and GitSuper pins. */
const DURABLE_REF = /^refs\/(?:heads|tags)\//u
const PIN_REF = /^refs\/git-super\/pins\//u
const MISSING_INLINE = 100

class UnknownError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UnknownError"
  }
}

function isDurableRef(ref: string): boolean {
  return DURABLE_REF.test(ref) || PIN_REF.test(ref)
}

const PUBLISHED_READ_TIMEOUT_MS = 120_000
/**
 * Diff-producing reads are pinned: the own copy and the primary store must hash the same bytes for one
 * patch, so a store's diff config can never turn an exact rebase into a false refusal.
 */
const PINNED_DIFF_CONFIG = ["-c", "diff.renames=false", "-c", "diff.noprefix=false", "-c", "diff.external="] as const
const PINNED_DIFF_READ = ["--no-ext-diff", "--no-textconv", "--full-index"] as const

/** A refused set this size still gets a patch-id read; beyond it the answer is unknown, never a pass. */
const REBASE_CANDIDATE_LIMIT = 500
/** A patch stream larger than this is not read into memory to guess at a match. */
const REBASE_PATCH_BYTES = 8 * 1024 * 1024

/**
 * The remote whose published refs decide durability: `origin` when configured, else the only one.
 * Two non-origin remotes leave no authority to choose, so that is unknown rather than a guess; a
 * store with no remote has nothing newer to read and keeps the local refs it always had.
 */
async function configuredRemote(gitDir: string, run: GitRun): Promise<string | undefined> {
  // `git remote` answers names only. Reading `config --get-regexp` means parsing around the URL value,
  // and a URL that itself ends in `.url` made the name swallow the value.
  const remotes = await run([`--git-dir=${gitDir}`, "remote"])
  if (remotes.code !== 0) {
    throw new UnknownError(
      `witness store ${gitDir}: its remotes could not be listed (${remotes.stderr.trim() || `exit ${String(remotes.code)}`})`,
    )
  }
  const ordered = [
    ...new Set(
      remotes.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((name) => name !== ""),
    ),
  ].sort()
  if (ordered.includes("origin")) return "origin"
  if (ordered.length === 1) return ordered[0]
  if (ordered.length === 0) return undefined
  throw new UnknownError(
    `witness store ${gitDir}: it configures ${String(ordered.length)} remotes and no origin (${ordered.join(", ")}), so which one publishes its refs is unknown`,
  )
}

/**
 * Read what the component's remote publishes NOW for the target branch and its GitSuper pins, then
 * make those commits readable in this witness store. A local remote-tracking ref or branch may be
 * days stale, so it never decides what is published; a remote that cannot be read is unknown, with
 * no fallback to the local copies (operator 2026-10-21, same rule as the value reader).
 *
 * Pins are named by the commit they point at, so fetching them by name is idempotent. The target
 * branch is fetched for its objects only, because a custody check must never move the primary's
 * own branch.
 */
async function refreshPublishedRefs(
  gitDir: string,
  remote: string,
  targetBranch: string,
  run: GitRun,
): Promise<Readonly<{ branchTip?: string; pinCount: number }>> {
  const targetRef = `refs/heads/${targetBranch}`
  const listed = await run(
    [`--git-dir=${gitDir}`, "ls-remote", "--symref", remote, targetRef, "refs/git-super/pins/*"],
    { timeoutMs: PUBLISHED_READ_TIMEOUT_MS },
  )
  if (listed.code !== 0) {
    throw new UnknownError(
      `witness store ${gitDir}: its remote ${remote} did not answer ls-remote (${listed.stderr.trim() || `exit ${String(listed.code)}`}), so the refs it publishes are unknown`,
    )
  }
  let branchTip: string | undefined
  let pinCount = 0
  for (const line of listed.stdout.split("\n")) {
    if (line.trim() === "" || line.startsWith("ref: ")) continue
    const [, sha, ref] = /^([0-9a-f]{40,64})\t(\S+)$/u.exec(line) ?? []
    if (sha === undefined || ref === undefined) {
      throw new UnknownError(
        `witness store ${gitDir}: ls-remote ${remote} answered an unreadable line ${JSON.stringify(line)}`,
      )
    }
    if (ref === targetRef) branchTip = sha
    else if (PIN_REF.test(ref)) pinCount += 1
  }
  if (pinCount > 0) {
    const fetched = await run(
      [
        `--git-dir=${gitDir}`,
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-recurse-submodules",
        "--no-write-fetch-head",
        "--no-auto-maintenance",
        remote,
        `+refs/git-super/pins/*:refs/git-super/pins/*`,
      ],
      { timeoutMs: PUBLISHED_READ_TIMEOUT_MS },
    )
    if (fetched.code !== 0) {
      throw new UnknownError(
        `witness store ${gitDir}: fetching the pins ${remote} publishes failed (${fetched.stderr.trim() || `exit ${String(fetched.code)}`}), so their custody is unknown`,
      )
    }
  }
  if (branchTip !== undefined) {
    const fetched = await run(
      [
        `--git-dir=${gitDir}`,
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-recurse-submodules",
        "--no-write-fetch-head",
        "--no-auto-maintenance",
        "--refmap=",
        remote,
        targetRef,
      ],
      { timeoutMs: PUBLISHED_READ_TIMEOUT_MS },
    )
    if (fetched.code !== 0) {
      throw new UnknownError(
        `witness store ${gitDir}: fetching ${targetRef} from ${remote} failed (${fetched.stderr.trim() || `exit ${String(fetched.code)}`}), so the commits it publishes are unknown`,
      )
    }
  }
  return { ...(branchTip === undefined ? {} : { branchTip }), pinCount }
}

/**
 * `git patch-id` reads its patch stream on stdin, which the injected `GitRun` cannot carry. This one
 * read therefore goes through the package's own runner, bounded, and every failure is loud.
 */
function patchIdIndex(
  gitDir: string,
  args: readonly string[],
  input: string | undefined,
  what: string,
): Map<string, string> {
  let stdout: string
  try {
    stdout = withGitTimeout(PUBLISHED_READ_TIMEOUT_MS, () => tryGit(gitDir, args, undefined, input)).stdout
  } catch (error) {
    throw new UnknownError(`${what} could not be read: ${error instanceof Error ? error.message : String(error)}`)
  }
  const byId = new Map<string, string>()
  for (const line of stdout.split("\n")) {
    const [, patchId, commitId] = /^([0-9a-f]{40,64}) ([0-9a-f]{40,64})$/u.exec(line.trim()) ?? []
    if (patchId !== undefined && commitId !== undefined) byId.set(commitId, patchId)
  }
  return byId
}

export function isPolicyRef(ref: string, tip: string, targetBranch: string): boolean {
  if (ref === `refs/heads/${targetBranch}`) return true
  const pin = /^(?:refs\/git-super\/pins|refs\/yrd\/pins)\/([0-9a-f]{40})$/u.exec(ref)
  return pin?.[1] === tip
}

function within(parent: string, path: string): boolean {
  const part = relative(parent, path)
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part))
}

function isObjectDir(path: string): boolean {
  return (
    existsSync(path) &&
    statSync(path).isDirectory() &&
    (existsSync(join(path, "pack")) || existsSync(join(path, "info")))
  )
}

/** Transitive alternates closure of a store, refusing any link into `R` or a missing target. */
function alternateClosure(
  objects: string,
  removal: readonly string[],
): { status: "ok"; stores: string[] } | { status: "unknown"; detail: string } {
  const stores: string[] = []
  const seen = new Set<string>()
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
        return { status: "unknown", detail: `witness store ${store} borrows ${target} inside the removal set` }
      }
      stack.push(target)
    }
  }
  return { status: "ok", stores }
}

async function objectFormat(
  gitDir: string,
  run: GitRun,
): Promise<{ status: "ok"; format: string } | { status: "unknown"; detail: string }> {
  const result = await run([`--git-dir=${gitDir}`, "rev-parse", "--show-object-format"])
  refuseSuccessfulStderr(result, `rev-parse --show-object-format in ${gitDir}`)
  if (result.code !== 0) {
    return { status: "unknown", detail: `rev-parse --show-object-format failed in ${gitDir}: ${result.stderr.trim()}` }
  }
  const format = result.stdout.trim()
  if (format !== "sha1" && format !== "sha256") {
    return { status: "unknown", detail: `${gitDir} reports unsupported object format '${format}'` }
  }
  return { status: "ok", format }
}

/** Drain bounded output before classifying it: a partial row cannot hide a native failure. */
async function* reachableOidLines(
  stream: GitLineStream,
  gitDir: string,
  tip: string,
  bounds: CustodyBounds,
  deadlinePassed: () => boolean,
): AsyncGenerator<string> {
  let malformed: UnknownError | undefined
  for await (const line of stream.lines) {
    if (malformed !== undefined) continue
    const oid = line.split(" ")[0]
    if (oid === undefined || !HEX40.test(oid)) {
      malformed = new UnknownError(`malformed rev-list row for ${tip} in ${gitDir}: ${line.slice(0, 120)}`)
      continue
    }
    yield oid
  }
  // Await only after draining: the producer can otherwise be paused at its queue bound.
  const outcome = await stream.outcome
  assertStreamComplete(outcome, {
    // The proof stream clamps the walk's timeout to the shared deadline: a kill at or past it ran out of shared time,
    // not this walk's own bound (#34920: two measurement runs reported the 300 s bound for a deadline kill).
    timedOut: deadlinePassed()
      ? `shared proof deadline is exhausted during rev-list ${tip} in ${gitDir}`
      : `rev-list ${tip} in ${gitDir} exceeded the ${bounds.reachableMs} ms bound`,
    capped: `reachable OIDs exceeded the ${bounds.maxReachableOids} cap in ${gitDir}`,
    failed: `rev-list ${tip} failed in witness store ${gitDir}: ${outcome.stderr.trim()}`,
    warned: `rev-list ${tip} in ${gitDir} exited 0 with stderr: ${outcome.stderr.trim()}`,
  })
  if (malformed !== undefined) throw malformed
}

/**
 * One durable witness ref, in global rank order. `fragment` is a PRIVATE index input, never a graph certificate:
 * the ref's sorted reachable OIDs minus those reachable from earlier-ranked tips whose traversal is equivalent in
 * this store (#34920, @cto 34920-witness-index-direction A3). `complete` is true only when no tip was subtracted, so
 * the fragment IS the full sorted closure and its sha256 may stand as the graphDigest.
 */
interface DurableRefRecord {
  readonly store: string
  readonly gitDir: string
  readonly ref: string
  readonly tip: string
  readonly format: string
  readonly fragment: SidecarRef
  readonly complete: boolean
  /** Read as a detached gitdir because its recorded core.worktree is gone (#34920). */
  readonly detached: boolean
}

/**
 * #34920 (@cto 34920-ranking-and-bare-r2 §2, the gate 4 class): a store that still records `core.worktree` for a
 * checkout that is gone dies on chdir to that missing path ("cannot chdir", live: .git/modules/vendor/brain8). Gate 5
 * reads such a store with `--work-tree=<gitDir>`, not gate 4's `--bare`: `fsck --full` runs `refs verify`,
 * `multi-pack-index verify` and `commit-graph verify` as children, which do not inherit `--bare` but do inherit the
 * GIT_WORK_TREE that `--work-tree` exports. It is a command context only: nothing here writes a worktree, no config is
 * rewritten, and `core.worktree` stays as evidence. A store with no recorded worktree, or one that exists, is read
 * exactly as before.
 */
async function worktreeGone(gitDir: string, run: GitRun): Promise<boolean> {
  const configured = await run(["config", "--file", join(gitDir, "config"), "--get", "core.worktree"])
  refuseSuccessfulStderr(configured, `config --get core.worktree in ${gitDir}`)
  if (configured.code === 1) return false
  if (configured.code !== 0) {
    throw new UnknownError(`config --get core.worktree failed in ${gitDir}: ${configured.stderr.trim()}`)
  }
  const worktree = resolve(gitDir, configured.stdout.trim())
  try {
    return lstatSync(worktree, { throwIfNoEntry: false }) === undefined
  } catch (error) {
    // A path component that is a file proves the worktree cannot exist; any other failure is not absence.
    if ((error as NodeJS.ErrnoException).code === "ENOTDIR") return true
    throw new UnknownError(`cannot probe recorded core.worktree ${worktree} of ${gitDir}: ${String(error)}`)
  }
}

function atStore(run: GitRun, gitDir: string, detached: boolean): GitRun {
  return detached ? (args, options) => run([`--work-tree=${gitDir}`, ...args], options) : run
}

function atStoreStream(stream: GitStreamFactory, gitDir: string, detached: boolean): GitStreamFactory {
  return detached ? (args, options) => stream([`--work-tree=${gitDir}`, ...args], options) : stream
}

/** #34920: a store's traversal may be subtracted across stores only when nothing rewrites or truncates it. */
interface TraversalContext {
  readonly plain: boolean
  /** Why it is not plain; reported in the scan detail, never silent. */
  readonly reason?: string
}

/** At most this many earlier tips are subtracted per walk; any subset is correct, fewer only repeats more objects. */
const MAX_SUBTRACTED_TIPS = 4096

async function traversalContext(
  gitDir: string,
  refRows: readonly string[],
  run: GitRun,
  witnessPolicy: Readonly<{ targetBranch: string }> | undefined,
): Promise<TraversalContext> {
  // The policy runner passes --no-replace-objects and GIT_NO_REPLACE_OBJECTS, so replace refs cannot act there; the
  // generic runner passes neither, so a replace ref (or a moved replace base) rewrites this store's traversal.
  if (witnessPolicy === undefined) {
    if (process.env.GIT_REPLACE_REF_BASE !== undefined) return { plain: false, reason: "GIT_REPLACE_REF_BASE is set" }
    if (process.env.GIT_NO_REPLACE_OBJECTS === undefined && refRows.some((row) => row.startsWith("refs/replace/"))) {
      return { plain: false, reason: "replace refs present" }
    }
  }
  if (process.env.GIT_GRAFT_FILE !== undefined) return { plain: false, reason: "GIT_GRAFT_FILE is set" }
  if (existsSync(join(gitDir, "info", "grafts"))) return { plain: false, reason: "info/grafts present" }
  if (existsSync(join(gitDir, "shallow"))) return { plain: false, reason: "shallow" }
  const promisor = await run([
    `--git-dir=${gitDir}`,
    "config",
    "--get-regexp",
    "^(extensions\\.partialclone|remote\\..*\\.promisor)$",
  ])
  refuseSuccessfulStderr(promisor, `config --get-regexp promisor in ${gitDir}`)
  if (promisor.code === 0 && promisor.stdout.trim() !== "") return { plain: false, reason: "partial clone (promisor)" }
  if (promisor.code !== 0 && promisor.code !== 1) {
    throw new UnknownError(`config --get-regexp promisor failed in ${gitDir}: ${promisor.stderr.trim()}`)
  }
  return { plain: true }
}

/**
 * Sorted reachable OIDs of `tip` minus those reachable from `subtract`. With nothing subtracted this is the complete
 * closure: the canonical graph certificate whose sha256 is a witness's graphDigest.
 */
async function reachableSidecar(
  gitDir: string,
  tip: string,
  subtract: readonly string[],
  stream: GitStreamFactory,
  bounds: CustodyBounds,
  clock: () => number,
  sidecarDir: string,
  deadline: number | undefined,
): Promise<SidecarRef> {
  const started = clock()
  // --ignore-missing drops a subtracted tip this store lacks; dropping one only repeats objects, never loses one.
  const args =
    subtract.length === 0
      ? [`--git-dir=${gitDir}`, "rev-list", "--objects", tip]
      : [`--git-dir=${gitDir}`, "rev-list", "--objects", "--ignore-missing", tip, "--not", ...subtract]
  const lineStream = stream(args, { timeoutMs: bounds.reachableMs, maxLines: bounds.maxReachableOids })
  const deadlinePassed = (): boolean => deadline !== undefined && clock() >= deadline
  const sidecar = await externalSortToSidecar(reachableOidLines(lineStream, gitDir, tip, bounds, deadlinePassed), {
    dir: sidecarDir,
    runLines: DEFAULT_SORT_RUN_LINES,
    deadline,
    clock,
  })
  if (deadlinePassed()) throw new UnknownError("shared proof deadline is exhausted")
  if (clock() - started > bounds.reachableMs) {
    throw new UnknownError(`rev-list ${tip} in ${gitDir} exceeded the ${bounds.reachableMs} ms bound`)
  }
  return sidecar
}

interface WitnessRef {
  readonly ref: string
  readonly tip: string
  readonly objectType: string | undefined
}

/** Select real refs whose complete graphs cover every admitted durable commit, under either policy (#35062). */
async function independentRefs(
  durable: readonly WitnessRef[],
  gitDir: string,
  run: GitRun,
): Promise<readonly WitnessRef[]> {
  // Descendant graphs contain their ancestors' complete object graphs. Noncommit
  // refs retain their own graphs; each selected commit keeps one real named ref.
  const commitRefs = new Map<string, string>()
  for (const entry of durable) {
    if (entry.objectType === "commit" && !commitRefs.has(entry.tip)) commitRefs.set(entry.tip, entry.ref)
  }
  let independent = new Set(commitRefs.keys())
  if (commitRefs.size > 1) {
    const reduced = await run([`--git-dir=${gitDir}`, "merge-base", "--independent", ...commitRefs.keys()])
    refuseSuccessfulStderr(reduced, `merge-base --independent in witness store ${gitDir}`)
    if (reduced.code !== 0 || reduced.timedOut === true) {
      throw new UnknownError(
        `merge-base --independent did not complete in ${gitDir} (exit ${reduced.code}, timedOut ${reduced.timedOut === true}): ${reduced.stderr.trim()}`,
      )
    }
    const tips = reduced.stdout.trim().split("\n")
    const unproven = tips.find((tip) => !HEX40.test(tip) || !commitRefs.has(tip))
    if (unproven !== undefined) {
      throw new UnknownError(
        `merge-base --independent returned an unproven tip in ${gitDir} (first 120 characters): ${JSON.stringify(unproven.slice(0, 120))}`,
      )
    }
    independent = new Set(tips)
  }
  return durable.filter(
    (entry) => entry.objectType !== "commit" || (independent.has(entry.tip) && commitRefs.get(entry.tip) === entry.ref),
  )
}

async function indexWitnessStores(
  stores: readonly string[],
  removal: readonly string[],
  stream: GitStreamFactory,
  run: GitRun,
  bounds: CustodyBounds,
  clock: () => number,
  sidecarDir: string,
  witnessPolicy?: Readonly<{ targetBranch: string }>,
  deadline?: number,
  onPhase?: (name: string, ms: number) => void,
): Promise<{
  records: DurableRefRecord[]
  formats: Map<string, string>
  published: ReadonlyArray<Readonly<{ store: string; tip: string }>>
  /** Stores whose traversal is not plain, so their refs were walked without cross-store subtraction, and why. */
  unsubtracted: readonly string[]
}> {
  const records: DurableRefRecord[] = []
  const prior: Array<Readonly<{ store: string; tip: string; plain: boolean }>> = []
  const unsubtracted: string[] = []
  const formats = new Map<string, string>()
  const published: Array<Readonly<{ store: string; tip: string }>> = []
  let witnessFsckMs = 0
  let refGraphMs = 0
  for (const store of stores) {
    const gitDir = dirname(store)
    // #34920: a witness store whose recorded core.worktree is gone is read detached (see worktreeGone).
    const detached = await worktreeGone(gitDir, run)
    const storeRun = atStore(run, gitDir, detached)
    const storeStream = atStoreStream(stream, gitDir, detached)
    const format = await objectFormat(gitDir, storeRun)
    if (format.status !== "ok") throw new UnknownError(format.detail)
    formats.set(store, format.format)
    let publishedBranchTip: string | undefined
    if (witnessPolicy !== undefined) {
      const shallow = await storeRun([`--git-dir=${gitDir}`, "rev-parse", "--is-shallow-repository"])
      refuseSuccessfulStderr(shallow, `rev-parse --is-shallow-repository in ${gitDir}`)
      if (shallow.code !== 0 || !["true", "false"].includes(shallow.stdout.trim())) {
        throw new UnknownError(
          `rev-parse --is-shallow-repository failed in ${gitDir}: ${shallow.stderr.trim() || shallow.stdout.trim()}`,
        )
      }
      if (shallow.stdout.trim() === "true") {
        throw new UnknownError(`witness graph in ${gitDir} is shallow and cannot prove complete custody`)
      }
      // What the remote publishes now, never this store's possibly days-old copy of it.
      // Remote refresh stays on the plain runner, never the detached one (@cto 34920-residual-existing-scope-1626).
      const remote = await configuredRemote(gitDir, run)
      if (remote !== undefined) {
        const refreshed = await refreshPublishedRefs(gitDir, remote, witnessPolicy.targetBranch, run)
        publishedBranchTip = refreshed.branchTip
        if (refreshed.branchTip !== undefined) published.push({ store, tip: refreshed.branchTip })
      }
    }
    const closureResult = alternateClosure(store, removal)
    if (closureResult.status !== "ok") throw new UnknownError(closureResult.detail)
    // A hung `fsck` is killed at the declared deadline and reported unknown, never blocking.
    const fsckStarted = clock()
    const fsck = await storeRun([`--git-dir=${gitDir}`, "fsck", "--full", "--no-progress"], {
      timeoutMs: bounds.fsckMs,
    })
    witnessFsckMs += clock() - fsckStarted
    refuseSuccessfulStderr(fsck, `fsck --full in witness store ${gitDir}`)
    if (fsck.code !== 0) {
      throw new UnknownError(`fsck --full failed in witness store ${gitDir}: ${fsck.stderr.trim()}`)
    }
    // #35062 (@cto 34920-shared-index-ruling-1931 §1): retention reads object types too, so both policies walk only
    // independent commit tips plus every noncommit ref.
    const refs = await storeRun([
      `--git-dir=${gitDir}`,
      "for-each-ref",
      "--format=%(refname)%09%(objectname)%09%(objecttype)",
    ])
    refuseSuccessfulStderr(refs, `for-each-ref in witness store ${gitDir}`)
    if (refs.code !== 0) {
      throw new UnknownError(`for-each-ref failed in witness store ${gitDir}: ${refs.stderr.trim()}`)
    }
    const durable: WitnessRef[] = []
    for (const row of refs.stdout.split("\n")) {
      if (row === "") continue
      const fields = row.split("\t")
      const [ref, tip, objectType] = fields
      if (
        ref === undefined ||
        tip === undefined ||
        !HEX40.test(tip) ||
        fields.length !== 3 ||
        objectType === undefined ||
        !["commit", "tag", "tree", "blob"].includes(objectType)
      ) {
        throw new UnknownError(`malformed for-each-ref row in witness store ${gitDir}: ${row.slice(0, 120)}`)
      }
      // A transient operation ref, remote-tracking ref or detached HEAD is never a durable
      // witness: only a named branch, tag or GitSuper pin qualifies (contract gate 5).
      if (witnessPolicy === undefined ? !isDurableRef(ref) : !isPolicyRef(ref, tip, witnessPolicy.targetBranch)) {
        continue
      }
      durable.push({ ref, tip, objectType })
    }
    if (witnessPolicy !== undefined && publishedBranchTip !== undefined) {
      const targetRef = `refs/heads/${witnessPolicy.targetBranch}`
      if (!durable.some((entry) => entry.ref === targetRef && entry.tip === publishedBranchTip)) {
        // The published tip is a durable name for the same ref even though no local ref names it yet.
        durable.push({ ref: targetRef, tip: publishedBranchTip, objectType: "commit" })
      }
    }
    durable.sort((left, right) => (left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0))
    const selected = await independentRefs(durable, gitDir, storeRun)
    const context = await traversalContext(gitDir, refs.stdout.split("\n"), storeRun, witnessPolicy)
    if (!context.plain && selected.length > 0) {
      unsubtracted.push(`${gitDir} (${context.reason ?? "traversal not plain"})`)
    }
    const refStarted = clock()
    for (const entry of selected) {
      // #34920 A3: subtract earlier-ranked tips whose closure this store's walk computes exactly as their own store
      // did: always this store's own earlier refs; another store's only when both traversals are plain. The object
      // set each ref emits shrinks, but the minimum-rank ref reaching an OID still emits it (none of its subtracted
      // tips are earlier-ranked reachers), so the labeled merge picks the same witness as a full walk.
      const subtract: string[] = []
      const seen = new Set<string>()
      for (let index = prior.length - 1; index >= 0 && subtract.length < MAX_SUBTRACTED_TIPS; index -= 1) {
        const earlier = prior[index]
        if (earlier === undefined) continue
        if (earlier.store !== store && !(earlier.plain && context.plain)) continue
        if (seen.has(earlier.tip)) continue
        seen.add(earlier.tip)
        subtract.push(earlier.tip)
      }
      const fragment = await reachableSidecar(
        gitDir,
        entry.tip,
        subtract,
        storeStream,
        bounds,
        clock,
        sidecarDir,
        deadline,
      )
      records.push({
        store,
        gitDir,
        ref: entry.ref,
        tip: entry.tip,
        format: format.format,
        fragment,
        complete: subtract.length === 0,
        detached,
      })
      prior.push({ store, tip: entry.tip, plain: context.plain })
    }
    refGraphMs += clock() - refStarted
  }
  onPhase?.("witnessFsck", witnessFsckMs)
  onPhase?.("refGraph", refGraphMs)
  return { records, formats, published, unsubtracted }
}

/**
 * The one second witness a rebase earns: a commit the published main graph still holds whose stable
 * patch-id equals the refused commit's. Merges and empty commits have no patch of their own, so an
 * empty patch-id never passes; the search is bounded by the commits on main that touch the refused
 * commit's paths, and passing that bound is unknown rather than a pass.
 */
async function rebaseWitness(
  target: Readonly<{ component: string; oid: string; source: string }>,
  gitDir: string,
  roots: ReadonlyArray<Readonly<{ store: string; ref: string; tip: string }>>,
  run: GitRun,
): Promise<RebaseWitness | undefined> {
  const names = await run([`--git-dir=${gitDir}`, "show", "--no-color", "--pretty=format:", "--name-only", target.oid])
  refuseSuccessfulStderr(names, `show --name-only ${target.oid} in ${gitDir}`)
  if (names.code !== 0) {
    throw new UnknownError(
      `at-risk commit ${target.oid}: its changed paths could not be read (${names.stderr.trim() || `exit ${String(names.code)}`})`,
    )
  }
  const paths = [
    ...new Set(
      names.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
    ),
  ]
  if (paths.length === 0) return undefined
  let diff: string
  try {
    diff = withGitTimeout(PUBLISHED_READ_TIMEOUT_MS, () =>
      tryGit(gitDir, [
        `--git-dir=${gitDir}`,
        ...PINNED_DIFF_CONFIG,
        "show",
        ...PINNED_DIFF_READ,
        "--no-color",
        target.oid,
      ]),
    ).stdout
  } catch (error) {
    throw new UnknownError(
      `at-risk commit ${target.oid}: its patch could not be read (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  if (diff.length > REBASE_PATCH_BYTES) {
    throw new UnknownError(`at-risk commit ${target.oid}: its patch exceeds ${REBASE_PATCH_BYTES} bytes`)
  }
  const own = patchIdIndex(gitDir, ["patch-id", "--verbatim"], diff, `patch-id of ${target.oid}`)
  const ownId = own.get(target.oid)
  if (ownId === undefined) return undefined
  for (const root of roots) {
    const storeDir = dirname(root.store)
    // The paths only choose candidates. Every candidate is then hashed on its COMPLETE patch, never
    // on the projection onto those paths: a commit that also changed other files is a different
    // patch, and matching it would record a landed twin that never carried this change.
    const listed = await run([`--git-dir=${storeDir}`, "rev-list", root.tip, "--", ...paths])
    refuseSuccessfulStderr(listed, `rev-list ${root.tip} in ${storeDir}`)
    if (listed.code !== 0) {
      throw new UnknownError(`published ${root.ref} history in ${storeDir} could not be read (${listed.stderr.trim()})`)
    }
    const candidates = listed.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
    if (candidates.length > REBASE_CANDIDATE_LIMIT) {
      throw new UnknownError(
        `${String(candidates.length)} commit(s) on published ${root.ref} touch the paths of ${target.oid}, above the ${REBASE_CANDIDATE_LIMIT} patch-id bound`,
      )
    }
    if (candidates.length === 0) continue
    const complete = await run([
      `--git-dir=${storeDir}`,
      ...PINNED_DIFF_CONFIG,
      "show",
      ...PINNED_DIFF_READ,
      "--no-color",
      "--no-notes",
      ...candidates,
    ])
    refuseSuccessfulStderr(complete, `show ${root.ref} candidates in ${storeDir}`)
    if (complete.code !== 0) {
      throw new UnknownError(
        `published ${root.ref} patches in ${storeDir} could not be read (${complete.stderr.trim()})`,
      )
    }
    if (complete.stdout.length > REBASE_PATCH_BYTES) {
      throw new UnknownError(`published ${root.ref} patches in ${storeDir} exceed ${REBASE_PATCH_BYTES} bytes`)
    }
    const landed = patchIdIndex(
      storeDir,
      ["patch-id", "--verbatim"],
      complete.stdout,
      `published patch ids on ${root.ref}`,
    )
    for (const [landedOid, patchId] of landed) {
      if (patchId !== ownId) continue
      return { component: target.component, oid: target.oid, landedOid, ref: root.ref, tip: root.tip }
    }
  }
  return undefined
}

/**
 * A refused commit whose component store path is unknown is never silently dropped from the report:
 * it stays refused, and the detail says so by name.
 */
/** #34920: stores whose refs were walked in full because their traversal could not be shown plain. */
function unsubtractedDetail(stores: ReadonlyArray<string>): string {
  if (stores.length === 0) return ""
  const shown = stores.slice(0, 5).join(", ")
  const more = stores.length > 5 ? ` and ${String(stores.length - 5)} more` : ""
  return `; witness index walked ${String(stores.length)} store(s) without cross-store subtraction: ${shown}${more}`
}

function uncheckedDetail(unchecked: ReadonlyArray<string>): string {
  if (unchecked.length === 0) return ""
  const shown = unchecked.slice(0, 5).join(", ")
  const more = unchecked.length > 5 ? ` and ${String(unchecked.length - 5)} more` : ""
  return `; ${String(unchecked.length)} refused OID(s) not patch-id checked because their component store path is unknown: ${shown}${more}`
}

async function runCustody(
  copyRoot: string,
  components: readonly ComponentContents[],
  witnessStores: readonly string[],
  removal: readonly string[],
  run: GitRun,
  stream: GitStreamFactory,
  bounds: CustodyBounds,
  clock: () => number,
  sidecarDir: string,
  witnessPolicy?: Readonly<{ targetBranch: string }>,
  deadline?: number,
  onPhase?: (name: string, ms: number) => void,
  indexScope?: CustodyIndexScope,
): Promise<CustodyScan> {
  const remaining = (): number => {
    const left = deadline === undefined ? Number.POSITIVE_INFINITY : deadline - clock()
    if (left <= 0) throw new UnknownError("shared proof deadline is exhausted")
    return left
  }
  remaining()
  // Callers enter only after a completed contents scan. An empty risk set needs no
  // witness (#33010, @cto 81aae278), but counters alone cannot replace its sidecars.
  const noAtRiskObjects =
    components.length > 0 &&
    components.every((component) => {
      if (component.missingRoots !== 0 || component.atRisk !== 0) return false
      const sidecar = statSync(component.atRiskSidecar.path)
      return sidecar.isFile() && sidecar.size === 0
    })
  remaining()
  if (noAtRiskObjects) {
    return {
      status: "pass",
      detail: `${components.length} component(s); no at-risk objects; no witness needed`,
      witnesses: [],
      witnessCount: 0,
      missing: [],
      missingCount: 0,
    }
  }
  const stores = [...new Set(witnessStores.map((store) => realpathSync(store)))]
    .filter((store) => !removal.some((root) => within(root, store)))
    .sort()
  const badStore = stores.find((store) => !isObjectDir(store))
  if (badStore !== undefined) {
    return {
      status: "unknown",
      detail: `witness store ${badStore} is not a Git object directory`,
      witnesses: [],
      witnessCount: 0,
      missing: [],
      missingCount: 0,
    }
  }
  const proofRun: GitRun = async (args, runOptions = {}) => {
    const timeoutMs = Math.min(runOptions.timeoutMs ?? Number.POSITIVE_INFINITY, remaining())
    return run(witnessPolicy === undefined ? args : ["--no-replace-objects", ...args], {
      ...runOptions,
      ...(Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
      ...(witnessPolicy === undefined
        ? {}
        : { env: { ...runOptions.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" } }),
    })
  }
  const proofStream: GitStreamFactory = (args, streamOptions = {}) =>
    stream(witnessPolicy === undefined ? args : ["--no-replace-objects", ...args], {
      ...streamOptions,
      timeoutMs: Math.min(streamOptions.timeoutMs ?? Number.POSITIVE_INFINITY, remaining()),
      ...(witnessPolicy === undefined
        ? {}
        : { env: { ...streamOptions.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" } }),
    })
  const indexDir = indexScope?.dir ?? sidecarDir
  const buildIndex = async (): Promise<BuiltWitnessIndex> => {
    const indexed = await indexWitnessStores(
      stores,
      removal,
      proofStream,
      proofRun,
      bounds,
      clock,
      indexDir,
      witnessPolicy,
      deadline,
      onPhase,
    )
    const width = String(Math.max(1, indexed.records.length)).length
    const merged = await mergeLabeledFiles(
      indexed.records.map((record, rank) => ({ path: record.fragment.path, label: String(rank).padStart(width, "0") })),
      { dir: indexDir, deadline, clock },
    )
    return { ...indexed, index: merged }
  }
  const { records, formats, published, unsubtracted, index } =
    indexScope === undefined
      ? await buildIndex()
      : await indexScope.witnessIndex(
          JSON.stringify([stores, [...removal].sort(), witnessPolicy?.targetBranch ?? null]),
          buildIndex,
        )
  remaining()
  const witnessWriter = new SidecarWriter(sidecarDir, "txt")
  const missingWriter = new SidecarWriter(sidecarDir, "txt")
  // The witnesses actually used, in first-use order; only these get a full graph certificate (#34920 A3).
  const identities = new Map<string, DurableRefRecord>()
  const missing: CustodyTarget[] = []
  const allMissing: Array<CustodyTarget & Readonly<{ gitDir?: string; objectType: string }>> = []
  // 34787: the final un-witnessed set after the rebase subtraction, described per component when gate 5 blocks.
  let finalMissing: readonly (CustodyTarget & Readonly<{ gitDir?: string; objectType: string }>)[] = allMissing
  const rebased: RebaseWitness[] = []
  const unchecked: string[] = []
  let witnessCount = 0
  let missingCount = 0
  let merged = 0
  try {
    for (const component of components) {
      remaining()
      const componentGitDir = component.gitDir ?? join(copyRoot, component.component)
      const format = await objectFormat(
        componentGitDir,
        atStore(proofRun, componentGitDir, await worktreeGone(componentGitDir, proofRun)),
      )
      if (format.status !== "ok") throw new UnknownError(format.detail)
      await mergeSorted(
        [
          { label: "at-risk", lines: readLines(component.atRiskSidecar.path), keyOf: oidKey },
          { label: "witness-index", lines: readLines(index.path), keyOf: oidKey },
        ],
        (key, groups) => {
          if ((merged++ & 1023) === 0) remaining()
          const atRiskLines = groups.find((group) => group.label === "at-risk")?.lines
          if (atRiskLines === undefined || atRiskLines.length === 0) return
          const source = atRiskLines[0]?.split("\t")[2] ?? "owned"
          const objectType = atRiskLines[0]?.split("\t")[1] ?? "unknown"
          const indexLines = groups.find((group) => group.label === "witness-index")?.lines
          if (indexLines === undefined || indexLines.length === 0) {
            missingCount += 1
            if (missing.length < MISSING_INLINE) missing.push({ component: component.component, oid: key, source })
            allMissing.push({
              component: component.component,
              oid: key,
              source,
              objectType,
              ...(component.gitDir === undefined ? {} : { gitDir: component.gitDir }),
            })
            return
          }
          const rank = indexLines[0]?.split("\t")[1]
          const record = rank === undefined ? undefined : records[Number(rank)]
          if (record === undefined) throw new UnknownError(`witness index names an unknown rank '${rank ?? ""}'`)
          if (formats.get(record.store) !== format.format) {
            throw new UnknownError(
              `witness store ${record.store} object format does not match component ${component.component}`,
            )
          }
          witnessCount += 1
          witnessWriter.add(`${key}\t${component.component}\t${record.store}\t${record.ref}\t${record.tip}`)
          const identityKey = `${record.store}\t${record.ref}\t${record.tip}`
          if (!identities.has(identityKey)) identities.set(identityKey, record)
        },
        { deadline, clock },
      )
      remaining()
    }
    // Second witness, rebase only: a refused commit whose stable patch-id the published main graph
    // still holds is superseded, not lost. The pair is recorded so the receipt can be audited.
    const roots =
      witnessPolicy === undefined
        ? []
        : [...new Map(published.map((entry) => [`${entry.store}\t${entry.tip}`, entry])).values()].map((entry) => ({
            store: entry.store,
            ref: `refs/heads/${witnessPolicy.targetBranch}`,
            tip: entry.tip,
          }))
    if (allMissing.length > 0 && roots.length > 0) {
      if (allMissing.length > REBASE_CANDIDATE_LIMIT) {
        throw new UnknownError(
          `${String(allMissing.length)} un-witnessed at-risk OID(s) exceed the ${REBASE_CANDIDATE_LIMIT} patch-id bound`,
        )
      }
      const gitDirs = new Map<string, string>()
      for (const component of components) {
        const dir = component.gitDir ?? join(copyRoot, component.component)
        gitDirs.set(component.component, dir)
      }
      for (const target of allMissing) {
        remaining()
        const gitDir = target.gitDir ?? gitDirs.get(target.component)
        if (gitDir === undefined) {
          unchecked.push(`${target.component}:${target.oid}`)
          continue
        }
        const witness = await rebaseWitness(target, gitDir, roots, run)
        if (witness !== undefined) rebased.push(witness)
      }
    }
    if (rebased.length > 0) {
      const rebasedKeys = new Set(rebased.map((witness) => `${witness.component}\0${witness.oid}`))
      const stillMissing = allMissing.filter((target) => !rebasedKeys.has(`${target.component}\0${target.oid}`))
      finalMissing = stillMissing
      missingCount = stillMissing.length
      missing.length = 0
      for (const target of stillMissing) {
        if (missing.length < MISSING_INLINE) {
          missing.push({ component: target.component, oid: target.oid, source: target.source })
        }
        missingWriter.add(`${target.oid}\t${target.component}\t${target.source}`)
      }
    } else {
      for (const target of allMissing) missingWriter.add(`${target.oid}\t${target.component}\t${target.source}`)
    }
  } catch (error) {
    witnessWriter.abort()
    missingWriter.abort()
    throw error
  }
  let witnessSidecar: SidecarRef | undefined
  if (witnessCount > 0) witnessSidecar = await witnessWriter.finish()
  else witnessWriter.abort()
  let missingSidecar: SidecarRef | undefined
  if (missingCount > 0) missingSidecar = await missingWriter.finish()
  else missingWriter.abort()
  // #34920 A3: graphDigest keeps its exact meaning, the sha256 of the witness's complete sorted closure. A complete
  // fragment already is that file; any other used witness is walked once in full here. A ref that was only considered
  // never gets one.
  const certificateStarted = clock()
  const certificates = new Map<string, SidecarRef>()
  const witnesses: WitnessIdentity[] = []
  for (const record of identities.values()) {
    const key = `${record.gitDir}\t${record.tip}`
    let certificate = record.complete ? record.fragment : (certificates.get(key) ?? indexScope?.certificate(key))
    if (certificate === undefined) {
      remaining()
      certificate = await reachableSidecar(
        record.gitDir,
        record.tip,
        [],
        atStoreStream(proofStream, record.gitDir, record.detached),
        bounds,
        clock,
        indexDir,
        deadline,
      )
      indexScope?.keepCertificate(key, certificate)
    }
    certificates.set(key, certificate)
    witnesses.push({ store: record.store, ref: record.ref, tip: record.tip, graphDigest: certificate.sha256 })
  }
  onPhase?.("witnessCertificates", clock() - certificateStarted)
  remaining()
  const first = missing[0]
  if (missingCount > 0 && first !== undefined) {
    const loss = await describeLoss(finalMissing, components, copyRoot, run)
    return {
      status: "blocked",
      detail: `${missingCount} at-risk OID(s) have no durable witness, e.g. ${first.component} ${first.oid} (${first.source}); first ${missing.length} inline, full list in ${missingSidecar?.path ?? "a sidecar"}${uncheckedDetail(unchecked)}${unsubtractedDetail(unsubtracted)}`,
      witnesses,
      witnessCount,
      ...(witnessSidecar === undefined ? {} : { witnessSidecar }),
      missing,
      missingCount,
      ...(missingSidecar === undefined ? {} : { missingSidecar }),
      rebased,
      loss,
    }
  }
  return {
    status: "pass",
    detail: `${witnessCount} at-risk OID(s) each have a named surviving witness across ${stores.length} store(s), ${witnesses.length} distinct identities${rebased.length === 0 ? "" : `, plus ${String(rebased.length)} rebased commit(s) matched by whitespace-sensitive patch-id to the published main graph`}${uncheckedDetail(unchecked)}${unsubtractedDetail(unsubtracted)}`,
    witnesses,
    witnessCount,
    ...(witnessSidecar === undefined ? {} : { witnessSidecar }),
    missing: [],
    missingCount: 0,
    rebased,
  }
}

/**
 * 34787 (@cto 34787-component-retention-ruling correction 4): name the exact loss a blocked gate 5 found, so an owner
 * discard can bind to it: per component, the count by object type and the commit roots with their subjects. Read-only.
 * A root set that cannot be proven (too many commits, a failed git call, a malformed answer) is reported unknown by
 * name; the counts stay, and nothing here changes gate 5's verdict.
 */
async function describeLoss(
  missing: readonly (CustodyTarget & Readonly<{ gitDir?: string; objectType: string }>)[],
  components: readonly ComponentContents[],
  copyRoot: string,
  run: GitRun,
): Promise<readonly MissingComponentLoss[]> {
  const byComponent = new Map<string, (CustodyTarget & Readonly<{ gitDir?: string; objectType: string }>)[]>()
  for (const target of missing) {
    const list = byComponent.get(target.component) ?? []
    list.push(target)
    byComponent.set(target.component, list)
  }
  const loss: MissingComponentLoss[] = []
  for (const [component, targets] of [...byComponent].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    const types: Record<string, number> = {}
    for (const target of targets) types[target.objectType] = (types[target.objectType] ?? 0) + 1
    const commits = targets.filter((target) => target.objectType === "commit").map((target) => target.oid)
    const declared = components.find((entry) => entry.component === component)
    const gitDir = targets[0]?.gitDir ?? declared?.gitDir ?? join(copyRoot, component)
    const roots = await commitRoots(commits, gitDir, run)
    loss.push({
      component,
      count: targets.length,
      types,
      ...("roots" in roots ? { roots: roots.roots } : { rootsUnknown: roots.unknown }),
    })
  }
  return loss
}

async function commitRoots(
  commits: readonly string[],
  gitDir: string,
  run: GitRun,
): Promise<Readonly<{ roots: readonly Readonly<{ oid: string; subject: string }>[] }> | Readonly<{ unknown: string }>> {
  if (commits.length === 0) return { roots: [] }
  if (commits.length > LOSS_ROOT_COMMIT_LIMIT) {
    return {
      unknown: `${String(commits.length)} missing commits exceed the ${String(LOSS_ROOT_COMMIT_LIMIT)} root bound`,
    }
  }
  let tips = [...commits]
  if (commits.length > 1) {
    const reduced = await run([`--git-dir=${gitDir}`, "merge-base", "--independent", ...commits], {
      timeoutMs: LOSS_GIT_TIMEOUT_MS,
    })
    if (reduced.code !== 0 || reduced.timedOut === true || reduced.stderr.trim() !== "") {
      return {
        unknown: `merge-base --independent in ${gitDir} did not complete cleanly (exit ${String(reduced.code)}): ${reduced.stderr.trim()}`,
      }
    }
    tips = reduced.stdout.trim().split("\n")
    const known = new Set(commits)
    const stray = tips.find((tip) => !HEX40.test(tip) || !known.has(tip))
    if (stray !== undefined) return { unknown: `merge-base --independent in ${gitDir} answered ${stray.slice(0, 80)}` }
  }
  const described = await run([`--git-dir=${gitDir}`, "log", "--no-walk=unsorted", "--format=%H%x09%s", ...tips], {
    timeoutMs: LOSS_GIT_TIMEOUT_MS,
  })
  if (described.code !== 0 || described.timedOut === true || described.stderr.trim() !== "") {
    return {
      unknown: `log of the commit roots in ${gitDir} did not complete cleanly (exit ${String(described.code)}): ${described.stderr.trim()}`,
    }
  }
  const subjects = new Map<string, string>()
  for (const line of described.stdout.split("\n")) {
    if (line === "") continue
    const tab = line.indexOf("\t")
    subjects.set(tab === -1 ? line : line.slice(0, tab), tab === -1 ? "" : line.slice(tab + 1))
  }
  const missingSubject = tips.find((tip) => !subjects.has(tip))
  if (missingSubject !== undefined) {
    return { unknown: `log in ${gitDir} did not describe commit root ${missingSubject}` }
  }
  return { roots: [...tips].sort().map((oid) => ({ oid, subject: subjects.get(oid) ?? "" })) }
}

/**
 * Prove surviving custody for every at-risk OID. `witnessStores` are the managed object
 * directories that survive this pass (the caller owns the complete `N` inventory); a store inside
 * `R`, borrowing into `R`, of a different object format, or failing `fsck` never witnesses. Any
 * unreadable, malformed, capped or unwritable step is `unknown` with the observed cause.
 */
export async function scanCustody(
  copyRoot: string,
  components: readonly ComponentContents[],
  witnessStores: readonly string[],
  removal: readonly string[],
  options: CustodyScanOptions,
): Promise<CustodyScan> {
  const run = options.run ?? defaultGitRun
  const stream = options.stream ?? defaultGitStream
  const bounds = options.bounds ?? DEFAULT_CUSTODY_BOUNDS
  const clock = options.clock ?? Date.now
  try {
    return await runCustody(
      copyRoot,
      components,
      witnessStores,
      removal,
      run,
      stream,
      bounds,
      clock,
      options.sidecarDir,
      options.witnessPolicy,
      options.deadline,
      options.onPhase,
      options.indexScope,
    )
  } catch (error) {
    return {
      status: "unknown",
      detail: error instanceof Error ? error.message : String(error),
      witnesses: [],
      witnessCount: 0,
      missing: [],
      missingCount: 0,
    }
  }
}
