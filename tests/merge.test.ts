/**
 * @failure A merge records a gitlink commit that component main does not contain.
 * @level l1
 * @consumer Yrd settled candidate preparation and landing
 */
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runCli } from "../src/cli.ts"
import { superMerge } from "../src/merge.ts"
import { createLocalGitProcess } from "../src/process.ts"
import {
  advanceRepository,
  canonicalTmpdir as tmpdir,
  createProductFixture,
  createRepository,
  git,
  injectionProbe,
  type ProductFixture,
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
  it("keeps authored-ahead pins, reports untouched off-main pins, and raises behind pins", async () => {
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
    const kept = await superMerge({ repo: refused.product, commit: refusedCandidate, message: "merge candidate" })

    expect(kept).toMatchObject({
      state: "updated",
      partial: false,
      gitlinks: [
        {
          path: "packages/alpha",
          from: unpublished,
          to: refused.alphaBase,
          state: "kept-ahead",
        },
      ],
      checkouts: [
        {
          path: "packages/alpha",
          recorded: refused.alphaBase,
          index: unpublished,
          checkout: unpublished,
          state: "settled",
        },
      ],
    })
    expect(git(refused.product, "ls-tree", "HEAD", "packages/alpha")).toContain(unpublished)
    expect(git(refusedAlpha, "rev-parse", "HEAD")).toBe(unpublished)
    expect(git(refused.product, "status", "--porcelain=v1")).toBe("")

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

  it("refuses a changed gitlink that diverged from component main before writing", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-component-main-moved-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const component = join(fixture.product, "packages/alpha")
    git(fixture.product, "switch", "-q", "-c", "candidate-diverged")
    writeFileSync(join(component, "alpha.ts"), "export const alpha = 'authored'\n")
    git(component, "add", "alpha.ts")
    git(component, "commit", "-q", "-m", "author alpha pin")
    const authored = git(component, "rev-parse", "HEAD")
    git(fixture.product, "add", "packages/alpha")
    git(fixture.product, "commit", "-q", "-m", "pin authored alpha")
    const candidate = git(fixture.product, "rev-parse", "HEAD")
    git(fixture.product, "switch", "-q", "main")
    git(component, "switch", "-q", "--detach", fixture.alphaBase)
    const movedMain = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 'moved main'\n")
    const headBefore = git(fixture.product, "rev-parse", "HEAD")
    const indexBefore = git(fixture.product, "write-tree")
    const statusBefore = git(fixture.product, "status", "--porcelain=v1")
    const checkoutBefore = git(component, "rev-parse", "HEAD")

    const result = await superMerge({ repo: fixture.product, commit: candidate })

    expect(result).toMatchObject({
      state: "failed",
      partial: false,
      detail: {
        code: "component-main-moved",
        subject: expect.stringContaining("packages/alpha"),
        objectIds: expect.arrayContaining([authored, movedMain]),
      },
    })
    expect(git(fixture.product, "rev-parse", "HEAD")).toBe(headBefore)
    expect(git(fixture.product, "write-tree")).toBe(indexBefore)
    expect(git(fixture.product, "status", "--porcelain=v1")).toBe(statusBefore)
    expect(git(component, "rev-parse", "HEAD")).toBe(checkoutBefore)
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

  it("writes the complete Settled report in one merge commit", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-one-settled-commit-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const newestAlpha = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 2\n")
    const newestBeta = advanceRepository(fixture.beta, "beta.ts", "export const beta = 2\n")
    const candidate = candidateWithRootChange(fixture, "candidate-one-settled-commit")
    const local = createLocalGitProcess()
    const commands: string[][] = []

    const result = await superMerge({
      repo: fixture.product,
      commit: candidate,
      message: "merge once\n\nChange: task/once@1234567",
      git: {
        run: async (request) => {
          commands.push([...request.args])
          return local.run(request)
        },
      },
    })

    expect(result).toMatchObject({ state: "updated", partial: false })
    expect(commands.filter((command) => command.includes("merge"))).toEqual([
      expect.arrayContaining(["merge", "--no-ff", "--no-commit", candidate]),
    ])
    expect(commands.filter(([command]) => command === "commit")).toEqual([
      expect.arrayContaining(["commit", "-F", "-"]),
    ])
    expect(commands.flat()).not.toContain("--amend")
    const merged = git(fixture.product, "rev-parse", "HEAD")
    expect(result.commit).toBe(merged)
    expect(git(fixture.product, "rev-list", "--parents", "-n", "1", merged).split(" ")).toHaveLength(3)
    expect(git(fixture.product, "show", "-s", "--format=%B", merged)).toContain(
      `Settled: packages/alpha@${newestAlpha}`,
    )
    expect(git(fixture.product, "show", "-s", "--format=%B", merged)).toContain(`Settled: vendor/beta@${newestBeta}`)
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

  it("accepts a clean component already at the staged pin without checking it out again", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-pre-settled-checkout-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const component = join(fixture.product, "packages/alpha")
    const newestAlpha = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 2\n")
    const candidate = candidateWithRootChange(fixture, "candidate-pre-settled-checkout")
    git(component, "fetch", "-q", "origin")
    git(component, "checkout", "-q", "--detach", newestAlpha)
    const local = createLocalGitProcess()
    const componentCheckouts: string[][] = []

    const result = await superMerge({
      repo: fixture.product,
      commit: candidate,
      git: {
        run: async (request) => {
          if (request.repo === component && request.args[0] === "checkout") {
            componentCheckouts.push([...request.args])
          }
          return local.run(request)
        },
      },
    })

    expect(result).toMatchObject({
      state: "updated",
      partial: false,
      checkouts: [
        {
          path: "packages/alpha",
          recorded: fixture.alphaBase,
          index: newestAlpha,
          preCheckout: newestAlpha,
          checkout: newestAlpha,
          state: "settled",
        },
      ],
    })
    expect(componentCheckouts).toEqual([])
    expect(git(fixture.product, "ls-tree", "HEAD", "packages/alpha")).toContain(newestAlpha)
    expect(git(component, "rev-parse", "HEAD")).toBe(newestAlpha)
    expect(git(fixture.product, "status", "--porcelain=v1")).toBe("")
  })

  it("refuses content changes inside a component already at the staged pin", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-dirty-pre-settled-checkout-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const component = join(fixture.product, "packages/alpha")
    const newestAlpha = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 2\n")
    const candidate = candidateWithRootChange(fixture, "candidate-dirty-pre-settled-checkout")
    git(component, "fetch", "-q", "origin")
    git(component, "checkout", "-q", "--detach", newestAlpha)
    writeFileSync(join(component, "alpha.ts"), "export const alpha = 'uncommitted'\n")
    const headBefore = git(fixture.product, "rev-parse", "HEAD")
    const indexBefore = git(fixture.product, "write-tree")
    const mergeHead = join(fixture.product, ".git", "MERGE_HEAD")
    const local = createLocalGitProcess()
    const rootStatus = await local.run({
      repo: fixture.product,
      args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    })

    expect(rootStatus).toMatchObject({ code: 0, stdout: " M packages/alpha\0" })
    expect(existsSync(mergeHead)).toBe(false)
    const result = await superMerge({ repo: fixture.product, commit: candidate })

    expect(result).toMatchObject({
      state: "failed",
      partial: false,
      detail: { code: "dirty-worktree" },
      checkouts: [
        {
          path: "packages/alpha",
          recorded: fixture.alphaBase,
          index: newestAlpha,
          preCheckout: newestAlpha,
          checkout: newestAlpha,
          state: "settled",
        },
      ],
    })
    expect(git(fixture.product, "rev-parse", "HEAD")).toBe(headBefore)
    expect(git(fixture.product, "write-tree")).toBe(indexBefore)
    expect(existsSync(mergeHead)).toBe(false)
    expect(git(component, "rev-parse", "HEAD")).toBe(newestAlpha)
    expect(git(component, "diff", "--", "alpha.ts")).toContain("uncommitted")
  })

  it("refuses unrelated component checkout drift before touching HEAD, index, or MERGE_HEAD", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-checkout-drift-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const component = join(fixture.product, "packages/alpha")
    const newestAlpha = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 2\n")
    const candidate = candidateWithRootChange(fixture, "candidate-checkout-drift")
    writeFileSync(join(component, "drift.ts"), "export const drift = true\n")
    git(component, "add", "drift.ts")
    git(component, "commit", "-q", "-m", "unrelated local checkout drift")
    const unrelated = git(component, "rev-parse", "HEAD")
    const headBefore = git(fixture.product, "rev-parse", "HEAD")
    const indexBefore = git(fixture.product, "write-tree")
    const mergeHead = join(fixture.product, ".git", "MERGE_HEAD")
    const stdout = outputSink()
    const stderr = outputSink()
    expect(existsSync(mergeHead)).toBe(false)

    const code = await runCli(["--repo", fixture.product, "--json", "merge", candidate], stdout, stderr)
    const result = JSON.parse(stdout.output)

    expect(code).toBe(1)
    expect(stderr.output).toBe("")
    expect(result).toMatchObject({
      state: "failed",
      partial: false,
      detail: { code: "component-checkout-drift" },
      checkouts: [
        {
          path: "packages/alpha",
          recorded: fixture.alphaBase,
          index: newestAlpha,
          preCheckout: unrelated,
          checkout: unrelated,
          state: "not-run",
        },
      ],
    })
    expect(git(fixture.product, "rev-parse", "HEAD")).toBe(headBefore)
    expect(git(fixture.product, "write-tree")).toBe(indexBefore)
    expect(existsSync(mergeHead)).toBe(false)
    expect(git(component, "rev-parse", "HEAD")).toBe(unrelated)
  })

  it("checks out staged gitlink pins before the concluding commit hook", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-hook-coherence-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const newestAlpha = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 2\n")
    const candidate = candidateWithRootChange(fixture, "candidate-hook-coherence")
    const hook = join(fixture.product, ".git", "hooks", "pre-commit")
    writeFileSync(
      hook,
      [
        "#!/bin/sh",
        "set -eu",
        "index=$(git ls-files --stage -- packages/alpha | awk '{print $2}')",
        "checkout=$(git -C packages/alpha rev-parse HEAD)",
        'if [ "$index" != "$checkout" ]; then',
        '  printf "gitlink drift: index=%s checkout=%s\\n" "$index" "$checkout" >&2',
        "  exit 23",
        "fi",
        "",
      ].join("\n"),
    )
    chmodSync(hook, 0o755)
    const stdout = outputSink()
    const stderr = outputSink()

    expect(await runCli(["--repo", fixture.product, "merge", candidate], stdout, stderr)).toBe(0)

    expect(stderr.output).not.toContain("gitlink drift")
    expect(git(fixture.product, "ls-tree", "HEAD", "packages/alpha")).toContain(newestAlpha)
    expect(git(join(fixture.product, "packages/alpha"), "rev-parse", "HEAD")).toBe(newestAlpha)
    expect(git(fixture.product, "status", "--porcelain=v1")).toBe("")
  })

  it("restores every settled checkout to its root-recorded pin when the concluding commit is rejected", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-commit-rollback-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const component = join(fixture.product, "packages/alpha")
    const betaComponent = join(fixture.product, "vendor/beta")
    const newestAlpha = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 2\n")
    const newestBeta = advanceRepository(fixture.beta, "beta.ts", "export const beta = 2\n")
    const candidate = candidateWithRootChange(fixture, "candidate-commit-rollback")
    git(component, "fetch", "-q", "origin")
    git(component, "checkout", "-q", "--detach", newestAlpha)
    const headBefore = git(fixture.product, "rev-parse", "HEAD")
    const hook = join(fixture.product, ".git", "hooks", "pre-commit")
    writeFileSync(hook, "#!/bin/sh\necho commit-policy-refused >&2\nexit 23\n")
    chmodSync(hook, 0o755)

    const result = await superMerge({ repo: fixture.product, commit: candidate })

    expect(result).toMatchObject({
      state: "failed",
      partial: true,
      detail: {
        code: "settled-merge-commit-failed",
        evidence: expect.stringContaining(`index=${newestAlpha}`),
      },
      checkouts: [
        {
          path: "packages/alpha",
          recorded: fixture.alphaBase,
          index: newestAlpha,
          preCheckout: newestAlpha,
          checkout: fixture.alphaBase,
          state: "restored",
        },
        {
          path: "vendor/beta",
          recorded: fixture.betaBase,
          index: newestBeta,
          preCheckout: fixture.betaBase,
          checkout: fixture.betaBase,
          state: "restored",
        },
      ],
    })
    expect(result.detail?.evidence).toContain(`recorded=${fixture.alphaBase}`)
    expect(result.detail?.evidence).toContain(`checkout=${fixture.alphaBase}`)
    expect(git(component, "rev-parse", "HEAD")).toBe(fixture.alphaBase)
    expect(git(betaComponent, "rev-parse", "HEAD")).toBe(fixture.betaBase)
    expect(git(fixture.product, "rev-parse", "HEAD")).toBe(headBefore)
    expect(git(fixture.product, "rev-parse", "MERGE_HEAD")).toBe(candidate)
    expect(git(fixture.product, "ls-files", "--stage", "--", "packages/alpha")).toContain(newestAlpha)
    expect(git(fixture.product, "ls-files", "--stage", "--", "vendor/beta")).toContain(newestBeta)
  })

  it("preserves the observed merge when commit writes HEAD but reports failure", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-commit-reported-failure-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const component = join(fixture.product, "packages/alpha")
    const newestAlpha = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 2\n")
    const candidate = candidateWithRootChange(fixture, "candidate-commit-reported-failure")
    const headBefore = git(fixture.product, "rev-parse", "HEAD")
    const local = createLocalGitProcess()
    const probe = injectionProbe()

    const result = await superMerge({
      repo: fixture.product,
      commit: candidate,
      git: {
        run: async (request) => {
          probe.observe(request)
          const observed = await local.run(request)
          if (request.repo === fixture.product && request.args[0] === "commit" && observed.code === 0) {
            probe.fire("commit reported failure after writing HEAD")
            return { ...observed, code: 23, stderr: "injected failure after commit wrote HEAD" }
          }
          return observed
        },
      },
    })

    probe.expectFired("commit reported failure after writing HEAD")
    const merged = git(fixture.product, "rev-parse", "HEAD")
    expect(result).toMatchObject({
      state: "failed",
      partial: true,
      commit: merged,
      detail: {
        code: "settled-merge-commit-reported-failed",
        objectIds: [headBefore, merged],
      },
      checkouts: [
        {
          path: "packages/alpha",
          recorded: fixture.alphaBase,
          index: newestAlpha,
          preCheckout: fixture.alphaBase,
          checkout: newestAlpha,
          state: "settled",
        },
      ],
    })
    expect(git(fixture.product, "rev-list", "--parents", "-n", "1", merged).split(" ")).toHaveLength(3)
    expect(git(component, "rev-parse", "HEAD")).toBe(newestAlpha)
  })

  it("renders recorded, staged-index, checkout, and pre-checkout pins for a partial merge", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-partial-render-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const newestAlpha = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 2\n")
    const candidate = candidateWithRootChange(fixture, "candidate-partial-render")
    const hook = join(fixture.product, ".git", "hooks", "pre-commit")
    writeFileSync(hook, "#!/bin/sh\necho render-policy-refused >&2\nexit 23\n")
    chmodSync(hook, 0o755)
    const stdout = outputSink()
    const stderr = outputSink()

    expect(await runCli(["--repo", fixture.product, "merge", candidate], stdout, stderr)).toBe(2)

    expect(stdout.output).toBe("")
    expect(stderr.output).toContain(
      `checkout-state packages/alpha recorded=${fixture.alphaBase} staged-index=${newestAlpha} checkout=${fixture.alphaBase} pre-checkout=${fixture.alphaBase} state=restored`,
    )
  })

  it("names recorded, staged-index, checkout, and pre-checkout pins when rollback cannot be proved", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-rollback-failure-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const component = join(fixture.product, "packages/alpha")
    const newestAlpha = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 2\n")
    const candidate = candidateWithRootChange(fixture, "candidate-rollback-failure")
    const local = createLocalGitProcess()
    const probe = injectionProbe()
    let commitRejected = false

    const result = await superMerge({
      repo: fixture.product,
      commit: candidate,
      git: {
        run: async (request) => {
          probe.observe(request)
          if (request.repo === fixture.product && request.args[0] === "commit") {
            commitRejected = true
            probe.fire("commit refusal")
            return { code: 23, stdout: "", stderr: "injected commit refusal" }
          }
          if (
            commitRejected &&
            request.repo === component &&
            request.args[0] === "checkout" &&
            request.args.at(-1) === fixture.alphaBase
          ) {
            probe.fire("rollback refusal")
            return { code: 24, stdout: "", stderr: "injected rollback refusal" }
          }
          return local.run(request)
        },
      },
    })

    probe.expectFired("commit refusal", "rollback refusal")
    expect(result).toMatchObject({
      state: "failed",
      partial: true,
      detail: {
        code: "component-checkout-rollback-failed",
        evidence: expect.stringContaining(`recorded=${fixture.alphaBase}`),
      },
      checkouts: [
        {
          path: "packages/alpha",
          recorded: fixture.alphaBase,
          index: newestAlpha,
          preCheckout: fixture.alphaBase,
          checkout: newestAlpha,
          state: "restore-failed",
        },
      ],
    })
    expect(result.detail?.evidence).toContain(`index=${newestAlpha}`)
    expect(result.detail?.evidence).toContain(`checkout=${newestAlpha}`)
    expect(result.detail?.evidence).toContain(`pre-checkout=${fixture.alphaBase}`)
    expect(git(component, "rev-parse", "HEAD")).toBe(newestAlpha)
  })

  it("checks out an on-main gitlink moved by the candidate so the settled worktree matches HEAD", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-candidate-gitlink-checkout-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const component = join(fixture.product, "packages/alpha")
    const newestAlpha = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 2\n")
    git(fixture.product, "switch", "-q", "-c", "candidate-gitlink")
    git(component, "fetch", "-q", "origin")
    git(component, "checkout", "-q", newestAlpha)
    git(fixture.product, "add", "packages/alpha")
    git(fixture.product, "commit", "-q", "-m", "advance alpha to component main")
    const candidate = git(fixture.product, "rev-parse", "HEAD")
    git(fixture.product, "switch", "-q", "main")
    git(component, "checkout", "-q", fixture.alphaBase)

    const result = await superMerge({ repo: fixture.product, commit: candidate, noVerify: true })

    expect(result).toMatchObject({ state: "updated", partial: false })
    expect(git(fixture.product, "ls-tree", "HEAD", "packages/alpha")).toContain(newestAlpha)
    expect(git(component, "rev-parse", "HEAD")).toBe(newestAlpha)
    expect(git(fixture.product, "status", "--porcelain=v1")).toBe("")
  })

  it("returns a named partial with the recovery command when a raised checkout cannot settle", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-checkout-failure-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const component = join(fixture.product, "packages/alpha")
    const newestAlpha = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 2\n")
    const candidate = candidateWithRootChange(fixture, "candidate-checkout-failure")
    const headBefore = git(fixture.product, "rev-parse", "HEAD")
    const local = createLocalGitProcess()
    const probe = injectionProbe()

    const result = await superMerge({
      repo: fixture.product,
      commit: candidate,
      git: {
        run: (request) => {
          probe.observe(request)
          if (request.repo === component && request.args[0] === "checkout" && request.args.at(-1) === newestAlpha) {
            probe.fire("checkout failure")
            return Promise.resolve({ code: 1, stdout: "", stderr: "injected checkout failure" })
          }
          return local.run(request)
        },
      },
    })

    probe.expectFired("checkout failure")
    expect(result).toMatchObject({
      state: "failed",
      partial: true,
      detail: {
        code: "component-checkout-failed",
        phase: "settle-component-checkout",
        paths: ["packages/alpha"],
        next: expect.stringContaining("Inspect the preserved root merge"),
      },
      gitlinks: [{ path: "packages/alpha", from: fixture.alphaBase, to: newestAlpha, state: "raised" }],
      checkouts: [
        {
          path: "packages/alpha",
          recorded: fixture.alphaBase,
          index: newestAlpha,
          preCheckout: fixture.alphaBase,
          checkout: fixture.alphaBase,
          state: "restored",
        },
      ],
    })
    expect(result.commit).toBeUndefined()
    expect(git(fixture.product, "rev-parse", "HEAD")).toBe(headBefore)
    expect(git(component, "rev-parse", "HEAD")).toBe(fixture.alphaBase)
  })

  it("restores a checkout when its staged-pin settlement cannot be observed", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-settlement-observation-failure-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const component = join(fixture.product, "packages/alpha")
    const newestAlpha = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 2\n")
    const candidate = candidateWithRootChange(fixture, "candidate-settlement-observation-failure")
    const headBefore = git(fixture.product, "rev-parse", "HEAD")
    const local = createLocalGitProcess()
    const probe = injectionProbe()
    let settling = false

    const result = await superMerge({
      repo: fixture.product,
      commit: candidate,
      git: {
        run: async (request) => {
          probe.observe(request)
          const observed = await local.run(request)
          if (
            request.repo === component &&
            request.args[0] === "checkout" &&
            request.args.at(-1) === newestAlpha &&
            observed.code === 0
          ) {
            settling = true
            return observed
          }
          if (settling && request.repo === component && request.args.join(" ") === "rev-parse HEAD^{commit}") {
            settling = false
            probe.fire("checkout observation mismatch")
            return { code: 0, stdout: `${fixture.betaBase}\n`, stderr: "" }
          }
          return observed
        },
      },
    })

    probe.expectFired("checkout observation mismatch")
    expect(result).toMatchObject({
      state: "failed",
      partial: true,
      detail: {
        code: "component-checkout-failed",
        message: expect.stringContaining("checkout observation mismatch"),
      },
      checkouts: [
        {
          path: "packages/alpha",
          recorded: fixture.alphaBase,
          index: newestAlpha,
          preCheckout: fixture.alphaBase,
          checkout: fixture.alphaBase,
          state: "restored",
        },
      ],
    })
    expect(git(fixture.product, "rev-parse", "HEAD")).toBe(headBefore)
    expect(git(fixture.product, "rev-parse", "MERGE_HEAD")).toBe(candidate)
    expect(git(fixture.product, "ls-files", "--stage", "--", "packages/alpha")).toContain(newestAlpha)
    expect(git(component, "rev-parse", "HEAD")).toBe(fixture.alphaBase)
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
    expect(stderr.output).toContain("shared.txt")
    const detailed = await superMerge({ repo: repository, commit: candidate })
    expect(detailed.detail?.paths).toEqual(["shared.txt"])
    expect(git(repository, "rev-parse", "HEAD")).toBe(headBefore)
    expect(git(repository, "status", "--porcelain=v1")).toBe(statusBefore)
  })

  it("disables commit graphs when alternate-backed worktree history makes a clean gitlink merge unreadable", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-stale-commit-graph-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const targetAlpha = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 2\n")
    const productAlpha = join(fixture.product, "packages/alpha")
    git(productAlpha, "fetch", "-q", "origin")
    git(fixture.product, "switch", "-q", "-c", "candidate-graph-target")
    git(productAlpha, "checkout", "-q", targetAlpha)
    git(fixture.product, "add", "packages/alpha")
    git(fixture.product, "commit", "-q", "-m", "advance alpha on target")
    const target = git(fixture.product, "rev-parse", "HEAD")
    git(fixture.product, "switch", "-q", "main")
    git(productAlpha, "checkout", "-q", fixture.alphaBase)

    const worktree = join(fixtureRoot, "worktree")
    const addedStdout = outputSink()
    const addedStderr = outputSink()
    expect(
      await runCli(["--repo", fixture.product, "worktree", "add", worktree, "HEAD"], addedStdout, addedStderr),
    ).toBe(0)
    const worktreeAlpha = join(worktree, "packages/alpha")
    git(worktree, "switch", "-q", "-c", "newer-than-graph")
    git(worktreeAlpha, "checkout", "-q", targetAlpha)
    git(worktreeAlpha, "commit-graph", "write", "--reachable", "--split")
    writeFileSync(join(worktreeAlpha, "alpha.ts"), "export const alpha = 3\n")
    git(worktreeAlpha, "add", "alpha.ts")
    git(worktreeAlpha, "commit", "-q", "-m", "first alpha commit after graph")
    writeFileSync(join(worktreeAlpha, "alpha.ts"), "export const alpha = 4\n")
    git(worktreeAlpha, "commit", "-q", "-am", "second alpha commit after graph")
    const newerAlpha = git(worktreeAlpha, "rev-parse", "HEAD")
    git(worktree, "add", "packages/alpha")
    git(worktree, "commit", "-q", "-m", "pin alpha newer than graph")
    const head = git(worktree, "rev-parse", "HEAD")
    const local = createLocalGitProcess()

    const graphOn = await local.run({
      repo: worktree,
      args: ["-c", "core.commitGraph=true", "merge-tree", "--write-tree", "--name-only", head, target],
    })
    const graphOff = await local.run({
      repo: worktree,
      args: ["-c", "core.commitGraph=false", "merge-tree", "--write-tree", "--name-only", head, target],
    })

    expect(graphOn.code).toBe(1)
    expect(graphOn.stderr).toContain("Could not read")
    expect(`${graphOn.stdout}\n${graphOn.stderr}`).toContain("CONFLICT (submodule): Merge conflict in packages/alpha")
    expect(graphOff.code).toBe(0)
    expect(graphOff.stderr).toBe("")

    const result = await superMerge({ repo: worktree, commit: target })

    expect(result.state).toBe("updated")
    expect(result.partial).toBe(false)
    expect(git(worktree, "ls-tree", "HEAD", "packages/alpha")).toContain(newerAlpha)
  })

  it("reports an unreadable merge-tree object with its stderr and sha instead of a merge conflict", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-unreadable-history-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const candidate = candidateWithRootChange(fixture, "candidate-unreadable-history")
    const local = createLocalGitProcess()
    const probe = injectionProbe()
    const unreadable = "a".repeat(40)

    const result = await superMerge({
      repo: fixture.product,
      commit: candidate,
      git: {
        run: (request) => {
          probe.observe(request)
          if (request.repo === fixture.product && request.args.includes("merge-tree")) {
            probe.fire("unreadable merge-tree object")
            return Promise.resolve({
              code: 1,
              stdout: "",
              stderr: `error: Could not read ${unreadable}`,
            })
          }
          return local.run(request)
        },
      },
    })

    probe.expectFired("unreadable merge-tree object")
    expect(result.state).toBe("failed")
    expect(result.partial).toBe(false)
    expect(result.detail?.code).toBe("component-history-unreadable")
    expect(result.detail?.message).toContain(`error: Could not read ${unreadable}`)
    expect(result.detail?.objectIds).toContain(unreadable)
    expect(result.detail?.message).not.toContain("merge-conflict")
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
    const probe = injectionProbe()

    const result = await superMerge({
      repo: fixture.product,
      commit: candidate,
      git: {
        run: (request) => {
          probe.observe(request)
          if (request.repo === component && request.args[0] === "merge-base") {
            probe.fire("ancestry probe failure")
            return Promise.resolve({ code: 128, stdout: "", stderr: "injected ancestry failure" })
          }
          return local.run(request)
        },
      },
    })

    probe.expectFired("ancestry probe failure")
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

  it("returns a named partial with completed and not-run raises in the uncommitted merge", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-partial-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 2\n")
    advanceRepository(fixture.beta, "beta.ts", "export const beta = 2\n")
    const candidate = candidateWithRootChange(fixture, "candidate-partial")
    const headBefore = git(fixture.product, "rev-parse", "HEAD")
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
    expect(result.commit).toBeUndefined()
    expect(git(fixture.product, "rev-parse", "HEAD")).toBe(headBefore)
    expect(git(fixture.product, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(1)
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
          if (request.args.includes("merge") && observed.code === 0) merged = true
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
      detail: { code: "post-commit-observation-failed", phase: "observe-settled-merge" },
      gitlinks: [],
    })
    expect(result.commit).toBeUndefined()
    expect(git(repository, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3)
  })
})
