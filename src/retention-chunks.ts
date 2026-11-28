/**
 * CHUNKED retirement (#34127, @cto 2026-11-24 chunk ruling).
 *
 * The invariant is stated once, in the header of `retention-batch.ts` (no entry is deleted on a stale or unknown
 * proof; the time budget governs new work only). This driver changes WHEN the run stops, never what a delete may rest
 * on: every delete here still goes through the batch's lease-held re-verification.
 *
 * Two consequences shape this driver, and both come from the live estate rather than from theory:
 *
 * 1. **Chunks, not one pass then one apply.** The single batch proves every selected entry, then opens one delete
 *    window. On 2026-11-24 the nightly census selected 1000 entries, spent its whole shared budget proving them (993
 *    kept, 7 proved), and then discarded the 7 because the deadline had passed before the window opened. Here a chunk is
 *    proved and then retired in the same call, so a deadline that ends the run ends it with real retirements behind it.
 * 2. **A rotating start.** The kept head of the census is what eats the budget (772 of last night's 1000 entries spent
 *    it in gate 4 and were kept). A run that always begins at the same head starves the tail forever. Each run records
 *    the entry it stopped at in the cursor file, and the next run begins after it and wraps, so every entry is examined
 *    within as many nights as the estate has chunks.
 *
 * The caller still decides `apply`; a dry run proves chunk by chunk and deletes nothing, reporting the same rows.
 */
import { randomUUID } from "node:crypto"
import { readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import {
  retireRetainedBatch,
  type BatchRow,
  type RetentionBatchOptions,
  type RetentionBatchResult,
} from "./retention-batch.ts"

export type RetentionChunkOptions = RetentionBatchOptions &
  Readonly<{
    /** Entries proved-and-retired per call. Default 50: small enough that one chunk's proofs fit a share of the budget. */
    chunkSize?: number
    /** Total time across every chunk, monotonic-checked before each chunk starts. Absent means unbounded. */
    deadlineMs?: number
    /**
     * The rotating start. One JSON object, `{ "lastExamined": "<entry path>" }`, rewritten atomically after each chunk.
     * Default `<artifactDir>/cursor.json`. Absent file means the estate has not been swept by chunks yet and the run
     * starts at the first entry.
     */
    cursorFile?: string
    /** Test seam: the clock the deadline is measured on. Production uses the process monotonic clock. */
    monotonic?: () => number
    /** Test seam: runs after each chunk's cursor is written, as time passing or a writer acting between chunks would. */
    afterChunk?: (chunk: RetentionBatchResult) => void
  }>

export type RetentionChunkResult = Readonly<{
  /** `complete` examined every entry; `partial` stopped at the deadline with a named remainder. */
  outcome: "complete" | "partial"
  retired: number
  /** Proved ready to retire by a preliminary pass but not retired before the run stopped. */
  provedButUnreached: number
  examined: number
  total: number
  /** The entry the next run begins after, or null when the run examined the whole estate. */
  nextCursor: string | null
  chunks: readonly RetentionBatchResult[]
  rows: readonly BatchRow[]
  /** Set on a time stop, naming what the next run will do; never a failure on its own. */
  stopped?: string
  /** #33010 (@cto c9e2666a): entries a census shift kept that the run re-proved once on a fresh scan. */
  reproved: number
  /**
   * #33010 (@cto a6752202): recorded stores outside the selection that vanished, and outside owners whose Git directory
   * was gone at the lease, summed over every window of every chunk: counted churn, never a stop.
   */
  vanishedStores: number
  vanishedOwners: number
  /** Every chunk's own byte figures summed (a re-proof's plan included), so a caller reads one total for the run. */
  bytesPlanned: number
  bytesEvidence: number
  bytesSharedLinked?: number
  bytesUnreadable?: number
  /** #34127: the `.retired/<date>` verdicts, from the first chunk, which alone ages; absent when no age limit was set. */
  retiredAged?: RetentionBatchResult["retiredAged"]
}>

const DEFAULT_CHUNK_SIZE = 50
/** One chunk is never given less than this: below it no proof can finish and the run would spin without progress. */
const MIN_CHUNK_MS = 30_000

type Cursor = Readonly<{ lastExamined: string }>

function readCursor(file: string): Cursor | undefined {
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
  const parsed: unknown = JSON.parse(text)
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { lastExamined?: unknown }).lastExamined !== "string"
  ) {
    throw new Error(`retention cursor ${file} is unreadable: it must hold { "lastExamined": "<entry>" }`)
  }
  return { lastExamined: (parsed as Cursor).lastExamined }
}

function writeCursor(file: string, cursor: Cursor): void {
  mkdirSync(dirname(file), { recursive: true })
  const staged = join(dirname(file), `.cursor-${randomUUID()}.json`)
  const body = `${JSON.stringify(cursor)}\n`
  writeFileSync(staged, body, { encoding: "utf8", mode: 0o600 })
  const readback = readFileSync(staged, "utf8")
  if (readback !== body) throw new Error(`retention cursor ${staged} differs on readback`)
  renameSync(staged, file)
  if (readFileSync(file, "utf8") !== body) throw new Error(`retention cursor ${file} differs on readback after rename`)
}

/** The run's own order, rotated so it begins after the cursor's entry and wraps at the end. */
function rotate(entries: readonly string[], cursor: Cursor | undefined): readonly string[] {
  if (cursor === undefined || entries.length === 0) return entries
  const at = entries.indexOf(cursor.lastExamined)
  // A cursor naming an entry that is gone (retired or reclassified) is not a failure: the run begins at the head.
  if (at < 0) return entries
  return [...entries.slice(at + 1), ...entries.slice(0, at + 1)]
}

export async function retireRetainedBatchInChunks(options: RetentionChunkOptions): Promise<RetentionChunkResult> {
  const monotonic = options.monotonic ?? (() => performance.now())
  const started = monotonic()
  const deadline = options.deadlineMs === undefined ? undefined : started + options.deadlineMs
  const remaining = (): number =>
    deadline === undefined ? Number.POSITIVE_INFINITY : Math.max(0, deadline - monotonic())
  const chunkSize = Math.max(1, Math.floor(options.chunkSize ?? DEFAULT_CHUNK_SIZE))
  const cursorFile = options.cursorFile ?? join(options.artifactDir, "cursor.json")
  const ordered = rotate(options.entries, readCursor(cursorFile))

  const chunks: RetentionBatchResult[] = []
  const rows: BatchRow[] = []
  let retired = 0
  let proved = 0
  let examined = 0
  let nextCursor: string | null = null
  let stopped: string | undefined
  let bytesPlanned = 0
  let bytesEvidence = 0
  let bytesSharedLinked = 0
  let bytesUnreadable = 0
  let at = 0
  // #33010 (@cto c9e2666a): the entries a census shift kept, re-proved ONCE on a fresh scan before the run moves on.
  // A re-proof is a new batch with its own scan, delta and held re-verification, so nothing is deleted on the proof the
  // shift voided. It draws on the same deadline: a shift never lengthens the run or its hold on the estate leases.
  let reprove: readonly string[] | undefined
  let reproved = 0
  let shiftedUnresolved: string | undefined
  while (at < ordered.length || reprove !== undefined) {
    const left = remaining()
    if (left <= 0) {
      stopped = `deadline: ${String(ordered.length - at)} of ${String(ordered.length)} entries not examined${reprove === undefined ? "" : ` and ${String(reprove.length)} shifted entr(ies) not re-proved`}; the next run starts after ${String(ordered[Math.min(at, ordered.length - 1)] as string)}`
      break
    }
    const isReproof = reprove !== undefined
    const slice = reprove ?? ordered.slice(at, at + chunkSize)
    reprove = undefined
    const chunksLeft = Math.max(1, Math.ceil((ordered.length - at) / chunkSize))
    // Fair share of what is left, never less than a chunk can use, never more than the whole remainder.
    const chunkBudget = Math.min(left, Math.max(MIN_CHUNK_MS, Math.floor(left / chunksLeft)))
    // #34127: only the first chunk ages `.retired`, so one run ages once and reports one row per directory.
    const { retiredMaxAgeMs, ...perChunk } = options
    const chunk = await retireRetainedBatch({
      ...perChunk,
      ...(chunks.length === 0 && retiredMaxAgeMs !== undefined ? { retiredMaxAgeMs } : {}),
      entries: slice,
      proofDeadlineMs: chunkBudget,
    })
    chunks.push(chunk)
    rows.push(...chunk.rows)
    examined += chunk.rows.length
    retired += chunk.rows.filter((row) => row.outcome === "retired").length
    proved += chunk.candidates?.length ?? 0
    bytesPlanned += chunk.bytesPlanned ?? 0
    bytesEvidence += chunk.bytesEvidence ?? 0
    bytesSharedLinked += chunk.bytesSharedLinked ?? 0
    bytesUnreadable += chunk.bytesUnreadable ?? 0
    if (!isReproof) {
      at += slice.length
      const last = slice[slice.length - 1] as string
      nextCursor = at < ordered.length ? last : null
      writeCursor(cursorFile, { lastExamined: last })
    }
    options.afterChunk?.(chunk)
    if (chunk.stoppedKind === "shifted") {
      // The entries this shift kept (each carries the shift as its reason), re-proved once; a second shift on the same
      // entries leaves them kept, named, for the next run, and the run moves on to the rest.
      const kept = chunk.rows.filter((row) => row.outcome === "kept" && row.reason === chunk.stopped)
      if (!isReproof && kept.length > 0) {
        const again = new Set(kept.map((row) => row.entry))
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          if (again.has((rows[i] as BatchRow).entry)) rows.splice(i, 1)
        }
        examined -= again.size
        // The re-proof proves them again; count each entry's proof once, so provedButUnreached stays per entry.
        proved -= (chunk.candidates ?? []).filter((entry) => again.has(entry)).length
        reproved += again.size
        reprove = [...again]
      } else {
        shiftedUnresolved = chunk.stopped
      }
      continue
    }
    // A condition stop ends the run: a held lease or a partial retirement is not something to keep sweeping past.
    if (chunk.stoppedKind === "stop") {
      stopped = chunk.stopped
      break
    }
    if (chunk.stoppedKind === "deadline" || chunk.stoppedKind === "budget") {
      stopped = chunk.stopped
      // The chunk ended at its own share of the budget; the next one starts fresh only if time is left, which the loop
      // head decides. This record names the stop for the report either way.
      continue
    }
  }
  if (stopped === undefined && at >= ordered.length) nextCursor = null
  // A shift a re-proof could not clear leaves its entries kept and named: the run is partial, never complete, but it is
  // not a hard stop, because every other chunk still ran on its own fresh proof.
  if (stopped === undefined && shiftedUnresolved !== undefined) stopped = shiftedUnresolved
  const windows = chunks.flatMap((chunk) => chunk.windows)
  return {
    outcome: at >= ordered.length && stopped === undefined ? "complete" : "partial",
    retired,
    provedButUnreached: Math.max(0, proved - retired),
    examined,
    total: ordered.length,
    nextCursor,
    chunks,
    rows,
    reproved,
    vanishedStores: windows.reduce((sum, window) => sum + window.vanishedStores, 0),
    vanishedOwners: windows.reduce((sum, window) => sum + window.vanishedOwners.length, 0),
    bytesPlanned,
    bytesEvidence,
    ...(bytesSharedLinked === 0 ? {} : { bytesSharedLinked }),
    ...(bytesUnreadable === 0 ? {} : { bytesUnreadable }),
    ...(stopped === undefined ? {} : { stopped }),
    ...(chunks[0]?.retiredAged === undefined ? {} : { retiredAged: chunks[0].retiredAged }),
  }
}
