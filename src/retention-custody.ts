/**
 * Gate 5 of the #27443(b) retirement proof: positive surviving custody for every at-risk OID.
 *
 * For each at-risk OID of every component, a durable witness must exist: a NAMED persistent
 * survivor ref in a store of the same object format whose reachable closure includes the OID,
 * whose alternate path closure is disjoint from the removal set `R`, and whose `fsck --full`
 * succeeds (cached once per pass). An existing alternate target, `cat-file -e`, a transient
 * reflog, or a bead is never a witness. Read-only: git queries and file reads only.
 *
 * The witness search is a MERGE, never a set: each durable ref's `rev-list --objects` output is
 * traversal-ordered, so it is externally sorted into a content-addressed sidecar, and the refs are
 * merged under a bounded fan-in into one OID -> ref-rank index. The at-risk stream is then
 * merge-joined against that index, so peak memory is the sort run buffer plus a line per stream,
 * not a 20,000,000-entry Map.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, relative, sep } from "node:path"
import { alternateEntries } from "./alternates.ts"
import {
  assertStreamComplete,
  DEFAULT_SORT_RUN_LINES,
  externalSortToSidecar,
  mergeLabeledFiles,
  mergeSorted,
  oidKey,
  readLines,
  SidecarWriter,
  type GitLineStream,
  type SidecarRef,
} from "./retention-stream.ts"
import {
  defaultGitRun,
  defaultGitStream,
  refuseSuccessfulStderr,
  type ComponentContents,
  type GitRun,
  type GitStreamFactory,
} from "./retention-contents.ts"

export interface CustodyBounds {
  /** 20,000,000 reachable OIDs per survivor graph in the contract's initial pass. */
  readonly maxReachableOids: number
  /** 300 s per survivor graph in the contract's initial pass. */
  readonly reachableMs: number
  /** 300 s per cached witness `fsck --full` in the contract's initial pass. */
  readonly fsckMs: number
}
export const DEFAULT_CUSTODY_BOUNDS: CustodyBounds = {
  maxReachableOids: 20_000_000,
  reachableMs: 300_000,
  fsckMs: 300_000,
}

export interface CustodyTarget {
  readonly component: string
  readonly oid: string
  readonly source: string
}

/** A durable survivor ref that witnessed at least one at-risk OID; the inline distinct identity. */
export interface WitnessIdentity {
  readonly store: string
  readonly ref: string
  readonly tip: string
  /** sha256 of this ref's sorted reachable-OID sidecar. */
  readonly graphDigest: string
}

export interface CustodyScan {
  readonly status: "pass" | "blocked" | "unknown"
  readonly detail: string
  /** The distinct (store, ref, tip) identities; bounded by the number of durable refs. */
  readonly witnesses: readonly WitnessIdentity[]
  /** The number of at-risk OIDs that found a durable witness. */
  readonly witnessCount: number
  readonly witnessSidecar?: SidecarRef | undefined
  /** The first 100 un-witnessed OIDs; the full list is `missingSidecar`. */
  readonly missing: readonly CustodyTarget[]
  readonly missingCount: number
  readonly missingSidecar?: SidecarRef | undefined
}

export interface CustodyScanOptions {
  /** Directory for the content-addressed sidecars; must be outside `E` and `R`. */
  readonly sidecarDir: string
  readonly run?: GitRun
  readonly stream?: GitStreamFactory
  readonly bounds?: CustodyBounds
  readonly clock?: () => number
  /** Shared absolute proof deadline in the same clock domain as `clock`; exhaustion is unknown. */
  readonly deadline?: number
  /** When present, only this target branch and exact-suffix primary pin refs are durable witnesses. */
  readonly witnessPolicy?: Readonly<{ targetBranch: string }>
}

const HEX40 = /^[0-9a-f]{40}$/u
/** The only durable witness namespaces the contract admits: branches, tags and GitSuper pins. */
const DURABLE_REF = /^refs\/(?:heads|tags)\//u
const PIN_REF = /^refs\/git-super\/pins\//u
const MISSING_INLINE = 100

class UnknownError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UnknownError"
  }
}

function isDurableRef(ref: string): boolean {
  return DURABLE_REF.test(ref) || PIN_REF.test(ref)
}

function isPolicyRef(ref: string, tip: string, targetBranch: string): boolean {
  if (ref === `refs/heads/${targetBranch}`) return true
  const pin = /^(?:refs\/git-super\/pins|refs\/yrd\/pins)\/([0-9a-f]{40})$/u.exec(ref)
  return pin?.[1] === tip
}

function within(parent: string, path: string): boolean {
  const part = relative(parent, path)
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part))
}

function isObjectDir(path: string): boolean {
  return (
    existsSync(path) &&
    statSync(path).isDirectory() &&
    (existsSync(join(path, "pack")) || existsSync(join(path, "info")))
  )
}

/** Transitive alternates closure of a store, refusing any link into `R` or a missing target. */
function alternateClosure(
  objects: string,
  removal: readonly string[],
): { status: "ok"; stores: string[] } | { status: "unknown"; detail: string } {
  const stores: string[] = []
  const seen = new Set<string>()
  const stack = [objects]
  while (stack.length > 0) {
    const store = stack.pop()
    if (store === undefined) break
    if (seen.has(store)) continue
    seen.add(store)
    stores.push(store)
    const file = join(store, "info", "alternates")
    if (!existsSync(file)) continue
    let content: string
    try {
      content = readFileSync(file, "utf8")
    } catch (error) {
      return {
        status: "unknown",
        detail: `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    for (const target of alternateEntries(content, store)) {
      if (!existsSync(target) || !statSync(target).isDirectory()) {
        return { status: "unknown", detail: `${file} names a missing alternate ${target}` }
      }
      if (removal.some((root) => within(root, target))) {
        return { status: "unknown", detail: `witness store ${store} borrows ${target} inside the removal set` }
      }
      stack.push(target)
    }
  }
  return { status: "ok", stores }
}

async function objectFormat(
  gitDir: string,
  run: GitRun,
): Promise<{ status: "ok"; format: string } | { status: "unknown"; detail: string }> {
  const result = await run([`--git-dir=${gitDir}`, "rev-parse", "--show-object-format"])
  refuseSuccessfulStderr(result, `rev-parse --show-object-format in ${gitDir}`)
  if (result.code !== 0) {
    return { status: "unknown", detail: `rev-parse --show-object-format failed in ${gitDir}: ${result.stderr.trim()}` }
  }
  const format = result.stdout.trim()
  if (format !== "sha1" && format !== "sha256") {
    return { status: "unknown", detail: `${gitDir} reports unsupported object format '${format}'` }
  }
  return { status: "ok", format }
}

/** Drain bounded output before classifying it: a partial row cannot hide a native failure. */
async function* reachableOidLines(
  stream: GitLineStream,
  gitDir: string,
  tip: string,
  bounds: CustodyBounds,
): AsyncGenerator<string> {
  let malformed: UnknownError | undefined
  for await (const line of stream.lines) {
    if (malformed !== undefined) continue
    const oid = line.split(" ")[0]
    if (oid === undefined || !HEX40.test(oid)) {
      malformed = new UnknownError(`malformed rev-list row for ${tip} in ${gitDir}: ${line.slice(0, 120)}`)
      continue
    }
    yield oid
  }
  // Await only after draining: the producer can otherwise be paused at its queue bound.
  const outcome = await stream.outcome
  assertStreamComplete(outcome, {
    timedOut: `rev-list ${tip} in ${gitDir} exceeded the ${bounds.reachableMs} ms bound`,
    capped: `reachable OIDs exceeded the ${bounds.maxReachableOids} cap in ${gitDir}`,
    failed: `rev-list ${tip} failed in witness store ${gitDir}: ${outcome.stderr.trim()}`,
    warned: `rev-list ${tip} in ${gitDir} exited 0 with stderr: ${outcome.stderr.trim()}`,
  })
  if (malformed !== undefined) throw malformed
}

interface DurableRefRecord {
  readonly store: string
  readonly ref: string
  readonly tip: string
  readonly format: string
  readonly sidecar: SidecarRef
}

interface WitnessRef {
  readonly ref: string
  readonly tip: string
  readonly objectType: string | undefined
}

/** Select real refs whose complete graphs cover all admitted policy commits. */
async function independentPolicyRefs(
  durable: readonly WitnessRef[],
  gitDir: string,
  run: GitRun,
): Promise<readonly WitnessRef[]> {
  // Descendant graphs contain their ancestors' complete object graphs. Noncommit
  // refs retain their own graphs; each selected commit keeps one real named ref.
  const commitRefs = new Map<string, string>()
  for (const entry of durable) {
    if (entry.objectType === "commit" && !commitRefs.has(entry.tip)) commitRefs.set(entry.tip, entry.ref)
  }
  let independent = new Set(commitRefs.keys())
  if (commitRefs.size > 1) {
    const reduced = await run([`--git-dir=${gitDir}`, "merge-base", "--independent", ...commitRefs.keys()])
    refuseSuccessfulStderr(reduced, `merge-base --independent in witness store ${gitDir}`)
    if (reduced.code !== 0 || reduced.timedOut === true) {
      throw new UnknownError(
        `merge-base --independent did not complete in ${gitDir} (exit ${reduced.code}, timedOut ${reduced.timedOut === true}): ${reduced.stderr.trim()}`,
      )
    }
    const tips = reduced.stdout.trim().split("\n")
    const unproven = tips.find((tip) => !HEX40.test(tip) || !commitRefs.has(tip))
    if (unproven !== undefined) {
      throw new UnknownError(
        `merge-base --independent returned an unproven tip in ${gitDir} (first 120 characters): ${JSON.stringify(unproven.slice(0, 120))}`,
      )
    }
    independent = new Set(tips)
  }
  return durable.filter(
    (entry) => entry.objectType !== "commit" || (independent.has(entry.tip) && commitRefs.get(entry.tip) === entry.ref),
  )
}

async function indexWitnessStores(
  stores: readonly string[],
  removal: readonly string[],
  stream: GitStreamFactory,
  run: GitRun,
  bounds: CustodyBounds,
  clock: () => number,
  sidecarDir: string,
  witnessPolicy?: Readonly<{ targetBranch: string }>,
  deadline?: number,
): Promise<{ records: DurableRefRecord[]; formats: Map<string, string> }> {
  const records: DurableRefRecord[] = []
  const formats = new Map<string, string>()
  for (const store of stores) {
    const gitDir = dirname(store)
    const format = await objectFormat(gitDir, run)
    if (format.status !== "ok") throw new UnknownError(format.detail)
    formats.set(store, format.format)
    if (witnessPolicy !== undefined) {
      const shallow = await run([`--git-dir=${gitDir}`, "rev-parse", "--is-shallow-repository"])
      refuseSuccessfulStderr(shallow, `rev-parse --is-shallow-repository in ${gitDir}`)
      if (shallow.code !== 0 || !["true", "false"].includes(shallow.stdout.trim())) {
        throw new UnknownError(
          `rev-parse --is-shallow-repository failed in ${gitDir}: ${shallow.stderr.trim() || shallow.stdout.trim()}`,
        )
      }
      if (shallow.stdout.trim() === "true") {
        throw new UnknownError(`witness graph in ${gitDir} is shallow and cannot prove complete custody`)
      }
    }
    const closureResult = alternateClosure(store, removal)
    if (closureResult.status !== "ok") throw new UnknownError(closureResult.detail)
    // A hung `fsck` is killed at the declared deadline and reported unknown, never blocking.
    const fsck = await run([`--git-dir=${gitDir}`, "fsck", "--full", "--no-progress"], { timeoutMs: bounds.fsckMs })
    refuseSuccessfulStderr(fsck, `fsck --full in witness store ${gitDir}`)
    if (fsck.code !== 0) {
      throw new UnknownError(`fsck --full failed in witness store ${gitDir}: ${fsck.stderr.trim()}`)
    }
    const refFormat =
      witnessPolicy === undefined ? "%(refname)%09%(objectname)" : "%(refname)%09%(objectname)%09%(objecttype)"
    const refs = await run([`--git-dir=${gitDir}`, "for-each-ref", `--format=${refFormat}`])
    refuseSuccessfulStderr(refs, `for-each-ref in witness store ${gitDir}`)
    if (refs.code !== 0) {
      throw new UnknownError(`for-each-ref failed in witness store ${gitDir}: ${refs.stderr.trim()}`)
    }
    const durable: WitnessRef[] = []
    for (const row of refs.stdout.split("\n")) {
      if (row === "") continue
      const fields = row.split("\t")
      const [ref, tip, objectType] = fields
      if (
        ref === undefined ||
        tip === undefined ||
        !HEX40.test(tip) ||
        (witnessPolicy !== undefined &&
          (fields.length !== 3 || objectType === undefined || !["commit", "tag", "tree", "blob"].includes(objectType)))
      ) {
        throw new UnknownError(`malformed for-each-ref row in witness store ${gitDir}: ${row.slice(0, 120)}`)
      }
      // A transient operation ref, remote-tracking ref or detached HEAD is never a durable
      // witness: only a named branch, tag or GitSuper pin qualifies (contract gate 5).
      if (witnessPolicy === undefined ? !isDurableRef(ref) : !isPolicyRef(ref, tip, witnessPolicy.targetBranch)) {
        continue
      }
      durable.push({ ref, tip, objectType })
    }
    durable.sort((left, right) => (left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0))
    const selected = witnessPolicy === undefined ? durable : await independentPolicyRefs(durable, gitDir, run)
    for (const entry of selected) {
      const started = clock()
      const lineStream = stream([`--git-dir=${gitDir}`, "rev-list", "--objects", entry.tip], {
        timeoutMs: bounds.reachableMs,
        maxLines: bounds.maxReachableOids,
      })
      const sidecar = await externalSortToSidecar(reachableOidLines(lineStream, gitDir, entry.tip, bounds), {
        dir: sidecarDir,
        runLines: DEFAULT_SORT_RUN_LINES,
        deadline,
        clock,
      })
      if (clock() - started > bounds.reachableMs) {
        throw new UnknownError(`rev-list ${entry.tip} in ${gitDir} exceeded the ${bounds.reachableMs} ms bound`)
      }
      if (deadline !== undefined && clock() >= deadline) throw new UnknownError("shared proof deadline is exhausted")
      records.push({ store, ref: entry.ref, tip: entry.tip, format: format.format, sidecar })
    }
  }
  return { records, formats }
}

async function runCustody(
  copyRoot: string,
  components: readonly ComponentContents[],
  witnessStores: readonly string[],
  removal: readonly string[],
  run: GitRun,
  stream: GitStreamFactory,
  bounds: CustodyBounds,
  clock: () => number,
  sidecarDir: string,
  witnessPolicy?: Readonly<{ targetBranch: string }>,
  deadline?: number,
): Promise<CustodyScan> {
  const stores = [...new Set(witnessStores.map((store) => realpathSync(store)))]
    .filter((store) => !removal.some((root) => within(root, store)))
    .sort()
  const badStore = stores.find((store) => !isObjectDir(store))
  if (badStore !== undefined) {
    return {
      status: "unknown",
      detail: `witness store ${badStore} is not a Git object directory`,
      witnesses: [],
      witnessCount: 0,
      missing: [],
      missingCount: 0,
    }
  }
  const remaining = (): number => {
    const left = deadline === undefined ? Number.POSITIVE_INFINITY : deadline - clock()
    if (left <= 0) throw new UnknownError("shared proof deadline is exhausted")
    return left
  }
  const proofRun: GitRun = async (args, runOptions = {}) => {
    const timeoutMs = Math.min(runOptions.timeoutMs ?? Number.POSITIVE_INFINITY, remaining())
    return run(witnessPolicy === undefined ? args : ["--no-replace-objects", ...args], {
      ...runOptions,
      ...(Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
      ...(witnessPolicy === undefined
        ? {}
        : { env: { ...runOptions.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" } }),
    })
  }
  const proofStream: GitStreamFactory = (args, streamOptions = {}) =>
    stream(witnessPolicy === undefined ? args : ["--no-replace-objects", ...args], {
      ...streamOptions,
      timeoutMs: Math.min(streamOptions.timeoutMs ?? Number.POSITIVE_INFINITY, remaining()),
      ...(witnessPolicy === undefined
        ? {}
        : { env: { ...streamOptions.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" } }),
    })
  const { records, formats } = await indexWitnessStores(
    stores,
    removal,
    proofStream,
    proofRun,
    bounds,
    clock,
    sidecarDir,
    witnessPolicy,
    deadline,
  )
  const width = String(Math.max(1, records.length)).length
  const index = await mergeLabeledFiles(
    records.map((record, rank) => ({ path: record.sidecar.path, label: String(rank).padStart(width, "0") })),
    { dir: sidecarDir, deadline, clock },
  )
  const witnessWriter = new SidecarWriter(sidecarDir, "txt")
  const missingWriter = new SidecarWriter(sidecarDir, "txt")
  const identities = new Map<string, WitnessIdentity>()
  const missing: CustodyTarget[] = []
  let witnessCount = 0
  let missingCount = 0
  let merged = 0
  try {
    for (const component of components) {
      remaining()
      const format = await objectFormat(component.gitDir ?? join(copyRoot, component.component), proofRun)
      if (format.status !== "ok") throw new UnknownError(format.detail)
      await mergeSorted(
        [
          { label: "at-risk", lines: readLines(component.atRiskSidecar.path), keyOf: oidKey },
          { label: "witness-index", lines: readLines(index.path), keyOf: oidKey },
        ],
        (key, groups) => {
          if ((merged++ & 1023) === 0) remaining()
          const atRiskLines = groups.find((group) => group.label === "at-risk")?.lines
          if (atRiskLines === undefined || atRiskLines.length === 0) return
          const source = atRiskLines[0]?.split("\t")[2] ?? "owned"
          const indexLines = groups.find((group) => group.label === "witness-index")?.lines
          if (indexLines === undefined || indexLines.length === 0) {
            missingCount += 1
            if (missing.length < MISSING_INLINE) missing.push({ component: component.component, oid: key, source })
            missingWriter.add(`${key}\t${component.component}\t${source}`)
            return
          }
          const rank = indexLines[0]?.split("\t")[1]
          const record = rank === undefined ? undefined : records[Number(rank)]
          if (record === undefined) throw new UnknownError(`witness index names an unknown rank '${rank ?? ""}'`)
          if (formats.get(record.store) !== format.format) {
            throw new UnknownError(
              `witness store ${record.store} object format does not match component ${component.component}`,
            )
          }
          witnessCount += 1
          witnessWriter.add(`${key}\t${component.component}\t${record.store}\t${record.ref}\t${record.tip}`)
          const identityKey = `${record.store}\t${record.ref}\t${record.tip}`
          if (!identities.has(identityKey)) {
            identities.set(identityKey, {
              store: record.store,
              ref: record.ref,
              tip: record.tip,
              graphDigest: record.sidecar.sha256,
            })
          }
        },
        { deadline, clock },
      )
      remaining()
    }
  } catch (error) {
    witnessWriter.abort()
    missingWriter.abort()
    throw error
  }
  let witnessSidecar: SidecarRef | undefined
  if (witnessCount > 0) witnessSidecar = await witnessWriter.finish()
  else witnessWriter.abort()
  let missingSidecar: SidecarRef | undefined
  if (missingCount > 0) missingSidecar = await missingWriter.finish()
  else missingWriter.abort()
  const witnesses = [...identities.values()]
  remaining()
  const first = missing[0]
  if (missingCount > 0 && first !== undefined) {
    return {
      status: "blocked",
      detail: `${missingCount} at-risk OID(s) have no durable witness, e.g. ${first.component} ${first.oid} (${first.source}); first ${missing.length} inline, full list in ${missingSidecar?.path ?? "a sidecar"}`,
      witnesses,
      witnessCount,
      ...(witnessSidecar === undefined ? {} : { witnessSidecar }),
      missing,
      missingCount,
      ...(missingSidecar === undefined ? {} : { missingSidecar }),
    }
  }
  return {
    status: "pass",
    detail: `${witnessCount} at-risk OID(s) each have a named surviving witness across ${stores.length} store(s), ${witnesses.length} distinct identities`,
    witnesses,
    witnessCount,
    ...(witnessSidecar === undefined ? {} : { witnessSidecar }),
    missing: [],
    missingCount: 0,
  }
}

/**
 * Prove surviving custody for every at-risk OID. `witnessStores` are the managed object
 * directories that survive this pass (the caller owns the complete `N` inventory); a store inside
 * `R`, borrowing into `R`, of a different object format, or failing `fsck` never witnesses. Any
 * unreadable, malformed, capped or unwritable step is `unknown` with the observed cause.
 */
export async function scanCustody(
  copyRoot: string,
  components: readonly ComponentContents[],
  witnessStores: readonly string[],
  removal: readonly string[],
  options: CustodyScanOptions,
): Promise<CustodyScan> {
  const run = options.run ?? defaultGitRun
  const stream = options.stream ?? defaultGitStream
  const bounds = options.bounds ?? DEFAULT_CUSTODY_BOUNDS
  const clock = options.clock ?? Date.now
  try {
    return await runCustody(
      copyRoot,
      components,
      witnessStores,
      removal,
      run,
      stream,
      bounds,
      clock,
      options.sidecarDir,
      options.witnessPolicy,
      options.deadline,
    )
  } catch (error) {
    return {
      status: "unknown",
      detail: error instanceof Error ? error.message : String(error),
      witnesses: [],
      witnessCount: 0,
      missing: [],
      missingCount: 0,
    }
  }
}
