import { afterEach, describe, expect, test } from "vitest"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { runCli } from "../src/cli.ts"
import { acquireExclusive, createExclusive } from "../src/exclusive.ts"
import { createLocalGitProcess, type GitProcess } from "../src/process.ts"
import { superPull } from "../src/pull.ts"
import {
  addNestedAlphaSubmodule,
  advanceRepository,
  bumpNestedAlphaSubmodule,
  bumpProductSubmodules,
  canonicalTmpdir as tmpdir,
  createProductFixture,
  createRepository,
  git,
} from "./fixture.ts"

const roots: string[] = []
const gitSuperBin = fileURLToPath(new URL("../bin/git-super", import.meta.url))

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

describe("git super pull --ff-only", () => {
  test("uses the configured upstream when repository and refspec are omitted", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "git-super-pull-upstream-"))
    roots.push(fixture)
    const upstream = join(fixture, "upstream")
    const checkout = join(fixture, "checkout")
    createRepository(upstream, "README.md", "one\n")
    git(upstream, "branch", "-m", "trunk")
    git(fixture, "clone", "-q", upstream, checkout)
    git(checkout, "remote", "rename", "origin", "source")
    git(checkout, "branch", "-m", "work")
    const target = advanceRepository(upstream, "README.md", "two\n")
    const stdout = outputSink()
    const stderr = outputSink()

    const exitCode = await runCli(["--repo", checkout, "pull", "--ff-only", "--json"], stdout, stderr)

    expect(exitCode).toBe(0)
    expect(stderr.output).toBe("")
    expect(git(checkout, "rev-parse", "HEAD")).toBe(target)
    expect(JSON.parse(stdout.output)).toMatchObject({ state: "updated", partial: false })
  })

  test("fails loudly when an omitted refspec has no configured upstream", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "git-super-pull-no-upstream-"))
    roots.push(fixture)
    const upstream = join(fixture, "upstream")
    const checkout = join(fixture, "checkout")
    createRepository(upstream, "README.md", "one\n")
    git(fixture, "clone", "-q", upstream, checkout)
    git(checkout, "branch", "--unset-upstream")
    const before = git(checkout, "rev-parse", "HEAD")
    const stdout = outputSink()
    const stderr = outputSink()

    const exitCode = await runCli(["--repo", checkout, "pull", "--ff-only", "--json"], stdout, stderr)

    expect(exitCode).toBe(2)
    expect(stderr.output).toBe("")
    expect(git(checkout, "rev-parse", "HEAD")).toBe(before)
    expect(JSON.parse(stdout.output)).toMatchObject({
      state: "failed",
      partial: false,
      detail: { code: "configured-upstream-required", phase: "resolve-default-target" },
    })
  })

  test("fast-forwards a SHA-256 repository", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "git-super-pull-sha256-"))
    roots.push(fixture)
    const upstream = join(fixture, "upstream")
    const checkout = join(fixture, "checkout")
    git(fixture, "init", "-q", "--object-format=sha256", "-b", "main", upstream)
    writeFileSync(join(upstream, "README.md"), "one\n")
    git(upstream, "add", "README.md")
    git(upstream, "commit", "-q", "-m", "add README")
    git(fixture, "clone", "-q", upstream, checkout)
    const target = advanceRepository(upstream, "README.md", "two\n")
    const stdout = outputSink()
    const stderr = outputSink()

    const exitCode = await runCli(["--repo", checkout, "pull", "--ff-only", "origin", "main", "--json"], stdout, stderr)

    expect(exitCode).toBe(0)
    expect(stderr.output).toBe("")
    expect(target).toHaveLength(64)
    expect(git(checkout, "rev-parse", "HEAD")).toBe(target)
    expect(JSON.parse(stdout.output)).toMatchObject({ state: "updated", partial: false })
  })

  test("fast-forwards a clean standalone clone with a structured result", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "git-super-pull-"))
    roots.push(fixture)
    const upstream = join(fixture, "upstream")
    const checkout = join(fixture, "checkout")
    createRepository(upstream, "README.md", "one\n")
    git(fixture, "clone", "-q", upstream, checkout)
    const target = advanceRepository(upstream, "README.md", "two\n")
    const before = git(checkout, "rev-parse", "HEAD")
    const stdout = outputSink()
    const stderr = outputSink()

    const exitCode = await runCli(["--repo", checkout, "pull", "--ff-only", "origin", "main", "--json"], stdout, stderr)

    expect(exitCode).toBe(0)
    expect(stderr.output).toBe("")
    expect(git(checkout, "rev-parse", "HEAD")).toBe(target)
    expect(JSON.parse(stdout.output)).toEqual({
      partial: false,
      repositories: [
        {
          refs: [{ destination: "HEAD", source: target, state: "updated" }],
          repository: checkout,
          state: "updated",
        },
      ],
      state: "updated",
    })
    expect(before).not.toBe(target)
  })

  test("peels an annotated tag target to its commit without FETCH_HEAD", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "git-super-pull-annotated-tag-"))
    roots.push(fixture)
    const upstream = join(fixture, "upstream")
    const checkout = join(fixture, "checkout")
    createRepository(upstream, "README.md", "one\n")
    git(fixture, "clone", "-q", upstream, checkout)
    const target = advanceRepository(upstream, "README.md", "two\n")
    git(upstream, "tag", "-a", "release", "-m", "release", target)

    const result = await superPull({
      repo: checkout,
      repository: "origin",
      refspecs: ["refs/tags/release"],
      ffOnly: true,
    })

    expect(result).toMatchObject({
      state: "updated",
      partial: false,
      repositories: [{ refs: [{ source: target, destination: "HEAD", state: "updated" }] }],
    })
    expect(git(checkout, "rev-parse", "HEAD")).toBe(target)
  })

  test("freezes and applies every exact gitlink in the target root", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-pull-product-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const checkout = join(fixtureRoot, "checkout")
    git(
      fixtureRoot,
      "-c",
      "protocol.file.allow=always",
      "clone",
      "-q",
      "--recurse-submodules",
      fixture.product,
      checkout,
    )
    const target = bumpProductSubmodules(fixture)
    const alphaTarget = git(fixture.product, "rev-parse", `${target}:packages/alpha`)
    const betaTarget = git(fixture.product, "rev-parse", `${target}:vendor/beta`)
    const stdout = outputSink()
    const stderr = outputSink()

    const exitCode = await runCli(["--repo", checkout, "pull", "--ff-only", "origin", "main", "--json"], stdout, stderr)

    expect(exitCode).toBe(0)
    expect(stderr.output).toBe("")
    expect(git(checkout, "rev-parse", "HEAD")).toBe(target)
    expect(git(join(checkout, "packages/alpha"), "rev-parse", "HEAD")).toBe(alphaTarget)
    expect(git(join(checkout, "vendor/beta"), "rev-parse", "HEAD")).toBe(betaTarget)
    const result = JSON.parse(stdout.output) as {
      state: string
      repositories: Array<{ repository: string; state: string }>
    }
    expect(result.state).toBe("updated")
    expect(result.repositories).toEqual([
      { repository: checkout, state: "updated", refs: [{ destination: "HEAD", source: target, state: "updated" }] },
      {
        repository: join(checkout, "packages/alpha"),
        state: "updated",
        refs: [{ destination: "HEAD", source: alphaTarget, state: "updated" }],
      },
      {
        repository: join(checkout, "vendor/beta"),
        state: "updated",
        refs: [{ destination: "HEAD", source: betaTarget, state: "updated" }],
      },
    ])
  })

  test("reports an unchanged root without touching it", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "git-super-pull-unchanged-"))
    roots.push(fixture)
    const upstream = join(fixture, "upstream")
    const checkout = join(fixture, "checkout")
    const head = createRepository(upstream, "README.md", "one\n")
    git(fixture, "clone", "-q", upstream, checkout)
    const stdout = outputSink()
    const stderr = outputSink()

    expect(await runCli(["--repo", checkout, "pull", "--ff-only", "origin", "main", "--json"], stdout, stderr)).toBe(0)
    expect(stderr.output).toBe("")
    expect(git(checkout, "rev-parse", "HEAD")).toBe(head)
    expect(JSON.parse(stdout.output)).toMatchObject({ state: "unchanged", partial: false })
  })

  test("preserves an unrelated tracked root edit", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "git-super-pull-dirty-root-"))
    roots.push(fixture)
    const upstream = join(fixture, "upstream")
    const checkout = join(fixture, "checkout")
    createRepository(upstream, "README.md", "one\n")
    writeFileSync(join(upstream, "local.txt"), "base\n")
    git(upstream, "add", "local.txt")
    git(upstream, "commit", "-q", "-m", "add local file")
    git(fixture, "clone", "-q", upstream, checkout)
    writeFileSync(join(checkout, "local.txt"), "kept locally\n")
    const target = advanceRepository(upstream, "README.md", "two\n")
    const stdout = outputSink()
    const stderr = outputSink()

    expect(await runCli(["--repo", checkout, "pull", "--ff-only", "origin", "main", "--json"], stdout, stderr)).toBe(0)
    expect(stderr.output).toBe("")
    expect(git(checkout, "rev-parse", "HEAD")).toBe(target)
    expect(readFileSync(join(checkout, "local.txt"), "utf8")).toBe("kept locally\n")
    expect(git(checkout, "status", "--short")).toBe("M local.txt")
  })

  test.each([
    ["tracked", false],
    ["staged", true],
  ] as const)("refuses an overlapping %s edit before moving HEAD", async (_kind, staged) => {
    const fixture = mkdtempSync(join(tmpdir(), `git-super-pull-overlap-${staged ? "staged" : "tracked"}-`))
    roots.push(fixture)
    const upstream = join(fixture, "upstream")
    const checkout = join(fixture, "checkout")
    const before = createRepository(upstream, "README.md", "one\n")
    git(fixture, "clone", "-q", upstream, checkout)
    writeFileSync(join(checkout, "README.md"), "local\n")
    if (staged) git(checkout, "add", "README.md")
    advanceRepository(upstream, "README.md", "remote\n")
    const stdout = outputSink()
    const stderr = outputSink()

    expect(await runCli(["--repo", checkout, "pull", "--ff-only", "origin", "main", "--json"], stdout, stderr)).toBe(2)
    expect(stderr.output).toBe("")
    expect(git(checkout, "rev-parse", "HEAD")).toBe(before)
    expect(readFileSync(join(checkout, "README.md"), "utf8")).toBe("local\n")
    expect(JSON.parse(stdout.output)).toMatchObject({ state: "failed", partial: false })
  })

  test("refuses an overlapping untracked path before moving HEAD", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "git-super-pull-overlap-untracked-"))
    roots.push(fixture)
    const upstream = join(fixture, "upstream")
    const checkout = join(fixture, "checkout")
    const before = createRepository(upstream, "README.md", "one\n")
    git(fixture, "clone", "-q", upstream, checkout)
    writeFileSync(join(checkout, "new.txt"), "local\n")
    advanceRepository(upstream, "new.txt", "remote\n")
    const stdout = outputSink()
    const stderr = outputSink()

    expect(await runCli(["--repo", checkout, "pull", "--ff-only", "origin", "main", "--json"], stdout, stderr)).toBe(2)
    expect(stderr.output).toBe("")
    expect(git(checkout, "rev-parse", "HEAD")).toBe(before)
    expect(readFileSync(join(checkout, "new.txt"), "utf8")).toBe("local\n")
    expect(JSON.parse(stdout.output)).toMatchObject({ state: "failed", partial: false })
  })

  test("refuses ignored operator bytes that an incoming tracked path would overwrite", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "git-super-pull-overlap-ignored-"))
    roots.push(fixture)
    const upstream = join(fixture, "upstream")
    const checkout = join(fixture, "checkout")
    createRepository(upstream, ".gitignore", "ignored.txt\n")
    const before = git(upstream, "rev-parse", "HEAD")
    git(fixture, "clone", "-q", upstream, checkout)
    writeFileSync(join(checkout, "ignored.txt"), "operator bytes\n")
    writeFileSync(join(upstream, "ignored.txt"), "remote bytes\n")
    git(upstream, "add", "-f", "ignored.txt")
    git(upstream, "commit", "-q", "-m", "track formerly ignored file")
    const stdout = outputSink()
    const stderr = outputSink()

    expect(await runCli(["--repo", checkout, "pull", "--ff-only", "origin", "main", "--json"], stdout, stderr)).toBe(2)
    expect(git(checkout, "rev-parse", "HEAD")).toBe(before)
    expect(readFileSync(join(checkout, "ignored.txt"), "utf8")).toBe("operator bytes\n")
    expect(JSON.parse(stdout.output)).toMatchObject({
      state: "failed",
      partial: false,
      detail: { code: "ignored-path-collision", phase: "preflight-tree-transition" },
    })
  })

  test("refuses divergent root history without merging or rebasing", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "git-super-pull-divergent-"))
    roots.push(fixture)
    const upstream = join(fixture, "upstream")
    const checkout = join(fixture, "checkout")
    createRepository(upstream, "README.md", "one\n")
    git(fixture, "clone", "-q", upstream, checkout)
    const local = advanceRepository(checkout, "local.txt", "local\n")
    advanceRepository(upstream, "remote.txt", "remote\n")
    const stdout = outputSink()
    const stderr = outputSink()

    expect(await runCli(["--repo", checkout, "pull", "--ff-only", "origin", "main", "--json"], stdout, stderr)).toBe(2)
    expect(git(checkout, "rev-parse", "HEAD")).toBe(local)
    expect(git(checkout, "log", "-1", "--format=%s")).toBe("update local.txt")
    expect(JSON.parse(stdout.output)).toMatchObject({
      state: "failed",
      detail: { code: "non-fast-forward", phase: "prove-root-ancestry" },
    })
  })

  test("preserves an unrelated edit inside a changed submodule", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-pull-dirty-submodule-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const checkout = join(fixtureRoot, "checkout")
    git(
      fixtureRoot,
      "-c",
      "protocol.file.allow=always",
      "clone",
      "-q",
      "--recurse-submodules",
      fixture.product,
      checkout,
    )
    const localPath = join(checkout, "packages/alpha", "local-only.ts")
    writeFileSync(localPath, "export const local = true\n")
    const target = bumpProductSubmodules(fixture)
    const stdout = outputSink()
    const stderr = outputSink()

    expect(await runCli(["--repo", checkout, "pull", "--ff-only", "origin", "main", "--json"], stdout, stderr)).toBe(0)
    expect(stderr.output).toBe("")
    expect(git(checkout, "rev-parse", "HEAD")).toBe(target)
    expect(readFileSync(localPath, "utf8")).toBe("export const local = true\n")
    expect(git(join(checkout, "packages/alpha"), "status", "--short")).toBe("?? local-only.ts")
  })

  test("freezes and applies nested target gitlinks before mutating the root", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-pull-nested-"))
    roots.push(fixtureRoot)
    const fixture = addNestedAlphaSubmodule(createProductFixture(fixtureRoot))
    const checkout = join(fixtureRoot, "checkout")
    git(
      fixtureRoot,
      "-c",
      "protocol.file.allow=always",
      "clone",
      "-q",
      "--recurse-submodules",
      fixture.product,
      checkout,
    )
    const target = bumpNestedAlphaSubmodule(fixture)
    const alphaTarget = git(fixture.product, "rev-parse", `${target}:packages/alpha`)
    git(fixture.alpha, "fetch", "-q", join(fixture.product, "packages/alpha"), alphaTarget)
    git(fixture.alpha, "tag", "nested-target", alphaTarget)
    const leafTarget = git(join(fixture.product, "packages/alpha"), "rev-parse", `${alphaTarget}:apps/maddoc`)
    const stdout = outputSink()
    const stderr = outputSink()

    expect(await runCli(["--repo", checkout, "pull", "--ff-only", "origin", "main", "--json"], stdout, stderr)).toBe(0)
    expect(stderr.output).toBe("")
    expect(git(checkout, "rev-parse", "HEAD")).toBe(target)
    expect(git(join(checkout, "packages/alpha"), "rev-parse", "HEAD")).toBe(alphaTarget)
    expect(git(join(checkout, "packages/alpha/apps/maddoc"), "rev-parse", "HEAD")).toBe(leafTarget)
    expect((JSON.parse(stdout.output) as { repositories: unknown[] }).repositories).toHaveLength(4)
  })

  test("accepts a detached commit contained in the incoming pin despite stale local refs", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-pull-stale-refs-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const checkout = join(fixtureRoot, "checkout")
    git(
      fixtureRoot,
      "-c",
      "protocol.file.allow=always",
      "clone",
      "-q",
      "--recurse-submodules",
      fixture.product,
      checkout,
    )
    const alphaCheckout = join(checkout, "packages/alpha")
    const intermediate = advanceRepository(fixture.alpha, "intermediate.ts", "export const intermediate = true\n")
    git(alphaCheckout, "fetch", "--no-tags", "origin", intermediate)
    git(alphaCheckout, "checkout", "--detach", intermediate)
    const target = bumpProductSubmodules(fixture)
    const alphaTarget = git(fixture.alpha, "rev-parse", "HEAD")
    expect(git(alphaCheckout, "for-each-ref", "--format=%(refname)", "--contains", intermediate)).toBe("")
    expect(git(alphaCheckout, "rev-parse", "origin/main")).toBe(fixture.alphaBase)
    const local = createLocalGitProcess()
    for (const injectedFailure of [
      { code: 128, stdout: "", stderr: "cannot read commit graph" },
      { code: 1, stdout: "", stderr: "cannot start git", failure: "cannot start git" },
    ]) {
      let ancestryFailureInjected = false
      const failed = await superPull({
        repo: checkout,
        repository: "origin",
        refspecs: ["main"],
        ffOnly: true,
        git: {
          run(request) {
            if (request.repo === alphaCheckout && request.args[0] === "merge-base") {
              ancestryFailureInjected = true
              return Promise.resolve(injectedFailure)
            }
            return local.run(request)
          },
        },
      })
      expect(ancestryFailureInjected).toBe(true)
      expect(failed).toMatchObject({
        state: "failed",
        detail: { code: "git-failed", phase: "prove-submodule-ancestry" },
      })
      expect(git(checkout, "rev-parse", "HEAD")).toBe(fixture.productBase)
      expect(git(alphaCheckout, "rev-parse", "HEAD")).toBe(intermediate)
    }
    const stdout = outputSink()
    const stderr = outputSink()

    expect(await runCli(["--repo", checkout, "pull", "--ff-only", "origin", "main", "--json"], stdout, stderr)).toBe(0)
    expect(stderr.output).toBe("")
    expect(git(checkout, "rev-parse", "HEAD")).toBe(target)
    expect(git(alphaCheckout, "rev-parse", "HEAD")).toBe(alphaTarget)
    expect(git(alphaCheckout, "merge-base", "--is-ancestor", intermediate, "HEAD")).toBe("")
  })

  test("protects an unpublished detached submodule commit before moving the root", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-pull-detached-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const checkout = join(fixtureRoot, "checkout")
    git(
      fixtureRoot,
      "-c",
      "protocol.file.allow=always",
      "clone",
      "-q",
      "--recurse-submodules",
      fixture.product,
      checkout,
    )
    const alphaCheckout = join(checkout, "packages/alpha")
    const unpublished = advanceRepository(alphaCheckout, "unpublished.ts", "export const unpublished = true\n")
    const before = git(checkout, "rev-parse", "HEAD")
    bumpProductSubmodules(fixture)
    const stdout = outputSink()
    const stderr = outputSink()

    expect(await runCli(["--repo", checkout, "pull", "--ff-only", "origin", "main", "--json"], stdout, stderr)).toBe(2)
    expect(git(checkout, "rev-parse", "HEAD")).toBe(before)
    expect(git(alphaCheckout, "rev-parse", "HEAD")).toBe(unpublished)
    expect(JSON.parse(stdout.output)).toMatchObject({
      state: "failed",
      partial: false,
      detail: {
        code: "unpublished-detached-submodule",
        phase: "protect-submodule-head",
        remedy: `In ${alphaCheckout}, run: git branch preserve/detached-${unpublished} ${unpublished}. Then rerun git super pull.`,
      },
    })
  })

  test("reports a missing recorded submodule commit before moving the root", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-pull-missing-submodule-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const checkout = join(fixtureRoot, "checkout")
    git(
      fixtureRoot,
      "-c",
      "protocol.file.allow=always",
      "clone",
      "-q",
      "--recurse-submodules",
      fixture.product,
      checkout,
    )
    const before = git(checkout, "rev-parse", "HEAD")
    bumpProductSubmodules(fixture)
    git(join(checkout, "packages/alpha"), "remote", "set-url", "origin", join(fixtureRoot, "missing-alpha"))
    const stdout = outputSink()
    const stderr = outputSink()

    expect(await runCli(["--repo", checkout, "pull", "--ff-only", "origin", "main", "--json"], stdout, stderr)).toBe(2)
    expect(git(checkout, "rev-parse", "HEAD")).toBe(before)
    expect(JSON.parse(stdout.output)).toMatchObject({
      state: "failed",
      partial: false,
      detail: { code: "git-failed", phase: "fetch-exact-commit" },
    })
  })

  test("refuses when the requested remote target changes after planning", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "git-super-pull-target-race-"))
    roots.push(fixture)
    const upstream = join(fixture, "upstream")
    const checkout = join(fixture, "checkout")
    const before = createRepository(upstream, "README.md", "one\n")
    git(fixture, "clone", "-q", upstream, checkout)
    advanceRepository(upstream, "README.md", "two\n")
    const local = createLocalGitProcess()
    let advanced = false
    const racing: GitProcess = {
      async run(request) {
        const result = await local.run(request)
        if (!advanced && request.args.join(" ") === "rev-parse --git-common-dir") {
          advanceRepository(upstream, "README.md", "three\n")
          advanced = true
        }
        return result
      },
    }

    const result = await superPull({
      repo: checkout,
      repository: "origin",
      refspecs: ["main"],
      ffOnly: true,
      git: racing,
    })

    expect(advanced).toBe(true)
    expect(git(checkout, "rev-parse", "HEAD")).toBe(before)
    expect(result).toMatchObject({
      state: "failed",
      partial: false,
      detail: { code: "target-changed", phase: "recheck-root-target" },
    })
  })

  test("does not rely on process-global FETCH_HEAD after fetching the root target", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "git-super-pull-fetch-head-race-"))
    roots.push(fixture)
    const upstream = join(fixture, "upstream")
    const checkout = join(fixture, "checkout")
    createRepository(upstream, "README.md", "one\n")
    git(fixture, "clone", "-q", upstream, checkout)
    const target = advanceRepository(upstream, "README.md", "two\n")
    const local = createLocalGitProcess()
    let disrupted = false
    const racing: GitProcess = {
      async run(request) {
        const result = await local.run(request)
        // FETCH_HEAD is shared mutable repository state; another fetch may replace or remove it between Git calls.
        if (!disrupted && request.repo === checkout && request.args[0] === "fetch") {
          rmSync(join(checkout, ".git", "FETCH_HEAD"), { force: true })
          disrupted = true
        }
        return result
      },
    }

    const result = await superPull({
      repo: checkout,
      repository: "origin",
      refspecs: ["main"],
      ffOnly: true,
      git: racing,
    })

    expect(disrupted).toBe(true)
    expect(result).toMatchObject({ state: "updated", partial: false })
    expect(git(checkout, "rev-parse", "HEAD")).toBe(target)
  })

  test("does not turn a target-manifest read failure into an empty submodule graph", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "git-super-pull-manifest-failure-"))
    roots.push(fixture)
    const upstream = join(fixture, "upstream")
    const checkout = join(fixture, "checkout")
    const before = createRepository(upstream, "README.md", "one\n")
    git(fixture, "clone", "-q", upstream, checkout)
    advanceRepository(upstream, "README.md", "two\n")
    const local = createLocalGitProcess()
    const failing: GitProcess = {
      async run(request) {
        if (request.args[0] === "ls-tree" && request.args.at(-1) === ".gitmodules") {
          return { code: 77, stdout: "", stderr: "injected target manifest read failure" }
        }
        return local.run(request)
      },
    }

    const result = await superPull({
      repo: checkout,
      repository: "origin",
      refspecs: ["main"],
      ffOnly: true,
      git: failing,
    })

    expect(git(checkout, "rev-parse", "HEAD")).toBe(before)
    expect(result).toMatchObject({
      state: "failed",
      partial: false,
      detail: { code: "git-failed", phase: "read-target-manifest" },
    })
  })

  test("bounds every Git subprocess through the shared process port", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "git-super-pull-timeout-"))
    roots.push(fixture)
    const upstream = join(fixture, "upstream")
    const checkout = join(fixture, "checkout")
    createRepository(upstream, "README.md", "one\n")
    git(fixture, "clone", "-q", upstream, checkout)
    advanceRepository(upstream, "README.md", "two\n")
    const local = createLocalGitProcess()
    const timeouts: Array<number | undefined> = []
    const recording: GitProcess = {
      async run(request) {
        timeouts.push(request.timeoutMs)
        return local.run(request)
      },
    }

    const result = await superPull({
      repo: checkout,
      repository: "origin",
      refspecs: ["main"],
      ffOnly: true,
      timeoutMs: 1234,
      git: recording,
    })

    expect(result.state).toBe("updated")
    expect(timeouts.length).toBeGreaterThan(0)
    expect(new Set(timeouts)).toEqual(new Set([1234]))
  })

  test("reports mutation lock contention without moving HEAD", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "git-super-pull-lock-"))
    roots.push(fixture)
    const upstream = join(fixture, "upstream")
    const checkout = join(fixture, "checkout")
    const before = createRepository(upstream, "README.md", "one\n")
    git(fixture, "clone", "-q", upstream, checkout)
    advanceRepository(upstream, "README.md", "two\n")
    const lockDirectory = join(checkout, ".git", "yrd-worktree-mutations")
    const held = await acquireExclusive(lockDirectory, { timeoutMs: 0 }, "test holder")
    try {
      const result = await superPull({
        repo: checkout,
        repository: "origin",
        refspecs: ["main"],
        ffOnly: true,
        exclusive: createExclusive(lockDirectory, { timeoutMs: 0 }),
      })

      expect(git(checkout, "rev-parse", "HEAD")).toBe(before)
      expect(result).toMatchObject({
        state: "failed",
        partial: false,
        detail: { code: "mutation-lock-busy", phase: "acquire-mutation-lock" },
      })
    } finally {
      held.release()
    }
  })

  test("returns a loud partial result when a submodule apply fails after the root moved", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-pull-partial-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const checkout = join(fixtureRoot, "checkout")
    git(
      fixtureRoot,
      "-c",
      "protocol.file.allow=always",
      "clone",
      "-q",
      "--recurse-submodules",
      fixture.product,
      checkout,
    )
    const alphaCheckout = join(checkout, "packages/alpha")
    const betaCheckout = join(checkout, "vendor/beta")
    const alphaBefore = git(alphaCheckout, "rev-parse", "HEAD")
    const betaBefore = git(betaCheckout, "rev-parse", "HEAD")
    const target = bumpProductSubmodules(fixture)
    const local = createLocalGitProcess()
    const writeCommands: string[][] = []
    const failing: GitProcess = {
      async run(request) {
        if (request.args.includes("merge") || request.args.includes("checkout")) writeCommands.push([...request.args])
        if (request.repo === alphaCheckout && request.args.includes("checkout")) {
          return { code: 55, stdout: "", stderr: "injected child checkout failure", timedOut: false }
        }
        return local.run(request)
      },
    }

    const result = await superPull({
      repo: checkout,
      repository: "origin",
      refspecs: ["main"],
      ffOnly: true,
      git: failing,
    })

    expect(git(checkout, "rev-parse", "HEAD")).toBe(target)
    expect(git(alphaCheckout, "rev-parse", "HEAD")).toBe(alphaBefore)
    expect(git(betaCheckout, "rev-parse", "HEAD")).toBe(betaBefore)
    expect(writeCommands).toEqual([
      ["-c", "submodule.recurse=false", "merge", "--ff-only", "--no-edit", target],
      ["-c", "submodule.recurse=false", "checkout", "--detach", expect.any(String)],
    ])
    expect(result).toMatchObject({
      state: "failed",
      partial: true,
      repositories: [
        { repository: checkout, state: "updated" },
        { repository: alphaCheckout, state: "failed", detail: { phase: "apply-submodule" } },
        { repository: betaCheckout, state: "not-run" },
      ],
    })
  })

  test("dry-run freezes and preflights without changing HEAD, index, or working tree", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "git-super-pull-dry-run-"))
    roots.push(fixture)
    const upstream = join(fixture, "upstream")
    const checkout = join(fixture, "checkout")
    createRepository(upstream, "README.md", "one\n")
    writeFileSync(join(upstream, "local.txt"), "base\n")
    git(upstream, "add", "local.txt")
    git(upstream, "commit", "-q", "-m", "add local file")
    git(fixture, "clone", "-q", upstream, checkout)
    writeFileSync(join(checkout, "local.txt"), "kept locally\n")
    const beforeHead = git(checkout, "rev-parse", "HEAD")
    const beforeIndex = git(checkout, "write-tree")
    const beforeStatus = git(checkout, "status", "--short")
    advanceRepository(upstream, "README.md", "two\n")

    const result = await superPull({
      repo: checkout,
      repository: "origin",
      refspecs: ["main"],
      ffOnly: true,
      dryRun: true,
    })

    expect(result).toMatchObject({ state: "updated", partial: false })
    expect(git(checkout, "rev-parse", "HEAD")).toBe(beforeHead)
    expect(git(checkout, "write-tree")).toBe(beforeIndex)
    expect(git(checkout, "status", "--short")).toBe(beforeStatus)
    expect(readFileSync(join(checkout, "local.txt"), "utf8")).toBe("kept locally\n")
  })

  test.each(["tracked", "staged", "untracked"] as const)(
    "the dry-run tree oracle refuses the same %s collision as real Git without changing it",
    async (kind) => {
      const fixture = mkdtempSync(join(tmpdir(), `git-super-pull-oracle-${kind}-`))
      roots.push(fixture)
      const upstream = join(fixture, "upstream")
      const planned = join(fixture, "planned")
      const control = join(fixture, "control")
      const before = createRepository(upstream, "README.md", "one\n")
      git(fixture, "clone", "-q", upstream, planned)
      git(fixture, "clone", "-q", upstream, control)
      const path = kind === "untracked" ? "new.txt" : "README.md"
      writeFileSync(join(planned, path), "local\n")
      writeFileSync(join(control, path), "local\n")
      if (kind === "staged") {
        git(planned, "add", path)
        git(control, "add", path)
      }
      const beforeIndex = git(planned, "write-tree")
      advanceRepository(upstream, path, "remote\n")

      const result = await superPull({
        repo: planned,
        repository: "origin",
        refspecs: ["main"],
        ffOnly: true,
        dryRun: true,
      })
      git(control, "fetch", "-q", "origin", "main")
      const actual = await createLocalGitProcess().run({
        repo: control,
        args: ["merge", "--ff-only", "--no-edit", "FETCH_HEAD"],
      })

      expect(result).toMatchObject({
        state: "failed",
        partial: false,
        detail: { phase: "preflight-tree-transition" },
      })
      expect(actual.code).not.toBe(0)
      expect(git(planned, "rev-parse", "HEAD")).toBe(before)
      expect(git(planned, "write-tree")).toBe(beforeIndex)
      expect(readFileSync(join(planned, path), "utf8")).toBe("local\n")
    },
  )

  test("the real executable emits stable JSON for success and operational failure", () => {
    const fixture = mkdtempSync(join(tmpdir(), "git-super-pull-bin-"))
    roots.push(fixture)
    const upstream = join(fixture, "upstream")
    const checkout = join(fixture, "checkout")
    createRepository(upstream, "README.md", "one\n")
    git(fixture, "clone", "-q", upstream, checkout)
    const target = advanceRepository(upstream, "README.md", "two\n")

    const success = Bun.spawnSync([
      process.execPath,
      gitSuperBin,
      "--repo",
      checkout,
      "pull",
      "--ff-only",
      "origin",
      "main",
      "--json",
    ])
    expect(success.exitCode).toBe(0)
    expect(success.stderr.toString()).toBe("")
    expect(JSON.parse(success.stdout.toString())).toMatchObject({
      state: "updated",
      partial: false,
      repositories: [{ repository: checkout, state: "updated", refs: [{ source: target }] }],
    })

    advanceRepository(checkout, "local.txt", "local\n")
    advanceRepository(upstream, "remote.txt", "remote\n")
    const failure = Bun.spawnSync([
      process.execPath,
      gitSuperBin,
      "--repo",
      checkout,
      "pull",
      "--ff-only",
      "origin",
      "main",
      "--json",
    ])
    expect(failure.exitCode).toBe(2)
    expect(failure.stderr.toString()).toBe("")
    expect(JSON.parse(failure.stdout.toString())).toMatchObject({
      state: "failed",
      partial: false,
      detail: { code: "non-fast-forward" },
    })
  })

  test("requires --ff-only as a structured operational refusal", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "git-super-pull-mode-"))
    roots.push(fixture)
    const upstream = join(fixture, "upstream")
    const checkout = join(fixture, "checkout")
    createRepository(upstream, "README.md", "one\n")
    git(fixture, "clone", "-q", upstream, checkout)
    const stdout = outputSink()
    const stderr = outputSink()

    expect(await runCli(["--repo", checkout, "pull", "origin", "main", "--json"], stdout, stderr)).toBe(2)
    expect(stderr.output).toBe("")
    expect(JSON.parse(stdout.output)).toMatchObject({
      state: "failed",
      partial: false,
      detail: { code: "ff-only-required", phase: "validate" },
    })
  })

  test("runs the ordinary post-merge hook on a successful root fast-forward", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "git-super-pull-hook-"))
    roots.push(fixture)
    const upstream = join(fixture, "upstream")
    const checkout = join(fixture, "checkout")
    createRepository(upstream, "README.md", "one\n")
    git(fixture, "clone", "-q", upstream, checkout)
    advanceRepository(upstream, "README.md", "two\n")
    const marker = join(fixture, "post-merge-ran")
    const hook = join(checkout, ".git", "hooks", "post-merge")
    writeFileSync(hook, `#!/bin/sh\nprintf invoked > ${JSON.stringify(marker)}\n`)
    chmodSync(hook, 0o755)
    const stdout = outputSink()
    const stderr = outputSink()

    expect(await runCli(["--repo", checkout, "pull", "--ff-only", "origin", "main", "--json"], stdout, stderr)).toBe(0)
    expect(stderr.output).toBe("")
    expect(readFileSync(marker, "utf8")).toBe("invoked")
  })
})
