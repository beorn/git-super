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
import { dirname, join, sep } from "node:path"
import { cleanGitRepositoryEnvironment } from "./git.ts"
import { manifest, metadataFileDigest, type WorktreeRemovalProof } from "./worktree-removal.ts"

/**
 * Post-close compaction of one retained-modules child (#27443 C1).
 *
 * `git pack-refs --all` writes `packed-refs` before it prunes any loose ref, so every ref VALUE
 * survives any failure point of that command. Remote-tracking reflogs (`logs/refs/remotes/`) are
 * then dropped; `logs/HEAD` and `logs/refs/heads/**` stay. G1 snapshots (for-each-ref, HEAD value
 * and symbolic target, local reflog digests) must be byte-identical before rewrite. On any failure:
 * do not rewrite the proof, never delete the copy, log one line naming the child and the failed
 * step, throw. Gate 2 then refuses the still-at-close proof against a mutated copy — loudly.
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

function rewriteProof(proof: WorktreeRemovalProof, retained: string): void {
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
      common: sep,
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
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { step: "rewrite-proof" })
  }
}

export function compactRetainedModules(proof: WorktreeRemovalProof): void {
  if (proof.retained === null) return
  const retained = proof.retained
  if (!existsSync(retained)) {
    throw new Error(`retained copy ${retained} is missing; compaction refused`)
  }
  const children = findRetainedGitDirs(retained)
  for (const gitDir of children) {
    try {
      compactOneGitDir(gitDir)
    } catch (error) {
      const step =
        error !== null && typeof error === "object" && "step" in error && typeof error.step === "string"
          ? error.step
          : "compact"
      console.warn(
        `git-super: retained compaction failed for ${gitDir}: ${step}: ${error instanceof Error ? error.message : String(error)}`,
      )
      throw error
    }
  }
  try {
    rewriteProof(proof, retained)
  } catch (error) {
    const step =
      error !== null && typeof error === "object" && "step" in error && typeof error.step === "string"
        ? error.step
        : "rewrite-proof"
    console.warn(
      `git-super: retained compaction failed for ${retained}: ${step}: ${error instanceof Error ? error.message : String(error)}`,
    )
    throw error
  }
}
