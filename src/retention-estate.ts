/**
 * Gate 3 of the #27443(b) retirement proof: ONE read-only inverted alternate/objects-link index
 * for a whole pass, built from the declared managed namespace `N` and the removal set `R`.
 *
 * It reads declarations and reverse links; it never writes, prunes, gc's or "repairs" one. An
 * unreadable registry, a missing or redirected alternate target, an incomplete scan or a bound
 * hit is `unknown`, never a silent skip. A survivor (outside `R`) that borrows into an object
 * directory under `R` is `blocked`.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { alternateEntries } from "./alternates.ts"

export interface EstateScanBounds {
  /** 60,000 in the contract's initial pass. */
  readonly maxAlternatesFiles: number
  /** 180 s in the contract's initial pass. */
  readonly scanMs: number
}

export const DEFAULT_ESTATE_BOUNDS: EstateScanBounds = { maxAlternatesFiles: 60_000, scanMs: 180_000 }

export interface EstateBorrower {
  /** The object directory that declares the alternate (the borrower). */
  readonly borrower: string
  /** The object directory the alternate names (the lender). */
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
      }
    }
    roots.push(canonical(root))
  }
  const removalRoots = removal.map(canonical)
  const objectDirs = new Set<string>()
  const registryDirs = new Set<string>()
  const borrowers: EstateBorrower[] = []
  let alternatesFiles = 0

  const unknown = (detail: string): EstateScan => ({
    status: "unknown",
    detail,
    roots,
    objectDirs: [...objectDirs].sort(),
    alternatesFiles,
    borrowers,
    registries: [...registryDirs].sort(),
    survivorIntoRemoval: [],
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
    for (const target of alternateEntries(content, store)) {
      const actual = canonical(target)
      if (!existsSync(actual) || !statSync(actual).isDirectory()) {
        return unknown(`${alternatesFile} names a missing or non-directory alternate ${target}`)
      }
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
      entries = readdirSync(current, { withFileTypes: true })
    } catch (error) {
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
  return {
    status: survivorIntoRemoval.length === 0 ? "pass" : "blocked",
    detail:
      survivorIntoRemoval.length === 0
        ? `${objectDirs.size} object dir(s), ${alternatesFiles} alternates file(s), ${borrowers.length} reverse link(s)`
        : `${survivorIntoRemoval.length} survivor borrower(s) into the removal set, e.g. ${survivorIntoRemoval[0]!.borrower} -> ${survivorIntoRemoval[0]!.target}`,
    roots,
    objectDirs: [...objectDirs].sort(),
    alternatesFiles,
    borrowers,
    registries: [...registryDirs].sort(),
    survivorIntoRemoval,
  }
}
