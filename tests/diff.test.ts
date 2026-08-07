import { afterEach, describe, expect, test } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { superDiff } from "../src/diff.ts"
import {
  addNestedAlphaSubmodule,
  bumpNestedAlphaSubmodule,
  bumpProductSubmodules,
  createProductFixture,
  createRepository,
  git,
} from "./fixture.ts"

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

  test("fails loudly when a gitlink is added without an old commit range", () => {
    const fixture = mkdtempSync(join(tmpdir(), "git-super-added-link-"))
    roots.push(fixture)
    const dependency = join(fixture, "dependency")
    const product = join(fixture, "product")
    createRepository(dependency, "dependency.ts", "export const value = 1\n")
    createRepository(product, "root.ts", "export const root = 1\n")
    const base = git(product, "rev-parse", "HEAD")
    git(product, "-c", "protocol.file.allow=always", "submodule", "add", "-q", dependency, "vendor/dependency")
    git(product, "commit", "-q", "-am", "add dependency")

    expect(() => superDiff({ repo: product, refs: [`${base}..HEAD`] })).toThrow(
      "is an added or removed gitlink; no old/new commit range exists",
    )
  })

  test("recursively expands a moved gitlink inside a moved submodule", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-nested-diff-"))
    roots.push(fixtureRoot)
    const fixture = addNestedAlphaSubmodule(createProductFixture(fixtureRoot))
    const head = bumpNestedAlphaSubmodule(fixture)

    const result = superDiff({
      repo: fixture.product,
      refs: [`${fixture.productWithNestedBase}..${head}`],
    })

    expect(result.paths).toEqual(["packages/alpha/apps/maddoc/leaf.ts"])
    expect(result.consultedRepositories.map(({ path }) => path)).toEqual([
      ".",
      "packages/alpha",
      "packages/alpha/apps/maddoc",
    ])
  })
})
