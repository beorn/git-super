import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import { changedCommitGitlinks, readCommitSubmodules, readPrivateSubmodulePaths } from "../src/commit-graph.ts"
import { superDiff } from "../src/diff.ts"
import { classifyExcludedPath } from "../src/status.ts"
import { createLocalGitProcess, type GitProcess } from "../src/process.ts"
import { advanceRepository, createProductFixture, git } from "./fixture.ts"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("commit submodule graph", () => {
  /**
   * @failure A repository's `private = true` declaration is invisible to every consumer, so each tool keeps its own list of private children (27147).
   * @level l1
   * @consumer Yrd env open and hh's private-submodule declaration
   */
  test("reads the declared private paths from .gitmodules alone, without joining gitlinks", async () => {
    const root = mkdtempSync(join(tmpdir(), "git-super-private-paths-"))
    roots.push(root)
    const fixture = createProductFixture(root)
    const local = createLocalGitProcess()
    expect(await readPrivateSubmodulePaths(local, fixture.product, fixture.productBase)).toEqual([])
    // A declared section with no recorded gitlink would refuse readCommitSubmodules; the declaration reader only reads.
    git(fixture.product, "config", "--file", ".gitmodules", "submodule.ghost.path", "vendor/ghost")
    git(fixture.product, "config", "--file", ".gitmodules", "submodule.ghost.private", "true")
    git(fixture.product, "config", "--file", ".gitmodules", "submodule.vendor/beta.private", "true")
    git(fixture.product, "commit", "-q", "-am", "declare two private children")
    const declared = git(fixture.product, "rev-parse", "HEAD")
    expect(await readPrivateSubmodulePaths(local, fixture.product, declared)).toEqual(["vendor/beta", "vendor/ghost"])

    git(fixture.product, "config", "--file", ".gitmodules", "submodule.pathless.private", "true")
    git(fixture.product, "commit", "-q", "-am", "a private flag with no path")
    const pathless = git(fixture.product, "rev-parse", "HEAD")
    await expect(readPrivateSubmodulePaths(local, fixture.product, pathless)).rejects.toMatchObject({
      resultDetail: { code: "invalid-target-submodule-config" },
    })
  })

  test("reports a submodule declared private = true, and refuses any other private value by name", async () => {
    const root = mkdtempSync(join(tmpdir(), "git-super-private-declaration-"))
    roots.push(root)
    const fixture = createProductFixture(root)
    git(fixture.product, "config", "--file", ".gitmodules", "submodule.vendor/beta.private", "true")
    git(fixture.product, "commit", "-q", "-am", "declare vendor/beta private")
    const declared = await readCommitSubmodules(
      createLocalGitProcess(),
      fixture.product,
      git(fixture.product, "rev-parse", "HEAD"),
    )
    expect(declared.map(({ path, private: isPrivate }) => [path, isPrivate === true])).toEqual([
      ["packages/alpha", false],
      ["vendor/beta", true],
    ])

    git(fixture.product, "config", "--file", ".gitmodules", "submodule.vendor/beta.private", "yes")
    git(fixture.product, "commit", "-q", "-am", "an unsupported spelling")
    const invalid = git(fixture.product, "rev-parse", "HEAD")
    await expect(readCommitSubmodules(createLocalGitProcess(), fixture.product, invalid)).rejects.toMatchObject({
      resultDetail: {
        code: "invalid-target-submodule-config",
        message: `Target ${invalid} declares submodule vendor/beta private = "yes"; write true or false.`,
      },
    })
  })

  /**
   * @failure Create loses staged identity, attributes staged defects to HEAD, or invents absence despite staged content (27058).
   * @level l1
   * @consumer Git-super stage-0 exclusion classification
   */
  // Frozen-tree coverage cannot witness an index that differs from HEAD; use the same native parent boundary.
  test.each(["addition", "removal", "directory", "unmerged", "conflicting-config", "orphan"] as const)(
    "retains native index identity for %s without writing parent objects or probing a child",
    async (kind) => {
      const root = mkdtempSync(join(tmpdir(), "git-super-selected-index-"))
      roots.push(root)
      const fixture = createProductFixture(root)
      const path = kind === "removal" || kind === "orphan" ? "packages/alpha" : "vendor/private"
      if (kind === "removal" || kind === "orphan") {
        git(fixture.product, "update-index", "--force-remove", path)
        if (kind === "removal") {
          git(fixture.product, "config", "--file", ".gitmodules", "--remove-section", "submodule.packages/alpha")
        }
      } else if (kind === "directory") {
        mkdirSync(join(fixture.product, path))
        writeFileSync(join(fixture.product, path, "file.txt"), "staged content\n")
        git(fixture.product, "add", path)
      } else {
        git(fixture.product, "config", "--file", ".gitmodules", "submodule.private.path", path)
        git(fixture.product, "config", "--file", ".gitmodules", "submodule.private.url", fixture.alpha)
        git(fixture.product, "update-index", "--add", "--cacheinfo", `160000,${fixture.alphaBase},${path}`)
      }
      if (kind === "conflicting-config") {
        git(fixture.product, "config", "--file", ".gitmodules", "--add", "submodule.private.branch", "one")
        git(fixture.product, "config", "--file", ".gitmodules", "--add", "submodule.private.branch", "two")
      }
      git(fixture.product, "add", ".gitmodules")
      const manifestObjectId = git(fixture.product, "rev-parse", ":.gitmodules")
      if (kind === "unmerged") {
        git(fixture.product, "update-index", "--force-remove", path)
        const row = `160000 ${fixture.alphaBase} 1\t${path}\n`
        const result = Bun.spawnSync(["git", "-C", fixture.product, "update-index", "--index-info"], {
          stdin: Buffer.from(row),
        })
        expect(result.exitCode).toBe(0)
      }
      const objectsBefore = git(fixture.product, "count-objects", "-v")
      const local = createLocalGitProcess()
      const process: GitProcess = {
        run(request) {
          if (request.repo !== fixture.product) throw new Error(`child repository was probed: ${request.repo}`)
          return local.run(request)
        },
      }
      const reading = readCommitSubmodules(process, fixture.product, fixture.productBase, {
        excludedSubmodules: kind === "orphan" ? [] : [path],
        source: "index",
      })
      if (kind === "unmerged") {
        await expect(reading).rejects.toMatchObject({ resultDetail: { code: "unmerged-target-index", paths: [path] } })
      } else if (kind === "conflicting-config" || kind === "orphan") {
        // A staged defect belongs to its captured index manifest, never the unchanged HEAD.
        await expect(reading).rejects.toMatchObject({
          message: expect.stringMatching(/stage-0 index/iu),
          resultDetail: {
            code: kind === "orphan" ? "missing-target-gitlink" : "conflicting-target-submodule-config",
            paths: [kind === "orphan" ? path : ".gitmodules"],
            objectIds: [manifestObjectId],
            message: expect.not.stringContaining(fixture.productBase),
          },
        })
      } else {
        const result = await reading
        const selected = result.selectedPaths[0]!
        expect(selected.index).toMatchObject({ source: "index", manifestObjectId })
        expect(selected.index!.entries.map((entry) => entry.path)).toEqual(
          kind === "removal" ? [] : [kind === "directory" ? `${path}/file.txt` : path],
        )
        const classification = classifyExcludedPath(
          path,
          [{ ...selected, repository: fixture.product, head: fixture.productBase }],
          "absent",
        )
        expect(classification.classification).toBe(
          kind === "addition" ? "declared" : kind === "removal" ? "absent" : "unclassified",
        )
        expect(classification.parents[0]!.head).toBe(fixture.productBase)
      }
      expect(git(fixture.product, "rev-parse", "HEAD")).toBe(fixture.productBase)
      expect(git(fixture.product, "count-objects", "-v")).toBe(objectsBefore)
    },
  )

  /**
   * @failure Removal cannot distinguish absent private identity from a tree/config disagreement without opening the child (27058).
   * @level l1
   * @consumer Git-super removal classification
   */
  // Strict graph tests only prove rejection; removal needs selected evidence for each inconsistent shape.
  test.each([
    "absent",
    "absent-no-manifest",
    "absent-empty-manifest",
    "declared",
    "blob",
    "tree",
    "metadata-only",
    "gitlink-only",
  ] as const)("retains selected frozen parent evidence for %s without probing a child", async (kind) => {
    const root = mkdtempSync(join(tmpdir(), "git-super-selected-parent-"))
    roots.push(root)
    const fixture = createProductFixture(root)
    const path = "vendor/private"
    const noSubmodules = kind === "absent-no-manifest" || kind === "absent-empty-manifest"
    if (noSubmodules) {
      git(fixture.product, "update-index", "--force-remove", "packages/alpha", "vendor/beta")
      if (kind === "absent-no-manifest") git(fixture.product, "rm", "-q", ".gitmodules")
      else writeFileSync(join(fixture.product, ".gitmodules"), "")
    }
    if (kind === "blob") writeFileSync(join(fixture.product, path), "parent blob\n")
    if (kind === "tree") {
      mkdirSync(join(fixture.product, path))
      writeFileSync(join(fixture.product, path, "file.txt"), "parent tree\n")
    }
    if (kind === "declared" || kind === "metadata-only") {
      git(fixture.product, "config", "--file", ".gitmodules", "submodule.private-store.path", path)
      git(fixture.product, "config", "--file", ".gitmodules", "submodule.private-store.url", fixture.alpha)
    }
    // A parent with no declarations may still have leftover fixture child checkouts;
    // only the public manifest is staged, never their content or gitlinks.
    if (kind === "absent-empty-manifest") git(fixture.product, "add", ".gitmodules")
    else if (!noSubmodules) git(fixture.product, "add", ".")
    if (kind === "declared" || kind === "gitlink-only") {
      git(fixture.product, "update-index", "--add", "--cacheinfo", `160000,${fixture.alphaBase},${path}`)
    }
    git(fixture.product, "commit", "--allow-empty", "-q", "-m", "selected parent shape")
    const head = git(fixture.product, "rev-parse", "HEAD")
    const local = createLocalGitProcess()
    const process: GitProcess = {
      run(request) {
        if (request.repo !== fixture.product) throw new Error(`child repository was probed: ${request.repo}`)
        return local.run(request)
      },
    }
    const result = await readCommitSubmodules(process, fixture.product, head, { excludedSubmodules: [path] })
    expect(result.selectedPaths).toEqual([
      {
        path,
        treeEntry:
          kind === "absent" || noSubmodules || kind === "metadata-only"
            ? null
            : {
                mode: kind === "blob" ? "100644" : kind === "tree" ? "040000" : "160000",
                type: kind === "blob" ? "blob" : kind === "tree" ? "tree" : "commit",
                objectId:
                  kind === "declared" || kind === "gitlink-only"
                    ? fixture.alphaBase
                    : git(fixture.product, "rev-parse", `${head}:${path}`),
              },
        declarations: kind === "declared" || kind === "metadata-only" ? [{ name: "private-store", path }] : [],
      },
    ])
    expect(result.submodules.map((entry) => entry.path)).toEqual(noSubmodules ? [] : ["packages/alpha", "vendor/beta"])
  })

  /**
   * @failure Forwarding loses a declared branch or takes ambiguous metadata from a different tree.
   * @level l1
   * @consumer GitSuper submodule destination resolution
   */
  test("reads branch metadata from one frozen commit and refuses conflicting declarations", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-commit-graph-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const alphaHead = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 2\n")
    git(join(fixture.product, "packages/alpha"), "fetch", "-q", "origin")
    git(join(fixture.product, "packages/alpha"), "checkout", "-q", alphaHead)

    git(fixture.product, "config", "--file", ".gitmodules", "submodule.packages/alpha.branch", "release/stable")
    git(fixture.product, "add", ".gitmodules", "packages/alpha")
    git(fixture.product, "commit", "-q", "-m", "declare submodule branch")
    const declared = git(fixture.product, "rev-parse", "HEAD")
    git(fixture.product, "config", "--file", ".gitmodules", "submodule.packages/alpha.branch", "uncommitted")

    await expect(readCommitSubmodules(createLocalGitProcess(), fixture.product, declared)).resolves.toEqual([
      {
        branch: "release/stable",
        name: "packages/alpha",
        path: "packages/alpha",
        target: alphaHead,
        url: fixture.alpha,
      },
      {
        name: "vendor/beta",
        path: "vendor/beta",
        target: fixture.betaBase,
        url: fixture.beta,
      },
    ])
    const comparison = superDiff({ repo: fixture.product, refs: [`${fixture.productBase}..${declared}`] })
    expect(comparison.paths).toContain("packages/alpha/alpha.ts")
    expect(comparison.consultedRepositories).toContainEqual(
      expect.objectContaining({
        path: "packages/alpha",
        from: fixture.alphaBase,
        to: alphaHead,
      }),
    )
    expect(comparison.notCompared).toEqual([])

    git(fixture.product, "config", "--file", ".gitmodules", "--add", "submodule.packages/alpha.branch", "other")
    git(fixture.product, "add", ".gitmodules")
    git(fixture.product, "commit", "-q", "-m", "record conflicting branches")
    await expect(readCommitSubmodules(createLocalGitProcess(), fixture.product, "HEAD")).rejects.toMatchObject({
      resultDetail: { code: "conflicting-target-submodule-config", paths: [".gitmodules"] },
    })
    expect(() => superDiff({ repo: fixture.product, refs: [`${fixture.productBase}..HEAD`] })).toThrowError(
      expect.objectContaining({
        resultDetail: expect.objectContaining({ code: "conflicting-target-submodule-config" }),
      }),
    )

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
   * @failure Non-UTF-8 tree/index bytes are silently converted into a different receipt path.
   * @level l1
   * @consumer GitSuper frozen graph and automatic-change receipt producer
   */
  test.each(
    ["head", "index"].flatMap((source) =>
      ["invalid-byte", "unicode-replacement", "literal-star"].map((kind) => [source, kind] as const),
    ),
  )("binds %s %s gitlink paths to native bytes", async (source, kind) => {
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
    if (source === "index") git(fixture.product, "read-tree", selected)
    const reading =
      source === "index"
        ? readCommitSubmodules(local, fixture.product, fixture.productBase, {
            excludedSubmodules: [],
            source: "index",
          }).then((result) => result.submodules)
        : readCommitSubmodules(local, fixture.product, selected)
    if (kind === "invalid-byte") {
      await expect(reading).rejects.toMatchObject({
        resultDetail: { code: "invalid-target-gitlink-path" },
      })
    } else {
      await expect(reading).resolves.toEqual([{ name: "raw", path, target: fixture.alphaBase, url: fixture.alpha }])
    }
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

  test("reads a valid empty manifest with no gitlinks as an empty submodule graph", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-commit-graph-empty-manifest-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    git(fixture.product, "update-index", "--force-remove", "packages/alpha", "vendor/beta")
    writeFileSync(join(fixture.product, ".gitmodules"), "")
    git(fixture.product, "add", ".gitmodules")
    git(fixture.product, "commit", "--allow-empty", "-q", "-m", "empty manifest and no gitlinks")
    const empty = git(fixture.product, "rev-parse", "HEAD")

    await expect(readCommitSubmodules(createLocalGitProcess(), fixture.product, empty)).resolves.toEqual([])
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
