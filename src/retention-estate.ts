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
import {
  lstat as lstatAsync,
  readdir,
  readFile as readFileAsync,
  realpath as realpathAsync,
  stat as statAsync,
} from "node:fs/promises"
import { cpus } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { alternateEntries } from "./alternates.ts"

export interface EstateScanBounds {
  /** 60,000 in the contract's initial pass. */
  readonly maxAlternatesFiles: number
  /** 180 s in the contract's initial pass. */
  readonly scanMs: number
  /**
   * How many directories the walk reads at once; the production default is `min(16, cpus)`.
   * A test that depends on the order directories are read pins this to 1, which is the serial
   * walk the scan used before #34270 — the node set is identical either way.
   */
  readonly workers?: number
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
  /**
   * Every directory the walk read, by path: `ino:mtimeMs:ctimeMs`, taken before it was read. The lease window no
   * longer re-stats this set (#33010: 10,132,305 directories cost 560 s), but it is still the walk's own proof that
   * a bounded pool visited exactly the nodes a serial walk does.
   */
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

// The walk's own copy of those three stamps, and of the canonical/object-dir reads, in async form. A `*Sync` call made
// from inside an async worker blocks the one thread every worker shares, so the pool still ran at about two cores: the
// first concurrent version scanned the whole estate in 346 s that way, against a 180 s target (#34272). `estateDelta`
// keeps the sync forms above — it runs after the scan, on the apply path, and is not what a dry-run waits for.
async function dirStampAsync(path: string): Promise<string> {
  const stamp = await lstatAsync(path)
  return `${stamp.ino}:${stamp.mtimeMs}:${stamp.ctimeMs}`
}

async function fileStampAsync(path: string): Promise<string> {
  // ENOENT is handled here, in words, rather than left to `throwIfNoEntry` on the promises API (@cto 7a5c26cd B3): the
  // package also supports a Node whose promises option I have not verified, and "absent" must not rest on a quirk.
  let link
  try {
    link = await lstatAsync(path)
  } catch (error) {
    if (absent(error)) return "absent"
    throw error
  }
  // A symlink whose target is gone is NOT an absence (@cto R1): the alternates file is declared through a link that
  // leads nowhere, so the read failure must reach `processStore`'s `unknown`. The sync `fileStamp` used by the delta
  // throws on the same link; the two must agree, and answering "absent" here would hide it from both.
  const stamp = link.isSymbolicLink() ? await statAsync(path) : link
  return `${link.dev}:${link.ino}:${link.size}:${link.ctimeMs}/${stamp.dev}:${stamp.ino}:${stamp.size}:${stamp.ctimeMs}`
}

/** A path that is not there: absent, or a parent that is not a directory. Any other error is a read failure. */
function absent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === "ENOENT" || code === "ENOTDIR"
}

async function registryDigestAsync(dir: string): Promise<string> {
  const hash = createHash("sha256")
  for (const name of (await readdir(dir)).filter((entry) => entry.endsWith(".json")).sort()) {
    hash
      .update(`${name}\0`)
      .update(await readFileAsync(join(dir, name)))
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

async function canonicalAsync(path: string): Promise<string> {
  try {
    return await realpathAsync(path)
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

/** The walk's async form of {@link isObjectDir}: same answer, and no thread-blocking call inside a pool worker. */
async function isObjectDirAsync(path: string): Promise<boolean> {
  let store
  try {
    store = await statAsync(path)
  } catch (error) {
    if (absent(error)) return false
    throw error
  }
  if (!store.isDirectory()) return false
  const parts = await Promise.all(
    ["pack", "info"].map(async (name) => {
      try {
        return await statAsync(join(path, name))
      } catch (error) {
        if (absent(error)) return undefined
        throw error
      }
    }),
  )
  return parts.some((part) => part !== undefined)
}

export async function scanEstate(
  namespace: readonly string[],
  removal: readonly string[],
  bounds: EstateScanBounds = DEFAULT_ESTATE_BOUNDS,
  clock: () => number = Date.now,
  record?: EstateWalkRecord,
): Promise<EstateScan> {
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
  const processStore = async (store: string): Promise<EstateScan | undefined> => {
    if (processedStores.has(store)) return undefined
    processedStores.add(store)
    objectDirs.add(store)
    const alternatesFile = join(store, "info", "alternates")
    // Stamped before the read, so a write racing the read shows as a change at the delta.
    try {
      const stamp = await fileStampAsync(alternatesFile)
      if (record !== undefined) record.alternates.set(alternatesFile, stamp)
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
      content = await readFileAsync(alternatesFile, "utf8")
    } catch (error) {
      return unknown(`cannot read ${alternatesFile}: ${error instanceof Error ? error.message : String(error)}`)
    }
    const declared: { line: string; target: string }[] = []
    alternateEntries(content, store, true, (entry, rawLine) => declared.push({ line: rawLine.trim(), target: entry }))
    for (const { line, target } of declared) {
      let isDirectory: boolean
      try {
        isDirectory = (await statAsync(target)).isDirectory()
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
      const actual = await canonicalAsync(target)
      borrowers.push({ borrower: await canonicalAsync(store), target: actual })
      const nested = await processStore(actual)
      if (nested !== undefined) return nested
    }
    return undefined
  }

  // Read every borrower-registry record; an unreadable, malformed or stale proof is `unknown`. The
  // record names a survivor retained borrower of the holder's stores, so it is recorded as a reverse
  // link and a survivor-into-R is blocked without invoking the mutating lender guard.
  const readRegistry = async (dir: string): Promise<EstateScan | undefined> => {
    registryDirs.add(dir)
    let names: string[]
    try {
      const digest = await registryDigestAsync(dir)
      if (record !== undefined) record.registries.set(dir, digest)
      names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort()
    } catch (error) {
      return unknown(`cannot read borrower registry ${dir}: ${error instanceof Error ? error.message : String(error)}`)
    }
    const holder = await canonicalAsync(dirname(dir))
    for (const name of names) {
      const file = join(dir, name)
      let bytes: string
      try {
        bytes = await readFileAsync(file, "utf8")
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
        manifestBytes = await readFileAsync(row.manifest as string, "utf8")
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
      borrowers.push({ borrower: await canonicalAsync(row.retained as string), target: holder })
    }
    return undefined
  }

  // The walk is I/O bound and the estate is millions of directories (#34270: a 240 s capped one-thread walk still had
  // 1,286 directories left, and the completed scan records 10,409,624 of them under `/hh` + `/home/hh` at ~10.4 k
  // readdir/s, so the serial floor alone is many minutes before a single alternates file opens).
  // A bounded pool visits the SAME nodes: same roots, same push rule, same store/registry handling, same `unknown`
  // policy, same record — only the overlap changes. Every collected set is sorted below, so the bytes this produces do
  // not depend on scheduling.
  const visited = new Set<string>()
  const pending: string[] = [...roots]
  let inFlight = 0
  let walkFailure: EstateScan | undefined

  const visit = async (current: string): Promise<void> => {
    let entries
    try {
      const stamp = await dirStampAsync(current)
      if (record !== undefined) record.dirs.set(current, stamp)
      entries = await readdir(current, { withFileTypes: true })
    } catch (error) {
      // A recorded walk (a retirement batch) tolerates a directory that vanished after its parent listed it: it lends
      // nothing now, and if it was moved into a directory already read, that directory's stamp moved, so the
      // lease-held estateDelta re-reads it and finds the store (#33010). An unrecorded walk has no such check.
      if (record !== undefined && (error as NodeJS.ErrnoException).code === "ENOENT" && !roots.includes(current)) {
        record.dirs.delete(current)
        vanishedDuringWalk += 1
        return
      }
      walkFailure ??= unknown(`cannot read ${current}: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isSymbolicLink()) {
        if (entry.name !== "objects") {
          if (entry.isDirectory()) pending.push(path)
          continue
        }
        let target: string
        try {
          target = await realpathAsync(path)
          if (!(await statAsync(target)).isDirectory()) throw new Error("target is not a directory")
        } catch (error) {
          walkFailure ??= unknown(
            `objects link ${path} has an unavailable or redirected target: ${error instanceof Error ? error.message : String(error)}`,
          )
          return
        }
        record?.objectLinks.set(path, target)
        borrowers.push({ borrower: path, target })
        const nested = await processStore(target)
        if (nested !== undefined) {
          walkFailure ??= nested
          return
        }
        continue
      }
      if (!entry.isDirectory()) continue
      if (entry.name === "objects" && (await isObjectDirAsync(path))) {
        const nested = await processStore(path)
        if (nested !== undefined) {
          walkFailure ??= nested
          return
        }
        continue
      }
      if (entry.name === "git-super-retained-borrowers") {
        const registry = await readRegistry(path)
        if (registry !== undefined) {
          walkFailure ??= registry
          return
        }
        continue
      }
      pending.push(path)
    }
  }

  // One worker retires only when the queue is empty AND nothing is in flight: a directory another worker is still
  // reading can push more work, so an early exit would silently scan part of the estate.
  const walker = async (): Promise<void> => {
    for (;;) {
      if (walkFailure !== undefined) return
      if (clock() - started > bounds.scanMs) {
        walkFailure ??= unknown(
          `estate declaration scan exceeded ${bounds.scanMs} ms after ${alternatesFiles} alternates file(s)`,
        )
        return
      }
      const current = pending.pop()
      if (current === undefined) {
        if (inFlight === 0) return
        await new Promise<void>((resolve) => {
          setImmediate(resolve)
        })
        continue
      }
      if (visited.has(current)) continue
      visited.add(current)
      inFlight += 1
      try {
        await visit(current)
      } catch (error) {
        // A read that fails outside visit's own try blocks (an `objects` probe on ELOOP or EACCES is one) is a verdict,
        // not a crash (@cto 7a5c26cd B2): the serial walk answered `unknown` naming the directory, and so does this one.
        walkFailure ??= unknown(`cannot read ${current}: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        inFlight -= 1
      }
    }
  }
  const walkers = Math.max(1, bounds.workers ?? Math.min(16, Math.max(2, cpus().length)))
  await Promise.all(Array.from({ length: walkers }, () => walker()))
  if (walkFailure !== undefined) return walkFailure

  borrowers.sort(compareEstateEdges)
  danglingAlternates.sort((left, right) => {
    if (left.alternatesFile !== right.alternatesFile) return left.alternatesFile < right.alternatesFile ? -1 : 1
    return left.line < right.line ? -1 : left.line > right.line ? 1 : 0
  })
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

/**
 * How deep below a namespace root the lease window looks for a store the census never saw (#33010). Measured on the
 * live estate 2026-11-25: 4 levels = 161,218 directories in 4.1 s, 5 = 283,657 in 16.3 s, 6 = 429,434 in 28.7 s, and
 * the window's whole budget is 10 s. Every directory beyond this depth is COUNTED in `prunedDirs`, never skipped
 * silently. The gap is a store FIRST created deeper than this below a root; a store that existed at the scan is
 * covered by its own alternates stamp however deep it sits.
 */
export const DELTA_DISCOVERY_DEPTH = 4

/**
 * Directories a window never descends into while it looks for a store it never census'd (#33010). A clone that
 * borrows a selected entry is a repository someone created; a build output or a package tree is not where one is
 * born, and descending into every one of them is what made the old location-scoped delta cost 560 s on 10,132,305
 * directories. Every pruned directory is COUNTED in the window (`prunedDirs`), never silently dropped.
 */
const DELTA_DISCOVERY_PRUNED = new Set([
  "node_modules",
  ".cache",
  ".turbo",
  ".vite",
  ".venv",
  "__pycache__",
  "coverage",
  "dist",
  "build",
  "target",
])

/** What the lease window is checked against; see {@link estateDelta}. */
export interface EstateDeltaWindow {
  /** Every entry this batch still holds a lease to delete: a changed or new alternates file naming one ends it. */
  readonly selected: readonly string[]
  /** Test seam: how deep below a namespace root discovery walks; production uses {@link DELTA_DISCOVERY_DEPTH}. */
  readonly discoveryDepth?: number
}

export type EstateDelta =
  | Readonly<{
      status: "unchanged"
      /** Directories outside the census that the window met (a store, a link or a registry): counted, not stopped. */
      changedDirs: number
      /** Alternates files the window stat'd. */
      filesStatted: number
      /** Alternates files the window read, because their stamp moved or the scan never saw them. */
      filesRead: number
      /** Stores the scan never saw that the window found and classified as churn. */
      discoveredStores: number
      /** Directories past the discovery depth or inside a pruned build output: not visited, and said so. */
      prunedDirs: number
      /** Directories the discovery walk read. */
      walkedDirs: number
      /**
       * Recorded stores outside every selected entry that vanished since the scan (#33010, @cto c9e2666a): counted,
       * not stopped. A gone store lends and borrows nothing; one that moved is classified at its new path by discovery.
       */
      vanishedStores: number
    }>
  | Readonly<{ status: "changed"; detail: string }>

/**
 * The lease-held check a retirement batch runs before it deletes anything (#33010): has any alternates declaration
 * moved since `scan` (recorded into `record`) so that it now borrows from an entry this window will delete?
 *
 * Scoped BY REFERENCE, not by location (@cto 2026-11-25): today's borrower list is not enough, because the delta
 * exists to catch a NEW borrower, which can appear anywhere. So every alternates file the scan recorded is stat'd
 * (cheap, and concurrently: 241,824 serial `lstat`s measured 99,815 ms on this estate on 2026-11-25), only a file
 * whose stamp moved — or a path that was absent at the scan — is read, and the batch stops only when a changed or
 * new file names a selected entry. A new object directory whose alternates name nothing selected is churn and is
 * ignored: that is the queue-worktree and ghostty build clone that used to stop the batch for a 560 s walk of
 * 10,132,305 directories.
 *
 * Writers that never take the lease exist (a hand-run clone, `git worktree add`), so this comparison, not the lease,
 * is what catches them between the scan and the delete. A stat or read that fails stops by the file's name, never a
 * skip. New stores are found by walking each namespace root to {@link DELTA_DISCOVERY_DEPTH} and skipping the build
 * outputs in {@link DELTA_DISCOVERY_PRUNED}; every directory that walk does not visit is counted in `prunedDirs`.
 * Stops are chosen from the first reported detail in sorted order, so the same estate always yields the same message
 * whatever order the pool finished in.
 */
export async function estateDelta(
  record: EstateWalkRecord,
  scan: EstateScan,
  window: EstateDeltaWindow,
): Promise<EstateDelta> {
  const selected = window.selected.map((entry) => resolve(entry))
  const borrowerInsideSelection = (store: string): boolean => selected.some((entry) => within(entry, store))
  const namingSelected = (content: string, store: string): string | undefined =>
    alternateEntries(content, store, true).find((target) => selected.some((entry) => within(entry, target)))
  const stops: string[] = []
  const stop = (detail: string): void => {
    stops.push(detail)
  }
  const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))
  const unreadable = (what: string, error: unknown): void => {
    stop(`${what} could not be read at the delta: ${reason(error)}`)
  }
  const workers = Math.max(4, Math.min(32, cpus().length))
  const inPool = async <Item>(items: readonly Item[], each: (item: Item) => Promise<void>): Promise<void> => {
    let next = 0
    const runners = Array.from({ length: Math.min(workers, items.length) }, async () => {
      for (;;) {
        const at = next
        next += 1
        const item = items[at]
        if (item === undefined || stops.length > 0) return
        await each(item)
      }
    })
    await Promise.all(runners)
  }
  const settled = (): EstateDelta | undefined =>
    stops.length === 0 ? undefined : { status: "changed", detail: [...stops].sort()[0] as string }
  try {
    let filesStatted = 0
    let filesRead = 0
    let changedDirs = 0
    let discoveredStores = 0
    let prunedDirs = 0
    let walkedDirs = 0
    let vanishedStores = 0
    const absentNow = new Set<string>()
    // 1. Every alternates file the scan recorded: one stat each, and a read only when its stamp moved or it
    //    appeared after the scan. A changed line that names nothing selected is churn (#33010 @cto).
    await inPool([...record.alternates], async ([file, stamp]) => {
      let now: string
      try {
        now = await fileStampAsync(file)
      } catch (error) {
        unreadable(`alternates file ${file}`, error)
        return
      }
      filesStatted += 1
      if (now === "absent") {
        absentNow.add(dirname(dirname(file)))
        return
      }
      if (now === stamp) return
      const store = dirname(dirname(file))
      // A borrower inside a selected entry is deleted with it: only an OUTSIDE borrower can be left broken.
      if (borrowerInsideSelection(store)) return
      filesRead += 1
      let content: string
      try {
        content = await readFileAsync(file, "utf8")
      } catch (error) {
        unreadable(`alternates file ${file}`, error)
        return
      }
      const named = namingSelected(content, store)
      if (named !== undefined) stop(`alternates file ${file} now names selected entry ${named}`)
    })
    if (settled() !== undefined) return settled() as EstateDelta
    // 2. A recorded store that is gone. Every store whose alternates file exists now was proved to exist by that
    //    stat; the rest get one lstat. #33010 (@cto c9e2666a): a gone store OUTSIDE every selected entry lends and
    //    borrows nothing now, so it is counted, not a stop (yrd-submit candidate worktrees and closed environments
    //    come and go all night); one that moved is classified at its new path by discovery (step 4), and one that
    //    reappears before a delete is caught by that entry's held re-verification. A gone store INSIDE a selected
    //    entry means the entry itself changed under the window, and that still ends the batch by name.
    await inPool([...absentNow], async (store) => {
      const now = await lstatAsync(store).catch((error: unknown) => {
        if (absent(error)) return undefined
        throw error
      })
      if (now?.isDirectory() === true) return
      if (!borrowerInsideSelection(store)) {
        vanishedStores += 1
        return
      }
      stop(`object directory ${store} inside a selected entry vanished or is no longer a directory since the scan`)
    })
    if (settled() !== undefined) return settled() as EstateDelta
    // 3. `objects` links and borrower registries: a few thousand at most, and a redirect or a new registration is a
    //    stop exactly as before.
    await inPool([...record.objectLinks], async ([link, target]) => {
      let now: string
      try {
        now = await realpathAsync(link)
      } catch (error) {
        if (!absent(error)) unreadable(`objects link ${link}`, error)
        now = "absent"
      }
      if (now !== target) stop(`objects link ${link} now resolves to ${now}, not ${target}`)
    })
    if (settled() !== undefined) return settled() as EstateDelta
    await inPool([...record.registries], async ([dir, digest]) => {
      let now: string
      try {
        now = await registryDigestAsync(dir)
      } catch (error) {
        unreadable(`borrower registry ${dir}`, error)
        return
      }
      if (now !== digest) stop(`borrower registry ${dir} changed since the scan`)
    })
    if (settled() !== undefined) return settled() as EstateDelta
    // 4. Stores the scan never saw. A fresh walk, depth-bounded and pruned, reads only alternates files the census
    //    does not carry, so a clone that appeared after the scan is classified by what it borrows, not by existing.
    const depthLimit = window.discoveryDepth ?? DELTA_DISCOVERY_DEPTH
    const classify = async (store: string, alternatesFile: string): Promise<void> => {
      discoveredStores += 1
      filesStatted += 1
      let now: string
      try {
        now = await fileStampAsync(alternatesFile)
      } catch (error) {
        unreadable(`alternates file ${alternatesFile}`, error)
        return
      }
      if (now === "absent") return
      filesRead += 1
      let content: string
      try {
        content = await readFileAsync(alternatesFile, "utf8")
      } catch (error) {
        unreadable(`alternates file ${alternatesFile}`, error)
        return
      }
      const named = namingSelected(content, store)
      if (named !== undefined) stop(`new alternates file ${alternatesFile} names selected entry ${named}`)
    }
    const classifyRegistry = async (registry: string): Promise<void> => {
      changedDirs += 1
      let names: string[]
      try {
        names = (await readdir(registry)).filter((name) => name.endsWith(".json")).sort()
      } catch (error) {
        unreadable(`borrower registry ${registry}`, error)
        return
      }
      for (const name of names) {
        let row: unknown
        try {
          row = JSON.parse(await readFileAsync(join(registry, name), "utf8"))
        } catch (error) {
          unreadable(`borrower registry record ${join(registry, name)}`, error)
          return
        }
        const retained = (row as { retained?: unknown } | null)?.retained
        if (typeof retained !== "string") continue
        const held = resolve(retained)
        if (selected.some((entry) => within(entry, held))) {
          stop(`new borrower registry record ${join(registry, name)} names selected entry ${held}`)
        }
      }
    }
    const pending: { path: string; depth: number }[] = scan.roots.map((root) => ({ path: root, depth: 0 }))
    const visit = async ({ path, depth }: { path: string; depth: number }): Promise<void> => {
      walkedDirs += 1
      let children
      try {
        children = await readdir(path, { withFileTypes: true })
      } catch (error) {
        // A directory that vanished mid-walk lends nothing now; a directory that cannot be read at all is a stop.
        const now = await lstatAsync(path).catch((statError: unknown) => {
          if (absent(statError)) return undefined
          throw statError
        })
        if (now === undefined) return
        stop(`estate delta could not read ${path}: ${reason(error)}`)
        return
      }
      const queue: { path: string; depth: number }[] = []
      for (const child of children) {
        if (stops.length > 0) return
        const childPath = join(path, child.name)
        if (child.name === "objects") {
          const alternatesFile = join(childPath, "info", "alternates")
          if (record.alternates.has(alternatesFile)) continue
          if (child.isSymbolicLink()) {
            let store: string
            try {
              store = await realpathAsync(childPath)
            } catch {
              stop(`new objects link ${childPath} has an unavailable or redirected target`)
              return
            }
            changedDirs += 1
            if (!(await isObjectDirAsync(store))) continue
            await classify(store, alternatesFile)
            continue
          }
          if (!(await isObjectDirAsync(childPath))) continue
          changedDirs += 1
          await classify(childPath, alternatesFile)
          continue
        }
        if (child.name === "git-super-retained-borrowers" && child.isDirectory()) {
          // A registry the scan already read is compared by digest above; only a NEW one is classified here.
          if (record.registries.has(childPath)) continue
          await classifyRegistry(childPath)
          continue
        }
        if (!child.isDirectory() || child.isSymbolicLink()) continue
        if (DELTA_DISCOVERY_PRUNED.has(child.name) || depth + 1 > depthLimit) {
          prunedDirs += 1
          continue
        }
        queue.push({ path: childPath, depth: depth + 1 })
      }
      pending.push(...queue)
    }
    while (pending.length > 0 && stops.length === 0) {
      const batch = pending.splice(0, workers)
      await Promise.all(batch.map(visit))
    }
    const verdict = settled()
    if (verdict !== undefined) return verdict
    return {
      status: "unchanged",
      changedDirs,
      filesStatted,
      filesRead,
      discoveredStores,
      prunedDirs,
      walkedDirs,
      vanishedStores,
    }
  } catch (error) {
    return { status: "changed", detail: `estate delta could not be read: ${reason(error)}` }
  }
}
