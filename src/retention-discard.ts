/**
 * An explicit discard of a retained entry's un-witnessed objects (34787, @cto 34787-component-retention-ruling
 * correction 4 and 34787-discard-surface-authority-ruling).
 *
 * Gate 5 refuses an entry whose at-risk objects have no durable witness, because the entry holds their last copy. A
 * disposition is the caller's recorded decision to lose exactly that set: it binds the entry's identity, its manifest
 * and the complete missing-object sidecar, and it names a reason and the caller's opaque attribution. It never makes a
 * missing witness real: gate 5 stays blocked, and the pass reports the loss separately as `explicitLoss`. Every other
 * gate still applies, and a set whose commit roots could not be described cannot be discarded.
 */
import { createHash } from "node:crypto"
import type { MissingComponentLoss } from "./retention-custody.ts"
import { checkRetentionAttribution, type RetentionAttribution } from "./worktree-removal.ts"

export const RETENTION_DISCARD_SCHEMA = "git-super/retention-discard/1"

export type RetentionDiscard = Readonly<{
  schema: typeof RETENTION_DISCARD_SCHEMA
  entry: string
  entryDevIno: string
  manifestSha256: string
  missingCount: number
  missingSidecarSha256: string
  loss: readonly MissingComponentLoss[]
  reason: string
  attribution: RetentionAttribution
}>

const HEX64 = /^[0-9a-f]{64}$/u
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u

function plain(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${what} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${what} must be a nonempty string`)
  return value
}

function count(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${what} must be a positive integer`)
  }
  return value
}

/** Validate a disposition before any effect; the reason why is named, never defaulted. */
export function checkRetentionDiscard(value: unknown): RetentionDiscard {
  const input = plain(value, "discard disposition")
  if (input.schema !== RETENTION_DISCARD_SCHEMA) {
    throw new Error(`discard disposition schema must be ${RETENTION_DISCARD_SCHEMA}`)
  }
  const known = new Set([
    "schema",
    "entry",
    "entryDevIno",
    "manifestSha256",
    "missingCount",
    "missingSidecarSha256",
    "loss",
    "reason",
    "attribution",
  ])
  const extra = Object.keys(input).find((key) => !known.has(key))
  if (extra !== undefined) throw new Error(`discard disposition has an unknown field '${extra}'`)
  const manifestSha256 = text(input.manifestSha256, "discard manifestSha256")
  const missingSidecarSha256 = text(input.missingSidecarSha256, "discard missingSidecarSha256")
  if (!HEX64.test(manifestSha256)) throw new Error("discard manifestSha256 must be a sha256")
  if (!HEX64.test(missingSidecarSha256)) throw new Error("discard missingSidecarSha256 must be a sha256")
  if (!Array.isArray(input.loss) || input.loss.length === 0) {
    throw new Error("discard loss must name at least one component")
  }
  const loss = input.loss.map((raw, index): MissingComponentLoss => {
    const where = `discard loss[${String(index)}]`
    const entry = plain(raw, where)
    if (entry.rootsUnknown !== undefined || !Array.isArray(entry.roots)) {
      throw new Error(`${where} must name its commit roots; a loss whose roots are unknown cannot be discarded`)
    }
    const types = plain(entry.types, `${where}.types`)
    for (const [type, n] of Object.entries(types)) count(n, `${where}.types.${type}`)
    return {
      component: text(entry.component, `${where}.component`),
      count: count(entry.count, `${where}.count`),
      types: types as Record<string, number>,
      roots: entry.roots.map((root, at) => {
        const item = plain(root, `${where}.roots[${String(at)}]`)
        if (typeof item.oid !== "string" || !OID.test(item.oid)) {
          throw new Error(`${where}.roots[${String(at)}].oid must be a full object id`)
        }
        if (typeof item.subject !== "string") throw new Error(`${where}.roots[${String(at)}].subject must be a string`)
        return { oid: item.oid, subject: item.subject }
      }),
    }
  })
  return {
    schema: RETENTION_DISCARD_SCHEMA,
    entry: text(input.entry, "discard entry"),
    entryDevIno: text(input.entryDevIno, "discard entryDevIno"),
    manifestSha256,
    missingCount: count(input.missingCount, "discard missingCount"),
    missingSidecarSha256,
    loss,
    reason: text(input.reason, "discard reason"),
    attribution: checkRetentionAttribution(input.attribution),
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, canonical(item)]),
  )
}

/** The sha256 of the disposition's canonical JSON: the identity a decision record and a removal row both carry. */
export function retentionDiscardDigest(discard: RetentionDiscard): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(discard)))
    .digest("hex")
}

/**
 * The first field where the disposition differs from what this pass observed, or undefined when it names exactly
 * this loss. An observed loss with unknown roots never matches.
 */
export function retentionDiscardMismatch(
  discard: RetentionDiscard,
  observed: Readonly<{
    entry: string
    entryDevIno: string | undefined
    manifestSha256: string | undefined
    missingCount: number
    missingSidecarSha256: string | undefined
    loss: readonly MissingComponentLoss[]
  }>,
): string | undefined {
  if (discard.entry !== observed.entry) return `entry is ${observed.entry}, not ${discard.entry}`
  if (discard.entryDevIno !== observed.entryDevIno) {
    return `entry identity is ${observed.entryDevIno ?? "unread"}, not ${discard.entryDevIno}`
  }
  if (discard.manifestSha256 !== observed.manifestSha256) {
    return `manifest sha256 is ${observed.manifestSha256 ?? "unread"}, not ${discard.manifestSha256}`
  }
  const unknown = observed.loss.find((component) => component.roots === undefined)
  if (unknown !== undefined) {
    return `commit roots of ${unknown.component} are unknown (${unknown.rootsUnknown ?? "no reason recorded"})`
  }
  if (discard.missingCount !== observed.missingCount) {
    return `${String(observed.missingCount)} un-witnessed object(s), not ${String(discard.missingCount)}`
  }
  if (discard.missingSidecarSha256 !== observed.missingSidecarSha256) {
    return `missing-object list sha256 is ${observed.missingSidecarSha256 ?? "absent"}, not ${discard.missingSidecarSha256}`
  }
  if (JSON.stringify(canonical(discard.loss)) !== JSON.stringify(canonical(observed.loss))) {
    return "the per-component loss (counts, types or commit roots) differs"
  }
  return undefined
}
