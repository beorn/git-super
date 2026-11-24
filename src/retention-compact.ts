import { createHash, randomUUID } from "node:crypto"
import { existsSync, lstatSync, readdirSync } from "node:fs"
import { lstat, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { basename, dirname, join, sep } from "node:path"
import { acquireExclusive, isExclusiveBusy, type WriterLock } from "./exclusive.ts"
import { cleanGitRepositoryEnvironment } from "./git.ts"
import { createLocalGitProcess, type GitProcess } from "./process.ts"
import {
  manifest,
  metadataFileDigest,
  readStoredManifest,
  readProofLocation,
  rebuildRetainedCopyProof,
  checkRemovalExecution,
  deleteStagedTree,
  type RemovalExecution,
  type WorktreeRemovalProof,
} from "./worktree-removal.ts"

/**
 * Post-close compaction of one retained-modules child (#27443 C1).
 *
 * `git pack-refs --all` writes `packed-refs` before it prunes any loose ref, so every ref VALUE
 * survives any failure point of that command. Remote-tracking reflogs (`logs/refs/remotes/`) are
 * then dropped; `logs/HEAD` and `logs/refs/heads/**` stay. G1 snapshots (for-each-ref, HEAD value
 * and symbolic target, local reflog digests) must be byte-identical before rewrite.
 *
 * On any failure: do not rewrite the proof, never delete the copy, log one line naming the child
 * and the failed step, return `{ status: "failed", child, step }`. After pack-refs has started,
 * every ref value stays intact, the proof is not rewritten (so a later retention verify refuses),
 * and the copy is never deleted. Callers that already ran native `--force` must not throw this
 * result out of `remove()`.
 *
 * `rewriteProof` re-describes whatever is on disk. The caller must say how that disk state was
 * verified, or a damaged child is blessed by the rewrite (R4).
 */

export type CompactionRecord = Readonly<{
  at: string
  packedRefs: true
  dropped: "logs/refs/remotes/"
  refValuesEqual: true
  filesBefore: number
  filesAfter: number
  previousManifestDigest: string
}>

/** How the copy's pre-compaction bytes were proven. C3 cannot skip this: gate-2 is run here. */
export type CompactionPreState =
  | Readonly<{
      /**
       * The copy was byte-verified against the live source in `retainWorktreeModules` during this
       * same `remove()`. C1 uses this. Do not pass it for an existing-stock child.
       */
      kind: "in-run"
    }>
  | Readonly<{
      /**
       * Existing stock (C3): compare the stored proof's files/entries to a fresh walk before any
       * pack. A mismatch refuses; rewrite never blesses a damaged child.
       */
      kind: "gate-2"
    }>

export type CompactionResult =
  | Readonly<{ status: "ok" }>
  | Readonly<{ status: "failed"; child: string; step: string }>
  | Readonly<{ status: "skipped" }>

export type CompactionOptions = Readonly<{
  /**
   * The lender's git-common-dir. `path.sep` (`"/"`) contains every path and disables the
   * objects-link custody check in `manifest()` (`!within("/", target)` is always true).
   */
  common: string
  preState: CompactionPreState
  gitProcess?: GitProcess
  execution?: RemovalExecution | undefined
}>

/**
 * The proof fields compaction reads: the retained copy to compact, the proof file it rewrites, and
 * the two recorded paths the manifest walk replays for custody (`checkout`, `gitDir`). A full
 * `WorktreeRemovalProof` satisfies it; C3 (#27443 existing stock) rebuilds it from an entry's own
 * `manifest.json` because a stored proof's `retained` records the root it was written under, which
 * is no longer where the entry lives.
 */
export type RetainedCopyProof = Pick<WorktreeRemovalProof, "path" | "modules" | "retained"> &
  Readonly<{ manifest: string }>

type RefSnapshot = Readonly<{
  refs: string
  headValue: string
  headSymbolic: string
  localReflogDigests: Readonly<Record<string, string>>
}>

async function runAtGitDir(
  gitDir: string,
  args: readonly string[],
  gitProcess: GitProcess,
  execution?: RemovalExecution,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // --work-tree=<gitDir>: the retained copy still records core.worktree for the checkout native --force just
  // deleted. Without it, for-each-ref and pack-refs die on chdir to that missing path. Not --bare: git 2.53 still
  // chdirs to the recorded worktree under --bare, 2.56 does not (#34920); --work-tree works on both.
  checkRemovalExecution(execution)
  const result = await gitProcess.run({
    repo: dirname(gitDir),
    args: ["--git-dir", gitDir, "--work-tree", gitDir, ...args],
    env: cleanGitRepositoryEnvironment(),
    ...(execution?.signal === undefined ? {} : { signal: execution.signal }),
    ...(execution?.remainingMs === undefined ? {} : { timeoutMs: Math.max(1, Math.floor(execution.remainingMs())) }),
  })
  if (result.failure !== undefined) throw new Error(`failed to run git in ${gitDir}: ${result.failure}`)
  checkRemovalExecution(execution)
  return {
    exitCode: result.code,
    stdout: result.stdout,
    stderr: result.stderr.trim(),
  }
}

async function compactionStat(
  path: string,
  execution?: RemovalExecution,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  checkRemovalExecution(execution)
  try {
    return await lstat(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") return undefined
    throw error
  }
}

async function isRetainedGitDir(path: string, execution?: RemovalExecution): Promise<boolean> {
  const head = join(path, "HEAD")
  if (!(await compactionStat(head, execution))?.isFile()) return false
  const refs = join(path, "refs")
  const packed = join(path, "packed-refs")
  return (
    (await compactionStat(refs, execution))?.isDirectory() === true ||
    (await compactionStat(packed, execution))?.isFile() === true
  )
}

/** HEAD plus (refs/ or packed-refs); recurse only into `modules/` of a gitdir. */
export async function findRetainedGitDirs(root: string, execution?: RemovalExecution): Promise<string[]> {
  const found: string[] = []
  const consider = async (path: string): Promise<void> => {
    if (!(await compactionStat(path, execution))?.isDirectory()) return
    if (await isRetainedGitDir(path, execution)) {
      found.push(path)
      await consider(join(path, "modules"))
      return
    }
    checkRemovalExecution(execution)
    for (const name of await readdir(path)) await consider(join(path, name))
  }
  await consider(root)
  return found
}

async function collectLocalReflogDigests(
  gitDir: string,
  execution?: RemovalExecution,
): Promise<Readonly<Record<string, string>>> {
  const digests: Record<string, string> = {}
  const visit = async (relativePath: string): Promise<void> => {
    const path = join(gitDir, relativePath)
    const stats = await compactionStat(path, execution)
    if (stats === undefined) return
    if (stats.isSymbolicLink()) {
      throw new Error(`local reflog path ${path} is a symlink; preserve before compaction`)
    }
    if (stats.isFile()) {
      digests[relativePath] = await metadataFileDigest(path, execution)
      return
    }
    if (stats.isDirectory()) {
      checkRemovalExecution(execution)
      for (const name of await readdir(path)) await visit(join(relativePath, name))
    }
  }
  await visit("logs/HEAD")
  await visit("logs/refs/heads")
  return Object.fromEntries(Object.entries(digests).sort(([left], [right]) => left.localeCompare(right)))
}

async function snapshotRefValues(
  gitDir: string,
  gitProcess: GitProcess,
  execution?: RemovalExecution,
): Promise<RefSnapshot> {
  const refs = await runAtGitDir(gitDir, ["for-each-ref", "--format=%(refname) %(objectname)"], gitProcess, execution)
  if (refs.exitCode !== 0) {
    throw new Error(`for-each-ref failed in ${gitDir}: ${refs.stderr || refs.stdout}`)
  }
  const head = await runAtGitDir(gitDir, ["rev-parse", "HEAD"], gitProcess, execution)
  if (head.exitCode !== 0) {
    throw new Error(`rev-parse HEAD failed in ${gitDir}: ${head.stderr || head.stdout}`)
  }
  let headSymbolic = ""
  if (await compactionStat(join(gitDir, "HEAD"), execution)) {
    checkRemovalExecution(execution)
    headSymbolic = await readFile(join(gitDir, "HEAD"), "utf8")
  }
  return {
    refs: refs.stdout,
    headValue: head.stdout.trim(),
    headSymbolic,
    localReflogDigests: await collectLocalReflogDigests(gitDir, execution),
  }
}

async function dropRemoteReflogs(gitDir: string, execution?: RemovalExecution): Promise<void> {
  const remotes = join(gitDir, "logs", "refs", "remotes")
  const stats = await compactionStat(remotes, execution)
  if (stats === undefined) return
  if (stats.isSymbolicLink()) {
    throw new Error(`${remotes} is a symlink; preserve before compaction`)
  }
  await deleteStagedTree(remotes, execution)
}

async function compactOneGitDir(gitDir: string, gitProcess: GitProcess, execution?: RemovalExecution): Promise<void> {
  const before = await snapshotRefValues(gitDir, gitProcess, execution)
  const packed = await runAtGitDir(gitDir, ["pack-refs", "--all"], gitProcess, execution)
  if (packed.exitCode !== 0) {
    throw Object.assign(new Error(`pack-refs failed in ${gitDir}: ${packed.stderr || packed.stdout}`), {
      step: "pack-refs",
    })
  }
  try {
    await dropRemoteReflogs(gitDir, execution)
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { step: "drop-remote-reflogs" })
  }
  const after = await snapshotRefValues(gitDir, gitProcess, execution)
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw Object.assign(new Error(`ref values were not byte-identical after compaction in ${gitDir}`), {
      step: "g1-snapshot",
    })
  }
}

function failedCompaction(child: string, error: unknown): CompactionResult {
  const step =
    error !== null && typeof error === "object" && "step" in error && typeof error.step === "string"
      ? error.step
      : "compact"
  console.warn(
    `git-super: retained compaction failed for ${child}: ${step}: ${error instanceof Error ? error.message : String(error)}`,
  )
  return { status: "failed", child, step }
}

function expectedCopyEntries(entries: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(entries).map(([key, entry]) => {
      if (
        entry !== null &&
        typeof entry === "object" &&
        "kind" in entry &&
        entry.kind === "objects-link" &&
        "target" in entry
      ) {
        return [key, { ...entry, declaration: entry.target }]
      }
      return [key, entry]
    }),
  )
}

async function assertStoredProofMatchesCopy(
  proof: RetainedCopyProof,
  retained: string,
  common: string,
  execution?: RemovalExecution,
): Promise<void> {
  checkRemovalExecution(execution)
  const current = JSON.parse((await readFile(proof.manifest)).toString("utf8")) as {
    files?: unknown
    entries?: unknown
  }
  if (typeof current.files !== "object" || current.files === null || Array.isArray(current.files)) {
    throw Object.assign(new Error(`${proof.manifest} does not record a files map`), { step: "gate-2" })
  }
  if (typeof current.entries !== "object" || current.entries === null || Array.isArray(current.entries)) {
    throw Object.assign(new Error(`${proof.manifest} does not record an entries map`), { step: "gate-2" })
  }
  const actual = await manifest(
    retained,
    {
      common,
      checkout: proof.path,
      gitDir: dirname(proof.modules),
      modules: retained,
    },
    true,
    false,
    execution,
  )
  if (JSON.stringify(current.files) !== JSON.stringify(actual.files)) {
    throw Object.assign(new Error(`gate 2 files mismatch in ${retained}; compaction refused`), { step: "gate-2" })
  }
  if (
    JSON.stringify(expectedCopyEntries(current.entries as Readonly<Record<string, unknown>>)) !==
    JSON.stringify(actual.entries)
  ) {
    throw Object.assign(new Error(`gate 2 entries mismatch in ${retained}; compaction refused`), { step: "gate-2" })
  }
}

async function rewriteProof(
  proof: RetainedCopyProof,
  retained: string,
  common: string,
  execution?: RemovalExecution,
): Promise<void> {
  try {
    checkRemovalExecution(execution)
    const currentBytes = await readFile(proof.manifest)
    const current = JSON.parse(currentBytes.toString("utf8")) as Record<string, unknown>
    const files = current.files
    if (typeof files !== "object" || files === null || Array.isArray(files)) {
      throw new Error(`${proof.manifest} does not record a files map`)
    }
    const filesBefore = Object.keys(files).length
    const actual = await manifest(
      retained,
      {
        common,
        checkout: proof.path,
        gitDir: dirname(proof.modules),
        modules: retained,
      },
      true,
      false,
      execution,
    )
    const next = {
      ...current,
      // The proof's LOCATION follows the copy the caller verified, never the root it was written
      // under: C3 compacts stock whose stored root no longer exists, and `retention verify` reads
      // this recorded path first, so an entry left naming the dead root would be refused (gate 1) by
      // the very command that certifies it. `path`/`modules` stay exactly as recorded (CTO
      // ba5cd1b2): they feed only the walk's custody string math, and regenerating them would
      // describe a copy nobody verified.
      retained,
      manifest: proof.manifest,
      files: actual.files,
      entries: actual.entries,
      compaction: {
        at: new Date().toISOString(),
        packedRefs: true,
        dropped: "logs/refs/remotes/",
        refValuesEqual: true,
        filesBefore,
        filesAfter: Object.keys(actual.files).length,
        previousManifestDigest: createHash("sha256").update(currentBytes).digest("hex"),
      } satisfies CompactionRecord,
    }
    const tmp = join(dirname(proof.manifest), `manifest.${randomUUID()}.json.tmp`)
    try {
      checkRemovalExecution(execution)
      await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx" })
      checkRemovalExecution(execution)
      await rename(tmp, proof.manifest)
    } catch (error) {
      try {
        // A cancelled attempt keeps its named temp proof; do not begin another operation after cutoff.
        checkRemovalExecution(execution)
        if (await compactionStat(tmp, execution)) {
          checkRemovalExecution(execution)
          await unlink(tmp)
        }
      } catch (cleanupError) {
        console.warn(
          `git-super: retained compaction left temp proof ${tmp}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        )
      }
      throw error
    }
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { step: "rewrite-proof" })
  }
}

export async function compactRetainedModules(
  proof: RetainedCopyProof,
  options: CompactionOptions,
): Promise<CompactionResult> {
  if (proof.retained === null) return { status: "skipped" }
  const retained = proof.retained
  try {
    if (!(await compactionStat(retained, options.execution))) {
      throw Object.assign(new Error(`retained copy ${retained} is missing; compaction refused`), {
        step: "missing-copy",
      })
    }
    if (options.preState.kind === "gate-2") {
      await assertStoredProofMatchesCopy(proof, retained, options.common, options.execution)
    } else if (options.preState.kind !== "in-run") {
      const exhaustive: never = options.preState
      throw Object.assign(new Error(`unknown compaction pre-state ${JSON.stringify(exhaustive)}`), {
        step: "pre-state",
      })
    }
  } catch (error) {
    return failedCompaction(retained, error)
  }
  let children: string[]
  try {
    children = await findRetainedGitDirs(retained, options.execution)
  } catch (error) {
    return failedCompaction(
      retained,
      Object.assign(error instanceof Error ? error : new Error(String(error)), { step: "discovery" }),
    )
  }
  const gitProcess = options.gitProcess ?? createLocalGitProcess()
  for (const gitDir of children) {
    try {
      await compactOneGitDir(gitDir, gitProcess, options.execution)
    } catch (error) {
      return failedCompaction(gitDir, error)
    }
  }
  try {
    await rewriteProof(proof, retained, options.common, options.execution)
  } catch (error) {
    return failedCompaction(retained, error)
  }
  return { status: "ok" }
}

/** How C3 classifies one direct child of a declared retained-modules root, before any write. */
export type RetainedEntryClass =
  | "eligible"
  | "refused"
  | "stopped-partial"
  | "already-compacted"
  | "no-entries-map"
  | "incomplete-proof"
  | "no-manifest"

export type RetainedEntryReport = Readonly<{
  entry: string
  classification: RetainedEntryClass
  /** The stored proof's recorded file count, when the child carries a readable manifest. */
  recordedFiles: number | null
  /**
   * The step that refused this child before any write (`refused`), or that stopped the run after its
   * copy had begun to change (`stopped-partial`). Null when the child was neither.
   */
  step: string | null
  /**
   * Why a child was not eligible: which way a `no-manifest` manifest failed (absent, unreadable, not
   * an object), or which recorded location field an `incomplete-proof` child is missing. A
   * `stopped-partial` child carries its partial-state note here: it MAY have changed already, so the
   * class alone must never be read as "nothing happened". Null otherwise: a class alone says what
   * happened, and this says which way.
   */
  detail: string | null
}>

export type CompactRetainedRootReport = Readonly<{
  root: string
  dryRun: boolean
  limit: number | null
  /** Every direct child directory of `root`, whatever its class. */
  children: number
  counts: Readonly<Record<RetainedEntryClass, number>>
  entries: readonly RetainedEntryReport[]
  /** Eligible children this run compacted, in sorted order. A dry run lists what it verified. */
  processed: readonly string[]
  /**
   * The first child to fail AFTER its copy had begun to change (pack-refs, the reflog drop, the
   * post-compaction checks, the proof rewrite). That child is labelled `stopped-partial` and the run
   * stops there with partial state. Null when none failed: a refusal that happened BEFORE any write
   * is reported as class `refused` instead, so a known refusal cannot stop a stock run at its first
   * child (CTO ruling 2026-10-12). A partial child is NEVER labelled or counted as a refusal — an
   * operator reading `refused` must be able to believe the entry is untouched.
   */
  failed: Readonly<{ entry: string; step: string }> | null
  /**
   * #37625: another sweep held this root, so this one wrote nothing and enumerated nothing. Concurrent
   * sweeps of one root raced here before: one dropped `logs/refs/remotes/**` while the other's gate-2
   * walk still had those very files open, which surfaced as `compact: ENOENT ... open <reflog>`. The
   * holding sweep owns the compaction; a duplicate sweep reports the fact instead of racing it.
   */
  heldByAnotherSweep: boolean
}>

/**
 * The steps a child can fail with before its copy has been written at all. Refusing one of these is
 * a REPORTED class (`refused`, the step named): the child is skipped, never rewritten, never
 * removed, and the run continues. Any other step means the copy had begun to change, which is not a
 * known class and stops the run.
 */
const PRE_MUTATION_REFUSALS: ReadonlySet<string> = new Set([
  "no-manifest",
  "incomplete-proof",
  "foreign-proof",
  "missing-copy",
  "gate-2",
  "discovery",
])

export type CompactRetainedRootOptions = Readonly<{
  /** Verify each eligible child's copy, report the forecast, and write nothing. */
  dryRun?: boolean
  /** Cap on eligible children processed this run; absent or `null` means every eligible child. */
  limit?: number | null
  /** The retained copy's custody common. `path.sep` (`"/"`) for existing stock, whose lender is gone. */
  common?: string
  /**
   * #37625: how long to wait for a concurrent sweep of the same root to finish before reporting
   * {@link CompactRetainedRootReport.heldByAnotherSweep}. Default 0: a duplicate sweep yields at once,
   * because a full stock sweep can run for hours and the caller (a worktree close) must not block on it.
   */
  lockWaitMs?: number
}>

/**
 * C3 (#27443): the same post-close compaction C1 runs on a verified copy, extended to the stock that
 * predates it. It PACKS REFS and DROPS the remote-tracking reflogs (`logs/refs/remotes/`); `logs/HEAD`
 * and `logs/refs/heads/**` stay and are digest-verified byte-identical. It NEVER removes an entry.
 *
 * A stored proof records `retained` and `manifest` under the root it was written in; stock written
 * under an earlier workdir root records a path that no longer exists, so C3 REBUILDS those two
 * fields from the child's own directory and refuses a manifest whose recorded entry name is not this
 * child. Children are read one level deep, sorted, and `--limit` counts ELIGIBLE children only.
 * Already-compacted children, children with no `entries` map (an older proof shape whose object-link,
 * directory and symlink identities were never recorded), and children with no readable manifest are
 * skipped and reported by class. The first eligible child to fail verification stops the run.
 */
/**
 * #37625: the exclusive lock lives BESIDE the root, never inside it - a lock file inside the root would
 * become a manifest entry of every child and break gate 2. One directory per root, so two different
 * roots in one parent never block each other.
 */
function retainedRootLockDir(root: string): string {
  return join(dirname(root), "." + basename(root) + ".retained-compaction")
}

/** Every class at zero, for the report a duplicate sweep returns without enumerating anything. */
function zeroCounts(): Record<RetainedEntryClass, number> {
  return {
    eligible: 0,
    refused: 0,
    "stopped-partial": 0,
    "already-compacted": 0,
    "no-entries-map": 0,
    "incomplete-proof": 0,
    "no-manifest": 0,
  }
}

/**
 * #37625 (2026-11-21): compact one declared retained-modules root, at most one sweep at a time.
 *
 * Two sweeps of one root used to race: sweep B's `dropRemoteReflogs` deletes `logs/refs/remotes/**`
 * while sweep A's gate-2 walk is still hashing exactly those files, so A's `open` of a file `readdir`
 * had just listed fails `ENOENT` and the child is stamped `compact`/failed. Measured on the stock at
 * `/hh/var/yrd-workdir/.../retained-modules/37455-reaper-R4tS4b`: its own manifest records the winning
 * compaction at 21:38:45.563Z (2418 -> 408 files, remote reflogs dropped) inside the same window as
 * the failure that opened `modules/km/logs/refs/remotes/origin/task/20917-s4-prelude-hoist`.
 *
 * The lock is per root and a duplicate sweep YIELDS rather than throws: a close must never fail
 * because maintenance is running elsewhere. `lockWaitMs` lets a caller wait instead, when it genuinely
 * wants this root compacted before it returns.
 */
export async function compactRetainedRoot(
  root: string,
  options: CompactRetainedRootOptions = {},
): Promise<CompactRetainedRootReport> {
  const dryRun = options.dryRun === true
  const limit = options.limit ?? null
  let lock: WriterLock
  try {
    lock = await acquireExclusive(
      retainedRootLockDir(root),
      { timeoutMs: Math.max(0, options.lockWaitMs ?? 0) },
      "retained compaction " + root,
    )
  } catch (error) {
    if (!isExclusiveBusy(error)) throw error
    return {
      root,
      dryRun,
      limit,
      children: 0,
      counts: zeroCounts(),
      entries: [],
      processed: [],
      failed: null,
      heldByAnotherSweep: true,
    }
  }
  try {
    return await compactRetainedRootLocked(root, options)
  } finally {
    lock.release()
  }
}

async function compactRetainedRootLocked(
  root: string,
  options: CompactRetainedRootOptions = {},
): Promise<CompactRetainedRootReport> {
  const dryRun = options.dryRun === true
  const limit = options.limit ?? null
  const common = options.common ?? sep
  if (!existsSync(root) || !lstatSync(root).isDirectory()) {
    throw new Error(`retained-modules root ${root} is absent or not a directory; nothing was compacted`)
  }
  const children = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => join(root, entry.name))
    .sort()

  type MutableReport = {
    entry: string
    classification: RetainedEntryClass
    recordedFiles: number | null
    step: string | null
    detail: string | null
  }
  const reports: MutableReport[] = []
  const counts: Record<RetainedEntryClass, number> = {
    eligible: 0,
    refused: 0,
    "stopped-partial": 0,
    "already-compacted": 0,
    "no-entries-map": 0,
    "incomplete-proof": 0,
    "no-manifest": 0,
  }
  const eligible: string[] = []
  for (const entry of children) {
    const classified = classifyRetainedEntry(entry)
    counts[classified.classification] += 1
    reports.push({ ...classified, step: null })
    if (classified.classification === "eligible") eligible.push(entry)
  }

  const selected = limit === null ? eligible : eligible.slice(0, Math.max(0, limit))
  const processed: string[] = []
  let failed: { entry: string; step: string } | null = null
  const relabel = (
    entry: string,
    classification: "refused" | "stopped-partial",
    step: string,
    detail: string | null,
  ): void => {
    const row = reports.find((candidate) => candidate.entry === entry)
    if (row === undefined) return
    row.step = step
    row.classification = classification
    if (detail !== null) row.detail = detail
    counts.eligible -= 1
    counts[classification] += 1
  }
  // A refusal before any write is a reported CLASS, not a stop: the child is left exactly as it is,
  // the run carries on, and the report still names it and its step.
  const refusal = (entry: string, step: string, detail: string | null = null): void =>
    relabel(entry, "refused", step, detail)
  // A failure after the copy began to change stops the run. Its child is PARTIAL, so it gets its own
  // label and is never counted with the refusals (CTO 2026-10-12, on @dev/review2's finding): an
  // operator reading `refused` must be able to believe the entry is untouched.
  const stopped = (entry: string, step: string): void =>
    relabel(
      entry,
      "stopped-partial",
      step,
      "may be partial: the failing step can write; run `retention verify` on it before trusting it",
    )
  for (const entry of selected) {
    const rebuilt = rebuildRetainedCopyProof(entry, root)
    if (typeof rebuilt === "string") {
      const colon = rebuilt.indexOf(":")
      const step = colon < 0 ? rebuilt : rebuilt.slice(0, colon)
      if (PRE_MUTATION_REFUSALS.has(step)) {
        refusal(entry, step, rebuilt)
        continue
      }
      failed = { entry, step: rebuilt }
      stopped(entry, rebuilt)
      break
    }
    if (dryRun) {
      const verified = await verifyRetainedCopy(rebuilt, common)
      if (verified.status === "failed") {
        if (PRE_MUTATION_REFUSALS.has(verified.step)) {
          refusal(entry, verified.step)
          continue
        }
        failed = { entry, step: verified.step }
        stopped(entry, verified.step)
        break
      }
    } else {
      const result = await compactRetainedModules(rebuilt, { common, preState: { kind: "gate-2" } })
      if (result.status === "failed") {
        if (PRE_MUTATION_REFUSALS.has(result.step)) {
          refusal(entry, result.step)
          continue
        }
        failed = { entry, step: result.step }
        stopped(entry, result.step)
        break
      }
    }
    processed.push(entry)
  }

  return {
    root,
    dryRun,
    limit,
    children: children.length,
    counts,
    entries: reports,
    processed,
    failed,
    heldByAnotherSweep: false,
  }
}

/** C3 dry run: run the existing-stock gate-2 copy verification without compacting anything. */
export async function verifyRetainedCopy(proof: RetainedCopyProof, common: string = sep): Promise<CompactionResult> {
  const retained = proof.retained
  if (retained === null || !existsSync(retained)) {
    return failedCompaction(
      retained ?? "(none)",
      Object.assign(new Error(`retained copy ${retained} is missing; compaction refused`), { step: "missing-copy" }),
    )
  }
  try {
    await assertStoredProofMatchesCopy(proof, retained, common)
  } catch (error) {
    return failedCompaction(retained, error)
  }
  return { status: "ok" }
}

/** Classify one child without walking its copy: no manifest, already compacted, no entries map, or eligible. */
function classifyRetainedEntry(entry: string): {
  entry: string
  classification: RetainedEntryClass
  recordedFiles: number | null
  detail: string | null
} {
  const read = readStoredManifest(entry)
  if (!read.ok) return { entry, classification: "no-manifest", recordedFiles: null, detail: read.reason }
  const stored = read.manifest
  const files = stored.files
  const recordedFiles =
    files !== null && typeof files === "object" && !Array.isArray(files) ? Object.keys(files).length : null
  if (stored.compaction !== null && stored.compaction !== undefined) {
    return { entry, classification: "already-compacted", recordedFiles, detail: null }
  }
  const entries = stored.entries
  if (entries === null || typeof entries !== "object" || Array.isArray(entries)) {
    return { entry, classification: "no-entries-map", recordedFiles, detail: null }
  }
  const location = readProofLocation(stored)
  if (!location.ok) {
    return {
      entry,
      classification: "incomplete-proof",
      recordedFiles,
      detail: `${join(entry, "manifest.json")} does not record ${location.missing.join(", ")} as a string`,
    }
  }
  return { entry, classification: "eligible", recordedFiles, detail: null }
}
