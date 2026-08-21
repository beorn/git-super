/**
 * @failure Gitlink writers duplicate raw index plumbing, move a submodule checkout, or quietly accept a non-gitlink path or unavailable commit.
 * @level l1
 * @consumer @i/10-merge-queue/git-super-one-layer F1 and Yrd composition callers
 */

import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import { runCli } from "../src/cli.ts"
import { writeGitlink } from "../src/gitlink.ts"
import { advanceRepository, canonicalTmpdir as tmpdir, createProductFixture, git } from "./fixture.ts"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(name: string) {
  const root = mkdtempSync(join(tmpdir(), `git-super-gitlink-${name}-`))
  roots.push(root)
  return createProductFixture(root)
}

function outputSink(): { output: string; write(value: string): void } {
  return {
    output: "",
    write(value) {
      this.output += value
    },
  }
}

function stage(repository: string, path: string): string {
  return git(repository, "ls-files", "--stage", "--", path)
}

function fetchWithoutCheckout(repository: string, path: string, commit: string): string {
  const checkout = join(repository, path)
  const before = git(checkout, "rev-parse", "HEAD")
  git(checkout, "fetch", "-q", "origin", commit)
  expect(git(checkout, "rev-parse", "HEAD")).toBe(before)
  return before
}

describe("policy-free gitlink writes", () => {
  test("writes the exact index pin without moving the submodule checkout and reports idempotence", async () => {
    const product = fixture("library")
    const next = advanceRepository(product.alpha, "alpha.ts", "export const alpha = 2\n")
    const checkoutBefore = fetchWithoutCheckout(product.product, "packages/alpha", next)

    const written = await writeGitlink({ repo: product.product, path: "packages/alpha", commit: next })

    expect(written).toMatchObject({
      state: "updated",
      partial: false,
      repositories: [{ repository: product.product, state: "updated", refs: [] }],
    })
    expect(stage(product.product, "packages/alpha")).toBe(`160000 ${next} 0\tpackages/alpha`)
    expect(git(join(product.product, "packages/alpha"), "rev-parse", "HEAD")).toBe(checkoutBefore)

    await expect(writeGitlink({ repo: product.product, path: "packages/alpha", commit: next })).resolves.toMatchObject({
      state: "unchanged",
      partial: false,
    })
  })

  test("resolves an all-gitlink index conflict to one stage-zero pin", async () => {
    const product = fixture("conflict")
    const next = advanceRepository(product.alpha, "alpha.ts", "export const alpha = 4\n")
    fetchWithoutCheckout(product.product, "packages/alpha", next)
    git(product.product, "update-index", "--force-remove", "--", "packages/alpha")
    const indexInfo = [
      `160000 ${product.alphaBase} 1\tpackages/alpha`,
      `160000 ${product.alphaBase} 2\tpackages/alpha`,
      `160000 ${next} 3\tpackages/alpha`,
      "",
    ].join("\n")
    const seeded = Bun.spawnSync(["git", "-C", product.product, "update-index", "--index-info"], {
      stdin: new Blob([indexInfo]),
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(seeded.exitCode, seeded.stderr.toString()).toBe(0)

    const result = await writeGitlink({ repo: product.product, path: "packages/alpha", commit: next })
    expect(result, JSON.stringify(result)).toMatchObject({ state: "updated", partial: false })
    expect(stage(product.product, "packages/alpha")).toBe(`160000 ${next} 0\tpackages/alpha`)
  })

  test("exposes the noun/sub-verb grammar through help and JSON output", async () => {
    const product = fixture("cli")
    const next = advanceRepository(product.alpha, "alpha.ts", "export const alpha = 3\n")
    fetchWithoutCheckout(product.product, "packages/alpha", next)
    const help = outputSink()
    const helpErrors = outputSink()

    expect(await runCli(["gitlink", "--help"], help, helpErrors)).toBe(0)
    expect(help.output).toContain("write <path> <commit>")
    expect(helpErrors.output).toBe("")

    const stdout = outputSink()
    const stderr = outputSink()
    expect(
      await runCli(["--repo", product.product, "gitlink", "write", "packages/alpha", next, "--json"], stdout, stderr),
    ).toBe(0)
    expect(stderr.output).toBe("")
    expect(JSON.parse(stdout.output)).toMatchObject({ state: "updated", partial: false })
    expect(stage(product.product, "packages/alpha")).toBe(`160000 ${next} 0\tpackages/alpha`)
  })

  test("fails loudly when the path is not already a gitlink", async () => {
    const product = fixture("not-gitlink")
    const before = stage(product.product, ".gitmodules")
    const stdout = outputSink()
    const stderr = outputSink()

    expect(
      await runCli(
        ["--repo", product.product, "gitlink", "write", ".gitmodules", product.alphaBase, "--json"],
        stdout,
        stderr,
      ),
    ).toBe(2)
    expect(stderr.output).toBe("")
    expect(JSON.parse(stdout.output)).toMatchObject({
      state: "failed",
      partial: false,
      detail: {
        code: "not-gitlink",
        phase: "validate-gitlink",
        paths: [".gitmodules"],
        objectIds: [product.alphaBase],
      },
    })
    expect(stage(product.product, ".gitmodules")).toBe(before)
  })

  test("fails loudly when the exact commit is absent from the submodule repository", async () => {
    const product = fixture("missing-commit")
    const missing = "f".repeat(40)
    const before = stage(product.product, "packages/alpha")
    const stdout = outputSink()
    const stderr = outputSink()

    expect(
      await runCli(
        ["--repo", product.product, "gitlink", "write", "packages/alpha", missing, "--json"],
        stdout,
        stderr,
      ),
    ).toBe(2)
    expect(stderr.output).toBe("")
    const result = JSON.parse(stdout.output) as {
      detail?: { code?: string; phase?: string; paths?: string[]; objectIds?: string[]; remedy?: string }
      partial?: boolean
      state?: string
    }
    expect(result).toMatchObject({
      state: "failed",
      partial: false,
      detail: {
        code: "submodule-commit-missing",
        phase: "validate-commit",
        paths: ["packages/alpha"],
        objectIds: [missing],
      },
    })
    expect(result.detail?.remedy).toMatch(/fetch/iu)
    expect(stage(product.product, "packages/alpha")).toBe(before)
  })
})
