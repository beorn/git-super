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
