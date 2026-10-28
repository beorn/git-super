import { createHash, randomUUID } from "node:crypto"
import { lstatSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { tmpdir } from "node:os"
import { acquireFlockWithTimeout, type FlockHandle } from "@bearly/flock"
import { DEFAULT_MUTATION_LOCK_WAIT_MS } from "./exclusive.ts"
import { canonicalEstateScan, scanEstate, type EstateScan } from "./retention-estate.ts"
import { runGit } from "./git.ts"
import { publishArtifact } from "./retention-stream.ts"
import {
  readRetentionAudits,
  newestRetentionAudit,
  retentionEstateDigest,
  validateRetentionAudit,
  RETENTION_AUDIT_SCHEMA,
  type RetentionAuditRecord,
} from "./retention-audit-record.ts"
import { gitSuperResult, type GitResultDetail, type GitSuperRepositoryResult, type GitSuperResult } from "./result.ts"
import {
  verifyRetainedEntry,
  inspectRetainedEntryForAudit,
  retentionAuditTool,
  GATE_ORDER,
  type RetentionVerifyOptions,
  type RetentionVerifyResult,
} from "./retention-verify.ts"
import {
  acquireRemovalWriterLeases,
  readRetainedPointer,
  removeRetainedPointer,
  canonicalProspectivePath,
} from "./worktree-removal.ts"

export type RetentionRetireOptions = RetentionVerifyOptions &
  Readonly<{
    common: string
    artifactDir: string
    namespaceRoots: readonly string[]
  }>

type KeepReason =
  | "legacy-unrecorded"
  | "incomplete"
  | "unexpired"
  | "borrower"
  | "identity-unknown"
  | "custody-unknown"
  | "lease-missing"
  | "lease-held"
  | "census-shifted"

function auditIdentity(record: RetentionAuditRecord): string {
  return JSON.stringify({
    original: record.original.sha256,
    estate: record.provenance.estate.scanDigest,
    common: record.provenance.common.head,
    tool: record.provenance.tool,
    outcomes: record.checks.map(({ gate, outcome }) => ({ gate, outcome })),
  })
}

function within(root: string, path: string): boolean {
  const part = relative(root, path)
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part))
}

function keepReason(proof: RetentionVerifyResult): KeepReason {
  if (proof.gates[0]?.status === "unknown") return "legacy-unrecorded"
  if (proof.retainUntil !== undefined && Date.parse(proof.clock) <= Date.parse(proof.retainUntil)) return "unexpired"
  if (proof.estate?.survivorIntoRemoval.length) return "borrower"
  if (proof.gates[0]?.status !== "pass") return "identity-unknown"
  if (proof.gates.find((gate) => gate.status !== "pass")?.gate === "positive-custody") return "custody-unknown"
  return "incomplete"
}

/** Compare actual, hash-checked proof contents, not hashes derived from differing pass clocks. */
function proofFacts(proof: RetentionVerifyResult): { facts: string; path: string } {
  if (proof.certificate === undefined || proof.artifactDir === undefined) {
    throw new Error(`candidate ${proof.entry} has no certificate or artifact directory`)
  }
  if (proof.estate === undefined) throw new Error(`candidate ${proof.entry} has no estate census`)
  const bytes = readFileSync(proof.certificate.path)
  const artifactDir = proof.artifactDir
  if (createHash("sha256").update(bytes).digest("hex") !== proof.certificate.digest) {
    throw new Error(`certificate bytes disagree with their digest: ${proof.certificate.path}`)
  }
  const certificate: unknown = JSON.parse(bytes.toString("utf8"))
  // Only the certificate's own clock/elapsed and these artifact path fields vary by pass.
  // All other keys, array order, identities, manifests, digests and census facts compare.
  const artifactPaths = new Set([
    "artifactDir",
    "atRiskSidecar",
    "missingRootsSidecar",
    "witnessSidecar",
    "missingSidecar",
  ])
  const stable = (value: unknown, depth: number): unknown => {
    if (Array.isArray(value)) return value.map((item) => stable(item, depth + 1))
    if (value === null || typeof value !== "object") return value
    const entries: [string, unknown][] = []
    for (const [key, item] of Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) {
      if (depth === 0 && (key === "clock" || key === "elapsedMs")) continue
      const estate: unknown = item
      if (depth === 0 && key === "estate" && estate !== null && typeof estate === "object" && !Array.isArray(estate)) {
        entries.push([key, canonicalEstateScan(estate)])
        continue
      }
      entries.push([
        key,
        artifactPaths.has(key) && typeof item === "string" && within(artifactDir, item)
          ? `artifact:${relative(artifactDir, item)}`
          : stable(item, depth + 1),
      ])
    }
    return Object.fromEntries(entries)
  }
  return {
    facts: JSON.stringify({ certificate: stable(certificate, 0), estate: canonicalEstateScan(proof.estate) }),
    path: proof.certificate.path,
  }
}

function pointers(proof: RetentionVerifyResult): ReturnType<typeof readRetainedPointer>[] {
  if (proof.estate === undefined) throw new Error(`candidate ${proof.entry} has no estate census`)
  return proof.estate.registries.flatMap((registry) =>
    readdirSync(registry)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => readRetainedPointer(join(registry, name))),
  )
}

/** Raw original identity and complete current census remain required even when historical checks are unknown. */
function auditSnapshot(
  entry: string,
  root: string,
  proof: RetentionVerifyResult,
  estate: EstateScan,
): { original: Buffer; facts: string } {
  const manifestPath = join(entry, "manifest.json")
  const manifest = lstatSync(manifestPath)
  if (!manifest.isFile() || manifest.isSymbolicLink() || realpathSync(manifestPath) !== manifestPath) {
    throw new Error(`audit original ${manifestPath} is not a regular nonredirected file`)
  }
  const original = readFileSync(manifestPath)
  const sha256 = createHash("sha256").update(original).digest("hex")
  if (proof.manifestSha256 !== undefined && proof.manifestSha256 !== sha256) {
    throw new Error(`audit original ${manifestPath} changed during evaluation`)
  }
  const entryIdentity = lstatSync(entry)
  const rootIdentity = lstatSync(root)
  return {
    original,
    facts: JSON.stringify({
      entry: `${entryIdentity.dev}:${entryIdentity.ino}`,
      root: `${rootIdentity.dev}:${rootIdentity.ino}`,
      original: { sha256, byteLength: original.length, devIno: `${manifest.dev}:${manifest.ino}` },
      estate: retentionEstateDigest(estate),
      wrappers: readRetentionAudits(entry, manifestPath, GATE_ORDER).map((record) => record.binding),
      outcomes: proof.gates.map(({ gate, status }) => ({ gate, status })),
    }),
  }
}

/** The only retained-entry actuator; a standalone preliminary proof remains no capability. */
export async function retireRetainedEntry(options: RetentionRetireOptions): Promise<GitSuperResult> {
  return runRetentionOperation(options, "retire")
}

/** Audit shares the held retention operation and returns before its deletion boundary. */
export async function auditRetainedEntry(options: RetentionRetireOptions): Promise<GitSuperResult> {
  return runRetentionOperation({ ...options, clock: options.clock ?? new Date() }, "audit")
}

async function runRetentionOperation(
  options: RetentionRetireOptions,
  mode: "retire" | "audit",
): Promise<GitSuperResult> {
  let entry = resolve(options.entry)
  let root = resolve(options.root)
  let commonLease: FlockHandle | undefined
  let leases: ReturnType<typeof acquireRemovalWriterLeases> | undefined
  let crossed = false
  let phase = "identity"
  let proof: RetentionVerifyResult | undefined
  let auditPath: string | undefined
  let auditPublished = false
  const rows: GitSuperRepositoryResult[] = []
  const row = (repository: string, state: GitSuperRepositoryResult["state"], detail: GitResultDetail): void => {
    rows.push({ repository, state, detail, refs: [] })
  }
  const kept = (code: KeepReason, message: string): GitSuperResult => {
    const detail: GitResultDetail = {
      code,
      phase,
      message,
      paths: [entry],
      ...(proof?.certificate === undefined ? {} : { evidence: proof.certificate.path }),
      next: "Keep this entry; resolve the named observation before another explicit retirement.",
    }
    row(entry, "unchanged", detail)
    return gitSuperResult(rows, detail)
  }
  const remaining = (): string => {
    try {
      return lstatSync(entry).isDirectory() ? "partly present" : "present with changed shape"
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "gone" : `unknown (${String(error)})`
    }
  }
  let result: GitSuperResult
  try {
    result = await (async (): Promise<GitSuperResult> => {
      entry = realpathSync(entry)
      root = realpathSync(root)
      const common = realpathSync(options.common)
      const assertEntry = (): void => {
        const stat = lstatSync(entry)
        if (
          entry !== resolve(options.entry) ||
          root !== resolve(options.root) ||
          dirname(entry) !== root ||
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          realpathSync(entry) !== entry ||
          within(entry, common)
        ) {
          throw new Error(
            `entry ${options.entry}, canonical entry ${entry}, root ${root} and common ${common} do not establish separate plain custody`,
          )
        }
      }
      assertEntry()
      if (options.namespaceRoots.length === 0) return kept("incomplete", "No complete managed namespace was declared.")
      if (mode === "audit") {
        if (!options.artifactDir.trim() || options.namespaceRoots.some((path) => !path.trim())) {
          throw new Error("retention audit requires explicit nonempty artifact and namespace declarations")
        }
        const artifact = canonicalProspectivePath(options.artifactDir)
        if (
          within(root, artifact) ||
          within(entry, artifact) ||
          (options.allowTemporaryArtifactDir !== true && within(canonicalProspectivePath(tmpdir()), artifact))
        ) {
          throw new Error(
            `audit artifact ${artifact} must be external to ${root} and outside the OS temporary directory`,
          )
        }
      }
      phase = "preliminary-proof"
      const preOptions = { ...options, entry, root, artifactDir: join(options.artifactDir, "pre") }
      const preliminaryEstate =
        mode === "audit"
          ? scanEstate(options.namespaceRoots, [entry], options.bounds?.estate, options.monotonic)
          : undefined
      if (preliminaryEstate?.status === "unknown") {
        throw new Error(`audit estate unavailable: ${preliminaryEstate.detail}`)
      }
      proof =
        preliminaryEstate === undefined
          ? await verifyRetainedEntry(preOptions)
          : await inspectRetainedEntryForAudit(preOptions, preliminaryEstate)
      if (mode === "retire" && proof.verdict !== "candidate") return kept(keepReason(proof), proof.reasons.join("; "))
      const before = proof.verdict === "candidate" ? proofFacts(proof) : undefined
      const auditBefore =
        preliminaryEstate === undefined ? undefined : auditSnapshot(entry, root, proof, preliminaryEstate)
      const registrations = pointers(proof)
      if (proof.estate === undefined) throw new Error(`candidate ${entry} has no estate census`)
      phase = "owner-identity"
      const observedObjects = [
        ...proof.estate.objectDirs,
        ...proof.estate.borrowers.filter((edge) => basename(edge.borrower) === "objects").map((edge) => edge.borrower),
      ]
      const objectOwners: string[] = []
      for (const objects of observedObjects) {
        if (within(entry, objects)) continue
        const owner = dirname(objects)
        if (realpathSync(join(owner, "objects")) !== realpathSync(objects)) {
          throw new Error(`object directory ${objects} has no proved Git owner at ${owner}`)
        }
        objectOwners.push(owner)
      }
      const owners = [...new Set([...objectOwners, ...proof.estate.registries.map(dirname), common])].filter(
        (owner) => !within(entry, owner),
      )
      phase = "common-lease"
      const commonPath = join(common, "yrd-worktree-mutations", "writer.lock")
      const acquired = acquireFlockWithTimeout(commonPath, DEFAULT_MUTATION_LOCK_WAIT_MS, {
        create: false,
        createParent: false,
        noFollow: true,
      })
      if (acquired === null) return kept("lease-held", `Existing common lease ${commonPath} is held; entry preserved.`)
      commonLease = acquired
      phase = "owner-leases"
      leases = acquireRemovalWriterLeases(entry, undefined, {
        existingOnly: true,
        additionalGitDirs: owners,
        skip: [commonPath],
      })
      phase = "held-proof"
      const heldOptions = {
        ...options,
        entry,
        root,
        artifactDir: join(options.artifactDir, "held"),
      }
      const heldEstate =
        mode === "audit"
          ? scanEstate(options.namespaceRoots, [entry], options.bounds?.estate, options.monotonic)
          : undefined
      if (heldEstate?.status === "unknown") throw new Error(`held audit estate unavailable: ${heldEstate.detail}`)
      const commonHead = mode === "audit" ? runGit(common, ["rev-parse", "--verify", "HEAD"]).trim() : undefined
      const held =
        heldEstate === undefined
          ? await verifyRetainedEntry(heldOptions)
          : await inspectRetainedEntryForAudit(heldOptions, heldEstate)
      const after = held.verdict === "candidate" ? proofFacts(held) : undefined
      if (mode === "audit") {
        if (heldEstate === undefined || auditBefore === undefined || commonHead === undefined) {
          throw new Error("held audit provenance is incomplete")
        }
        const current = auditSnapshot(entry, root, held, heldEstate)
        if (
          auditBefore.facts !== current.facts ||
          (before !== undefined && (after === undefined || before.facts !== after.facts)) ||
          JSON.stringify(registrations) !== JSON.stringify(pointers(held))
        ) {
          throw new Error(`audit preliminary and held observations differ for ${entry}; no record published`)
        }
        assertEntry()
        const record: RetentionAuditRecord = {
          schema: RETENTION_AUDIT_SCHEMA,
          runId: randomUUID(),
          original: {
            path: join(entry, "manifest.json"),
            sha256: createHash("sha256").update(current.original).digest("hex"),
            byteLength: current.original.length,
          },
          provenance: {
            observedAt: held.clock,
            tool: retentionAuditTool(),
            common: { path: common, head: commonHead },
            estate: {
              namespaceRoots: options.namespaceRoots,
              scanDigest: retentionEstateDigest(heldEstate),
              counts: {
                objectDirs: heldEstate.objectDirs.length,
                alternatesFiles: heldEstate.alternatesFiles,
                borrowers: heldEstate.borrowers.length,
                registries: heldEstate.registries.length,
                survivorIntoRemoval: heldEstate.survivorIntoRemoval.length,
              },
            },
          },
          checks: held.gates.map((gate) => ({
            gate: gate.gate,
            outcome: gate.status,
            reason: `${gate.status}: ${gate.message}`,
            basis:
              gate.status === "unknown"
                ? "unavailable"
                : gate.gate === "identity-eligibility" || gate.gate === "copy-manifest"
                  ? "recorded"
                  : "observed",
          })),
        }
        const blocked = record.checks.filter((check) => check.outcome === "blocked").length
        const unknown = record.checks.filter((check) => check.outcome === "unknown").length
        const bytes = `${JSON.stringify(record, null, 2)}\n`
        const existing = readRetentionAudits(entry, join(entry, "manifest.json"), GATE_ORDER)
        const newest = newestRetentionAudit(existing)
        if (newest !== undefined && auditIdentity(newest.record) === auditIdentity(record)) {
          const detail: GitResultDetail = {
            code: blocked + unknown === 0 ? "audit-pass" : "audit-incomplete",
            phase: "publish-audit",
            message: `Audit unchanged since ${newest.record.provenance.observedAt}: ${blocked} blocked, ${unknown} unknown; no record published, entry preserved.`,
            evidence: newest.binding.path,
            paths: [entry, newest.binding.path],
          }
          row(entry, "unchanged", detail)
          return gitSuperResult(rows, detail)
        }
        auditPath = join(entry, `retention-audit-${createHash("sha256").update(bytes).digest("hex")}.json`)
        validateRetentionAudit(record, auditPath, join(entry, "manifest.json"), GATE_ORDER)
        phase = "publish-audit"
        publishArtifact(auditPath, bytes, { replace: false })
        auditPublished = true
        if (held.staleAudits !== undefined) {
          for (const stale of held.staleAudits) {
            row(stale.path, "unchanged", {
              code: "audit-stale",
              phase,
              message: `Stale audit ${stale.path}: ${stale.reason}; preserved.`,
            })
          }
        }
        const detail: GitResultDetail = {
          code: blocked + unknown === 0 ? "audit-pass" : "audit-incomplete",
          phase,
          message: `Audit ${auditPath}: ${blocked} blocked, ${unknown} unknown; original unchanged, entry preserved.`,
          evidence: auditPath,
          paths: [entry, auditPath],
        }
        row(entry, "updated", detail)
        return gitSuperResult(rows, detail)
      }
      if (
        before === undefined ||
        after === undefined ||
        before.facts !== after.facts ||
        JSON.stringify(registrations) !== JSON.stringify(pointers(held))
      ) {
        return kept("census-shifted", `Preliminary and held proofs differ for ${entry}; nothing removed.`)
      }
      assertEntry()
      const stat = lstatSync(entry)
      if (held.entry !== entry || held.entryDevIno !== `${stat.dev}:${stat.ino}` || held.root !== root) {
        return kept("census-shifted", `Held entry identity no longer names ${entry} inside ${root}; preserved.`)
      }
      phase = "delete-entry"
      crossed = true
      // The family's existing primitive. Every acquired handle is still held in this process.
      rmSync(entry, { recursive: true, force: false })
      if (remaining() !== "gone") throw new Error(`entry readback after deletion is ${remaining()}`)
      const evidence = after.path
      row(entry, "updated", {
        code: "retired",
        phase,
        message: `Removed ${entry}; absence verified.`,
        evidence,
        paths: [before.path, evidence],
      })
      phase = "retire-pointers"
      for (const pointer of registrations) {
        if (pointer.retained !== join(entry, "modules") || pointer.manifest !== join(entry, "manifest.json")) continue
        try {
          removeRetainedPointer(pointer)
        } catch (error) {
          row(pointer.path, "failed", {
            code: "pointer-cleanup-failed",
            phase,
            message: String(error),
            paths: [pointer.path],
          })
          throw error
        }
        row(pointer.path, "updated", {
          code: "pointer-retired",
          phase,
          message: `Removed unchanged pointer ${pointer.path}.`,
        })
      }
      return gitSuperResult(rows, {
        code: "retired",
        phase: "complete",
        message: `Retired ${entry}; lender locks remain held by their owners.`,
        evidence,
        paths: [before.path, evidence],
      })
    })()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (mode === "audit") {
      let recordState = "not attempted"
      if (auditPath !== undefined) {
        try {
          recordState = lstatSync(auditPath).isFile() ? "present" : "present with changed shape"
        } catch (observation) {
          recordState =
            (observation as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : `unknown (${String(observation)})`
        }
      }
      const detail: GitResultDetail = {
        code: "audit-failed",
        phase,
        message: `${message}; audit record ${auditPath ?? "not planned"}: ${recordState}; entry preserved, no retry.`,
        paths: auditPath === undefined ? [entry] : [entry, auditPath],
      }
      row(entry, "failed", detail)
      result = { ...gitSuperResult(rows, detail), partial: auditPublished || recordState.startsWith("present") }
    } else if (!crossed) {
      const code: KeepReason =
        (error as NodeJS.ErrnoException).code === "ENOENT" && phase.includes("lease")
          ? "lease-missing"
          : phase.includes("lease") && message.includes(" is held")
            ? "lease-held"
            : phase.includes("lease") || phase === "identity" || phase === "owner-identity"
              ? "identity-unknown"
              : "incomplete"
      result = kept(code, `${phase}: ${message}; entry preserved.`)
    } else {
      const state = remaining()
      if (!rows.some((item) => item.repository === entry)) {
        row(entry, state === "gone" ? "updated" : "unknown", {
          code: "entry-readback",
          phase,
          message: `${entry}: ${state}`,
        })
      }
      const detail = {
        code: "retirement-partial",
        phase,
        message: `${message}; actual entry state: ${state}; no retry performed.`,
        paths: [entry],
      }
      if (!rows.some((item) => item.state === "failed")) row(entry, "failed", detail)
      result = { ...gitSuperResult(rows, detail), partial: true }
    }
  }
  for (const release of [() => leases?.release(), () => commonLease?.release()]) {
    try {
      release()
    } catch (error) {
      const detail = { code: "lease-release-failed", phase: "release", message: String(error), paths: [entry] }
      row(entry, "failed", detail)
      result = { ...gitSuperResult(rows, detail), partial: crossed || auditPublished }
    }
  }
  return result
}
