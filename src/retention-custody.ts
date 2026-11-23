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
  IncompleteStreamError,
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
  observeRefs,
  type ComponentContents,
  type GitRun,
  type GitRunOptions,
  type GitStreamFactory,
  type RefObservationRow,
  type RefObservations,
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
  /**
   * 34127 (@cto 536e2c15): stores the pass recorded during inventory but could not read because the path was gone, or
   * was no longer a git repository, by the time custody reached it. That is a race with a moving estate, not a verdict
   * about the entry: a caller may re-inventory and re-evaluate, and only the caller knows how many rescans it allows.
   * Named here so no caller string-matches a git error, and so a pass that keeps moving can report which paths it lost
   * on which round.
   */
  readonly vanishedAtRead?: readonly string[] | undefined
  /** At-risk commits a rebase removed that the published main graph still holds by patch-id. */
  readonly rebased?: readonly RebaseWitness[] | undefined
  /**
   * 37455-A: components whose custody was proven by ancestry instead of by witness or patch-id. Every head the
   * environment holds (the component gitlink's checkout HEAD and its local branch tips) is an ancestor of the
   * published target branch, so nothing this environment names can be lost and no patch stream was read.
   */
  readonly reachability?: readonly HeadReachability[] | undefined
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
   * 34127 (@cto e8f6c3b5): the phase this scan is INSIDE, reported when it is entered. A scan cut by the shared
   * deadline never reaches its completing onPhase, so without this a starved run names no phase at all.
   */
  readonly onPhaseEnter?: (name: string) => void
  /**
   * 34127 (@cto turn60): the REAL time a named operation spent, reported once per phase when the walk ends — including an
   * exceptional exit. Enter windows overlap by construction (the fsck window runs under the graph walk), so only these
   * durations are arithmetic; the windows only carry the phase name.
   */
  readonly onPhaseSpend?: (name: string, ms: number) => void
  /**
   * #35062: the run-owned witness index this scan shares with the other members of its proof phase. Absent, the scan
   * builds its own index in `sidecarDir`, as a single-entry verify always has.
   */
  readonly indexScope?: CustodyIndexScope
  /**
   * 37455-A (@cto 29f8631c): the heads this environment holds per component — the component gitlink's checkout HEAD
   * and its local branch tips. When every one of them is an ancestor of the published target branch, custody is
   * proven by reachability and no patch stream is read. Absent or empty, the component keeps the witness proof.
   */
  readonly environmentHeads?: Readonly<Record<string, readonly string[]>>
  /** 37792 (@cto 93f4ba37): this run's shared store verdicts, so a batch fsck each store once. */
  readonly runScope?: CustodyRunScope
  /**
   * 37854 (@cto 3706925a): TEST SEAM for the subtraction-bound experiment only, never a production setting. The walk
   * subtracts at most this many earlier-ranked tips; absent, it uses {@link MAX_SUBTRACTED_TIPS}. A smaller value only
   * re-emits objects an earlier-ranked ref already emitted, which the labeled merge still resolves to that earlier
   * witness — the object set grows, the witness set does not. It can still cross a walk's OID or time bound, which
   * keeps the entry unknown rather than mis-retiring it; {@link MAX_SUBTRACTED_TIPS} states that limit in full.
   */
  readonly maxSubtractedTips?: number
}

/**
 * 37455-A: one component's custody proven without a witness or a patch read. `store`/`tip` are the published target
 * branch the heads were compared against, so a receipt can re-run the exact check.
 */
export interface HeadReachability {
  readonly component: string
  readonly heads: readonly string[]
  readonly store: string
  readonly tip: string
  /**
   * 37792 (@cto 78e96f64): the remote read and the ref it answered with, in this same run, that fixed `tip`. A
   * mirror's own main ref that was never confirmed against its remote is never a witness.
   */
  readonly confirmedBy?: string
  /**
   * At-risk OIDs no head and no durable witness reaches. They are named here (first 100) instead of read as patches:
   * with every head an ancestor of the published target branch, the environment holds no unpublished work, so these
   * are leftover objects the removal drops. `unreferencedCount` carries the full number.
   */
  readonly unreferenced?: readonly CustodyTarget[]
  readonly unreferencedCount?: number
}

/** One built witness index: the ranked durable-ref records and the merged OID -> rank file every scan joins against. */
interface BuiltWitnessIndex {
  readonly records: readonly DurableRefRecord[]
  readonly formats: ReadonlyMap<string, string>
  readonly published: ReadonlyArray<Readonly<{ store: string; tip: string; repo: string; remote: string }>>
  readonly unsubtracted: readonly string[]
  readonly nonWitnesses: readonly string[]
  /** 37792 (@cto 2026-11-22): stores whose health `fsck --connectivity-only` covered for this entry, named in it. */
  readonly fsckStores: readonly string[]
  /**
   * 37792 (@cto 78e96f64 part 4): witness stores whose remote names a repository no component belongs to. They cannot
   * witness anything in this pass, so they are named and skipped before their `fsck --full`.
   */
  readonly foreign: readonly string[]
  /** Stores whose repository could not be proved; they keep the proof they always had and are named. */
  readonly unscoped: readonly string[]
  /**
   * 37792 (@cto 2026-11-22 f66720e5): stores whose refs or objects cannot be read. They prove nothing, so they are
   * excluded as witnesses and named with their diagnostic; any head or object only they held stays unproven.
   */
  readonly corrupt: readonly string[]
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

  /**
   * The index for `key`, built by `build` on first use. A failed build is kept for the rest of the phase: every later
   * member with the same key gets the same named unknown at once instead of rebuilding it (the 2026-11-19 05:12 dry
   * run paid ~3.5 min three times for one fsck refusal, #35062). This is deliberately conservative failure memoization,
   * not a claim that a retry would fail alike: refs, objects and graph context can change, so a transient recovery
   * may still leave the rest of this phase unknown, which only keeps more entries. A fresh scope (the held window, a
   * later run) builds again and can see the recovery (@cto 35062-empty-witness-go-0606 §2).
   */
  async witnessIndex(key: string, build: () => Promise<BuiltWitnessIndex>): Promise<BuiltWitnessIndex> {
    const existing = this.builds.get(key)
    if (existing === undefined) {
      const pending = build()
      this.builds.set(key, pending)
      // Marked handled here; each caller still awaits the same rejection.
      pending.catch(() => undefined)
      // 37792 (@cto 2026-11-22 9573ed64): release only a refusal the SHARED deadline cut. That refusal records when the
      // budget ran out, not anything about the stores it read, and the next eligible entry provokes a new build with
      // its own remaining time, resuming from the fragments this one already completed. A genuine store failure stays
      // memoized exactly as before, and no caller retries inside its own slice.
      pending.catch((error: unknown) => {
        if (error instanceof ProofDeadlineError && this.builds.get(key) === pending) this.builds.delete(key)
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

/**
 * 37792 (@cto 93f4ba37, @cto 2026-11-22 ruling): one retirement run's shared verdicts about witness stores. A store's
 * health check and the repository it mirrors are properties of the run, not of the entry being verified, so a batch
 * reads each once and every entry reuses it instead of paying 5 checks of /hh/dev/.git for 5 entries. A refusal is
 * remembered too: it is the same store and the same bytes, and re-running it per entry only spends the budget.
 */
export class CustodyRunScope {
  constructor(
    /**
     * 37854: where this run keeps its content-addressed ref fragments. A batch passes one directory so entry 2 reuses
     * the walk entry 1 already paid for instead of re-walking every durable ref of every witness store.
     */
    readonly fragmentDir?: string,
  ) {}
  readonly identities = new Map<
    string,
    Readonly<{ status: "known"; id: string } | { status: "unknown"; detail: string }>
  >()
  /**
   * 37792 (@cto 2026-11-22 9573ed64): a verdict cut by the SHARED deadline is never published here - it says when the
   * budget ran out, not what the store is, and the next entry has its own remaining time to spend on it.
   */
  readonly fscks = new Map<
    string,
    Readonly<{ ok: true } | { ok: false; detail: string; timedOut?: boolean; deadlineCut?: boolean }>
  >()
  /** 37854: ref fragments by store, format, tip and subtracted set — the walk's result, never a proof decision. */
  readonly fragments = new Map<string, SidecarRef>()
  /** 37854: how many ref walks this pass paid for, and how many a later entry in it reused. */
  readonly fragmentUse = { walked: 0, reused: 0 }
  /**
   * 37792 (@cto turn38-retention-remote): remote advertisements reused inside this pass, keyed by the exact store,
   * configured remote and target branch. The held pass gets its own scope, so a branch that moved is re-read there.
   */
  readonly publishedAdvertisements = new Map<string, PublishedAdvertisement>()
  /** 37792 (@cto turn38-retention-remote): stores whose pin namespace this pass has already populated. */
  readonly populatedPinNamespaces = new Set<string>()
  /**
   * 37854 (@cto turn46-ref-observations): one complete raw ref enumeration per retained copy and worktree Git
   * directory. The scope IS the phase, so the held pass builds a new one and reads refs that moved again; only a
   * complete, successful listing is ever stored.
   */
  readonly refObservations: RefObservations = new Map<string, readonly RefObservationRow[]>()
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

/**
 * 37792 (@cto 2026-11-22 9573ed64): a refusal whose cause was the SHARED proof deadline - the entry's slice or the
 * batch budget - not the command's own bound and not a store refusing to be read. It is a scheduling result: the entry
 * it cut stays unknown, and no later entry may inherit it, because a later entry's remaining time is a different
 * budget. Raised only where the deadline really constrained the read (the dispatch-time clamp, or the throw site's own
 * check), never inferred from message text after the fact.
 */
class ProofDeadlineError extends UnknownError {
  constructor(message: string) {
    super(message)
    this.name = "ProofDeadlineError"
  }
}

/**
 * 37792 (@cto 2026-11-22 f66720e5): an exhausted shared budget keeps the entry unknown; it is never read as one
 * corrupt store, which would let a pass run on evidence it never had time to read. Every deadline refusal in this
 * module names the phrase, so one predicate recognises them all wherever they are raised.
 */
function isDeadlineExhaustion(error: unknown): boolean {
  if (error instanceof ProofDeadlineError) return true
  // The sort and merge helpers raise plain Errors from a running reader; their only deadline message is this phrase.
  return error instanceof Error && error.message.includes("shared proof deadline is exhausted")
}

/**
 * 37792 (@cto 2026-11-22 9573ed64): give a sort or merge helper's deadline refusal the typed classification, so a memo
 * holding it knows this is a scheduling result and not a store's verdict. Every other error passes through untouched.
 */
async function asProofDeadline<T>(work: Promise<T>): Promise<T> {
  try {
    return await work
  } catch (error) {
    if (error instanceof ProofDeadlineError) throw error
    throw isDeadlineExhaustion(error) ? new ProofDeadlineError((error as Error).message) : error
  }
}

/** 34127 (@cto 536e2c15): a store the inventory recorded, gone or no longer a repository when custody read it. */
class VanishedStoreError extends UnknownError {
  constructor(
    readonly gitDir: string,
    message: string,
  ) {
    super(message)
    this.name = "VanishedStoreError"
  }
}

/**
 * 37792 (@cto 2026-11-22 f66720e5): a witness store whose own refs or objects cannot be read. It is not evidence that
 * the environment lost anything, and it proves nothing, so it is excluded by name. A proof limit that refused the
 * store (policy, remote authority, shallow graph) is NOT this class: that keeps the entry unknown as it always did.
 */
class CorruptStoreError extends UnknownError {
  constructor(message: string) {
    super(message)
    this.name = "CorruptStoreError"
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
 * 37792 (@cto 78e96f64 part 4): the repository a store mirrors, as one normalized identity. A witness store may prove
 * custody only for components of the repository it mirrors; the root-repo gitomic mirror that spent 300 s on
 * `fsck --full` for a dev-repo environment in the 2026-11-21 run mirrors no component in it (#34127).
 */
const REMOTE_URL_LINE = /^remote\.([^.\s]+)\.url\s+(.+)$/u

/** One identity for the forms one repository is written in: `git@h:o/r.git`, `ssh://git@h/o/r`, `https://h/o/r`. */
export function normalizeRepoUrl(raw: string): string {
  const trimmed = raw.trim()
  const file = /^file:\/\/(\/.*)$/u.exec(trimmed)
  const scp = /^(?:[^@/\s]+@)([^:/\s]+):(.+)$/u.exec(trimmed)
  const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/(.+)$/iu.exec(trimmed)
  let host = ""
  let path = trimmed
  if (file?.[1] !== undefined) {
    path = file[1]
  } else if (scp?.[1] !== undefined && scp[2] !== undefined) {
    host = scp[1]
    path = scp[2]
  } else if (url?.[1] !== undefined && url[2] !== undefined) {
    host = url[1]
    path = url[2]
  }
  const clean = path
    .replace(/^\/+/u, "")
    .replace(/\.git$/u, "")
    .toLowerCase()
  return `${host.toLowerCase()}/${clean}`
}

/**
 * The repository `gitDir` mirrors, read from every remote URL it declares. Unknown is explicit, never a guess: no
 * remote, an unreadable config, or two remotes naming different repositories all answer `unknown` with the cause.
 */
async function storeRepoIdentity(
  gitDir: string,
  run: GitRun,
  remaining: () => number,
): Promise<Readonly<{ status: "known"; id: string }> | Readonly<{ status: "unknown"; detail: string }>> {
  const timeoutMs = remaining()
  const config = await run(
    [`--git-dir=${gitDir}`, "config", "--get-regexp", String.raw`^remote\..*\.url$`],
    Number.isFinite(timeoutMs) ? { timeoutMs } : {},
  )
  if (config.code === 1 && config.stderr.trim() === "") {
    return { status: "unknown", detail: `${gitDir} declares no remote URL` }
  }
  if (config.code !== 0) {
    return {
      status: "unknown",
      detail: `${gitDir}: its remote URLs could not be read (${config.stderr.trim() || `exit ${String(config.code)}`})`,
    }
  }
  const ids = new Set<string>()
  for (const line of config.stdout.split("\n")) {
    if (line.trim() === "") continue
    const match = REMOTE_URL_LINE.exec(line)
    if (match?.[2] === undefined) {
      return {
        status: "unknown",
        detail: `${gitDir}: unreadable remote config line ${JSON.stringify(line.slice(0, 120))}`,
      }
    }
    ids.add(normalizeRepoUrl(match[2]))
  }
  if (ids.size !== 1) {
    return {
      status: "unknown",
      detail: `${gitDir} declares ${String(ids.size)} distinct remote repositories (${[...ids].sort().join(", ")}), so the repository it mirrors is unknown`,
    }
  }
  return { status: "known", id: [...ids][0] as string }
}

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

/** One store's remote advertisement, read once: the target branch it publishes and how many pins it names. */
type PublishedAdvertisement = Readonly<{ branchTip?: string; pinCount: number }>

/**
 * 37792 (@cto turn38-retention-remote): a target-tip advertisement and a populated pin namespace are DIFFERENT facts.
 * Reading what the remote publishes is one ls-remote; making its pins readable in this store is a fetch, and that
 * fetch has to happen BEFORE the eligible-ref list is enumerated or a pin published since the last read stays
 * invisible to this read. Keeping them apart is what lets the ancestry proof pay for the cheap read alone.
 */
async function advertisePublishedRefs(
  gitDir: string,
  remote: string,
  targetBranch: string,
  run: GitRun,
): Promise<PublishedAdvertisement> {
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
  return { ...(branchTip === undefined ? {} : { branchTip }), pinCount }
}

/**
 * Pins are named by the commit they point at, so fetching them by name is idempotent. 37792 (@cto turn38-retention-remote):
 * this runs BEFORE the eligible-ref list, so the first read of a store already sees a pin published since the last one.
 */
async function fetchPublishedPins(gitDir: string, remote: string, run: GitRun): Promise<void> {
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

/** The target branch is fetched for its objects only, because a custody check must never move the store's own branch. */
async function fetchPublishedTarget(gitDir: string, remote: string, targetBranch: string, run: GitRun): Promise<void> {
  const targetRef = `refs/heads/${targetBranch}`
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

/**
 * 37792 (@cto turn38-retention-remote): an advertisement may be reused only for the same admitted surviving store, the
 * same configured remote, the same target branch and the same pass. The held pass starts a fresh scope, so a branch
 * that moved between passes is read again; a refused or deadline-cut read is never stored, so the next entry still
 * tries with its own budget instead of inheriting the failure.
 */
function publishedAdvertisementKey(gitDir: string, remote: string, targetBranch: string): string {
  return `${gitDir}\u0000${remote}\u0000${targetBranch}`
}

async function observePublishedAdvertisement(
  runScope: CustodyRunScope | undefined,
  gitDir: string,
  remote: string,
  targetBranch: string,
  run: GitRun,
): Promise<PublishedAdvertisement> {
  const key = publishedAdvertisementKey(gitDir, remote, targetBranch)
  const cached = runScope?.publishedAdvertisements.get(key)
  if (cached !== undefined) return cached
  const advertisement = await advertisePublishedRefs(gitDir, remote, targetBranch, run)
  runScope?.publishedAdvertisements.set(key, advertisement)
  return advertisement
}

async function populatePublishedPins(
  runScope: CustodyRunScope | undefined,
  gitDir: string,
  remote: string,
  targetBranch: string,
  advertisement: PublishedAdvertisement,
  run: GitRun,
): Promise<void> {
  if (advertisement.pinCount === 0) return
  const key = publishedAdvertisementKey(gitDir, remote, targetBranch)
  if (runScope?.populatedPinNamespaces.has(key) === true) return
  await fetchPublishedPins(gitDir, remote, run)
  runScope?.populatedPinNamespaces.add(key)
}

/**
 * 37792 (@cto turn38-retention-remote): an advertisement proves custody only when that exact commit is readable in the
 * same surviving store. When it is absent, fetch the target branch's objects without moving the branch and verify the
 * advertised SHA again - a branch that moved between listing and fetching cannot silently substitute a different tip.
 */
async function requirePublishedTipReadable(
  gitDir: string,
  remote: string,
  targetBranch: string,
  tip: string,
  run: GitRun,
): Promise<void> {
  const present = await run([`--git-dir=${gitDir}`, "cat-file", "-e", `${tip}^{commit}`])
  if (present.code === 0 && present.stderr.trim() === "") return
  await fetchPublishedTarget(gitDir, remote, targetBranch, run)
  const verified = await run([`--git-dir=${gitDir}`, "cat-file", "-e", `${tip}^{commit}`])
  if (verified.code !== 0 || verified.stderr.trim() !== "") {
    throw new UnknownError(
      `witness store ${gitDir}: its remote ${remote} advertises ${tip} for refs/heads/${targetBranch}, but that commit is still unreadable after fetching it, so its custody is unknown`,
    )
  }
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
): Promise<{ status: "ok"; format: string } | { status: "unknown"; detail: string; vanished?: string }> {
  const result = await run([`--git-dir=${gitDir}`, "rev-parse", "--show-object-format"])
  refuseSuccessfulStderr(result, `rev-parse --show-object-format in ${gitDir}`)
  if (result.code !== 0) {
    const detail = `rev-parse --show-object-format failed in ${gitDir}: ${result.stderr.trim()}`
    // 34127 (@cto 536e2c15): the inventory listed this store and it is gone now. That is a moving estate, not a verdict.
    const gone =
      !existsSync(gitDir) || /not a git repository|does not exist|No such file or directory/u.test(result.stderr)
    return gone ? { status: "unknown", detail, vanished: gitDir } : { status: "unknown", detail }
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
): AsyncGenerator<string> {
  let malformed: UnknownError | undefined
  for await (const line of stream.lines) {
    if (malformed !== undefined) continue
    const oid = line.split(" ")[0]
    if (oid === undefined || !HEX40.test(oid)) {
      malformed = new CorruptStoreError(`malformed rev-list row for ${tip} in ${gitDir}: ${line.slice(0, 120)}`)
      continue
    }
    yield oid
  }
  // Await only after draining: the producer can otherwise be paused at its queue bound.
  const outcome = await stream.outcome
  // 37792 (@cto 2026-11-22 9573ed64): which budget killed the child is decided at dispatch, where the proof factory
  // clamped its timeout, and arrives here as `sharedDeadlineCut` - never re-derived from the clock now (#34920: two
  // measurement runs reported the 300 s bound for a deadline kill).
  const deadlineCut = outcome.sharedDeadlineCut === true
  try {
    assertStreamComplete(outcome, {
      timedOut: deadlineCut
        ? `shared proof deadline is exhausted during rev-list ${tip} in ${gitDir}`
        : `rev-list ${tip} in ${gitDir} exceeded the ${bounds.reachableMs} ms bound`,
      capped: `reachable OIDs exceeded the ${bounds.maxReachableOids} cap in ${gitDir}`,
      failed: `rev-list ${tip} failed in witness store ${gitDir}: ${outcome.stderr.trim()}`,
      warned: `rev-list ${tip} in ${gitDir} exited 0 with stderr: ${outcome.stderr.trim()}`,
    })
  } catch (error) {
    throw deadlineCut && error instanceof IncompleteStreamError && error.fault === "timedOut"
      ? new ProofDeadlineError(error.message)
      : error
  }
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
async function worktreeGone(gitDir: string, run: GitRun, options: GitRunOptions = {}): Promise<boolean> {
  const configured = await run(["config", "--file", join(gitDir, "config"), "--get", "core.worktree"], options)
  refuseSuccessfulStderr(configured, `config --get core.worktree in ${gitDir}`)
  // 37792 (@cto turn44): this is the first command of a head census. A child the caller's shared budget killed is a
  // scheduling result named as the deadline, never a store that refused to be read.
  if (configured.timedOut === true) {
    throw new UnknownError(`core.worktree read in ${gitDir} was cut by the shared proof deadline`)
  }
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

/**
 * 37854 (@cto 283fabfc, @dev/6 46063009): the most earlier-ranked tips one walk subtracts before it stops subtracting.
 * It bounds the `--not` list and nothing else: a tip past the bound is simply not excluded, so the emitted OBJECT SET
 * can only grow, never shrink. Every object still arrives from some ref, and the labeled merge attributes it to the
 * earliest-ranked witness that reached it, so witness set and missing set are unchanged.
 *
 * A larger fragment is not free, and this comment previously overclaimed that it was. A wider walk can cross
 * `maxReachableOids` or `reachableMs` where a narrower one would not; that walk is then refused, the entry is kept as
 * unknown, and nothing is mis-retired. That is the honest bound: 1024 changed 0 of 2,057 recorded emitted sets on two
 * runs (4096->256 changed 12) for 16-18% of child time inside a ~3% run-to-run spread, and no walk in the recording
 * crossed either bound. A larger fragment costs proof margin, not correctness.
 */
const MAX_SUBTRACTED_TIPS = 1024

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
export async function reachableSidecar(
  gitDir: string,
  tip: string,
  subtract: readonly string[],
  stream: GitStreamFactory,
  bounds: CustodyBounds,
  clock: () => number,
  sidecarDir: string,
  deadline: number | undefined,
  runScope?: CustodyRunScope,
): Promise<SidecarRef> {
  // 37854: a walk's answer depends only on the store's bytes, the tip and the subtracted set — never on which entry is
  // being proved. A batch therefore keeps each fragment once and every later entry reuses it, verifying the file is
  // still the one this ref names before trusting it.
  const cacheKey = `${gitDir}\u0000${tip}\u0000${subtract.join(",")}`
  const cached = runScope?.fragments.get(cacheKey)
  if (cached !== undefined && statSync(cached.path, { throwIfNoEntry: false })?.size === cached.bytes) {
    if (runScope !== undefined) runScope.fragmentUse.reused += 1
    return cached
  }
  if (runScope !== undefined) runScope.fragmentUse.walked += 1
  const started = clock()
  // --ignore-missing drops a subtracted tip this store lacks; dropping one only repeats objects, never loses one.
  const args =
    subtract.length === 0
      ? [`--git-dir=${gitDir}`, "rev-list", "--objects", tip]
      : [`--git-dir=${gitDir}`, "rev-list", "--objects", "--ignore-missing", tip, "--not", ...subtract]
  const lineStream = stream(args, { timeoutMs: bounds.reachableMs, maxLines: bounds.maxReachableOids })
  const sidecar = await asProofDeadline(
    externalSortToSidecar(reachableOidLines(lineStream, gitDir, tip, bounds), {
      dir: runScope?.fragmentDir ?? sidecarDir,
      runLines: DEFAULT_SORT_RUN_LINES,
      deadline,
      clock,
    }),
  )
  // Only a completed walk is a fragment: a partial one is never cached, so it cannot be reused as custody evidence.
  if (deadline !== undefined && clock() >= deadline) throw new ProofDeadlineError("shared proof deadline is exhausted")
  if (clock() - started > bounds.reachableMs) {
    throw new UnknownError(`rev-list ${tip} in ${gitDir} exceeded the ${bounds.reachableMs} ms bound`)
  }
  runScope?.fragments.set(cacheKey, sidecar)
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

/**
 * 37792 (@cto 8288868d): one witness store's OWN reads, with nothing shared mutated. Two of these run at once, and the
 * ordered consumer in `indexWitnessStores` applies the answers in rank order, so subtraction and witness choice stay
 * deterministic while the per-store subprocess fan-out (config, ref listing, identity, connectivity) overlaps.
 */
type WitnessStoreRead =
  /**
   * 34127 (@cto turn58): `fsckMs` is the span the read had already spent when it died, so a cut inside its fsck is not
   * reported as 0. Absent when the read died before the fsck started (or outside it).
   */
  | { readonly kind: "fatal"; readonly error: unknown; readonly fsckMs?: number }
  | { readonly kind: "corrupt"; readonly gitDir: string; readonly detail: string }
  | { readonly kind: "foreign"; readonly detail: string }
  | { readonly kind: "nonWitness"; readonly gitDir: string }
  | {
      readonly kind: "ready"
      readonly gitDir: string
      readonly detached: boolean
      readonly format: string
      readonly selected: readonly WitnessRef[]
      readonly plain: boolean
      /** Non-empty when this store's traversal is not plain and it was walked without cross-store subtraction. */
      readonly unsubtracted: string
      readonly unscoped?: string
      readonly published?: Readonly<{ store: string; tip: string; repo: string; remote: string }>
      /** True when `fsck --connectivity-only` covered this store for the entry. */
      readonly fsck: boolean
      readonly fsckMs: number
    }

async function readWitnessStore(
  store: string,
  run: GitRun,
  bounds: CustodyBounds,
  removal: readonly string[],
  witnessPolicy: Readonly<{ targetBranch: string }> | undefined,
  componentRepos: Readonly<{ ids: ReadonlySet<string>; complete: boolean }> | undefined,
  skipFsck: boolean,
  skipFsckRepos: ReadonlySet<string>,
  runScope: CustodyRunScope | undefined,
  deadline: number | undefined,
  clock: () => number,
): Promise<WitnessStoreRead> {
  const gitDir = dirname(store)
  // 34127 (@cto turn58): held outside the `try` so the catch can still report the fsck time a cut read had spent.
  let fsckMs = 0
  try {
    // The same invocation deadline bounds a read that is running: a spent budget refuses before another child spawns.
    if (deadline !== undefined && clock() >= deadline) {
      throw new ProofDeadlineError("shared proof deadline is exhausted")
    }
    // #34920: a witness store whose recorded core.worktree is gone is read detached (see worktreeGone).
    const detached = await worktreeGone(gitDir, run)
    const storeRun = atStore(run, gitDir, detached)
    const format = await objectFormat(gitDir, storeRun)
    if (format.status !== "ok") {
      if (format.vanished !== undefined) throw new VanishedStoreError(format.vanished, format.detail)
      throw new UnknownError(format.detail)
    }
    const closureResult = alternateClosure(store, removal)
    if (closureResult.status !== "ok") throw new UnknownError(closureResult.detail)
    // 37792 (@cto 78e96f64 part 4): a store proves custody only for components of the repository it mirrors. A store
    // whose remote names another repository cannot witness any of them, so it is named and skipped BEFORE its
    // connectivity check. Exclusion can only keep more entries, never free one wrongly.
    const remainingHere = (): number => (deadline === undefined ? Number.POSITIVE_INFINITY : deadline - clock())
    const identity = await identityOf(runScope, gitDir, storeRun, remainingHere)
    const repo = identity.status === "known" ? identity.id : undefined
    if (
      identity.status === "known" &&
      componentRepos !== undefined &&
      componentRepos.complete &&
      !componentRepos.ids.has(identity.id)
    ) {
      return { kind: "foreign", detail: `${gitDir} (mirrors ${identity.id}, which no component belongs to)` }
    }
    const unscoped = identity.status === "unknown" ? `${gitDir} (${identity.detail})` : undefined
    // What the remote publishes now, never this store's possibly days-old copy of it, and never a mirror ref that was
    // not confirmed against its remote (@cto 78e96f64 part 2). Remote refresh stays on the plain runner, never the
    // detached one (@cto 34920-residual-existing-scope-1626).
    let publishedBranchTip: string | undefined
    let publishedEntry: Readonly<{ store: string; tip: string; repo: string; remote: string }> | undefined
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
      const remote = await configuredRemote(gitDir, run)
      if (remote !== undefined) {
        const advertisement = await observePublishedAdvertisement(
          runScope,
          gitDir,
          remote,
          witnessPolicy.targetBranch,
          run,
        )
        // 37792 (@cto turn38-retention-remote): populate the pin namespace BEFORE the eligible-ref list below, or a pin
        // published since the previous read stays invisible to this one.
        await populatePublishedPins(runScope, gitDir, remote, witnessPolicy.targetBranch, advertisement, run)
        publishedBranchTip = advertisement.branchTip
        if (advertisement.branchTip !== undefined) {
          await requirePublishedTipReadable(gitDir, remote, witnessPolicy.targetBranch, advertisement.branchTip, run)
          publishedEntry = {
            store,
            tip: advertisement.branchTip,
            // A store whose own repository is unproved cannot fix which components its tip proves (@cto 78e96f64).
            repo: repo ?? "",
            remote,
          }
        }
      }
    }
    // #35062 (@cto 34920-shared-index-ruling-1931 §1): retention reads object types too, so both policies walk only
    // independent commit tips plus every noncommit ref. 37792 (@cto turn38-retention-remote): this read happens AFTER
    // the pin namespace is populated, so a freshly published pin is eligible on the same pass.
    const refs = await storeRun([
      `--git-dir=${gitDir}`,
      "for-each-ref",
      "--format=%(refname)%09%(objectname)%09%(objecttype)",
    ])
    refuseSuccessfulStderr(refs, `for-each-ref in witness store ${gitDir}`)
    if (refs.code !== 0) {
      throw new CorruptStoreError(`for-each-ref failed in witness store ${gitDir}: ${refs.stderr.trim()}`)
    }
    const listed: WitnessRef[] = []
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
        throw new CorruptStoreError(`malformed for-each-ref row in witness store ${gitDir}: ${row.slice(0, 120)}`)
      }
      listed.push({ ref, tip, objectType })
    }
    // A transient operation ref, remote-tracking ref or detached HEAD is never a durable
    // witness: only a named branch, tag or GitSuper pin qualifies (contract gate 5).
    const durable: WitnessRef[] = listed.filter((entry) =>
      witnessPolicy === undefined
        ? isDurableRef(entry.ref)
        : isPolicyRef(entry.ref, entry.tip, witnessPolicy.targetBranch),
    )
    if (witnessPolicy !== undefined && publishedBranchTip !== undefined) {
      const targetRef = `refs/heads/${witnessPolicy.targetBranch}`
      if (!durable.some((entry) => entry.ref === targetRef && entry.tip === publishedBranchTip)) {
        // The published tip is a durable name for the same ref even though no local ref names it yet.
        durable.push({ ref: targetRef, tip: publishedBranchTip, objectType: "commit" })
      }
    }
    durable.sort((left, right) => (left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0))
    // #35062 (@cto 35062-empty-witness-go-0606 §1): a store that admits no durable root can witness nothing, so it is
    // named and skipped before its connectivity check; it supplies no fragment, certificate, subtraction tip or rebase
    // root, and stays in every estate, owner and delta fact.
    if (durable.length === 0) return { kind: "nonWitness", gitDir }
    let fsck = false
    // 37792 (@cto 2026-11-22): the witness proof asks whether this environment's objects survive, not whether every
    // blob parses, so store health is `fsck --connectivity-only`. The entry-relevant proof is the head closure below.
    if (!skipFsck && (repo === undefined || !skipFsckRepos.has(repo))) {
      fsck = true
      let verdict = runScope?.fscks.get(gitDir)
      if (verdict === undefined) {
        // No child outlives the budget the read was started under.
        if (deadline !== undefined && clock() >= deadline) {
          throw new ProofDeadlineError("shared proof deadline is exhausted")
        }
        const fsckStarted = clock()
        const result = await storeRun([`--git-dir=${gitDir}`, "fsck", "--connectivity-only", "--no-progress"], {
          timeoutMs: bounds.fsckMs,
        })
        fsckMs = clock() - fsckStarted
        // 37792 (@cto 2026-11-22): a missing object is named from stdout, where `fsck --connectivity-only` reports it.
        const broken = result.stdout
          .split("\n")
          .filter((line) => /^(?:missing|broken|error)\b/u.test(line))
          .slice(0, MISSING_INLINE)
        verdict =
          // A child this runner killed did not answer, whatever code it was reported with; only a complete read is ok.
          result.code === 0 && result.stderr.trim() === "" && result.timedOut !== true
            ? { ok: true }
            : {
                ok: false,
                // A kill the shared deadline ordered is named as the schedule, never as a failure of the store.
                detail:
                  result.sharedDeadlineCut === true
                    ? `shared proof deadline is exhausted during fsck --connectivity-only in witness store ${gitDir}`
                    : `fsck --connectivity-only failed in witness store ${gitDir}: ${result.stderr.trim() || broken.join("; ") || "exit " + String(result.code)}`,
                timedOut: result.timedOut === true,
                ...(result.sharedDeadlineCut === true ? { deadlineCut: true } : {}),
              }
        // 37792 (@cto 2026-11-22 9573ed64): publish only an answer about the store. A health check the shared deadline
        // cut says when the budget ran out, so it is not remembered - the next entry spends its own remaining time.
        if (!("deadlineCut" in verdict)) runScope?.fscks.set(gitDir, verdict)
      }
      // A store killed at its own fsck bound is a proof limit, not corruption; only an answer that reports objects it
      // cannot read excludes the store.
      if (!verdict.ok) {
        if (verdict.deadlineCut === true) throw new ProofDeadlineError(verdict.detail)
        throw verdict.timedOut === true ? new UnknownError(verdict.detail) : new CorruptStoreError(verdict.detail)
      }
    }
    const selected = await independentRefs(durable, gitDir, storeRun)
    const context = await traversalContext(gitDir, refs.stdout.split("\n"), storeRun, witnessPolicy)
    return {
      kind: "ready",
      gitDir,
      detached,
      format: format.format,
      selected,
      plain: context.plain,
      unsubtracted:
        !context.plain && selected.length > 0 ? `${gitDir} (${context.reason ?? "traversal not plain"})` : "",
      ...(unscoped === undefined ? {} : { unscoped }),
      ...(publishedEntry === undefined ? {} : { published: publishedEntry }),
      fsck,
      fsckMs,
    }
  } catch (error) {
    if (error instanceof CorruptStoreError) return { kind: "corrupt", gitDir, detail: error.message }
    return { kind: "fatal", error, fsckMs }
  }
}

/**
 * 34127 (@cto e8f6c3b5): the phase a store walk is inside is emitted on ENTRY, and both spans are reported from a
 * finally, so a walk cut by the shared deadline names witnessFsck or refGraph with the time it had spent instead of
 * reporting nothing. Before this, a starved entry completed no phase and proofPhases came out empty (anc23).
 */
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
  componentRepos?: Readonly<{ ids: ReadonlySet<string>; complete: boolean }>,
  skipFsck = false,
  skipFsckRepos: ReadonlySet<string> = new Set<string>(),
  runScope?: CustodyRunScope,
  onPhaseEnter?: (name: string) => void,
  onPhaseSpend?: (name: string, ms: number) => void,
  /** 37854: the subtraction bound, threaded from {@link CustodyScanOptions.maxSubtractedTips}. */
  maxSubtractedTips = MAX_SUBTRACTED_TIPS,
): Promise<Awaited<ReturnType<typeof indexWitnessStoresReported>>> {
  const phaseStats = { witnessFsckMs: 0, refGraphMs: 0, refGraphEntered: false }
  onPhaseEnter?.("witnessFsck")
  try {
    return await indexWitnessStoresReported(
      stores,
      removal,
      stream,
      run,
      bounds,
      clock,
      sidecarDir,
      witnessPolicy,
      deadline,
      onPhase,
      componentRepos,
      skipFsck,
      skipFsckRepos,
      runScope,
      phaseStats,
      onPhaseEnter,
      maxSubtractedTips,
    )
  } finally {
    onPhase?.("witnessFsck", phaseStats.witnessFsckMs)
    if (phaseStats.refGraphEntered) onPhase?.("refGraph", phaseStats.refGraphMs)
    // 34127 (@cto turn60): the durations, not the windows, are what a reader can add up: the fsck window stays open
    // under the graph walk, so reporting both windows would count the graph twice.
    onPhaseSpend?.("witnessFsck", phaseStats.witnessFsckMs)
    if (phaseStats.refGraphEntered) onPhaseSpend?.("refGraph", phaseStats.refGraphMs)
  }
}

async function indexWitnessStoresReported(
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
  /** 37792 part 4: the repositories this pass's components belong to, when every one of them is known. */
  componentRepos?: Readonly<{ ids: ReadonlySet<string>; complete: boolean }>,
  /**
   * 37792 part 2: ancestry already proves every component, so no witness is used and no store is fscked. A store whose
   * graph cannot be read then contributes no ref rather than an unknown, because nothing joins against it.
   */
  skipFsck = false,
  /** 37792 part 3: repositories ancestry already proved; a store mirroring only these is not fscked. */
  skipFsckRepos: ReadonlySet<string> = new Set<string>(),
  /** 37792 (@cto 93f4ba37): one fsck verdict per store per run, reused by every entry of a batch. */
  runScope?: CustodyRunScope,
  /** 34127: the spans this call accumulates, reported by the wrapper even when the walk is cut. */
  phaseStats: { witnessFsckMs: number; refGraphMs: number; refGraphEntered: boolean } = {
    witnessFsckMs: 0,
    refGraphMs: 0,
    refGraphEntered: false,
  },
  onPhaseEnter?: (name: string) => void,
  /** 37854: how many earlier-ranked tips one walk may subtract; the fixture proves a smaller bound keeps the witnesses. */
  maxSubtractedTips = MAX_SUBTRACTED_TIPS,
): Promise<{
  records: DurableRefRecord[]
  formats: Map<string, string>
  published: ReadonlyArray<Readonly<{ store: string; tip: string; repo: string; remote: string }>>
  /** Stores whose traversal is not plain, so their refs were walked without cross-store subtraction, and why. */
  unsubtracted: readonly string[]
  nonWitnesses: readonly string[]
  /** 37792 (@cto 2026-11-22): stores whose health `fsck --connectivity-only` covered for this entry, named in it. */
  readonly fsckStores: readonly string[]
  /** 37792 part 4: stores mirroring no component's repository, skipped before their fsck, and why refused. */
  foreign: readonly string[]
  /** Stores whose repository could not be proved; named, with the cause, because they keep the old proof. */
  unscoped: readonly string[]
  /** 37792 (@cto 2026-11-22): stores that cannot be read, named with their diagnostic and excluded as witnesses. */
  readonly corrupt: readonly string[]
}> {
  const records: DurableRefRecord[] = []
  const fsckStores: string[] = []
  const prior: Array<Readonly<{ store: string; tip: string; plain: boolean }>> = []
  const unsubtracted: string[] = []
  const nonWitnesses: string[] = []
  const foreign: string[] = []
  const unscoped: string[] = []
  const corrupt: string[] = []
  const formats = new Map<string, string>()
  const published: Array<Readonly<{ store: string; tip: string; repo: string; remote: string }>> = []
  // 37792 (@cto 8288868d): two independent witness stores are read at once, and only store-local work runs in
  // parallel. Rank order, subtraction, fragment publication, witness choice and failure isolation all stay in this
  // one consumer, so the ordered custody result is the same as a sequential build.
  // Two stores is the shipped window (@cto 8288868d). The environment override exists so a test can compare one store
  // in flight with two on the same fixture; production never sets it.
  const readAheadSetting = Number(process.env.GIT_SUPER_WITNESS_READ_AHEAD ?? "2")
  const readAhead =
    Number.isInteger(readAheadSetting) && readAheadSetting >= 1 && readAheadSetting <= 4 ? readAheadSetting : 2
  const inFlight = new Map<number, Promise<WitnessStoreRead>>()
  const deadlinePassed = (): boolean => deadline !== undefined && clock() >= deadline
  const startRead = (index: number): void => {
    if (index >= stores.length || inFlight.has(index) || deadlinePassed()) return
    const store = stores[index]
    if (store === undefined) return
    inFlight.set(
      index,
      readWitnessStore(
        store,
        run,
        bounds,
        removal,
        witnessPolicy,
        componentRepos,
        skipFsck,
        skipFsckRepos,
        runScope,
        deadline,
        clock,
      ).catch((error: unknown): WitnessStoreRead => ({ kind: "fatal", error })),
    )
  }
  startRead(0)
  startRead(1)
  for (let index = 0; index < stores.length; index += 1) {
    const store = stores[index]
    if (store === undefined) continue
    const gitDir = dirname(store)
    const waiting = inFlight.get(index)
    inFlight.delete(index)
    // An expired budget launches nothing further; the entry keeps a named reason instead of a silent gap.
    if (waiting === undefined) throw new ProofDeadlineError("shared proof deadline is exhausted")
    const read = await waiting
    if (read.kind === "fatal") {
      // 34127 (@cto turn58): a read cut inside its fsck still contributes the time that fsck had spent, so the aggregate
      // proofPhases names a real cost instead of 0 for the very phase the deadline landed in.
      if (read.fsckMs !== undefined) phaseStats.witnessFsckMs += read.fsckMs
      throw read.error
    }
    if (read.kind === "corrupt") {
      // 37792 (@cto 2026-11-22 f66720e5): a store that cannot be read is no witness. Excluding it can only keep more
      // entries, never free one wrongly: it contributes no ref, fragment, certificate or tip.
      corrupt.push(`${read.gitDir} (${read.detail})`)
      startRead(index + readAhead)
      continue
    }
    if (read.kind === "foreign") {
      foreign.push(read.detail)
      startRead(index + readAhead)
      continue
    }
    if (read.kind === "nonWitness") {
      nonWitnesses.push(read.gitDir)
      startRead(index + readAhead)
      continue
    }
    const mark = {
      records: records.length,
      prior: prior.length,
      published: published.length,
      unsubtracted: unsubtracted.length,
      fsckStores: fsckStores.length,
      foreign: foreign.length,
      unscoped: unscoped.length,
    }
    formats.set(store, read.format)
    if (read.unscoped !== undefined) unscoped.push(read.unscoped)
    if (read.fsck) fsckStores.push(read.gitDir)
    if (read.unsubtracted !== "") unsubtracted.push(read.unsubtracted)
    if (read.published !== undefined) published.push(read.published)
    phaseStats.witnessFsckMs += read.fsckMs
    const storeStream = atStoreStream(stream, gitDir, read.detached)
    // 34127 (@cto turn60): anchored outside the try so a walk cut mid-way still reports the time it spent.
    let graphStarted: number | undefined
    try {
      if (!phaseStats.refGraphEntered) {
        phaseStats.refGraphEntered = true
        onPhaseEnter?.("refGraph")
      }
      graphStarted = clock()
      for (const entry of read.selected) {
        // #34920 A3: subtract earlier-ranked tips whose closure this store's walk computes exactly as their own store
        // did: always this store's own earlier refs; another store's only when both traversals are plain. The object
        // set each ref emits shrinks, but the minimum-rank ref reaching an OID still emits it (none of its subtracted
        // tips are earlier-ranked reachers), so the labeled merge picks the same witness as a full walk.
        const subtract: string[] = []
        const seen = new Set<string>()
        for (
          let earlierIndex = prior.length - 1;
          earlierIndex >= 0 && subtract.length < maxSubtractedTips;
          earlierIndex -= 1
        ) {
          const earlier = prior[earlierIndex]
          if (earlier === undefined) continue
          if (earlier.store !== store && !(earlier.plain && read.plain)) continue
          if (seen.has(earlier.tip)) continue
          seen.add(earlier.tip)
          subtract.push(earlier.tip)
        }
        // 37792 (@cto f66720e5): a walk this store cannot finish is the store's own unreadability, so the store is
        // excluded by name; an expired budget is not, and keeps the entry unknown.
        let fragment: SidecarRef
        try {
          fragment = await reachableSidecar(
            gitDir,
            entry.tip,
            subtract,
            storeStream,
            bounds,
            clock,
            sidecarDir,
            deadline,
            runScope,
          )
        } catch (error) {
          if (isDeadlineExhaustion(error)) throw error
          // A child that failed to read is a store that cannot be read. A deadline, a cap or an exit-0 warning is a proof
          // limit, and keeps the entry unknown exactly as it always did.
          if (error instanceof UnknownError || (error instanceof IncompleteStreamError && error.fault === "failed")) {
            throw new CorruptStoreError(`${gitDir}: ${error.message}`)
          }
          throw error
        }
        records.push({
          store,
          gitDir,
          ref: entry.ref,
          tip: entry.tip,
          format: read.format,
          fragment,
          complete: subtract.length === 0,
          detached: read.detached,
        })
        prior.push({ store, tip: entry.tip, plain: read.plain })
      }
    } catch (error) {
      // A proof limit that refused the store (policy, remote authority, shallow graph, an expired budget) keeps the
      // entry unknown; only a store that cannot be read is excluded.
      if (!(error instanceof CorruptStoreError)) throw error
      records.length = mark.records
      prior.length = mark.prior
      published.length = mark.published
      unsubtracted.length = mark.unsubtracted
      fsckStores.length = mark.fsckStores
      foreign.length = mark.foreign
      unscoped.length = mark.unscoped
      formats.delete(store)
      corrupt.push(`${gitDir} (${error.message})`)
    } finally {
      if (graphStarted !== undefined) phaseStats.refGraphMs += clock() - graphStarted
    }
    startRead(index + readAhead)
  }
  return {
    records,
    formats,
    published,
    unsubtracted,
    nonWitnesses,
    fsckStores,
    foreign,
    unscoped,
    corrupt,
  }
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
function vanishedDetail(stores: ReadonlyArray<string>): string {
  if (stores.length === 0) return ""
  const shown = stores.slice(0, 5).join(", ")
  const more = stores.length > 5 ? ` and ${String(stores.length - 5)} more` : ""
  return `; ${String(stores.length)} witness store(s) gone since the estate scan, not used as witnesses: ${shown}${more}`
}

/** 37792 (@cto 2026-11-22): the store-health command and count the receipt carries beside the head closure. */
function storeHealthDetail(stores: ReadonlyArray<string>): string {
  return stores.length === 0 ? "" : `; store health: fsck --connectivity-only ok on ${String(stores.length)} store(s)`
}

/** 37792 (@cto 2026-11-22): the entry-relevant closure check, named with its command and counts. */
function closureDetail(notes: ReadonlyArray<string>): string {
  return notes.length === 0 ? "" : `; head closure checked with rev-list --objects --missing=print: ${notes.join("; ")}`
}

/** 37792 part 4: stores skipped because they mirror no component's repository, named with the repository they do. */
function foreignDetail(stores: ReadonlyArray<string>): string {
  if (stores.length === 0) return ""
  const shown = stores.slice(0, 5).join(", ")
  const more = stores.length > 5 ? ` and ${String(stores.length - 5)} more` : ""
  return `; ${String(stores.length)} witness store(s) mirror no component repository and witness nothing here; fsck not run: ${shown}${more}`
}

/** 37792 (@cto 2026-11-22): an unreadable store is excluded as a witness, and named with the diagnostic that refused it. */
function corruptDetail(stores: ReadonlyArray<string>): string {
  if (stores.length === 0) return ""
  const shown = stores.slice(0, 5).join(", ")
  const more = stores.length > 5 ? ` and ${String(stores.length - 5)} more` : ""
  return `; ${String(stores.length)} unreadable witness store(s) excluded (they prove nothing, so any head or object only they held stays unproven): ${shown}${more}`
}

/** 37854: the phase split the receipt must name — ref walks this pass paid for, and the ones a later entry reused. */
function fragmentUseDetail(scope: CustodyRunScope | undefined): string {
  if (scope === undefined) return ""
  const { walked, reused } = scope.fragmentUse
  if (walked + reused === 0) return ""
  return `; reachability fragments this pass: ${String(walked)} walk(s) paid, ${String(reused)} reused by a later entry`
}

/** 37792 part 4: stores whose repository could not be proved. They keep the old proof and are named, never silent. */
function unscopedDetail(stores: ReadonlyArray<string>): string {
  if (stores.length === 0) return ""
  const shown = stores.slice(0, 5).join(", ")
  const more = stores.length > 5 ? ` and ${String(stores.length - 5)} more` : ""
  return `; ${String(stores.length)} witness store(s) whose repository is unproved kept their witness role: ${shown}${more}`
}

function nonWitnessDetail(stores: ReadonlyArray<string>): string {
  if (stores.length === 0) return ""
  const shown = stores.slice(0, 5).join(", ")
  const more = stores.length > 5 ? ` and ${String(stores.length - 5)} more` : ""
  return `; ${String(stores.length)} witness store(s) with no admitted durable refs; fsck not run: ${shown}${more}`
}

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

/**
 * 37455-A: are all of this environment's heads ancestors of the published target tip? `ancestors` is custody by
 * reachability; `ahead` keeps the witness and patch proofs; anything unreadable is `unknown` with the exact cause, so
 * a ref this rule cannot read is retained rather than guessed at (@cto 29f8631c).
 *
 * 37792 (@cto turn36-retention-ruling part 2): the proof runs in the ADMITTED SURVIVING WITNESS STORE, never in the
 * retained copy. A copy captured weeks ago cannot contain a tip published after it was captured, so requiring the tip
 * there would make every real entry unprovable by construction. `gitDir` is the retained copy: it is named in a refusal
 * so the reader knows what was kept, and it is never read here. The witness store must still answer for the tip and the
 * heads, and the existing object-closure read stays the second condition.
 */
async function headsAreAncestors(
  gitDir: string,
  heads: readonly string[],
  tip: string,
  storeGitDir: string,
  run: GitRun,
  remaining: () => number,
): Promise<Readonly<{ status: "ancestors" | "ahead" }> | Readonly<{ status: "unknown"; detail: string }>> {
  const budget = (): Readonly<{ timeoutMs?: number }> => {
    const left = remaining()
    return Number.isFinite(left) ? { timeoutMs: left } : {}
  }
  // 37792 (@cto 78e96f64 part 2): the tip must exist in the store that claims it before any ancestry runs; a mirror
  // that never fetched its own published tip is not a witness for it.
  const inStore = await run([`--git-dir=${storeGitDir}`, "cat-file", "-e", `${tip}^{commit}`], budget())
  if (inStore.code !== 0 || inStore.stderr.trim() !== "") {
    return {
      status: "unknown",
      detail: `published target commit ${tip} is not readable in witness store ${storeGitDir} (${inStore.stderr.trim() || `exit ${String(inStore.code)}`}); custody by reachability cannot be proven`,
    }
  }
  for (const head of [...heads].sort()) {
    // The exact retained head is established in the copy that holds it; a copy that cannot read its own head refuses.
    // `rev-parse --verify --quiet` separates "absent" (exit 1, no output) from an unreadable store, which `cat-file -e`
    // cannot: a missing object there exits 128 with stderr, which would read as a store failure.
    const inCopy = await run([`--git-dir=${gitDir}`, "rev-parse", "--verify", "--quiet", `${head}^{commit}`], budget())
    if (inCopy.code !== 0 || inCopy.stdout.trim() === "" || inCopy.stderr.trim() !== "") {
      return {
        status: "unknown",
        detail: `component head ${head} in retained copy ${gitDir} answered ${String(inCopy.code)} (${inCopy.stderr.trim() || "no output"}); an unreadable head is retained, never proven`,
      }
    }
    // Ancestry is asked in the witness store, so the head must be readable there. Cleanly absent means this store
    // simply does not hold the head: reachability cannot certify it, the witness and patch proofs still decide.
    const inWitness = await run(
      [`--git-dir=${storeGitDir}`, "rev-parse", "--verify", "--quiet", `${head}^{commit}`],
      budget(),
    )
    if (inWitness.code === 1 && inWitness.stderr.trim() === "") return { status: "ahead" }
    if (inWitness.code !== 0 || inWitness.stdout.trim() === "" || inWitness.stderr.trim() !== "") {
      return {
        status: "unknown",
        detail: `component head ${head} of retained copy ${gitDir} in witness store ${storeGitDir} answered ${String(inWitness.code)} (${inWitness.stderr.trim() || "no output"}); an unreadable head is retained, never proven`,
      }
    }
    const answer = await run([`--git-dir=${storeGitDir}`, "merge-base", "--is-ancestor", head, tip], budget())
    if (answer.stderr.trim() !== "" || (answer.code !== 0 && answer.code !== 1)) {
      return {
        status: "unknown",
        detail: `component head ${head} of retained copy ${gitDir}: merge-base --is-ancestor ${head} ${tip} in witness store ${storeGitDir} answered ${String(answer.code)} (${answer.stderr.trim() || "no stderr"}); an unreadable head is retained, never proven`,
      }
    }
    if (answer.code === 1) return { status: "ahead" }
  }
  return { status: "ancestors" }
}

/**
 * 37792 (@cto 2026-11-22): the question gate 5 asks is whether this environment's objects survive deleting it, and
 * store-wide connectivity does not answer it. Every object reachable from the component's heads must be present in the
 * witness store that would be relied on. Any `missing` report from this read or from the store-health check keeps the
 * entry as unknown with the oid named; a race with a repack costs a retry next run, never a deletion.
 */
async function headsPresentInWitness(
  storeGitDir: string,
  heads: readonly string[],
  run: GitRun,
  remaining: () => number,
): Promise<
  Readonly<{ status: "present"; objects: number }> | Readonly<{ status: "missing"; missing: readonly string[] }>
> {
  const left = remaining()
  const result = await run(
    [`--git-dir=${storeGitDir}`, "rev-list", "--objects", "--missing=print", ...[...heads].sort()],
    Number.isFinite(left) ? { timeoutMs: left } : {},
  )
  const missing: string[] = []
  let objects = 0
  for (const line of result.stdout.split("\n")) {
    if (line === "") continue
    if (line.startsWith("?")) {
      missing.push(line.slice(1).trim())
      continue
    }
    objects += 1
  }
  if (result.stderr.trim() !== "" || (result.code !== 0 && missing.length === 0)) {
    throw new UnknownError(
      `head closure in witness store ${storeGitDir} could not be read (exit ${String(result.code)}): ${result.stderr.trim()}`,
    )
  }
  if (missing.length > 0) return { status: "missing", missing }
  return { status: "present", objects }
}

/**
 * 37792 (@cto 8c9ba37e): the heads an ancestry proof may compare, and the fetched copies it may not. A ref under
 * refs/remotes/** or refs/gitomic/fetched/** is a copy of what somebody else publishes, so this environment is not its
 * only custodian and the proof must not depend on it — they are counted by namespace, never dropped in silence.
 */
export interface ComponentHeadCensus {
  readonly heads: readonly string[]
  readonly fetched: readonly Readonly<{ namespace: string; count: number }>[]
}

/** The fetched-copy namespaces an ancestry proof excludes, longest prefix first. */
const FETCHED_NAMESPACES = ["refs/gitomic/fetched/", "refs/remotes/"] as const

function fetchedNamespace(ref: string): string | undefined {
  return FETCHED_NAMESPACES.find((namespace) => ref.startsWith(namespace))
}

export function custodyIdentityError(message: string): Error {
  return new Error(`component custody census unknown: ${message}`)
}

/**
 * 37455-A (@cto 29f8631c): the heads the environment holds for one component — what its checkout names (the gitlink
 * commit) plus every local branch tip in its own store. A head that cannot be read is not dropped: it is named in the
 * error, because an unreadable ref must refuse rather than leave custody unproven in silence.
 */
export async function componentHeads(
  run: GitRun,
  gitDir: string,
  deadline: number,
  clock: () => number = Date.now,
  shared?: Readonly<{ observations: RefObservations; key: string }>,
): Promise<ComponentHeadCensus> {
  const remaining = (): number => {
    const left = deadline - clock()
    if (left <= 0) throw custodyIdentityError("shared proof deadline is exhausted")
    return left
  }
  // No caller deadline is not a deadline at infinity: spawn rejects a non-finite timeout, and the census would then
  // report every component unreadable (2026-11-22). Omit the timeout instead.
  const timing = (): { timeoutMs?: number } => (Number.isFinite(deadline) ? { timeoutMs: remaining() } : {})
  // 37792 (@cto 93f4ba37): a retained module's store still records core.worktree for a checkout that is gone, so a plain
  // --git-dir read dies with "cannot chdir" and every component census came back unreadable. Read it detached, exactly
  // as the witness walk does (#34920).
  // 37792 (@cto turn44): `timing()` reads the remaining budget first, so an entry whose shared deadline is already
  // spent starts no Git child at all -- not even the configuration read that decides how to open the store -- and the
  // first child that does start carries that remaining budget instead of running unbounded.
  const storeRun = atStore(run, gitDir, await worktreeGone(gitDir, run, timing()))
  const heads: string[] = []
  const fetched = new Map<string, number>()
  const named = await storeRun([`--git-dir=${gitDir}`, "rev-parse", "--verify", "HEAD"], timing())
  if (named.code === 0 && named.stderr.trim() === "") {
    const head = named.stdout.trim()
    if (!/^[0-9a-f]{40,64}$/u.test(head)) {
      throw custodyIdentityError(`${gitDir}: rev-parse HEAD answered a non-commit ${JSON.stringify(head.slice(0, 80))}`)
    }
    heads.push(head)
  } else if (!/unknown revision|Needed a single revision|ambiguous argument|bad revision/u.test(named.stderr)) {
    throw custodyIdentityError(
      `${gitDir}: HEAD could not be read (${named.stderr.trim() || `exit ${String(named.code)}`}); an unreadable head is refused, never dropped`,
    )
  }
  // 37455-A forward (@chief 2026-11-22): the census roots EVERY ref outside refs/remotes/** as a Gate 4 root OID
  // (CUSTODY_FRESHNESS_INPUT_SPEC component.refs), so the heads handed to the ancestry proof must be that same set.
  // Taking only refs/heads left a commit held solely by refs/stash, a tag or notes as reachability.unreferenced, and
  // env close then deleted the environment's private object store with it.
  // 37854 (@cto turn46-ref-observations): contents already listed this exact copy's refs in this pass, so the census
  // reuses that complete raw list instead of paying a second whole-store listing. It validates the rows itself, and a
  // refused, timed-out or changed read is never cached, so no reuse can carry a custody claim it did not observe.
  let refRows: readonly RefObservationRow[]
  try {
    refRows = await observeRefs(storeRun, gitDir, {
      ...(shared === undefined ? {} : { observations: shared.observations }),
      key: shared?.key ?? gitDir,
      // `storeRun` only adds `--work-tree`; the listing must name the store or it reads whatever repo is the cwd.
      context: [`--git-dir=${gitDir}`],
      runOptions: timing(),
      label: `for-each-ref in ${gitDir}`,
      // The census decides commit / tag / other, so it cannot accept a listing that lost the type to a broken ref:
      // it re-reads strictly and refuses, exactly as it did before the shared observation existed.
      requireTypes: true,
    })
  } catch (error) {
    throw custodyIdentityError(error instanceof Error ? error.message : String(error))
  }
  for (const { ref, oid: tip, type: objectType } of refRows) {
    const fetchedFrom = fetchedNamespace(ref)
    if (fetchedFrom !== undefined) {
      fetched.set(fetchedFrom, (fetched.get(fetchedFrom) ?? 0) + 1)
      continue
    }
    if (!/^[0-9a-f]{40,64}$/u.test(tip)) {
      throw custodyIdentityError(
        `${gitDir}: for-each-ref answered a non-commit tip for ${ref} ${JSON.stringify(tip.slice(0, 80))}`,
      )
    }
    if (objectType === "commit") {
      heads.push(tip)
      continue
    }
    // A ref on a blob or tree is still a Gate 4 root (component.refs), so an ancestry proof over commits cannot speak
    // for this component: hand back NO heads and let the full census path keep every object it roots (@dev/15
    // 2026-11-22). A partial head set here is the same defect as reading only refs/heads, one ref type over.
    if (objectType !== "tag") {
      return { heads: [], fetched: [...fetched].map(([namespace, count]) => ({ namespace, count })) }
    }
    // A tag object names a commit through a peel. A peel that FAILS is either a tag of a tree/blob, which is the case
    // above, or a read that could not complete, which is refused like an unreadable HEAD.
    // 37854 (@cto turn46): peel the OBSERVED tag object id, never the ref name. A name re-pointed since the
    // enumeration would otherwise peel to a commit this census never listed.
    const peeled = await storeRun([`--git-dir=${gitDir}`, "rev-parse", "--verify", `${tip}^{commit}`], timing())
    remaining()
    const peeledTip = peeled.stdout.trim()
    if (peeled.code === 0 && peeled.stderr.trim() === "" && /^[0-9a-f]{40,64}$/u.test(peeledTip)) {
      heads.push(peeledTip)
      continue
    }
    if (/expected commit type|not a commit|is a (blob|tree)\b/iu.test(peeled.stderr)) {
      return { heads: [], fetched: [...fetched].map(([namespace, count]) => ({ namespace, count })) }
    }
    throw custodyIdentityError(
      `${gitDir}: tag ref ${ref} could not be peeled to a commit (${peeled.stderr.trim() || `exit ${String(peeled.code)}`}); an unreadable head is refused, never dropped`,
    )
  }
  return {
    heads: [...new Set(heads)],
    fetched: [...fetched]
      .map(([namespace, count]) => ({ namespace, count }))
      .sort((a, b) => (a.namespace < b.namespace ? -1 : 1)),
  }
}

/**
 * 37792 (@cto 78e96f64 part 2): which components does head ancestry already prove, and does it prove them all? Asked
 * BEFORE any witness store is fscked, because a proof that needs no witness must not pay for one — and because a
 * proven component needs no store fscked on its behalf at all. Each component is proven against the tip its own
 * mirror's remote answered with in this same run, after that tip is proved present in the mirror, and only when every
 * head the component holds is an ancestor of it. Any missing head, unreadable remote, absent tip or non-ancestor head
 * leaves that component out, which keeps the witness and patch proofs for it exactly as they were.
 *
 * The store walk is one pass over the witnesses: identity is read once per store, never once per component, because
 * the live estate holds ~24,000 of them and the first version of this paid that cost five times over (2026-11-22).
 */
/** 37792 (@cto 93f4ba37): one repository read per store per run, never once per store per entry. */
async function identityOf(
  scope: CustodyRunScope | undefined,
  gitDir: string,
  run: GitRun,
  remaining: () => number,
): Promise<Readonly<{ status: "known"; id: string } | { status: "unknown"; detail: string }>> {
  const cached = scope?.identities.get(gitDir)
  if (cached !== undefined) return cached
  const computed = await storeRepoIdentity(gitDir, run, remaining)
  scope?.identities.set(gitDir, computed)
  return computed
}

async function ancestryProof(
  copyRoot: string,
  components: readonly ComponentContents[],
  repoByComponent: ReadonlyMap<string, string>,
  stores: readonly string[],
  heads: Readonly<Record<string, readonly string[]>> | undefined,
  targetBranch: string | undefined,
  run: GitRun,
  runScope: CustodyRunScope | undefined,
  remaining: () => number,
): Promise<Readonly<{ provenRepos: ReadonlySet<string>; allProven: boolean }>> {
  const none = { provenRepos: new Set<string>(), allProven: false }
  if (targetBranch === undefined || heads === undefined || components.length === 0) return none
  // One identity read per store; the first matching store per repository is the one allowed to fix that tip.
  const storesByRepo = new Map<string, string[]>()
  for (const store of stores) {
    const storeGitDir = dirname(store)
    let identity: Awaited<ReturnType<typeof storeRepoIdentity>>
    try {
      identity = await storeRepoIdentity(
        storeGitDir,
        atStore(run, storeGitDir, await worktreeGone(storeGitDir, run)),
        remaining,
      )
    } catch {
      continue
    }
    if (identity.status !== "known") continue
    const list = storesByRepo.get(identity.id)
    if (list === undefined) storesByRepo.set(identity.id, [store])
    else list.push(store)
  }
  const provenRepos = new Set<string>()
  for (const component of components) {
    const repo = repoByComponent.get(component.component)
    const componentHeads = heads[component.component]
    if (repo === undefined || componentHeads === undefined || componentHeads.length === 0) continue
    const candidates = storesByRepo.get(repo)
    if (candidates === undefined || candidates.length === 0) continue
    const store = candidates[0] as string
    const storeGitDir = dirname(store)
    let tip: string | undefined
    try {
      const remote = await configuredRemote(
        storeGitDir,
        atStore(run, storeGitDir, await worktreeGone(storeGitDir, run)),
      )
      if (remote === undefined) continue
      // 37792 (@cto turn38-retention-remote): ancestry pays for the target advertisement alone; populating the pin
      // namespace is the index's fact and happens there, before its eligible-ref list.
      const advertisement = await observePublishedAdvertisement(runScope, storeGitDir, remote, targetBranch, run)
      tip = advertisement.branchTip
      if (tip !== undefined) await requirePublishedTipReadable(storeGitDir, remote, targetBranch, tip, run)
    } catch {
      continue
    }
    if (tip === undefined) continue
    const componentGitDir = component.gitDir ?? join(copyRoot, component.component)
    // 37792 (@cto turn36-retention-ruling part 2): the ancestry read belongs to the admitted surviving witness store,
    // so the runner is bound there too; the retained copy is only named in a refusal.
    const ancestry = await headsAreAncestors(
      componentGitDir,
      componentHeads,
      tip,
      storeGitDir,
      atStore(run, storeGitDir, await worktreeGone(storeGitDir, run)),
      remaining,
    )
    if (ancestry.status === "ancestors") provenRepos.add(repo)
  }
  return {
    provenRepos,
    allProven:
      provenRepos.size > 0 &&
      components.every((component) => {
        const repo = repoByComponent.get(component.component)
        return repo !== undefined && provenRepos.has(repo)
      }),
  }
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
  environmentHeads?: Readonly<Record<string, readonly string[]>>,
  runScope?: CustodyRunScope,
  /** 34127 (@cto e8f6c3b5): the phase entered, reported before its completed span exists. */
  onPhaseEnter?: (name: string) => void,
  /** 34127 (@cto turn60): the real duration of each named operation, including one cut by the deadline. */
  onPhaseSpend?: (name: string, ms: number) => void,
  /** 37854: the subtraction bound this scan walks with; see {@link CustodyScanOptions.maxSubtractedTips}. */
  maxSubtractedTips = MAX_SUBTRACTED_TIPS,
): Promise<CustodyScan> {
  const remaining = (): number => {
    const left = deadline === undefined ? Number.POSITIVE_INFINITY : deadline - clock()
    if (left <= 0) throw new ProofDeadlineError("shared proof deadline is exhausted")
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
  // #35062 (@cto 35062-vanished-witness-go-0445): a candidate witness store proven absent by ENOENT when its path is
  // resolved (a worktree removed after the estate scan) is excluded from witness selection and named. It contributes
  // no ref, object or index fragment; every at-risk object still needs a surviving witness, so dropping it can only
  // keep more. Any other failure (EACCES, I/O, a malformed store) stays as before, and the estate facts keep the path.
  const vanished: string[] = []
  const canonical: string[] = []
  for (const store of witnessStores) {
    try {
      canonical.push(realpathSync(store))
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error
      vanished.push(store)
    }
  }
  const stores = [...new Set(canonical)].filter((store) => !removal.some((root) => within(root, store))).sort()
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
    const requested = runOptions.timeoutMs ?? Number.POSITIVE_INFINITY
    const left = remaining()
    const timeoutMs = Math.min(requested, left)
    const result = await run(witnessPolicy === undefined ? args : ["--no-replace-objects", ...args], {
      ...runOptions,
      ...(Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
      ...(witnessPolicy === undefined
        ? {}
        : { env: { ...runOptions.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" } }),
    })
    // 37792 (@cto 2026-11-22 9573ed64): classify from the bound that was actually in force at dispatch. `left` at or
    // below the requested bound means the SHARED deadline set it, so a kill here is the schedule, not the store.
    return left <= requested && result.timedOut === true ? { ...result, sharedDeadlineCut: true } : result
  }
  const proofStream: GitStreamFactory = (args, streamOptions = {}) => {
    const requested = streamOptions.timeoutMs ?? Number.POSITIVE_INFINITY
    const left = remaining()
    const sharedDeadlineCut = left <= requested
    const opened = stream(witnessPolicy === undefined ? args : ["--no-replace-objects", ...args], {
      ...streamOptions,
      timeoutMs: Math.min(requested, left),
      ...(witnessPolicy === undefined
        ? {}
        : { env: { ...streamOptions.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" } }),
    })
    if (!sharedDeadlineCut) return opened
    return {
      lines: opened.lines,
      outcome: opened.outcome.then((outcome) => (outcome.timedOut ? { ...outcome, sharedDeadlineCut: true } : outcome)),
    }
  }
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
      componentRepos,
      skipFsck,
      skipFsckRepos,
      runScope,
      onPhaseEnter,
      onPhaseSpend,
      maxSubtractedTips,
    )
    const width = String(Math.max(1, indexed.records.length)).length
    const merged = await asProofDeadline(
      mergeLabeledFiles(
        indexed.records.map((record, rank) => ({
          path: record.fragment.path,
          label: String(rank).padStart(width, "0"),
        })),
        { dir: indexDir, deadline, clock },
      ),
    )
    return { ...indexed, index: merged }
  }
  // 37792 (@cto 78e96f64 part 4): the repository each component belongs to. A store may witness a component only
  // when it mirrors that component's repository; `complete` says every component's repository is proved, so a store
  // matching none of them can be skipped rather than fscked.
  const componentRepoIds = new Set<string>()
  const componentRepoByComponent = new Map<string, string>()
  let componentReposComplete = components.length > 0
  for (const component of components) {
    // #34920: a retained module records core.worktree for a checkout that is gone, so its config is read detached or
    // git refuses to answer at all — which read as an unproved repository and cost the whole run its scoping (#37792).
    const componentGitDir = component.gitDir ?? join(copyRoot, component.component)
    const identity = await storeRepoIdentity(
      componentGitDir,
      atStore(proofRun, componentGitDir, await worktreeGone(componentGitDir, proofRun)),
      remaining,
    )
    if (identity.status === "known") {
      componentRepoIds.add(identity.id)
      componentRepoByComponent.set(component.component, identity.id)
    } else componentReposComplete = false
  }
  const componentRepos = { ids: componentRepoIds, complete: componentReposComplete }
  // 37792 (@cto 78e96f64 part 2): when ancestry proves every component no witness is needed, so no store-wide
  // `fsck --full` runs at all; the index is still built, because it is what names the leftover objects.
  const ancestry =
    witnessPolicy === undefined
      ? { provenRepos: new Set<string>(), allProven: false }
      : await ancestryProof(
          copyRoot,
          components,
          componentRepoByComponent,
          stores,
          environmentHeads,
          witnessPolicy.targetBranch,
          proofRun,
          runScope,
          remaining,
        )
  // A component ancestry already proves needs no witness, so no store that mirrors only proven repositories is
  // fscked on its behalf; a store also serving an unproven component is still fscked, because that component needs it.
  const skipFsck = ancestry.allProven
  const skipFsckRepos = ancestry.provenRepos
  const { records, formats, published, unsubtracted, nonWitnesses, fsckStores, foreign, unscoped, corrupt, index } =
    indexScope === undefined
      ? await buildIndex()
      : await indexScope.witnessIndex(
          JSON.stringify([
            stores,
            [...removal].sort(),
            witnessPolicy?.targetBranch ?? null,
            [...componentRepoIds].sort(),
            componentReposComplete,
            skipFsck,
            [...skipFsckRepos].sort(),
          ]),
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
  const reachability: HeadReachability[] = []
  // 37792 (@cto 2026-11-22): the head-closure facts the receipt names next to the store-health count.
  const closureNotes: string[] = []
  const unreferenced: CustodyTarget[] = []
  let unreferencedCount = 0
  // 37455-A: the published target tip a component's heads must be ancestors of. 37792 (@cto 78e96f64 part 2): the
  // candidate tips are only those a store's remote answered for in this run (never a mirror ref confirmed nowhere),
  // and a component takes the one whose store mirrors its own repository; anything else keeps the witness and patch
  // proofs, because a tip from another repository proves nothing about this one.
  const publishedTipFor = (
    component: string,
  ): Readonly<{ store: string; tip: string; repo: string; remote: string }> | undefined => {
    const repo = componentRepoByComponent.get(component)
    const only = published.length === 1 ? published[0] : undefined
    // One published tip still decides a component whose own repository is unproved (a local-only copy declares no
    // remote), which is 37455-A's behaviour and stays behind the same two cat-file checks. Known repositories must
    // match: a tip from another repository proves nothing about this one.
    if (only !== undefined && (repo === undefined || only.repo === "" || only.repo === repo)) return only
    if (repo === undefined) return undefined
    const candidates = published.filter((entry) => entry.repo === repo)
    return candidates.length === 1 ? candidates[0] : undefined
  }
  // 37792 (@cto 2026-11-22): head ancestry is cheap, so every component is decided first; the closure read that
  // answers "would these objects survive" then runs ONCE per witness store over the union of the heads it proves,
  // instead of once per component (the first version paid a full object walk per component and exhausted the batch).
  const ancestryByComponent = new Map<string, HeadReachability>()
  const closureByStore = new Map<string, { heads: string[]; components: string[] }>()
  for (const component of components) {
    remaining()
    const componentGitDir = component.gitDir ?? join(copyRoot, component.component)
    const heads = environmentHeads?.[component.component]
    const publishedTip = publishedTipFor(component.component)
    if (component.missingRoots !== 0 || heads === undefined || heads.length === 0 || publishedTip === undefined) {
      continue
    }
    const ancestry = await headsAreAncestors(
      componentGitDir,
      heads,
      publishedTip.tip,
      dirname(publishedTip.store),
      proofRun,
      remaining,
    )
    if (ancestry.status === "unknown") throw new UnknownError(ancestry.detail)
    if (ancestry.status !== "ancestors") continue
    ancestryByComponent.set(component.component, {
      component: component.component,
      heads: [...heads].sort(),
      store: publishedTip.store,
      tip: publishedTip.tip,
      confirmedBy: `ls-remote ${publishedTip.remote} refs/heads/${witnessPolicy?.targetBranch ?? "?"} in this run`,
    })
    const closureStore = dirname(publishedTip.store)
    const target = closureByStore.get(closureStore) ?? { heads: [], components: [] }
    target.heads.push(...heads)
    target.components.push(component.component)
    closureByStore.set(closureStore, target)
  }
  for (const [store, target] of closureByStore) {
    const heads = [...new Set(target.heads)].sort()
    const closure = await headsPresentInWitness(store, heads, proofRun, remaining)
    if (closure.status === "missing") {
      throw new UnknownError(
        `head closure missing ${String(closure.missing.length)} object(s) in witness store ${store}: ${closure.missing.slice(0, MISSING_INLINE).join(", ")}${closure.missing.length > MISSING_INLINE ? " ..." : ""}`,
      )
    }
    closureNotes.push(
      `${String(closure.objects)} object(s) reachable from ${String(heads.length)} head(s) of ${String(target.components.length)} component(s) present in ${store}`,
    )
  }
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
      if (format.status !== "ok") {
        if (format.vanished !== undefined) throw new VanishedStoreError(format.vanished, format.detail)
        throw new UnknownError(format.detail)
      }
      // 37455-A (@cto 29f8631c): reachability first. A component whose every head ancestry proved needs no byte
      // stream; its closure was already read once for its store above. Anything else falls through to the witness and
      // patch proofs below, where the patch bound stays.
      const proven = ancestryByComponent.get(component.component)
      const provenUnreferenced: CustodyTarget[] = []
      let provenUnreferencedTotal = 0
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
            // 37455-A: a proven component keeps every un-witnessed object named here rather than silent. No head
            // reaches it, no patch stream is read for it, and the proof says exactly which objects the removal drops.
            if (proven !== undefined) {
              provenUnreferencedTotal += 1
              unreferencedCount += 1
              if (unreferenced.length < MISSING_INLINE) {
                unreferenced.push({ component: component.component, oid: key, source })
              }
              if (provenUnreferenced.length < MISSING_INLINE) {
                provenUnreferenced.push({ component: component.component, oid: key, source })
              }
              return
            }
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
      if (proven !== undefined) {
        reachability.push({
          ...proven,
          ...(provenUnreferenced.length === 0
            ? {}
            : { unreferenced: provenUnreferenced, unreferencedCount: provenUnreferencedTotal }),
        })
      }
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
  onPhaseEnter?.("witnessCertificates")
  const certificates = new Map<string, SidecarRef>()
  const witnesses: WitnessIdentity[] = []
  try {
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
  } finally {
    // 34127 (@cto e8f6c3b5): a certificate walk cut by the deadline still names what it was doing and what it spent.
    // 34127 (@cto turn60): the same measured duration is what the entry's own subphase record takes, so this phase is
    // not the one nested operation left without a number beside `child`.
    const certificateMs = clock() - certificateStarted
    onPhase?.("witnessCertificates", certificateMs)
    onPhaseSpend?.("witnessCertificates", certificateMs)
  }
  remaining()
  const first = missing[0]
  if (missingCount > 0 && first !== undefined) {
    const loss = await describeLoss(finalMissing, components, copyRoot, run)
    return {
      status: "blocked",
      detail: `${missingCount} at-risk OID(s) have no durable witness, e.g. ${first.component} ${first.oid} (${first.source}); first ${missing.length} inline, full list in ${missingSidecar?.path ?? "a sidecar"}${uncheckedDetail(unchecked)}${unsubtractedDetail(unsubtracted)}${nonWitnessDetail(nonWitnesses)}${vanishedDetail(vanished)}${foreignDetail(foreign)}${unscopedDetail(unscoped)}${corruptDetail(corrupt)}${storeHealthDetail(fsckStores)}${closureDetail(closureNotes)}${fragmentUseDetail(runScope)}`,
      witnesses,
      witnessCount,
      ...(witnessSidecar === undefined ? {} : { witnessSidecar }),
      missing,
      missingCount,
      ...(missingSidecar === undefined ? {} : { missingSidecar }),
      rebased,
      ...(reachability.length === 0 ? {} : { reachability }),
      loss,
    }
  }
  return {
    status: "pass",
    detail: `${witnessCount} at-risk OID(s) each have a named surviving witness across ${stores.length} store(s), ${witnesses.length} distinct identities${rebased.length === 0 ? "" : `, plus ${String(rebased.length)} rebased commit(s) matched by whitespace-sensitive patch-id to the published main graph`}${reachability.length === 0 ? "" : `, plus ${String(reachability.length)} component(s) proven by head ancestry of the published target branch (no patch stream read; ${String(unreferencedCount)} un-witnessed leftover object(s) named, no head reaches them)`}${uncheckedDetail(unchecked)}${unsubtractedDetail(unsubtracted)}${nonWitnessDetail(nonWitnesses)}${vanishedDetail(vanished)}${foreignDetail(foreign)}${unscopedDetail(unscoped)}${corruptDetail(corrupt)}${storeHealthDetail(fsckStores)}${closureDetail(closureNotes)}${fragmentUseDetail(runScope)}`,
    witnesses,
    witnessCount,
    ...(witnessSidecar === undefined ? {} : { witnessSidecar }),
    missing: [],
    missingCount: 0,
    rebased,
    ...(reachability.length === 0 ? {} : { reachability }),
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
      options.environmentHeads,
      options.runScope,
      options.onPhaseEnter,
      options.onPhaseSpend,
      options.maxSubtractedTips ?? MAX_SUBTRACTED_TIPS,
    )
  } catch (error) {
    return {
      status: "unknown",
      detail: error instanceof Error ? error.message : String(error),
      witnesses: [],
      witnessCount: 0,
      missing: [],
      missingCount: 0,
      ...(error instanceof VanishedStoreError ? { vanishedAtRead: [error.gitDir] } : {}),
    }
  }
}
