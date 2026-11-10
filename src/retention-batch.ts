/**
 * A retirement BATCH (#33010, @cto dc77f630): one shared gate-3 estate scan reused across many retained entries,
 * because a fresh scan per entry costs 469-496 s on the live estate (149,443 alternates files) and cannot fit any
 * per-entry bound. Every other gate still runs per entry, twice: a preliminary pass with no lease, then a held
 * re-verify under the lease whose facts must equal the preliminary ones before that entry is deleted.
 *
 * The lease is NOT held across the scan. Instead each lease window opens with {@link estateDelta}: the estate's SET of
 * object directories, alternates files, `objects` links and borrower registries must still be what the scan saw.
 * Writers that never take the lease exist (a hand-run clone or `git worktree add` writes an alternates file with no
 * lease); that comparison, not the lease, is what catches them between scan and delete. Any change ends the batch
 * with nothing deleted. The lease is then held with no gap through that window's deletes, and its hold time is
 * measured; a window closes once its hold would pass the budget (about 60 s).
 *
 * Dry run by default: `apply: false` reports the entries that would be retired and why every other one is kept.
 */
import { lstatSync, realpathSync, rmSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { acquireFlockWithTimeout, type FlockHandle } from "@bearly/flock"
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
import { inspectRetainedEntryInBatch, type RetentionVerifyOptions, type RetentionVerifyResult } from "./retention-verify.ts"
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
  clock?: Date
  monotonic?: () => number
  allowTemporaryArtifactDir?: boolean
  /** Test seam: the batch scan bounds; production uses {@link BATCH_ESTATE_BOUNDS}. */
  scanBounds?: EstateScanBounds
  /** Test seam: runs between the scan and the first lease window, as a writer with no lease would. */
  afterScan?: () => void
}>

export type BatchRow = Readonly<{
  entry: string
  outcome: "would-retire" | "retired" | "kept" | "failed" | "not-reached"
  reason: string
  evidence?: string
}>

export type BatchWindow = Readonly<{
  entries: readonly string[]
  delta: "unchanged" | "changed"
  deltaMs: number
  holdMs: number
}>

export type RetentionBatchResult = Readonly<{
  apply: boolean
  scan: Readonly<{ status: EstateScan["status"]; detail: string; ms: number; alternatesFiles: number; excluded: number }>
  /** The outside Git owners whose existing writer leases a window holds, and how many cannot be leased. */
  owners?: Readonly<{
    total: number
    leaseMissing: number
    unproved: number
    leaseMissingExample?: string
    unprovedExample?: string
  }>
  windows: readonly BatchWindow[]
  rows: readonly BatchRow[]
  /** Set when the batch stopped early; every entry not yet deleted is kept. */
  stopped?: string
}>

function within(root: string, path: string): boolean {
  const part = relative(root, path)
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part))
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

export async function retireRetainedBatch(options: RetentionBatchOptions): Promise<RetentionBatchResult> {
  const apply = options.apply === true
  const monotonic = options.monotonic ?? (() => performance.now())
  const budget = options.holdBudgetMs ?? 60_000
  const root = realpathSync(options.root)
  const common = realpathSync(options.common)
  const entries = options.entries.map((entry) => realpathSync(resolve(entry)))
  for (const entry of entries) {
    if (dirname(entry) !== root) throw new Error(`batch entry ${entry} is not a direct child of ${root}`)
  }
  if (new Set(entries).size !== entries.length) throw new Error("batch names an entry twice")
  const rows = new Map<string, BatchRow>()
  const verifyOptions = (entry: string, phase: "pre" | "held"): RetentionVerifyOptions => ({
    entry,
    root,
    namespaceRoots: options.namespaceRoots,
    artifactDir: join(options.artifactDir, basename(entry), phase),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.allowTemporaryArtifactDir === undefined
      ? {}
      : { allowTemporaryArtifactDir: options.allowTemporaryArtifactDir }),
  })

  // ---- One shared scan, recorded for the delta ------------------------------------------------
  const record = newEstateWalkRecord()
  const scanStarted = monotonic()
  const scan = scanEstate(options.namespaceRoots, entries, options.scanBounds ?? BATCH_ESTATE_BOUNDS, Date.now, record)
  const scanSummary = {
    status: scan.status,
    detail: scan.detail,
    ms: Math.round(monotonic() - scanStarted),
    alternatesFiles: scan.alternatesFiles,
    excluded: scan.danglingAlternates.length,
  }
  let ownerSummary: RetentionBatchResult["owners"]
  const result = (windows: BatchWindow[], stopped?: string): RetentionBatchResult => ({
    apply,
    scan: scanSummary,
    ...(ownerSummary === undefined ? {} : { owners: ownerSummary }),
    windows,
    rows: entries.map(
      (entry) => rows.get(entry) ?? { entry, outcome: "not-reached", reason: stopped ?? "not evaluated" },
    ),
    ...(stopped === undefined ? {} : { stopped }),
  })
  if (scan.status === "unknown") {
    const reason = `incomplete: the batch estate scan is unknown: ${scan.detail}`
    for (const entry of entries) rows.set(entry, { entry, outcome: "kept", reason })
    return result([], reason)
  }

  // ---- Preliminary gates per entry, no lease ----------------------------------------------------
  const preliminary = new Map<string, RetentionVerifyResult>()
  const kept = new Map<string, string>()
  for (const entry of entries) {
    const proof = await inspectRetainedEntryInBatch(verifyOptions(entry, "pre"), entryView(scan, entry), entries)
    preliminary.set(entry, proof)
    if (proof.verdict !== "candidate") kept.set(entry, `${proof.verdict}: ${proof.reasons.join("; ")}`)
  }
  closeOverKeptBorrowers(entries, scan.borrowers, kept)
  for (const [entry, reason] of kept) rows.set(entry, { entry, outcome: "kept", reason })
  const candidates = entries.filter((entry) => !kept.has(entry))

  // Every Git owner of a reached object directory outside the batch, plus registry holders: their EXISTING writer
  // leases are held for the whole window, as the single-entry retire holds them, so no lender moves mid-delete. A
  // missing lease file keeps the entry (retire never creates one), so the dry run names them up front.
  const owners = new Set<string>([common])
  const unproved: string[] = []
  for (const objects of [
    ...scan.objectDirs,
    ...scan.borrowers.filter((edge) => basename(edge.borrower) === "objects").map((edge) => edge.borrower),
  ]) {
    if (entries.some((entry) => within(entry, objects))) continue
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
  const leaseMissing = ownerList.filter(
    (owner) => lstatSync(join(owner, "yrd-worktree-mutations", "writer.lock"), { throwIfNoEntry: false }) === undefined,
  )
  ownerSummary = {
    total: ownerList.length,
    leaseMissing: leaseMissing.length,
    unproved: unproved.length,
    ...(leaseMissing[0] === undefined ? {} : { leaseMissingExample: leaseMissing[0] }),
    ...(unproved[0] === undefined ? {} : { unprovedExample: unproved[0] }),
  }
  const ownerStop =
    unproved.length > 0
      ? `identity-unknown: ${unproved.length} object director(ies) have no proved Git owner, e.g. ${unproved[0]}`
      : leaseMissing.length > 0
        ? `lease-missing: ${leaseMissing.length} of ${ownerList.length} owner(s) have no existing writer lease, e.g. ${leaseMissing[0]}; retirement never creates one`
        : undefined

  if (!apply) {
    for (const entry of candidates) {
      const evidence = preliminary.get(entry)?.certificate?.path
      rows.set(entry, {
        entry,
        outcome: "would-retire",
        reason:
          ownerStop === undefined
            ? "every gate passed against the shared scan; a held re-verify runs at delete time"
            : `every gate passed, but apply would stop first: ${ownerStop}`,
        ...(evidence === undefined ? {} : { evidence }),
      })
    }
    return result([], ownerStop)
  }
  if (ownerStop !== undefined) {
    for (const entry of candidates) rows.set(entry, { entry, outcome: "kept", reason: ownerStop })
    return result([], ownerStop)
  }
  options.afterScan?.()

  // ---- Lease windows: delta first, then held re-verify and delete per entry ---------------------
  const windows: BatchWindow[] = []
  let next = 0
  while (next < candidates.length) {
    const commonPath = join(common, "yrd-worktree-mutations", "writer.lock")
    const commonLease: FlockHandle | null = acquireFlockWithTimeout(commonPath, DEFAULT_MUTATION_LOCK_WAIT_MS, {
      create: false,
      createParent: false,
      noFollow: true,
    })
    if (commonLease === null) return result(windows, `lease-held: common lease ${commonPath} is held; nothing more deleted`)
    const heldFrom = monotonic()
    const ownerLeases: ReturnType<typeof acquireRemovalWriterLeases>[] = []
    const windowEntries: string[] = []
    let deltaStatus: BatchWindow["delta"] = "unchanged"
    let deltaMs = 0
    let stopped: string | undefined
    try {
      const delta = estateDelta(record, scan)
      deltaMs = Math.round(monotonic() - heldFrom)
      if (delta.status === "changed") {
        deltaStatus = "changed"
        stopped = `census-shifted: ${delta.detail}; the batch deleted nothing more`
      } else {
        // Each entry costs about what the last one did; stop before the hold would pass the budget.
        let lastEntryMs = 0
        while (next < candidates.length && monotonic() - heldFrom + lastEntryMs < budget) {
          const entry = candidates[next] as string
          next += 1
          const entryStarted = monotonic()
          windowEntries.push(entry)
          // The window's first entry also carries every outside owner's lease, once: flock is per open file, so a
          // second acquisition of the same lease in this process would refuse itself.
          ownerLeases.push(
            acquireRemovalWriterLeases(entry, undefined, {
              existingOnly: true,
              additionalGitDirs: windowEntries.length === 1 ? ownerList : [],
              skip: [commonPath],
            }),
          )
          const pre = preliminary.get(entry) as RetentionVerifyResult
          const held = await inspectRetainedEntryInBatch(verifyOptions(entry, "held"), entryView(scan, entry), entries)
          const before = proofFacts(pre)
          const after = held.verdict === "candidate" ? proofFacts(held) : undefined
          const stat = lstatSync(entry)
          if (
            after === undefined ||
            before.facts !== after.facts ||
            JSON.stringify(pointers(pre)) !== JSON.stringify(pointers(held)) ||
            held.entryDevIno !== `${stat.dev}:${stat.ino}`
          ) {
            rows.set(entry, {
              entry,
              outcome: "kept",
              reason: `census-shifted: preliminary and held proofs differ${after === undefined ? `: ${held.reasons.join("; ")}` : ""}`,
            })
          } else {
            try {
              rmSync(entry, { recursive: true, force: false })
              if (lstatSync(entry, { throwIfNoEntry: false }) !== undefined) {
                throw new Error(`entry ${entry} is still present after deletion`)
              }
              for (const pointer of pointers(held)) {
                if (pointer.retained === join(entry, "modules") && pointer.manifest === join(entry, "manifest.json")) {
                  removeRetainedPointer(pointer)
                }
              }
            } catch (error) {
              const state = lstatSync(entry, { throwIfNoEntry: false }) === undefined ? "gone" : "partly present"
              rows.set(entry, {
                entry,
                outcome: "failed",
                reason: `${error instanceof Error ? error.message : String(error)}; actual entry state: ${state}; no retry`,
              })
              stopped = `retirement-partial at ${entry}; the batch deleted nothing more`
              break
            }
            rows.set(entry, { entry, outcome: "retired", reason: "absence verified", evidence: after.path })
          }
          lastEntryMs = monotonic() - entryStarted
        }
      }
    } finally {
      for (const lease of ownerLeases.reverse()) lease.release()
      commonLease.release()
    }
    windows.push({ entries: windowEntries, delta: deltaStatus, deltaMs, holdMs: Math.round(monotonic() - heldFrom) })
    if (stopped !== undefined) {
      for (const entry of candidates.slice(next)) rows.set(entry, { entry, outcome: "kept", reason: stopped })
      return result(windows, stopped)
    }
  }
  return result(windows)
}
