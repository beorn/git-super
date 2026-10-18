import { afterEach, describe, expect, test, vi } from "vitest"
import childProcess from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process") & { default: typeof childProcess }>()
  return {
    ...actual,
    spawnSync: (...args: Parameters<typeof actual.spawnSync>) => actual.default.spawnSync(...args),
  }
})
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { superDiff, type SuperDiffResult } from "../src/diff.ts"
import { runCli } from "../src/cli.ts"
import {
  addNestedAlphaSubmodule,
  advanceRepository,
  bumpNestedAlphaSubmodule,
  bumpProductSubmodules,
  createProductFixture,
  createRepository,
  git,
  type ProductFixture,
} from "./fixture.ts"

function outputSink(): { output: string; write(value: string): void } {
  return {
    output: "",
    write(value) {
      this.output += value
    },
  }
}

const roots: string[] = []
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("superDiff", () => {
  /**
   * @failure CLI parsing drops -- and Git mistakes deleted paths for revisions (#29476).
   * @level l1
   * @consumer git super diff --stat --patch --json A B -- paths
   * @testonly none
   */
  test("preserves deleted path filters after the option separator", async () => {
    const root = mkdtempSync(join(tmpdir(), "git-super-path-filter-"))
    roots.push(root)
    createRepository(root, "deleted file.ts", "first\nsecond\n")
    writeFileSync(join(root, "--repo"), "option-shaped path\n")
    writeFileSync(join(root, "unrelated.ts"), "before\n")
    git(root, "add", ".")
    git(root, "commit", "-qm", "add path-filter fixture")
    const before = git(root, "rev-parse", "HEAD")
    git(root, "rm", "--", "deleted file.ts", "--repo")
    const after = advanceRepository(root, "unrelated.ts", "after\n")
    const stdout = outputSink()
    const stderr = outputSink()
    const code = await runCli(
      ["--repo", root, "--json", "diff", "--stat", "--patch", before, after, "--", "deleted file.ts", "--repo"],
      stdout,
      stderr,
    )
    expect(code, stderr.output).toBe(0)
    const result = JSON.parse(stdout.output) as SuperDiffResult
    expect(result.paths).toEqual(["--repo", "deleted file.ts"])
    expect(result.stats?.[0]?.files).toEqual([
      { path: "--repo", added: 0, deleted: 1, binary: false },
      { path: "deleted file.ts", added: 0, deleted: 2, binary: false },
    ])
    expect(result.patches?.[0]?.patch).toContain("deleted file mode")
    expect(result.patches?.[0]?.patch).not.toContain("unrelated.ts")
  })

  /**
   * @failure An explicit exclusion still reads the child's Git content or silently hides included working dirt (#27058 AC3).
   * @level l1
   * @consumer git super diff, including native argv and CLI narration
   * @testonly none
   */
  // 28661: this pair builds a real fixture with two submodules and drives both `superDiff` and the CLI over it,
  // spawning dozens of git processes. The 5s default is not a budget under a full parallel suite run: it timed
  // out with this branch's extra tests in the run, and the abort left this file's mocked
  // `childProcess.spawnSync` and its `syncBuiltinESMExports()` in place for the NEXT test in the same file,
  // which then overflowed the stack on its first nested spawn. A realistic budget removes the flake; that
  // contamination is why it is worth removing rather than re-running.
  for (const mode of ["historical", "working"] as const) {
    test(`reports exclusions before child access in ${mode} comparisons`, { timeout: 30_000 }, async () => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-excluded-"))
      roots.push(fixtureRoot)
      const fixture = createProductFixture(fixtureRoot)
      const head = bumpProductSubmodules(fixture)
      if (mode === "working") {
        writeFileSync(join(fixture.product, "packages/alpha/alpha.ts"), "private canary\n")
        writeFileSync(join(fixture.product, "vendor/beta/beta.ts"), "included working change\n")
      }
      const original = childProcess.spawnSync
      const excluded = join(fixture.product, "packages/alpha")
      const spy = vi.spyOn(childProcess, "spawnSync").mockImplementation((command, args, options) => {
        if (
          Array.isArray(args) &&
          args[0] === "-C" &&
          typeof args[1] === "string" &&
          (args[1] === excluded || args[1].startsWith(`${excluded}/`))
        ) {
          throw new Error(`excluded component content was probed: ${args.join(" ")}`)
        }
        return original(command, args, options)
      })
      syncBuiltinESMExports()
      try {
        const options = {
          repo: fixture.product,
          ...(mode === "historical" ? { refs: [`${fixture.productBase}..${head}`] } : {}),
          excludedSubmodules: ["packages/alpha"],
          stat: true,
          patch: true,
        }
        const result = superDiff(options)
        expect(spy.mock.calls.length).toBeGreaterThan(0)
        expect(result).toMatchObject({
          notCompared: [expect.objectContaining({ path: "packages/alpha", reason: "excluded" })],
        })
        expect(result.paths).toEqual([mode === "historical" ? "vendor/beta/new-beta.ts" : "vendor/beta/beta.ts"])
        expect(result.consultedRepositories.map(({ path }) => path)).toEqual([".", "vendor/beta"])
        expect(result.stats?.flatMap(({ files }) => files.map(({ path }) => path))).not.toContain("packages/alpha")
        if (mode === "working") {
          const parentDiffs = spy.mock.calls.filter(
            ([, args]) => Array.isArray(args) && args[1] === fixture.product && args.includes("diff"),
          )
          expect(parentDiffs.length).toBeGreaterThan(0)
          for (const [, args] of parentDiffs) expect(args).toContain("--ignore-submodules=dirty")
        }
        const stdout = outputSink()
        const stderr = outputSink()
        expect(
          await runCli(
            [
              "--repo",
              fixture.product,
              "diff",
              "--exclude-submodule",
              "packages/alpha",
              ...(mode === "historical" ? [`${fixture.productBase}..${head}`] : []),
            ],
            stdout,
            stderr,
          ),
        ).toBe(0)
        expect(stderr.output).toContain("packages/alpha: component excluded, not compared")
      } finally {
        spy.mockRestore()
        syncBuiltinESMExports()
      }
    })
  }
  test("expands two moved gitlinks into root-relative inner files", () => {
    const fixture = mkdtempSync(join(tmpdir(), "git-super-diff-"))
    roots.push(fixture)
    const productFixture = createProductFixture(fixture)
    const head = bumpProductSubmodules(productFixture)

    const result = superDiff({ repo: productFixture.product, refs: [`${productFixture.productBase}..${head}`] })

    expect(result.paths).toEqual(["packages/alpha/alpha.ts", "vendor/beta/new-beta.ts"])
    expect(result.consultedRepositories.map(({ path }) => path)).toEqual([".", "packages/alpha", "vendor/beta"])
  })

  /**
   * @failure An added gitlink threw "no old/new commit range exists", so affected-tests refused to judge every
   * post-merge range that spanned a submodule addition (vendor/brain8, 26972).
   * @level l1
   * @consumer git super diff, affected-tests, the nightly red comparison and pm-metrics
   * @testonly none
   */
  test("expands an added gitlink from git's empty tree: paths, consulted range, stat, pointer move and patch", () => {
    const fixture = mkdtempSync(join(tmpdir(), "git-super-added-link-"))
    roots.push(fixture)
    const dependency = join(fixture, "dependency")
    const product = join(fixture, "product")
    createRepository(dependency, "dependency.ts", "export const value = 1\n")
    advanceRepository(dependency, "notes.md", "notes\n")
    createRepository(product, "root.ts", "export const root = 1\n")
    const base = git(product, "rev-parse", "HEAD")
    git(product, "-c", "protocol.file.allow=always", "submodule", "add", "-q", dependency, "vendor/dependency")
    git(product, "commit", "-q", "-am", "add dependency")
    const pin = git(product, "rev-parse", "HEAD:vendor/dependency")

    const result = superDiff({ repo: product, refs: [`${base}..HEAD`], stat: true, patch: true })

    expect(result.paths).toEqual([".gitmodules", "vendor/dependency/dependency.ts", "vendor/dependency/notes.md"])
    expect(result.deletedPaths).toEqual([])
    expect(result.consultedRepositories).toContainEqual(
      expect.objectContaining({ path: "vendor/dependency", from: EMPTY_TREE, to: pin }),
    )
    const added = result.stats?.find((stat) => stat.repository === "vendor/dependency")
    expect(added?.range).toEqual({ from: EMPTY_TREE, to: pin })
    expect(added?.files.map(({ path, deleted }) => ({ path, deleted }))).toEqual([
      { path: "dependency.ts", deleted: 0 },
      { path: "notes.md", deleted: 0 },
    ])
    const root = result.stats?.find((stat) => stat.repository === ".")
    expect(root?.pointerMoves).toEqual([{ path: "vendor/dependency", from: EMPTY_TREE, to: pin }])
    const patch = result.patches?.find((entry) => entry.repository === "vendor/dependency")?.patch ?? ""
    expect(patch).toContain("+++ b/dependency.ts")
    expect(patch).toContain("+++ b/notes.md")
  })

  test("expands a gitlink nested inside an added gitlink", () => {
    const fixture = mkdtempSync(join(tmpdir(), "git-super-added-nested-"))
    roots.push(fixture)
    const leaf = join(fixture, "leaf")
    const dependency = join(fixture, "dependency")
    const product = join(fixture, "product")
    createRepository(leaf, "leaf.ts", "export const leaf = 1\n")
    createRepository(dependency, "dependency.ts", "export const value = 1\n")
    git(dependency, "-c", "protocol.file.allow=always", "submodule", "add", "-q", leaf, "apps/leaf")
    git(dependency, "commit", "-q", "-am", "add leaf")
    createRepository(product, "root.ts", "export const root = 1\n")
    const base = git(product, "rev-parse", "HEAD")
    git(product, "-c", "protocol.file.allow=always", "submodule", "add", "-q", dependency, "vendor/dependency")
    git(join(product, "vendor/dependency"), "-c", "protocol.file.allow=always", "submodule", "update", "-q", "--init")
    git(product, "commit", "-q", "-am", "add dependency")

    const result = superDiff({ repo: product, refs: [`${base}..HEAD`] })

    expect(result.paths).toEqual([
      ".gitmodules",
      "vendor/dependency/.gitmodules",
      "vendor/dependency/apps/leaf/leaf.ts",
      "vendor/dependency/dependency.ts",
    ])
  })

  test("refuses an added gitlink whose checkout is not initialized, naming it and its pin", () => {
    const fixture = mkdtempSync(join(tmpdir(), "git-super-added-uninit-"))
    roots.push(fixture)
    const dependency = join(fixture, "dependency")
    const product = join(fixture, "product")
    const clone = join(fixture, "clone")
    createRepository(dependency, "dependency.ts", "export const value = 1\n")
    createRepository(product, "root.ts", "export const root = 1\n")
    const base = git(product, "rev-parse", "HEAD")
    git(fixture, "clone", "-q", product, clone)
    git(product, "-c", "protocol.file.allow=always", "submodule", "add", "-q", dependency, "vendor/dependency")
    git(product, "commit", "-q", "-am", "add dependency")
    const pin = git(product, "rev-parse", "HEAD:vendor/dependency")
    git(clone, "fetch", "-q", "origin")

    expect(() => superDiff({ repo: clone, refs: [`${base}..origin/main`] })).toThrow(
      `vendor/dependency is an added gitlink at ${pin}; its checkout is not initialized`,
    )
  })

  test("refuses a file replaced by a gitlink with its own message", () => {
    const fixture = mkdtempSync(join(tmpdir(), "git-super-file-to-link-"))
    roots.push(fixture)
    const dependency = join(fixture, "dependency")
    const product = join(fixture, "product")
    createRepository(dependency, "dependency.ts", "export const value = 1\n")
    createRepository(product, "linked", "a file at the future gitlink path\n")
    const base = git(product, "rev-parse", "HEAD")
    git(product, "rm", "-q", "linked")
    git(product, "-c", "protocol.file.allow=always", "submodule", "add", "-q", dependency, "linked")
    git(product, "commit", "-q", "-am", "replace the file with a gitlink")

    expect(() => superDiff({ repo: product, refs: [`${base}..HEAD`] })).toThrow(
      "linked changed from a file to a gitlink",
    )
  })

  /**
   * @failure A removed component aborts the whole comparison and hides readable root changes (#27058 AC1/AC4).
   * @level l1
   * @consumer git super diff and deriving comparison consumers
   * @testonly none
   */
  test("reports a removed component without losing readable root changes", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "git-super-removed-link-"))
    roots.push(fixture)
    const dependency = join(fixture, "dependency")
    const product = join(fixture, "product")
    createRepository(dependency, "dependency.ts", "export const value = 1\n")
    createRepository(product, "root.ts", "export const root = 1\n")
    git(product, "-c", "protocol.file.allow=always", "submodule", "add", "-q", dependency, "vendor/dependency")
    git(product, "commit", "-q", "-am", "add dependency")
    const base = git(product, "rev-parse", "HEAD")
    git(product, "rm", "-q", "vendor/dependency")
    writeFileSync(join(product, "root.ts"), "export const root = 2\n")
    git(product, "add", "root.ts")
    git(product, "commit", "-q", "-m", "remove dependency and change root")

    const result = superDiff({ repo: product, refs: [`${base}..HEAD`], stat: true })

    expect(result.paths).toEqual([".gitmodules", "root.ts"])
    expect(result).toMatchObject({
      notCompared: [
        expect.objectContaining({
          path: "vendor/dependency",
          reason: "removed",
          message: "component removed, not compared",
        }),
      ],
    })
    expect(result.consultedRepositories.map(({ path }) => path)).toEqual(["."])
    expect(result.stats?.[0]?.files.map(({ path }) => path)).toEqual([".gitmodules", "root.ts"])
    for (const json of [false, true]) {
      const stdout = outputSink()
      const stderr = outputSink()
      expect(
        await runCli(["--repo", product, ...(json ? ["--json"] : []), "diff", `${base}..HEAD`], stdout, stderr),
      ).toBe(0)
      if (json) {
        expect(JSON.parse(stdout.output)).toMatchObject({ notCompared: result.notCompared })
      } else {
        expect(stdout.output).toContain("root.ts")
        expect(stderr.output).toContain("vendor/dependency: component removed, not compared")
      }
    }
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

describe("superDiff --stat / --patch", () => {
  test("root-only change: no gitlinks moved, root's own stat and patch carry the file", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-diff-stat-root-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const head = advanceRepository(fixture.product, "root.ts", "export const root = 1\n")

    const result = superDiff({
      repo: fixture.product,
      refs: [`${fixture.productBase}..${head}`],
      stat: true,
      patch: true,
    })

    expect(result.stats?.map((s) => s.repository)).toEqual(["."])
    expect(result.stats?.[0]?.files).toEqual([{ path: "root.ts", added: 1, deleted: 0, binary: false }])
    expect(result.stats?.[0]?.totals).toEqual({ files: 1, added: 1, deleted: 0 })
    expect(result.stats?.[0]?.pointerMoves).toEqual([])
    expect(result.stats?.[0]?.range).toEqual({ from: fixture.productBase, to: head })
    expect(result.patches?.[0]?.patch).toContain("root.ts")
  })

  test("one moved gitlink: submodule stat/patch appear, root excludes the pointer bump from its own totals, unmoved beta prints nothing", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-diff-stat-one-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const alphaHead = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 2\n")
    git(join(fixture.product, "packages/alpha"), "fetch", "-q", "origin")
    git(join(fixture.product, "packages/alpha"), "checkout", "-q", alphaHead)
    git(fixture.product, "add", "packages/alpha")
    git(fixture.product, "commit", "-q", "-m", "bump alpha only")
    const head = git(fixture.product, "rev-parse", "HEAD")

    const result = superDiff({
      repo: fixture.product,
      refs: [`${fixture.productBase}..${head}`],
      stat: true,
      patch: true,
    })

    expect(result.stats?.map((s) => s.repository)).toEqual([".", "packages/alpha"])
    expect(result.stats?.some((s) => s.repository === "vendor/beta")).toBe(false)
    const [root, alpha] = result.stats ?? []
    expect(root?.files).toEqual([])
    expect(root?.pointerMoves).toEqual([{ path: "packages/alpha", from: fixture.alphaBase, to: alphaHead }])
    expect(alpha?.range).toEqual({ from: fixture.alphaBase, to: alphaHead })
    expect(alpha?.files).toEqual([{ path: "alpha.ts", added: 1, deleted: 1, binary: false }])
    expect(alpha?.totals).toEqual({ files: 1, added: 1, deleted: 1 })
    expect(alpha?.pointerMoves).toEqual([])
    expect(result.patches?.map((p) => p.repository)).toEqual([".", "packages/alpha"])
    expect(result.patches?.[1]?.patch).toContain("alpha.ts")
  })

  test("two moved gitlinks: both submodule stats appear under the root, totals add up", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-diff-stat-two-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const head = bumpProductSubmodules(fixture)

    const result = superDiff({ repo: fixture.product, refs: [`${fixture.productBase}..${head}`], stat: true })

    expect(result.stats?.map((s) => s.repository)).toEqual([".", "packages/alpha", "vendor/beta"])
    expect(result.stats?.[0]?.pointerMoves.map((m) => m.path).sort()).toEqual(["packages/alpha", "vendor/beta"])
    expect(result.stats?.[0]?.files).toEqual([])
    expect(result.stats?.[1]?.files).toEqual([{ path: "alpha.ts", added: 1, deleted: 1, binary: false }])
    expect(result.stats?.[2]?.files).toEqual([{ path: "new-beta.ts", added: 1, deleted: 0, binary: false }])
  })

  test("a nested gitlink attributes its own pointer move to the middle repository, not the root", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-diff-stat-nested-"))
    roots.push(fixtureRoot)
    const fixture = addNestedAlphaSubmodule(createProductFixture(fixtureRoot))
    const head = bumpNestedAlphaSubmodule(fixture)

    const result = superDiff({ repo: fixture.product, refs: [`${fixture.productWithNestedBase}..${head}`], stat: true })

    expect(result.stats?.map((s) => s.repository)).toEqual([".", "packages/alpha", "packages/alpha/apps/maddoc"])
    expect(result.stats?.[1]?.files).toEqual([])
    expect(result.stats?.[1]?.pointerMoves.map((m) => m.path)).toEqual(["apps/maddoc"])
    expect(result.stats?.[2]?.files).toEqual([{ path: "leaf.ts", added: 1, deleted: 1, binary: false }])
  })

  /**
   * @failure The first missing sibling pin aborts comparison, hiding other missing pins and readable root data (#27058 AC2/AC4).
   * @level l1
   * @consumer git super diff CLI and affected-tests
   * @testonly none
   */
  test("reports every unreadable sibling pin and readable root data before CLI refusal", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-diff-stat-missing-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const alphaHead = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 2\n")
    const betaHead = advanceRepository(fixture.beta, "beta.ts", "export const beta = 2\n")
    const alphaCheckout = join(fixture.product, "packages/alpha")
    const betaCheckout = join(fixture.product, "vendor/beta")
    // Deliberately skip both fetches: neither new object reaches its nested checkout.
    git(fixture.product, "update-index", "--cacheinfo", `160000,${alphaHead},packages/alpha`)
    git(fixture.product, "update-index", "--cacheinfo", `160000,${betaHead},vendor/beta`)
    writeFileSync(join(fixture.product, "root.ts"), "export const root = 1\n")
    git(fixture.product, "add", "root.ts")
    git(fixture.product, "commit", "-q", "-m", "bump two pins without fetching and change root")
    const head = git(fixture.product, "rev-parse", "HEAD")

    const stdout = outputSink()
    const stderr = outputSink()
    const code = await runCli(
      ["--repo", fixture.product, "--json", "diff", "--stat", `${fixture.productBase}..${head}`],
      stdout,
      stderr,
    )

    expect(code).toBe(2)
    expect(stdout.output).toContain("root.ts")
    const result = JSON.parse(stdout.output) as {
      paths: string[]
      consultedRepositories: { path: string }[]
      notCompared: { path: string; reason: string; objectIds: string[]; remedy: string }[]
    }
    expect(result.paths).toEqual(["root.ts"])
    expect(result.consultedRepositories.map(({ path }) => path)).toEqual(["."])
    expect(result.notCompared).toEqual([
      expect.objectContaining({ path: "packages/alpha", reason: "unreadable", objectIds: [alphaHead] }),
      expect.objectContaining({ path: "vendor/beta", reason: "unreadable", objectIds: [betaHead] }),
    ])
    for (const [index, checkout, origin, pin] of [
      [0, alphaCheckout, fixture.alpha, alphaHead],
      [1, betaCheckout, fixture.beta, betaHead],
    ] as const) {
      const remedy = result.notCompared[index]?.remedy
      expect(remedy).toContain(checkout)
      expect(remedy).toContain(origin)
      expect(remedy).toContain("fetch")
      expect(remedy).toContain(`${pin}:refs/git-super/pins/${pin}`)
    }
  })

  test("CLI --json --stat carries the same per-repository split, and plain --json without either flag is unchanged", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-diff-cli-json-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const alphaHead = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 2\n")
    git(join(fixture.product, "packages/alpha"), "fetch", "-q", "origin")
    git(join(fixture.product, "packages/alpha"), "checkout", "-q", alphaHead)
    git(fixture.product, "add", "packages/alpha")
    git(fixture.product, "commit", "-q", "-m", "bump alpha only")
    const head = git(fixture.product, "rev-parse", "HEAD")
    const refs = `${fixture.productBase}..${head}`

    const plainStdout = outputSink()
    const plainStderr = outputSink()
    expect(await runCli(["--repo", fixture.product, "--json", "diff", refs], plainStdout, plainStderr)).toBe(0)
    const plainResult = JSON.parse(plainStdout.output) as Record<string, unknown>
    expect(plainResult.stats).toBeUndefined()
    expect(plainResult.patches).toBeUndefined()
    expect(plainResult.paths).toEqual(["packages/alpha/alpha.ts"])

    const statStdout = outputSink()
    const statStderr = outputSink()
    expect(await runCli(["--repo", fixture.product, "--json", "diff", "--stat", refs], statStdout, statStderr)).toBe(0)
    const statResult = JSON.parse(statStdout.output) as { stats: { repository: string }[] }
    expect(statResult.stats.map((s) => s.repository)).toEqual([".", "packages/alpha"])
  })
})

type DivergentFixture = Readonly<{ product: string; mergeBase: string; leftTip: string }>

/** `main` and `left` share one root commit and then each gain a file the other never sees. */
function createDivergentFixture(fixtureRoot: string): DivergentFixture {
  const product = join(fixtureRoot, "product")
  const mergeBase = createRepository(product, "root.ts", "export const root = 1\n")
  git(product, "checkout", "-q", "-b", "left")
  const leftTip = advanceRepository(product, "left-only.ts", "export const left = 1\n")
  git(product, "checkout", "-q", "main")
  advanceRepository(product, "right-only.ts", "export const right = 1\n")
  return { product, mergeBase, leftTip }
}

describe("superDiff reported range", () => {
  test("a divergent a...b reports the merge base Git measured, never the left branch tip", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-diff-symmetric-"))
    roots.push(fixtureRoot)
    const { product, mergeBase, leftTip } = createDivergentFixture(fixtureRoot)

    const result = superDiff({ repo: product, refs: ["left...main"], stat: true, patch: true })

    // `git diff left...main` measures merge-base(left, main)..main: one right-only addition.
    expect(result.paths).toEqual(["right-only.ts"])
    expect(result.stats?.[0]?.files).toEqual([{ path: "right-only.ts", added: 1, deleted: 0, binary: false }])
    // Reporting {left, main} would additionally claim left-only.ts was deleted — a
    // left-side change no diff in this run ever measured.
    expect(result.stats?.[0]?.range).toEqual({ from: mergeBase, to: "main" })
    expect(result.stats?.[0]?.range?.from).not.toBe(leftTip)
    expect(result.patches?.[0]?.range).toEqual({ from: mergeBase, to: "main" })
    expect(result.patches?.[0]?.patch).not.toContain("left-only.ts")
  })

  test("the range reported for a divergent a...b replays to the files it was measured over", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-diff-symmetric-replay-"))
    roots.push(fixtureRoot)
    const { product } = createDivergentFixture(fixtureRoot)

    const measured = superDiff({ repo: product, refs: ["left...main"], stat: true })
    const range = measured.stats?.[0]?.range
    if (range === undefined) throw new Error("expected a reported range for a two-endpoint request")

    const replay = superDiff({ repo: product, refs: [`${range.from}..${range.to}`], stat: true })

    expect(replay.paths).toEqual(measured.paths)
    expect(replay.stats?.[0]?.files).toEqual(measured.stats?.[0]?.files)
    expect(replay.stats?.[0]?.totals).toEqual(measured.stats?.[0]?.totals)
  })

  test("a two-dot range reports the endpoints it was given, which are the endpoints measured", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-diff-two-dot-"))
    roots.push(fixtureRoot)
    const { product, mergeBase, leftTip } = createDivergentFixture(fixtureRoot)

    const result = superDiff({ repo: product, refs: [`${mergeBase}..left`], stat: true })

    expect(result.stats?.[0]?.range).toEqual({ from: mergeBase, to: "left" })
    expect(result.stats?.[0]?.files).toEqual([{ path: "left-only.ts", added: 1, deleted: 0, binary: false }])
    expect(leftTip).not.toBe(mergeBase)
  })
})

describe("git super diff --stat / --patch human output", () => {
  /** Root file change + one moved submodule (alpha) + one unmoved submodule (beta). */
  function createOneMovedFixture(fixtureRoot: string): {
    fixture: ReturnType<typeof createProductFixture>
    alphaHead: string
    head: string
  } {
    const fixture = createProductFixture(fixtureRoot)
    const alphaHead = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 2\n")
    git(join(fixture.product, "packages/alpha"), "fetch", "-q", "origin")
    git(join(fixture.product, "packages/alpha"), "checkout", "-q", alphaHead)
    writeFileSync(join(fixture.product, "root.ts"), "export const root = 1\n")
    git(fixture.product, "add", "root.ts", "packages/alpha")
    git(fixture.product, "commit", "-q", "-m", "bump alpha and touch root")
    return { fixture, alphaHead, head: git(fixture.product, "rev-parse", "HEAD") }
  }

  test("--stat prints the root stat, the moved submodule under its own header, and nothing for the unmoved one", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-diff-cli-stat-"))
    roots.push(fixtureRoot)
    const { fixture, alphaHead, head } = createOneMovedFixture(fixtureRoot)

    const stdout = outputSink()
    const stderr = outputSink()
    const code = await runCli(
      ["--repo", fixture.product, "diff", "--stat", `${fixture.productBase}..${head}`],
      stdout,
      stderr,
    )

    expect(code).toBe(0)
    expect(stdout.output).toContain("== . ==")
    expect(stdout.output).toContain(" root.ts | +1 -0")
    // The gitlink bump is reported as a pointer move, never counted as a product line.
    expect(stdout.output).toContain(" 1 file changed, 1 insertion(+), 0 deletions(-)")
    expect(stdout.output).toContain(
      ` packages/alpha: pointer ${fixture.alphaBase.slice(0, 7)} -> ${alphaHead.slice(0, 7)}`,
    )
    expect(stdout.output).toContain("== packages/alpha ==")
    expect(stdout.output).toContain(" alpha.ts | +1 -1")
    expect(stdout.output).toContain(" 1 file changed, 1 insertion(+), 1 deletion(-)")
    expect(stdout.output).not.toContain("vendor/beta")
  }, 30_000)

  test("--patch prints the root patch and the moved submodule's own patch, nothing for the unmoved one", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-diff-cli-patch-"))
    roots.push(fixtureRoot)
    const { fixture, head } = createOneMovedFixture(fixtureRoot)

    const stdout = outputSink()
    const stderr = outputSink()
    const code = await runCli(
      ["--repo", fixture.product, "diff", "--patch", `${fixture.productBase}..${head}`],
      stdout,
      stderr,
    )

    expect(code).toBe(0)
    expect(stdout.output).toContain("== . ==")
    expect(stdout.output).toContain("+++ b/root.ts")
    expect(stdout.output).toContain("== packages/alpha ==")
    expect(stdout.output).toContain("+export const alpha = 2")
    expect(stdout.output).not.toContain("vendor/beta")
    expect(stdout.output).not.toContain("beta.ts")
  })

  test("a binary file reports explicit nulls, never a fake zero, and prints Bin", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-diff-binary-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    writeFileSync(join(fixture.alpha, "logo.bin"), new Uint8Array([0, 1, 2, 0, 255]))
    git(fixture.alpha, "add", "logo.bin")
    git(fixture.alpha, "commit", "-q", "-m", "add binary asset")
    const alphaHead = git(fixture.alpha, "rev-parse", "HEAD")
    git(join(fixture.product, "packages/alpha"), "fetch", "-q", "origin")
    git(join(fixture.product, "packages/alpha"), "checkout", "-q", alphaHead)
    git(fixture.product, "add", "packages/alpha")
    git(fixture.product, "commit", "-q", "-m", "bump alpha to the binary asset")
    const head = git(fixture.product, "rev-parse", "HEAD")

    const result = superDiff({ repo: fixture.product, refs: [`${fixture.productBase}..${head}`], stat: true })
    const alpha = result.stats?.find((entry) => entry.repository === "packages/alpha")

    expect(alpha?.files).toEqual([{ path: "logo.bin", added: null, deleted: null, binary: true }])
    expect(alpha?.totals).toEqual({ files: 1, added: 0, deleted: 0 })

    const stdout = outputSink()
    const stderr = outputSink()
    expect(
      await runCli(["--repo", fixture.product, "diff", "--stat", `${fixture.productBase}..${head}`], stdout, stderr),
    ).toBe(0)
    expect(stdout.output).toContain(" logo.bin | Bin")
  })

  test("diff --stat over a dirty submodule lists its changed files under its own repository", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-diff-dirty-submodule-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    writeFileSync(join(fixture.product, "packages/alpha/alpha.ts"), "export const alpha = 999;\n")

    const result = superDiff({ repo: fixture.product, stat: true, patch: true })

    expect(result.paths).toEqual(["packages/alpha/alpha.ts"])
    expect(result.stats?.map((s) => s.repository)).toEqual([".", "packages/alpha"])
    const [root, alpha] = result.stats ?? []
    expect(root?.files).toEqual([])
    expect(root?.pointerMoves).toEqual([])
    expect(alpha?.files).toEqual([{ path: "alpha.ts", added: 1, deleted: 1, binary: false }])
    expect(alpha?.totals).toEqual({ files: 1, added: 1, deleted: 1 })
    expect(alpha?.pointerMoves).toEqual([])

    const stdout = outputSink()
    const stderr = outputSink()
    expect(await runCli(["--repo", fixture.product, "diff", "--stat"], stdout, stderr)).toBe(0)
    expect(stdout.output).toContain("== packages/alpha ==")
    expect(stdout.output).toContain(" alpha.ts | +1 -1")
    expect(stdout.output).toContain(" 1 file changed, 1 insertion(+), 1 deletion(-)")
    expect(stdout.output).not.toContain("pointer")
  })

  test("diff --stat over a submodule dirty only through untracked files names the submodule", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-diff-untracked-submodule-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    writeFileSync(join(fixture.product, "packages/alpha/untracked.ts"), "export const untracked = true;\n")

    const result = superDiff({ repo: fixture.product, stat: true, patch: true })

    expect(result.consultedRepositories.map((r) => r.path)).toEqual([".", "packages/alpha"])
    expect(result.stats?.map((s) => s.repository)).toEqual([".", "packages/alpha"])
    const [root, alpha] = result.stats ?? []
    expect(root?.files).toEqual([])
    expect(root?.pointerMoves).toEqual([])
    expect(alpha?.files).toEqual([])
    expect(alpha?.totals).toEqual({ files: 0, added: 0, deleted: 0 })
    expect(alpha?.pointerMoves).toEqual([])
    expect(alpha?.untrackedOnly).toBe(true)

    const stdout = outputSink()
    const stderr = outputSink()
    expect(await runCli(["--repo", fixture.product, "diff", "--stat"], stdout, stderr)).toBe(0)
    expect(stdout.output).toContain("== packages/alpha ==")
    expect(stdout.output).toContain("dirty (untracked files only)")
    expect(stderr.output).toContain("✓  packages/alpha")
  })
})

type PublishedComponentFixture = ProductFixture & Readonly<{ publishedBeta: string; publishedMain: string }>

/**
 * 29363: beta's main gains a PUBLISHED commit and the product's main lands it, so the product's `origin/main` pins
 * beta at that commit while the task branch's fork point (`productBase`) still pins `betaBase`. Composition then
 * advances the branch's beta pin onto the published main exactly as the queue does, without the author touching
 * beta. Measured from the fork point, that pin move reads as the author's change to `published-beta.ts`.
 */
function createPublishedComponentFixture(fixtureRoot: string): PublishedComponentFixture {
  const fixture = createProductFixture(fixtureRoot)
  const publishedBeta = advanceRepository(fixture.beta, "published-beta.ts", "export const published = 1\n")
  const betaCheckout = join(fixture.product, "vendor/beta")
  git(betaCheckout, "fetch", "-q", "origin")
  git(betaCheckout, "checkout", "-q", publishedBeta)
  git(fixture.product, "add", "vendor/beta")
  git(fixture.product, "commit", "-q", "-m", "land beta: published-beta.ts")
  const publishedMain = git(fixture.product, "rev-parse", "HEAD")
  git(fixture.product, "update-ref", "refs/remotes/origin/main", publishedMain)
  // The task branch forks from productBase; its index pins beta at betaBase while the checkout stays at the
  // published commit, so the next `git add vendor/beta` is the composition step.
  git(fixture.product, "checkout", "-q", "-b", "task", fixture.productBase)
  return { ...fixture, publishedBeta, publishedMain }
}

describe("superDiff --component-base (29363: published component changes are not the author's)", () => {
  /**
   * @failure A native three-dot component delta already at the selected target reads as branch-authored scope.
   * @level l1
   * @consumer 30108 CLI scope review and public ConsultedRepository target comparison
   * @testonly none
   */
  test.each(["at-target", "authored"] as const)(
    "three-dot scope distinguishes a component %s without changing native products (30108)",
    async (mode) => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-three-dot-target-"))
      roots.push(fixtureRoot)
      const fixture = createPublishedComponentFixture(fixtureRoot)
      if (mode === "authored") {
        advanceRepository(join(fixture.product, "vendor/beta"), "authored-beta.ts", "export const authored = 1\n")
      }
      writeFileSync(join(fixture.product, "authored.ts"), "export const authored = 1\n")
      git(fixture.product, "add", "authored.ts", "vendor/beta")
      git(fixture.product, "commit", "-q", "-m", "root work with composed beta")
      const head = git(fixture.product, "rev-parse", "HEAD")
      const refs = ["origin/main..." + head]
      const actual = superDiff({ repo: fixture.product, refs, stat: true, patch: true })
      const native = superDiff({
        repo: fixture.product,
        refs: [fixture.productBase + ".." + head],
        stat: true,
        patch: true,
      })
      expect(actual.paths).toEqual(native.paths)
      expect(actual.deletedPaths).toEqual(native.deletedPaths)
      expect(actual.stats).toEqual(native.stats)
      expect(actual.patches).toEqual(native.patches)
      expect(Object.keys(actual.stats?.[0]?.range ?? {}).sort()).toEqual(["from", "to"])
      expect(actual.notCompared).toEqual([])
      const beta = actual.consultedRepositories.find(({ path }) => path === "vendor/beta")
      if (mode === "at-target") {
        expect(beta).toMatchObject({
          targetComparison: { kind: "at-target", target: "origin/main", commit: fixture.publishedMain },
        })
      } else {
        expect(actual.paths).toContain("vendor/beta/authored-beta.ts")
        expect(beta).not.toHaveProperty("targetComparison")
      }

      const stdout = outputSink()
      const stderr = outputSink()
      expect(await runCli(["--repo", fixture.product, "diff", "--stat", ...refs], stdout, stderr)).toBe(0)
      if (mode === "at-target") {
        expect(stdout.output).toMatch(/== vendor\/beta[^\n]*already in origin\/main[^\n]*==/u)
      } else {
        expect(stdout.output).not.toContain("already in origin/main")
        expect(stdout.output).toContain("authored-beta.ts")
      }

      const names = outputSink()
      expect(await runCli(["--repo", fixture.product, "diff", "--name-only", "-z", ...refs], names, outputSink())).toBe(
        0,
      )
      expect(names.output).toBe(native.paths.map((path) => path + "\0").join(""))
    },
  )

  /**
   * @failure The scoped fix measures a moved gitlink from the branch's fork-point pin, so the published component
   * commits composition pulled under the branch select their suites as if authored (10 files reached 74 suites, 8 min).
   * @level l1
   * @consumer km fix-scoped.sh committed scope (27381), via git super diff --component-base origin/main
   * @testonly none
   */
  test("N authored root paths plus a gitlink advanced to the already-published component main select only the N root paths", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-diff-component-base-"))
    roots.push(fixtureRoot)
    const fixture = createPublishedComponentFixture(fixtureRoot)
    writeFileSync(join(fixture.product, "authored.ts"), "export const authored = 1\n")
    git(fixture.product, "add", "authored.ts", "vendor/beta")
    git(fixture.product, "commit", "-q", "-m", "authored root change, beta composed onto its published main")
    const head = git(fixture.product, "rev-parse", "HEAD")

    // Today's reading, kept as the control: from the fork point the published beta file is the branch's change.
    const forkPoint = superDiff({ repo: fixture.product, refs: [`${fixture.productBase}..${head}`] })
    expect(forkPoint.paths).toEqual(["authored.ts", "vendor/beta/published-beta.ts"])

    const composed = superDiff({
      repo: fixture.product,
      refs: [`${fixture.productBase}..${head}`],
      componentBase: "origin/main",
    })
    expect(composed.paths).toEqual(["authored.ts"])
    // The component was consulted, over the composed base: nothing between the published pin and itself.
    expect(composed.consultedRepositories.map(({ path }) => path)).toEqual([".", "vendor/beta"])
    expect(composed.consultedRepositories.find(({ path }) => path === "vendor/beta")).toEqual({
      path: "vendor/beta",
      root: join(fixture.product, "vendor/beta"),
      from: fixture.publishedBeta,
      to: fixture.publishedBeta,
    })
    expect(composed.notCompared).toEqual([])
  })

  test("an authored component commit on top of the published main selects exactly its own files", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-diff-component-base-authored-"))
    roots.push(fixtureRoot)
    const fixture = createPublishedComponentFixture(fixtureRoot)
    const betaCheckout = join(fixture.product, "vendor/beta")
    const authoredBeta = advanceRepository(betaCheckout, "authored-beta.ts", "export const authored = 1\n")
    writeFileSync(join(fixture.product, "authored.ts"), "export const authored = 1\n")
    git(fixture.product, "add", "authored.ts", "vendor/beta")
    git(fixture.product, "commit", "-q", "-m", "authored root and beta changes over the published main")
    const head = git(fixture.product, "rev-parse", "HEAD")

    const composed = superDiff({
      repo: fixture.product,
      refs: [`${fixture.productBase}..${head}`],
      componentBase: "origin/main",
    })
    expect(composed.paths).toEqual(["authored.ts", "vendor/beta/authored-beta.ts"])
    expect(composed.consultedRepositories.find(({ path }) => path === "vendor/beta")).toEqual({
      path: "vendor/beta",
      root: betaCheckout,
      from: fixture.publishedBeta,
      to: authoredBeta,
    })

    // The CLI carries the same option, and the committed-scope caller reads NUL-terminated names.
    const stdout = outputSink()
    const stderr = outputSink()
    expect(
      await runCli(
        [
          "--repo",
          fixture.product,
          "diff",
          "--name-only",
          "-z",
          "--component-base",
          "origin/main",
          `${fixture.productBase}..${head}`,
        ],
        stdout,
        stderr,
      ),
    ).toBe(0)
    expect(stdout.output.split("\0").filter(Boolean)).toEqual(["authored.ts", "vendor/beta/authored-beta.ts"])
  })

  test("a gitlink the base ref does not record keeps its empty-tree expansion: every file of an added component is the branch's", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-diff-component-base-added-"))
    roots.push(fixtureRoot)
    const fixture = createPublishedComponentFixture(fixtureRoot)
    const gamma = join(fixtureRoot, "gamma")
    createRepository(gamma, "gamma.ts", "export const gamma = 1\n")
    git(fixture.product, "-c", "protocol.file.allow=always", "submodule", "add", "-q", gamma, "vendor/gamma")
    git(fixture.product, "add", "vendor/beta")
    git(fixture.product, "commit", "-q", "-m", "add gamma, beta composed onto its published main")
    const head = git(fixture.product, "rev-parse", "HEAD")

    const composed = superDiff({
      repo: fixture.product,
      refs: [`${fixture.productBase}..${head}`],
      componentBase: "origin/main",
    })
    expect(composed.paths).toEqual([".gitmodules", "vendor/gamma/gamma.ts"])
    expect(composed.consultedRepositories.find(({ path }) => path === "vendor/gamma")?.from).toBe(EMPTY_TREE)
  })

  test("a nested gitlink is measured from the pin the parent's PUBLISHED tree records, not from the parent's fork-point tree", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-diff-component-base-nested-"))
    roots.push(fixtureRoot)
    // Fork point: alpha carries the leaf at leafBase. Published: the leaf bumps, alpha pins it, the product lands it.
    const nested = addNestedAlphaSubmodule(createProductFixture(fixtureRoot))
    const forkPoint = nested.productWithNestedBase
    const alphaCheckout = join(nested.product, "packages/alpha")
    const leafCheckout = join(alphaCheckout, "apps/maddoc")
    const alphaAtFork = git(nested.product, "rev-parse", `${forkPoint}:packages/alpha`)
    const publishedMain = bumpNestedAlphaSubmodule(nested)
    git(nested.product, "update-ref", "refs/remotes/origin/main", publishedMain)
    const alphaPublished = git(nested.product, "rev-parse", "origin/main:packages/alpha")
    const leafPublished = git(alphaCheckout, "rev-parse", `${alphaPublished}:apps/maddoc`)
    // The branch: alpha authored on top of its FORK pin (not composed), but its leaf authored on top of the
    // PUBLISHED leaf. Only the parent's published tree says the leaf's published bump is not the author's.
    git(nested.product, "checkout", "-q", "-b", "task", forkPoint)
    git(alphaCheckout, "checkout", "-q", alphaAtFork)
    const leafAuthored = advanceRepository(leafCheckout, "authored-leaf.ts", "export const authoredLeaf = 1\n")
    writeFileSync(join(alphaCheckout, "authored-alpha.ts"), "export const authoredAlpha = 1\n")
    git(alphaCheckout, "add", "authored-alpha.ts", "apps/maddoc")
    git(alphaCheckout, "commit", "-q", "-m", "authored alpha change, leaf composed onto its published main")
    const alphaAuthored = git(alphaCheckout, "rev-parse", "HEAD")
    writeFileSync(join(nested.product, "authored.ts"), "export const authored = 1\n")
    git(nested.product, "add", "authored.ts", "packages/alpha")
    git(nested.product, "commit", "-q", "-m", "authored root change")
    const head = git(nested.product, "rev-parse", "HEAD")

    const composed = superDiff({
      repo: nested.product,
      refs: [`${forkPoint}..${head}`],
      componentBase: "origin/main",
    })
    expect(composed.paths).toEqual([
      "authored.ts",
      "packages/alpha/apps/maddoc/authored-leaf.ts",
      "packages/alpha/authored-alpha.ts",
    ])
    expect(composed.consultedRepositories.find(({ path }) => path === "packages/alpha")).toMatchObject({
      from: alphaAtFork,
      to: alphaAuthored,
    })
    expect(composed.consultedRepositories.find(({ path }) => path === "packages/alpha/apps/maddoc")).toMatchObject({
      from: leafPublished,
      to: leafAuthored,
    })
    // The control: from the fork-point tree the leaf's published bump (leaf.ts) reads as the author's.
    expect(superDiff({ repo: nested.product, refs: [`${forkPoint}..${head}`] }).paths).toContain(
      "packages/alpha/apps/maddoc/leaf.ts",
    )
  })

  test("a published pin the component checkout cannot read refuses with exit 2 and a remedy naming that pin", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-diff-component-base-unreadable-"))
    roots.push(fixtureRoot)
    const fixture = createPublishedComponentFixture(fixtureRoot)
    // Beta's main moves again, and the product's main records that pin without the checkout ever fetching it.
    const publishedBeta2 = advanceRepository(fixture.beta, "published-beta-2.ts", "export const published = 2\n")
    git(fixture.product, "checkout", "-q", "main")
    git(fixture.product, "update-index", "--cacheinfo", `160000,${publishedBeta2},vendor/beta`)
    git(fixture.product, "commit", "-q", "-m", "land beta: published-beta-2.ts")
    git(fixture.product, "update-ref", "refs/remotes/origin/main", git(fixture.product, "rev-parse", "HEAD"))
    git(fixture.product, "checkout", "-q", "task")
    writeFileSync(join(fixture.product, "authored.ts"), "export const authored = 1\n")
    git(fixture.product, "add", "authored.ts", "vendor/beta")
    git(fixture.product, "commit", "-q", "-m", "authored root change, beta composed onto the earlier published pin")
    const head = git(fixture.product, "rev-parse", "HEAD")

    const stdout = outputSink()
    const stderr = outputSink()
    expect(
      await runCli(
        ["--repo", fixture.product, "diff", "--component-base", "origin/main", `${fixture.productBase}..${head}`],
        stdout,
        stderr,
      ),
    ).toBe(2)
    expect(stderr.output).toContain(publishedBeta2)
    expect(stderr.output).toContain(`${publishedBeta2}:refs/`)
    const result = superDiff({
      repo: fixture.product,
      refs: [`${fixture.productBase}..${head}`],
      componentBase: "origin/main",
    })
    expect(result.notCompared).toMatchObject([
      { path: "vendor/beta", reason: "unreadable", objectIds: [publishedBeta2] },
    ])
    expect(result.paths).toEqual(["authored.ts"])
  })

  test("the option is defined for a committed two-endpoint range only; other forms refuse by name", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-diff-component-base-form-"))
    roots.push(fixtureRoot)
    const fixture = createPublishedComponentFixture(fixtureRoot)
    git(fixture.product, "add", "vendor/beta")
    git(fixture.product, "commit", "-q", "-m", "beta composed onto its published main")
    const head = git(fixture.product, "rev-parse", "HEAD")
    for (const [form, options] of [
      ["a working-tree comparison", {}],
      ["an index comparison (--cached)", { cached: true }],
      [`a single ref (${head})`, { refs: [head] }],
      ["3 refs", { refs: [fixture.productBase, head, head] }],
    ] as const) {
      expect(() => superDiff({ repo: fixture.product, componentBase: "origin/main", ...options })).toThrow(
        `not for ${form}`,
      )
    }
    expect(() =>
      superDiff({ repo: fixture.product, componentBase: "no-such-ref", refs: [`${fixture.productBase}..${head}`] }),
    ).toThrow("--component-base no-such-ref does not resolve")
    // The three accepted forms measure the same thing.
    const twoDot = superDiff({
      repo: fixture.product,
      componentBase: "origin/main",
      refs: [`${fixture.productBase}..${head}`],
    })
    const pair = superDiff({ repo: fixture.product, componentBase: "origin/main", refs: [fixture.productBase, head] })
    expect(pair.paths).toEqual(twoDot.paths)
  })
})
