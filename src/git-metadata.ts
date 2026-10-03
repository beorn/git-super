import { constants, type Stats } from "node:fs"
import { lstat, open } from "node:fs/promises"

/** Read the inspected regular metadata entry without following a replacement or accepting changed bytes. */
export async function readMetadataFile(pointer: string, inspected: Stats): Promise<string> {
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
      const content = await handle.readFile("utf8")
      if (!same(await handle.stat()) || !same(await lstat(pointer))) {
        throw new Error("metadata identity changed during reading")
      }
      return content
    } finally {
      await handle.close()
    }
  } catch (error) {
    throw new Error(`cannot read Git metadata file: ${pointer}`, { cause: error })
  }
}
