/**
 * How many bytes a retirement batch would free, measured from the retained stores themselves (#34270).
 *
 * `du` semantics, not apparent size: a path counts the blocks it occupies (`st.blocks * 512`), so a sparse object file
 * counts what it holds on disk, and a symlink counts as the entry being removed rather than the tree it points at —
 * which is what a batch that removes these stores actually frees.
 *
 * A path that cannot be read is COUNTED, never silently dropped: the caller prints the count beside the total, because a
 * total that quietly excludes a subtree would understate the deletion it is asking an operator to approve.
 *
 * A HARD LINK is one file, not several (@cto 7a5c26cd B1). Counting blocks per directory entry would count one inode
 * once per link, and would count a file whose other link lives outside the set even though removing the set frees none
 * of it. Local clones hard-link packs, so both cases are ordinary here. An inode with more than one link is therefore
 * counted once, and only when every one of its links was seen inside the set; the rest is reported separately, because
 * an operator has to know how much of the figure is not actually freed.
 *
 * The walk is the same bounded-pool shape as the estate scan: a store set of thousands of trees is I/O bound, and the
 * number is only ever read by a human deciding whether to delete.
 */
import { lstat, readdir } from "node:fs/promises"
import { join } from "node:path"

export interface RetainedBytes {
  /** Allocated bytes the removal frees: every single-link entry plus every inode whose links are all inside the set. */
  readonly bytes: number
  /** Allocated bytes NOT freed: files also linked outside the set, which stay on disk after the set is removed. */
  readonly sharedBytes?: number
  /** Paths that could not be read or listed: their bytes are NOT in `bytes`. */
  readonly unreadable: number
  /** First unreadable path, so the count can be acted on rather than guessed at. */
  readonly unreadableExample?: string
}

/** The exact figure with a rounded human size beside it, so an approved deletion is neither misread nor mistyped. */
export function formatRetainedBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"]
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const exact = bytes.toLocaleString("en-US")
  return unit === 0 ? `${exact} B` : `${value.toFixed(1)} ${units[unit]} (${exact} B)`
}

export async function measureRetainedBytes(roots: readonly string[], workers = 8): Promise<RetainedBytes> {
  let bytes = 0
  let unreadable = 0
  let unreadableExample: string | undefined
  // One entry per inode seen through more than one link; `links` counts the names this walk has actually read.
  const linkedInodes = new Map<string, { blocks: number; nlink: number; links: number }>()
  const pending: string[] = [...roots]
  let inFlight = 0

  const visit = async (path: string): Promise<void> => {
    let stat
    try {
      stat = await lstat(path)
    } catch (error) {
      // A path that vanished between being listed and being read frees nothing more; anything else is reported, so the
      // total says it is missing a subtree instead of reading as complete.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        unreadable += 1
        unreadableExample ??= path
      }
      return
    }
    const allocated = stat.blocks * 512
    if (!stat.isDirectory() && stat.nlink > 1) {
      const key = `${stat.dev}:${stat.ino}`
      const seen = linkedInodes.get(key)
      if (seen === undefined) linkedInodes.set(key, { blocks: allocated, nlink: stat.nlink, links: 1 })
      else seen.links += 1
    } else {
      // A directory's own link count carries its subdirectories, so it is never a shared-file question.
      bytes += allocated
    }
    if (!stat.isDirectory()) return
    let entries
    try {
      entries = await readdir(path, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        unreadable += 1
        unreadableExample ??= path
      }
      return
    }
    for (const entry of entries) pending.push(join(path, entry.name))
  }

  const worker = async (): Promise<void> => {
    for (;;) {
      const path = pending.pop()
      if (path === undefined) {
        if (inFlight === 0) return
        await new Promise<void>((resolve) => {
          setImmediate(resolve)
        })
        continue
      }
      inFlight += 1
      try {
        await visit(path)
      } finally {
        inFlight -= 1
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, workers) }, () => worker()))
  let sharedBytes = 0
  for (const inode of linkedInodes.values()) {
    if (inode.links >= inode.nlink) bytes += inode.blocks
    else sharedBytes += inode.blocks
  }
  return {
    bytes,
    ...(sharedBytes === 0 ? {} : { sharedBytes }),
    unreadable,
    ...(unreadableExample === undefined ? {} : { unreadableExample }),
  }
}
