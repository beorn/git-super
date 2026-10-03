import { constants, type Stats } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { join, resolve } from "node:path"

/** Read the inspected regular metadata entry without following a replacement or accepting changed bytes. */
export async function readMetadataFile(
  pointer: string,
  inspected: Stats,
  inspect?: (path: string, stat: Stats | undefined, bytes: Buffer | undefined) => void,
): Promise<string> {
  if (!inspected.isFile()) throw new Error(`unsupported Git metadata file: ${pointer}`)
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new Error(`no-follow Git metadata reading is unavailable: ${pointer}`)
  }
  const same = (observed: Stats): boolean =>
    observed.isFile() &&
    observed.dev === inspected.dev &&
    observed.ino === inspected.ino &&
    observed.size === inspected.size &&
    observed.mtimeMs === inspected.mtimeMs &&
    observed.ctimeMs === inspected.ctimeMs
  try {
    const handle = await open(pointer, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      if (!same(await handle.stat())) throw new Error("opened metadata identity changed")
      const content = await handle.readFile()
      if (!same(await handle.stat()) || !same(await lstat(pointer))) {
        throw new Error("metadata identity changed during reading")
      }
      inspect?.(pointer, inspected, content)
      return content.toString("utf8")
    } finally {
      await handle.close()
    }
  } catch (error) {
    throw new Error(`cannot read Git metadata file: ${pointer}`, { cause: error })
  }
}

/** Resolve common metadata without converting a pointer fault into standalone identity. */
export async function commonDirectory(
  gitDirectory: string,
  inspect?: (path: string, stat: Stats | undefined, bytes: Buffer | undefined) => void,
): Promise<string> {
  const pointer = join(gitDirectory, "commondir")
  let inspected: Stats
  try {
    inspected = await lstat(pointer)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // silent-fallback-allow: only lstat-proven entry absence identifies a standalone repository
      inspect?.(pointer, undefined, undefined)
      return gitDirectory
    }
    throw new Error(`cannot inspect Git metadata file: ${pointer}`, { cause: error })
  }
  const content = await readMetadataFile(pointer, inspected, inspect)
  const selected = content.trim()
  if (selected === "" || /[\r\n\u0000]/u.test(selected)) throw new Error(`invalid commondir pointer: ${pointer}`)
  try {
    return await realpath(resolve(gitDirectory, selected))
  } catch (error) {
    throw new Error(`cannot resolve commondir pointer: ${pointer}`, { cause: error })
  }
}
