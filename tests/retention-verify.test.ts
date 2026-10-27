/**
 * @failure A retained entry is verified from a partial walk, or a preliminary `candidate` is read as removal authority.
 * @level l1
 * @consumer Yrd environment close through git-super worktree remove --retain; #27443(b)
 * @reach fs-walk <fixture-only: the real retention writer, worktree add/remove and the estate scan use mkdtempSync(tmpdir()) Git repos>
 * @testonly none
 */
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative } from "node:path"
import { tryAcquireFlock } from "@bearly/flock"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { runCli } from "../src/cli.ts"
import { digestDirectory, emitCertificate } from "../src/retention-certificate.ts"
import { alternateEntries } from "../src/alternates.ts"
import type { GitSuperResult } from "../src/result.ts"
import { scanContents, type ComponentContents } from "../src/retention-contents.ts"
import { scanCustody } from "../src/retention-custody.ts"
import { scanEstate } from "../src/retention-estate.ts"
import {
  readRetentionAudits,
  matchRetentionAudit,
  retentionEstateDigest,
  type RetentionAuditRecord,
} from "../src/retention-audit-record.ts"
import { readLines, SidecarWriter } from "../src/retention-stream.ts"
import {
  DEFAULT_NON_OBJECT_METADATA_BOUNDS,
  GATE_ORDER,
  type RetentionVerifyResult,
  retentionRemovalBoundary,
  verifyRetainedEntry,
} from "../src/retention-verify.ts"
import { canonicalProspectivePath, type ManifestEntry } from "../src/worktree-removal.ts"
import { auditRetainedEntry } from "../src/retention-remove.ts"

/** The shared, real-writer fixture and the pristine snapshot used to restore it in place. */
let fixtureRoot: string | undefined

afterAll(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
})

const environment: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Git Super Test",
  GIT_AUTHOR_EMAIL: "git-super@example.test",
  GIT_COMMITTER_NAME: "Git Super Test",
  GIT_COMMITTER_EMAIL: "git-super@example.test",
  GIT_TERMINAL_PROMPT: "0",
}

function git(repo: string, args: readonly string[]): string {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env: environment })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed in ${repo}`)
  return result.stdout.trim()
}

function outputSink(): { output: string; write(value: string): void } {
  return {
    output: "",
    write(value) {
      this.output += value
    },
  }
}

/**
 * One retained entry produced by the REAL writer (a superproject worktree with one submodule),
 * built once and reused: the suite runs beside a heavily loaded shared host, and rebuilding the
 * fixture per case starves neighbouring files (measured 2026-10-05: ten builds tipped
 * tests/diff.test.ts past its timeout in the full run).
 */
let base: Readonly<{ root: string; entry: string; retainUntil: string; artifactDir: string }>
let pristine: string | undefined

beforeAll(async () => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-retention-verify-"))
  const dependency = join(fixtureRoot, "dependency")
  const product = join(fixtureRoot, "product")
  mkdirSync(dependency, { recursive: true })
  git(dependency, ["init", "-q", "-b", "main"])
  writeFileSync(join(dependency, "dep.ts"), "export const dep = 1\n")
  git(dependency, ["add", "dep.ts"])
  git(dependency, ["commit", "-q", "-m", "dep"])
  mkdirSync(product, { recursive: true })
  git(product, ["init", "-q", "-b", "main"])
  git(product, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", dependency, "vendor/dep"])
  git(product, ["commit", "-q", "-m", "add vendor/dep"])
  const worktree = join(fixtureRoot, "candidate")
  const root = join(fixtureRoot, "retained")
  expect(await runCli(["--repo", product, "worktree", "add", worktree, "HEAD"], outputSink(), outputSink())).toBe(0)
  expect(
    await runCli(
      ["--repo", product, "--json", "worktree", "remove", worktree, "--retain", root],
      outputSink(),
      outputSink(),
    ),
  ).toBe(0)
  const entries = readdirSync(root)
  expect(entries).toHaveLength(1)
  const entry = join(root, entries[0] as string)
  const manifest = JSON.parse(readFileSync(join(entry, "manifest.json"), "utf8")) as { retainUntil: string }
  // The manifest records absolute paths, so a relocation is refused by design (gate 1). Mutation
  // cases therefore restore the entry in place from this snapshot rather than verifying a copy.
  pristine = join(fixtureRoot, "pristine")
  cpSync(entry, pristine, { recursive: true })
  base = { root, entry, retainUntil: manifest.retainUntil, artifactDir: join(fixtureRoot, "pass") }
}, 120_000)

/**
 * Rewrite the shared entry to its as-written bytes before every case, so a mutation case cannot
 * leak into the next read (see the `pristine` note above).
 */
beforeEach(() => {
  rmSync(base.entry, { recursive: true, force: true })
  cpSync(pristine as string, base.entry, { recursive: true })
  rmSync(base.artifactDir, { recursive: true, force: true })
})

function eligible(): Date {
  return new Date(Date.parse(base.retainUntil) + 1000)
}

function firstFile(root: string): string {
  for (const name of readdirSync(root, { recursive: true }) as string[]) {
    const path = join(root, name)
    if (statSync(path).isFile()) return path
  }
  throw new Error(`no file under ${root}`)
}

async function atRiskComponent(
  sidecarDir: string,
  rows: ReadonlyArray<{ oid: string; type: string; source: string }>,
): Promise<ComponentContents> {
  const writer = new SidecarWriter(sidecarDir, "txt")
  for (const row of [...rows].sort((left, right) => (left.oid < right.oid ? -1 : 1))) {
    writer.add(`${row.oid}\t${row.type}\t${row.source}`)
  }
  return {
    component: ".git",
    effective: rows.length,
    independent: 0,
    atRisk: rows.length,
    atRiskSidecar: await writer.finish(),
    missingRoots: 0,
    missingRootsSample: [],
    elapsedMs: 0,
  }
}

async function sidecarRows(path: string): Promise<string[]> {
  const rows: string[] = []
  for await (const line of readLines(path)) rows.push(line)
  return rows
}

async function prepareRetirementFixture(artifactDir: string, createdLeasePaths: string[]): Promise<void> {
  const path = join(base.entry, "manifest.json")
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
  manifest["retainUntil"] = new Date(Date.now() - 1000).toISOString()
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
  const pre = await verifyRetainedEntry({
    entry: base.entry,
    root: base.root,
    namespaceRoots: [fixtureRoot as string],
    artifactDir: join(artifactDir, "control"),
  })
  expect(pre.verdict).toBe("candidate")
  if (pre.estate === undefined) throw new Error("candidate fixture has no estate census")
  for (const objects of pre.estate.objectDirs) {
    if (!objects.startsWith(`${fixtureRoot}/`)) throw new Error(`fixture escaped its namespace: ${objects}`)
    if (objects.startsWith(`${base.entry}/`)) continue
    const parent = join(dirname(objects), "yrd-worktree-mutations")
    const lockPath = join(parent, "writer.lock")
    if (existsSync(lockPath)) continue
    createdLeasePaths.push(existsSync(parent) ? lockPath : parent)
    using lease = tryAcquireFlock(lockPath)
    expect(lease?.held).toBe(true)
  }
}

function retirementArgs(artifactDir: string): string[] {
  return [
    "--repo",
    join(fixtureRoot as string, "product"),
    "--json",
    "worktree",
    "retention",
    "retire",
    base.entry,
    "--root",
    base.root,
    "--common",
    join(fixtureRoot as string, "product", ".git"),
    "--namespace",
    fixtureRoot as string,
    "--artifact-dir",
    artifactDir,
  ]
}

/** A native-schema record fixture; stored pass claims never replace the verifier's actual checks. */
function fixtureAuditRecord(proof: RetentionVerifyResult, original: Buffer): RetentionAuditRecord {
  if (proof.estate === undefined) throw new Error("fixture has no complete estate")
  const common = join(fixtureRoot as string, "product", ".git")
  return {
    schema: "git-super/retention-audit/1",
    runId: randomUUID(),
    original: {
      path: join(base.entry, "manifest.json"),
      sha256: createHash("sha256").update(original).digest("hex"),
      byteLength: original.length,
    },
    provenance: {
      observedAt: proof.clock,
      tool: { name: "git-super", version: "1.0.0" },
      common: { path: common, head: git(common, ["rev-parse", "HEAD"]) },
      estate: {
        namespaceRoots: [fixtureRoot as string],
        scanDigest: retentionEstateDigest(proof.estate),
        counts: {
          objectDirs: proof.estate.objectDirs.length,
          alternatesFiles: proof.estate.alternatesFiles,
          borrowers: proof.estate.borrowers.length,
          registries: proof.estate.registries.length,
          survivorIntoRemoval: proof.estate.survivorIntoRemoval.length,
        },
      },
    },
    checks: proof.gates.map((gate) => ({
      gate: gate.gate,
      outcome: gate.status,
      reason: `${gate.status}: ${gate.message}`,
      basis: "observed",
    })),
  }
}

function writeAuditRecordFixture(value: unknown): string {
  const bytes = `${JSON.stringify(value, null, 2)}\n`
  const path = join(base.entry, `retention-audit-${createHash("sha256").update(bytes).digest("hex")}.json`)
  writeFileSync(path, bytes, { flag: "wx" })
  return path
}

describe("retention verify gates 1-6", () => {
  it.each(["held-common", "held-original-shift", "missing-common-head"])(
    "audit preserves E and publishes no record for %s",
    async (kind) => {
      const artifactDir = mkdtempSync(join("/var/tmp", "git-super-audit-held-"))
      const createdLeasePaths: string[] = []
      let lease: ReturnType<typeof tryAcquireFlock> | undefined
      try {
        await prepareRetirementFixture(artifactDir, createdLeasePaths)
        const manifestPath = join(base.entry, "manifest.json")
        const original = readFileSync(manifestPath)
        const common = join(fixtureRoot as string, "product", ".git")
        const commonPath = join(common, "yrd-worktree-mutations", "writer.lock")
        let selectedCommon = common
        if (kind === "held-common") {
          lease = tryAcquireFlock(commonPath)
          expect(lease?.held).toBe(true)
        } else if (kind === "missing-common-head") {
          selectedCommon = join(fixtureRoot as string, "unborn-common")
          mkdirSync(selectedCommon)
          createdLeasePaths.push(selectedCommon)
          git(selectedCommon, ["init", "-q", "--bare"])
          const seed = tryAcquireFlock(join(selectedCommon, "yrd-worktree-mutations", "writer.lock"))
          expect(seed?.held).toBe(true)
          seed?.release()
        }
        let shifted = false
        let tick = 0
        const monotonic = () => {
          if (kind === "held-original-shift" && !shifted) {
            const probe = tryAcquireFlock(commonPath, { create: false, createParent: false, noFollow: true })
            if (probe === null) {
              writeFileSync(manifestPath, Buffer.concat([original, Buffer.from("\n")]))
              shifted = true
            } else probe.release()
          }
          return tick++
        }
        const result = await auditRetainedEntry({
          ...base,
          artifactDir,
          common: selectedCommon,
          namespaceRoots: [fixtureRoot as string],
          monotonic,
        })
        expect(result.state).not.toBe("updated")
        expect(readRetentionAudits(base.entry, manifestPath, GATE_ORDER)).toEqual([])
        expect(lstatSync(base.entry).isDirectory()).toBe(true)
        if (kind === "held-original-shift") {
          expect(shifted).toBe(true)
          expect(result.detail?.message).toContain("observations differ")
          expect(readFileSync(manifestPath)).toEqual(Buffer.concat([original, Buffer.from("\n")]))
        } else {
          expect(readFileSync(manifestPath)).toEqual(original)
          expect(result.detail?.code).toBe(kind === "held-common" ? "lease-held" : "audit-failed")
        }
      } finally {
        lease?.release()
        rmSync(artifactDir, { recursive: true, force: true })
        for (const path of createdLeasePaths) rmSync(path, { recursive: true, force: true })
      }
    },
  )

  it.each(["unexpired", "missing-history"])("audit records distinct blocked/unknown outcomes for %s", async (kind) => {
    const artifactDir = mkdtempSync(join("/var/tmp", "git-super-audit-outcome-"))
    const createdLeasePaths: string[] = []
    try {
      await prepareRetirementFixture(artifactDir, createdLeasePaths)
      const manifestPath = join(base.entry, "manifest.json")
      const value = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
      if (kind === "unexpired") value["retainUntil"] = new Date(Date.now() + 86_400_000).toISOString()
      else delete value["head"]
      writeFileSync(manifestPath, `${JSON.stringify(value, null, 2)}\n`)
      const original = readFileSync(manifestPath)
      const stdout = outputSink()
      const stderr = outputSink()
      const args = retirementArgs(artifactDir)
        .filter((argument) => argument !== "--json")
        .map((argument) => (argument === "retire" ? "audit" : argument))
      expect(await runCli(args, stdout, stderr), stderr.output).toBe(1)
      const records = readRetentionAudits(base.entry, manifestPath, GATE_ORDER)
      expect(records).toHaveLength(1)
      expect(records[0]?.record.checks[0]?.outcome).toBe(kind === "unexpired" ? "blocked" : "unknown")
      expect(stdout.output).toContain(kind === "unexpired" ? "1 blocked, 5 unknown" : "0 blocked, 6 unknown")
      for (const check of records[0]?.record.checks ?? []) {
        expect(check.reason).toMatch(/^(pass|blocked|unknown): /)
        expect(check).not.toHaveProperty("status")
      }
      expect(readFileSync(manifestPath)).toEqual(original)
    } finally {
      rmSync(artifactDir, { recursive: true, force: true })
      for (const path of createdLeasePaths) rmSync(path, { recursive: true, force: true })
    }
  })

  it("audit publishes no record for a bounded incomplete estate or missing namespace", async () => {
    const artifactDir = mkdtempSync(join("/var/tmp", "git-super-audit-incomplete-"))
    try {
      const manifestPath = join(base.entry, "manifest.json")
      const original = readFileSync(manifestPath)
      let tick = 0
      const result = await auditRetainedEntry({
        ...base,
        artifactDir,
        common: join(fixtureRoot as string, "product", ".git"),
        namespaceRoots: [fixtureRoot as string],
        bounds: { estate: { maxAlternatesFiles: 60_000, scanMs: 0 } },
        monotonic: () => tick++,
      })
      expect(result.detail?.code).toBe("audit-failed")
      expect(result.detail?.message).toContain("estate unavailable")
      const args = retirementArgs(artifactDir).map((argument) => (argument === "retire" ? "audit" : argument))
      args.splice(args.indexOf("--namespace"), 2)
      const stderr = outputSink()
      expect(await runCli(args, outputSink(), stderr)).not.toBe(0)
      expect(stderr.output).toContain("--namespace")
      const empty = await auditRetainedEntry({
        ...base,
        artifactDir,
        common: join(fixtureRoot as string, "product", ".git"),
        namespaceRoots: [],
      })
      expect(empty.detail?.code).toBe("incomplete")
      expect(empty.detail?.message).toContain("No complete managed namespace")
      expect(readRetentionAudits(base.entry, manifestPath, GATE_ORDER)).toEqual([])
      expect(readFileSync(manifestPath)).toEqual(original)
    } finally {
      rmSync(artifactDir, { recursive: true, force: true })
    }
  })

  it("native legacy retirement preserves original and selected audit bytes in the checked external bundle", async () => {
    const artifactDir = mkdtempSync(join("/var/tmp", "git-super-legacy-preserve-"))
    const createdLeasePaths: string[] = []
    try {
      await prepareRetirementFixture(artifactDir, createdLeasePaths)
      const modern = await verifyRetainedEntry({
        ...base,
        namespaceRoots: [fixtureRoot as string],
        artifactDir: join(artifactDir, "fixture"),
      })
      expect(modern.verdict).toBe("candidate")
      const originalPath = join(base.entry, "manifest.json")
      const legacy = JSON.parse(readFileSync(originalPath, "utf8")) as Record<string, unknown>
      for (const field of ["repositories", "writerLocks", "createdWriterLocks", "notCompared"]) delete legacy[field]
      const original = Buffer.from(`${JSON.stringify(legacy, null, 2)}\n`)
      writeFileSync(originalPath, original)
      const auditPath = writeAuditRecordFixture(fixtureAuditRecord(modern, original))
      const auditBytes = readFileSync(auditPath)
      // The old bundle's observed size fits exactly; preserving the two new evidence files must exceed it.
      const oldBundle = join(artifactDir, "fixture", "metadata")
      const oldBytes = (readdirSync(oldBundle, { recursive: true }) as string[]).reduce((sum, path) => {
        const stat = lstatSync(join(oldBundle, path))
        return sum + (stat.isFile() ? stat.size : 0)
      }, 0)
      const bounded = await verifyRetainedEntry({
        ...base,
        namespaceRoots: [fixtureRoot as string],
        artifactDir: join(artifactDir, "budget"),
        bounds: { metadata: { maxBytes: oldBytes } },
      })
      expect(bounded.verdict).toBe("unknown")
      expect(bounded.gates.find((gate) => gate.gate === "copy-manifest")?.message).toContain("byte bound")
      expect(readFileSync(originalPath)).toEqual(original)
      expect(readFileSync(auditPath)).toEqual(auditBytes)
      const stdout = outputSink()
      const stderr = outputSink()
      expect(await runCli(retirementArgs(artifactDir), stdout, stderr), stderr.output || stdout.output).toBe(0)
      expect(() => lstatSync(base.entry)).toThrowError(expect.objectContaining({ code: "ENOENT" }))
      const certificate = JSON.parse(
        readFileSync(join(artifactDir, "held", "retirement-certificate.json"), "utf8"),
      ) as {
        audit: { path: string; sha256: string }
        wrapperRecords: readonly { path: string; sha256: string; metadataPath?: string }[]
      }
      expect(isAbsolute(certificate.audit.path)).toBe(false)
      const bundle = join(artifactDir, "held", "metadata")
      expect(readFileSync(join(bundle, certificate.audit.path))).toEqual(auditBytes)
      expect(certificate.audit.sha256).toBe(createHash("sha256").update(auditBytes).digest("hex"))
      const originalBinding = certificate.wrapperRecords.find((record) => record.path === originalPath)
      expect(originalBinding).toMatchObject({
        sha256: createHash("sha256").update(original).digest("hex"),
        metadataPath: "retention-evidence/manifest.json",
      })
      if (originalBinding?.metadataPath === undefined) throw new Error("certificate lost original metadata reference")
      expect(readFileSync(join(bundle, originalBinding.metadataPath))).toEqual(original)
    } finally {
      rmSync(artifactDir, { recursive: true, force: true })
      for (const path of createdLeasePaths) rmSync(path, { recursive: true, force: true })
    }
  })

  it("immutable audit validation and two-key matching preserve the original bytes", async () => {
    const proof = await verifyRetainedEntry({
      ...base,
      clock: eligible(),
      namespaceRoots: [fixtureRoot as string],
      allowTemporaryArtifactDir: true,
    })
    expect(proof.verdict).toBe("candidate")
    if (proof.estate === undefined) throw new Error("fixture has no complete estate")
    const originalPath = join(base.entry, "manifest.json")
    const original = readFileSync(originalPath)
    const common = join(fixtureRoot as string, "product", ".git")
    const record = fixtureAuditRecord(proof, original)
    const writeRecord = writeAuditRecordFixture
    const first = writeRecord(record)
    const second = writeRecord({
      ...record,
      runId: randomUUID(),
      provenance: { ...record.provenance, common: { path: common, head: "1".repeat(40) } },
    })
    const records = readRetentionAudits(base.entry, originalPath, GATE_ORDER)
    const matched = matchRetentionAudit(records, original, proof.estate)
    expect(matched.selected?.binding.path).toBe([first, second].sort()[0])
    expect(matched.stale).toEqual([])
    expect(matchRetentionAudit(records, Buffer.from("changed original"), proof.estate).selected).toBeUndefined()
    const changedEstate = matchRetentionAudit(records, original, {
      ...proof.estate,
      detail: "different bounded outcome",
    })
    expect(changedEstate.selected).toBeUndefined()
    expect(changedEstate.stale).toHaveLength(2)
    const legacy = JSON.parse(original.toString("utf8")) as Record<string, unknown>
    for (const field of ["repositories", "writerLocks", "createdWriterLocks", "notCompared"]) delete legacy[field]
    const checkLegacy = async (): Promise<Awaited<ReturnType<typeof verifyRetainedEntry>>> => {
      const bytes = Buffer.from(`${JSON.stringify(legacy, null, 2)}\n`)
      writeFileSync(originalPath, bytes)
      writeRecord({
        ...record,
        original: {
          path: originalPath,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          byteLength: bytes.length,
        },
      })
      const checked = await verifyRetainedEntry({
        ...base,
        clock: eligible(),
        namespaceRoots: [fixtureRoot as string],
        allowTemporaryArtifactDir: true,
      })
      expect(readFileSync(originalPath)).toEqual(bytes)
      return checked
    }
    const checkedLegacy = await checkLegacy()
    expect(checkedLegacy.verdict, checkedLegacy.reasons.join("; ")).toBe("candidate")
    expect(checkedLegacy.gates.map((gate) => gate.status)).toEqual(["pass", "pass", "pass", "pass", "pass", "pass"])
    delete legacy["head"]
    const missingHistory = await checkLegacy()
    expect(missingHistory.verdict).toBe("unknown")
    expect(missingHistory.gates[0]?.status).toBe("unknown")
    writeFileSync(originalPath, original)
    const missingTool = writeRecord({
      ...record,
      provenance: { ...record.provenance, tool: { name: "git-super" } },
    })
    expect(() => readRetentionAudits(base.entry, originalPath, GATE_ORDER)).toThrowError("required tool version")
    rmSync(missingTool)
    const invalid = writeRecord({
      ...record,
      checks: record.checks.map((check, index) => (index === 0 ? { ...check, outcome: ["pass"] } : check)),
    })
    expect(() => readRetentionAudits(base.entry, originalPath, GATE_ORDER)).toThrowError("check outcome")
    rmSync(invalid)
    writeFileSync(first, "tampered")
    expect(() => readRetentionAudits(base.entry, originalPath, GATE_ORDER)).toThrowError("byte digest")
    expect(readFileSync(originalPath)).toEqual(original)
  })

  it("native legacy audit records provenance and retires through its generated immutable evidence", async () => {
    const artifactDir = mkdtempSync(join("/var/tmp", "git-super-legacy-audit-"))
    const createdLeasePaths: string[] = []
    try {
      await prepareRetirementFixture(artifactDir, createdLeasePaths)
      const manifestPath = join(base.entry, "manifest.json")
      const legacy = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
      // These are strict modern parser metadata, not inputs to the six safety evaluators.
      for (const field of ["repositories", "writerLocks", "createdWriterLocks", "notCompared"]) delete legacy[field]
      writeFileSync(manifestPath, `${JSON.stringify(legacy, null, 2)}\n`)
      const original = readFileSync(manifestPath)
      const common = join(fixtureRoot as string, "product", ".git")
      const expectedHead = git(common, ["rev-parse", "HEAD"])
      const expectedTool = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
        version: string
      }
      const args = retirementArgs(artifactDir).map((argument) => (argument === "retire" ? "audit" : argument))
      for (let run = 0; run < 2; run += 1) {
        const stdout = outputSink()
        const stderr = outputSink()
        expect(await runCli(args, stdout, stderr), stderr.output || stdout.output).toBe(0)
        expect(readFileSync(manifestPath)).toEqual(original)
        const records = readdirSync(base.entry).filter((name) => /^retention-audit-[a-f0-9]{64}\.json$/.test(name))
        expect(records).toHaveLength(run + 1)
        for (const name of records) {
          const bytes = readFileSync(join(base.entry, name))
          expect(name).toBe(`retention-audit-${createHash("sha256").update(bytes).digest("hex")}.json`)
          const record = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>
          expect(record["original"]).toEqual({
            path: manifestPath,
            sha256: createHash("sha256").update(original).digest("hex"),
            byteLength: original.length,
          })
          expect(record["schema"]).toBe("git-super/retention-audit/1")
        }
        const estate = scanEstate([fixtureRoot as string], [base.entry])
        const nativeRecords = readRetentionAudits(base.entry, manifestPath, GATE_ORDER)
        for (const { record } of nativeRecords) {
          expect(record.provenance).toMatchObject({
            tool: { name: "git-super", version: expectedTool.version },
            common: { path: common, head: expectedHead },
            estate: {
              namespaceRoots: [fixtureRoot as string],
              scanDigest: retentionEstateDigest(estate),
              counts: {
                objectDirs: estate.objectDirs.length,
                alternatesFiles: estate.alternatesFiles,
                borrowers: estate.borrowers.length,
                registries: estate.registries.length,
                survivorIntoRemoval: estate.survivorIntoRemoval.length,
              },
            },
          })
          expect(Number.isFinite(Date.parse(record.provenance.observedAt))).toBe(true)
          expect(record.checks.map(({ outcome }) => outcome)).toEqual(GATE_ORDER.map(() => "pass"))
        }
      }
      // The producer's record must be usable by the real actuator, without a fixture-written receipt.
      const records = readRetentionAudits(base.entry, manifestPath, GATE_ORDER)
      const selected = matchRetentionAudit(
        records,
        original,
        scanEstate([fixtureRoot as string], [base.entry]),
      ).selected
      if (selected === undefined) throw new Error("native audit did not produce matching evidence")
      const auditBytes = readFileSync(selected.binding.path)
      const stdout = outputSink()
      const stderr = outputSink()
      expect(await runCli(retirementArgs(artifactDir), stdout, stderr), stderr.output || stdout.output).toBe(0)
      expect(existsSync(base.entry)).toBe(false)
      const certificate = JSON.parse(
        readFileSync(join(artifactDir, "held", "retirement-certificate.json"), "utf8"),
      ) as { audit: { path: string; sha256: string } }
      expect(isAbsolute(certificate.audit.path)).toBe(false)
      expect(certificate.audit.sha256).toBe(selected.binding.sha256)
      expect(readFileSync(join(artifactDir, "held", "metadata", certificate.audit.path))).toEqual(auditBytes)
      expect(readFileSync(join(artifactDir, "held", "metadata", "retention-evidence", "manifest.json"))).toEqual(
        original,
      )
    } finally {
      rmSync(artifactDir, { recursive: true, force: true })
      for (const path of createdLeasePaths) rmSync(path, { recursive: true, force: true })
    }
  })

  // Root-only containment misses aliases below an otherwise external artifact directory.
  it.each(["metadata-directory", "metadata-file", "sidecars", "certificate", "original-evidence", "audit-evidence"])(
    "preserves custody before writing through a %s artifact alias",
    async (kind) => {
      const artifactDir = mkdtempSync(join("/var/tmp", "git-super-descendant-artifact-"))
      try {
        let alias = join(artifactDir, kind === "sidecars" ? "sidecars" : "metadata")
        let target = base.entry
        if (kind === "original-evidence" || kind === "audit-evidence") {
          const modern = await verifyRetainedEntry({
            ...base,
            clock: eligible(),
            namespaceRoots: [fixtureRoot as string],
            artifactDir: join(artifactDir, "control"),
          })
          expect(modern.verdict).toBe("candidate")
          const manifestPath = join(base.entry, "manifest.json")
          const legacy = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
          for (const field of ["repositories", "writerLocks", "createdWriterLocks", "notCompared"]) delete legacy[field]
          const original = Buffer.from(`${JSON.stringify(legacy, null, 2)}\n`)
          writeFileSync(manifestPath, original)
          const audit = writeAuditRecordFixture(fixtureAuditRecord(modern, original))
          target = manifestPath
          alias = join(
            artifactDir,
            "metadata",
            "retention-evidence",
            kind === "original-evidence" ? "manifest.json" : basename(audit),
          )
        }
        if (kind === "metadata-file") {
          const copy = join(base.entry, "modules")
          const key = (readdirSync(copy, { recursive: true }) as string[]).find(
            (path) => path.endsWith("/config") && !path.split("/").includes("objects"),
          )
          if (key === undefined) throw new Error("native retained fixture has no non-object config")
          alias = join(artifactDir, "metadata", relative(copy, join(copy, key)))
          target = join(base.entry, "manifest.json")
        } else if (kind === "certificate") {
          alias = join(artifactDir, "retirement-certificate.json")
          target = join(base.entry, "manifest.json")
        }
        mkdirSync(dirname(alias), { recursive: true })
        symlinkSync(target, alias)
        const before = digestDirectory(base.entry)
        const proof = await verifyRetainedEntry({
          entry: base.entry,
          root: base.root,
          artifactDir,
          namespaceRoots: [fixtureRoot as string],
          clock: eligible(),
        })
        expect(digestDirectory(base.entry)).toBe(before)
        expect(proof.gates.find((gate) => gate.gate === "copy-manifest")).toMatchObject({ status: "blocked" })
        expect(proof.verdict).toBe("blocked")
      } finally {
        rmSync(artifactDir, { recursive: true, force: true })
      }
    },
  )

  it("publishes the computed certificate name without following its existing symlink", () => {
    const artifactDir = mkdtempSync(join("/var/tmp", "git-super-certificate-publication-"))
    try {
      const certificate = { entry: base.entry, verdict: "candidate" }
      const bytes = `${JSON.stringify(certificate, null, 2)}\n`
      const digest = createHash("sha256").update(bytes).digest("hex")
      const path = join(artifactDir, `retirement-certificate-${digest.slice(0, 16)}.json`)
      const target = join(base.entry, "manifest.json")
      const before = readFileSync(target)
      symlinkSync(target, path)
      expect(emitCertificate(certificate, artifactDir).status).toBe("pass")
      expect(readFileSync(target)).toEqual(before)
      expect(readFileSync(path, "utf8")).toBe(bytes)
      expect(emitCertificate(certificate, artifactDir).status).toBe("pass")
    } finally {
      rmSync(artifactDir, { recursive: true, force: true })
    }
  })

  it.each(["missing", "inaccessible", "loop"])("preserves the typed %s prospective-ancestor failure", (failure) => {
    const root = mkdtempSync(join("/var/tmp", "git-super-prospective-path-"))
    const parent = join(root, "ancestor")
    mkdirSync(parent)
    let requested = join(parent, "future")
    try {
      if (failure === "inaccessible") {
        expect(process.getuid?.(), "native permission fault requires an unprivileged actor").not.toBe(0)
        chmodSync(parent, 0o000)
      } else {
        requested = join(root, "alias")
        symlinkSync(failure === "loop" ? requested : join(root, "missing-target"), requested)
      }
      expect(() => canonicalProspectivePath(requested)).toThrowError(
        expect.objectContaining({
          code: failure === "missing" ? "ENOENT" : failure === "inaccessible" ? "EACCES" : "ELOOP",
        }),
      )
    } finally {
      chmodSync(parent, 0o700)
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("writes an external alias's proof at its canonical durable directory", async () => {
    const root = mkdtempSync(join("/var/tmp", "git-super-external-artifact-"))
    const target = join(root, "canonical")
    mkdirSync(target)
    const alias = join(root, "alias")
    symlinkSync(target, alias)
    try {
      const result = await verifyRetainedEntry({
        entry: base.entry,
        root: base.root,
        namespaceRoots: [fixtureRoot as string],
        artifactDir: join(alias, "future", "pass"),
        clock: eligible(),
      })
      expect(result.verdict).toBe("candidate")
      expect(result.artifactDir).toBe(join(target, "future", "pass"))
      expect(result.certificate?.path.startsWith(`${target}/future/pass/`)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each(["held", "manifest", "census", "pointer-cleanup", "audit-bytes", "audit-identity"])(
    "reports the real %s boundary event",
    async (event) => {
      const artifactDir = mkdtempSync(join("/var/tmp", "git-super-retire-boundary-"))
      const createdLeasePaths: string[] = []
      let child: ReturnType<typeof Bun.spawn> | undefined
      let blocker: ReturnType<typeof tryAcquireFlock> = null
      const census = join(fixtureRoot as string, "boundary-survivor")
      const registry = join(fixtureRoot as string, "dependency", ".git", "git-super-retained-borrowers")
      const pointer = join(registry, "pointer.json")
      let auditPath: string | undefined
      try {
        await prepareRetirementFixture(artifactDir, createdLeasePaths)
        if (event === "audit-bytes" || event === "audit-identity") {
          const manifestPath = join(base.entry, "manifest.json")
          const legacy = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
          for (const field of ["repositories", "writerLocks", "createdWriterLocks", "notCompared"]) delete legacy[field]
          writeFileSync(manifestPath, `${JSON.stringify(legacy, null, 2)}\n`)
          const result = await auditRetainedEntry({
            ...base,
            artifactDir: join(artifactDir, "audit"),
            common: join(fixtureRoot as string, "product", ".git"),
            namespaceRoots: [fixtureRoot as string],
          })
          expect(result.detail?.code).toBe("audit-pass")
          auditPath = readRetentionAudits(base.entry, manifestPath, GATE_ORDER)[0]?.binding.path
          if (auditPath === undefined) throw new Error("native audit fixture produced no record")
        }
        if (event === "pointer-cleanup") {
          expect(process.getuid?.(), "native permission fault requires an unprivileged actor").not.toBe(0)
          expect(existsSync(registry)).toBe(false)
          mkdirSync(registry)
          writeFileSync(
            pointer,
            `${JSON.stringify({ retained: join(base.entry, "modules"), manifest: join(base.entry, "manifest.json") })}\n`,
          )
        }
        const common = join(fixtureRoot as string, "product", ".git", "yrd-worktree-mutations", "writer.lock")
        const lockPath =
          event === "held"
            ? join(fixtureRoot as string, "dependency", ".git", "yrd-worktree-mutations", "writer.lock")
            : common
        blocker = tryAcquireFlock(lockPath, { create: false, noFollow: true })
        expect(blocker?.held).toBe(true)
        const running = Bun.spawn(
          [
            process.execPath,
            join(import.meta.dirname, "../bin/git-super"),
            ...retirementArgs(join(artifactDir, "operation")),
          ],
          { cwd: process.cwd(), env: environment, stdout: "pipe", stderr: "pipe" },
        )
        child = running
        const stdout = new Response(running.stdout).text()
        const stderr = new Response(running.stderr).text()
        await vi.waitFor(
          () => expect(existsSync(join(artifactDir, "operation", "pre", "retirement-certificate.json"))).toBe(true),
          { timeout: 30_000, interval: 20 },
        )
        const manifestPath = join(base.entry, "manifest.json")
        if (event === "manifest") {
          const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
          manifest["retainUntil"] = new Date(Date.now() - 500).toISOString()
          writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
        } else if (event === "census") {
          mkdirSync(census)
          git(census, ["init", "-q", "-b", "main"])
          writeFileSync(join(census, "survivor"), "independent survivor\n")
          git(census, ["add", "survivor"])
          git(census, ["commit", "-q", "-m", "independent survivor"])
        } else if (event === "pointer-cleanup") {
          chmodSync(registry, 0o555)
        } else if (auditPath !== undefined) {
          const bytes = readFileSync(auditPath)
          if (event === "audit-bytes") writeFileSync(auditPath, Buffer.concat([bytes, Buffer.from("\n")]))
          else {
            const previous = lstatSync(auditPath)
            const replacement = join(artifactDir, "replacement-audit.json")
            writeFileSync(replacement, bytes)
            renameSync(replacement, auditPath)
            expect(lstatSync(auditPath).ino).not.toBe(previous.ino)
          }
        }
        const preserved = readFileSync(manifestPath)
        if (event !== "held") blocker?.release()
        const code = await child.exited
        const body = await stdout
        expect(code, `${await stderr}\n${body}`).toBe(event === "pointer-cleanup" ? 2 : 1)
        const result = JSON.parse(body) as GitSuperResult
        if (event === "pointer-cleanup") {
          expect(result).toMatchObject({ state: "failed", partial: true, detail: { code: "retirement-partial" } })
          expect(() => lstatSync(base.entry)).toThrowError(expect.objectContaining({ code: "ENOENT" }))
          expect(existsSync(pointer)).toBe(true)
          expect(result.repositories).toContainEqual(
            expect.objectContaining({ repository: base.entry, state: "updated" }),
          )
          expect(result.repositories).toContainEqual(expect.objectContaining({ repository: pointer, state: "failed" }))
        } else {
          expect(result).toMatchObject({
            state: "unchanged",
            partial: false,
            detail: { code: event === "held" ? "lease-held" : "census-shifted" },
          })
          expect(existsSync(base.entry)).toBe(true)
          expect(readFileSync(manifestPath)).toEqual(preserved)
        }
        if (event === "manifest" || event === "census") {
          const readCertificate = (
            pass: string,
          ): { verdict: string; manifestSha256: string; estate: { objectDirs: string[] } } =>
            JSON.parse(readFileSync(join(artifactDir, "operation", pass, "retirement-certificate.json"), "utf8")) as {
              verdict: string
              manifestSha256: string
              estate: { objectDirs: string[] }
            }
          const pre = readCertificate("pre")
          const held = readCertificate("held")
          expect(held.verdict).toBe("candidate")
          if (event === "manifest") expect(held.manifestSha256).not.toBe(pre.manifestSha256)
          else {
            expect(pre.estate.objectDirs).not.toContain(join(census, ".git", "objects"))
            expect(held.estate.objectDirs).toContain(join(census, ".git", "objects"))
          }
        }
      } finally {
        blocker?.release()
        if (child !== undefined && child.exitCode === null) {
          child.kill()
          await child.exited
        }
        if (event === "pointer-cleanup" && existsSync(registry)) {
          chmodSync(registry, 0o700)
          rmSync(registry, { recursive: true, force: false })
        }
        for (const path of createdLeasePaths.reverse()) rmSync(path, { recursive: true, force: false })
        rmSync(census, { recursive: true, force: true })
        rmSync(artifactDir, { recursive: true, force: true })
      }
    },
    60_000,
  )

  it.each(["unexpired", "legacy-unrecorded", "incomplete", "lease-missing"])(
    "keeps a %s entry through the native retire CLI without changing its manifest",
    async (reason) => {
      const artifactDir = mkdtempSync(join("/var/tmp", "git-super-retire-keep-"))
      try {
        const path = join(base.entry, "manifest.json")
        const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
        if (reason !== "unexpired") manifest["retainUntil"] = new Date(Date.now() - 1000).toISOString()
        if (reason === "legacy-unrecorded") delete manifest["entries"]
        writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
        if (reason === "incomplete") writeFileSync(firstFile(join(base.entry, "modules")), "changed fixture bytes")
        const before = readFileSync(path)
        const output = outputSink()
        const diagnostic = outputSink()
        const code = await runCli(
          [
            "--repo",
            join(fixtureRoot as string, "product"),
            "--json",
            "worktree",
            "retention",
            "retire",
            base.entry,
            "--root",
            base.root,
            "--common",
            join(fixtureRoot as string, "product", ".git"),
            "--namespace",
            fixtureRoot as string,
            "--artifact-dir",
            artifactDir,
          ],
          output,
          diagnostic,
        )
        expect(code, `${diagnostic.output}\n${output.output}`).toBe(1)
        expect(JSON.parse(output.output)).toMatchObject({
          state: "unchanged",
          partial: false,
          detail: { code: reason },
        })
        expect(existsSync(base.entry)).toBe(true)
        expect(readFileSync(path)).toEqual(before)
      } finally {
        rmSync(artifactDir, { recursive: true, force: true })
      }
    },
  )

  /**
   * @failure A verified native-writer entry has no governed retirement actuator.
   * @level l2
   * @consumer worktree retention retire (#31146)
   * A standalone candidate certificate remains insufficient to remove it.
   */
  it("retires an eligible native-writer entry through the explicit CLI and retains external proof", async () => {
    const artifactDir = mkdtempSync(join("/var/tmp", "git-super-retire-proof-"))
    const createdLeasePaths: string[] = []
    try {
      const manifestPath = join(base.entry, "manifest.json")
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
      // The CLI uses the real clock; only this isolated fixture's floor moves.
      manifest["retainUntil"] = new Date(Date.now() - 1000).toISOString()
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
      const pre = await verifyRetainedEntry({
        entry: base.entry,
        root: base.root,
        namespaceRoots: [fixtureRoot as string],
        artifactDir: join(artifactDir, "control"),
      })
      expect(pre.verdict).toBe("candidate")
      if (pre.estate === undefined) throw new Error("candidate fixture has no estate census")
      // Only this isolated fixture's external owners are provisioned. Certified E
      // stays untouched; a missing in-copy lease must still keep the entry.
      for (const objects of pre.estate.objectDirs) {
        if (!objects.startsWith(`${fixtureRoot}/`)) throw new Error(`fixture escaped its namespace: ${objects}`)
        if (objects.startsWith(`${base.entry}/`)) continue
        const parent = join(dirname(objects), "yrd-worktree-mutations")
        const path = join(parent, "writer.lock")
        if (existsSync(path)) continue
        createdLeasePaths.push(existsSync(parent) ? path : parent)
        using lease = tryAcquireFlock(path)
        expect(lease?.held).toBe(true)
      }
      const output = outputSink()
      const diagnostic = outputSink()
      const code = await runCli(
        [
          "--repo",
          join(fixtureRoot as string, "product"),
          "--json",
          "worktree",
          "retention",
          "retire",
          base.entry,
          "--root",
          base.root,
          "--common",
          join(fixtureRoot as string, "product", ".git"),
          "--namespace",
          fixtureRoot as string,
          "--artifact-dir",
          join(artifactDir, "retire"),
        ],
        output,
        diagnostic,
      )
      expect(code, `${diagnostic.output}\n${output.output}`).toBe(0)
      const result = JSON.parse(output.output) as {
        state: string
        partial: boolean
        detail: { evidence: string }
      }
      expect(result).toMatchObject({ state: "updated", partial: false })
      expect(() => lstatSync(base.entry)).toThrowError(expect.objectContaining({ code: "ENOENT" }))
      expect(existsSync(result.detail.evidence)).toBe(true)
    } finally {
      for (const path of createdLeasePaths.reverse()) rmSync(path, { recursive: true, force: false })
      rmSync(artifactDir, { recursive: true, force: true })
    }
  })

  it("reaches candidate only through gate 6 and never claims removal authority", async () => {
    const result = await verifyRetainedEntry({
      entry: base.entry,
      root: base.root,
      namespaceRoots: [fixtureRoot as string],
      artifactDir: base.artifactDir,
      allowTemporaryArtifactDir: true,
      clock: eligible(),
    })
    expect(result.verdict).toBe("candidate")
    expect(result.gates.map((gate) => gate.status)).toEqual(["pass", "pass", "pass", "pass", "pass", "pass"])
    expect(result.head).toMatch(/^[0-9a-f]{40}$/u)
    expect(result.manifestSha256).toMatch(/^[0-9a-f]{64}$/u)
    // The rendered, content-addressed certificate exists outside E.
    expect(result.certificate?.digest).toMatch(/^[0-9a-f]{64}$/u)
    expect(JSON.parse(readFileSync(result.certificate?.path as string, "utf8"))).toMatchObject({ verdict: "candidate" })
    expect(retentionRemovalBoundary(result).authorized).toBe(false)
    expect(retentionRemovalBoundary(result).reason).toContain("preliminary")
  })

  it("reports gate 2 unknown when no external pass directory was supplied", async () => {
    const result = await verifyRetainedEntry({ entry: base.entry, root: base.root, clock: eligible() })
    expect(result.verdict).toBe("unknown")
    expect(result.gates[1]).toMatchObject({ gate: "copy-manifest", status: "unknown" })
    expect(retentionRemovalBoundary(result).authorized).toBe(false)
  })

  it.each(["direct", "symlink"])(
    "refuses a %s pass directory inside the retention custody before writing",
    async (kind) => {
      const aliasRoot = mkdtempSync(join("/var/tmp", "git-super-artifact-alias-"))
      const alias = join(aliasRoot, "artifact-alias")
      if (kind === "symlink") symlinkSync(base.entry, alias)
      const inside = kind === "direct" ? join(base.root, "inside") : join(base.entry, "inside")
      const artifactDir = kind === "direct" ? inside : join(alias, "inside")
      try {
        const result = await verifyRetainedEntry({ entry: base.entry, root: base.root, artifactDir, clock: eligible() })
        expect(() => lstatSync(inside)).toThrowError(expect.objectContaining({ code: "ENOENT" }))
        expect(result.verdict).toBe("blocked")
        expect(result.gates[1]).toMatchObject({ gate: "copy-manifest", status: "blocked" })
        expect(result.gates[1]?.message).toContain("inside the retention custody")
      } finally {
        rmSync(aliasRoot, { recursive: true, force: true })
      }
    },
  )

  it("refuses eligibility at the retention floor (now == retainUntil)", async () => {
    const result = await verifyRetainedEntry({
      entry: base.entry,
      root: base.root,
      artifactDir: base.artifactDir,
      clock: new Date(Date.parse(base.retainUntil)),
    })
    expect(result.verdict).toBe("blocked")
    expect(result.gates[0]).toMatchObject({ gate: "identity-eligibility", status: "blocked" })
  })

  it("refuses a changed byte inside the copied store", async () => {
    const target = firstFile(join(base.entry, "modules"))
    writeFileSync(target, `${readFileSync(target, "utf8")}changed`)
    const result = await verifyRetainedEntry({
      entry: base.entry,
      root: base.root,
      artifactDir: base.artifactDir,
      clock: eligible(),
    })
    expect(result.verdict).toBe("blocked")
    expect(result.gates[1]).toMatchObject({ gate: "copy-manifest", status: "blocked" })
  })

  it("refuses an extra wrapper file beside the manifest", async () => {
    writeFileSync(join(base.entry, "notes.txt"), "unrecorded\n")
    const result = await verifyRetainedEntry({
      entry: base.entry,
      root: base.root,
      artifactDir: base.artifactDir,
      clock: eligible(),
    })
    expect(result.verdict).toBe("blocked")
    expect(result.gates[1]).toMatchObject({ gate: "copy-manifest", status: "blocked" })
  })

  it("refuses an entry that is not a direct child of the declared root", async () => {
    const nested = join(base.entry, "nested")
    mkdirSync(nested, { recursive: true })
    const result = await verifyRetainedEntry({
      entry: nested,
      root: base.root,
      artifactDir: base.artifactDir,
      clock: eligible(),
    })
    expect(result.verdict).toBe("blocked")
    expect(result.gates[0]).toMatchObject({ gate: "identity-eligibility", status: "blocked" })
    expect(JSON.stringify(result.gates[0])).toContain("direct child")
  })

  it("refuses an entry with no manifest", async () => {
    rmSync(join(base.entry, "manifest.json"))
    const result = await verifyRetainedEntry({
      entry: base.entry,
      root: base.root,
      artifactDir: base.artifactDir,
      clock: eligible(),
    })
    expect(result.verdict).toBe("blocked")
    expect(result.gates[0]).toMatchObject({ gate: "identity-eligibility", status: "blocked" })
  })

  it("reports a legacy manifest as unknown rather than a violated condition", async () => {
    const manifestPath = join(base.entry, "manifest.json")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
    delete manifest["writerLocks"]
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    const result = await verifyRetainedEntry({
      entry: base.entry,
      root: base.root,
      artifactDir: base.artifactDir,
      clock: eligible(),
    })
    expect(result.verdict).toBe("unknown")
    expect(result.gates[0]).toMatchObject({ gate: "identity-eligibility", status: "unknown" })
  })

  it("refuses a present but malformed proof field", async () => {
    const manifestPath = join(base.entry, "manifest.json")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
    manifest["writerLocks"] = "not-an-array"
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    const result = await verifyRetainedEntry({
      entry: base.entry,
      root: base.root,
      artifactDir: base.artifactDir,
      clock: eligible(),
    })
    expect(result.verdict).toBe("blocked")
    expect(result.gates[0]).toMatchObject({ gate: "identity-eligibility", status: "blocked" })
  })

  it("reports the estate and custody gates unknown without a declared namespace", async () => {
    const result = await verifyRetainedEntry({
      entry: base.entry,
      root: base.root,
      artifactDir: base.artifactDir,
      allowTemporaryArtifactDir: true,
      clock: eligible(),
    })
    expect(result.verdict).toBe("unknown")
    expect(result.gates[2]).toMatchObject({ gate: "estate-inventory", status: "unknown" })
    expect(result.gates[3]).toMatchObject({ gate: "candidate-contents", status: "unknown" })
  })

  it("exposes the verdict through the CLI, refusing before the retention floor", async () => {
    const stdout = outputSink()
    const code = await runCli(
      [
        "--repo",
        base.root,
        "--json",
        "worktree",
        "retention",
        "verify",
        base.entry,
        "--root",
        base.root,
        "--artifact-dir",
        base.artifactDir,
      ],
      stdout,
      outputSink(),
    )
    expect(code).toBe(1)
    const result = JSON.parse(stdout.output) as { verdict: string; gates: Array<{ gate: string; status: string }> }
    expect(result.verdict).toBe("blocked")
    expect(result.gates[0]).toMatchObject({ gate: "identity-eligibility", status: "blocked" })
  })

  it("keeps the public CLI from certifying a temporary artifact directory", async () => {
    // The CLI reads the real clock, so bring the recorded retention floor into the past first;
    // only `retainUntil` changes, and gate 2 compares the copied subtree, not these bytes.
    const manifestPath = join(base.entry, "manifest.json")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
    manifest["retainUntil"] = new Date(Date.now() - 1000).toISOString()
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    const stdout = outputSink()
    const code = await runCli(
      [
        "--repo",
        base.root,
        "--json",
        "worktree",
        "retention",
        "verify",
        base.entry,
        "--root",
        base.root,
        "--namespace",
        fixtureRoot as string,
        "--artifact-dir",
        base.artifactDir,
      ],
      stdout,
      outputSink(),
    )
    // The fixture's pass directory is under the OS temporary directory, so gate 6 can never see
    // durable evidence: the public CLI reports unknown and never a candidate (exit 2).
    expect(code).toBe(2)
    const result = JSON.parse(stdout.output) as {
      verdict: string
      gates: Array<{ gate: string; status: string; message?: string }>
    }
    expect(result.verdict).toBe("unknown")
    expect(result.gates[1]).toMatchObject({ gate: "copy-manifest", status: "unknown" })
    expect(result.gates[1]?.message).toContain("temporary")
  })

  it("non-object metadata over the per-entry bound is unknown with the observed bytes and the cap", async () => {
    const result = await verifyRetainedEntry({
      entry: base.entry,
      root: base.root,
      namespaceRoots: [fixtureRoot as string],
      artifactDir: base.artifactDir,
      allowTemporaryArtifactDir: true,
      clock: eligible(),
      bounds: { metadata: { maxBytes: 1 } },
    })
    expect(result.verdict).toBe("unknown")
    expect(result.gates[1]).toMatchObject({ gate: "copy-manifest", status: "unknown" })
    expect(result.gates[1]?.message).toMatch(/non-object metadata/)
    expect(result.gates[1]?.message).toContain("bound")
  })

  it("defaults the per-entry non-object metadata bound to the contract's 256 MiB", () => {
    expect(DEFAULT_NON_OBJECT_METADATA_BOUNDS.maxBytes).toBe(256 * 1024 * 1024)
  })

  it("does not expose a public temporary-artifact bypass flag", async () => {
    const stdout = outputSink()
    const code = await runCli(
      [
        "--repo",
        base.root,
        "--json",
        "worktree",
        "retention",
        "verify",
        base.entry,
        "--root",
        base.root,
        "--artifact-dir",
        base.artifactDir,
        "--allow-temporary-artifact",
      ],
      stdout,
      outputSink(),
    )
    expect(code).not.toBe(0)
    expect(stdout.output).toBe("")
  })

  it("requires the declared root instead of inferring it", async () => {
    const stdout = outputSink()
    const code = await runCli(["worktree", "retention", "verify", base.entry], stdout, outputSink())
    expect(code).not.toBe(0)
    expect(stdout.output).toBe("")
  })
})

describe("retention verify fix-forward #27443(b) gaps", () => {
  it("follows alternate targets transitively and blocks a survivor that borrows into the removal set", async () => {
    const scene = mkdtempSync(join(tmpdir(), "estate-transitive-"))
    const roots = join(scene, "S")
    const target = join(scene, "T")
    const removal = join(scene, "E")
    mkdirSync(join(roots, "objects", "info"), { recursive: true })
    mkdirSync(join(target, "objects", "info"), { recursive: true })
    mkdirSync(join(removal, "kept", "objects", "info"), { recursive: true })
    writeFileSync(join(roots, "objects", "info", "alternates"), `${join(target, "objects")}\n`)
    writeFileSync(join(target, "objects", "info", "alternates"), `${join(removal, "kept", "objects")}\n`)
    const result = scanEstate([roots], [removal])
    expect(result.status).toBe("blocked")
    expect(result.objectDirs).toContain(realpathSync(join(target, "objects")))
    expect(result.survivorIntoRemoval.some((edge) => edge.borrower === realpathSync(join(target, "objects")))).toBe(
      true,
    )
  })

  it("keeps a transitive alternate chain that never enters the removal set at pass", async () => {
    const scene = mkdtempSync(join(tmpdir(), "estate-transitive-pass-"))
    const roots = join(scene, "S")
    const target = join(scene, "T")
    mkdirSync(join(roots, "objects", "info"), { recursive: true })
    mkdirSync(join(target, "objects", "info"), { recursive: true })
    writeFileSync(join(roots, "objects", "info", "alternates"), `${join(target, "objects")}\n`)
    const result = scanEstate([roots], [join(scene, "E")])
    expect(result.status).toBe("pass")
  })

  it("reports a malformed borrower registry record unknown", async () => {
    const scene = mkdtempSync(join(tmpdir(), "estate-registry-"))
    const roots = join(scene, "R")
    mkdirSync(join(roots, "git-super-retained-borrowers"), { recursive: true })
    writeFileSync(join(roots, "git-super-retained-borrowers", "broken.json"), "{ not json")
    const result = scanEstate([roots], [join(scene, "E")])
    expect(result.status).toBe("unknown")
    expect(result.detail).toContain("not valid JSON")
  })

  it("reads a valid borrower registry record and reconciles it with the manifest it names", async () => {
    const scene = mkdtempSync(join(tmpdir(), "estate-registry-good-"))
    const roots = join(scene, "R")
    const entry = join(scene, "entry")
    mkdirSync(join(roots, "git-super-retained-borrowers"), { recursive: true })
    mkdirSync(entry, { recursive: true })
    const manifestPath = join(entry, "manifest.json")
    writeFileSync(manifestPath, `${JSON.stringify({ retainUntil: "2020-01-01T00:00:00Z" })}\n`)
    writeFileSync(
      join(roots, "git-super-retained-borrowers", "good.json"),
      `${JSON.stringify({ retained: entry, manifest: manifestPath })}\n`,
    )
    const result = scanEstate([roots], [join(scene, "E")])
    expect(result.status).toBe("pass")
    expect(result.registries).toHaveLength(1)
  })

  it("records the at-risk OID's own type in the sidecar and names the ref whose closure carries it", async () => {
    const scene = mkdtempSync(join(tmpdir(), "custody-type-"))
    const repo = join(scene, "witness")
    const sidecarDir = join(scene, "sidecars")
    mkdirSync(repo, { recursive: true })
    git(repo, ["init", "-q", "-b", "main"])
    writeFileSync(join(repo, "f.txt"), "hello\n")
    git(repo, ["add", "f.txt"])
    git(repo, ["commit", "-q", "-m", "c"])
    const blob = git(repo, ["rev-parse", "HEAD:f.txt"])
    const commit = git(repo, ["rev-parse", "HEAD"])
    const component = await atRiskComponent(sidecarDir, [{ oid: blob, type: "blob", source: "owned" }])
    const result = await scanCustody(repo, [component], [join(repo, ".git", "objects")], [], { sidecarDir })
    expect(result.status).toBe("pass")
    expect(result.witnesses[0]).toMatchObject({ ref: "refs/heads/main", tip: commit })
    expect(await sidecarRows(component.atRiskSidecar.path)).toEqual([`${blob}\tblob\towned`])
  })

  it("refuses a transient operation ref as a durable witness", async () => {
    const scene = mkdtempSync(join(tmpdir(), "custody-transient-"))
    const repo = join(scene, "witness")
    const sidecarDir = join(scene, "sidecars")
    mkdirSync(repo, { recursive: true })
    git(repo, ["init", "-q", "-b", "main"])
    writeFileSync(join(repo, "f.txt"), "hello\n")
    git(repo, ["add", "f.txt"])
    git(repo, ["commit", "-q", "-m", "c"])
    const blob = git(repo, ["rev-parse", "HEAD:f.txt"])
    git(repo, ["update-ref", "refs/rewritten/temporary-review", blob])
    git(repo, ["update-ref", "-d", "refs/heads/main"])
    const component = await atRiskComponent(sidecarDir, [{ oid: blob, type: "blob", source: "owned" }])
    const result = await scanCustody(repo, [component], [join(repo, ".git", "objects")], [], { sidecarDir })
    expect(result.status).toBe("blocked")
  })

  it("subtracts an external objects-symlink target from the at-risk set", async () => {
    const scene = mkdtempSync(join(tmpdir(), "contents-link-"))
    const source = join(scene, "source")
    const component = join(scene, "comp")
    mkdirSync(source, { recursive: true })
    mkdirSync(component, { recursive: true })
    git(source, ["init", "-q", "-b", "main"])
    writeFileSync(join(source, "f.txt"), "hello\n")
    git(source, ["add", "f.txt"])
    git(source, ["commit", "-q", "-m", "c"])
    const commit = git(source, ["rev-parse", "HEAD"])
    git(component, ["init", "-q", "-b", "main"])
    rmSync(join(component, ".git", "objects"), { recursive: true, force: true })
    symlinkSync(join(source, ".git", "objects"), join(component, ".git", "objects"))
    git(component, ["update-ref", "refs/heads/main", commit])
    const entries = {
      ".git/objects/info/alternates": { kind: "file", sha256: "0".repeat(64) },
    } as Record<string, ManifestEntry>
    const result = await scanContents(component, entries, [], {
      sidecarDir: mkdtempSync(join(tmpdir(), "contents-link-sidecars-")),
    })
    expect(result.status).toBe("pass")
    expect(result.components[0]).toMatchObject({ component: ".git", atRisk: 0 })
    expect(result.components[0]!.independent).toBeGreaterThan(0)
  })

  it("refuses a temporary artifact directory as durable evidence", async () => {
    const result = await verifyRetainedEntry({
      entry: base.entry,
      root: base.root,
      namespaceRoots: [fixtureRoot as string],
      artifactDir: base.artifactDir,
      clock: eligible(),
    })
    expect(result.verdict).toBe("unknown")
    expect(result.gates[1]).toMatchObject({ gate: "copy-manifest", status: "unknown" })
    expect(result.gates[1]?.message).toContain("temporary")
  })

  it("still certifies durable evidence with no test seam", async () => {
    // Durable means outside the OS temporary directory. The refusal above and this candidate must
    // stay a pair: the correction for #27443(b) tightened the temporary path, never the durable one.
    // /var/tmp is the OS's persistent scratch, outside tmpdir() and writable on Linux and macOS
    // runners alike. The earlier dirname(tmpdir()) was `/` on Linux CI, where mkdtemp failed EACCES,
    // so the durable case was never exercised there.
    const durableRoot = mkdtempSync(join("/var/tmp", "git-super-retention-durable-"))
    try {
      const result = await verifyRetainedEntry({
        entry: base.entry,
        root: base.root,
        namespaceRoots: [fixtureRoot as string],
        artifactDir: join(durableRoot, "pass"),
        clock: eligible(),
      })
      expect(result.verdict).toBe("candidate")
      expect(result.gates[5]).toMatchObject({ gate: "certificate", status: "pass" })
    } finally {
      rmSync(durableRoot, { recursive: true, force: true })
    }
  })

  it("emits a byte-identical certificate and sidecars on a rerun of the same estate", async () => {
    const artifactDir = mkdtempSync(join(tmpdir(), "verify-rerun-"))
    const options = {
      entry: base.entry,
      root: base.root,
      namespaceRoots: [fixtureRoot as string],
      artifactDir,
      allowTemporaryArtifactDir: true,
      clock: eligible(),
      monotonic: () => 0,
    }
    const first = await verifyRetainedEntry(options)
    expect(first.verdict).toBe("candidate")
    const firstBytes = readFileSync(first.certificate?.path as string, "utf8")
    const sidecarsAfterFirst = readdirSync(join(artifactDir, "sidecars")).sort()
    expect(sidecarsAfterFirst.length).toBeGreaterThan(0)
    const second = await verifyRetainedEntry(options)
    expect(second.certificate?.digest).toBe(first.certificate?.digest)
    expect(readFileSync(second.certificate?.path as string, "utf8")).toBe(firstBytes)
    expect(readdirSync(join(artifactDir, "sidecars")).sort()).toEqual(sidecarsAfterFirst)
    // Content-addressed only: no temporary name (`.<prefix>-<pid>-<n>`) survives a pass.
    expect(sidecarsAfterFirst.every((name) => /^[0-9a-f]{64}\.txt$/u.test(name))).toBe(true)
  })

  it("reports unknown when a previously written sidecar was tampered with", async () => {
    const artifactDir = mkdtempSync(join(tmpdir(), "verify-tamper-"))
    const options = {
      entry: base.entry,
      root: base.root,
      namespaceRoots: [fixtureRoot as string],
      artifactDir,
      allowTemporaryArtifactDir: true,
      clock: eligible(),
      monotonic: () => 0,
    }
    const first = await verifyRetainedEntry(options)
    expect(first.verdict).toBe("candidate")
    // Corrupt every sidecar: whichever ones a rerun re-derives, it must refuse to trust a name.
    for (const name of readdirSync(join(artifactDir, "sidecars"))) {
      writeFileSync(join(artifactDir, "sidecars", name), "tampered\n")
    }
    const second = await verifyRetainedEntry(options)
    expect(second.verdict).toBe("unknown")
    expect(second.reasons.join(" ")).toContain("read-back mismatch")
  })

  it("reports an uncreatable pass directory unknown, never a crash", async () => {
    const scene = mkdtempSync(join(tmpdir(), "verify-unwritable-"))
    writeFileSync(join(scene, "blocker"), "x")
    const result = await verifyRetainedEntry({
      entry: base.entry,
      root: base.root,
      namespaceRoots: [fixtureRoot as string],
      artifactDir: join(scene, "blocker", "pass"),
      allowTemporaryArtifactDir: true,
      clock: eligible(),
    })
    expect(result.verdict).toBe("unknown")
    expect(result.gates[1]).toMatchObject({ gate: "copy-manifest", status: "unknown" })
  })
})

describe("native retirement alongside supported materialization", () => {
  it("keeps the materializer's actual object target at the durable primary while retirement runs", async () => {
    const artifactDir = mkdtempSync(join("/var/tmp", "git-super-retire-materializer-"))
    const createdLeasePaths: string[] = []
    let child: ReturnType<typeof Bun.spawn> | undefined
    let blocker: ReturnType<typeof tryAcquireFlock> = null
    try {
      await prepareRetirementFixture(artifactDir, createdLeasePaths)
      const product = join(fixtureRoot as string, "product")
      const checkout = join(fixtureRoot as string, "materialized-survivor")
      blocker = tryAcquireFlock(join(product, ".git", "yrd-worktree-mutations", "writer.lock"), { create: false })
      expect(blocker?.held).toBe(true)
      const running = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dirname, "../bin/git-super"),
          ...retirementArgs(join(artifactDir, "operation")),
        ],
        { cwd: process.cwd(), env: environment, stdout: "pipe", stderr: "pipe" },
      )
      child = running
      const stdout = new Response(running.stdout).text()
      const stderr = new Response(running.stderr).text()
      await vi.waitFor(
        () => expect(existsSync(join(artifactDir, "operation", "pre", "retirement-certificate.json"))).toBe(true),
        { timeout: 30_000, interval: 20 },
      )
      blocker?.release()
      const diagnostic = outputSink()
      expect(
        await runCli(["--repo", product, "worktree", "add", checkout, "HEAD"], outputSink(), diagnostic),
        diagnostic.output,
      ).toBe(0)
      const code = await running.exited
      const body = await stdout
      expect([0, 1], `${await stderr}\n${body}`).toContain(code)
      const result = JSON.parse(body) as GitSuperResult
      expect(result.partial).toBe(false)
      if (code === 1) expect(lstatSync(base.entry).isDirectory()).toBe(true)
      else expect(() => lstatSync(base.entry)).toThrowError(expect.objectContaining({ code: "ENOENT" }))
      const objects = realpathSync(
        git(join(checkout, "vendor/dep"), ["rev-parse", "--path-format=absolute", "--git-path", "objects"]),
      )
      expect(alternateEntries(readFileSync(join(objects, "info", "alternates"), "utf8"), objects)).toContain(
        realpathSync(join(product, ".git", "modules", "vendor", "dep", "objects")),
      )
      expect(objects.startsWith(`${base.entry}/`)).toBe(false)
      expect(scanEstate([fixtureRoot as string], [base.entry]).survivorIntoRemoval).toEqual([])
      git(join(checkout, "vendor/dep"), ["fsck", "--full"])
    } finally {
      blocker?.release()
      if (child !== undefined && child.exitCode === null) {
        child.kill()
        await child.exited
      }
      for (const path of createdLeasePaths.reverse()) rmSync(path, { recursive: true, force: false })
      rmSync(artifactDir, { recursive: true, force: true })
    }
  }, 90_000)
})
