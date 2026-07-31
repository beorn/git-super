import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveInvocation } from "@silvery/command"
import { commands } from "../src/commands.ts"
import { runCli } from "../src/cli.ts"
import { superIsAncestor } from "../src/merge-base.ts"
import { superStatus } from "../src/status.ts"
import { bumpProductSubmodules, createProductFixture, git } from "./fixture.ts"

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
    const json = JSON.parse(jsonOut.output)
    expect(json.paths).toEqual(["packages/alpha/alpha.ts", "vendor/beta/new-beta.ts"])
    expect(json.consultedRepositories.map(({ path }: { path: string }) => path)).toEqual([
      ".",
      "packages/alpha",
      "vendor/beta",
    ])
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
