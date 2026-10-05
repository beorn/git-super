/**
 * Gate 5 of the #27443(b) retirement proof: positive surviving custody for every at-risk OID.
 *
 * For each at-risk OID of every component, a durable witness must exist: a NAMED persistent
 * survivor ref in a store of the same object format whose reachable closure includes the OID,
 * whose alternate path closure is disjoint from the removal set `R`, and whose `fsck --full`
 * succeeds (cached once per pass). An existing alternate target, `cat-file -e`, a transient
 * reflog, or a bead is never a witness. Read-only: git queries and file reads only.
 */
import { createHash } from "node:crypto"
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, relative, sep } from "node:path"
import { alternateEntries } from "./alternates.ts"
import { defaultGitRun, type ComponentContents, type GitRun, type GitRunResult } from "./retention-contents.ts"

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

export interface Witness {
  readonly component: string
  readonly oid: string
  readonly store: string
  readonly ref: string
  readonly tip: string
  readonly objectType: string
  readonly graphDigest: string
}

export interface CustodyScan {
  readonly status: "pass" | "blocked" | "unknown"
  readonly detail: string
  readonly witnesses: readonly Witness[]
  readonly missing: readonly CustodyTarget[]
}

const HEX40 = /^[0-9a-f]{40}$/u
/** The only durable witness namespaces the contract admits: branches, tags and GitSuper pins. */
const DURABLE_REF = /^refs\/(?:heads|tags)\//u
const PIN_REF = /^refs\/git-super\/pins\//u

function isDurableRef(ref: string): boolean {
  return DURABLE_REF.test(ref) || PIN_REF.test(ref)
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
    const store = stack.pop()!
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

function objectFormat(
  gitDir: string,
  run: GitRun,
): { status: "ok"; format: string } | { status: "unknown"; detail: string } {
  const result = run([`--git-dir=${gitDir}`, "rev-parse", "--show-object-format"])
  if (result.code !== 0) {
    return { status: "unknown", detail: `rev-parse --show-object-format failed in ${gitDir}: ${result.stderr.trim()}` }
  }
  const format = result.stdout.trim()
  if (format !== "sha1" && format !== "sha256") {
    return { status: "unknown", detail: `${gitDir} reports unsupported object format '${format}'` }
  }
  return { status: "ok", format }
}

type StoreIndex =
  | {
      status: "ok"
      format: string
      byOid: Map<string, Readonly<{ ref: string; tip: string; digest: string }>>
    }
  | { status: "unknown"; detail: string }

function indexStore(
  store: string,
  removal: readonly string[],
  run: GitRun,
  bounds: CustodyBounds,
  clock: () => number,
): StoreIndex {
  const gitDir = dirname(store)
  const format = objectFormat(gitDir, run)
  if (format.status !== "ok") return format
  const closure = alternateClosure(store, removal)
  if (closure.status !== "ok") return closure
  const started = clock()
  const fsck: GitRunResult = run([`--git-dir=${gitDir}`, "fsck", "--full", "--no-progress"])
  if (fsck.code !== 0) {
    return { status: "unknown", detail: `fsck --full failed in witness store ${gitDir}: ${fsck.stderr.trim()}` }
  }
  if (clock() - started > bounds.fsckMs) {
    return { status: "unknown", detail: `fsck in ${gitDir} exceeded the ${bounds.fsckMs} ms bound` }
  }
  const refs = run([`--git-dir=${gitDir}`, "for-each-ref", "--format=%(refname)%09%(objectname)"])
  if (refs.code !== 0) {
    return { status: "unknown", detail: `for-each-ref failed in witness store ${gitDir}: ${refs.stderr.trim()}` }
  }
  const byOid = new Map<string, Readonly<{ ref: string; tip: string; digest: string }>>()
  let reachable = 0
  for (const line of refs.stdout.split("\n")) {
    if (line === "") continue
    const [ref, tip] = line.split("\t")
    if (ref === undefined || tip === undefined || !HEX40.test(tip)) {
      return {
        status: "unknown",
        detail: `malformed for-each-ref row in witness store ${gitDir}: ${line.slice(0, 120)}`,
      }
    }
    // A transient operation ref, remote-tracking ref or detached HEAD is never a durable witness:
    // only a named branch, tag or GitSuper pin qualifies (contract gate 5).
    if (!isDurableRef(ref)) continue
    const refStart = clock()
    const graph = run([`--git-dir=${gitDir}`, "rev-list", "--objects", tip])
    if (graph.code !== 0) {
      return { status: "unknown", detail: `rev-list ${tip} failed in witness store ${gitDir}: ${graph.stderr.trim()}` }
    }
    if (clock() - refStart > bounds.reachableMs) {
      return { status: "unknown", detail: `rev-list ${tip} in ${gitDir} exceeded the ${bounds.reachableMs} ms bound` }
    }
    const oids: string[] = []
    for (const row of graph.stdout.split("\n")) {
      if (row === "") continue
      const oid = row.split(" ")[0]!
      if (!HEX40.test(oid)) {
        return { status: "unknown", detail: `malformed rev-list row in ${gitDir}: ${row.slice(0, 120)}` }
      }
      oids.push(oid)
      reachable += 1
      if (reachable > bounds.maxReachableOids) {
        return { status: "unknown", detail: `reachable OIDs exceeded the ${bounds.maxReachableOids} cap in ${gitDir}` }
      }
    }
    const digest = createHash("sha256")
      .update([...oids].sort().join("\n"))
      .digest("hex")
    for (const oid of oids) {
      if (!byOid.has(oid)) byOid.set(oid, { ref, tip, digest })
    }
  }
  return { status: "ok", format: format.format, byOid }
}

/**
 * Prove surviving custody for every at-risk OID. `witnessStores` are the managed object
 * directories that survive this pass (the caller owns the complete `N` inventory); a store
 * inside `R`, borrowing into `R`, of a different object format, or failing `fsck` never witnesses.
 */
export function scanCustody(
  copyRoot: string,
  components: readonly ComponentContents[],
  witnessStores: readonly string[],
  removal: readonly string[],
  run: GitRun = defaultGitRun,
  bounds: CustodyBounds = DEFAULT_CUSTODY_BOUNDS,
  clock: () => number = Date.now,
): CustodyScan {
  const stores = [...new Set(witnessStores.map((store) => realpathSync(store)))]
    .filter((store) => !removal.some((root) => within(root, store)))
    .sort()
  const badStore = stores.find((store) => !isObjectDir(store))
  if (badStore !== undefined) {
    return {
      status: "unknown",
      detail: `witness store ${badStore} is not a Git object directory`,
      witnesses: [],
      missing: [],
    }
  }
  const index = new Map<string, StoreIndex>()
  for (const store of stores) {
    const entry = indexStore(store, removal, run, bounds, clock)
    index.set(store, entry)
    if (entry.status !== "ok") return { status: "unknown", detail: entry.detail, witnesses: [], missing: [] }
  }
  // The contract records the witnessed OID's OWN type, not the ref tip's type: a blob reached from
  // a commit ref is a blob witness. Resolve lazily, once per (store, oid), through Git itself.
  const typeCache = new Map<string, Map<string, string>>()
  const resolveObjectType = (
    store: string,
    oid: string,
  ): { status: "ok"; type: string } | { status: "unknown"; detail: string } => {
    const gitDir = dirname(store)
    let cache = typeCache.get(store)
    if (cache === undefined) {
      cache = new Map()
      typeCache.set(store, cache)
    }
    const cached = cache.get(oid)
    if (cached !== undefined) return { status: "ok", type: cached }
    const result = run([`--git-dir=${gitDir}`, "cat-file", "-t", oid])
    if (result.code !== 0) {
      return {
        status: "unknown",
        detail: `cat-file -t ${oid} failed in witness store ${gitDir}: ${result.stderr.trim()}`,
      }
    }
    const type = result.stdout.trim()
    if (type !== "commit" && type !== "tree" && type !== "blob" && type !== "tag") {
      return {
        status: "unknown",
        detail: `witness store ${gitDir} reports unsupported object type '${type}' for ${oid}`,
      }
    }
    cache.set(oid, type)
    return { status: "ok", type }
  }
  const witnesses: Witness[] = []
  const missing: CustodyTarget[] = []
  for (const component of components) {
    const format = objectFormat(join(copyRoot, component.component), run)
    if (format.status !== "ok") return { status: "unknown", detail: format.detail, witnesses: [], missing: [] }
    for (const oid of component.atRiskOids) {
      let found: Witness | undefined
      for (const store of stores) {
        const entry = index.get(store)!
        if (entry.status !== "ok" || entry.format !== format.format) continue
        const hit = entry.byOid.get(oid)
        if (hit === undefined) continue
        const objectType = resolveObjectType(store, oid)
        if (objectType.status !== "ok") {
          return { status: "unknown", detail: objectType.detail, witnesses: [], missing: [] }
        }
        found = {
          component: component.component,
          oid,
          store,
          ref: hit.ref,
          tip: hit.tip,
          objectType: objectType.type,
          graphDigest: hit.digest,
        }
        break
      }
      if (found === undefined) {
        missing.push({ component: component.component, oid, source: component.atRiskSources[oid] ?? "owned" })
      } else {
        witnesses.push(found)
      }
    }
  }
  if (missing.length > 0) {
    const first = missing[0]!
    return {
      status: "blocked",
      detail: `${missing.length} at-risk OID(s) have no durable witness, e.g. ${first.component} ${first.oid} (${first.source})`,
      witnesses,
      missing,
    }
  }
  return {
    status: "pass",
    detail: `${witnesses.length} at-risk OID(s) each have a named surviving witness across ${stores.length} store(s)`,
    witnesses,
    missing,
  }
}
