import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import { readCommitSubmodules } from "../src/commit-graph.ts"
import { createLocalGitProcess } from "../src/process.ts"
import { createProductFixture, git } from "./fixture.ts"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("commit submodule graph", () => {
  test("reads names, paths, URLs, and exact gitlinks from one frozen commit", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-commit-graph-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)

    await expect(readCommitSubmodules(createLocalGitProcess(), fixture.product, fixture.productBase)).resolves.toEqual([
      {
        name: "packages/alpha",
        path: "packages/alpha",
        target: fixture.alphaBase,
        url: fixture.alpha,
      },
      {
        name: "vendor/beta",
        path: "vendor/beta",
        target: fixture.betaBase,
        url: fixture.beta,
      },
    ])
  })

  test("refuses a gitlink graph whose manifest was deleted", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-commit-graph-invalid-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    git(fixture.product, "rm", "-q", ".gitmodules")
    git(fixture.product, "commit", "-q", "-m", "remove manifest")
    const invalid = git(fixture.product, "rev-parse", "HEAD")

    await expect(readCommitSubmodules(createLocalGitProcess(), fixture.product, invalid)).rejects.toMatchObject({
      resultDetail: {
        code: "missing-target-manifest",
        paths: ["packages/alpha", "vendor/beta"],
      },
    })
  })
})
