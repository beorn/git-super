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
import { isAbsolute, join, relative, resolve, sep } from "node:path"
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
  const stack = [...roots]
  while (stack.length > 0) {
    if (clock() - started > bounds.scanMs) {
      return {
        status: "unknown",
        detail: `estate declaration scan exceeded ${bounds.scanMs} ms after ${alternatesFiles} alternates file(s)`,
        roots,
        objectDirs: [...objectDirs].sort(),
        alternatesFiles,
        borrowers,
        registries: [...registryDirs].sort(),
        survivorIntoRemoval: [],
      }
    }
    const current = stack.pop()!
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch (error) {
      return {
        status: "unknown",
        detail: `cannot read ${current}: ${error instanceof Error ? error.message : String(error)}`,
        roots,
        objectDirs: [...objectDirs].sort(),
        alternatesFiles,
        borrowers,
        registries: [...registryDirs].sort(),
        survivorIntoRemoval: [],
      }
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
          return {
            status: "unknown",
            detail: `objects link ${path} has an unavailable or redirected target: ${error instanceof Error ? error.message : String(error)}`,
            roots,
            objectDirs: [...objectDirs].sort(),
            alternatesFiles,
            borrowers,
            registries: [...registryDirs].sort(),
            survivorIntoRemoval: [],
          }
        }
        objectDirs.add(path)
        borrowers.push({ borrower: canonical(join(current, "..")), target })
        continue
      }
      if (!entry.isDirectory()) continue
      if (entry.name === "objects" && isObjectDir(path)) {
        objectDirs.add(path)
        const alternatesFile = join(path, "info", "alternates")
        if (existsSync(alternatesFile)) {
          alternatesFiles += 1
          if (alternatesFiles > bounds.maxAlternatesFiles) {
            return {
              status: "unknown",
              detail: `estate declaration scan hit the alternates-file bound (${alternatesFiles} recorded, cap ${bounds.maxAlternatesFiles})`,
              roots,
              objectDirs: [...objectDirs].sort(),
              alternatesFiles,
              borrowers,
              registries: [...registryDirs].sort(),
              survivorIntoRemoval: [],
            }
          }
          let content: string
          try {
            content = readFileSync(alternatesFile, "utf8")
          } catch (error) {
            return {
              status: "unknown",
              detail: `cannot read ${alternatesFile}: ${error instanceof Error ? error.message : String(error)}`,
              roots,
              objectDirs: [...objectDirs].sort(),
              alternatesFiles,
              borrowers,
              registries: [...registryDirs].sort(),
              survivorIntoRemoval: [],
            }
          }
          for (const target of alternateEntries(content, path)) {
            const actual = canonical(target)
            if (!existsSync(actual) || !statSync(actual).isDirectory()) {
              return {
                status: "unknown",
                detail: `${alternatesFile} names a missing or non-directory alternate ${target}`,
                roots,
                objectDirs: [...objectDirs].sort(),
                alternatesFiles,
                borrowers,
                registries: [...registryDirs].sort(),
                survivorIntoRemoval: [],
              }
            }
            borrowers.push({ borrower: canonical(path), target: actual })
          }
        }
        continue
      }
      if (entry.name === "git-super-retained-borrowers") {
        registryDirs.add(path)
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
