/**
 * @failure A merge records a gitlink commit that component main does not contain.
 * @level l1
 * @consumer Yrd settled candidate preparation and landing
 */
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runCli } from "../src/cli.ts"
import { superMerge } from "../src/merge.ts"
import { createLocalGitProcess } from "../src/process.ts"
import { advanceRepository, createProductFixture, createRepository, git, type ProductFixture } from "./fixture.ts"

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

function candidateWithRootChange(fixture: ProductFixture, name: string): string {
  git(fixture.product, "switch", "-q", "-c", name)
  writeFileSync(join(fixture.product, `${name}.txt`), `${name}\n`)
  git(fixture.product, "add", `${name}.txt`)
  git(fixture.product, "commit", "-q", "-m", `add ${name}`)
  const candidate = git(fixture.product, "rev-parse", "HEAD")
  git(fixture.product, "switch", "-q", "main")
  return candidate
}

describe("git super merge", () => {
  it("refuses moved off-main pins, reports untouched off-main pins, and raises behind pins", async () => {
    const refusedRoot = mkdtempSync(join(tmpdir(), "git-super-merge-refused-"))
    roots.push(refusedRoot)
    const refused = createProductFixture(refusedRoot)
    const refusedAlpha = join(refused.product, "packages/alpha")
    git(refused.product, "switch", "-q", "-c", "candidate-off-main")
    writeFileSync(join(refusedAlpha, "alpha.ts"), "export const alpha = 'unpushed'\n")
    git(refusedAlpha, "add", "alpha.ts")
    git(refusedAlpha, "commit", "-q", "-m", "advance alpha off main")
    const unpublished = git(refusedAlpha, "rev-parse", "HEAD")
    git(refused.product, "add", "packages/alpha")
    git(refused.product, "commit", "-q", "-m", "pin unpublished alpha")
    const refusedCandidate = git(refused.product, "rev-parse", "HEAD")
    git(refused.product, "switch", "-q", "main")
    git(refusedAlpha, "switch", "-q", "--detach", refused.alphaBase)
    const refusedHeadBefore = git(refused.product, "rev-parse", "HEAD")
    const refusedStatusBefore = git(refused.product, "status", "--porcelain=v1")
    const refusedStdout = outputSink()
    const refusedStderr = outputSink()

    const refusedCode = await runCli(
      ["--repo", refused.product, "merge", refusedCandidate, "-m", "merge candidate"],
      refusedStdout,
      refusedStderr,
    )

    expect(refusedCode).toBe(1)
    expect(refusedStdout.output).toBe("")
    expect(refusedStderr.output).toContain("gitlink-off-main")
    expect(refusedStderr.output).toContain("packages/alpha")
    expect(refusedStderr.output).toContain(unpublished)
    expect(refusedStderr.output).toContain(refused.alphaBase)
    expect(refusedStderr.output).toContain("evidence:")
    expect(refusedStderr.output).toContain("next:")
    expect(refusedStderr.output).toContain("owner: the component writer")
    expect(git(refused.product, "rev-parse", "HEAD")).toBe(refusedHeadBefore)
    expect(git(refused.product, "status", "--porcelain=v1")).toBe(refusedStatusBefore)

    const refusedJsonStdout = outputSink()
    const refusedJsonStderr = outputSink()
    expect(
      await runCli(
        ["--repo", refused.product, "--json", "merge", refusedCandidate, "-m", "merge candidate"],
        refusedJsonStdout,
        refusedJsonStderr,
      ),
    ).toBe(1)
    expect(refusedJsonStderr.output).toBe("")
    expect(JSON.parse(refusedJsonStdout.output)).toMatchObject({
      state: "failed",
      partial: false,
      detail: {
        code: "gitlink-off-main",
        subject: expect.stringContaining("packages/alpha"),
        evidence: expect.stringContaining("merge-base --is-ancestor"),
        next: expect.stringContaining("Push"),
        owner: "the component writer",
      },
    })

    const leftRoot = mkdtempSync(join(tmpdir(), "git-super-merge-left-off-main-"))
    roots.push(leftRoot)
    const left = createProductFixture(leftRoot)
    const leftAlpha = join(left.product, "packages/alpha")
    writeFileSync(join(leftAlpha, "alpha.ts"), "export const alpha = 'already ahead'\n")
    git(leftAlpha, "add", "alpha.ts")
    git(leftAlpha, "commit", "-q", "-m", "advance alpha already at head")
    const leftOffMain = git(leftAlpha, "rev-parse", "HEAD")
    git(left.product, "add", "packages/alpha")
    git(left.product, "commit", "-q", "-m", "pin existing off-main alpha")
    const leftCandidate = candidateWithRootChange(left, "candidate-left")
    const leftStdout = outputSink()
    const leftStderr = outputSink()

    expect(
      await runCli(
        ["--repo", left.product, "merge", leftCandidate, "-m", "merge untouched off-main"],
        leftStdout,
        leftStderr,
      ),
    ).toBe(0)
    expect(leftStderr.output).toContain("left-off-main")
    expect(leftStderr.output).toContain("packages/alpha")
    expect(leftStderr.output).toContain(leftOffMain)
    expect(leftStderr.output).toContain(left.alphaBase)
    expect(git(left.product, "ls-tree", "HEAD", "packages/alpha")).toContain(leftOffMain)
    expect(git(left.product, "show", "-s", "--format=%B", "HEAD")).toContain(
      `Settled: packages/alpha@${leftOffMain} left-off-main component-main@${left.alphaBase}`,
    )

    const raisedRoot = mkdtempSync(join(tmpdir(), "git-super-merge-raised-"))
    roots.push(raisedRoot)
    const raised = createProductFixture(raisedRoot)
    const newestAlpha = advanceRepository(raised.alpha, "alpha.ts", "export const alpha = 2\n")
    const raisedCandidate = candidateWithRootChange(raised, "candidate-raised")
    const raisedStdout = outputSink()
    const raisedStderr = outputSink()

    expect(
      await runCli(
        ["--repo", raised.product, "merge", raisedCandidate, "-m", "merge and raise"],
        raisedStdout,
        raisedStderr,
      ),
    ).toBe(0)
    expect(raisedStderr.output).toContain(
      `packages/alpha ${raised.alphaBase.slice(0, 7)} -> ${newestAlpha.slice(0, 7)} (component main)`,
    )
    expect(git(raised.product, "ls-tree", "HEAD", "packages/alpha")).toContain(newestAlpha)
    expect(git(raised.product, "show", "-s", "--format=%B", "HEAD")).toContain(`Settled: packages/alpha@${newestAlpha}`)
  })

  it("preserves the queue record trailer block when it adds Settled trailers", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-trailers-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const newestAlpha = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 2\n")
    const newestBeta = advanceRepository(fixture.beta, "beta.ts", "export const beta = 2\n")
    const candidate = candidateWithRootChange(fixture, "candidate-trailers")
    const stdout = outputSink()
    const stderr = outputSink()

    expect(
      await runCli(
        [
          "--repo",
          fixture.product,
          "merge",
          candidate,
          "-m",
          "merge with queue record\n\nChange: task/example@1234567\nMerged-By: yrd queue main",
        ],
        stdout,
        stderr,
      ),
    ).toBe(0)

    expect(git(fixture.product, "log", "-1", "--format=%(trailers:key=Change,valueonly)")).toBe("task/example@1234567")
    expect(git(fixture.product, "log", "-1", "--format=%(trailers:key=Merged-By,valueonly)")).toBe("yrd queue main")
    expect(git(fixture.product, "log", "-1", "--format=%(trailers:key=Settled,valueonly)").split("\n")).toEqual([
      `packages/alpha@${newestAlpha}`,
      `vendor/beta@${newestBeta}`,
    ])
  })

  it("writes one complete settled merge while queue-owned verification bypasses every repository hook", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-one-settled-commit-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const newestAlpha = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 2\n")
    const newestBeta = advanceRepository(fixture.beta, "beta.ts", "export const beta = 2\n")
    const candidate = candidateWithRootChange(fixture, "candidate-one-settled-commit")
    const hookLog = join(fixtureRoot, "observed-hooks.log")
    for (const hook of ["pre-merge-commit", "pre-commit", "commit-msg"]) {
      const path = join(fixture.product, ".git", "hooks", hook)
      writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${hook}' >> '${hookLog}'\nexit 1\n`)
      chmodSync(path, 0o755)
    }
    const local = createLocalGitProcess()
    const commands: string[][] = []

    const result = await superMerge({
      repo: fixture.product,
      commit: candidate,
      message: "merge once\n\nChange: task/once@1234567",
      noVerify: true,
      git: {
        run: async (request) => {
          commands.push([...request.args])
          return local.run(request)
        },
      },
    })

    expect(result).toMatchObject({ state: "updated", partial: false })
    expect(existsSync(hookLog)).toBe(false)
    expect(commands.filter(([command]) => command === "merge")).toEqual([
      expect.arrayContaining(["merge", "--no-ff", "--no-commit", "--no-verify", candidate]),
    ])
    expect(commands.filter(([command]) => command === "commit")).toEqual([
      expect.arrayContaining(["commit", "--no-verify", "-F", "-"]),
    ])
    expect(commands.flat()).not.toContain("--amend")
    const merged = git(fixture.product, "rev-parse", "HEAD")
    expect(result.commit).toBe(merged)
    expect(git(fixture.product, "rev-list", "--parents", "-n", "1", merged).split(" ")).toHaveLength(3)
    expect(git(fixture.product, "show", "-s", "--format=%B", merged)).toContain(
      `Settled: packages/alpha@${newestAlpha}`,
    )
    expect(git(fixture.product, "show", "-s", "--format=%B", merged)).toContain(
      `Settled: vendor/beta@${newestBeta}`,
    )
  })

  it("refuses an uncomposable Settled report before writing a merge", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-settlement-refusal-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 2\n")
    const candidate = candidateWithRootChange(fixture, "candidate-settlement-refusal")
    const headBefore = git(fixture.product, "rev-parse", "HEAD")
    const statusBefore = git(fixture.product, "status", "--porcelain=v1")
    const local = createLocalGitProcess()

    const result = await superMerge({
      repo: fixture.product,
      commit: candidate,
      message: "merge whose report cannot be composed",
      noVerify: true,
      git: {
        run: (request) =>
          request.args[0] === "interpret-trailers"
            ? Promise.resolve({ code: 1, stdout: "", stderr: "injected trailer composition refusal" })
            : local.run(request),
      },
    })

    expect(result).toMatchObject({
      state: "failed",
      partial: false,
      detail: {
        code: "settlement-message-failed",
        phase: "compose-settlement-report",
        message: expect.stringContaining("injected trailer composition refusal"),
      },
    })
    expect(result.commit).toBeUndefined()
    expect(git(fixture.product, "rev-parse", "HEAD")).toBe(headBefore)
    expect(git(fixture.product, "status", "--porcelain=v1")).toBe(statusBefore)
  })

  it("checks out every raised component so the settled worktree matches HEAD", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-checkouts-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const newestAlpha = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 2\n")
    const candidate = candidateWithRootChange(fixture, "candidate-checkouts")
    const stdout = outputSink()
    const stderr = outputSink()

    expect(await runCli(["--repo", fixture.product, "merge", candidate], stdout, stderr)).toBe(0)

    expect(git(join(fixture.product, "packages/alpha"), "rev-parse", "HEAD")).toBe(newestAlpha)
    expect(git(fixture.product, "status", "--porcelain=v1")).toBe("")
  })

  it("returns a named partial with the recovery command when a raised checkout cannot settle", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-checkout-failure-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const component = join(fixture.product, "packages/alpha")
    const newestAlpha = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 2\n")
    const candidate = candidateWithRootChange(fixture, "candidate-checkout-failure")
    const local = createLocalGitProcess()

    const result = await superMerge({
      repo: fixture.product,
      commit: candidate,
      git: {
        run: (request) =>
          request.repo === component && request.args[0] === "checkout"
            ? Promise.resolve({ code: 1, stdout: "", stderr: "injected checkout failure" })
            : local.run(request),
      },
    })

    expect(result).toMatchObject({
      state: "failed",
      partial: true,
      detail: {
        code: "component-checkout-failed",
        phase: "settle-component-checkout",
        paths: ["packages/alpha"],
        next: `git -C ${fixture.product} submodule update --init -- packages/alpha`,
      },
      gitlinks: [{ path: "packages/alpha", from: fixture.alphaBase, to: newestAlpha, state: "raised" }],
    })
    expect(result.commit).toBe(git(fixture.product, "rev-parse", "HEAD"))
  })

  it("returns a merge commit with no gitlink rows when every pin is already newest", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-newest-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const candidate = candidateWithRootChange(fixture, "candidate-newest")
    const stdout = outputSink()
    const stderr = outputSink()

    expect(await runCli(["--repo", fixture.product, "merge", candidate, "-m", "merge newest"], stdout, stderr)).toBe(0)

    const merged = git(fixture.product, "rev-parse", "HEAD")
    expect(stdout.output).toBe(`${merged}\n`)
    expect(stderr.output).toBe("")
    expect(git(fixture.product, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3)
  })

  it("merges a repository with no submodules and returns the commit", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-plain-"))
    roots.push(fixtureRoot)
    const repository = join(fixtureRoot, "plain")
    createRepository(repository, "shared.txt", "base\n")
    git(repository, "switch", "-q", "-c", "candidate")
    writeFileSync(join(repository, "candidate.txt"), "candidate\n")
    git(repository, "add", "candidate.txt")
    git(repository, "commit", "-q", "-m", "add candidate")
    const candidate = git(repository, "rev-parse", "HEAD")
    git(repository, "switch", "-q", "main")
    const stdout = outputSink()
    const stderr = outputSink()

    expect(await runCli(["--repo", repository, "merge", candidate, "-m", "merge plain"], stdout, stderr)).toBe(0)
    expect(stdout.output).toBe(`${git(repository, "rev-parse", "HEAD")}\n`)
    expect(stderr.output).toBe("")
  })

  it("refuses an already-contained target instead of claiming the old HEAD is a merge commit", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-contained-"))
    roots.push(fixtureRoot)
    const repository = join(fixtureRoot, "contained")
    createRepository(repository, "base.txt", "base\n")
    const contained = git(repository, "rev-parse", "HEAD")
    writeFileSync(join(repository, "later.txt"), "later\n")
    git(repository, "add", "later.txt")
    git(repository, "commit", "-q", "-m", "advance main")
    const headBefore = git(repository, "rev-parse", "HEAD")
    const stdout = outputSink()
    const stderr = outputSink()

    expect(await runCli(["--repo", repository, "merge", contained], stdout, stderr)).toBe(1)
    expect(stdout.output).toBe("")
    expect(stderr.output).toContain("merge-target-already-contained")
    expect(git(repository, "rev-parse", "HEAD")).toBe(headBefore)
  })

  it("reports a conflict before writing HEAD, the index, or the worktree", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-conflict-"))
    roots.push(fixtureRoot)
    const repository = join(fixtureRoot, "conflict")
    createRepository(repository, "shared.txt", "base\n")
    git(repository, "switch", "-q", "-c", "candidate")
    writeFileSync(join(repository, "shared.txt"), "candidate\n")
    git(repository, "commit", "-q", "-am", "candidate conflict")
    const candidate = git(repository, "rev-parse", "HEAD")
    git(repository, "switch", "-q", "main")
    writeFileSync(join(repository, "shared.txt"), "main\n")
    git(repository, "commit", "-q", "-am", "main conflict")
    const headBefore = git(repository, "rev-parse", "HEAD")
    const statusBefore = git(repository, "status", "--porcelain=v1")
    const stdout = outputSink()
    const stderr = outputSink()

    expect(await runCli(["--repo", repository, "merge", candidate], stdout, stderr)).toBe(1)
    expect(stdout.output).toBe("")
    expect(stderr.output).toContain("merge-conflict")
    expect(git(repository, "rev-parse", "HEAD")).toBe(headBefore)
    expect(git(repository, "status", "--porcelain=v1")).toBe(statusBefore)
  })

  it("refuses an unreadable component main before merging and names the resource", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-unreadable-main-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const candidate = candidateWithRootChange(fixture, "candidate-unreadable")
    const component = join(fixture.product, "packages/alpha")
    git(component, "remote", "set-url", "origin", join(fixtureRoot, "missing-alpha-origin"))
    const headBefore = git(fixture.product, "rev-parse", "HEAD")
    const stdout = outputSink()
    const stderr = outputSink()

    expect(await runCli(["--repo", fixture.product, "merge", candidate], stdout, stderr)).toBe(1)
    expect(stdout.output).toBe("")
    expect(stderr.output).toContain("component-main-unreadable")
    expect(stderr.output).toContain("packages/alpha")
    expect(stderr.output).toContain("fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main")
    expect(stderr.output).toContain("owner: the component writer")
    expect(git(fixture.product, "rev-parse", "HEAD")).toBe(headBefore)
  })

  it("does not misreport an ancestry probe failure as an off-main pin", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-ancestry-failure-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const component = join(fixture.product, "packages/alpha")
    git(fixture.product, "switch", "-q", "-c", "candidate-ancestry-failure")
    writeFileSync(join(component, "alpha.ts"), "export const alpha = 'unprovable'\n")
    git(component, "add", "alpha.ts")
    git(component, "commit", "-q", "-m", "advance alpha without proof")
    git(fixture.product, "add", "packages/alpha")
    git(fixture.product, "commit", "-q", "-m", "pin alpha without proof")
    const candidate = git(fixture.product, "rev-parse", "HEAD")
    git(fixture.product, "switch", "-q", "main")
    const headBefore = git(fixture.product, "rev-parse", "HEAD")
    const local = createLocalGitProcess()

    const result = await superMerge({
      repo: fixture.product,
      commit: candidate,
      git: {
        run: (request) =>
          request.repo === component && request.args[0] === "merge-base"
            ? Promise.resolve({ code: 128, stdout: "", stderr: "injected ancestry failure" })
            : local.run(request),
      },
    })

    expect(result).toMatchObject({
      state: "failed",
      partial: false,
      detail: { code: "git-failed", phase: "prove-gitlink-on-main" },
    })
    expect(result.detail?.code).not.toBe("gitlink-off-main")
    expect(git(fixture.product, "rev-parse", "HEAD")).toBe(headBefore)
  })

  it("emits one byte-clean JSON result carrying the commit and raise rows", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-json-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const newestAlpha = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 2\n")
    const candidate = candidateWithRootChange(fixture, "candidate-json")
    const stdout = outputSink()
    const stderr = outputSink()

    expect(
      await runCli(["--repo", fixture.product, "--json", "merge", candidate, "-m", "merge json"], stdout, stderr),
    ).toBe(0)

    expect(stderr.output).toBe("")
    expect(JSON.parse(stdout.output)).toMatchObject({
      commit: git(fixture.product, "rev-parse", "HEAD"),
      gitlinks: [
        {
          path: "packages/alpha",
          from: fixture.alphaBase,
          to: newestAlpha,
          state: "raised",
        },
      ],
      partial: false,
      state: "updated",
    })
  })

  it("returns a named partial with completed and not-run raises after the merge commit", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-partial-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 2\n")
    advanceRepository(fixture.beta, "beta.ts", "export const beta = 2\n")
    const candidate = candidateWithRootChange(fixture, "candidate-partial")
    const local = createLocalGitProcess()
    let writes = 0

    const result = await superMerge({
      repo: fixture.product,
      commit: candidate,
      message: "merge partial",
      git: {
        run: async (request) => {
          if (request.args[0] === "update-index") {
            writes += 1
            if (writes === 2) return { code: 1, stdout: "", stderr: "injected second write failure" }
          }
          return local.run(request)
        },
      },
    })

    expect(result).toMatchObject({
      state: "failed",
      partial: true,
      detail: { code: "gitlink-raise-failed", phase: "raise-gitlink" },
      gitlinks: [
        { path: "packages/alpha", state: "raised" },
        { path: "vendor/beta", state: "not-run" },
      ],
    })
    expect(result.commit).toBe(git(fixture.product, "rev-parse", "HEAD"))
    expect(git(fixture.product, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3)
    expect(git(fixture.product, "status", "--porcelain=v1")).toContain("packages/alpha")
  })

  it("keeps a successful but unobservable merge in the partial state", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-observation-partial-"))
    roots.push(fixtureRoot)
    const repository = join(fixtureRoot, "plain")
    createRepository(repository, "base.txt", "base\n")
    git(repository, "switch", "-q", "-c", "candidate")
    writeFileSync(join(repository, "candidate.txt"), "candidate\n")
    git(repository, "add", "candidate.txt")
    git(repository, "commit", "-q", "-m", "add candidate")
    const candidate = git(repository, "rev-parse", "HEAD")
    git(repository, "switch", "-q", "main")
    const local = createLocalGitProcess()
    let merged = false

    const result = await superMerge({
      repo: repository,
      commit: candidate,
      message: "merge with unreadable result",
      git: {
        run: async (request) => {
          const observed = await local.run(request)
          if (request.args[0] === "merge" && observed.code === 0) merged = true
          if (merged && request.args.join(" ") === "rev-parse HEAD^{commit}") {
            return { code: 1, stdout: "", stderr: "injected observation failure" }
          }
          return observed
        },
      },
    })

    expect(result).toMatchObject({
      state: "failed",
      partial: true,
      detail: { code: "post-merge-observation-failed", phase: "observe-merge" },
      gitlinks: [],
    })
    expect(result.commit).toBeUndefined()
    expect(git(repository, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3)
  })
})
