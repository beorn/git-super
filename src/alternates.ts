import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"

function canonical(pathname: string): string {
  return existsSync(pathname) ? realpathSync(pathname) : resolve(pathname)
}

/** The canonical object directories an alternates file names, relative lines resolved against its own store. */
export function alternateEntries(
  content: string,
  objects: string,
  physical = true,
  observe?: (entry: string, rawLine: string) => void,
): string[] {
  return content
    .split(/\r?\n/u)
    .map((rawLine) => ({ rawLine, line: rawLine.trim() }))
    .filter(({ line }) => line !== "" && (!physical || !line.startsWith("#")))
    .map(({ line, rawLine }) => {
      const pathname = isAbsolute(line) ? resolve(line) : resolve(objects, line)
      const entry = physical ? canonical(pathname) : pathname
      observe?.(entry, rawLine)
      return entry
    })
}

/**
 * Every existing object directory reachable through the alternates of `stores`, transitively and without `own`,
 * each AFTER the directories it borrows from (post-order), so git reading them in this order finds every
 * borrow already registered. A directory that no longer exists (its worktree was recycled) ends that branch: git
 * skips it too.
 */
export function alternatesLineageSync(
  stores: readonly string[],
  own: string,
  policy?: Readonly<{ allowedObjects: ReadonlySet<string> }>,
  observation?: Readonly<{
    strictReads: true
    onEdge: (store: string, target: string) => void
    onDangling: (store: string, target: string, rawLine: string) => void
  }>,
): string[] {
  // Seeded with the own store only: a listed ancestor must still be placed ahead of the store that borrows from it,
  // or a file an earlier release wrote ancestor-last reads as complete and is never healed (review2 f11cfb14).
  const seen = new Set([own])
  const lineage: string[] = []
  const missing = new Set<string>()
  const visit = (store: string): void => {
    if (policy !== undefined) {
      // Check authority before resolving or opening a path named by an alternates file.
      if (!policy.allowedObjects.has(store)) throw new Error(`unapproved alternate object store: ${store}`)
      try {
        if (realpathSync(store) !== store || !statSync(store).isDirectory()) {
          throw new Error(`redirected or non-directory alternate object store: ${store}`)
        }
      } catch (error) {
        throw new Error(`cannot validate alternate object store: ${store}`, { cause: error })
      }
    }
    const file = join(store, "info", "alternates")
    let content: string
    try {
      if (policy !== undefined || observation?.strictReads) {
        const info = lstatSync(join(store, "info"), { throwIfNoEntry: false })
        // silent-fallback-allow: a genuinely absent info directory cannot contain an alternates file
        if (info === undefined) return
        if (!info.isDirectory()) throw new Error(`redirected or non-directory alternates parent: ${file}`)
        const metadata = lstatSync(file, { throwIfNoEntry: false })
        // silent-fallback-allow: absent file borrows nothing; lstat distinguishes a dangling symlink from absence
        if (metadata === undefined) return
        if (!metadata.isFile() || realpathSync(file) !== file) {
          throw new Error(`redirected or non-file alternates file: ${file}`)
        }
      }
      content = readFileSync(file, "utf8")
    } catch (error) {
      if (policy !== undefined || observation?.strictReads) {
        throw new Error(`cannot inspect alternates file: ${file}`, { cause: error })
      }
      // silent-fallback-allow: a store with no alternates file borrows nothing; it ends its branch of the lineage
      return
    }
    const declarations: Array<{ entry: string; rawLine: string }> = []
    alternateEntries(content, store, policy === undefined, (entry, rawLine) => {
      declarations.push({ entry, rawLine })
    })
    for (const { entry, rawLine } of declarations) {
      if (policy !== undefined && !policy.allowedObjects.has(entry)) {
        throw new Error(`unapproved alternate object store: ${entry}`)
      }
      if (seen.has(entry)) continue
      if (policy === undefined && observation?.strictReads) {
        try {
          if (!statSync(entry).isDirectory()) throw new Error(`alternate object store is not a directory: ${entry}`)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
          if (!missing.has(entry)) {
            missing.add(entry)
            observation.onDangling(store, entry, rawLine)
          }
          continue
        }
      } else if (policy === undefined && !existsSync(entry)) continue
      seen.add(entry)
      observation?.onEdge(store, entry)
      visit(entry)
      lineage.push(entry)
    }
  }
  for (const store of stores) visit(store)
  return lineage
}

/** Preserve asynchronous callers, including rejected promises for every synchronous traversal refusal. */
export async function alternatesLineage(
  stores: readonly string[],
  own: string,
  policy?: Readonly<{ allowedObjects: ReadonlySet<string> }>,
): Promise<string[]> {
  return Promise.resolve(alternatesLineageSync(stores, own, policy))
}
