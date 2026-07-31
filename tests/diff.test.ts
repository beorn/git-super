import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { superDiff } from "../src/diff.ts"
import { bumpProductSubmodules, createProductFixture } from "./fixture.ts"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("superDiff", () => {
  test("expands two moved gitlinks into root-relative inner files", () => {
    const fixture = mkdtempSync(join(tmpdir(), "git-super-diff-"))
    roots.push(fixture)
    const productFixture = createProductFixture(fixture)
    const head = bumpProductSubmodules(productFixture)

    const result = superDiff({ repo: productFixture.product, refs: [`${productFixture.productBase}..${head}`] })

    expect(result.paths).toEqual(["packages/alpha/alpha.ts", "vendor/beta/new-beta.ts"])
    expect(result.consultedRepositories.map(({ path }) => path)).toEqual([".", "packages/alpha", "vendor/beta"])
  })
})
