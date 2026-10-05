/**
 * Gate 6 of the #27443(b) retirement proof: the deterministic, content-addressed preliminary
 * certificate, emitted OUTSIDE the entry. `candidate` here means *preliminary proof only*: the
 * certificate is never a delete capability, and GitSuper writes nothing under `E`.
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, relative, sep } from "node:path"

export const RETENTION_CERTIFICATE_SCHEMA = "git-super/retention-certificate/1"

export interface CertificateEmission {
  readonly status: "pass" | "unknown"
  readonly detail: string
  readonly path?: string
  readonly digest?: string
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
export function emitCertificate(certificate: unknown, artifactDir: string): CertificateEmission {
  try {
    mkdirSync(artifactDir, { recursive: true })
    const bytes = `${JSON.stringify(certificate, null, 2)}\n`
    const digest = createHash("sha256").update(bytes).digest("hex")
    const path = join(artifactDir, `retirement-certificate-${digest.slice(0, 16)}.json`)
    writeFileSync(path, bytes)
    writeFileSync(join(artifactDir, "retirement-certificate.json"), bytes)
    return { status: "pass", detail: `certificate ${path} (sha256 ${digest})`, path, digest }
  } catch (error) {
    return {
      status: "unknown",
      detail: `cannot emit certificate in ${artifactDir}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
