/**
 * A retirement BATCH (#33010, @cto dc77f630): one shared gate-3 estate scan reused across many retained entries,
 * because a fresh scan per entry costs 469-496 s on the live estate (149,443 alternates files) and cannot fit any
 * per-entry bound. Every other gate still runs per entry, twice: a preliminary pass with no lease, then a held
 * re-verify under the lease whose facts must equal the preliminary ones before that entry is deleted.
 *
 * The lease is NOT held across the scan. Instead one lease window opens with {@link estateDelta}: the estate's SET of
 * object directories, alternates files, `objects` links and borrower registries must still be what the scan saw.
 * Writers that never take the lease exist (a hand-run clone or `git worktree add` writes an alternates file with no
 * lease); that comparison catches their changes before the delta. A new borrower added without a lease DURING
 * the held window is not detected by the reused scan (accepted limitation, @cto d35ae483). A changed delta ends the batch
 * with nothing deleted. The lease is then held with no gap through that window's deletes, and its hold time is
 * measured; the command stops once its hold would pass the budget (about 60 s). A subsequent invocation scans afresh.
 *
 * Dry run by default: `apply: false` reports the entries that would be retired and why every other one is kept.
 *
 * THE INVARIANT, and the one place it is stated (#34127, @cto 2026-11-24): **no entry is deleted on a stale or unknown
 * proof.** Each entry's proof must be fresh, re-verified inside its lease, at the moment its delete runs. The time
 * budget governs NEW work — which entry is proved next and where the run stops — and it never voids a proof that was
 * already re-verified under its lease, and never lets an unverified entry through. So a `deadline`/`budget` stop is a
 * time stop (`stoppedKind`), a success with a named remainder, and only a condition stop (a shifted census, a held
 * lease, a partial retirement) or a failed row fails the run. The chunked driver that turns this into progress across
 * nights is `retention-chunks.ts`; it changes when the run stops, never what a delete is allowed to rest on.
 */
import { measureRetainedBytes } from "./retention-bytes.ts"
import { CustodyIndexScope } from "./retention-custody.ts"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { acquireFlockWithTimeout, type FlockHandle } from "@bearly/flock"
import { reapStaleWriterLease } from "./exclusive.ts"
import { DEFAULT_MUTATION_LOCK_WAIT_MS } from "./exclusive.ts"
import {
  BATCH_ESTATE_BOUNDS,
  estateDelta,
  newEstateWalkRecord,
  scanEstate,
  type EstateBorrower,
  type EstateScan,
  type EstateScanBounds,
} from "./retention-estate.ts"
import { pointers, proofFacts } from "./retention-remove.ts"
import { CustodyRunScope } from "./retention-custody.ts"
import type { GitRun, GitStreamFactory } from "./retention-contents.ts"
import {
  inspectRetainedEntryInBatch,
  type RetentionVerifyOptions,
  type RetentionVerifyResult,
} from "./retention-verify.ts"
import { acquireRemovalWriterLeases, removeRetainedPointer } from "./worktree-removal.ts"

export type RetentionBatchOptions = Readonly<{
  entries: readonly string[]
  root: string
  common: string
  namespaceRoots: readonly string[]
  /** One durable directory; each entry's proofs go under `<artifactDir>/<entry name>/{pre,held}`. */
  artifactDir: string
  /** False (the default) is a dry run: nothing is leased or deleted. */
  apply?: boolean
  /** A lease window closes before its hold would pass this; default 60 s (@cto dc77f630 condition 2). */
  holdBudgetMs?: number
  /**
   * #35047: the whole batch's proof budget, from the call. An entry not started by then, or a custody walk still
   * running at it, is kept with the cause named, and the batch reports `stopped` instead of running past its caller's
   * timeout with no report. Absent means unbounded; the CLI sets 1080 s, under Yrd's 1200 s batch timeout.
   */
  proofDeadlineMs?: number
  clock?: Date
  monotonic?: () => number
  allowTemporaryArtifactDir?: boolean
  /**
   * 37792 (@cto 78e96f64): the published branch gate 5 proves component heads against. Set, a component whose heads
   * are all ancestors of the tip its witness store's remote answered for in this run is proven without fsck. Absent,
   * every entry keeps the witness and patch proofs exactly as before.
   */
  targetBranch?: string
  /** Test seam: the batch scan bounds; production uses {@link BATCH_ESTATE_BOUNDS}. */
  scanBounds?: EstateScanBounds
  /** Test seam: runs between the scan and the first lease window, as a writer with no lease would. */
  afterScan?: () => void
  /**
   * 37792 (@cto 2026-11-22 9f716dad): the two readers a measurement harness wraps - the same hooks a custody scan
   * takes - so an owned harness can record each child's argv, start, result and duration without a production flag.
   * Absent, the batch uses the shipped readers exactly as before.
   */
  gitRun?: GitRun
  gitStream?: GitStreamFactory
  /**
   * 37792 (@cto 1a773179): set false to force every entry's witness walk, for a caller or case that proves the walk
   * itself. Default: gate 5 answers from one timestamped live remote snapshot per component when the copy is redundant.
   */
  remoteRedundancy?: boolean
  /**
   * #38246 (@cto 2026-11-24T21:28Z): by default every entry asks the cheap nothing-unpublished gate first, so a copy
   * that holds nothing unique retires without the content and custody gates. `true` demands the full gates for every
   * entry; the production CLI never sets it, and a case proving the expensive path does.
   */
  fullProof?: boolean
  /**
   * #34127 (@chief ce94a977, @cto b682a7ed): set, the batch ages `<namespace root>/.retired/<YYYY-MM-DD>` — the retained
   * arm's own already-retired output. A dated directory whose name date AND mtime are both older than this, with no
   * borrower outside the aged set, is deleted; every other one is kept or skipped by name. Absent, nothing is aged. The
   * chunk driver sets it on its first chunk only, so one run ages once.
   */
  retiredMaxAgeMs?: number
}>

/** One `.retired/<date>` directory's ageing verdict (#34127). */
export type RetiredAgedRow = Readonly<{
  path: string
  outcome: "would-retire" | "retired" | "kept" | "skipped" | "failed"
  reason: string
  /** Allocated bytes, measured before the delete, on would-retire and retired rows (each hard-linked file counted once). */
  bytes?: number
}>

/** The retained arm's already-retired output under each namespace root (#34127). */
export const RETIRED_DIR = ".retired"
/** How old a `.retired/<date>` directory must be, by name and by mtime, before the CLI's batch ages it (@chief ce94a977). */
export const RETIRED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const RETIRED_DATE_NAME = /^\d{4}-\d{2}-\d{2}$/u

export type BatchRow = Readonly<{
  entry: string
  outcome: "would-retire" | "retired" | "kept" | "failed" | "not-reached"
  reason: string
  evidence?: string
  /**
   * 34127 (@cto 2026-11-26): milliseconds per gate for the pass that decided this row, under the names the certificate
   * uses, plus the custody walk's own nested phases (witnessFsck, refGraph, ...) under their own names. A gate the pass
   * never reached is ABSENT, never zero, so "not evaluated" and "took no time" stay different answers.
   */
  gates?: Readonly<Record<string, number>>
  /** Milliseconds spent removing the entry and cleaning up its pointers; absent when nothing was deleted. */
  deleteMs?: number
}>

export type BatchWindow = Readonly<{
  entries: readonly string[]
  delta: "unchanged" | "changed"
  deltaMs: number
  holdMs: number
  /** #33010 (@cto): what the delta cost, so its "< 10 s" target is visible on a real apply, not inferred. */
  filesStatted: number
  filesRead: number
  /** Stores the scan never saw that the delta classified as churn: counted, never a stop. */
  discoveredStores: number
  /** Directories past the discovery depth or inside a pruned build output: not visited, and counted. */
  prunedDirs: number
  /** Directories the discovery walk read. */
  walkedDirs: number
  /** #33010 (@cto a6752202): recorded stores outside the selection that vanished since the scan: counted, not a stop. */
  vanishedStores: number
  /**
   * #33010 (@cto a6752202): outside owners whose Git directory was gone when the window took its leases, by path. A
   * gone owner can move no lender, so it is named here and left out of the lease set instead of ending the batch.
   */
  vanishedOwners: readonly string[]
}>

export type RetentionBatchResult = Readonly<{
  apply: boolean
  /** Allocation warnings are informational and never change a row outcome. */
  warnings: readonly Readonly<{ entry: string; phase: "pre" | "held"; message: string }>[]
  scan: Readonly<{
    status: EstateScan["status"]
    detail: string
    ms: number
    alternatesFiles: number
    excluded: number
  }>
  /**
   * 37792 (@cto c1f3a921): the custody scan's phase totals for this run, summed per phase name, so the receipt separates
   * a cold store's connectivity check from its ordered ref walk. Absent when no proof reached a witness store.
   */
  proofPhases?: Readonly<Record<string, number>>
  /**
   * 34127 (@cto e8f6c3b5, turn58 (b)): each entry's own time in the PRELIMINARY pass, so a starved batch says where its
   * budget went instead of naming one proof total. The held re-verification is not reported here: a no-apply batch
   * returns before it, and a held pass runs under the existing shared deadline with no per-entry slice to report.
   * `startMs`/`endMs` are monotonic offsets from the batch start; `sliceMs` is the share the schedule gave the entry
   * and `sliceDeadlineMs` its offset from the batch proof start.
   *
   * `phases` holds only the entry's own top-level boundaries (setup, child, drain, receipt) and they never overlap;
   * the custody walk's named phases are reported beside them under `subphases`, inclusive inside `child`, because
   * their windows can span several stores and must never be subtracted from it. `lastPhase` is the deepest phase that
   * was LIVE when the entry entered it, so a deadline cut keeps naming the operation that died, not the cleanup that
   * ran after it; `deadlineCutMs` is where that cut was first observed, in the same batch-relative coordinates as
   * `startMs`/`endMs`, so it always satisfies `startMs <= deadlineCutMs <= endMs`. `receiptMs` is the measured
   * certificate write at its call site, absent when the entry never reached it. `unattributedMs` is the residual as
   * measured, reported even when negative so overlapping windows stay visible rather than being clamped away.
   */
  preliminaryEntryTimings?: Readonly<
    Record<
      string,
      Readonly<{
        startMs: number
        endMs: number
        sliceMs: number
        sliceDeadlineMs?: number
        lastPhase: string
        deadlineCutMs?: number
        phases: Readonly<Record<string, number>>
        subphases?: Readonly<Record<string, number>>
        receiptMs?: number
        unattributedMs: number
        /**
         * 37854 (@cto 7debe1c0): the ref walks this entry itself paid for and the ones it reused from earlier entries
         * in the same preliminary pass. Always present; `0`/`0` means this entry observed no eligible walk (it never
         * reached one, or was not started), never "not measured". Diagnostic only: it changes no deadline or decision.
         */
        fragments: Readonly<{ walked: number; reused: number }>
      }>
    >
  >
  /**
   * 37854 (@cto 7debe1c0): the preliminary pass's own totals for the same counters, so the per-entry deltas can be
   * checked against them. Absent only when no entry in the pass ever reached the custody walk.
   */
  preliminaryFragments?: Readonly<{ walked: number; reused: number }>
  /** The outside Git owners whose existing writer leases a window holds, and how many cannot be leased. */
  owners?: Readonly<{
    total: number
    leaseMissing: number
    cold: number
    liveUnleased: number
    /** Owners kept live because their cold evidence could not be read, including shared-source cache hits. */
    coldProofFailed: number
    coldProofFailedOwners: readonly string[]
    unproved: number
    leaseMissingExample?: string
    unprovedExample?: string
    /** Every owner object directory with no proved Git owner, one path per line, sorted (#34960). */
    unprovedList: string
    /** Every live owner with no existing writer lease, one path per line, sorted (#34960). */
    leaseMissingList: string
    /**
     * #34127 (@chief ce94a977): object directories under `<namespace>/.retired/`, left out of leasing and of
     * {@link unproved} because they are already-retired data; still scanned, so a borrower edge out of them counts.
     */
    retiredExcluded: number
    /** Those directories, one path per line, sorted. */
    retiredExcludedList: string
    /**
     * #34127 (@chief 2026-11-21 14:20): an object directory with no proved Git owner is a reported skip, never a batch
     * stop. This is how many selected entries were kept because they borrow objects from one; none of them is deleted.
     */
    identityUnknownEntries: number
    /** Those kept entries, `entry<TAB>object directory` per line, sorted; written beside the other owner lists. */
    identityUnknownList: string
    /** Allocated bytes the unproved directories hold, each measured on its own (a file linked into two counts twice). */
    identityUnknownBytes?: number
    /** Paths the byte total could not read; non-zero means `identityUnknownBytes` understates what is held. */
    identityUnknownUnreadable?: number
    /** Unproved directories the proof deadline cut off before their measurement, so no bytes were read for them. */
    identityUnknownUnmeasured?: number
  }>
  windows: readonly BatchWindow[]
  rows: readonly BatchRow[]
  /** Allocated bytes the batch would free, measured from the retained stores themselves (never an estimate). */
  bytesPlanned?: number
  /** Allocated bytes in files the batch would NOT free, because those files are also linked outside the set. */
  bytesSharedLinked?: number
  /** Paths the byte total could not read; non-zero means the figure understates what would be freed. */
  bytesUnreadable?: number
  /**
   * Allocated bytes of the evidence this batch's selected entries hold under the artifact directory (per-entry proofs
   * and the shared common folder), each hard-linked file counted once, measured when the rows are final, so a reclaim figure is read beside what its
   * receipts cost (#34920, @cto 34920-ranking-and-bare-r2). A report, never a gate.
   */
  bytesEvidence?: number
  /** Set when the batch stopped early; every entry not yet deleted is kept. */
  stopped?: string
  /**
   * 34127 (@cto 2026-11-24, chunk ruling): why the batch stopped, and whether a reader must treat it as a failure.
   * `deadline` and `budget` are TIME stops: the work that finished is real, the remainder is named, and the run is a
   * success with a remainder. `stop` is a condition that must be acted on — a shifted census, a held lease, a partial
   * retirement, an unreadable estate — and a batch that ends that way fails. Read beside `stopped`, never instead of it.
   * `shifted` (#33010, @cto c9e2666a) is the census-shifted condition on its own: the batch still fails, but the chunk
   * driver re-proves the entries it kept once, on a fresh scan, rather than ending every remaining chunk.
   */
  stoppedKind?: "deadline" | "budget" | "shifted" | "stop"
  /**
   * 34127 (@cto 2026-11-24): the entries this batch's preliminary pass proved ready to retire, in borrower order. The
   * chunk driver subtracts what it retired to report "proved but unreached", so a deadline cut names the work it cost.
   */
  candidates?: readonly string[]
  /**
   * #38246 (@cto 2026-11-24T21:28Z): the cheap gate's spend across this run. The `live` count is the entries it
   * retired on its own answer (no content or custody gate paid for), `fallThrough` the ones it sent to the full
   * gates, and `ms` the sum of each entry's own cost — the figure #38198's acceptance asks for per entry.
   */
  cheapGate?: Readonly<{ live: number; fallThrough: number; ms: number }>
  /** #34127: each `.retired/<date>` directory's verdict; absent when the caller set no {@link RetentionBatchOptions.retiredMaxAgeMs}. */
  retiredAged?: readonly RetiredAgedRow[]
}>

/**
 * 37854 (@cto 7debe1c0): the per-entry ref-walk counters as the CLI prints them. `0`/`0` says no eligible walk was
 * observed - it never reached one, or was not started - which is not the same as "not measured". Diagnostic only.
 */
export function fragmentUseText(fragments: Readonly<{ walked: number; reused: number }>): string {
  const total = fragments.walked + fragments.reused
  if (total === 0) return "fragments 0 walked / 0 reused (no eligible walk observed)"
  return `fragments ${String(fragments.walked)} walked / ${String(fragments.reused)} reused (${String(
    Math.round((fragments.reused / total) * 100),
  )}% reuse)`
}

/**
 * #34127 (@cto b682a7ed): age `.retired/<date>` directories. Both the name date and the mtime must be older than the
 * limit; a name that is not a date is skipped by name, never deleted. Deletable is a fixed point: an aged directory goes
 * only when every store borrowing from it sits inside another deletable one, so two aged directories that borrow from
 * each other both go, and a kept borrower keeps its lender. Per entry: one failure never stops the next.
 */
async function ageRetiredNamespace(input: {
  retiredRoots: readonly string[]
  borrowers: readonly EstateBorrower[]
  clockMs: number
  maxAgeMs: number
  apply: boolean
}): Promise<RetiredAgedRow[]> {
  const days = `${String(Math.round(input.maxAgeMs / 86_400_000))} d`
  const rows = new Map<string, RetiredAgedRow>()
  const aged: string[] = []
  for (const retiredRoot of input.retiredRoots) {
    for (const name of readdirSync(retiredRoot).sort()) {
      const path = join(retiredRoot, name)
      const stat = lstatSync(path)
      if (!stat.isDirectory()) {
        rows.set(path, { path, outcome: "skipped", reason: "not a directory; only dated directories are aged" })
        continue
      }
      const nameMs = RETIRED_DATE_NAME.test(name) ? Date.parse(`${name}T00:00:00Z`) : Number.NaN
      if (Number.isNaN(nameMs)) {
        rows.set(path, {
          path,
          outcome: "skipped",
          reason: `no date in its name (${name}); an undated entry is never aged`,
        })
      } else if (input.clockMs - nameMs <= input.maxAgeMs) {
        rows.set(path, { path, outcome: "kept", reason: `name date ${name} is within ${days}` })
      } else if (input.clockMs - stat.mtimeMs <= input.maxAgeMs) {
        rows.set(path, {
          path,
          outcome: "kept",
          reason: `mtime ${new Date(stat.mtimeMs).toISOString()} is within ${days}`,
        })
      } else aged.push(path)
    }
  }
  const deletable = new Set(aged)
  const outsideBorrower = (path: string) =>
    input.borrowers.find(
      (edge) =>
        within(path, edge.target) &&
        !within(path, edge.borrower) &&
        ![...deletable].some((other) => other !== path && within(other, edge.borrower)),
    )
  for (let changed = true; changed;) {
    changed = false
    for (const path of deletable) {
      if (outsideBorrower(path) === undefined) continue
      deletable.delete(path)
      changed = true
    }
  }
  for (const path of aged) {
    const edge = outsideBorrower(path)
    if (edge !== undefined) {
      rows.set(path, {
        path,
        outcome: "kept",
        reason: `aged past ${days}, but ${edge.borrower} still borrows from ${edge.target}`,
      })
    } else {
      const measured = await measureRetainedBytes([path])
      const bytes = measured.bytes + (measured.sharedBytes ?? 0)
      const reason = `name date and mtime older than ${days}; no live borrower${measured.unreadable === 0 ? "" : `; ${String(measured.unreadable)} path(s) unreadable, so bytes understate it`}`
      if (!input.apply) {
        rows.set(path, { path, outcome: "would-retire", reason, bytes })
        continue
      }
      try {
        // raw-delete-allow: a dated .retired directory this pass just proved past the age limit by name and mtime with
        // no live borrower (@cto b682a7ed); git-super carries no removely dependency, as with the retained-entry delete.
        rmSync(path, { recursive: true, force: false })
        rows.set(path, { path, outcome: "retired", reason, bytes })
      } catch (error) {
        rows.set(path, { path, outcome: "failed", reason: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  return [...rows.values()].sort((left, right) => (left.path < right.path ? -1 : 1))
}

function within(root: string, path: string): boolean {
  const part = relative(root, path)
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part))
}

/**
 * Proven absent: lstat reports no entry (ENOENT), or a path component is not a directory (ENOTDIR), so the path cannot
 * exist. Retired namespaces such as hh-dev%23main leave a receipt FILE where the directory was (#34920). Any other
 * failure throws, keeping the owner live.
 */
function provenAbsent(path: string): boolean {
  try {
    return lstatSync(path, { throwIfNoEntry: false }) === undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOTDIR") return true
    throw error
  }
}

type ColdOwner = Readonly<{ source: string; bytes: string; absent: string }>
type ColdOwnerRead = ColdOwner | Readonly<{ failure: string }>

/** Cold is an observed absent worktree, never a directory-class assumption (@cto 76cc52e6). */
function coldOwner(
  owner: string,
  root: string,
  common: string,
  cache: Map<string, ColdOwnerRead | undefined>,
): ColdOwnerRead | undefined {
  let source: string | undefined
  let retained = false
  if (within(root, owner)) {
    const name = relative(root, owner).split(sep)[0]
    if (name !== undefined && within(join(root, name, "modules"), owner)) {
      source = join(root, name, "manifest.json")
      retained = true
    }
  } else if (within(join(common, "worktrees"), owner)) {
    const name = relative(join(common, "worktrees"), owner).split(sep)[0]
    if (name !== undefined) source = join(common, "worktrees", name, "gitdir")
  }
  if (source === undefined) return undefined
  if (cache.has(source)) return cache.get(source)
  cache.set(source, undefined)
  try {
    if (lstatSync(source, { throwIfNoEntry: false })?.isFile() !== true) return undefined
    const bytes = readFileSync(source, "utf8")
    let absent: unknown
    if (retained) {
      const manifest: unknown = JSON.parse(bytes)
      if (typeof manifest === "object" && manifest !== null && "path" in manifest) absent = manifest.path
    } else {
      const gitdir = bytes.trim()
      if (isAbsolute(gitdir) && basename(gitdir) === ".git") absent = dirname(gitdir)
    }
    const proof =
      typeof absent === "string" && isAbsolute(absent) && provenAbsent(absent) ? { source, bytes, absent } : undefined
    cache.set(source, proof)
    return proof
  } catch (error) {
    // delete-fallback-allow: failed evidence keeps every owner live, requiring existing leases or connected keeps; it is reported, never used as absence proof (#33010).
    const failure = { failure: `${source}: ${error instanceof Error ? error.message : String(error)}` }
    cache.set(source, failure)
    return failure
  }
}

function coldOwnerChanged(proofs: ReadonlyMap<string, ColdOwner>): string | undefined {
  const checked = new Set<string>()
  for (const [owner, proof] of proofs) {
    if (checked.has(proof.source)) continue
    checked.add(proof.source)
    if (readFileSync(proof.source, "utf8") !== proof.bytes || !provenAbsent(proof.absent)) {
      return `cold owner ${owner} changed: ${proof.source} or absent worktree ${proof.absent}`
    }
  }
  return undefined
}

/** This entry's view of the shared scan: only survivors that borrow into THIS entry block it. */
function entryView(scan: EstateScan, entry: string): EstateScan {
  const mine = scan.survivorIntoRemoval.filter((edge) => within(entry, edge.target))
  const first = mine[0]
  return {
    ...scan,
    status: scan.status === "unknown" ? "unknown" : mine.length === 0 ? "pass" : "blocked",
    survivorIntoRemoval: mine,
    detail:
      first === undefined
        ? scan.detail
        : `${mine.length} survivor borrower(s) into ${entry}, e.g. ${first.borrower} -> ${first.target}`,
  }
}

/**
 * Entries a kept batch member still borrows from must be kept too: deleting them would break the kept one. The
 * scan's survivor list only sees borrowers OUTSIDE the batch, so edges between members are closed here.
 */
function closeOverKeptBorrowers(
  entries: readonly string[],
  borrowers: readonly EstateBorrower[],
  kept: Map<string, string>,
): void {
  const member = (path: string): string | undefined => entries.find((entry) => within(entry, path))
  const edges = borrowers
    .map((edge) => ({ from: member(edge.borrower), to: member(edge.target), edge }))
    .filter((edge) => edge.from !== undefined && edge.to !== undefined && edge.from !== edge.to)
  let grew = true
  while (grew) {
    grew = false
    for (const { from, to, edge } of edges) {
      if (kept.has(from as string) && !kept.has(to as string)) {
        kept.set(
          to as string,
          `borrower: kept batch member ${from} still borrows from it (${edge.borrower} -> ${edge.target})`,
        )
        grew = true
      }
    }
  }
}

/** Delete borrowers before their lenders, so any refused entry or early stop leaves its loans intact. */
function borrowerOrder(
  entries: readonly string[],
  borrowers: readonly EstateBorrower[],
  kept: Map<string, string>,
): string[] {
  const candidates = entries.filter((entry) => !kept.has(entry))
  const lenders = new Map(candidates.map((entry) => [entry, new Set<string>()]))
  const incoming = new Map(candidates.map((entry) => [entry, 0]))
  for (const edge of borrowers) {
    const from = candidates.find((entry) => within(entry, edge.borrower))
    const to = candidates.find((entry) => within(entry, edge.target))
    if (from === undefined || to === undefined || from === to) continue
    const targets = lenders.get(from) as Set<string>
    if (targets.has(to)) continue
    targets.add(to)
    incoming.set(to, (incoming.get(to) as number) + 1)
  }
  const ordered = candidates.filter((entry) => incoming.get(entry) === 0)
  for (let i = 0; i < ordered.length; i++) {
    for (const lender of lenders.get(ordered[i] as string) as Set<string>) {
      const remaining = (incoming.get(lender) as number) - 1
      incoming.set(lender, remaining)
      if (remaining === 0) ordered.push(lender)
    }
  }
  for (const entry of candidates) {
    if (!ordered.includes(entry)) {
      kept.set(entry, "borrower: unresolved cyclic batch dependency; its borrowers must remain in custody")
    }
  }
  return ordered
}

export async function retireRetainedBatch(options: RetentionBatchOptions): Promise<RetentionBatchResult> {
  const apply = options.apply === true
  const monotonic = options.monotonic ?? (() => performance.now())
  // 34127 (@cto e8f6c3b5): entry boundaries are monotonic offsets from here.
  // 34127 (@cto turn58): the proof deadline is expressed in that same monotonic clock and handed to the verifier, so an
  // entry's own start/end and its phase buckets are one domain. Mixing wall-clock spans with performance.now offsets left
  // a residual that was negative by fractions of a millisecond and would have hidden a real overlap.
  const batchStarted = monotonic()
  const proofStartWall = batchStarted
  const budget = options.holdBudgetMs ?? 60_000
  // In the verifier's default clock domain (Date.now), so the same absolute value bounds both the batch loop and the
  // custody walks inside each proof.
  const proofDeadline = options.proofDeadlineMs === undefined ? undefined : monotonic() + options.proofDeadlineMs
  const proofDeadlinePassed = (): boolean => proofDeadline !== undefined && monotonic() >= proofDeadline
  const root = realpathSync(options.root)
  const common = realpathSync(options.common)
  const entries = options.entries.map((entry) => realpathSync(resolve(entry)))
  for (const entry of entries) {
    if (dirname(entry) !== root) throw new Error(`batch entry ${entry} is not a direct child of ${root}`)
  }
  if (new Set(entries).size !== entries.length) throw new Error("batch names an entry twice")
  const rows = new Map<string, BatchRow>()
  const warnings: { entry: string; phase: "pre" | "held"; message: string }[] = []
  // 34127 (@cto 2026-11-24): set once the preliminary pass has ordered its proved entries; absent until then.
  let candidatesForResult: readonly string[] | undefined
  const recordWarnings = (proof: RetentionVerifyResult, phase: "pre" | "held"): void => {
    for (const message of proof.certificate?.warnings ?? []) warnings.push({ entry: proof.entry, phase, message })
  }
  // 37792 (@cto 93f4ba37): one scope per pass, so five entries fsck /hh/dev/.git once rather than five times.
  // 37854: the pass's ref-walk fragments are kept too, so entry 2 reuses the walks entry 1 paid for. The scope is per
  // phase on purpose: the held pass exists because a store may change after the preliminary one, so it must re-walk.
  const scopes = new Map<"pre" | "held", CustodyRunScope>()
  const runScopeFor = (phase: "pre" | "held"): CustodyRunScope => {
    const existing = scopes.get(phase)
    if (existing !== undefined) return existing
    const scope = new CustodyRunScope(join(options.artifactDir, "common", "custody-fragments", phase))
    scopes.set(phase, scope)
    return scope
  }
  // 37792 (@cto c1f3a921): one entry may not spend the whole pass. Each not-yet-started entry is given an equal share
  // of what is left, and a share it does not use stays in the pool for the entries after it. The batch deadline is
  // still the hard cap, so this changes when one proof stops, never how long the run may take.
  const entryShare = (entriesLeft: number): Readonly<{ deadline?: number; ms: number }> => {
    if (proofDeadline === undefined) return { ms: 0 }
    const left = proofDeadline - monotonic()
    if (left <= 0) return { deadline: proofDeadline, ms: 0 }
    const ms = Math.floor(left / Math.max(1, entriesLeft))
    return { deadline: Math.min(proofDeadline, monotonic() + ms), ms }
  }
  // 37792 (@cto c1f3a921): the custody scan's phase timings, summed per name, so a receipt separates a cold store's
  // connectivity check from its ordered ref walk instead of reporting one proof total.
  const phases: Record<string, number> = {}
  const recordPhases = (name: string, ms: number): void => {
    phases[name] = (phases[name] ?? 0) + ms
  }
  // 34127 (@cto turn58): the entry's own boundaries are the only non-overlapping buckets. Everything the custody walk
  // names nests inside `child`, so it is accumulated separately and never subtracted from the parent's span.
  const TOP_LEVEL_PHASES: ReadonlySet<string> = new Set(["setup", "child", "drain", "receipt"])
  type EntryTimingState = {
    readonly startMs: number
    endMs?: number
    sliceMs: number
    sliceDeadlineMs?: number
    lastPhase: string
    deadlineCutMs?: number
    readonly phases: Map<string, number>
    readonly subphases: Map<string, number>
    readonly enteredAt: Map<string, number>
    /**
     * 37854 (@cto 7debe1c0): this entry's own ref-walk deltas, from the shared preliminary scope. Created at `0`/`0`
     * and replaced by the measured delta, so it is never absent: `0`/`0` means no eligible walk was observed, not
     * "not measured".
     */
    fragments: Readonly<{ walked: number; reused: number }>
  }
  const timings = new Map<string, EntryTimingState>()
  const timingFor = (entry: string): EntryTimingState => {
    const existing = timings.get(entry)
    if (existing !== undefined) return existing
    const created: EntryTimingState = {
      startMs: monotonic() - batchStarted,
      sliceMs: 0,
      lastPhase: "not-started",
      phases: new Map<string, number>(),
      subphases: new Map<string, number>(),
      enteredAt: new Map<string, number>(),
      fragments: { walked: 0, reused: 0 },
    }
    timings.set(entry, created)
    return created
  }
  // A phase entered but never ended is the phase the entry died in: its elapsed so far is kept, not dropped. A phase
  // reached only after the cut was observed does not claim lastPhase; it is cleanup spend, recorded as such.
  // 34127 (@cto turn60): every instant published here is converted to batch coordinates on arrival, because the verify
  // clock starts at the entry and the receipt is read next to the batch's own boundaries. The custody walk's nested
  // phases arrive as `spend` events carrying the measured duration of the operation that ran, so the `witnessFsck`
  // window staying open under `refGraph` can never charge the graph's time to fsck.
  const recordEntryTiming =
    (entry: string) =>
    (event: Readonly<{ kind: "enter" | "end" | "spend"; phase: string; ms: number; claimsPhase?: boolean }>): void => {
      const state = timingFor(entry)
      if (event.kind === "spend") {
        state.subphases.set(event.phase, (state.subphases.get(event.phase) ?? 0) + Math.max(0, event.ms))
        return
      }
      const atBatchMs = state.startMs + event.ms
      if (event.kind === "enter") {
        if (event.claimsPhase === false) {
          if (state.deadlineCutMs === undefined) state.deadlineCutMs = atBatchMs
        } else {
          state.lastPhase = event.phase
        }
        state.enteredAt.set(event.phase, event.ms)
        return
      }
      const started = state.enteredAt.get(event.phase)
      state.enteredAt.delete(event.phase)
      // Only the entry's own top-level intervals are read from their window: they never overlap. A nested custody phase
      // that ever reported an `end` instead would still take its number from `spend`, never from window arithmetic.
      if (TOP_LEVEL_PHASES.has(event.phase)) {
        const spend = Math.max(0, event.ms - (started ?? 0))
        state.phases.set(event.phase, (state.phases.get(event.phase) ?? 0) + spend)
      }
    }
  const verifyOptions = (
    entry: string,
    phase: "pre" | "held",
    sharedDeadline?: number,
    /**
     * 34127 (@cto 536e2c15): a vanish rescan must not join the pass scopes. Both memoize what they read — the index
     * keeps a failed build for the rest of the phase, the run scope keeps per-store verdicts — so a store that came
     * back would be replayed as still gone. Each round gets its own pair, and it reports no entry timings: those
     * describe the preliminary proof, which already ended.
     */
    rescan?: CustodyRunScope,
  ): RetentionVerifyOptions => {
    // exactOptionalPropertyTypes: a shared spread of `number | undefined` is not assignable to `deadline?: number`, so
    // the absence is decided here where the type can narrow (red on the pin before this, TS2375).
    const deadline = sharedDeadline ?? proofDeadline
    return {
      custodyPhases: recordPhases,
      // 34127 (@cto turn58 (b)): the timings describe the PRELIMINARY proof only. A no-apply batch returns before the
      // held re-verification, and a held pass runs under the existing shared deadline with no per-entry slice to report,
      // so it keeps the existing held/window reporting rather than folding into these boundaries.
      ...(phase === "pre" && rescan === undefined ? { entryTimings: recordEntryTiming(entry) } : {}),
      // 34127 (@cto turn58): one clock for the entry's boundaries and the proof deadline it is measured against.
      monotonic,
      entry,
      root,
      namespaceRoots: options.namespaceRoots,
      artifactDir: join(options.artifactDir, basename(entry), phase),
      commonArtifactDir: join(options.artifactDir, "common"),
      ...(options.gitRun === undefined ? {} : { gitRun: options.gitRun }),
      ...(options.gitStream === undefined ? {} : { gitStream: options.gitStream }),
      ...(options.targetBranch === undefined ? {} : { custodyTargetBranch: options.targetBranch }),
      ...(options.remoteRedundancy === undefined ? {} : { remoteRedundancy: options.remoteRedundancy }),
      ...(options.fullProof === undefined ? {} : { fullProof: options.fullProof }),
      custodyRunScope: rescan ?? runScopeFor(phase),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(deadline === undefined ? {} : { deadline }),
      ...(options.allowTemporaryArtifactDir === undefined
        ? {}
        : { allowTemporaryArtifactDir: options.allowTemporaryArtifactDir }),
    }
  }

  // ---- One shared scan, recorded for the delta ------------------------------------------------
  const record = newEstateWalkRecord()
  const scanStarted = monotonic()
  const scan = await scanEstate(
    options.namespaceRoots,
    entries,
    options.scanBounds ?? BATCH_ESTATE_BOUNDS,
    Date.now,
    record,
  )
  const scanSummary = {
    status: scan.status,
    detail: scan.detail,
    ms: Math.round(monotonic() - scanStarted),
    alternatesFiles: scan.alternatesFiles,
    excluded: scan.danglingAlternates.length,
  }
  const ownerSummary: { current?: RetentionBatchResult["owners"] } = {}
  // #34127: `.retired` stays inside the scan; these roots only steer leasing and ageing.
  const retiredRoots = [
    ...new Set(
      options.namespaceRoots
        .filter((namespace) => existsSync(namespace))
        .map((namespace) => join(realpathSync(namespace), RETIRED_DIR))
        .filter((retiredRoot) => existsSync(retiredRoot)),
    ),
  ].sort()
  const retiredSummary: { current?: readonly RetiredAgedRow[] } = {}
  const ageRetired = async (): Promise<void> => {
    if (options.retiredMaxAgeMs === undefined) return
    retiredSummary.current = await ageRetiredNamespace({
      retiredRoots,
      borrowers: scan.borrowers,
      clockMs: (options.clock ?? new Date()).getTime(),
      maxAgeMs: options.retiredMaxAgeMs,
      apply,
    })
  }
  const byteSummary: { current?: Awaited<ReturnType<typeof measureRetainedBytes>> } = {}
  const evidenceSummary: { current?: Awaited<ReturnType<typeof measureRetainedBytes>> } = {}
  // The byte total is a measurement of the trees being removed, taken once the rows are final: it is the number an
  // operator approves a deletion against, so it is never an estimate from the manifests (which carry path -> sha256 and
  // no sizes) and it names any subtree it could not read. A dry run is where that number is read, so it measures there
  // too, not only on the apply path.
  const measurePlannedBytes = async (): Promise<void> => {
    evidenceSummary.current = await measureRetainedBytes([
      ...entries.map((entry) => join(options.artifactDir, basename(entry))),
      join(options.artifactDir, "common"),
    ])
    byteSummary.current = await measureRetainedBytes(
      entries.filter((entry) => {
        const outcome = rows.get(entry)?.outcome
        return outcome === "would-retire" || outcome === "retired"
      }),
    )
  }
  // 34127 (@cto 2026-11-24): one place decides whether a stop is a time stop or a condition, so every return site gets
  // the same reading and a new stop cannot be added without landing in one of the three kinds.
  const stopKind = (message: string | undefined): RetentionBatchResult["stoppedKind"] => {
    if (message === undefined) return undefined
    if (message.startsWith("proof-deadline")) return "deadline"
    if (message.startsWith("lease budget")) return "budget"
    if (message.startsWith("census-shifted")) return "shifted"
    return "stop"
  }
  const cheapTotals = { live: 0, fallThrough: 0, ms: 0 }
  const cheapTally = (proof: RetentionVerifyResult | undefined): void => {
    if (proof?.cheapGate === undefined) return
    if (proof.cheapGate.state === "published" && proof.verdict === "candidate") cheapTotals.live += 1
    else cheapTotals.fallThrough += 1
    cheapTotals.ms += proof.cheapGate.ms
  }
  // 34127 (@cto 2026-11-26): one gate's milliseconds, from the pass that decided the row plus that entry's custody
  // sub-phases. Undefined when the pass recorded neither, so a row never claims a timing it did not measure.
  const gateTimings = (
    proof: RetentionVerifyResult | undefined,
    subphases: ReadonlyMap<string, number> | undefined,
  ): Readonly<Record<string, number>> | undefined => {
    const measured: Record<string, number> = {}
    for (const gate of proof?.gates ?? []) if (gate.ms !== undefined) measured[gate.gate] = gate.ms
    for (const [phase, ms] of subphases ?? []) measured[phase] = Math.round(ms)
    return Object.keys(measured).length === 0 ? undefined : measured
  }
  const batchResult = (windows: BatchWindow[], stopped?: string): RetentionBatchResult => ({
    apply,
    ...(cheapTotals.live + cheapTotals.fallThrough === 0 ? {} : { cheapGate: { ...cheapTotals } }),
    warnings,
    ...(Object.keys(phases).length === 0 ? {} : { proofPhases: { ...phases } }),
    ...(timings.size === 0
      ? {}
      : {
          preliminaryEntryTimings: Object.fromEntries(
            [...timings].map(([entry, state]) => {
              const endMs = state.endMs ?? monotonic() - batchStarted
              // 34127 (@cto turn58): only the entry's own top-level buckets count against its slice; the custody walk's
              // nested phases sit beside them. The residual is reported as measured and never clamped to zero, so an
              // overlap or a post-deadline stretch stays visible instead of being absorbed into silence.
              const accounted = [...state.phases.values()].reduce((sum, ms) => sum + ms, 0)
              const receiptMs = state.phases.get("receipt")
              return [
                entry,
                {
                  startMs: state.startMs,
                  endMs,
                  sliceMs: state.sliceMs,
                  ...(state.sliceDeadlineMs === undefined ? {} : { sliceDeadlineMs: state.sliceDeadlineMs }),
                  lastPhase: state.lastPhase,
                  ...(state.deadlineCutMs === undefined ? {} : { deadlineCutMs: state.deadlineCutMs }),
                  phases: Object.fromEntries(state.phases),
                  ...(state.subphases.size === 0 ? {} : { subphases: Object.fromEntries(state.subphases) }),
                  ...(receiptMs === undefined ? {} : { receiptMs }),
                  unattributedMs: endMs - state.startMs - accounted,
                  fragments: state.fragments,
                },
              ]
            }),
          ),
        }),
    // 37854 (@cto 7debe1c0): the pass's own counters, so a reader can check that the per-entry deltas add up and see
    // the ratio the next design must move. Absent when no entry in the pass ever reached the walk.
    ...(scopes.get("pre") === undefined
      ? {}
      : {
          preliminaryFragments: {
            walked: scopes.get("pre")?.fragmentUse.walked ?? 0,
            reused: scopes.get("pre")?.fragmentUse.reused ?? 0,
          },
        }),
    scan: scanSummary,
    ...(ownerSummary.current === undefined ? {} : { owners: ownerSummary.current }),
    ...(options.retiredMaxAgeMs === undefined
      ? {}
      : {
          // A batch that stopped first never aged: each directory says so by name, rather than the list going missing.
          retiredAged:
            retiredSummary.current ??
            retiredRoots.flatMap((retiredRoot) =>
              readdirSync(retiredRoot)
                .sort()
                .map((name) => ({
                  path: join(retiredRoot, name),
                  outcome: "skipped" as const,
                  reason: `not aged: the batch stopped first (${stopped ?? "before its scan"})`,
                })),
            ),
        }),
    ...(byteSummary.current === undefined
      ? {}
      : {
          bytesPlanned: byteSummary.current.bytes,
          bytesUnreadable: byteSummary.current.unreadable,
          ...(byteSummary.current.sharedBytes === undefined
            ? {}
            : { bytesSharedLinked: byteSummary.current.sharedBytes }),
        }),
    ...(evidenceSummary.current === undefined
      ? {}
      : { bytesEvidence: evidenceSummary.current.bytes + (evidenceSummary.current.sharedBytes ?? 0) }),
    windows,
    rows: entries.map(
      (entry) => rows.get(entry) ?? { entry, outcome: "not-reached", reason: stopped ?? "not evaluated" },
    ),
    ...(candidatesForResult === undefined ? {} : { candidates: candidatesForResult }),
    ...(stopped === undefined || stopKind(stopped) === undefined
      ? {}
      : { stopped, stoppedKind: stopKind(stopped) as NonNullable<RetentionBatchResult["stoppedKind"]> }),
  })
  // 34127 (@cto 2026-11-26): every row names what each gate cost, from the preliminary pass when nothing else decided
  // it, so the slow gate is named by every run's own JSON rather than by a hand profile after the fact.
  const result = (windows: BatchWindow[], stopped?: string): RetentionBatchResult => {
    for (const [entry, row] of rows) {
      if (row.gates !== undefined) continue
      const gates = gateTimings(preliminary.get(entry), timings.get(entry)?.subphases)
      if (gates !== undefined) rows.set(entry, { ...row, gates })
    }
    return batchResult(windows, stopped)
  }
  if (scan.status === "unknown") {
    const reason = `incomplete: the batch estate scan is unknown: ${scan.detail}`
    for (const entry of entries) rows.set(entry, { entry, outcome: "kept", reason })
    return result([], reason)
  }

  // ---- Preliminary gates per entry, no lease ----------------------------------------------------
  // #35062: one witness index for the whole preliminary pass, built by the first member with at-risk objects.
  const preliminaryIndex = new CustodyIndexScope(join(options.artifactDir, "common", "custody-index", "pre"))
  const preliminary = new Map<string, RetentionVerifyResult>()
  const kept = new Map<string, string>()
  let notStarted = 0
  let entriesLeft = entries.length
  for (const entry of entries) {
    const share = entryShare(entriesLeft)
    entriesLeft -= 1
    const entryTiming = timingFor(entry)
    entryTiming.sliceMs = share.ms
    if (share.deadline !== undefined) entryTiming.sliceDeadlineMs = share.deadline - proofStartWall
    if (proofDeadlinePassed()) {
      notStarted++
      // 34127 (@cto turn58): an entry that never started ends where it was skipped; later batch work is not its spend.
      entryTiming.endMs = monotonic() - batchStarted
      kept.set(
        entry,
        `unproved: the batch proof deadline (${String(options.proofDeadlineMs)} ms) passed before this entry's proof began; select it again in a later batch`,
      )
      continue
    }
    // 37854 (@cto 7debe1c0): the counters live on the pass scope, so each entry's own share of them is the delta across
    // its proof. Read before and after the call, and set even when the entry is cut inside the walk.
    const preScope = runScopeFor("pre")
    const fragmentsBefore = { walked: preScope.fragmentUse.walked, reused: preScope.fragmentUse.reused }
    const proof = await inspectRetainedEntryInBatch(
      verifyOptions(entry, "pre", share.deadline),
      entryView(scan, entry),
      entries,
      preliminaryIndex,
    )
    entryTiming.fragments = {
      walked: preScope.fragmentUse.walked - fragmentsBefore.walked,
      reused: preScope.fragmentUse.reused - fragmentsBefore.reused,
    }
    recordWarnings(proof, "pre")
    preliminary.set(entry, proof)
    cheapTally(proof)
    if (proof.verdict !== "candidate") {
      // An entry whose own share ran out is unknown because of the schedule, never because its store looked corrupt and
      // never as a reusable negative custody verdict; the reason names the slice so a later run can tell them apart.
      const sliced =
        share.deadline !== undefined &&
        proofDeadline !== undefined &&
        share.deadline < proofDeadline &&
        monotonic() >= share.deadline &&
        proof.verdict === "unknown"
      const slice = sliced
        ? ` (entry proof slice of ${String(share.ms)} ms of the ${String(options.proofDeadlineMs)} ms batch budget)`
        : ""
      kept.set(entry, `${proof.verdict}: ${proof.reasons.join("; ")}${slice}`)
    }
    entryTiming.endMs = monotonic() - batchStarted
  }
  // 34127 (@cto 536e2c15): a store the inventory recorded but that was gone when custody read it is a moving estate,
  // not a verdict. Re-inventory and re-evaluate only the entries that hit that race, at most 3 rounds. Custody is
  // recomputed from the new set and never patched, and a path still vanishing after the third round keeps the entry
  // unknown with every round's paths named.
  const vanishRounds: string[][] = []
  let passScan = scan
  for (let round = 1; round <= 3; round += 1) {
    const hit = entries.filter((entry) => {
      const proof = preliminary.get(entry)
      return proof !== undefined && proof.verdict === "unknown" && (proof.vanishedAtRead?.length ?? 0) > 0
    })
    if (hit.length === 0) break
    // One fresh index and run scope per round, for the same reason the held window builds its own: both memoize what
    // they read, so replaying a round through the preliminary pair would report the very store that came back as gone.
    const roundIndex = new CustodyIndexScope(join(options.artifactDir, "common", "custody-index", `vanish-${round}`))
    const roundScope = new CustodyRunScope(join(options.artifactDir, "common", "custody-fragments", `vanish-${round}`))
    vanishRounds.push([...new Set(hit.flatMap((entry) => preliminary.get(entry)?.vanishedAtRead ?? []))].sort())
    passScan = await scanEstate(
      options.namespaceRoots,
      entries,
      options.scanBounds ?? BATCH_ESTATE_BOUNDS,
      Date.now,
      newEstateWalkRecord(),
    )
    let hitLeft = hit.length
    for (const entry of hit) {
      const share = entryShare(hitLeft)
      hitLeft -= 1
      // A spent budget cannot buy a re-proof. The preliminary verdict stands, so the row still names the paths it lost
      // instead of replacing that evidence with a deadline cut.
      if (share.deadline !== undefined && share.ms === 0) continue
      const proof = await inspectRetainedEntryInBatch(
        verifyOptions(entry, "pre", share.deadline, roundScope),
        entryView(passScan, entry),
        entries,
        roundIndex,
      )
      recordWarnings(proof, "pre")
      preliminary.set(entry, proof)
      if (proof.verdict === "candidate") {
        kept.delete(entry)
      } else {
        kept.set(entry, `${proof.verdict}: ${proof.reasons.join("; ")}`)
      }
    }
  }
  // A path that survived all three rounds marks the entry's reason, so a reader can tell "the estate kept moving" from
  // "the store is genuinely unprovable" without re-reading the evidence directory.
  if (vanishRounds.length > 0) {
    const named = vanishRounds.map((paths, index) => `round ${String(index + 1)}: ${paths.join(", ")}`).join("; ")
    for (const entry of entries) {
      const proof = preliminary.get(entry)
      const still = proof?.verdict === "unknown" && (proof.vanishedAtRead?.length ?? 0) > 0
      if (!still) continue
      kept.set(entry, `${kept.get(entry) ?? "unknown"}; the estate vanished under it (${named})`)
    }
  }
  closeOverKeptBorrowers(entries, passScan.borrowers, kept)
  for (const [entry, reason] of kept) rows.set(entry, { entry, outcome: "kept", reason })
  // A proof the deadline cut short already reads `unknown` in its own row; this names the cut for the whole batch.
  const deadlineStop = proofDeadlinePassed()
    ? `proof-deadline: the batch proof deadline (${String(options.proofDeadlineMs)} ms) passed during the preliminary proofs; ${String(notStarted)} entr(ies) were not started and any proof still running was kept unknown`
    : undefined

  // Every Git owner of a reached object directory outside the batch, plus registry holders: their EXISTING writer
  // leases are held for the whole window, as the single-entry retire holds them, so no lender moves mid-delete. A
  // missing lease file keeps the entry (retire never creates one), so the dry run names them up front.
  const owners = new Set<string>([common])
  const unproved: string[] = []
  const retiredExcluded: string[] = []
  for (const objects of [
    ...passScan.objectDirs,
    ...passScan.borrowers.filter((edge) => basename(edge.borrower) === "objects").map((edge) => edge.borrower),
  ]) {
    if (entries.some((entry) => within(entry, objects))) continue
    if (retiredRoots.some((retiredRoot) => within(retiredRoot, objects))) {
      if (!retiredExcluded.includes(objects)) retiredExcluded.push(objects)
      continue
    }
    const owner = dirname(objects)
    if (lstatSync(join(owner, "objects"), { throwIfNoEntry: false }) === undefined) {
      unproved.push(objects)
      continue
    }
    if (realpathSync(join(owner, "objects")) !== realpathSync(objects)) unproved.push(objects)
    else owners.add(owner)
  }
  for (const registry of scan.registries) owners.add(dirname(registry))
  const ownerList = [...owners].sort()
  const cold = new Map<string, ColdOwner>()
  const coldCache = new Map<string, ColdOwnerRead | undefined>()
  const coldProofFailedOwners: string[] = []
  const coldProofFailures: string[] = []
  for (const owner of ownerList) {
    const proof = coldOwner(owner, root, common, coldCache)
    if (proof === undefined) continue
    if ("failure" in proof) {
      coldProofFailedOwners.push(owner)
      coldProofFailures.push(`${owner}: ${proof.failure}`)
      console.warn(
        `retention: cannot prove cold owner ${owner}: ${proof.failure}; owner evidence is incomplete, so the batch stops before any deletion`,
      )
    } else cold.set(owner, proof)
  }
  const liveOwners = ownerList.filter((owner) => !cold.has(owner))
  const leaseMissing = liveOwners.filter(
    (owner) => lstatSync(join(owner, "yrd-worktree-mutations", "writer.lock"), { throwIfNoEntry: false }) === undefined,
  )
  // #34960: the owners behind a stop are written out in full, not one example: an operator resolves them owner by
  // owner from these lists (@cto: owners first, no new full scan).
  const ownerListDir = join(options.artifactDir, "owners")
  mkdirSync(ownerListDir, { recursive: true })
  const unprovedList = join(ownerListDir, "unproved.txt")
  const leaseMissingList = join(ownerListDir, "lease-missing.txt")
  const retiredExcludedList = join(ownerListDir, "retired-excluded.txt")
  const identityUnknownList = join(ownerListDir, "identity-unknown-entries.txt")
  const lines = (paths: readonly string[]): string => (paths.length === 0 ? "" : `${[...paths].sort().join("\n")}\n`)
  writeFileSync(unprovedList, lines(unproved))
  writeFileSync(leaseMissingList, lines(leaseMissing))
  writeFileSync(retiredExcludedList, lines(retiredExcluded))
  // #34127 (@chief 2026-11-21 14:20): an object directory with no proved Git owner is a REPORTED SKIP, never a batch
  // stop and never deleted. Only the entries that borrow objects from it lose their proof: its owner cannot be leased,
  // so it could move inside the held window. No other entry is affected — deleting a retained store under this root
  // cannot create, move or empty an outside object directory, and an outside borrower INTO a removal already blocks
  // that entry on its own (survivorIntoRemoval) — so the batch continues with the proved ones.
  const identityUnknown = new Map<string, string[]>()
  for (const entry of entries) {
    const lenders = unproved.filter((objects) =>
      scan.borrowers.some((edge) => within(entry, edge.borrower) && within(objects, edge.target)),
    )
    if (lenders.length === 0) continue
    identityUnknown.set(entry, lenders)
    kept.set(
      entry,
      `identity-unknown: borrows objects from ${String(lenders.length)} object director(ies) with no proved Git owner, e.g. ${lenders[0]}; kept, never deleted (every path in ${unprovedList})`,
    )
  }
  writeFileSync(
    identityUnknownList,
    lines([...identityUnknown].flatMap(([entry, lenders]) => lenders.map((objects) => `${entry}\t${objects}`))),
  )
  if (unproved.length > 0) {
    console.warn(
      `retention: ${String(unproved.length)} object director(ies) have no proved Git owner and cannot be leased; nothing under them is deleted, and ${String(identityUnknown.size)} selected entr(ies) that borrow from them are kept (paths in ${unprovedList}, per-entry skips in ${identityUnknownList})`,
    )
  }
  // @chief asked for the paths AND their bytes: this figure is what an operator resolves owner by owner. Each
  // directory is measured on its own, so a file hard-linked into two of them is counted in both, and a directory the
  // proof deadline cut off is counted as unmeasured rather than as zero.
  const unprovedBytes = { bytes: 0, unreadable: 0, unmeasured: 0 }
  for (const objects of unproved) {
    if (proofDeadlinePassed()) {
      unprovedBytes.unmeasured += 1
      continue
    }
    const measured = await measureRetainedBytes([objects])
    unprovedBytes.bytes += measured.bytes + (measured.sharedBytes ?? 0)
    unprovedBytes.unreadable += measured.unreadable
  }
  ownerSummary.current = {
    total: ownerList.length,
    leaseMissing: leaseMissing.length,
    cold: cold.size,
    liveUnleased: leaseMissing.length,
    coldProofFailed: coldProofFailedOwners.length,
    coldProofFailedOwners,
    unproved: unproved.length,
    ...(leaseMissing[0] === undefined ? {} : { leaseMissingExample: leaseMissing[0] }),
    ...(unproved[0] === undefined ? {} : { unprovedExample: unproved[0] }),
    unprovedList,
    leaseMissingList,
    retiredExcluded: retiredExcluded.length,
    retiredExcludedList,
    identityUnknownEntries: identityUnknown.size,
    identityUnknownList,
    ...(unproved.length === 0 ? {} : { identityUnknownBytes: unprovedBytes.bytes }),
    ...(unprovedBytes.unreadable === 0 ? {} : { identityUnknownUnreadable: unprovedBytes.unreadable }),
    ...(unprovedBytes.unmeasured === 0 ? {} : { identityUnknownUnmeasured: unprovedBytes.unmeasured }),
  }
  // A failed cold-proof read is incomplete owner evidence: the batch reports and stops before any deletion window,
  // dry run included (exit 2 through the CLI and Yrd), rather than keeping the owner live inside a green run (#34920,
  // @cto 34920-retention-calls-r1). An unproved owner no longer stops it (#34127, above); it keeps only its borrowers.
  const ownerStop =
    coldProofFailures[0] !== undefined
      ? `@gate/retention-cold-proof: cold-proof-incomplete: ${coldProofFailures.length} owner(s) have unreadable cold evidence (each named on stderr), e.g. ${coldProofFailures[0]}`
      : leaseMissing.includes(common)
        ? `lease-missing: common owner ${common} has no existing writer lease`
        : undefined
  closeOverKeptBorrowers(entries, scan.borrowers, kept)
  const candidates = borrowerOrder(entries, scan.borrowers, kept)
  candidatesForResult = candidates
  for (const [entry, reason] of kept) rows.set(entry, { entry, outcome: "kept", reason })
  const leasedOwners = liveOwners.filter((owner) => !leaseMissing.includes(owner))

  if (!apply) {
    for (const entry of candidates) {
      const proof = preliminary.get(entry)
      const evidence = proof?.certificate?.path
      const cheap = proof?.cheapGate
      rows.set(entry, {
        entry,
        outcome: "would-retire",
        reason:
          cheap?.state === "published"
            ? `nothing-unpublished: ${cheap.reason} (${String(cheap.ms)} ms); a held re-verify answers the same question at delete time`
            : ownerStop === undefined
              ? "every gate passed against the shared scan; a held re-verify runs at delete time"
              : `every gate passed, but apply would stop first: ${ownerStop}`,
        ...(evidence === undefined ? {} : { evidence }),
      })
    }
    await measurePlannedBytes()
    const stops = [ownerStop, deadlineStop].filter((stop): stop is string => stop !== undefined)
    if (stops.length === 0) await ageRetired()
    return result([], stops.length === 0 ? undefined : stops.join("; "))
  }
  if (ownerStop !== undefined) {
    for (const entry of candidates) rows.set(entry, { entry, outcome: "kept", reason: ownerStop })
    return result([], ownerStop)
  }
  // The held re-verify shares the same deadline: past it every held proof would be unknown, so no lease is taken.
  if (deadlineStop !== undefined) {
    for (const entry of candidates) rows.set(entry, { entry, outcome: "kept", reason: deadlineStop })
    return result([], deadlineStop)
  }
  options.afterScan?.()

  // ---- One lease window: delta first, then held re-verify and delete per entry ------------------
  const windows: BatchWindow[] = []
  const verifiedRemoved: string[] = []
  // Only current pointer reads omit our own verified removals. The verifier and certificate retain the full
  // frozen estate, so this bookkeeping cannot hide drift in the preliminary/held proof facts.
  const currentPointers = (proof: RetentionVerifyResult): ReturnType<typeof pointers> => {
    if (proof.estate === undefined) return pointers(proof)
    return pointers({
      ...proof,
      estate: {
        ...proof.estate,
        registries: proof.estate.registries.filter(
          (registry) => !verifiedRemoved.some((entry) => within(entry, registry)),
        ),
      },
    })
  }
  let next = 0
  if (candidates.length > 0) {
    const commonPath = join(common, "yrd-worktree-mutations", "writer.lock")
    const reportReapedLease = (path: string, detail: string): void => {
      console.warn(`retention: ${detail} (${path})`)
    }
    const takeCommonLease = (create: boolean): FlockHandle | null =>
      acquireFlockWithTimeout(commonPath, DEFAULT_MUTATION_LOCK_WAIT_MS, {
        ...(create ? {} : { create: false }),
        createParent: false,
        noFollow: true,
      })
    let commonLease = takeCommonLease(false)
    if (commonLease === null) {
      // #33010 (@cto 2026-11-25): a lease whose recorded pid is dead and which no process holds a flock on is reaped
      // by name before the batch gives up, never left to hold every later drain for an hour.
      const reap = reapStaleWriterLease(commonPath)
      if (reap.reaped) {
        reportReapedLease(commonPath, reap.detail)
        commonLease = takeCommonLease(true)
      }
    }
    if (commonLease === null) {
      return result(windows, `lease-held: common lease ${commonPath} is held; nothing more deleted`)
    }
    const heldFrom = monotonic()
    // #35062: the held window builds its own witness index from fresh reads, never the preliminary one, so a ref
    // that moved or an object that went bad after the preliminary pass keeps its entry.
    const heldIndex = new CustodyIndexScope(join(options.artifactDir, "common", "custody-index", "held"))
    const ownerLeases: ReturnType<typeof acquireRemovalWriterLeases>[] = []
    const windowEntries: string[] = []
    let deltaStatus: BatchWindow["delta"] = "unchanged"
    let deltaMs = 0
    let deltaCounts = {
      filesStatted: 0,
      filesRead: 0,
      discoveredStores: 0,
      prunedDirs: 0,
      walkedDirs: 0,
      vanishedStores: 0,
    }
    // #33010 (@cto c9e2666a, a6752202): an outside owner whose Git directory is gone now (a yrd-submit candidate
    // worktree, a closed environment) can move no lender, so it is named and left out of the lease set instead of
    // ending the batch on realpath's ENOENT. The common owner stays required. An owner that reappears with a loan into
    // an entry before its delete is caught by that entry's held re-verification, as any new borrower is.
    const vanishedOwners = leasedOwners.filter(
      (owner) => owner !== common && lstatSync(owner, { throwIfNoEntry: false }) === undefined,
    )
    const presentOwners = leasedOwners.filter((owner) => !vanishedOwners.includes(owner))
    let stopped: string | undefined
    try {
      // Acquire outside owners BEFORE checking the delta; otherwise a leased writer could change an alternate
      // after that check and before its lease is acquired. Hold the first entry's leases through its deletion too.
      const first = candidates[next] as string
      ownerLeases.push(
        acquireRemovalWriterLeases(first, undefined, {
          existingOnly: true,
          additionalGitDirs: presentOwners,
          skip: [commonPath],
          onReapedLease: reportReapedLease,
        }),
      )
      // #33010 (@cto 2026-11-25): scoped by reference — only a changed or new alternates file that names an entry
      // this window still deletes ends the batch, so unrelated churn (a queue worktree, a build clone) is counted
      // and ignored instead of stopping every store on the host.
      const delta = await estateDelta(record, scan, { selected: candidates.slice(next) })
      if (delta.status === "unchanged") {
        deltaCounts = {
          filesStatted: delta.filesStatted,
          filesRead: delta.filesRead,
          discoveredStores: delta.discoveredStores,
          prunedDirs: delta.prunedDirs,
          walkedDirs: delta.walkedDirs,
          vanishedStores: delta.vanishedStores,
        }
      }
      const coldChanged = coldOwnerChanged(cold)
      deltaMs = Math.round(monotonic() - heldFrom)
      if (delta.status === "changed" || coldChanged !== undefined) {
        deltaStatus = "changed"
        stopped = `census-shifted: ${coldChanged ?? (delta.status === "changed" ? delta.detail : "cold owner changed")}; the batch deleted nothing more`
      } else {
        // Each entry costs about what the last one did; stop before the hold would pass the budget.
        let lastEntryMs = 0
        while (next < candidates.length && monotonic() - heldFrom + lastEntryMs < budget) {
          const entry = candidates[next] as string
          next += 1
          if (kept.has(entry)) continue
          const entryStarted = monotonic()
          windowEntries.push(entry)
          // The window's first entry also carries every outside owner's lease, once: flock is per open file, so a
          // second acquisition of the same lease in this process would refuse itself.
          if (windowEntries.length > 1) {
            ownerLeases.push(
              acquireRemovalWriterLeases(entry, undefined, {
                existingOnly: true,
                skip: [commonPath],
                onReapedLease: reportReapedLease,
              }),
            )
          }
          const changedCold = coldOwnerChanged(cold)
          if (changedCold !== undefined) {
            stopped = `census-shifted: ${changedCold}; the batch deleted nothing more`
            rows.set(entry, { entry, outcome: "kept", reason: stopped })
            break
          }
          const pre = preliminary.get(entry) as RetentionVerifyResult
          const held = await inspectRetainedEntryInBatch(
            verifyOptions(entry, "held"),
            entryView(scan, entry),
            entries,
            heldIndex,
          )
          recordWarnings(held, "held")
          const before = proofFacts(pre)
          const after = held.verdict === "candidate" ? proofFacts(held) : undefined
          const heldPointers = after === undefined ? undefined : currentPointers(held)
          const stat = lstatSync(entry)
          if (
            after === undefined ||
            heldPointers === undefined ||
            before.facts !== after.facts ||
            JSON.stringify(currentPointers(pre)) !== JSON.stringify(heldPointers) ||
            held.entryDevIno !== `${stat.dev}:${stat.ino}`
          ) {
            kept.set(
              entry,
              `census-shifted: preliminary and held proofs differ${after === undefined ? `: ${held.reasons.join("; ")}` : ""}`,
            )
            closeOverKeptBorrowers(entries, scan.borrowers, kept)
            for (const [member, reason] of kept) rows.set(member, { entry: member, outcome: "kept", reason })
          } else {
            let phase = "deletion"
            try {
              const changedCold = coldOwnerChanged(cold)
              if (changedCold !== undefined) {
                stopped = `census-shifted: ${changedCold}; the batch deleted nothing more`
                rows.set(entry, { entry, outcome: "kept", reason: stopped })
                break
              }
              // Invalidate selection before bulk removal: a kill/partial removal leaves a named manifest-less
              // remainder for the next census, never another automatically selected expired store (@cto d35ae483).
              rmSync(join(entry, "manifest.json"), { force: false })
              rmSync(entry, { recursive: true, force: false })
              if (lstatSync(entry, { throwIfNoEntry: false }) !== undefined) {
                throw new Error(`entry ${entry} is still present after deletion`)
              }
              phase = "pointer cleanup"
              for (const pointer of heldPointers) {
                if (within(entry, pointer.path)) continue
                if (pointer.retained === join(entry, "modules") && pointer.manifest === join(entry, "manifest.json")) {
                  removeRetainedPointer(pointer)
                }
              }
              verifiedRemoved.push(entry)
              for (const owner of cold.keys()) {
                if (within(entry, owner)) cold.delete(owner)
              }
            } catch (error) {
              const state = lstatSync(entry, { throwIfNoEntry: false }) === undefined ? "gone" : "partly present"
              rows.set(entry, {
                entry,
                outcome: "failed",
                reason: `${error instanceof Error ? error.message : String(error)}; ${phase} failed; actual entry state: ${state}; no retry`,
                gates: gateTimings(held, timings.get(entry)?.subphases) ?? {},
                deleteMs: Math.round(monotonic() - entryStarted),
              })
              stopped = `retirement-partial at ${entry}; the batch deleted nothing more`
              break
            }
            rows.set(entry, {
              entry,
              outcome: "retired",
              // #38246: with no certificate, this row is the only record of why the copy was deletable, so it carries
              // the whole answer: the environment, its heads and the remote refs that proved them, plus what it cost.
              reason:
                held.cheapGate === undefined
                  ? "absence verified"
                  : `absence verified; retired with no content or custody gate: ${held.cheapGate.reason} (${String(held.cheapGate.ms)} ms)`,
              evidence: after.path,
              gates: gateTimings(held, timings.get(entry)?.subphases) ?? {},
              deleteMs: Math.round(monotonic() - entryStarted),
            })
          }
          lastEntryMs = monotonic() - entryStarted
        }
        if (stopped === undefined && next < candidates.length) {
          stopped = `lease budget ${budget}ms exhausted; remaining entries kept; rerun with a fresh estate scan`
        }
      }
    } catch (error) {
      stopped = `retirement stopped: ${error instanceof Error ? error.message : String(error)}; nothing more deleted`
    } finally {
      for (const lease of ownerLeases.reverse()) lease.release()
      commonLease.release()
    }
    windows.push({
      entries: windowEntries,
      delta: deltaStatus,
      deltaMs,
      holdMs: Math.round(monotonic() - heldFrom),
      ...deltaCounts,
      vanishedOwners,
    })
    if (stopped !== undefined) {
      for (const entry of candidates.slice(next)) {
        if (!rows.has(entry)) rows.set(entry, { entry, outcome: "kept", reason: stopped })
      }
      return result(windows, stopped)
    }
  }
  await measurePlannedBytes()
  await ageRetired()
  return result(windows)
}
