/**
 * @failure `bytesPlanned` understates what a retirement batch asks an operator to delete - counting apparent size,
 * dropping a subtree it could not read, or reporting nothing for a path that vanished - so the number reads as
 * complete when it is not.
 * @level l1
 * @consumer `yrd env retained --retire-expired` dry-run; #34270
 * @testonly none
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { measureRetainedBytes } from "../src/retention-bytes.ts"

const cleanup: string[] = []
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true })
})

function tmp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  cleanup.push(path)
  return path
}

describe("retained bytes (#34270)", async () => {
  test("counts allocated blocks, not apparent size, and does not depend on the worker count", async () => {
    const root = tmp("git-super-retained-bytes-")
    const store = join(root, "store")
    const pack = join(store, "pack")
    mkdirSync(pack, { recursive: true })
    const small = [join(pack, "a.pack"), join(pack, "b.pack")]
    for (const file of small) writeFileSync(file, "x")
    const paths = [root, store, pack, ...small]

    // `du` semantics: the two one-byte files occupy a block each, which apparent sizes would report as two bytes.
    const allocated = paths.reduce((total, path) => total + statSync(path).blocks * 512, 0)
    const apparent = paths.reduce((total, path) => total + statSync(path).size, 0)
    expect(apparent).toBeLessThan(allocated)

    expect(await measureRetainedBytes([root])).toEqual({ bytes: allocated, unreadable: 0 })
    expect(await measureRetainedBytes([root], 1)).toEqual({ bytes: allocated, unreadable: 0 })
  })

  test("a directory that cannot be listed is counted and named, never silently dropped", async () => {
    const root = tmp("git-super-retained-bytes-locked-")
    mkdirSync(join(root, "kept"))
    writeFileSync(join(root, "kept", "visible"), "x")
    const locked = join(root, "locked")
    mkdirSync(locked)
    writeFileSync(join(locked, "hidden"), "x")
    chmodSync(locked, 0o000)
    try {
      const measured = await measureRetainedBytes([root], 1)
      expect(measured.unreadable).toBe(1)
      expect(measured.unreadableExample).toBe(locked)
      // The locked directory's own blocks are counted; its children are not, and the count says so.
      const visible = [root, join(root, "kept"), join(root, "kept", "visible"), locked].reduce(
        (total, path) => total + statSync(path).blocks * 512,
        0,
      )
      expect(measured.bytes).toBe(visible)
    } finally {
      chmodSync(locked, 0o755)
    }
  })

  // A store that was already removed frees nothing more, so a vanished path is not an unreadable subtree; the
  // total stays honest instead of reporting a ghost error for work another pass already did.
  test("a path that no longer exists adds nothing and is not reported as unreadable", async () => {
    expect(await measureRetainedBytes([join(tmpdir(), "git-super-retained-bytes-absent-xyz")])).toEqual({
      bytes: 0,
      unreadable: 0,
    })
  })
})
