/** Archive custody and exact-name retirement for Git refs. */
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

/** The existing dated-name grammar, shared by custody reads and legacy-name retirement. */
function datedArchiveBranch(ref: string): string | undefined {
  const name = /^refs\/archive\/(\d{4}-\d{2}-\d{2})\/([^/]+)\/(.+)$/u.exec(ref)
  return name?.[2] !== undefined && archiveActorSegment(name[2]) === name[2] ? name[3] : undefined
}

/** Read archive custody through the one archive-name parser; malformed evidence is never omitted. */
export function readArchiveRows(
  repoRoot: string,
  tip?: string,
): readonly { branch: string; tip: string; ref: string }[] {
  if (tip !== undefined && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(tip)) {
    throw new Error(`the archive tip ${JSON.stringify(tip)} is not a full SHA1 or SHA256 object ID`)
  }
  const args = [
    "for-each-ref",
    ...(tip === undefined ? [] : [`--points-at=${tip}`]),
    "--format=%(objectname)%09%(refname)",
    `${ARCHIVE_REF_PREFIX}/`,
  ]
  const result = tryGit(repoRoot, args)
  if (result.exitCode !== 0) throw gitError(repoRoot, args, result.exitCode, result.stderr)
  const rows: { branch: string; tip: string; ref: string }[] = []
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
    const branch = datedArchiveBranch(ref)
    if (branch === undefined) throw new Error(`${repoRoot}: malformed archive name ${ref}`)
    rows.push({ branch, tip: value, ref })
  }
  return rows
}

/** Read existing custody for this exact branch and tip, regardless of the retiring actor or UTC day. */
export function findArchiveRefFor(repoRoot: string, branch: string, tip: string): string | undefined {
  return readArchiveRows(repoRoot, tip).find((row) => row.branch === branch)?.ref
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

export type RemoveLegacyArchiveRefResult =
  | {
      readonly ok: true
      readonly removed: true
      readonly legacyRef: string
      readonly replacementRef: string
      readonly tip: string
    }
  | { readonly ok: false; readonly removed: boolean | "unknown"; readonly reason: string }

/**
 * Retire one obsolete archive name while its identically named dated custody stays pinned.
 * The caller owns attribution and its decision journal. A failed post-write read reports
 * removed=true when Git committed the deletion; absence on a later invocation is a refusal.
 */
export function removeLegacyArchiveRef(
  repoRoot: string,
  legacyRef: string,
  replacementRef: string,
  tip: string,
): RemoveLegacyArchiveRefResult {
  let removed: boolean | "unknown" = false
  try {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(tip)) {
      throw new Error(`expected a full SHA1 or SHA256 tip, got ${JSON.stringify(tip)}`)
    }
    if (!legacyRef.startsWith(`${ARCHIVE_REF_PREFIX}/`) || datedArchiveBranch(legacyRef) !== undefined) {
      throw new Error(`legacy ref ${legacyRef} must be an undated name under ${ARCHIVE_REF_PREFIX}/`)
    }
    if (datedArchiveBranch(replacementRef) !== legacyRef.slice(ARCHIVE_REF_PREFIX.length + 1)) {
      throw new Error(
        `replacement ${replacementRef} must be a dated archive for the exact legacy suffix of ${legacyRef}`,
      )
    }
    for (const ref of [legacyRef, replacementRef]) {
      const valid = tryGit(repoRoot, ["check-ref-format", ref])
      if (valid.exitCode !== 0) throw new Error(`invalid archive ref ${JSON.stringify(ref)}: ${valid.stderr}`)
      const symbolic = tryGit(repoRoot, ["symbolic-ref", "--quiet", ref])
      if (symbolic.exitCode === 0) {
        throw new Error(`archive ref ${ref} is symbolic (${symbolic.stdout.trim()}); keep it`)
      }
      if (symbolic.exitCode !== 1) {
        throw gitError(repoRoot, ["symbolic-ref", "--quiet", ref], symbolic.exitCode, symbolic.stderr)
      }
    }
    const read = (ref: string): string | undefined => {
      const args = ["rev-parse", "--verify", "--quiet", ref]
      const result = tryGit(repoRoot, args)
      if (result.exitCode === 1 && result.stdout.trim() === "") return undefined
      if (result.exitCode !== 0) throw gitError(repoRoot, args, result.exitCode, result.stderr)
      const oid = result.stdout.trim()
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(oid)) {
        throw new Error(`archive ${ref} read malformed object ID ${JSON.stringify(oid)}`)
      }
      return oid
    }
    const replacementTip = read(replacementRef)
    const legacyTip = read(legacyRef)
    if (legacyTip === undefined) {
      throw new Error(
        `legacy ref ${legacyRef} is absent; replacement ${replacementRef} reads ${replacementTip ?? "absent"}, expected ${tip}; no deletion attempted`,
      )
    }
    if (legacyTip !== tip || replacementTip !== tip) {
      throw new Error(
        `expected ${tip}; legacy ${legacyRef} reads ${legacyTip}, replacement ${replacementRef} reads ${replacementTip ?? "absent"}; both refs kept`,
      )
    }
    const args = [...DURABLE_GIT_CONFIG, "update-ref", "--no-deref", "--stdin"]
    removed = "unknown"
    const result = tryGit(
      repoRoot,
      args,
      undefined,
      `start\nverify ${replacementRef} ${tip}\ndelete ${legacyRef} ${tip}\nprepare\ncommit\n`,
    )
    if (result.exitCode !== 0) throw gitError(repoRoot, args, result.exitCode, result.stderr)
    removed = true
    const afterLegacy = read(legacyRef)
    const afterReplacement = read(replacementRef)
    // rev-parse cannot distinguish an absent name from a dangling symbolic ref.
    for (const ref of [legacyRef, replacementRef]) {
      const symbolic = tryGit(repoRoot, ["symbolic-ref", "--quiet", ref])
      if (symbolic.exitCode === 0) {
        throw new Error(
          `${ref} became symbolic to ${symbolic.stdout.trim()} after deletion; inspect both ${legacyRef} and ${replacementRef} before retry`,
        )
      }
      if (symbolic.exitCode !== 1) {
        throw gitError(repoRoot, ["symbolic-ref", "--quiet", ref], symbolic.exitCode, symbolic.stderr)
      }
    }
    if (afterLegacy !== undefined || afterReplacement !== tip) {
      throw new Error(
        `post-delete readback: legacy ${legacyRef} reads ${afterLegacy ?? "absent"}; replacement ${replacementRef} reads ${afterReplacement ?? "absent"}, expected ${tip}`,
      )
    }
    return { ok: true, removed: true, legacyRef, replacementRef, tip }
  } catch (cause) {
    return {
      ok: false,
      removed,
      reason: `${repoRoot}: ${removed === true ? "deletion committed; " : removed === "unknown" ? "deletion outcome unconfirmed; inspect both refs before retry; " : "no deletion attempted; "}${cause instanceof Error ? cause.message : String(cause)}`,
    }
  }
}
