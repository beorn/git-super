/**
 * Gate 6 of the #27443(b) retirement proof: the deterministic, content-addressed preliminary
 * certificate, emitted OUTSIDE the entry. `candidate` here means *preliminary proof only*: the
 * certificate is never a delete capability, and GitSuper writes nothing under `E`.
 */
import { createHash, randomUUID } from "node:crypto"
import { existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { publishArtifact, SidecarWriter } from "./retention-stream.ts"
import { canonicalEstateScan, type EstateScan } from "./retention-estate.ts"

export const RETENTION_CERTIFICATE_SCHEMA = "git-super/retention-certificate/2"
const COMMON_FACTS_SCHEMA = "git-super/retention-common-facts/1"

export interface CertificateEmission {
  readonly status: "pass" | "unknown"
  readonly detail: string
  readonly path?: string
  readonly digest?: string
  readonly commonArtifactDir?: string
  readonly warnings?: readonly string[]
}

/** The existing certificate projection, distinct from the complete observed EstateScan. */
export function certificateEstate(estate: EstateScan): object {
  return {
    roots: estate.roots,
    objectDirs: estate.objectDirs,
    alternatesFiles: estate.alternatesFiles,
    borrowers: estate.borrowers,
    registries: estate.registries,
    survivorIntoRemoval: estate.survivorIntoRemoval,
  }
}

function plain(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("certificate facts must be an object")
  }
  return value as Record<string, unknown>
}

function contained(root: string, path: string): boolean {
  const part = relative(root, path)
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part))
}

/** Reject redirected ancestors rather than granting their destination a new trusted namespace. */
function unredirected(path: string): string {
  const absolute = resolve(path)
  let current = absolute
  while (true) {
    const stat = lstatSync(current, { throwIfNoEntry: false })
    if (stat?.isSymbolicLink()) throw new Error(`shared certificate artifact is redirected: ${current}`)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return absolute
}

/** Hash-bound logical facts for the existing native proof comparison; no saved envelope grants authority. */
export function readCertificateFacts(
  value: unknown,
  commonArtifactDir: string,
  estate: EstateScan,
  coverage: object,
): Record<string, unknown> {
  const certificate = plain(value)
  if (
    certificate.schema !== RETENTION_CERTIFICATE_SCHEMA ||
    certificate.certificateSchema !== RETENTION_CERTIFICATE_SCHEMA
  ) {
    throw new Error("unsupported retention certificate version")
  }
  const ref = plain(certificate.commonFactsRef)
  if (
    typeof ref.path !== "string" ||
    !isAbsolute(ref.path) ||
    typeof ref.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(ref.sha256) ||
    !Number.isSafeInteger(ref.bytes) ||
    ref.count !== 1
  ) {
    throw new Error("invalid common facts reference")
  }
  const namespace = unredirected(commonArtifactDir)
  if (!contained(namespace, unredirected(ref.path)) || ref.path === namespace || !lstatSync(ref.path).isFile()) {
    throw new Error("common facts reference is outside its native regular-file namespace")
  }
  const bytes = readFileSync(ref.path)
  if (bytes.length !== ref.bytes || createHash("sha256").update(bytes).digest("hex") !== ref.sha256) {
    throw new Error("common facts bytes disagree with their reference")
  }
  if (bytes.at(-1) !== 10 || bytes.subarray(0, -1).includes(10)) {
    throw new Error("common facts must contain exactly one newline-terminated JSON record")
  }
  const facts = plain(JSON.parse(bytes.toString("utf8")))
  if (facts.schema !== COMMON_FACTS_SCHEMA || Object.keys(facts).sort().join(",") !== "coverage,estate,schema") {
    throw new Error("unsupported common facts version or shape")
  }
  if (canonicalEstateScan(plain(facts.estate)) !== canonicalEstateScan(certificateEstate(estate))) {
    throw new Error("common facts estate differs from the observed estate projection")
  }
  if (canonicalEstateScan(plain(facts.coverage)) !== canonicalEstateScan(coverage)) {
    throw new Error("common facts coverage differs from the observed coverage")
  }
  const { commonFactsRef: _ref, ...local } = certificate
  if ("estate" in local || Object.keys(plain(local.coverage)).join(",") !== "artifactDir") {
    throw new Error("unsupported inline certificate facts")
  }
  return { ...local, estate: facts.estate, coverage: { ...plain(facts.coverage), ...plain(local.coverage) } }
}

function publishCertificateAlias(source: string, target: string, bytes: string): readonly string[] {
  const temporary = join(dirname(target), `.certificate-alias-${randomUUID()}`)
  try {
    linkSync(source, temporary)
  } catch (error) {
    // A copy preserves the proof; its extra allocation is reported through the returned warning row.
    publishArtifact(target, bytes)
    return [`certificate alias used a copy: ${error instanceof Error ? error.message : String(error)}`]
  }
  try {
    publishArtifact(target, { temporaryPath: temporary })
  } finally {
    if (lstatSync(temporary, { throwIfNoEntry: false }) !== undefined) unlinkSync(temporary)
  }
  return []
}

/** A deterministic digest of a directory tree: sorted `relative-path sha256` rows. */
export function digestDirectory(root: string): string {
  const rows: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) {
        rows.push(
          `${relative(root, path).split(sep).join("/")} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`,
        )
      }
    }
  }
  if (existsSync(root) && statSync(root).isDirectory()) walk(root)
  return createHash("sha256").update(rows.join("\n")).digest("hex")
}

/**
 * Write the certificate as `<artifactDir>/retirement-certificate-<digest>.json` plus a stable
 * `retirement-certificate.json` pointer copy. Both live outside `E`; an unwritable artifact
 * directory is `unknown`, never a silent pass.
 */
export async function emitCertificate(
  certificate: unknown,
  artifactDir: string,
  commonArtifactDir?: string,
): Promise<CertificateEmission> {
  try {
    const original = plain(certificate)
    if (
      original.schema !== RETENTION_CERTIFICATE_SCHEMA ||
      original.certificateSchema !== RETENTION_CERTIFICATE_SCHEMA
    ) {
      throw new Error("unsupported retention certificate writer version")
    }
    const common = unredirected(commonArtifactDir ?? join(artifactDir, "common"))
    const removal: readonly unknown[] = Array.isArray(original.removal) ? original.removal : []
    const roots = [...removal, original.root, original.entry].filter((root): root is string => typeof root === "string")
    if (roots.some((root) => contained(resolve(root), common))) {
      throw new Error("common facts directory is inside removal custody")
    }
    mkdirSync(artifactDir, { recursive: true })
    const { estate, coverage, ...local } = original
    const { artifactDir: localArtifactDir, ...commonCoverage } = plain(coverage)
    const payload = JSON.stringify({ schema: COMMON_FACTS_SCHEMA, estate: plain(estate), coverage: commonCoverage })
    const writer = new SidecarWriter(common, "common-facts.jsonl")
    let commonFactsRef
    try {
      writer.add(payload)
      commonFactsRef = await writer.finish()
    } catch (error) {
      writer.abort()
      throw error
    }
    // Sidecar reuse verifies bytes but must also reject a redirected content-addressed destination.
    unredirected(commonFactsRef.path)
    const bytes = `${JSON.stringify({ ...local, coverage: { artifactDir: localArtifactDir }, commonFactsRef }, null, 2)}\n`
    const digest = createHash("sha256").update(bytes).digest("hex")
    const path = join(artifactDir, `retirement-certificate-${digest.slice(0, 16)}.json`)
    publishArtifact(path, bytes)
    const warnings = publishCertificateAlias(path, join(artifactDir, "retirement-certificate.json"), bytes)
    return {
      status: "pass",
      detail: `certificate ${path} (sha256 ${digest})`,
      path,
      digest,
      commonArtifactDir: common,
      warnings,
    }
  } catch (error) {
    return {
      status: "unknown",
      detail: `cannot emit certificate in ${artifactDir}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
