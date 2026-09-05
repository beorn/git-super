import { afterEach, describe, expect, test } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveInvocation } from "@silvery/command"
import { commands } from "../src/commands.ts"
import { runCli } from "../src/cli.ts"
import { superIsAncestor } from "../src/merge-base.ts"
import { superStatus } from "../src/status.ts"
import {
  addNestedAlphaSubmodule,
  advanceRepository,
  bumpProductSubmodules,
  createProductFixture,
  git,
} from "./fixture.ts"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function outputSink(): { output: string; write(value: string): void } {
  return {
    output: "",
    write(value) {
      this.output += value
    },
  }
}

describe("Phase 1 read commands", () => {
  test("routes help to stdout without contaminating stderr", async () => {
    const stdout = outputSink()
    const stderr = outputSink()

    expect(await runCli(["-h"], stdout, stderr)).toBe(0)
    expect(stdout.output).toContain("Usage: git super [options] [command]")
    expect(stderr.output).toBe("")
  })

  test("status prefixes tracked and untracked changes inside every checked-out submodule", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-status-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    writeFileSync(join(fixture.product, "packages/alpha", "new-alpha.ts"), "export const added = true\n")
    writeFileSync(join(fixture.product, "vendor/beta", "beta.ts"), "export const beta = 3\n")

    const result = superStatus({ repo: fixture.product })

    expect(result.records).toEqual(["?? packages/alpha/new-alpha.ts", " M vendor/beta/beta.ts"])
    expect(result.consultedRepositories.map(({ path }) => path)).toEqual([".", "packages/alpha", "vendor/beta"])
  })

  test("status recursively expands a dirty file inside a nested submodule", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-nested-status-"))
    roots.push(fixtureRoot)
    const fixture = addNestedAlphaSubmodule(createProductFixture(fixtureRoot))
    writeFileSync(join(fixture.product, "packages/alpha/apps/maddoc/leaf.ts"), "export const leaf = 2\n")

    const result = superStatus({ repo: fixture.product })

    expect(result.records).toEqual([" M packages/alpha/apps/maddoc/leaf.ts"])
    expect(result.consultedRepositories.map(({ path }) => path)).toEqual([
      ".",
      "packages/alpha",
      "packages/alpha/apps/maddoc",
      "vendor/beta",
    ])
  })

  test("status fails loudly when a nested submodule checkout is missing", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-nested-missing-"))
    roots.push(fixtureRoot)
    const fixture = addNestedAlphaSubmodule(createProductFixture(fixtureRoot))
    rmSync(join(fixture.product, "packages/alpha/apps/maddoc"), { recursive: true, force: true })

    expect(() => superStatus({ repo: fixture.product })).toThrow("rev-parse --show-toplevel failed")
  })

  test("merge-base finds the repository that owns a sha and compares against the ref's pin", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-ancestor-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const productHead = bumpProductSubmodules(fixture)

    const result = superIsAncestor({
      repo: fixture.product,
      ancestor: fixture.alphaBase,
      descendant: productHead,
    })

    expect(result.isAncestor).toBe(true)
    expect(result.owningRepository).toBe("packages/alpha")
    expect(result.comparedTo).not.toBe(productHead)
  })

  test("status expands a staged gitlink pin instead of returning the opaque submodule path", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-staged-pin-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const alphaHead = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 4\n")
    git(join(fixture.product, "packages/alpha"), "fetch", "-q", "origin")
    git(join(fixture.product, "packages/alpha"), "checkout", "-q", alphaHead)
    git(fixture.product, "add", "packages/alpha")

    expect(superStatus({ repo: fixture.product }).records).toEqual(["M  packages/alpha/alpha.ts"])
  })

  test("still answers in the superproject for a commit the superproject's own refs reach", () => {
    // The other half of the ownership rule, and the regression the fix could
    // plausibly have caused: tightening "the root has the object" to "the root
    // REACHES the object" must not stop the root answering for its own history.
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-root-owned-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const productHead = bumpProductSubmodules(fixture)

    const result = superIsAncestor({
      repo: fixture.product,
      ancestor: fixture.productBase,
      descendant: productHead,
    })

    expect(result.owningRepository).toBe(".")
    expect(result.comparedTo).toBe(productHead)
    expect(result.isAncestor).toBe(true)
  })

  test("does not answer in the superproject when a submodule sha also sits in the root object store", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-leaked-object-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const productHead = bumpProductSubmodules(fixture)

    // THE PRECONDITION, and the reason this defect hides. A superproject's
    // object store can hold its submodules' commits — /hh's does — so
    // `cat-file -e <submodule sha>` succeeds at the ROOT and the resolver
    // concludes the root owns it. Reproduced by fetching alpha's history into
    // the product store, because a fixture without it cannot fail for this.
    git(fixture.product, "-c", "protocol.file.allow=always", "fetch", "-q", "--no-tags", fixture.alpha, "main")
    expect(git(fixture.product, "cat-file", "-t", `${fixture.alphaBase}^{commit}`)).toBe("commit")

    const result = superIsAncestor({
      repo: fixture.product,
      ancestor: fixture.alphaBase,
      descendant: productHead,
    })

    // Answering in "." compares an alpha commit against a product commit —
    // unrelated histories — and returns a confident FALSE. That is the
    // dangerous direction: it reports landed work as NOT landed, and it is
    // what manufactured a "km-revert" finding against a clean rescue ref.
    expect(result.owningRepository).toBe("packages/alpha")
    expect(result.isAncestor).toBe(true)
  })

  test("merge-base refuses when no consulted repository owns the commit", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-missing-owner-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)

    expect(() =>
      superIsAncestor({
        repo: fixture.product,
        ancestor: "f".repeat(40),
        descendant: fixture.productBase,
      }),
    ).toThrow("no consulted repository owns commit")
  })

  test("merge-base resolves a ref name in the named repository, not in a nested submodule that carries the same name", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-ref-name-ancestor-"))
    roots.push(fixtureRoot)
    const fixture = addNestedAlphaSubmodule(createProductFixture(fixtureRoot))
    const alphaCheckout = join(fixture.product, "packages/alpha")
    const alphaHead = git(alphaCheckout, "rev-parse", "HEAD")

    // THE PRECONDITION: the named repository and its nested submodule BOTH
    // resolve `origin/main`, to unrelated commits. A ref name is not an
    // object id; searching the name across the consulted repositories found
    // an owner in each and refused as ambiguous, so a comparison against a
    // ref name failed in every repository with a nested submodule.
    expect(git(alphaCheckout, "rev-parse", "--verify", "origin/main")).toBe(alphaHead)
    expect(git(join(alphaCheckout, "apps/maddoc"), "rev-parse", "--verify", "origin/main")).toBe(fixture.leafBase)

    const result = superIsAncestor({ repo: alphaCheckout, ancestor: "origin/main", descendant: alphaHead })

    expect(result.owningRepository).toBe(".")
    expect(result.comparedTo).toBe(alphaHead)
    expect(result.isAncestor).toBe(true)
  })

  test("merge-base refuses, by name, a ref the named repository does not resolve", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-ref-name-missing-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)

    expect(() =>
      superIsAncestor({ repo: fixture.product, ancestor: "origin/no-such-branch", descendant: fixture.productBase }),
    ).toThrow("origin/no-such-branch is not an object id and does not resolve in")
  })

  test("dispatches through the Silvery command tree and preserves JSON and NUL output parity", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-cli-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const productHead = bumpProductSubmodules(fixture)
    const range = `${fixture.productBase}..${productHead}`

    const invocation = resolveInvocation(commands.diff, { repo: fixture.product }, { refs: [range] })
    expect(invocation.state).toBe("ready")

    const jsonOut = outputSink()
    const jsonErr = outputSink()
    expect(await runCli(["--repo", fixture.product, "diff", "--name-only", range, "--json"], jsonOut, jsonErr)).toBe(0)
    const json = JSON.parse(jsonOut.output) as {
      paths: string[]
      consultedRepositories: Array<{ path: string }>
    }
    expect(json.paths).toEqual(["packages/alpha/alpha.ts", "vendor/beta/new-beta.ts"])
    expect(json.consultedRepositories.map(({ path }) => path)).toEqual([".", "packages/alpha", "vendor/beta"])
    expect(jsonErr.output).toBe("")

    const nulOut = outputSink()
    const report = outputSink()
    expect(await runCli(["--repo", fixture.product, "diff", "--name-only", "-z", range], nulOut, report)).toBe(0)
    expect(nulOut.output).toBe("packages/alpha/alpha.ts\0vendor/beta/new-beta.ts\0")
    expect(report.output).toContain("Consulted repositories")
    expect(report.output).toContain("packages/alpha")
    expect(report.output).toContain("vendor/beta")
  })

  test("composes --cached and --diff-filter with ordinary diff semantics", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-diff-flags-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    writeFileSync(join(fixture.product, "root.ts"), "export const root = true\n")
    git(fixture.product, "add", "root.ts")

    const cached = await commands.diff.run({ repo: fixture.product }, { refs: [], cached: true, diffFilter: "A" })

    expect(cached.paths).toEqual(["root.ts"])
  })
})
