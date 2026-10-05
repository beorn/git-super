import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs"
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path"
import { manifest, metadataFileDigest, type ManifestEntry, type StoreCustody } from "./worktree-removal.ts"

/**
 * Read-only verification of one retained GitSuper entry (a direct child of a declared
 * `retained-modules` root). The result is EVIDENCE, never removal authority: only a later,
 * separately-gated final boundary under a namespace-admission barrier may authorize removal.
 *
 * Stages implemented here: gate 1 (identity and eligibility) and gate 2 (full copy-to-manifest
 * comparison). Gates 3-6 are reported `unknown` by this cut rather than inferred: a proof that
 * cannot be completed must never read as a pass.
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
  gates: readonly RetentionGateResult[]
  coverage: Readonly<{ declaredNamespaceRoots: readonly string[]; excluded: readonly string[] }>
}>

export type RetentionVerifyOptions = Readonly<{
  entry: string
  /** The caller-declared, canonical `retained-modules` root; `entry` must be one direct child. */
  root: string
  /**
   * Managed roots whose Git object stores, alternates declarations and borrower registries make up
   * the estate `N` for gate 3. Empty means the inventory cannot be proven complete.
   */
  namespaceRoots?: readonly string[]
  clock?: Date
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

export function verifyRetainedEntry(options: RetentionVerifyOptions): RetentionVerifyResult {
  const clock = options.clock ?? new Date()
  const gates: RetentionGateResult[] = []
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
  } = { entry: resolve(options.entry), root: resolve(options.root) }

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
      verdict,
      ...result,
      clock: clock.toISOString(),
      gates: ordered,
      coverage: { declaredNamespaceRoots, excluded: [] },
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
      gates.push(
        refusal("identity-eligibility", `${entryReal} is not a direct child of declared root ${rootReal}`, {
          path: entryReal,
          remedy: `Declare the immediate parent of ${basename(entryReal)} as --root, or verify the entry itself.`,
        }),
      )
      return finish()
    }
    const entryStat = lstatSync(entryReal)
    if (!entryStat.isDirectory() || entryStat.isSymbolicLink()) {
      gates.push(
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
      gates.push(
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
    gates.push(
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
    gates.push(
      refusal("identity-eligibility", `manifest records ${proof.manifest}, not ${manifestPath}`, {
        path: manifestPath,
        remedy: "The entry's proof does not describe this directory; preserve it and investigate.",
      }),
    )
    return finish()
  }
  const expectedCopyRoot = join(entryReal, "modules")
  if (proof.retained !== null && proof.retained !== expectedCopyRoot) {
    gates.push(
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
    gates.push(
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
  gates.push({
    gate: "identity-eligibility",
    status: "pass",
    message: `entry ${entryReal} is a direct child of ${result.root}; retainUntil ${proof.retainUntil} has passed`,
    path: manifestPath,
  })

  // ---- Gate 2: full copy-to-manifest comparison -----------------------------------------
  try {
    const expectedTop = proof.retained === null ? ["manifest.json"] : ["manifest.json", "modules"]
    const actualTop = readdirSync(entryReal).sort()
    if (JSON.stringify(actualTop) !== JSON.stringify(expectedTop)) {
      gates.push(
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
      gates.push({
        gate: "copy-manifest",
        status: "pass",
        message: "entry recorded no copied Git stores; the wrapper holds the manifest alone",
        path: manifestPath,
      })
      return finish()
    }
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
      gates.push(
        refusal("copy-manifest", `copied store differs from the manifest at '${differingEntry}'`, {
          path: join(expectedCopyRoot, differingEntry),
          remedy: "Preserve the entry: its bytes no longer match the proof taken at retention.",
        }),
      )
      return finish()
    }
    const differingFile = firstDifference(proof.files, actual.files)
    if (differingFile !== undefined) {
      gates.push(
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
        gates.push(
          refusal("copy-manifest", `${link} is not the recorded objects link`, {
            path: link,
            remedy: "Preserve the entry: an external object store link changed shape.",
          }),
        )
        return finish()
      }
      const target = realpathSync(link)
      if (target !== realpathSync(store.target)) {
        gates.push(
          refusal("copy-manifest", `${link} points at ${target}, not the recorded ${store.target}`, {
            path: link,
            remedy: "Preserve the entry: a borrowed store is no longer the one the proof recorded.",
          }),
        )
        return finish()
      }
    }
    gates.push({
      gate: "copy-manifest",
      status: "pass",
      message: `copied stores match the manifest (${Object.keys(expectedEntries).length} entries, ${proof.externalObjectStores.length} external stores)`,
      path: expectedCopyRoot,
    })
  } catch (error) {
    gates.push(
      refusal("copy-manifest", error instanceof Error ? error.message : String(error), {
        path: proof.retained ?? entryReal,
        remedy: "An unreadable or changed copy cannot be proven; preserve the entry and investigate.",
      }),
    )
    return finish()
  }

  // ---- Gates 3-6: not implemented in this cut, and reported as such ----------------------
  gates.push(
    incomplete("estate-inventory", "no managed-namespace inventory was built in this cut", {
      remedy:
        "Gate 3 needs owner-declared managed roots (every retention root, common dir, worktree/bay/landing and private projection) and one inverted alternate/objects-link index; absent that owner API the inventory cannot be proven complete.",
    }),
  )
  gates.push(
    incomplete("candidate-contents", "Effective/IndependentStores/AtRisk/Roots were not computed in this cut", {
      remedy: "Gate 4 needs the per-component object-set ledger and its alternate closure.",
    }),
  )
  gates.push(
    incomplete("positive-custody", "no durable witnesses were resolved in this cut", {
      remedy: "Gate 5 needs a survivor ref/object proof for every at-risk object id.",
    }),
  )
  gates.push(
    incomplete("certificate", "no preliminary certificate was emitted in this cut", {
      remedy: "Gate 6 needs the content-addressed artifact outside the entry.",
    }),
  )
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
