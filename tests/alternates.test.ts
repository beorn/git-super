/**
 * @failure A private projection follows an unapproved transitive object store before validating its physical path.
 * @level l1
 * @consumer GitSuper private projection and existing submodule borrowing
 * @reach fs-walk <fixture-only: isolated object directories>
 * @testonly none
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { alternatesLineage } from "../src/alternates.ts"
import { canonicalTmpdir } from "./fixture.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it("validates every transitive store and rejects unknown, missing, and redirected paths", async () => {
  const root = mkdtempSync(join(canonicalTmpdir(), "git-super-alternates-"))
  roots.push(root)
  const source = join(root, "source", "objects")
  const publicStore = join(root, "public", "objects")
  const privateStore = join(root, "private", "objects")
  const missing = join(root, "missing", "objects")
  const redirected = join(root, "redirected", "objects")
  for (const store of [source, publicStore, privateStore]) mkdirSync(join(store, "info"), { recursive: true })
  mkdirSync(join(root, "redirected"))
  symlinkSync(privateStore, redirected, "dir")
  writeFileSync(join(source, "info", "alternates"), `${publicStore}\n`)
  const policy = { allowedObjects: new Set([source, publicStore, missing, redirected]) }
  expect(await alternatesLineage([source], join(root, "own"), policy)).toEqual([publicStore])
  for (const denied of [privateStore, missing, redirected]) {
    writeFileSync(join(publicStore, "info", "alternates"), `${denied}\n`)
    await expect(alternatesLineage([source], join(root, "own"), policy)).rejects.toThrow(denied)
  }
})

/**
 * @failure A dangling alternates symlink is mistaken for a missing file and
 * allows a contained intake to accept a redirected physical object closure.
 * @level l1 - real filesystem metadata, no Git commands
 * @consumer #27143 strict public object-store closure before bundle import
 * @testonly none
 */
it.each(["dangling file", "redirected file", "redirected info"] as const)(
  "refuses %s while accepting a truly absent alternates file",
  async (shape) => {
    const root = mkdtempSync(join(canonicalTmpdir(), "git-super-alternates-file-"))
    roots.push(root)
    const store = join(root, "public", "objects")
    const outside = join(root, "outside")
    mkdirSync(store, { recursive: true })
    mkdirSync(outside)
    const policy = { allowedObjects: new Set([store]) }
    expect(await alternatesLineage([store], join(root, "own"), policy)).toEqual([])
    if (shape === "redirected info") {
      symlinkSync(outside, join(store, "info"), "dir")
    } else {
      mkdirSync(join(store, "info"))
      const target = join(outside, "alternates")
      if (shape === "redirected file") writeFileSync(target, "")
      symlinkSync(target, join(store, "info", "alternates"))
    }
    await expect(alternatesLineage([store], join(root, "own"), policy)).rejects.toThrow("alternates")
  },
)
