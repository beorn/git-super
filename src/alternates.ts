import { existsSync, lstatSync, realpathSync, statSync, type Stats } from "node:fs"
import { readFile } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { readMetadataFile } from "./git-metadata.ts"

function canonical(pathname: string): string {
  return existsSync(pathname) ? realpathSync(pathname) : resolve(pathname)
}

/** The canonical object directories an alternates file names, relative lines resolved against its own store. */
export function alternateEntries(content: string, objects: string, physical = true): string[] {
  return content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((entry) => entry !== "" && (!physical || !entry.startsWith("#")))
    .map((entry) => {
      const pathname = isAbsolute(entry) ? resolve(entry) : resolve(objects, entry)
      return physical ? canonical(pathname) : pathname
    })
}

/**
 * Every existing object directory reachable through the alternates of `stores`, transitively and without `own`,
 * each AFTER the directories it borrows from (post-order), so git reading them in this order finds every
 * borrow already registered. A directory that no longer exists (its worktree was recycled) ends that branch: git
 * skips it too.
 */
export async function alternatesLineage(
  stores: readonly string[],
  own: string,
  policy?: Readonly<{
    allowedObjects: ReadonlySet<string>
    inspect?: (path: string, stat: Stats | undefined, bytes: Buffer | undefined) => void
  }>,
): Promise<string[]> {
  // Seeded with the own store only: a listed ancestor must still be placed ahead of the store that borrows from it,
  // or a file an earlier release wrote ancestor-last reads as complete and is never healed (review2 f11cfb14).
  const seen = new Set([own])
  const lineage: string[] = []
  const visit = async (store: string): Promise<void> => {
    if (policy !== undefined) {
      // Check authority before resolving or opening a path named by an alternates file.
      if (!policy.allowedObjects.has(store)) throw new Error(`unapproved alternate object store: ${store}`)
      try {
        const metadata = statSync(store)
        if (realpathSync(store) !== store || !metadata.isDirectory()) {
          throw new Error(`redirected or non-directory alternate object store: ${store}`)
        }
        policy.inspect?.(store, metadata, undefined)
      } catch (error) {
        throw new Error(`cannot validate alternate object store: ${store}`, { cause: error })
      }
    }
    const file = join(store, "info", "alternates")
    let content: string
    try {
      if (policy !== undefined) {
        const info = lstatSync(join(store, "info"), { throwIfNoEntry: false })
        policy.inspect?.(join(store, "info"), info, undefined)
        // silent-fallback-allow: a genuinely absent info directory cannot contain an alternates file
        if (info === undefined) return
        if (!info.isDirectory()) throw new Error(`redirected or non-directory alternates parent: ${file}`)
        const metadata = lstatSync(file, { throwIfNoEntry: false })
        // silent-fallback-allow: absent file borrows nothing; lstat distinguishes a dangling symlink from absence
        if (metadata === undefined) {
          policy.inspect?.(file, undefined, undefined)
          return
        }
        if (!metadata.isFile() || realpathSync(file) !== file) {
          throw new Error(`redirected or non-file alternates file: ${file}`)
        }
        content = await readMetadataFile(file, metadata, policy.inspect)
      } else {
        content = await readFile(file, "utf8")
      }
    } catch (error) {
      if (policy !== undefined) {
        throw new Error(`cannot inspect alternates file: ${file}`, { cause: error })
      }
      // silent-fallback-allow: a store with no alternates file borrows nothing; it ends its branch of the lineage
      return
    }
    for (const entry of alternateEntries(content, store, policy === undefined)) {
      if (policy !== undefined && !policy.allowedObjects.has(entry)) {
        throw new Error(`unapproved alternate object store: ${entry}`)
      }
      if (seen.has(entry)) continue
      if (policy === undefined && !existsSync(entry)) continue
      seen.add(entry)
      await visit(entry)
      lineage.push(entry)
    }
  }
  for (const store of stores) await visit(store)
  return lineage
}
