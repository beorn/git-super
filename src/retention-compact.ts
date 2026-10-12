import { createHash, randomUUID } from "node:crypto"
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { spawnSync } from "node:child_process"
import { basename, dirname, join, sep } from "node:path"
import { cleanGitRepositoryEnvironment } from "./git.ts"
import { manifest, metadataFileDigest, type WorktreeRemovalProof } from "./worktree-removal.ts"

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
}>

/**
 * The proof fields compaction reads: the retained copy to compact, the proof file it rewrites, and
 * the two recorded paths the manifest walk replays for custody (`checkout`, `gitDir`). A full
 * `WorktreeRemovalProof` satisfies it; C3 (#27443 existing stock) rebuilds it from an entry's own
 * `manifest.json` because a stored proof's `retained` records the root it was written under, which
 * is no longer where the entry lives.
 */
export type RetainedCopyProof = Pick<WorktreeRemovalProof, "path" | "modules" | "retained" | "manifest">

type RefSnapshot = Readonly<{
  refs: string
  headValue: string
  headSymbolic: string
  localReflogDigests: Readonly<Record<string, string>>
}>

function runAtGitDir(gitDir: string, args: readonly string[]): { exitCode: number; stdout: string; stderr: string } {
  // --bare: the retained copy still records core.worktree for the checkout native --force just
  // deleted. Without it, for-each-ref and pack-refs die on chdir to that missing path.
  const result = spawnSync("git", ["--git-dir", gitDir, "--bare", ...args], {
    encoding: "utf8",
    env: cleanGitRepositoryEnvironment(),
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) throw new Error(`failed to run git in ${gitDir}: ${result.error.message}`)
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: (result.stderr ?? "").trim(),
  }
}

function isRetainedGitDir(path: string): boolean {
  const head = join(path, "HEAD")
  if (!existsSync(head) || !lstatSync(head).isFile()) return false
  const refs = join(path, "refs")
  const packed = join(path, "packed-refs")
  return (existsSync(refs) && lstatSync(refs).isDirectory()) || (existsSync(packed) && lstatSync(packed).isFile())
}

/** HEAD plus (refs/ or packed-refs); recurse only into `modules/` of a gitdir. */
export function findRetainedGitDirs(root: string): string[] {
  const found: string[] = []
  const consider = (path: string): void => {
    if (!existsSync(path) || !lstatSync(path).isDirectory()) return
    if (isRetainedGitDir(path)) {
      found.push(path)
      consider(join(path, "modules"))
      return
    }
    for (const name of readdirSync(path)) consider(join(path, name))
  }
  consider(root)
  return found
}

function collectLocalReflogDigests(gitDir: string): Readonly<Record<string, string>> {
  const digests: Record<string, string> = {}
  const visit = (relativePath: string): void => {
    const path = join(gitDir, relativePath)
    if (!existsSync(path)) return
    const stats = lstatSync(path)
    if (stats.isSymbolicLink()) {
      throw new Error(`local reflog path ${path} is a symlink; preserve before compaction`)
    }
    if (stats.isFile()) {
      digests[relativePath] = metadataFileDigest(path)
      return
    }
    if (stats.isDirectory()) {
      for (const name of readdirSync(path)) visit(join(relativePath, name))
    }
  }
  visit("logs/HEAD")
  visit("logs/refs/heads")
  return Object.fromEntries(Object.entries(digests).sort(([left], [right]) => left.localeCompare(right)))
}

function snapshotRefValues(gitDir: string): RefSnapshot {
  const refs = runAtGitDir(gitDir, ["for-each-ref", "--format=%(refname) %(objectname)"])
  if (refs.exitCode !== 0) {
    throw new Error(`for-each-ref failed in ${gitDir}: ${refs.stderr || refs.stdout}`)
  }
  const head = runAtGitDir(gitDir, ["rev-parse", "HEAD"])
  if (head.exitCode !== 0) {
    throw new Error(`rev-parse HEAD failed in ${gitDir}: ${head.stderr || head.stdout}`)
  }
  return {
    refs: refs.stdout,
    headValue: head.stdout.trim(),
    headSymbolic: existsSync(join(gitDir, "HEAD")) ? readFileSync(join(gitDir, "HEAD"), "utf8") : "",
    localReflogDigests: collectLocalReflogDigests(gitDir),
  }
}

function dropRemoteReflogs(gitDir: string): void {
  const remotes = join(gitDir, "logs", "refs", "remotes")
  if (!existsSync(remotes)) return
  if (lstatSync(remotes).isSymbolicLink()) {
    throw new Error(`${remotes} is a symlink; preserve before compaction`)
  }
  rmSync(remotes, { recursive: true, force: false })
}

function compactOneGitDir(gitDir: string): void {
  const before = snapshotRefValues(gitDir)
  const packed = runAtGitDir(gitDir, ["pack-refs", "--all"])
  if (packed.exitCode !== 0) {
    throw Object.assign(new Error(`pack-refs failed in ${gitDir}: ${packed.stderr || packed.stdout}`), {
      step: "pack-refs",
    })
  }
  try {
    dropRemoteReflogs(gitDir)
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { step: "drop-remote-reflogs" })
  }
  const after = snapshotRefValues(gitDir)
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

function assertStoredProofMatchesCopy(proof: RetainedCopyProof, retained: string, common: string): void {
  const current = JSON.parse(readFileSync(proof.manifest).toString("utf8")) as {
    files?: unknown
    entries?: unknown
  }
  if (typeof current.files !== "object" || current.files === null || Array.isArray(current.files)) {
    throw Object.assign(new Error(`${proof.manifest} does not record a files map`), { step: "gate-2" })
  }
  if (typeof current.entries !== "object" || current.entries === null || Array.isArray(current.entries)) {
    throw Object.assign(new Error(`${proof.manifest} does not record an entries map`), { step: "gate-2" })
  }
  const actual = manifest(
    retained,
    {
      common,
      checkout: proof.path,
      gitDir: dirname(proof.modules),
      modules: retained,
    },
    true,
    false,
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

function rewriteProof(proof: RetainedCopyProof, retained: string, common: string): void {
  try {
    const currentBytes = readFileSync(proof.manifest)
    const current = JSON.parse(currentBytes.toString("utf8")) as Record<string, unknown>
    const files = current.files
    if (typeof files !== "object" || files === null || Array.isArray(files)) {
      throw new Error(`${proof.manifest} does not record a files map`)
    }
    const filesBefore = Object.keys(files).length
    const actual = manifest(
      retained,
      {
        common,
        checkout: proof.path,
        gitDir: dirname(proof.modules),
        modules: retained,
      },
      true,
      false,
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
      writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx" })
      renameSync(tmp, proof.manifest)
    } catch (error) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp)
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

export function compactRetainedModules(proof: RetainedCopyProof, options: CompactionOptions): CompactionResult {
  if (proof.retained === null) return { status: "skipped" }
  const retained = proof.retained
  if (!existsSync(retained)) {
    return failedCompaction(
      retained,
      Object.assign(new Error(`retained copy ${retained} is missing; compaction refused`), { step: "missing-copy" }),
    )
  }
  try {
    if (options.preState.kind === "gate-2") {
      assertStoredProofMatchesCopy(proof, retained, options.common)
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
    children = findRetainedGitDirs(retained)
  } catch (error) {
    return failedCompaction(
      retained,
      Object.assign(error instanceof Error ? error : new Error(String(error)), { step: "discovery" }),
    )
  }
  for (const gitDir of children) {
    try {
      compactOneGitDir(gitDir)
    } catch (error) {
      return failedCompaction(gitDir, error)
    }
  }
  try {
    rewriteProof(proof, retained, options.common)
  } catch (error) {
    return failedCompaction(retained, error)
  }
  return { status: "ok" }
}

/** How C3 classifies one direct child of a declared retained-modules root, before any write. */
export type RetainedEntryClass =
  | "eligible"
  | "already-compacted"
  | "no-entries-map"
  | "incomplete-proof"
  | "no-manifest"

export type RetainedEntryReport = Readonly<{
  entry: string
  classification: RetainedEntryClass
  /** The stored proof's recorded file count, when the child carries a readable manifest. */
  recordedFiles: number | null
  /** The compaction step that refused this eligible child, when it failed verification. */
  refusedStep: string | null
  /**
   * Why a child was not eligible: which way a `no-manifest` manifest failed (absent, unreadable, not
   * an object), or which recorded location field an `incomplete-proof` child is missing. Null
   * otherwise: a class alone says what happened, and this says which way.
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
  /** The first eligible child to fail verification; a run stops there. Null when none failed. */
  failed: Readonly<{ entry: string; step: string }> | null
}>

export type CompactRetainedRootOptions = Readonly<{
  /** Verify each eligible child's copy, report the forecast, and write nothing. */
  dryRun?: boolean
  /** Cap on eligible children processed this run; absent or `null` means every eligible child. */
  limit?: number | null
  /** The retained copy's custody common. `path.sep` (`"/"`) for existing stock, whose lender is gone. */
  common?: string
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
export function compactRetainedRoot(root: string, options: CompactRetainedRootOptions = {}): CompactRetainedRootReport {
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
    refusedStep: string | null
    detail: string | null
  }
  const reports: MutableReport[] = []
  const counts: Record<RetainedEntryClass, number> = {
    eligible: 0,
    "already-compacted": 0,
    "no-entries-map": 0,
    "incomplete-proof": 0,
    "no-manifest": 0,
  }
  const eligible: string[] = []
  for (const entry of children) {
    const classified = classifyRetainedEntry(entry)
    counts[classified.classification] += 1
    reports.push({ ...classified, refusedStep: null })
    if (classified.classification === "eligible") eligible.push(entry)
  }

  const selected = limit === null ? eligible : eligible.slice(0, Math.max(0, limit))
  const processed: string[] = []
  let failed: { entry: string; step: string } | null = null
  const markRefused = (entry: string, step: string): void => {
    const row = reports.find((candidate) => candidate.entry === entry)
    if (row !== undefined) row.refusedStep = step
  }
  for (const entry of selected) {
    const rebuilt = rebuildRetainedCopyProof(entry)
    if (typeof rebuilt === "string") {
      failed = { entry, step: rebuilt }
      markRefused(entry, rebuilt)
      break
    }
    if (dryRun) {
      const verified = verifyRetainedCopy(rebuilt, common)
      if (verified.status === "failed") {
        failed = { entry, step: verified.step }
        markRefused(entry, verified.step)
        break
      }
    } else {
      const result = compactRetainedModules(rebuilt, { common, preState: { kind: "gate-2" } })
      if (result.status === "failed") {
        failed = { entry, step: result.step }
        markRefused(entry, result.step)
        break
      }
    }
    processed.push(entry)
  }

  return { root, dryRun, limit, children: children.length, counts, entries: reports, processed, failed }
}

/** C3 dry run: run the existing-stock gate-2 copy verification without compacting anything. */
export function verifyRetainedCopy(proof: RetainedCopyProof, common: string = sep): CompactionResult {
  const retained = proof.retained
  if (retained === null || !existsSync(retained)) {
    return failedCompaction(
      retained ?? "(none)",
      Object.assign(new Error(`retained copy ${retained} is missing; compaction refused`), { step: "missing-copy" }),
    )
  }
  try {
    assertStoredProofMatchesCopy(proof, retained, common)
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

/**
 * The stored proof's location fields. Compaction never invents one: a value that is not a string is a
 * MISSING recorded fact about this child, so the child is reported and skipped rather than rebuilt
 * with a guessed path that would then feed the manifest walk's custody arithmetic (CTO F1).
 */
function readProofLocation(stored: Record<string, unknown>):
  | { readonly ok: true; readonly path: string; readonly modules: string; readonly retained: string }
  | {
      readonly ok: false
      readonly missing: readonly string[]
    } {
  const missing = ["path", "modules", "retained"].filter((field) => typeof stored[field] !== "string")
  if (missing.length > 0) return { ok: false, missing }
  return {
    ok: true,
    path: stored.path as string,
    modules: stored.modules as string,
    retained: stored.retained as string,
  }
}

/**
 * Read a child's stored proof. A failure is a REPORTED reason, never a silent null: a manifest that
 * is absent, unreadable, or not a JSON object is what makes a child `no-manifest`, and the report
 * carries which way it failed.
 */
function readStoredManifest(
  entry: string,
): { readonly ok: true; readonly manifest: Record<string, unknown> } | { readonly ok: false; readonly reason: string } {
  const path = join(entry, "manifest.json")
  if (!existsSync(path)) return { ok: false, reason: `${path} is absent` }
  if (!lstatSync(path).isFile()) return { ok: false, reason: `${path} is not a regular file` }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    return {
      ok: false,
      reason: `${path} is unreadable JSON: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: `${path} is not a JSON object` }
  }
  return { ok: true, manifest: parsed as Record<string, unknown> }
}

/**
 * Rebuild the proof compaction reads from the child's own location. The stored `retained`/`manifest`
 * point at the root the proof was written under, which for older stock no longer exists; `path` and
 * `modules` feed only the manifest walk's custody string math and are taken as recorded, never
 * regenerated from a walk. Returns the refusing step's name when the stored proof cannot be matched
 * to this child, or does not record the location fields at all.
 */
function rebuildRetainedCopyProof(entry: string): RetainedCopyProof | string {
  const read = readStoredManifest(entry)
  if (!read.ok) return "no-manifest"
  const stored = read.manifest
  const location = readProofLocation(stored)
  if (!location.ok) return "incomplete-proof"
  const recordedRetained = location.retained
  if (basename(recordedRetained) !== "modules" || basename(dirname(recordedRetained)) !== basename(entry)) {
    return "foreign-proof"
  }
  return {
    path: location.path,
    modules: location.modules,
    retained: join(entry, "modules"),
    manifest: join(entry, "manifest.json"),
  }
}
