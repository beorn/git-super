import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  statfsSync,
  mkdirSync,
  copyFileSync,
} from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { createHash } from "node:crypto"
import { digestDirectory, emitCertificate, RETENTION_CERTIFICATE_SCHEMA } from "./retention-certificate.ts"
import { scanContents, type ComponentContents, type ContentsBounds, type GitRun } from "./retention-contents.ts"
import { scanCustody, type CustodyBounds, type Witness } from "./retention-custody.ts"
import { scanEstate, type EstateScan, type EstateScanBounds } from "./retention-estate.ts"
import { manifest, metadataFileDigest, type ManifestEntry, type StoreCustody } from "./worktree-removal.ts"

/**
 * Read-only verification of one retained GitSuper entry (a direct child of a declared
 * `retained-modules` root). The result is EVIDENCE, never removal authority: only a later,
 * separately-gated final boundary under a namespace-admission barrier may authorize removal.
 *
 * Gates 1-6 (#27443(b) contract): identity/eligibility, full copy-to-manifest comparison with a
 * non-object metadata sidecar, the complete estate/reverse-dependency snapshot, per-component
 * candidate contents, positive surviving custody, and the preliminary certificate. A `candidate`
 * verdict requires gates 1-5 to pass and gate 6 to emit; it is still preliminary proof only.
 */

export type RetentionGateId =
  | "identity-eligibility"
  | "copy-manifest"
  | "estate-inventory"
  | "candidate-contents"
  | "positive-custody"
  | "certificate"

export type RetentionGateStatus = "pass" | "blocked" | "unknown"

export type RetentionGateResult = Readonly<{
  gate: RetentionGateId
  status: RetentionGateStatus
  message: string
  path?: string
  remedy?: string
}>

export type RetentionVerifyVerdict = "candidate" | "blocked" | "unknown"

export type RetentionVerifyResult = Readonly<{
  schema: string
  verdict: RetentionVerifyVerdict
  entry: string
  root: string
  entryDevIno?: string | undefined
  rootDevIno?: string | undefined
  head?: string | undefined
  createdAt?: string | undefined
  retainUntil?: string | undefined
  clock: string
  manifestSha256?: string | undefined
  artifactDir?: string | undefined
  gates: readonly RetentionGateResult[]
  reasons: readonly string[]
  estate?: EstateScan | undefined
  contents?: readonly ComponentContents[] | undefined
  witnesses?: readonly Witness[] | undefined
  certificate?: Readonly<{ path: string; digest: string }> | undefined
  coverage: Readonly<{
    declaredNamespaceRoots: readonly string[]
    witnessStores: readonly string[]
    excluded: readonly string[]
  }>
}>

export type RetentionVerifyBounds = Readonly<{
  estate?: EstateScanBounds
  contents?: ContentsBounds
  custody?: CustodyBounds
}>

export type RetentionVerifyOptions = Readonly<{
  entry: string
  /** The caller-declared, canonical `retained-modules` root; `entry` must be one direct child. */
  root: string
  /**
   * Managed roots whose Git object stores, alternates declarations and borrower registries make up
   * the estate `N` for gates 3-5. Empty means the inventory cannot be proven complete.
   */
  namespaceRoots?: readonly string[]
  /**
   * External, caller-owned pass directory (outside `E` and outside the retention root) for the
   * gate 2 non-object metadata sidecar and the gate 6 certificate. Absent means neither can be
   * produced, so gates 2 and 6 report `unknown`.
   */
  artifactDir?: string
  clock?: Date
  bounds?: RetentionVerifyBounds
  /** Injected git runner and monotonic clock for tests; real runs use the clean-child defaults. */
  gitRun?: GitRun
  monotonic?: () => number
}>

const GATE_ORDER: readonly RetentionGateId[] = [
  "identity-eligibility",
  "copy-manifest",
  "estate-inventory",
  "candidate-contents",
  "positive-custody",
  "certificate",
]

function devIno(path: string): string | undefined {
  const stats = lstatSync(path)
  return `${stats.dev}:${stats.ino}`
}

function refusal(
  gate: RetentionGateId,
  message: string,
  extra?: { path?: string; remedy?: string },
): RetentionGateResult {
  return { gate, status: "blocked", message, ...extra }
}

function incomplete(
  gate: RetentionGateId,
  message: string,
  extra?: { path?: string; remedy?: string },
): RetentionGateResult {
  return { gate, status: "unknown", message, ...extra }
}

function evidence(path: string): string {
  const bytes = readFileSync(path, "utf8")
  const parsed: unknown = JSON.parse(bytes)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} is not a retention manifest object`)
  }
  return bytes
}

type RetainedManifest = Readonly<{
  path: string
  head: string
  repositories: readonly string[]
  modules: string
  retained: string | null
  manifest: string
  createdAt: string
  retainUntil: string
  writerLocks: readonly unknown[]
  createdWriterLocks: readonly unknown[]
  notCompared: readonly unknown[]
  files: Readonly<Record<string, string>>
  entries: Readonly<Record<string, ManifestEntry>>
  externalObjectStores: readonly Readonly<{ path: string; declaration: string; target: string }>[]
}>

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
}

/**
 * A field that is ABSENT is a proof we cannot complete (`unknown`) — an entry written by an
 * earlier GitSuper predates the field. A field that is PRESENT but malformed is a violated
 * condition (`blocked`). The distinction is reader-facing only; both preserve the entry.
 */
class ManifestShapeError extends Error {
  constructor(
    message: string,
    readonly kind: "absent" | "invalid",
  ) {
    super(message)
  }
}

function parseManifest(bytes: string, source: string): RetainedManifest {
  const value = JSON.parse(bytes) as Record<string, unknown>
  const require = (field: string, valid: boolean): void => {
    if (!(field in value)) throw new ManifestShapeError(`${source} does not record '${field}'`, "absent")
    if (!valid) throw new ManifestShapeError(`${source} records an invalid '${field}' field`, "invalid")
  }
  require("path", typeof value.path === "string" && isAbsolute(value.path))
  require("head", typeof value.head === "string" && value.head !== "")
  require("repositories", isStringArray(value.repositories))
  require("modules", typeof value.modules === "string" && isAbsolute(value.modules))
  require("retained", value.retained === null || (typeof value.retained === "string" && isAbsolute(value.retained)))
  require("manifest", typeof value.manifest === "string" && isAbsolute(value.manifest))
  require("createdAt", typeof value.createdAt === "string" && !Number.isNaN(Date.parse(value.createdAt)))
  require("retainUntil", typeof value.retainUntil === "string" && !Number.isNaN(Date.parse(value.retainUntil)))
  require("writerLocks", Array.isArray(value.writerLocks))
  require("createdWriterLocks", Array.isArray(value.createdWriterLocks))
  require("notCompared", Array.isArray(value.notCompared))
  require("files", typeof value.files === "object" && value.files !== null && !Array.isArray(value.files))
  require("entries", typeof value.entries === "object" && value.entries !== null && !Array.isArray(value.entries))
  require("externalObjectStores", Array.isArray(value.externalObjectStores))
  return value as unknown as RetainedManifest
}

/** The expected copy transform: an `objects-link` declaration in the copy is the recorded canonical target. */
function expectedCopy(entries: Readonly<Record<string, ManifestEntry>>): Readonly<Record<string, ManifestEntry>> {
  return Object.fromEntries(
    Object.entries(entries).map(([key, entry]) => [
      key,
      entry.kind === "objects-link" ? { ...entry, declaration: entry.target } : entry,
    ]),
  )
}

function firstDifference(
  expected: Readonly<Record<string, unknown>>,
  actual: Readonly<Record<string, unknown>>,
): string | undefined {
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()
  return keys.find((key) => JSON.stringify(expected[key]) !== JSON.stringify(actual[key]))
}

function inside(parent: string, path: string): boolean {
  const part = relative(resolve(parent), resolve(path))
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part))
}

export function verifyRetainedEntry(options: RetentionVerifyOptions): RetentionVerifyResult {
  const clock = options.clock ?? new Date()
  const monotonic = options.monotonic ?? Date.now
  const startedAt = monotonic()
  const gates: RetentionGateResult[] = []
  const reasons: string[] = []
  const declaredNamespaceRoots = [...(options.namespaceRoots ?? [])]
  const result: {
    entry: string
    root: string
    entryDevIno?: string | undefined
    rootDevIno?: string | undefined
    head?: string | undefined
    createdAt?: string | undefined
    retainUntil?: string | undefined
    manifestSha256?: string | undefined
    artifactDir?: string | undefined
    estate?: EstateScan | undefined
    contents?: readonly ComponentContents[] | undefined
    witnesses?: readonly Witness[] | undefined
    certificate?: Readonly<{ path: string; digest: string }> | undefined
  } = { entry: resolve(options.entry), root: resolve(options.root) }
  let witnessStores: readonly string[] = []

  const push = (gate: RetentionGateResult): void => {
    gates.push(gate)
    if (gate.status !== "pass") {
      reasons.push(`gate ${GATE_ORDER.indexOf(gate.gate) + 1} ${gate.gate}: ${gate.message}`)
    }
  }

  const finish = (): RetentionVerifyResult => {
    const ordered = GATE_ORDER.map((gate) => {
      const found = gates.find((entry) => entry.gate === gate)
      if (found !== undefined) return found
      return incomplete(gate, "not evaluated: an earlier gate ended the pass before this one ran")
    })
    const verdict: RetentionVerifyVerdict = ordered.some((gate) => gate.status === "blocked")
      ? "blocked"
      : ordered.some((gate) => gate.status === "unknown")
        ? "unknown"
        : "candidate"
    return {
      schema: RETENTION_CERTIFICATE_SCHEMA,
      verdict,
      ...result,
      clock: clock.toISOString(),
      gates: ordered,
      reasons,
      coverage: { declaredNamespaceRoots, witnessStores, excluded: [] },
    }
  }

  // ---- Gate 1: identity and eligibility -------------------------------------------------
  let entryReal: string
  let manifestPath: string
  let proof: RetainedManifest
  try {
    const rootReal = realpathSync(result.root)
    result.root = rootReal
    entryReal = realpathSync(result.entry)
    result.entry = entryReal
    if (dirname(entryReal) !== rootReal) {
      push(
        refusal("identity-eligibility", `${entryReal} is not a direct child of declared root ${rootReal}`, {
          path: entryReal,
          remedy: `Declare the immediate parent of ${basename(entryReal)} as --root, or verify the entry itself.`,
        }),
      )
      return finish()
    }
    const entryStat = lstatSync(entryReal)
    if (!entryStat.isDirectory() || entryStat.isSymbolicLink()) {
      push(
        refusal("identity-eligibility", `${entryReal} is not a plain directory`, {
          path: entryReal,
          remedy: "A retained entry must be one direct, owned directory that is not a link.",
        }),
      )
      return finish()
    }
    result.rootDevIno = devIno(rootReal)
    result.entryDevIno = devIno(entryReal)
    manifestPath = join(entryReal, "manifest.json")
    const manifestStat = lstatSync(manifestPath)
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
      push(
        refusal("identity-eligibility", `${manifestPath} is not a regular file`, {
          path: manifestPath,
          remedy: "Restore the retention manifest; an entry without one is not verifiable.",
        }),
      )
      return finish()
    }
    proof = parseManifest(evidence(manifestPath), manifestPath)
    result.manifestSha256 = metadataFileDigest(manifestPath)
    result.head = proof.head
    result.createdAt = proof.createdAt
    result.retainUntil = proof.retainUntil
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const absentProof = error instanceof ManifestShapeError && error.kind === "absent"
    push(
      absentProof
        ? incomplete("identity-eligibility", message, {
            path: result.entry,
            remedy:
              "The manifest predates the current retention schema, so its proof cannot be completed; keep the entry until it can be rewritten by a current writer.",
          })
        : refusal("identity-eligibility", message, {
            path: result.entry,
            remedy: "Confirm the entry path and its manifest; an unreadable proof cannot be completed.",
          }),
    )
    return finish()
  }

  if (proof.manifest !== manifestPath) {
    push(
      refusal("identity-eligibility", `manifest records ${proof.manifest}, not ${manifestPath}`, {
        path: manifestPath,
        remedy: "The entry's proof does not describe this directory; preserve it and investigate.",
      }),
    )
    return finish()
  }
  const expectedCopyRoot = join(entryReal, "modules")
  if (proof.retained !== null && proof.retained !== expectedCopyRoot) {
    push(
      refusal(
        "identity-eligibility",
        `manifest records retained copy ${proof.retained}, expected ${expectedCopyRoot}`,
        {
          path: expectedCopyRoot,
          remedy: "An unsupported retained-copy shape; preserve the entry and investigate.",
        },
      ),
    )
    return finish()
  }
  const retainUntil = new Date(proof.retainUntil)
  if (!(clock.getTime() > retainUntil.getTime())) {
    push(
      refusal(
        "identity-eligibility",
        `retainUntil ${proof.retainUntil} has not passed (clock ${clock.toISOString()})`,
        {
          path: manifestPath,
          remedy: "Eligibility requires now > retainUntil; retry after the retention floor.",
        },
      ),
    )
    return finish()
  }
  push({
    gate: "identity-eligibility",
    status: "pass",
    message: `entry ${entryReal} is a direct child of ${result.root}; retainUntil ${proof.retainUntil} has passed`,
    path: manifestPath,
  })

  // ---- Gate 2: full copy-to-manifest comparison + non-object metadata sidecar -----------
  let metadataBundleDigest: string | undefined
  try {
    const expectedTop = proof.retained === null ? ["manifest.json"] : ["manifest.json", "modules"]
    const actualTop = readdirSync(entryReal).sort()
    if (JSON.stringify(actualTop) !== JSON.stringify(expectedTop)) {
      push(
        refusal(
          "copy-manifest",
          `wrapper ${entryReal} holds [${actualTop.join(", ")}]; expected [${expectedTop.join(", ")}]`,
          {
            path: entryReal,
            remedy: "Remove unexplained wrapper files, or preserve the entry and investigate.",
          },
        ),
      )
      return finish()
    }
    if (proof.retained === null) {
      push({
        gate: "copy-manifest",
        status: "pass",
        message: "entry recorded no copied Git stores; the wrapper holds the manifest alone",
        path: manifestPath,
      })
    } else {
      const custody: StoreCustody = {
        // The original common dir is not recorded. Every external target is re-proved below by
        // comparison against the recorded declaration, which is stronger than rechecking custody.
        common: sep,
        checkout: proof.path,
        gitDir: dirname(proof.modules),
        modules: expectedCopyRoot,
      }
      const actual = manifest(expectedCopyRoot, custody, true, false)
      const expectedEntries = expectedCopy(proof.entries)
      const differingEntry = firstDifference(expectedEntries, actual.entries)
      if (differingEntry !== undefined) {
        push(
          refusal("copy-manifest", `copied store differs from the manifest at '${differingEntry}'`, {
            path: join(expectedCopyRoot, differingEntry),
            remedy: "Preserve the entry: its bytes no longer match the proof taken at retention.",
          }),
        )
        return finish()
      }
      const differingFile = firstDifference(proof.files, actual.files)
      if (differingFile !== undefined) {
        push(
          refusal("copy-manifest", `copied file digest differs from the manifest at '${differingFile}'`, {
            path: join(expectedCopyRoot, differingFile),
            remedy: "Preserve the entry: its bytes no longer match the proof taken at retention.",
          }),
        )
        return finish()
      }
      for (const store of proof.externalObjectStores) {
        const link = join(expectedCopyRoot, store.path)
        const stats = lstatSync(link)
        if (!stats.isSymbolicLink()) {
          push(
            refusal("copy-manifest", `${link} is not the recorded objects link`, {
              path: link,
              remedy: "Preserve the entry: an external object store link changed shape.",
            }),
          )
          return finish()
        }
        const target = realpathSync(link)
        if (target !== realpathSync(store.target)) {
          push(
            refusal("copy-manifest", `${link} points at ${target}, not the recorded ${store.target}`, {
              path: link,
              remedy: "Preserve the entry: a borrowed store is no longer the one the proof recorded.",
            }),
          )
          return finish()
        }
      }
      // Outside E: a byte-exact bundle of the NON-OBJECT metadata (refs/reflogs/pseudo-refs/
      // index/config and other manifest files outside objects/**), with a free-space check and a
      // read-back hash. Git objects are never copied as a replacement.
      if (options.artifactDir === undefined) {
        push(
          incomplete(
            "copy-manifest",
            "no --artifact-dir was supplied, so the non-object metadata sidecar cannot be written",
            {
              path: entryReal,
              remedy: "Supply an external, caller-owned --artifact-dir outside the retention root and entry.",
            },
          ),
        )
        return finish()
      }
      const artifactDir = resolve(options.artifactDir)
      if (inside(entryReal, artifactDir) || inside(result.root, artifactDir)) {
        push(
          refusal("copy-manifest", `pass artifact ${artifactDir} is inside the retention custody ${result.root}`, {
            path: artifactDir,
            remedy: "Choose a pass directory outside the declared retention root and the entry.",
          }),
        )
        return finish()
      }
      result.artifactDir = artifactDir
      mkdirSync(artifactDir, { recursive: true })
      const bundle = join(artifactDir, "metadata")
      mkdirSync(bundle, { recursive: true })
      const nonObject = Object.keys(expectedEntries)
        .filter((key) => !key.split("/").includes("objects"))
        .sort()
      const bytes = nonObject.reduce(
        (total, key) => total + (actual.entries[key]?.kind === "file" ? statSync(join(expectedCopyRoot, key)).size : 0),
        0,
      )
      const free = statfsSync(artifactDir)
      const available = Number(free.bavail) * Number(free.bsize)
      if (available < bytes) {
        push(
          refusal("copy-manifest", `pass artifact ${artifactDir} has ${available} bytes free, needs ${bytes}`, {
            path: artifactDir,
            remedy: "Choose a pass directory with room for the byte-exact non-object metadata bundle.",
          }),
        )
        return finish()
      }
      for (const key of nonObject) {
        const want = actual.entries[key]!
        if (want.kind !== "file") continue
        const source = join(expectedCopyRoot, key)
        const target = join(bundle, key)
        mkdirSync(dirname(target), { recursive: true })
        copyFileSync(source, target)
        if (createHash("sha256").update(readFileSync(target)).digest("hex") !== want.sha256) {
          push(
            refusal("copy-manifest", `metadata bundle ${target} read-back does not match manifest ${want.sha256}`, {
              path: target,
              remedy: "Preserve the entry and investigate the pass directory; the sidecar is not byte-exact.",
            }),
          )
          return finish()
        }
      }
      metadataBundleDigest = digestDirectory(bundle)
      push({
        gate: "copy-manifest",
        status: "pass",
        message: `copied stores match the manifest (${Object.keys(expectedEntries).length} entries, ${proof.externalObjectStores.length} external stores); ${nonObject.length} non-object path(s) bundled (${metadataBundleDigest.slice(0, 16)})`,
        path: expectedCopyRoot,
      })
    }
  } catch (error) {
    push(
      refusal("copy-manifest", error instanceof Error ? error.message : String(error), {
        path: proof.retained ?? entryReal,
        remedy: "An unreadable or changed copy cannot be proven; preserve the entry and investigate.",
      }),
    )
    return finish()
  }

  // ---- Gate 3: complete estate and reverse dependency snapshot --------------------------
  let estate: EstateScan | undefined
  if (declaredNamespaceRoots.length === 0) {
    push(
      incomplete(
        "estate-inventory",
        "no managed-namespace root was declared, so the inventory cannot be proven complete",
        {
          remedy:
            "Declare every managed retention root, common dir, worktree/bay/landing and private projection with --namespace.",
        },
      ),
    )
    return finish()
  }
  estate = scanEstate(declaredNamespaceRoots, [entryReal], options.bounds?.estate, monotonic)
  result.estate = estate
  witnessStores = estate.objectDirs.filter((path) => !inside(entryReal, path))
  if (estate.status !== "pass") {
    push(
      estate.status === "blocked"
        ? refusal("estate-inventory", estate.detail, {
            remedy: "A survivor borrows into the removal set; keep the entry and investigate the borrower.",
          })
        : incomplete("estate-inventory", estate.detail, {
            remedy: "Complete the managed-namespace inventory; an unproven estate preserves the entry.",
          }),
    )
    return finish()
  }
  for (const store of proof.externalObjectStores) {
    const target = realpathSync(store.target)
    const covered =
      estate.objectDirs.includes(target) ||
      estate.borrowers.some((borrower) => borrower.target === target) ||
      witnessStores.includes(target)
    if (!covered) {
      push(
        incomplete(
          "estate-inventory",
          `declared external store ${store.target} was not reached by the declared namespace`,
          {
            path: store.target,
            remedy: "Declare the owner root of every external store this entry borrows from.",
          },
        ),
      )
      return finish()
    }
  }
  push({
    gate: "estate-inventory",
    status: "pass",
    message: `${estate.detail}; ${estate.roots.length} declared root(s), ${estate.registries.length} borrower registry(ies)`,
    path: entryReal,
  })

  // ---- Gate 4: candidate Git contents ---------------------------------------------------
  let contents: ReturnType<typeof scanContents> | undefined
  contents = scanContents(
    expectedCopyRoot,
    proof.entries,
    [entryReal],
    options.gitRun,
    options.bounds?.contents,
    monotonic,
  )
  result.contents = contents.components
  if (contents.status !== "pass") {
    push(
      contents.status === "blocked"
        ? refusal("candidate-contents", contents.detail, {
            path: expectedCopyRoot,
            remedy: "A named root OID is missing from the entry's own store; keep the entry.",
          })
        : incomplete("candidate-contents", contents.detail, {
            path: expectedCopyRoot,
            remedy: "Complete the per-component object ledger; an unproven contents set preserves the entry.",
          }),
    )
    return finish()
  }
  push({
    gate: "candidate-contents",
    status: "pass",
    message: contents.detail,
    path: expectedCopyRoot,
  })

  // ---- Gate 5: positive surviving custody ----------------------------------------------
  const custody = scanCustody(
    expectedCopyRoot,
    contents.components,
    witnessStores,
    [entryReal],
    options.gitRun,
    options.bounds?.custody,
    monotonic,
  )
  result.witnesses = custody.witnesses
  if (custody.status !== "pass") {
    push(
      custody.status === "blocked"
        ? refusal("positive-custody", custody.detail, {
            path: expectedCopyRoot,
            remedy: "No durable witness holds an at-risk object; the entry preserves the last copy.",
          })
        : incomplete("positive-custody", custody.detail, {
            path: expectedCopyRoot,
            remedy: "Prove custody from a durable survivor ref in a clean, empty-of-R store.",
          }),
    )
    return finish()
  }
  push({
    gate: "positive-custody",
    status: "pass",
    message: custody.detail,
    path: expectedCopyRoot,
  })

  // ---- Gate 6: preliminary certificate -------------------------------------------------
  if (options.artifactDir === undefined || result.artifactDir === undefined) {
    push(
      incomplete("certificate", "no --artifact-dir was supplied, so no preliminary certificate can be emitted", {
        remedy: "Supply an external, caller-owned --artifact-dir for the content-addressed certificate.",
      }),
    )
    return finish()
  }
  const certificate = {
    schema: RETENTION_CERTIFICATE_SCHEMA,
    schemaId: "hab-sandbox/retained-modules-retirement/1",
    verdict: "candidate",
    entry: entryReal,
    removal: [entryReal],
    root: result.root,
    clock: clock.toISOString(),
    retainUntil: proof.retainUntil,
    entryDevIno: result.entryDevIno,
    rootDevIno: result.rootDevIno,
    head: proof.head,
    manifestSha256: result.manifestSha256,
    metadataBundleDigest,
    components: contents.components.map((component) => ({
      component: component.component,
      effective: component.effective,
      independent: component.independent,
      atRisk: component.atRisk,
      atRiskDigest: createHash("sha256").update(component.atRiskOids.join("\n")).digest("hex"),
      missingRoots: component.missingRoots.length,
    })),
    estate: {
      roots: estate.roots,
      objectDirs: estate.objectDirs,
      alternatesFiles: estate.alternatesFiles,
      borrowers: estate.borrowers,
      registries: estate.registries,
      survivorIntoRemoval: estate.survivorIntoRemoval,
    },
    witnesses: custody.witnesses,
    bounds: {
      estate: options.bounds?.estate ?? null,
      contents: options.bounds?.contents ?? null,
      custody: options.bounds?.custody ?? null,
    },
    elapsedMs: monotonic() - startedAt,
    coverage: {
      declaredNamespaceRoots,
      witnessStores,
      excluded: [],
      artifactDir: result.artifactDir,
    },
  }
  const emission = emitCertificate(
    { ...certificate, certificateSchema: RETENTION_CERTIFICATE_SCHEMA },
    result.artifactDir,
  )
  if (emission.status !== "pass" || emission.path === undefined || emission.digest === undefined) {
    push(
      incomplete("certificate", emission.detail, {
        path: result.artifactDir,
        remedy: "Choose a writable pass directory outside the retention custody.",
      }),
    )
    return finish()
  }
  result.certificate = { path: emission.path, digest: emission.digest }
  push({
    gate: "certificate",
    status: "pass",
    message: emission.detail,
    path: emission.path,
  })
  return finish()
}

/**
 * The reusable final-boundary predicate. Removal is authorized only when a full pass proves
 * `candidate` AND the namespace-admission barrier and composed locks have been held through
 * revalidation. This cut does not implement that boundary, so it refuses by construction.
 */
export function retentionRemovalBoundary(result: RetentionVerifyResult): Readonly<{
  authorized: false
  verdict: RetentionVerifyVerdict
  reason: string
}> {
  return {
    authorized: false,
    verdict: result.verdict,
    reason:
      result.verdict === "candidate"
        ? "a candidate result is preliminary evidence only; the namespace-admission barrier and composed locks are not implemented"
        : `verdict ${result.verdict} preserves the entry`,
  }
}
