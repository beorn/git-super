/** Create-only archive custody for callers that retire Git refs. */
import { gitError, tryGit } from "./git.ts"

/** One archive namespace shared by branch-retirement callers. */
export const ARCHIVE_REF_PREFIX = "refs/archive"
/** Match Gitomic's per-invocation durable publication settings. */
const DURABLE_GIT_CONFIG = ["-c", "core.fsync=loose-object,reference", "-c", "core.fsyncMethod=fsync"] as const

/** Convert the caller-supplied actor into a ref-safe path segment. */
export function archiveActorSegment(actor: string): string {
  const slug = actor
    .replace(/^@/u, "")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^[.-]+|[.-]+$/gu, "")
  return slug.length > 0 ? slug : "unknown"
}

/** The archive ref for one retired branch: `refs/archive/<date>/<actor>/<branch>`. */
export function archiveRefFor(branch: string, actor: string, date: string): string {
  return `${ARCHIVE_REF_PREFIX}/${date}/${archiveActorSegment(actor)}/${branch}`
}

/** Read existing custody for this exact branch and tip, regardless of the retiring actor or UTC day. */
export function findArchiveRefFor(repoRoot: string, branch: string, tip: string): string | undefined {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(tip)) {
    throw new Error(`the archive tip ${JSON.stringify(tip)} is not a full SHA1 or SHA256 object ID`)
  }
  const args = ["for-each-ref", `--points-at=${tip}`, "--format=%(objectname)%09%(refname)", `${ARCHIVE_REF_PREFIX}/`]
  const result = tryGit(repoRoot, args)
  if (result.exitCode !== 0) throw gitError(repoRoot, args, result.exitCode, result.stderr)
  for (const line of result.stdout.split("\n")) {
    if (line === "") continue
    const fields = line.split("\t")
    const [value, ref] = fields
    if (
      fields.length !== 2 ||
      value === undefined ||
      ref === undefined ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)
    ) {
      throw new Error(`cannot read archive custody in ${repoRoot}: malformed for-each-ref row ${JSON.stringify(line)}`)
    }
    const name = /^refs\/archive\/(\d{4}-\d{2}-\d{2})\/([^/]+)\/(.+)$/u.exec(ref)
    if (value === tip && name?.[2] !== undefined && archiveActorSegment(name[2]) === name[2] && name[3] === branch) {
      return ref
    }
  }
  return undefined
}

/** `created` distinguishes a fresh archive ref from an idempotent re-run; both mean the tip is archived. */
export type EnsureArchiveRefResult =
  | { readonly ok: true; readonly created: boolean }
  | { readonly ok: false; readonly reason: string }

/**
 * Create an archive without ever replacing another tip.
 *
 * The invariant, in one place: **a branch name is retired only after its archive ref READS BACK as the pinned tip.**
 *
 *   * a ref already at `tip` is idempotent success (a re-run, never a second archive);
 *   * a ref at any OTHER oid is refused and left untouched — an archive is evidence, never overwritten;
 *   * a `rev-parse` that exits non-zero but still printed something matches neither case and is refused, because a
 *     writer that "creates" over an unreadable ref would silently discard whatever it is;
 *   * the create uses `update-ref <ref> <tip> <zero>` (create-only), and the read-back that follows is the proof.
 */
export function ensureArchiveRef(repoRoot: string, archiveRef: string, tip: string): EnsureArchiveRefResult {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(tip)) {
    return { ok: false, reason: `the archive tip ${JSON.stringify(tip)} is not a full SHA1 or SHA256 object ID` }
  }
  const existing = tryGit(repoRoot, ["rev-parse", "--verify", archiveRef])
  if (existing.exitCode === 0) {
    if (existing.stdout.trim() === tip) return { ok: true, created: false }
    return {
      ok: false,
      reason: `the archive ref ${archiveRef} already holds ${existing.stdout.trim()}, not ${tip}; an archive ref is never overwritten`,
    }
  }
  if (existing.stdout.trim() !== "") {
    return {
      ok: false,
      reason: `cannot read the archive ref ${archiveRef}: rev-parse exited ${existing.exitCode} but printed ${existing.stdout.trim()}`,
    }
  }
  // Git's create-only old value must use the repository's object-ID width.
  const created = tryGit(repoRoot, [...DURABLE_GIT_CONFIG, "update-ref", archiveRef, tip, "0".repeat(tip.length)])
  if (created.exitCode !== 0) {
    return {
      ok: false,
      reason: `the archive ref ${archiveRef} could not be created: ${
        (created.stderr || created.stdout).trim().split("\n")[0] ?? "unknown"
      }`,
    }
  }
  const readBack = tryGit(repoRoot, ["rev-parse", "--verify", archiveRef])
  if (readBack.exitCode !== 0 || readBack.stdout.trim() !== tip) {
    return {
      ok: false,
      reason: `the archive ref ${archiveRef} did not read back as ${tip} after creation (got ${
        readBack.stdout.trim() || `exit ${readBack.exitCode}`
      })`,
    }
  }
  return { ok: true, created: true }
}
