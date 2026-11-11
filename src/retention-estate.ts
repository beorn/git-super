/**
 * Gate 3 of the #27443(b) retirement proof: ONE read-only inverted alternate/objects-link index
 * for a whole pass, built from the declared managed namespace `N` and the removal set `R`.
 *
 * It reads declarations and reverse links; it never writes, prunes, gc's or "repairs" one. An
 * unreadable registry, a missing or redirected alternate target, an incomplete scan or a bound
 * hit is `unknown`, never a silent skip. A survivor (outside `R`) that borrows into an object
 * directory under `R` is `blocked`.
 *
 * A DANGLING alternates line (its resolved path does not exist) is excluded BY NAME and the pass continues (#33010,
 * @cto e497078d): a path that does not exist cannot be a loan from any store that does, so excluding it loses no
 * lender fact, and it must not end the inventory for every other entry. Exclusion is per line: the same file's
 * resolvable lines still count. Any other unreadable or non-directory target still ends the pass as `unknown`.
 */
import { createHash } from "node:crypto"
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { alternateEntries } from "./alternates.ts"

export interface EstateScanBounds {
  /** 60,000 in the contract's initial pass. */
  readonly maxAlternatesFiles: number
  /** 180 s in the contract's initial pass. */
  readonly scanMs: number
}

export const DEFAULT_ESTATE_BOUNDS: EstateScanBounds = { maxAlternatesFiles: 60_000, scanMs: 180_000 }

/**
 * The raised bounds for the ONE scan a retirement batch reuses (#33010, @cto dc77f630 condition 5); an ordinary
 * verify keeps {@link DEFAULT_ESTATE_BOUNDS}. Measured 2026-11-10 on the live estate: 149,443 alternates files, 469-496 s.
 */
export const BATCH_ESTATE_BOUNDS: EstateScanBounds = { maxAlternatesFiles: 300_000, scanMs: 900_000 }

/**
 * What one scan saw, so a lease-held {@link estateDelta} can prove the estate's SET unchanged without a second walk
 * (#33010, @cto dc77f630 condition 1). Stamps carry the inode and the change time, never the modification time
 * alone, which any writer can set back.
 */
export interface EstateWalkRecord {
  /** Every directory the walk read, by path: `ino:mtimeMs:ctimeMs`, taken before it was read. */
  readonly dirs: Map<string, string>
  /** Every reached object directory's `info/alternates`, by path: `ino:size:ctimeMs`, or `absent`. */
  readonly alternates: Map<string, string>
  /** Every `objects` symlink the walk met, by path: its resolved target. */
  readonly objectLinks: Map<string, string>
  /** Every borrower registry directory, by path: a digest of its record names and bytes. */
  readonly registries: Map<string, string>
}

export function newEstateWalkRecord(): EstateWalkRecord {
  return { dirs: new Map(), alternates: new Map(), objectLinks: new Map(), registries: new Map() }
}

function dirStamp(path: string): string {
  const stat = lstatSync(path)
  return `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}`
}

function fileStamp(path: string): string {
  const link = lstatSync(path, { throwIfNoEntry: false })
  if (link === undefined) return "absent"
  const stat = link.isSymbolicLink() ? statSync(path) : link
  return `${link.dev}:${link.ino}:${link.size}:${link.ctimeMs}/${stat.dev}:${stat.ino}:${stat.size}:${stat.ctimeMs}`
}

function registryDigest(dir: string): string {
  const hash = createHash("sha256")
  for (const name of readdirSync(dir)
    .filter((entry) => entry.endsWith(".json"))
    .sort()) {
    hash
      .update(`${name}\0`)
      .update(readFileSync(join(dir, name)))
      .update("\0")
  }
  return hash.digest("hex")
}

export interface EstateBorrower {
  /** The object directory that declares the alternate (the borrower). */
  readonly borrower: string
  /** The object directory the alternate names (the lender). */
  readonly target: string
}

function compareEstateEdges(left: EstateBorrower, right: EstateBorrower): number {
  if (left.borrower !== right.borrower) return left.borrower < right.borrower ? -1 : 1
  return left.target < right.target ? -1 : left.target > right.target ? 1 : 0
}

/** One excluded alternates line: the store declaring it lost the objects that line named. */
export interface DanglingAlternate {
  /** The object directory whose `info/alternates` holds the line. */
  readonly store: string
  readonly alternatesFile: string
  /** The line as written (trimmed). */
  readonly line: string
  /** The line resolved the way git does, relative lines against `store`. */
  readonly target: string
}

export interface EstateScan {
  readonly status: "pass" | "blocked" | "unknown"
  readonly detail: string
  readonly roots: readonly string[]
  readonly objectDirs: readonly string[]
  readonly alternatesFiles: number
  readonly borrowers: readonly EstateBorrower[]
  readonly registries: readonly string[]
  /** Survivors outside R that borrow into an object directory inside R. */
  readonly survivorIntoRemoval: readonly EstateBorrower[]
  /** Alternates lines naming a path that does not exist, excluded by name (#33010). */
  readonly danglingAlternates: readonly DanglingAlternate[]
}

/** Complete estate identity: only the named top-level sets are unordered; no fields or duplicates are omitted. */
export function canonicalEstateScan(scan: object): string {
  const sets = new Set(["roots", "objectDirs", "registries", "borrowers", "survivorIntoRemoval", "danglingAlternates"])
  const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)
  const edgePart = (value: unknown, field: string): string => {
    if (value !== null && typeof value === "object") {
      const part: unknown = Reflect.get(value, field)
      if (typeof part === "string") return part
    }
    return JSON.stringify(value)
  }
  const stable = (value: unknown, depth: number, key: string): unknown => {
    if (Array.isArray(value)) {
      const items = value.map((item) => stable(item, depth + 1, ""))
      if (depth !== 1 || !sets.has(key)) return items
      return items.sort((left, right) => {
        if (key === "borrowers" || key === "survivorIntoRemoval") {
          const pair = compareEstateEdges(
            { borrower: edgePart(left, "borrower"), target: edgePart(left, "target") },
            { borrower: edgePart(right, "borrower"), target: edgePart(right, "target") },
          )
          if (pair !== 0) return pair
        }
        return compare(
          typeof left === "string" ? left : JSON.stringify(left),
          typeof right === "string" ? right : JSON.stringify(right),
        )
      })
    }
    if (value === null || typeof value !== "object") return value
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compare(left, right))
        .map(([field, item]) => [field, stable(item, depth + 1, field)]),
    )
  }
  return JSON.stringify(stable(scan, 0, ""))
}

function within(parent: string, path: string): boolean {
  const part = relative(parent, path)
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part))
}

function canonical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/** A directory is an object store when it is named `objects` and carries pack/info (or is a symlink to one). */
function isObjectDir(path: string): boolean {
  if (!existsSync(path)) return false
  const stat = statSync(path)
  if (!stat.isDirectory()) return false
  return existsSync(join(path, "pack")) || existsSync(join(path, "info"))
}

export function scanEstate(
  namespace: readonly string[],
  removal: readonly string[],
  bounds: EstateScanBounds = DEFAULT_ESTATE_BOUNDS,
  clock: () => number = Date.now,
  record?: EstateWalkRecord,
): EstateScan {
  const started = clock()
  const roots: string[] = []
  for (const root of namespace) {
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      return {
        status: "unknown",
        detail: `managed namespace root ${root} is absent or not a directory; the inventory cannot be proven complete`,
        roots,
        objectDirs: [],
        alternatesFiles: 0,
        borrowers: [],
        registries: [],
        survivorIntoRemoval: [],
        danglingAlternates: [],
      }
    }
    roots.push(canonical(root))
  }
  const removalRoots = removal.map(canonical)
  const objectDirs = new Set<string>()
  const registryDirs = new Set<string>()
  const borrowers: EstateBorrower[] = []
  const danglingAlternates: DanglingAlternate[] = []
  let alternatesFiles = 0
  let vanishedDuringWalk = 0

  const unknown = (detail: string): EstateScan => ({
    status: "unknown",
    detail,
    roots,
    objectDirs: [...objectDirs].sort(),
    alternatesFiles,
    borrowers,
    registries: [...registryDirs].sort(),
    survivorIntoRemoval: [],
    danglingAlternates,
  })

  // One worklist of object directories, seeded from the filesystem walk AND from every alternate /
  // objects-link target reached. Scanning a reached target is what makes the inventory the closed
  // transitive set the contract requires; it reads only `info/alternates`, never a pack store walk.
  const processedStores = new Set<string>()
  const processStore = (store: string): EstateScan | undefined => {
    if (processedStores.has(store)) return undefined
    processedStores.add(store)
    objectDirs.add(store)
    const alternatesFile = join(store, "info", "alternates")
    // Stamped before the read, so a write racing the read shows as a change at the delta.
    try {
      record?.alternates.set(alternatesFile, fileStamp(alternatesFile))
    } catch (error) {
      return unknown(
        `cannot read alternates metadata ${alternatesFile}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (!existsSync(alternatesFile)) return undefined
    alternatesFiles += 1
    if (alternatesFiles > bounds.maxAlternatesFiles) {
      return unknown(
        `estate declaration scan hit the alternates-file bound (${alternatesFiles} recorded, cap ${bounds.maxAlternatesFiles})`,
      )
    }
    let content: string
    try {
      content = readFileSync(alternatesFile, "utf8")
    } catch (error) {
      return unknown(`cannot read ${alternatesFile}: ${error instanceof Error ? error.message : String(error)}`)
    }
    const declared: { line: string; target: string }[] = []
    alternateEntries(content, store, true, (entry, rawLine) => declared.push({ line: rawLine.trim(), target: entry }))
    for (const { line, target } of declared) {
      let isDirectory: boolean
      try {
        isDirectory = statSync(target).isDirectory()
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === "ENOENT" || code === "ENOTDIR") {
          danglingAlternates.push({ store: canonical(store), alternatesFile, line, target })
          continue
        }
        return unknown(
          `cannot read alternate ${target} named by ${alternatesFile}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      if (!isDirectory) return unknown(`${alternatesFile} names a non-directory alternate ${target}`)
      const actual = canonical(target)
      borrowers.push({ borrower: canonical(store), target: actual })
      const nested = processStore(actual)
      if (nested !== undefined) return nested
    }
    return undefined
  }

  // Read every borrower-registry record; an unreadable, malformed or stale proof is `unknown`. The
  // record names a survivor retained borrower of the holder's stores, so it is recorded as a reverse
  // link and a survivor-into-R is blocked without invoking the mutating lender guard.
  const readRegistry = (dir: string): EstateScan | undefined => {
    registryDirs.add(dir)
    let names: string[]
    try {
      record?.registries.set(dir, registryDigest(dir))
      names = readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .sort()
    } catch (error) {
      return unknown(`cannot read borrower registry ${dir}: ${error instanceof Error ? error.message : String(error)}`)
    }
    const holder = canonical(dirname(dir))
    for (const name of names) {
      const file = join(dir, name)
      let bytes: string
      try {
        bytes = readFileSync(file, "utf8")
      } catch (error) {
        return unknown(
          `cannot read borrower registry record ${file}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      let record: unknown
      try {
        record = JSON.parse(bytes)
      } catch (error) {
        return unknown(
          `borrower registry record ${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      if (record === null || typeof record !== "object" || Array.isArray(record)) {
        return unknown(`borrower registry record ${file} is not a JSON object`)
      }
      const row = record as Record<string, unknown>
      if (
        typeof row.retained !== "string" ||
        row.retained.trim() === "" ||
        typeof row.manifest !== "string" ||
        row.manifest.trim() === ""
      ) {
        return unknown(`borrower registry record ${file} lacks a retained path and a manifest path`)
      }
      // Reconcile the record with the manifest it names: a stale or unreadable proof is unknown.
      let manifestBytes: string
      try {
        manifestBytes = readFileSync(row.manifest as string, "utf8")
      } catch (error) {
        return unknown(
          `borrower registry record ${file} names an unreadable manifest ${row.manifest}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      try {
        JSON.parse(manifestBytes)
      } catch {
        return unknown(`borrower registry record ${file} names a manifest that is not valid JSON: ${row.manifest}`)
      }
      borrowers.push({ borrower: canonical(row.retained as string), target: holder })
    }
    return undefined
  }

  const visited = new Set<string>()
  const stack = [...roots]
  while (stack.length > 0) {
    if (clock() - started > bounds.scanMs) {
      return unknown(`estate declaration scan exceeded ${bounds.scanMs} ms after ${alternatesFiles} alternates file(s)`)
    }
    const current = stack.pop()!
    if (visited.has(current)) continue
    visited.add(current)
    let entries
    try {
      record?.dirs.set(current, dirStamp(current))
      entries = readdirSync(current, { withFileTypes: true })
    } catch (error) {
      // A recorded walk (a retirement batch) tolerates a directory that vanished after its parent listed it: it lends
      // nothing now, and if it was moved into a directory already read, that directory's stamp moved, so the
      // lease-held estateDelta re-reads it and finds the store (#33010). An unrecorded walk has no such check.
      if (record !== undefined && (error as NodeJS.ErrnoException).code === "ENOENT" && !roots.includes(current)) {
        record.dirs.delete(current)
        vanishedDuringWalk += 1
        continue
      }
      return unknown(`cannot read ${current}: ${error instanceof Error ? error.message : String(error)}`)
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isSymbolicLink()) {
        if (entry.name !== "objects") {
          if (entry.isDirectory()) stack.push(path)
          continue
        }
        let target: string
        try {
          target = realpathSync(path)
          if (!statSync(target).isDirectory()) throw new Error("target is not a directory")
        } catch (error) {
          return unknown(
            `objects link ${path} has an unavailable or redirected target: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
        record?.objectLinks.set(path, target)
        borrowers.push({ borrower: path, target })
        const nested = processStore(target)
        if (nested !== undefined) return nested
        continue
      }
      if (!entry.isDirectory()) continue
      if (entry.name === "objects" && isObjectDir(path)) {
        const nested = processStore(path)
        if (nested !== undefined) return nested
        continue
      }
      if (entry.name === "git-super-retained-borrowers") {
        const registry = readRegistry(path)
        if (registry !== undefined) return registry
        continue
      }
      stack.push(path)
    }
  }
  const survivorIntoRemoval = borrowers.filter(
    (edge) =>
      removalRoots.some((root) => within(root, edge.target)) &&
      !removalRoots.some((root) => within(root, edge.borrower)),
  )
  // The example must not make otherwise identical complete censuses depend on filesystem walk order.
  const firstSurvivor = survivorIntoRemoval.reduce<EstateBorrower | undefined>(
    (first, edge) => (first === undefined || compareEstateEdges(edge, first) < 0 ? edge : first),
    undefined,
  )
  return {
    status: survivorIntoRemoval.length === 0 ? "pass" : "blocked",
    detail:
      (firstSurvivor === undefined
        ? `${objectDirs.size} object dir(s), ${alternatesFiles} alternates file(s), ${borrowers.length} reverse link(s)`
        : `${survivorIntoRemoval.length} survivor borrower(s) into the removal set, e.g. ${firstSurvivor.borrower} -> ${firstSurvivor.target}`) +
      (danglingAlternates.length === 0 ? "" : `; ${danglingAlternates.length} dangling alternates line(s) excluded`) +
      (vanishedDuringWalk === 0 ? "" : `; ${vanishedDuringWalk} director(ies) vanished during the walk`),
    roots,
    objectDirs: [...objectDirs].sort(),
    alternatesFiles,
    borrowers,
    registries: [...registryDirs].sort(),
    survivorIntoRemoval,
    danglingAlternates,
  }
}

export type EstateDelta =
  | Readonly<{ status: "unchanged"; changedDirs: number }>
  | Readonly<{ status: "changed"; detail: string }>

/** The first object directory, `objects` link or borrower registry under a directory the scan never read. */
function storeUnder(root: string): string | undefined {
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop() as string
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isSymbolicLink()) {
        if (entry.name === "objects") return `objects link ${path}`
        continue
      }
      if (!entry.isDirectory()) continue
      if (entry.name === "objects" && isObjectDir(path)) return `object directory ${path}`
      if (entry.name === "git-super-retained-borrowers") return `borrower registry ${path}`
      stack.push(path)
    }
  }
  return undefined
}

/**
 * The lease-held check a retirement batch runs before it deletes anything (#33010, @cto dc77f630 conditions 1 and 3):
 * is the estate's SET of object directories, alternates files, `objects` links and borrower registries still what
 * `scan` (recorded into `record`) saw? Writers that never take the lease exist — a hand-run clone or `git worktree
 * add` writes an alternates file with no lease — so this comparison, not the lease, is what catches them between the
 * scan and the delete. It re-stats every directory the scan read and re-reads only the ones whose stamp moved: a
 * changed directory that only gained files is unchanged for the estate; one that gained a store, a link or a
 * registry, at any depth, is a change. Any read failure is a change: the batch then deletes nothing.
 */
export function estateDelta(record: EstateWalkRecord, scan: EstateScan): EstateDelta {
  const changed = (detail: string): EstateDelta => ({ status: "changed", detail })
  try {
    for (const [file, stamp] of record.alternates) {
      const now = fileStamp(file)
      if (now !== stamp) return changed(`alternates file ${file} changed since the scan (${stamp} -> ${now})`)
    }
    const known = new Set(scan.objectDirs)
    for (const dir of scan.objectDirs) {
      // Scan object directories are walked plain directories or canonical alternate targets, never links.
      if (lstatSync(dir, { throwIfNoEntry: false })?.isDirectory() !== true) {
        return changed(`object directory ${dir} vanished or is no longer a directory since the scan`)
      }
    }
    for (const [link, target] of record.objectLinks) {
      const now = existsSync(link) ? realpathSync(link) : "absent"
      if (now !== target) return changed(`objects link ${link} now resolves to ${now}, not ${target}`)
    }
    for (const [dir, digest] of record.registries) {
      if (registryDigest(dir) !== digest) return changed(`borrower registry ${dir} changed since the scan`)
    }
    let changedDirs = 0
    for (const [dir, stamp] of record.dirs) {
      const now = lstatSync(dir, { throwIfNoEntry: false })
      // A vanished directory removed nothing the estate counts unless a store or registry under it went too, and
      // those were checked by path above.
      if (now === undefined || `${now.ino}:${now.mtimeMs}:${now.ctimeMs}` === stamp) continue
      changedDirs += 1
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isSymbolicLink()) {
          if (entry.name === "objects" && !record.objectLinks.has(path)) return changed(`new objects link ${path}`)
          continue
        }
        if (!entry.isDirectory() || record.dirs.has(path)) continue
        if (entry.name === "objects" && isObjectDir(path)) {
          if (!known.has(path)) return changed(`new object directory ${path}`)
          continue
        }
        if (entry.name === "git-super-retained-borrowers") {
          if (!record.registries.has(path)) return changed(`new borrower registry ${path}`)
          continue
        }
        const found = storeUnder(path)
        if (found !== undefined) return changed(`new ${found} under ${dir}`)
      }
    }
    return { status: "unchanged", changedDirs }
  } catch (error) {
    return changed(`estate delta could not be read: ${error instanceof Error ? error.message : String(error)}`)
  }
}
