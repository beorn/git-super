/**
 * @failure Gitlink writers duplicate raw index plumbing, move a submodule checkout, or quietly accept a non-gitlink path or unavailable commit.
 * @level l1
 * @consumer @i/10-merge-queue/git-super-one-layer F1 and Yrd composition callers
 * @reach fs-walk <fixture-only: createProductFixture under mkdtempSync(canonicalTmpdir())>
 */

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import { runCli } from "../src/cli.ts"
import { acquireExclusive } from "../src/exclusive.ts"
import { writeGitlink } from "../src/gitlink.ts"
import { composeGitlinkCarrier } from "../src/gitlink-carrier.ts"
import { createLocalGitProcess, type GitProcess } from "../src/process.ts"
import { advanceRepository, canonicalTmpdir as tmpdir, createProductFixture, git, injectionProbe } from "./fixture.ts"

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

/**
 * Two deterministic blob contents whose object IDs share the same four hex characters, so Git
 * itself calls that prefix "ambiguous". The bodies are fixed and the search is bounded, so the
 * collision is the same every run and a failure to find one throws rather than silently testing
 * nothing (#28554).
 */
function collidingBlobPair(): { prefix: string; contents: readonly [string, string] } {
  const seen = new Map<string, string>()
  for (let index = 0; index < 4_000; index++) {
    const content = `ambiguous ${index}\n`
    const prefix = createHash("sha1")
      .update(`blob ${Buffer.byteLength(content)}\0`)
      .update(content)
      .digest("hex")
      .slice(0, 4)
    const first = seen.get(prefix)
    if (first !== undefined) return { prefix, contents: [first, content] }
    seen.set(prefix, content)
  }
  throw new Error("no 4-hex blob collision among 4000 deterministic contents")
}

function writeBlob(repository: string, content: string): void {
  const written = spawnSync("git", ["-C", repository, "hash-object", "-w", "--stdin"], {
    input: content,
    encoding: "utf8",
  })
  if (written.status !== 0) throw new Error(`git hash-object failed: ${written.stderr}`)
}

function fetchWithoutCheckout(repository: string, path: string, commit: string): string {
  const checkout = join(repository, path)
  const before = git(checkout, "rev-parse", "HEAD")
  git(checkout, "fetch", "-q", "origin", commit)
  expect(git(checkout, "rev-parse", "HEAD")).toBe(before)
  return before
}

describe("policy-free gitlink writes", () => {
  test("builds a two-pin carrier on an exact parent without touching the caller index or checkout", async () => {
    const product = fixture("carrier-exact-tree")
    const alphaNext = advanceRepository(product.alpha, "alpha.ts", "export const alpha = 8\n")
    const betaNext = advanceRepository(product.beta, "beta.ts", "export const beta = 8\n")
    fetchWithoutCheckout(product.product, "packages/alpha", alphaNext)
    fetchWithoutCheckout(product.product, "vendor/beta", betaNext)
    const indexBefore = git(product.product, "ls-files", "--stage")
    const statusBefore = git(product.product, "status", "--porcelain")

    const carrier = await composeGitlinkCarrier({
      repo: product.product,
      base: product.productBase,
      pins: [
        { path: "packages/alpha", commit: alphaNext },
        { path: "vendor/beta", commit: betaNext },
      ],
      message: "carry two pins\n\nRefs: 25804\n",
    })

    expect(git(product.product, "rev-list", "--parents", "-n", "1", carrier.commit)).toBe(
      `${carrier.commit} ${product.productBase}`,
    )
    expect(git(product.product, "ls-tree", carrier.commit, "packages/alpha")).toBe(
      `160000 commit ${alphaNext}\tpackages/alpha`,
    )
    expect(git(product.product, "ls-tree", carrier.commit, "vendor/beta")).toBe(
      `160000 commit ${betaNext}\tvendor/beta`,
    )
    expect(git(product.product, "diff-tree", "--no-commit-id", "--name-only", "-r", carrier.commit)).toBe(
      "packages/alpha\nvendor/beta",
    )
    expect(git(product.product, "ls-files", "--stage")).toBe(indexBefore)
    expect(git(product.product, "status", "--porcelain")).toBe(statusBefore)
  })

  test("keeps malformed index records visible without changing the established error prefix", async () => {
    const product = fixture("malformed-index-record")
    const path = "packages/alpha"
    const malformed = `160000 invalid-object 0\t${path}`
    const indexBefore = stage(product.product, path)
    const local = createLocalGitProcess()
    const probe = injectionProbe()

    const result = await writeGitlink({
      repo: product.product,
      path,
      commit: product.alphaBase,
      git: {
        run: async (request) => {
          probe.observe(request)
          if (request.args[0] === "ls-files") {
            probe.fire("malformed index record")
            return { code: 0, stdout: `${malformed}\0`, stderr: "" }
          }
          return local.run(request)
        },
      },
    })

    probe.expectFired("malformed index record")
    expect(result).toMatchObject({
      state: "failed",
      partial: false,
      detail: {
        code: "invalid-index-entry",
        phase: "observe-index",
        remedy: "Inspect the index with `git ls-files --stage` and repair it before retrying.",
        paths: [path],
      },
    })
    expect(
      result.detail?.message.startsWith(`Git returned an invalid index entry while inspecting ${product.product}.`),
    ).toBe(true)
    expect(result.detail?.message).toContain(JSON.stringify(malformed))
    expect(result.detail?.evidence).toContain(JSON.stringify(malformed))
    expect(stage(product.product, path)).toBe(indexBefore)
  })

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

  test("reports a malformed submodule declaration instead of treating it as a missing checkout", async () => {
    const product = fixture("malformed-gitmodules")
    const before = stage(product.product, "packages/alpha")
    rmSync(join(product.product, "packages/alpha"), { recursive: true, force: true })
    writeFileSync(join(product.product, ".gitmodules"), '[submodule "broken"\n')

    const result = await writeGitlink({ repo: product.product, path: "packages/alpha", commit: product.alphaBase })

    expect(result).toMatchObject({
      state: "failed",
      partial: false,
      detail: {
        code: "git-failed",
        phase: "locate-submodule-store",
        paths: ["packages/alpha"],
        objectIds: [product.alphaBase],
      },
    })
    expect(stage(product.product, "packages/alpha")).toBe(before)
  })

  test("uses the common-dir object store when the scratch worktree has no submodule checkout", async () => {
    const product = fixture("common-store")
    const next = advanceRepository(product.alpha, "alpha.ts", "export const alpha = 6\n")
    fetchWithoutCheckout(product.product, "packages/alpha", next)
    rmSync(join(product.product, "packages/alpha"), { recursive: true, force: true })

    const result = await writeGitlink({ repo: product.product, path: "packages/alpha", commit: next })

    expect(result, JSON.stringify(result)).toMatchObject({ state: "updated", partial: false })
    expect(stage(product.product, "packages/alpha")).toBe(`160000 ${next} 0\tpackages/alpha`)
  })

  test("rejects invalid paths and object IDs before invoking Git", async () => {
    const neverGit: GitProcess = {
      run: () => Promise.reject(new Error("Git must not run for invalid input")),
    }

    await expect(
      writeGitlink({ repo: ".", path: "dep", commit: "not-an-object", git: neverGit }),
    ).resolves.toMatchObject({ state: "failed", detail: { code: "invalid-commit", phase: "validate-commit" } })
    await expect(
      writeGitlink({ repo: ".", path: "../dep", commit: "a".repeat(40), git: neverGit }),
    ).resolves.toMatchObject({ state: "failed", detail: { code: "invalid-gitlink-path", phase: "validate-gitlink" } })
  })

  test("reports unknown when the index cannot be observed after Git accepts the write", async () => {
    const product = fixture("post-write-observation")
    const next = advanceRepository(product.alpha, "alpha.ts", "export const alpha = 7\n")
    fetchWithoutCheckout(product.product, "packages/alpha", next)
    const local = createLocalGitProcess()
    let indexReads = 0
    const injected: GitProcess = {
      async run(request) {
        const result = await local.run(request)
        if (request.args[0] === "ls-files" && ++indexReads === 2) {
          return { ...result, code: 2, stderr: "observation failed" }
        }
        return result
      },
    }

    const result = await writeGitlink({ repo: product.product, path: "packages/alpha", commit: next, git: injected })

    expect(result).toMatchObject({
      state: "unknown",
      partial: false,
      detail: { code: "post-write-observation-failed", phase: "observe-index" },
    })
    expect(stage(product.product, "packages/alpha")).toBe(`160000 ${next} 0\tpackages/alpha`)
  })

  test("waits for the shared mutation lock before changing the index", async () => {
    const product = fixture("mutation-lock")
    const next = advanceRepository(product.alpha, "alpha.ts", "export const alpha = 8\n")
    fetchWithoutCheckout(product.product, "packages/alpha", next)
    const common = git(product.product, "rev-parse", "--git-common-dir")
    const commonDirectory = isAbsolute(common) ? common : resolve(product.product, common)
    const lock = await acquireExclusive(join(commonDirectory, "yrd-worktree-mutations"))

    const pending = writeGitlink({ repo: product.product, path: "packages/alpha", commit: next })
    await Bun.sleep(25)
    expect(stage(product.product, "packages/alpha")).toBe(`160000 ${product.alphaBase} 0\tpackages/alpha`)
    lock.release()

    await expect(pending).resolves.toMatchObject({ state: "updated", partial: false })
  })

  // @failure A gitlink write given an abbreviated commit silently leaves the index at the old
  //          pin while answering "updated" — the no-op @dev/3 reported for a short sha (#28554).
  // @level l1
  // @consumer @hh/tooling/28554: callers that advance a submodule pin by an abbreviated object ID
  test("resolves an abbreviated commit to the full object id, and the printed result matches the index", async () => {
    const product = fixture("abbreviated-commit")
    const next = advanceRepository(product.alpha, "alpha.ts", "export const alpha = 9\n")
    fetchWithoutCheckout(product.product, "packages/alpha", next)
    const abbreviated = next.slice(0, 10)
    expect(abbreviated).not.toBe(next)
    const stdout = outputSink()
    const stderr = outputSink()

    expect(
      await runCli(["--repo", product.product, "gitlink", "write", "packages/alpha", abbreviated], stdout, stderr),
    ).toBe(0)
    expect(stderr.output).toBe("")
    expect(stdout.output).toBe("updated\n")
    // The abbreviation is resolved IN the submodule repository, so the index carries the FULL id.
    expect(stage(product.product, "packages/alpha")).toBe(`160000 ${next} 0\tpackages/alpha`)
  })

  // @failure An abbreviation that names no commit refuses without naming the command form that
  //          produces the accepted input, so the caller cannot act on the refusal (#28554).
  // @level l1
  // @consumer @hh/tooling/28554 refusal breadcrumb (NO SILENT ERRORS, docs/principles.md)
  test("refuses an abbreviated commit that resolves to no commit, naming the full-sha command form", async () => {
    const product = fixture("abbreviated-missing")
    const before = stage(product.product, "packages/alpha")
    const stdout = outputSink()
    const stderr = outputSink()

    expect(
      await runCli(["--repo", product.product, "gitlink", "write", "packages/alpha", "0000000"], stdout, stderr),
    ).toBe(2)
    expect(stdout.output).toBe("failed\n")
    // Breadcrumb: the refusal names the full-sha requirement AND the command that prints it.
    expect(stderr.output).toContain("rev-parse")
    expect(stderr.output).toContain("bun git-super --repo <dir> gitlink write packages/alpha <full-oid>")
    expect(stage(product.product, "packages/alpha")).toBe(before)
  })

  // @failure An abbreviated object ID that names SEVERAL objects in the submodule refuses, but the
  //          caller is not told which form works and Git's own ambiguity is discarded, so "names
  //          several" and "names none" read identically (#28554).
  // @level l1
  // @consumer @hh/tooling/28554 ambiguous-prefix refusal path
  test("refuses an ambiguous abbreviated commit, naming the working form and Git's own evidence", async () => {
    const product = fixture("abbreviated-ambiguous")
    const { prefix, contents } = collidingBlobPair()
    const submodule = join(product.product, "packages/alpha")
    for (const content of contents) writeBlob(submodule, content)
    const before = stage(product.product, "packages/alpha")
    const stdout = outputSink()
    const stderr = outputSink()

    expect(
      await runCli(["--repo", product.product, "gitlink", "write", "packages/alpha", prefix, "--json"], stdout, stderr),
    ).toBe(2)
    expect(stderr.output).toBe("")
    const result = JSON.parse(stdout.output) as {
      state?: string
      detail?: { code?: string; phase?: string; message?: string; evidence?: string }
    }
    expect(result).toMatchObject({ state: "failed", detail: { code: "invalid-commit", phase: "resolve-commit" } })
    expect(result.detail?.message).toContain("does not resolve to exactly one commit")
    expect(result.detail?.message).toContain("bun git-super --repo <dir> gitlink write packages/alpha <full-oid>")
    // Git's own words survive into the refusal: the ambiguity is visible, not just the failure.
    expect(result.detail?.evidence).toContain(prefix)
    expect(result.detail?.evidence).toMatch(/ambiguous/iu)
    expect(stage(product.product, "packages/alpha")).toBe(before)
  })
})
