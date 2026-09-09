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
  /**
   * @failure Forwarding loses a declared branch or takes ambiguous metadata from a different tree.
   * @level l1
   * @consumer GitSuper component destination resolution
   */
  test("reads branch metadata from one frozen commit and refuses conflicting declarations", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-commit-graph-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)

    git(fixture.product, "config", "--file", ".gitmodules", "submodule.packages/alpha.branch", "release/stable")
    git(fixture.product, "add", ".gitmodules")
    git(fixture.product, "commit", "-q", "-m", "declare component branch")
    const declared = git(fixture.product, "rev-parse", "HEAD")
    git(fixture.product, "config", "--file", ".gitmodules", "submodule.packages/alpha.branch", "uncommitted")

    await expect(readCommitSubmodules(createLocalGitProcess(), fixture.product, declared)).resolves.toEqual([
      {
        branch: "release/stable",
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

    git(fixture.product, "config", "--file", ".gitmodules", "--add", "submodule.packages/alpha.branch", "other")
    git(fixture.product, "add", ".gitmodules")
    git(fixture.product, "commit", "-q", "-m", "record conflicting branches")
    await expect(readCommitSubmodules(createLocalGitProcess(), fixture.product, "HEAD")).rejects.toMatchObject({
      resultDetail: { code: "conflicting-target-submodule-config", paths: [".gitmodules"] },
    })

    git(fixture.product, "config", "--file", ".gitmodules", "--unset-all", "submodule.packages/alpha.branch")
    git(fixture.product, "config", "--file", ".gitmodules", "submodule.alias.path", "packages/alpha")
    git(fixture.product, "config", "--file", ".gitmodules", "submodule.alias.url", fixture.alpha)
    git(fixture.product, "config", "--file", ".gitmodules", "submodule.alias.branch", "other")
    git(fixture.product, "add", ".gitmodules")
    git(fixture.product, "commit", "-q", "-m", "record conflicting path aliases")
    await expect(readCommitSubmodules(createLocalGitProcess(), fixture.product, "HEAD")).rejects.toMatchObject({
      resultDetail: { code: "conflicting-target-submodule-path", paths: ["packages/alpha"] },
    })
  })

  /**
   * @failure Non-UTF-8 tree bytes are silently converted into a different receipt path.
   * @level l1
   * @consumer GitSuper frozen graph and automatic-change receipt producer
   */
  test.each(["invalid-byte", "unicode-replacement", "literal-star"])(
    "binds %s gitlink paths to native tree bytes",
    async (kind) => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-graph-path-bytes-"))
      roots.push(fixtureRoot)
      const fixture = createProductFixture(fixtureRoot)
      const rawPath =
        kind === "invalid-byte"
          ? Buffer.from([0x61, 0xff, 0x62])
          : Buffer.from(kind === "literal-star" ? "a*b" : "a\ufffdb")
      const path = rawPath.toString("utf8")
      const local = createLocalGitProcess()
      const manifest = await local.run({
        repo: fixture.product,
        args: ["hash-object", "-w", "--stdin"],
        stdin: `[submodule "raw"]\n\tpath = "${path}"\n\turl = "${fixture.alpha}"\n`,
      })
      expect(manifest.code).toBe(0)
      const rawTree = Bun.spawnSync(["git", "-C", fixture.product, "mktree", "-z", "--missing"], {
        stdin: Buffer.concat([
          Buffer.from(`100644 blob ${manifest.stdout.trim()}\t.gitmodules\0`),
          Buffer.from(`160000 commit ${fixture.alphaBase}\t`),
          rawPath,
          Buffer.from([0]),
        ]),
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(rawTree.exitCode, rawTree.stderr.toString()).toBe(0)
      const selected = rawTree.stdout.toString().trim()
      if (kind === "invalid-byte") {
        await expect(readCommitSubmodules(local, fixture.product, selected)).rejects.toMatchObject({
          resultDetail: { code: "invalid-target-gitlink-path" },
        })
      } else {
        await expect(readCommitSubmodules(local, fixture.product, selected)).resolves.toEqual([
          { name: "raw", path, target: fixture.alphaBase, url: fixture.alpha },
        ])
      }
    },
  )

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
