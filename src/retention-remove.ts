import { createHash } from "node:crypto"
import { lstatSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { acquireFlockWithTimeout, type FlockHandle } from "@bearly/flock"
import { DEFAULT_MUTATION_LOCK_WAIT_MS } from "./exclusive.ts"
import { canonicalEstateScan } from "./retention-estate.ts"
import { gitSuperResult, type GitResultDetail, type GitSuperRepositoryResult, type GitSuperResult } from "./result.ts"
import { verifyRetainedEntry, type RetentionVerifyOptions, type RetentionVerifyResult } from "./retention-verify.ts"
import { acquireRemovalWriterLeases, readRetainedPointer, removeRetainedPointer } from "./worktree-removal.ts"

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

/** The only retained-entry actuator; a standalone preliminary proof remains no capability. */
export async function retireRetainedEntry(options: RetentionRetireOptions): Promise<GitSuperResult> {
  let entry = resolve(options.entry)
  let root = resolve(options.root)
  let commonLease: FlockHandle | undefined
  let leases: ReturnType<typeof acquireRemovalWriterLeases> | undefined
  let crossed = false
  let phase = "identity"
  let proof: RetentionVerifyResult | undefined
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
      phase = "preliminary-proof"
      proof = await verifyRetainedEntry({ ...options, entry, root, artifactDir: join(options.artifactDir, "pre") })
      if (proof.verdict !== "candidate") return kept(keepReason(proof), proof.reasons.join("; "))
      const before = proofFacts(proof)
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
      const held = await verifyRetainedEntry({
        ...options,
        entry,
        root,
        artifactDir: join(options.artifactDir, "held"),
      })
      const after = held.verdict === "candidate" ? proofFacts(held) : undefined
      if (
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
    if (!crossed) {
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
      result = { ...gitSuperResult(rows, detail), partial: crossed }
    }
  }
  return result
}
