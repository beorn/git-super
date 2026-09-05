import { afterEach, describe, expect, test } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { superDiff } from "../src/diff.ts"
import { runCli } from "../src/cli.ts"
import {
  addNestedAlphaSubmodule,
  advanceRepository,
  bumpNestedAlphaSubmodule,
  bumpProductSubmodules,
  createProductFixture,
  createRepository,
  git,
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

  test("one moved gitlink: component stat/patch appear, root excludes the pointer bump from its own totals, unmoved beta prints nothing", () => {
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

  test("two moved gitlinks: both component stats appear under the root, totals add up", () => {
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

  test("a gitlink whose target commit is absent locally fails loud naming the repository and the missing sha", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-diff-stat-missing-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const alphaHead = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 2\n")
    const alphaCheckout = join(fixture.product, "packages/alpha")
    // Deliberately skip fetch/checkout: alphaHead's object never reaches the nested checkout.
    git(fixture.product, "update-index", "--cacheinfo", `160000,${alphaHead},packages/alpha`)
    git(fixture.product, "commit", "-q", "-m", "bump alpha pin without fetching")
    const head = git(fixture.product, "rev-parse", "HEAD")

    let thrown: unknown
    try {
      superDiff({ repo: fixture.product, refs: [`${fixture.productBase}..${head}`], stat: true })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    const message = (thrown as Error).message
    expect(message).toContain(alphaCheckout)
    expect(message).toContain(alphaHead)
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
  /** Root file change + one moved component (alpha) + one unmoved component (beta). */
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

  test("--stat prints the root stat, the moved component under its own header, and nothing for the unmoved one", async () => {
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
  })

  test("--patch prints the root patch and the moved component's own patch, nothing for the unmoved one", async () => {
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
})
