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
 */
import { measureRetainedBytes } from "./retention-bytes.ts"
import { lstatSync, readFileSync, realpathSync, rmSync } from "node:fs"
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
  /** Allocation warnings are informational and never change a row outcome. */
  warnings: readonly Readonly<{ entry: string; phase: "pre" | "held"; message: string }>[]
  scan: Readonly<{
    status: EstateScan["status"]
    detail: string
    ms: number
    alternatesFiles: number
    excluded: number
  }>
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
  }>
  windows: readonly BatchWindow[]
  rows: readonly BatchRow[]
  /** Allocated bytes the batch would free, measured from the retained stores themselves (never an estimate). */
  bytesPlanned?: number
  /** Paths the byte total could not read; non-zero means the figure understates what would be freed. */
  bytesUnreadable?: number
  /** Set when the batch stopped early; every entry not yet deleted is kept. */
  stopped?: string
}>

function within(root: string, path: string): boolean {
  const part = relative(root, path)
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part))
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
      typeof absent === "string" && isAbsolute(absent) && lstatSync(absent, { throwIfNoEntry: false }) === undefined
        ? { source, bytes, absent }
        : undefined
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
    if (
      readFileSync(proof.source, "utf8") !== proof.bytes ||
      lstatSync(proof.absent, { throwIfNoEntry: false }) !== undefined
    ) {
      return `cold owner ${owner} changed: ${proof.source} or absent worktree ${proof.absent}`
    }
  }
  return undefined
}

/** An unleased live owner's whole alternates-connected component remains in custody. */
function keepUnleasedConnections(
  entries: readonly string[],
  borrowers: readonly EstateBorrower[],
  owners: readonly string[],
  kept: Map<string, string>,
): void {
  const graph = new Map<string, string[]>()
  const link = (from: string, to: string): void => {
    const targets = graph.get(from)
    if (targets === undefined) graph.set(from, [to])
    else targets.push(to)
  }
  for (const edge of borrowers) {
    link(edge.borrower, edge.target)
    link(edge.target, edge.borrower)
  }
  const reached = new Set<string>()
  for (const owner of owners) {
    const queue = [join(owner, "objects")]
    for (let i = 0; i < queue.length; i++) {
      const path = queue[i] as string
      if (reached.has(path)) continue
      reached.add(path)
      const entry = entries.find((entry) => within(entry, path))
      if (entry !== undefined && !kept.has(entry)) {
        kept.set(entry, `live owner ${owner} has no existing writer lease; alternates-connected store kept`)
      }
      queue.push(...(graph.get(path) ?? []))
    }
  }
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
  const budget = options.holdBudgetMs ?? 60_000
  const root = realpathSync(options.root)
  const common = realpathSync(options.common)
  const entries = options.entries.map((entry) => realpathSync(resolve(entry)))
  for (const entry of entries) {
    if (dirname(entry) !== root) throw new Error(`batch entry ${entry} is not a direct child of ${root}`)
  }
  if (new Set(entries).size !== entries.length) throw new Error("batch names an entry twice")
  const rows = new Map<string, BatchRow>()
  const warnings: { entry: string; phase: "pre" | "held"; message: string }[] = []
  const recordWarnings = (proof: RetentionVerifyResult, phase: "pre" | "held"): void => {
    for (const message of proof.certificate?.warnings ?? []) warnings.push({ entry: proof.entry, phase, message })
  }
  const verifyOptions = (entry: string, phase: "pre" | "held"): RetentionVerifyOptions => ({
    entry,
    root,
    namespaceRoots: options.namespaceRoots,
    artifactDir: join(options.artifactDir, basename(entry), phase),
    commonArtifactDir: join(options.artifactDir, "common"),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.allowTemporaryArtifactDir === undefined
      ? {}
      : { allowTemporaryArtifactDir: options.allowTemporaryArtifactDir }),
  })

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
  const byteSummary: { current?: Awaited<ReturnType<typeof measureRetainedBytes>> } = {}
  const result = (windows: BatchWindow[], stopped?: string): RetentionBatchResult => ({
    apply,
    warnings,
    scan: scanSummary,
    ...(ownerSummary.current === undefined ? {} : { owners: ownerSummary.current }),
    ...(byteSummary.current === undefined
      ? {}
      : { bytesPlanned: byteSummary.current.bytes, bytesUnreadable: byteSummary.current.unreadable }),
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
    recordWarnings(proof, "pre")
    preliminary.set(entry, proof)
    if (proof.verdict !== "candidate") kept.set(entry, `${proof.verdict}: ${proof.reasons.join("; ")}`)
  }
  closeOverKeptBorrowers(entries, scan.borrowers, kept)
  for (const [entry, reason] of kept) rows.set(entry, { entry, outcome: "kept", reason })

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
  const cold = new Map<string, ColdOwner>()
  const coldCache = new Map<string, ColdOwnerRead | undefined>()
  const coldProofFailedOwners: string[] = []
  for (const owner of ownerList) {
    const proof = coldOwner(owner, root, common, coldCache)
    if (proof === undefined) continue
    if ("failure" in proof) {
      coldProofFailedOwners.push(owner)
      console.warn(
        `retention: cannot prove cold owner ${owner}: ${proof.failure}; treating it as live, requiring its existing writer lease or keeping its connected stores`,
      )
    } else cold.set(owner, proof)
  }
  const liveOwners = ownerList.filter((owner) => !cold.has(owner))
  const leaseMissing = liveOwners.filter(
    (owner) => lstatSync(join(owner, "yrd-worktree-mutations", "writer.lock"), { throwIfNoEntry: false }) === undefined,
  )
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
  }
  const ownerStop =
    unproved.length > 0
      ? `identity-unknown: ${unproved.length} object director(ies) have no proved Git owner, e.g. ${unproved[0]}`
      : leaseMissing.includes(common)
        ? `lease-missing: common owner ${common} has no existing writer lease`
        : undefined
  keepUnleasedConnections(entries, scan.borrowers, leaseMissing, kept)
  closeOverKeptBorrowers(entries, scan.borrowers, kept)
  const candidates = borrowerOrder(entries, scan.borrowers, kept)
  for (const [entry, reason] of kept) rows.set(entry, { entry, outcome: "kept", reason })
  const leasedOwners = liveOwners.filter((owner) => !leaseMissing.includes(owner))

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
    const commonLease: FlockHandle | null = acquireFlockWithTimeout(commonPath, DEFAULT_MUTATION_LOCK_WAIT_MS, {
      create: false,
      createParent: false,
      noFollow: true,
    })
    if (commonLease === null) {
      return result(windows, `lease-held: common lease ${commonPath} is held; nothing more deleted`)
    }
    const heldFrom = monotonic()
    const ownerLeases: ReturnType<typeof acquireRemovalWriterLeases>[] = []
    const windowEntries: string[] = []
    let deltaStatus: BatchWindow["delta"] = "unchanged"
    let deltaMs = 0
    let stopped: string | undefined
    try {
      // Acquire outside owners BEFORE checking the delta; otherwise a leased writer could change an alternate
      // after that check and before its lease is acquired. Hold the first entry's leases through its deletion too.
      const first = candidates[next] as string
      ownerLeases.push(
        acquireRemovalWriterLeases(first, undefined, {
          existingOnly: true,
          additionalGitDirs: leasedOwners,
          skip: [commonPath],
        }),
      )
      const delta = estateDelta(record, scan)
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
          const held = await inspectRetainedEntryInBatch(verifyOptions(entry, "held"), entryView(scan, entry), entries)
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
              })
              stopped = `retirement-partial at ${entry}; the batch deleted nothing more`
              break
            }
            rows.set(entry, { entry, outcome: "retired", reason: "absence verified", evidence: after.path })
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
    windows.push({ entries: windowEntries, delta: deltaStatus, deltaMs, holdMs: Math.round(monotonic() - heldFrom) })
    if (stopped !== undefined) {
      for (const entry of candidates.slice(next)) {
        if (!rows.has(entry)) rows.set(entry, { entry, outcome: "kept", reason: stopped })
      }
      return result(windows, stopped)
    }
  }
  // The byte total is a measurement of the trees being removed, taken once the rows are final: it is the number an
  // operator approves a deletion against, so it is never an estimate from the manifests (which carry path -> sha256 and
  // no sizes) and it names any subtree it could not read.
  byteSummary.current = await measureRetainedBytes(
    entries.filter((entry) => {
      const outcome = rows.get(entry)?.outcome
      return outcome === "would-retire" || outcome === "retired"
    }),
  )
  return result(windows)
}
