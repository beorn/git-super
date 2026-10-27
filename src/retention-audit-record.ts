import { createHash } from "node:crypto"
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { canonicalEstateScan, type EstateScan } from "./retention-estate.ts"
import type { RetentionGateId, RetentionGateStatus } from "./retention-verify.ts"

export const RETENTION_AUDIT_SCHEMA = "git-super/retention-audit/1"

export type RetentionAuditRecord = Readonly<{
  schema: typeof RETENTION_AUDIT_SCHEMA
  runId: string
  original: Readonly<{ path: string; sha256: string; byteLength: number }>
  provenance: Readonly<{
    observedAt: string
    tool: Readonly<{ name: string; version: string }>
    common: Readonly<{ path: string; head: string }>
    estate: Readonly<{
      namespaceRoots: readonly string[]
      scanDigest: string
      counts: Readonly<{
        objectDirs: number
        alternatesFiles: number
        borrowers: number
        registries: number
        survivorIntoRemoval: number
      }>
    }>
  }>
  checks: readonly Readonly<{
    gate: RetentionGateId
    outcome: RetentionGateStatus
    reason: string
    basis: "recorded" | "observed" | "unavailable"
  }>[]
}>

export type RetentionAuditBinding = Readonly<{ path: string; sha256: string; devIno: string }>
export type ReadRetentionAudit = Readonly<{ binding: RetentionAuditBinding; record: RetentionAuditRecord }>

const SHA256 = /^[a-f0-9]{64}$/
const AUDIT_NAME = /^retention-audit-([a-f0-9]{64})\.json$/

/** The same complete canonical estate value is used by production, matching and held comparisons. */
export function retentionEstateDigest(estate: EstateScan): string {
  return createHash("sha256").update(canonicalEstateScan(estate)).digest("hex")
}

function recordObject(value: unknown, subject: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${subject} is not an audit record object`)
  }
  return value as Record<string, unknown>
}

function requireRecord(valid: boolean, subject: string): asserts valid {
  if (!valid) throw new Error(`${subject} is invalid in the native retention audit`)
}

/** Validate native records, including well-formed stale ones; never trust a stored check as authority. */
export function readRetentionAudits(
  entry: string,
  manifestPath: string,
  gateOrder: readonly RetentionGateId[],
): readonly ReadRetentionAudit[] {
  const records: ReadRetentionAudit[] = []
  for (const name of readdirSync(entry).sort()) {
    const match = AUDIT_NAME.exec(name)
    if (match === null) continue // Unrecognized siblings remain subject to the verifier's exact wrapper check.
    const path = join(entry, name)
    const stat = lstatSync(path)
    requireRecord(stat.isFile() && !stat.isSymbolicLink() && realpathSync(path) === resolve(path), path)
    const bytes = readFileSync(path)
    const sha256 = createHash("sha256").update(bytes).digest("hex")
    requireRecord(match[1] === sha256, `${path} byte digest`)
    let parsed: unknown
    try {
      parsed = JSON.parse(bytes.toString("utf8"))
    } catch (error) {
      throw new Error(`cannot decode native retention audit ${path}: ${String(error)}`, { cause: error })
    }
    const value = recordObject(parsed, path)
    requireRecord(value["schema"] === RETENTION_AUDIT_SCHEMA, `${path} schema`)
    requireRecord(
      typeof value["runId"] === "string" &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value["runId"]),
      `${path} runId`,
    )
    const original = recordObject(value["original"], `${path} original`)
    requireRecord(original["path"] === manifestPath, `${path} original manifest path`)
    requireRecord(typeof original["sha256"] === "string" && SHA256.test(original["sha256"]), `${path} original digest`)
    requireRecord(
      Number.isSafeInteger(original["byteLength"]) && Number(original["byteLength"]) >= 0,
      `${path} original byte length`,
    )
    const provenance = recordObject(value["provenance"], `${path} provenance`)
    requireRecord(
      typeof provenance["observedAt"] === "string" && Number.isFinite(Date.parse(provenance["observedAt"])),
      `${path} observation clock`,
    )
    const tool = recordObject(provenance["tool"], `${path} tool`)
    requireRecord(typeof tool["name"] === "string" && tool["name"].trim() !== "", `${path} tool name`)
    requireRecord(
      typeof tool["version"] === "string" &&
        /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(tool["version"]),
      `${path} required tool version`,
    )
    const common = recordObject(provenance["common"], `${path} common`)
    requireRecord(typeof common["path"] === "string" && isAbsolute(common["path"]), `${path} common path`)
    requireRecord(
      typeof common["head"] === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(common["head"]),
      `${path} common HEAD`,
    )
    const estate = recordObject(provenance["estate"], `${path} estate`)
    const roots = estate["namespaceRoots"]
    requireRecord(
      Array.isArray(roots) &&
        roots.length > 0 &&
        roots.every((root: unknown) => typeof root === "string" && root.trim() !== ""),
      `${path} namespace declaration`,
    )
    requireRecord(
      typeof estate["scanDigest"] === "string" && SHA256.test(estate["scanDigest"]),
      `${path} estate digest`,
    )
    const counts = recordObject(estate["counts"], `${path} counts`)
    for (const field of ["objectDirs", "alternatesFiles", "borrowers", "registries", "survivorIntoRemoval"]) {
      requireRecord(Number.isSafeInteger(counts[field]) && Number(counts[field]) >= 0, `${path} ${field} count`)
    }
    const checks = value["checks"]
    requireRecord(Array.isArray(checks) && checks.length === gateOrder.length, `${path} complete check set`)
    for (const [index, check] of checks.entries()) {
      const row = recordObject(check, `${path} check ${index + 1}`)
      requireRecord(row["gate"] === gateOrder[index], `${path} check order`)
      const outcome = row["outcome"]
      requireRecord(
        typeof outcome === "string" && ["pass", "blocked", "unknown"].includes(outcome),
        `${path} check outcome`,
      )
      requireRecord(
        typeof row["reason"] === "string" && row["reason"].startsWith(`${String(row["outcome"])}: `),
        `${path} check reason`,
      )
      const basis = row["basis"]
      requireRecord(
        typeof basis === "string" && ["recorded", "observed", "unavailable"].includes(basis),
        `${path} check basis`,
      )
      requireRecord(!("status" in row), `${path} obsolete persisted binary status`)
    }
    records.push({
      binding: { path, sha256, devIno: `${stat.dev}:${stat.ino}` },
      record: value as unknown as RetentionAuditRecord,
    })
  }
  return records
}

/** Two validity keys only; common HEAD and observation clocks are provenance, never freshness. */
export function matchRetentionAudit(
  records: readonly ReadRetentionAudit[],
  original: Buffer,
  estate: EstateScan,
): Readonly<{ selected?: ReadRetentionAudit; stale: readonly Readonly<{ path: string; reason: string }>[] }> {
  const originalDigest = createHash("sha256").update(original).digest("hex")
  const scanDigest = retentionEstateDigest(estate)
  const stale: { path: string; reason: string }[] = []
  let selected: ReadRetentionAudit | undefined
  for (const candidate of records) {
    const reason =
      candidate.record.original.sha256 !== originalDigest
        ? "original manifest digest changed"
        : candidate.record.original.byteLength !== original.length
          ? "original manifest byte length changed"
          : candidate.record.provenance.estate.scanDigest !== scanDigest
            ? "complete estate digest changed"
            : undefined
    if (reason === undefined)
      selected ??= candidate // readRetentionAudits orders full digest filenames.
    else stale.push({ path: candidate.binding.path, reason })
  }
  return { ...(selected === undefined ? {} : { selected }), stale }
}
