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
import { dirname, join } from "node:path"
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

function assertStoredProofMatchesCopy(proof: WorktreeRemovalProof, retained: string, common: string): void {
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

function rewriteProof(proof: WorktreeRemovalProof, retained: string, common: string): void {
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

export function compactRetainedModules(proof: WorktreeRemovalProof, options: CompactionOptions): CompactionResult {
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
