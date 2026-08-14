import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import { changedCommitGitlinks, readCommitSubmodules } from "../src/commit-graph.ts"
import { createLocalGitProcess, type GitProcess } from "../src/process.ts"
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

  test("does not interpret a silent config command failure as an empty submodule graph", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-commit-graph-config-failure-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const local = createLocalGitProcess()
    let injected = false
    const silentFailure: GitProcess = {
      run(request) {
        if (!injected && request.args.includes("--blob")) {
          injected = true
          return Promise.resolve({ code: 1, stdout: "", stderr: "", signal: null, timedOut: false })
        }
        return local.run(request)
      },
    }

    await expect(readCommitSubmodules(silentFailure, fixture.product, fixture.productBase)).rejects.toMatchObject({
      resultDetail: { code: "git-failed", phase: "read-target-submodules" },
    })
  })

  test("reports only gitlinks added or advanced by the head commit", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-commit-graph-change-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    git(fixture.alpha, "commit", "--allow-empty", "-q", "-m", "advance alpha")
    git(join(fixture.product, "packages/alpha"), "fetch", "-q", "origin")
    git(join(fixture.product, "packages/alpha"), "checkout", "-q", git(fixture.alpha, "rev-parse", "HEAD"))
    git(fixture.product, "add", "packages/alpha")
    git(fixture.product, "commit", "-q", "-m", "advance alpha pin")
    const head = git(fixture.product, "rev-parse", "HEAD")

    await expect(
      changedCommitGitlinks(createLocalGitProcess(), fixture.product, fixture.productBase, head),
    ).resolves.toEqual([
      {
        path: "packages/alpha",
        target: git(fixture.alpha, "rev-parse", "HEAD"),
      },
    ])
  })
})
