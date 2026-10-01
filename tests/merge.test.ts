/**
 * @failure A merge records a gitlink commit that submodule main does not contain.
 * @level l1
 * @consumer Yrd settled candidate preparation and landing
 * @reach fs-walk <fixture-only: superMerge uses Git repos under mkdtempSync(canonicalTmpdir())>
 */
import { chmodSync, existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative } from "node:path"
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest"
import { runCli } from "../src/cli.ts"
import { acquireExclusive } from "../src/exclusive.ts"
import { superPush } from "../src/push.ts"
import { decodePushIntent, PUSH_INTENT_TRAILER } from "../src/push-intent.ts"
import { SUPER_MERGE_STEPS, superMerge } from "../src/merge.ts"
import { superWorktreeAdd } from "../src/worktree-add.ts"
import { createLocalGitProcess, type GitProcess, type GitProcessRequest } from "../src/process.ts"
import { materializeSubmodulesWithProcess } from "../src/submodules.ts"
import type { GitResultDetail } from "../src/result.ts"
import {
  addNestedAlphaSubmodule,
  advanceRepository,
  canonicalTmpdir as tmpdir,
  createProductFixture as createLocalProductFixture,
  createRepository,
  git,
  injectionProbe,
  type NestedProductFixture,
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

/** Merge ownership is hosted identity; Git's rewrite keeps fixture transport local. */
function createProductFixture(root: string): ProductFixture {
  const fixture = createLocalProductFixture(root)
  git(fixture.product, "remote", "add", "origin", "https://git-super.test/owned/product.git")
  for (const [path, repository, name] of [
    ["packages/alpha", fixture.alpha, "alpha"],
    ["vendor/beta", fixture.beta, "beta"],
  ] as const) {
    const url = `https://git-super.test/owned/${name}.git`
    git(fixture.product, "config", "--file", ".gitmodules", `submodule.${path}.url`, url)
    git(fixture.product, "config", `submodule.${path}.url`, url)
    git(join(fixture.product, path), "remote", "set-url", "origin", url)
    git(join(fixture.product, path), "config", `url.${repository}.insteadOf`, url)
  }
  git(fixture.product, "commit", "-q", "--amend", "-am", "declare hosted merge fixture identities")
  return { ...fixture, productBase: git(fixture.product, "rev-parse", "HEAD") }
}

/**
 * The hosted fixture, one level deeper: `packages/alpha/apps/maddoc`, which is
 * the shape of the real `km/apps/maddoc` this row's acceptance names.
 *
 * The nested leaf needs a HOSTED identity of its own, exactly as
 * `createProductFixture` gives alpha and beta. Without it `planGitlinks` takes
 * the `sameHostedOwner` branch, records the pin `as-written` and never asks its
 * main anything -- so the arm would pass for the wrong reason, on a level that
 * was skipped rather than classified.
 */
function createNestedProductFixture(root: string): NestedProductFixture {
  const fixture = addNestedAlphaSubmodule(createProductFixture(root))
  const url = "https://git-super.test/owned/leaf.git"
  // ALPHA MAIN declares the nested identity, exactly as km main declares
  // maddoc's. Declaring it only on the product's checkout loses it the moment an
  // arm cuts its candidate from alpha main -- and the freeze then refuses the
  // leaf as an unhosted local path, which is a fixture fault wearing the costume
  // of a real refusal.
  git(fixture.alpha, "config", "--file", ".gitmodules", "submodule.apps/maddoc.url", url)
  git(fixture.alpha, "config", "submodule.apps/maddoc.url", url)
  git(fixture.alpha, "config", `url.${fixture.leaf}.insteadOf`, url)
  git(fixture.alpha, "commit", "-q", "-am", "declare hosted nested identity")
  const alphaCheckout = join(fixture.product, "packages/alpha")
  git(alphaCheckout, "fetch", "-q", "origin")
  git(alphaCheckout, "checkout", "-q", git(fixture.alpha, "rev-parse", "HEAD"))
  git(join(alphaCheckout, "apps/maddoc"), "remote", "set-url", "origin", url)
  git(join(alphaCheckout, "apps/maddoc"), "config", `url.${fixture.leaf}.insteadOf`, url)
  git(fixture.product, "add", "packages/alpha")
  git(fixture.product, "commit", "-q", "-m", "pin alpha with hosted nested identity")
  return { ...fixture, productWithNestedBase: git(fixture.product, "rev-parse", "HEAD") }
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
  /**
   * @failure A merge adds a gitlink but leaves its prepared store without a checkout before the concluding commit hook (26988).
   * @level l1
   * @consumer git-super merge and authoring hooks
   * @testonly none
   */
  it.each(["none", "exit", "throw", "timeout", "stage0", "head", "mismatch", "unknown-pin", "continue"] as const)(
    "initializes an added gitlink at its pin before the concluding commit hook (26988), initialization case=%s",
    async (failure) => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-added-"))
      roots.push(fixtureRoot)
      const fixture = createProductFixture(fixtureRoot)
      const primary = join(fixtureRoot, "primary")
      const checkout = join(fixtureRoot, "checkout")
      const gamma = join(fixtureRoot, "gamma")
      const gammaBase = createRepository(gamma, "gamma.ts", "export const gamma = 1\n")
      const rootUrl = "https://git-super.test/owned/product.git"
      const gammaUrl = "https://git-super.test/owned/gamma.git"
      // Ownership remains hosted; every recursive Git process uses local fixture transport.
      const config = [
        ["protocol.file.allow", "always"],
        [`url.${fixture.product}.insteadOf`, rootUrl],
        [`url.${fixture.alpha}.insteadOf`, "https://git-super.test/owned/alpha.git"],
        [`url.${fixture.beta}.insteadOf`, "https://git-super.test/owned/beta.git"],
        [`url.${gamma}.insteadOf`, gammaUrl],
      ] as const
      vi.stubEnv("GIT_CONFIG_COUNT", String(config.length))
      for (const [index, [key, value]] of config.entries()) {
        vi.stubEnv(`GIT_CONFIG_KEY_${index}`, key)
        vi.stubEnv(`GIT_CONFIG_VALUE_${index}`, value)
      }
      try {
        if (failure === "continue") {
          writeFileSync(join(fixture.product, "README.md"), "base root content\n")
          git(fixture.product, "add", "README.md")
          git(fixture.product, "commit", "-q", "-m", "base root content")
        }
        git(fixtureRoot, "clone", "-q", "--recurse-submodules", rootUrl, primary)
        git(primary, "worktree", "add", "-q", "-b", "task/added-gitlink", checkout, "HEAD")
        const initial = await materializeSubmodulesWithProcess(createLocalGitProcess(), {
          worktree: checkout,
          referenceWorktree: primary,
        })
        expect(initial).toMatchObject({ code: 0, considered: 2, borrowed: 2, remoteFallbacks: 0, unreferenced: 0 })
        if (failure === "continue") {
          writeFileSync(join(fixture.product, "README.md"), "incoming root content\n")
          git(fixture.product, "add", "README.md")
          writeFileSync(join(checkout, "README.md"), "local root content\n")
          git(checkout, "commit", "-q", "-am", "local root content")
        }
        git(fixture.product, "submodule", "add", "-q", gammaUrl, "vendor/gamma")
        git(fixture.product, "commit", "-q", "-m", "main adds gamma")
        const gammaPin =
          failure === "unknown-pin" ? gammaBase : advanceRepository(gamma, "gamma.ts", "export const gamma = 2\n")
        git(checkout, "fetch", "-q", "origin")
        const hook = git(checkout, "rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-commit")
        writeFileSync(
          hook,
          "#!/bin/sh\nif ! test -e vendor/gamma/.git; then echo 'added gitlink checkout missing before commit' >&2; exit 1; fi\n",
        )
        chmodSync(hook, 0o755)
        const alphaBefore = git(join(checkout, "packages/alpha"), "rev-parse", "HEAD")
        advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 2\n")
        const local = createLocalGitProcess()
        const requests: GitProcessRequest[] = []
        const process: GitProcess = {
          run: (request) => {
            requests.push(request)
            if (
              failure === "stage0" &&
              request.repo === checkout &&
              request.args.join(" ") === "rev-parse :vendor/gamma"
            ) {
              return Promise.resolve({ code: 1, stdout: "", stderr: "injected stage-0 read failure" })
            }
            if (
              (failure === "head" || failure === "mismatch") &&
              request.repo === join(checkout, "vendor/gamma") &&
              request.args.join(" ") === "rev-parse HEAD^{commit}"
            ) {
              return Promise.resolve(
                failure === "head"
                  ? { code: 1, stdout: "", stderr: "injected unreadable HEAD" }
                  : { code: 0, stdout: rootBefore, stderr: "" },
              )
            }
            if (
              (failure === "exit" || failure === "throw" || failure === "timeout" || failure === "unknown-pin") &&
              request.args.includes("update") &&
              request.args.includes("vendor/gamma")
            ) {
              if (failure === "throw") throw new Error("injected thrown initialization failure")
              if (failure === "timeout") {
                return Promise.resolve({
                  code: 1,
                  stdout: "",
                  stderr: "injected timeout",
                  timedOut: true,
                  failure: "SIGTERM",
                })
              }
              return Promise.resolve({ code: 1, stdout: "", stderr: "injected added-submodule initialization failure" })
            }
            return local.run(request)
          },
        }
        const rootBefore = git(checkout, "rev-parse", "HEAD")
        if (failure === "continue") {
          const pending = await superMerge({
            repo: checkout,
            commit: "origin/main",
            git: process,
            preserveConflicts: true,
            timeoutMs: 12345,
          })
          expect(pending).toMatchObject({ state: "failed", partial: true })
          expect(existsSync(join(checkout, "vendor/gamma/.git"))).toBe(false)
          writeFileSync(join(checkout, "README.md"), "human root resolution\n")
          git(checkout, "add", "README.md")
        }
        const result = await superMerge({
          repo: checkout,
          commit: "origin/main",
          git: process,
          timeoutMs: 12345,
          ...(failure === "continue"
            ? { continue: true, expectedHead: rootBefore, expectedBranch: "refs/heads/task/added-gitlink" }
            : {}),
        })
        if (failure === "stage0") {
          expect(result).toMatchObject({
            state: "failed",
            partial: true,
            repositories: [{ state: "updated" }],
            detail: { phase: "observe-added-gitlink" },
          })
          expect(result.gitlinks).toContainEqual(expect.objectContaining({ path: "packages/alpha", state: "raised" }))
          expect(git(checkout, "rev-parse", ":vendor/gamma")).toBe(gammaPin)
          expect(git(checkout, "rev-parse", "HEAD")).toBe(rootBefore)
          return
        }
        if (failure !== "none" && failure !== "continue") {
          expect(result).toMatchObject({
            state: "failed",
            partial: true,
            detail: {
              code:
                failure === "head"
                  ? "added-submodule-head-unreadable"
                  : failure === "mismatch"
                    ? "added-submodule-not-at-gitlink"
                    : "added-submodule-initialization-failed",
              phase: "initialize-added-submodule",
              paths: ["vendor/gamma"],
            },
            initializations: [{ path: "vendor/gamma", index: gammaPin, state: "initialization-failed" }],
          })
          expect(result.detail?.message).toContain(gammaPin)
          if (failure === "throw") expect(result.detail?.message).toContain("injected thrown initialization failure")
          expect(git(checkout, "rev-parse", "HEAD")).toBe(rootBefore)
          expect(git(checkout, "rev-parse", ":vendor/gamma")).toBe(gammaPin)
          expect(git(join(checkout, "packages/alpha"), "rev-parse", "HEAD")).toBe(alphaBefore)
          expect(result.steps?.at(-1)?.name).toBe("initialize")
          expect(existsSync(join(checkout, "vendor/gamma/.git"))).toBe(failure === "head" || failure === "mismatch")
          if (failure === "unknown-pin") expect(result.detail?.message).not.toContain("incoming pin")
          if (failure === "timeout") {
            expect(result.detail?.message).toContain("timed out")
            expect(result.detail?.message).toContain("SIGTERM")
            expect(result.initializations).toContainEqual(
              expect.objectContaining({
                materialization: expect.objectContaining({ timedOut: true, failure: "SIGTERM" }),
              }),
            )
          }
          return
        }
        // The caller must borrow on its OWN call; a second explicit-reference call masked the regression.
        const update = requests.find(
          (request) => request.args.includes("update") && request.args.includes("vendor/gamma"),
        )
        expect(update?.args).toEqual(expect.arrayContaining(["--reference", "--no-fetch"]))
        expect(update?.timeoutMs).toBe(12345)
        expect(result.initializations).toContainEqual(
          expect.objectContaining({
            path: "vendor/gamma",
            materialization: { considered: 1, borrowed: 1, remoteFallbacks: 0, unreferenced: 0 },
          }),
        )
        const common = git(checkout, "rev-parse", "--path-format=absolute", "--git-common-dir")
        expect(existsSync(join(primary, "vendor/gamma/.git"))).toBe(false)
        expect(git(join(common, "modules/vendor/gamma"), "rev-parse", `${gammaPin}^{commit}`)).toBe(gammaPin)
        expect(result.detail).toBeUndefined()
        expect(result.state).toBe("updated")
        expect(result.initializations).toContainEqual(
          expect.objectContaining({
            path: "vendor/gamma",
            index: gammaPin,
            checkout: gammaPin,
            state: "initialized",
          }),
        )
        const gammaCheckout = join(checkout, "vendor/gamma")
        expect(git(gammaCheckout, "rev-parse", "HEAD")).toBe(gammaPin)
        const gitdir = git(gammaCheckout, "rev-parse", "--path-format=absolute", "--git-dir")
        expect(gitdir).toBe(join(common, "worktrees/checkout/modules/vendor/gamma"))
        expect(readFileSync(join(gitdir, "objects/info/alternates"), "utf8").trim()).toBe(
          join(common, "modules/vendor/gamma/objects"),
        )
      } finally {
        vi.unstubAllEnvs()
      }
    },
  )

  /**
   * @failure An existing parent acquires a nested gitlink and a merge silently leaves it uninitialized.
   * @level l1
   * @consumer git-super merge
   */
  it.each([false, true])(
    "names a nested addition in an existing submodule before applying the root merge, already initialized=%s",
    async (initializeBeforeMerge) => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-nested-added-"))
      roots.push(fixtureRoot)
      const fixture = createProductFixture(fixtureRoot)
      const before = git(fixture.product, "rev-parse", "HEAD")
      const alphaBefore = git(join(fixture.product, "packages/alpha"), "rev-parse", "HEAD")
      const leaf = join(fixtureRoot, "leaf")
      const leafPin = createRepository(leaf, "leaf.ts", "export const leaf = 1\n")
      git(fixture.alpha, "-c", "protocol.file.allow=always", "submodule", "add", "-q", leaf, "apps/leaf")
      const leafUrl = "https://git-super.test/owned/leaf.git"
      git(fixture.alpha, "config", "--file", ".gitmodules", "submodule.apps/leaf.url", leafUrl)
      git(fixture.alpha, "config", "submodule.apps/leaf.url", leafUrl)
      vi.stubEnv("GIT_CONFIG_COUNT", "2")
      vi.stubEnv("GIT_CONFIG_KEY_0", `url.${leaf}.insteadOf`)
      vi.stubEnv("GIT_CONFIG_VALUE_0", leafUrl)
      vi.stubEnv("GIT_CONFIG_KEY_1", "protocol.file.allow")
      vi.stubEnv("GIT_CONFIG_VALUE_1", "always")
      onTestFinished(() => {
        vi.unstubAllEnvs()
      })
      git(fixture.alpha, "-c", "protocol.file.allow=always", "submodule", "add", "-q", leaf, "apps/other")
      git(fixture.alpha, "config", "--file", ".gitmodules", "submodule.apps/other.url", leafUrl)
      git(fixture.alpha, "config", "submodule.apps/other.url", leafUrl)
      git(fixture.alpha, "commit", "-q", "-am", "add nested leaves")
      const alphaCheckout = join(fixture.product, "packages/alpha")
      if (initializeBeforeMerge) {
        git(alphaCheckout, "fetch", "-q", "origin")
        git(alphaCheckout, "checkout", "-q", git(fixture.alpha, "rev-parse", "HEAD"))
        git(alphaCheckout, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive")
      }
      const candidate = candidateWithRootChange(fixture, "candidate-nested-addition")
      const result = await superMerge({ repo: fixture.product, commit: candidate })
      if (initializeBeforeMerge) {
        expect(result, JSON.stringify(result)).toMatchObject({ state: "updated", partial: false })
        expect(result.initializations).toBeUndefined()
        expect(git(join(alphaCheckout, "apps/leaf"), "rev-parse", "HEAD")).toBe(leafPin)
        return
      }
      expect(result, JSON.stringify(result)).toMatchObject({
        state: "failed",
        partial: false,
        detail: {
          code: "nested-submodule-initialization-required",
          paths: ["packages/alpha/apps/leaf", "packages/alpha/apps/other"],
        },
        gitlinks: [],
        initializations: [
          { path: "packages/alpha/apps/leaf", index: leafPin, state: "initialization-required" },
          { path: "packages/alpha/apps/other", index: leafPin, state: "initialization-required" },
        ],
      })
      expect(git(fixture.product, "rev-parse", "HEAD")).toBe(before)
      expect(git(join(fixture.product, "packages/alpha"), "rev-parse", "HEAD")).toBe(alphaBefore)
      expect(git(fixture.product, "status", "--porcelain")).toBe("")
    },
  )

  /**
   * @failure A submit's candidate merge gives up after 30 s while the queue's merge still holds the writer lock (25274).
   * @level l1
   * @consumer Yrd submit candidate verification
   */
  it("waits for a queue merge holding the writer lock past 30 seconds", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-writer-wait-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const candidate = candidateWithRootChange(fixture, "candidate-writer-wait")
    const lockDirectory = join(fixture.product, ".git", "yrd-worktree-mutations")
    const held = await acquireExclusive(lockDirectory, { timeoutMs: 0 }, "git super merge")
    // CLI startup takes time before lock acquisition; leave enough margin beyond its 30 s default.
    const release = Bun.sleep(40_000).then(() => held.release())
    try {
      const ordinaryWait = acquireExclusive(lockDirectory, {}, "ordinary mutation").then(
        (lock) => {
          lock.release()
          return "acquired"
        },
        (error: unknown) => error,
      )
      const stdout = outputSink()
      const stderr = outputSink()
      expect(await runCli(["--repo", fixture.product, "--json", "merge", candidate], stdout, stderr)).toBe(0)
      expect(JSON.parse(stdout.output)).toMatchObject({ state: "updated", partial: false })
      const reports = stderr.output.match(
        /git-super merge: waiting for writer lock held by git super merge \(pid:\d+, age \d+ms\)\n/gu,
      )
      expect(reports?.length).toBeGreaterThanOrEqual(4)
      expect(reports?.join("")).toBe(stderr.output)
      const ordinaryResult = await ordinaryWait
      expect(ordinaryResult).toBeInstanceOf(Error)
      expect((ordinaryResult as Error).message).toMatch(/timeout=30000ms; holder=git super merge/u)
    } finally {
      await release
    }
  }, 75_000)

  /**
   * @failure Merge's lock call site silently reverts to a 30 s wait despite the shared four-minute policy (25274).
   * @level l1
   * @consumer Yrd submit candidate verification
   */
  it("wires the shared mutation wait through merge after 30 seconds virtual", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-writer-virtual-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const candidate = candidateWithRootChange(fixture, "candidate-writer-virtual")
    const dir = join(fixture.product, ".git", "yrd-worktree-mutations")
    const held = await acquireExclusive(dir, { timeoutMs: 0 }, "queue merge")
    const reports: string[] = []
    let released = false
    const release = () => {
      if (released) return
      released = true
      held.release()
    }
    const releaseSoon = Bun.sleep(1_500).then(release)
    vi.useFakeTimers({ toFake: ["Date"] })
    let running: ReturnType<typeof superMerge> | undefined
    try {
      const startedAt = Date.now()
      running = superMerge({ repo: fixture.product, commit: candidate, report: (line) => reports.push(line) })
      for (let poll = 0; poll < 100 && reports.length === 0; poll += 1) await Bun.sleep(10)
      expect(reports).toHaveLength(1)
      vi.setSystemTime(startedAt + 31_000)
      const result = await running
      expect(result).toMatchObject({ state: "updated", partial: false })
      expect(reports[0]).toMatch(/^git-super merge: waiting for writer lock held by queue merge /u)
    } finally {
      await releaseSoon
      release()
      if (running !== undefined) await Promise.allSettled([running])
      vi.useRealTimers()
    }
  }, 30_000)

  /**
   * @failure Merge settlement reads main although Git config selects another submodule branch.
   * @level l1
   * @consumer Configured submodule merge containment
   */
  it("settles against the configured submodule branch", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-configured-branch-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    git(fixture.alpha, "switch", "-q", "-c", "stable")
    const stable = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 'stable'\n")
    git(fixture.product, "config", "submodule.packages/alpha.branch", "stable")
    const candidate = candidateWithRootChange(fixture, "candidate-stable")
    const result = await superMerge({ repo: fixture.product, commit: candidate })
    expect(result).toMatchObject({
      state: "updated",
      gitlinks: [expect.objectContaining({ path: "packages/alpha", to: stable, state: "raised" })],
    })
    expect(git(fixture.product, "rev-parse", "HEAD:packages/alpha")).toBe(stable)
    expect(git(fixture.alpha, "rev-parse", "main")).toBe(fixture.alphaBase)
  })

  it("refuses a moved off-main pin whose component merge conflicts before changing the checkout (25389)", async () => {
    const refusedRoot = mkdtempSync(join(tmpdir(), "git-super-merge-refused-"))
    roots.push(refusedRoot)
    const refused = createProductFixture(refusedRoot)
    const refusedMain = advanceRepository(refused.alpha, "alpha.ts", "export const alpha = 'competing'\n")
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
    expect(refusedStderr.output).toContain("gitlink-compose-refused")
    expect(refusedStderr.output).toContain("packages/alpha")
    expect(refusedStderr.output).toContain("alpha.ts")
    expect(refusedStderr.output).toContain(unpublished)
    expect(refusedStderr.output).toContain(refusedMain)
    expect(refusedStderr.output).toContain("evidence:")
    expect(refusedStderr.output).toContain("next:")
    expect(refusedStderr.output).toContain("owner: the caller")
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
        code: "gitlink-compose-refused",
        subject: expect.stringContaining("packages/alpha"),
        evidence: expect.stringContaining(`merge-tree --write-tree ${refusedMain} ${unpublished}`),
        next: expect.stringContaining("Merge the submodule's own main"),
        owner: "the caller",
      },
    })
  })

  /**
   * @failure A component main that moves between the plan's read and the freeze is leased at a commit the merge never
   * composed against, or its non-ancestor answer is reported as git-failed (25591, 25570).
   * @level l1
   * @consumer Yrd submit candidate verification and the round's leased publication
   */
  it("leases a component main that moves mid-merge at the plan's own read, which publication's lease then refuses", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-component-main-ahead-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const alphaCheckout = join(fixture.product, "packages/alpha")
    const rootPin = advanceRepository(fixture.alpha, "root-side.ts", "export const root = 1\n")
    git(fixture.alpha, "switch", "-q", "-c", "change-side", fixture.alphaBase)
    const changePin = advanceRepository(fixture.alpha, "change-side.ts", "export const change = 1\n")
    git(fixture.alpha, "switch", "-q", "main")
    git(alphaCheckout, "fetch", "-q", "origin")

    git(fixture.product, "switch", "-q", "-c", "candidate-old-component")
    git(alphaCheckout, "checkout", "-q", changePin)
    git(fixture.product, "add", "packages/alpha")
    git(fixture.product, "commit", "-q", "-m", "pin change side")
    const candidate = git(fixture.product, "rev-parse", "HEAD")
    git(fixture.product, "switch", "-q", "main")
    git(alphaCheckout, "checkout", "-q", rootPin)
    git(fixture.product, "add", "packages/alpha")
    git(fixture.product, "commit", "-q", "-m", "pin root side")
    const rootHead = git(fixture.product, "rev-parse", "HEAD")
    git(fixture.alpha, "switch", "-q", "-c", "pending-main")
    const componentMain = advanceRepository(fixture.alpha, "later-main.ts", "export const later = 1\n")
    git(fixture.alpha, "switch", "-q", "main")
    const local = createLocalGitProcess()
    let advanced = false
    const racing: GitProcess = {
      run: async (request) => {
        const result = await local.run(request)
        // The component's main moves the moment after the plan has read it.
        if (!advanced && request.repo === alphaCheckout && request.args[0] === "fetch") {
          git(fixture.alpha, "merge", "-q", "--ff-only", "pending-main")
          advanced = true
        }
        return result
      },
    }

    const result = await superMerge({ repo: fixture.product, commit: candidate, git: racing })

    expect(advanced).toBe(true)
    expect(result).toMatchObject({ state: "updated", partial: false })
    const merge = git(fixture.product, "rev-parse", "HEAD")
    expect(merge).not.toBe(rootHead)
    const composed = git(fixture.product, "rev-parse", "HEAD:packages/alpha")
    expect(git(alphaCheckout, "cat-file", "-p", composed)).toContain(`parent ${rootPin}`)
    const encoded = git(
      fixture.product,
      "show",
      "-s",
      `--format=%(trailers:key=${PUSH_INTENT_TRAILER},valueonly)`,
      merge,
    )
    // The lease is the main the merge composed against, not the one that moved after: publication refuses it
    // (push.test "(b) a child main moved after capture is refused at the push").
    expect(decodePushIntent(encoded).children.find((row) => row.path === "packages/alpha")?.publication).toMatchObject({
      source: composed,
      expectedDestination: { state: "oid", oid: rootPin },
    })
    expect(componentMain).not.toBe(rootPin)
  })

  it("reports untouched off-main pins without changing them", async () => {
    const leftRoot = mkdtempSync(join(tmpdir(), "git-super-merge-left-off-main-"))
    roots.push(leftRoot)
    const left = createProductFixture(leftRoot)
    const leftMain = advanceRepository(left.alpha, "alpha.ts", "export const alpha = 'diverged'\n")
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
    expect(leftStderr.output).toContain(leftMain)
    expect(git(left.product, "ls-tree", "HEAD", "packages/alpha")).toContain(leftOffMain)
    expect(git(left.product, "show", "-s", "--format=%B", "HEAD")).toContain(
      `Settled: packages/alpha@${leftOffMain} left-off-main submodule-main@${leftMain}`,
    )
  })

  /**
   * THE CLEAN-ROOM CASE, and it is the one the queue actually runs.
   *
   * `composeCandidate` opens the compose worktree at the TARGET sha and populates
   * reference stores for TARGET pins only. `planGitlinks` then fetches nothing
   * but `+refs/heads/main` before asking whether the candidate pin is contained
   * in it. So for a CREATE-ONLY pin — a new commit in a submodule, which is every
   * real fix in one — the object is simply not there, and the containment check
   * dies with exit 128 "Not a valid commit name" for a commit that IS published.
   *
   * `submit` publishes it as `refs/git-super/pins/<sha>`, so the object is
   * reachable from the remote and nothing on this path ever asks for it.
   *
   * Specimen: `task/dev4-24385` bounced FIVE times on exactly this, across four
   * distinct upstream causes that each masked it in turn.
   *
   * The fixture reproduces the clean room without destroying anything: the pin is
   * made in a SEPARATE clone and pushed to the remote as a pin ref only, and the
   * product's gitlink is written with `update-index --cacheinfo`, so the
   * product's own submodule store has never seen the object.
   */
  it("settles kept-ahead for a pin published only as a pin ref, which its store has never seen", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-cleanroom-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)

    // The candidate pin is created somewhere the product cannot see, and reaches
    // the remote ONLY as a pin ref — never on a branch.
    const authoring = join(fixtureRoot, "alpha-authoring")
    git(fixtureRoot, "clone", "-q", fixture.alpha, authoring)
    const pin = advanceRepository(authoring, "alpha.ts", "export const alpha = 'create-only'\n")
    git(authoring, "push", "-q", "origin", `${pin}:refs/git-super/pins/${pin}`)

    git(fixture.product, "switch", "-q", "-c", "candidate-clean-room")
    git(fixture.product, "update-index", "--add", "--cacheinfo", `160000,${pin},packages/alpha`)
    git(fixture.product, "commit", "-q", "-m", "pin alpha at a create-only commit")
    const candidate = git(fixture.product, "rev-parse", "HEAD")
    git(fixture.product, "switch", "-q", "main")

    // POSITIVE CONTROL for the clean room: without this the test could pass on a
    // store that happened to hold the object, proving nothing about the fetch.
    const child = join(fixture.product, "packages/alpha")
    expect(() => git(child, "cat-file", "-e", `${pin}^{commit}`)).toThrow()
    expect(git(fixture.alpha, "rev-parse", "main")).toBe(fixture.alphaBase)

    const result = await superMerge({ repo: fixture.product, commit: candidate })
    expect(result).toMatchObject({
      state: "updated",
      partial: false,
      gitlinks: [expect.objectContaining({ path: "packages/alpha", state: "kept-ahead" })],
    })
    expect(git(fixture.product, "rev-parse", "HEAD:packages/alpha")).toBe(pin)
  })

  /**
   * M8.5: the real merge must freeze an owned ahead pin before checks, and ordinary
   * push must advance it before root. External pins remain as written with no ref
   * writes; unjudged local identity refuses before merge. Prior consumer fixtures
   * manually authored trailers and could not prove the producer or its policy.
   */
  it.each(["owned", "external", "local"] as const)("freezes %s child disposition in the actual merge", async (kind) => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), `git-super-merge-freeze-${kind}-`))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const child = join(fixture.product, "packages/alpha")
    const remote = join(fixtureRoot, "root.git")
    git(fixture.product, "clone", "-q", "--bare", fixture.product, remote)
    git(fixture.product, "config", `url.${remote}.insteadOf`, "https://git-super.test/owned/product.git")
    git(fixture.alpha, "config", "receive.denyCurrentBranch", "ignore")
    git(fixture.product, "switch", "-q", "-c", "candidate-frozen")
    const pin = advanceRepository(child, "alpha.ts", "export const alpha = 'candidate'\n")
    if (kind !== "owned") {
      const url = kind === "external" ? "https://git-super.test/foreign/alpha.git" : fixture.alpha
      git(fixture.product, "config", "--file", ".gitmodules", "submodule.packages/alpha.url", url)
    }
    git(fixture.product, "add", "packages/alpha", ".gitmodules")
    git(fixture.product, "commit", "-q", "-m", "pin candidate alpha")
    const candidate = git(fixture.product, "rev-parse", "HEAD")
    git(fixture.product, "switch", "-q", "main")
    git(child, "switch", "-q", "--detach", fixture.alphaBase)
    const result = await superMerge({ repo: fixture.product, commit: candidate })
    if (kind === "local") {
      expect(result).toMatchObject({ state: "failed", partial: false, detail: { code: "invalid-frozen-push-intent" } })
      expect(git(fixture.product, "rev-parse", "HEAD")).toBe(fixture.productBase)
      expect(git(fixture.alpha, "rev-parse", "main")).toBe(fixture.alphaBase)
      return
    }
    expect(result).toMatchObject({
      state: "updated",
      partial: false,
      gitlinks: [
        expect.objectContaining({ path: "packages/alpha", state: kind === "owned" ? "kept-ahead" : "as-written" }),
      ],
    })
    const merge = git(fixture.product, "rev-parse", "HEAD")
    expect(git(fixture.product, "show", "-s", "--format=%P", merge)).toBe(`${fixture.productBase} ${candidate}`)
    expect(git(fixture.product, "rev-parse", "HEAD:packages/alpha")).toBe(pin)
    const encoded = git(
      fixture.product,
      "show",
      "-s",
      `--format=%(trailers:key=${PUSH_INTENT_TRAILER},valueonly)`,
      merge,
    )
    const intent = decodePushIntent(encoded)
    const row = intent.children.find((entry) => entry.path === "packages/alpha")
    expect(row).toMatchObject({ pin })
    if (kind === "owned") {
      expect(row?.publication).toMatchObject({
        source: pin,
        expectedDestination: { state: "oid", oid: fixture.alphaBase },
      })
    } else expect(row?.publication).toBeUndefined()
    expect(git(fixture.alpha, "rev-parse", "main")).toBe(fixture.alphaBase)
    git(child, "remote", "set-url", "origin", "https://elsewhere.test/moved/alpha.git")
    git(fixture.product, "config", "submodule.packages/alpha.branch", "changed-after-freeze")
    expect(
      await superPush({
        repo: fixture.product,
        remote: "origin",
        refspecs: [`${merge}:refs/heads/main`],
        recurseSubmodules: "on-demand",
      }),
    ).toMatchObject({ state: "updated", partial: false })
    expect(git(fixture.alpha, "rev-parse", "main")).toBe(kind === "owned" ? pin : fixture.alphaBase)
    expect(git(remote, "rev-parse", "main")).toBe(merge)
  })

  it("raises behind pins to the submodule destination", async () => {
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
      `packages/alpha ${raised.alphaBase.slice(0, 7)} -> ${newestAlpha.slice(0, 7)} (submodule main)`,
    )
    expect(git(raised.product, "ls-tree", "HEAD", "packages/alpha")).toContain(newestAlpha)
    expect(git(raised.product, "show", "-s", "--format=%B", "HEAD")).toContain(`Settled: packages/alpha@${newestAlpha}`)
    const merge = git(raised.product, "rev-parse", "HEAD")
    const receipt = git(raised.product, "rev-parse", `refs/git-super/receipts/${merge}`)
    expect(git(raised.product, "show", "-s", "--format=%P", receipt)).toBe(merge)
    expect(git(raised.product, "ls-tree", "--name-only", receipt)).toBe("receipt.json")
    expect(JSON.parse(git(raised.product, "show", `${receipt}:receipt.json`))).toEqual({
      version: 1,
      merge,
      changes: [{ path: "packages/alpha", mode: "160000", from: raised.alphaBase, to: newestAlpha }],
    })
  })

  /**
   * @failure A concurrent receipt writer overwrites attribution or hides a completed merge on failure.
   * @level l1
   * @consumer GitSuper merge receipt create-only publication
   */
  it.each(["identical", "conflicting"])("preserves a %s receipt created during publication", async (kind) => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-receipt-race-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 2\n")
    const candidate = candidateWithRootChange(fixture, "candidate-receipt-race")
    const local = createLocalGitProcess()
    const probe = injectionProbe()
    let winner: string | undefined
    let receiptRef: string | undefined
    const result = await superMerge({
      repo: fixture.product,
      commit: candidate,
      git: {
        async run(request) {
          probe.observe(request)
          if (request.args[0] === "update-ref" && request.args[1]?.startsWith("refs/git-super/receipts/")) {
            probe.fire("receipt-race")
            receiptRef = request.args[1]
            winner = kind === "identical" ? request.args[2] : git(fixture.product, "rev-parse", "HEAD")
            if (winner === undefined) throw new Error("missing proposed receipt")
            git(fixture.product, "update-ref", receiptRef, winner)
          }
          return local.run(request)
        },
      },
    })
    probe.expectFired("receipt-race")
    const merge = git(fixture.product, "rev-parse", "HEAD")
    expect(result).toMatchObject(
      kind === "identical"
        ? { state: "updated", partial: false, commit: merge }
        : {
            state: "failed",
            partial: true,
            commit: merge,
            detail: {
              code: "root-receipt-failed",
              message: expect.stringContaining("conflicts with the validated payload"),
            },
          },
    )
    expect(git(fixture.product, "rev-parse", receiptRef!)).toBe(winner)
    expect(git(fixture.product, "show", "-s", "--format=%P", merge).split(" ")).toHaveLength(2)
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
          request.args[0] === "interpret-trailers" && request.args.includes("--trailer")
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

  it("checks out every raised submodule so the settled worktree matches HEAD", async () => {
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

  it("accepts a clean submodule already at the staged pin without checking it out again", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-pre-settled-checkout-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const submodule = join(fixture.product, "packages/alpha")
    const newestAlpha = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 2\n")
    const candidate = candidateWithRootChange(fixture, "candidate-pre-settled-checkout")
    git(submodule, "fetch", "-q", "origin")
    git(submodule, "checkout", "-q", "--detach", newestAlpha)
    const local = createLocalGitProcess()
    const submoduleCheckouts: string[][] = []

    const result = await superMerge({
      repo: fixture.product,
      commit: candidate,
      git: {
        run: async (request) => {
          if (request.repo === submodule && request.args[0] === "checkout") {
            submoduleCheckouts.push([...request.args])
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
    expect(submoduleCheckouts).toEqual([])
    expect(git(fixture.product, "ls-tree", "HEAD", "packages/alpha")).toContain(newestAlpha)
    expect(git(submodule, "rev-parse", "HEAD")).toBe(newestAlpha)
    expect(git(fixture.product, "status", "--porcelain=v1")).toBe("")
  })

  it("refuses content changes inside a submodule already at the staged pin", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-dirty-pre-settled-checkout-"))
    roots.push(fixtureRoot)
    const fixture = createNestedProductFixture(fixtureRoot)
    const submodule = join(fixture.product, "packages/alpha")
    const leafCheckout = join(submodule, "apps/maddoc")
    const recordedAlpha = git(submodule, "rev-parse", "HEAD")
    const newestAlpha = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 2\n")
    const candidate = candidateWithRootChange(fixture, "candidate-dirty-pre-settled-checkout")
    git(submodule, "fetch", "-q", "origin")
    git(submodule, "checkout", "-q", "--detach", newestAlpha)
    writeFileSync(join(leafCheckout, "leaf.ts"), "export const leaf = 'uncommitted'\n")
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
          recorded: recordedAlpha,
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
    expect(git(submodule, "rev-parse", "HEAD")).toBe(newestAlpha)
    expect(git(leafCheckout, "diff", "--", "leaf.ts")).toContain("uncommitted")
  })

  it("refuses unrelated submodule checkout drift before touching HEAD, index, or MERGE_HEAD", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-checkout-drift-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const submodule = join(fixture.product, "packages/alpha")
    const newestAlpha = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 2\n")
    const candidate = candidateWithRootChange(fixture, "candidate-checkout-drift")
    writeFileSync(join(submodule, "drift.ts"), "export const drift = true\n")
    git(submodule, "add", "drift.ts")
    git(submodule, "commit", "-q", "-m", "unrelated local checkout drift")
    const unrelated = git(submodule, "rev-parse", "HEAD")
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
      detail: { code: "submodule-checkout-drift" },
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
    expect(git(submodule, "rev-parse", "HEAD")).toBe(unrelated)
  })

  it("checks out staged gitlink pins before the concluding commit hook", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-hook-coherence-"))
    roots.push(fixtureRoot)
    const fixture = createNestedProductFixture(fixtureRoot)
    const newestLeaf = raiseNestedPinOnAlphaMain(fixture, "export const leaf = 2\n")
    const newestAlpha = git(fixture.alpha, "rev-parse", "HEAD")
    const leafCheckout = join(fixture.product, "packages/alpha/apps/maddoc")
    // The real 26390 specimen already holds the new nested object, but still checks out the old pin.
    git(leafCheckout, "fetch", "-q", "origin")
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
        'nested=$(git -C packages/alpha rev-parse "$index:apps/maddoc")',
        "nested_checkout=$(git -C packages/alpha/apps/maddoc rev-parse HEAD)",
        'if [ "$nested" != "$nested_checkout" ]; then',
        '  printf "nested gitlink drift: index=%s checkout=%s\\n" "$nested" "$nested_checkout" >&2',
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
    expect(git(leafCheckout, "rev-parse", "HEAD")).toBe(newestLeaf)
    expect(git(fixture.product, "status", "--porcelain=v1")).toBe("")
  })

  it("restores every settled checkout to its root-recorded pin when the concluding commit is rejected", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-commit-rollback-"))
    roots.push(fixtureRoot)
    const fixture = createNestedProductFixture(fixtureRoot)
    const submodule = join(fixture.product, "packages/alpha")
    const leafCheckout = join(submodule, "apps/maddoc")
    const recordedAlpha = git(submodule, "rev-parse", "HEAD")
    const betaSubmodule = join(fixture.product, "vendor/beta")
    const newestLeaf = raiseNestedPinOnAlphaMain(fixture, "export const leaf = 2\n")
    const newestAlpha = git(fixture.alpha, "rev-parse", "HEAD")
    const newestBeta = advanceRepository(fixture.beta, "beta.ts", "export const beta = 2\n")
    const candidate = candidateWithRootChange(fixture, "candidate-commit-rollback")
    git(submodule, "fetch", "-q", "origin")
    git(leafCheckout, "fetch", "-q", "origin")
    git(submodule, "checkout", "-q", "--detach", "--recurse-submodules", newestAlpha)
    expect(git(leafCheckout, "rev-parse", "HEAD")).toBe(newestLeaf)
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
          recorded: recordedAlpha,
          index: newestAlpha,
          preCheckout: newestAlpha,
          checkout: recordedAlpha,
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
    expect(result.detail?.evidence).toContain(`recorded=${recordedAlpha}`)
    expect(result.detail?.evidence).toContain(`checkout=${recordedAlpha}`)
    expect(git(submodule, "rev-parse", "HEAD")).toBe(recordedAlpha)
    expect(git(leafCheckout, "rev-parse", "HEAD")).toBe(fixture.leafBase)
    expect(git(betaSubmodule, "rev-parse", "HEAD")).toBe(fixture.betaBase)
    expect(git(fixture.product, "rev-parse", "HEAD")).toBe(headBefore)
    expect(git(fixture.product, "rev-parse", "MERGE_HEAD")).toBe(candidate)
    expect(git(fixture.product, "ls-files", "--stage", "--", "packages/alpha")).toContain(newestAlpha)
    expect(git(fixture.product, "ls-files", "--stage", "--", "vendor/beta")).toContain(newestBeta)
    // The same resting state must advertise the same continuation owner (26988).
    expect(result.pending).toEqual({
      branch: "refs/heads/main",
      head: headBefore,
      target: candidate,
      unmergedPaths: [],
    })
    expect(result.detail?.next).toContain(
      `'--continue' '--expected-head' '${headBefore}' '--expected-branch' 'refs/heads/main'`,
    )
    expect(result.detail?.next).toContain("merge --abort")

    // CTO correction 3: hook rejection and explicit conflict entry share the
    // same resting state and the same continuation owner, including nested pins.
    writeFileSync(hook, "#!/bin/sh\nexit 0\n")
    const finished = await superMerge({
      repo: fixture.product,
      commit: candidate,
      continue: true,
      expectedHead: headBefore,
      expectedBranch: "refs/heads/main",
    })
    expect(finished).toMatchObject({ state: "updated", partial: false })
    expect(git(fixture.product, "show", "-s", "--format=%P", "HEAD")).toBe(`${headBefore} ${candidate}`)
    expect(git(submodule, "rev-parse", "HEAD")).toBe(newestAlpha)
    expect(git(leafCheckout, "rev-parse", "HEAD")).toBe(newestLeaf)
    expect(git(betaSubmodule, "rev-parse", "HEAD")).toBe(newestBeta)
    // Raises already staged by the rejected invocation are not new automatic writes.
    expect(existsSync(join(fixture.product, ".git", "refs", "git-super", "receipts", finished.commit ?? ""))).toBe(
      false,
    )
  })

  it("gives the concluding commit the merge's commit budget rather than one plumbing call's, so a slow hook completes", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-slow-hook-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 2\n")
    const candidate = candidateWithRootChange(fixture, "candidate-slow-hook")
    const hook = join(fixture.product, ".git", "hooks", "pre-commit")
    writeFileSync(hook, "#!/bin/sh\nsleep 7\n")
    chmodSync(hook, 0o755)

    const result = await superMerge({ repo: fixture.product, commit: candidate, timeoutMs: 5_000 })

    expect(result).toMatchObject({ state: "updated", partial: false })
    expect(git(fixture.product, "rev-parse", "HEAD")).toBe(result.commit)
  }, 60_000)

  it("preserves the observed merge when commit writes HEAD but reports failure", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-commit-reported-failure-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const submodule = join(fixture.product, "packages/alpha")
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
    expect(git(submodule, "rev-parse", "HEAD")).toBe(newestAlpha)
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
    const submodule = join(fixture.product, "packages/alpha")
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
            request.repo === submodule &&
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
        code: "submodule-checkout-rollback-failed",
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
    expect(git(submodule, "rev-parse", "HEAD")).toBe(newestAlpha)
  })

  it("checks out an on-main gitlink moved by the candidate so the settled worktree matches HEAD", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-candidate-gitlink-checkout-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const submodule = join(fixture.product, "packages/alpha")
    const newestAlpha = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 2\n")
    git(fixture.product, "switch", "-q", "-c", "candidate-gitlink")
    git(submodule, "fetch", "-q", "origin")
    git(submodule, "checkout", "-q", newestAlpha)
    git(fixture.product, "add", "packages/alpha")
    git(fixture.product, "commit", "-q", "-m", "advance alpha to submodule main")
    const candidate = git(fixture.product, "rev-parse", "HEAD")
    git(fixture.product, "switch", "-q", "main")
    git(submodule, "checkout", "-q", fixture.alphaBase)

    const result = await superMerge({ repo: fixture.product, commit: candidate, noVerify: true })

    expect(result).toMatchObject({ state: "updated", partial: false })
    expect(git(fixture.product, "ls-tree", "HEAD", "packages/alpha")).toContain(newestAlpha)
    expect(git(submodule, "rev-parse", "HEAD")).toBe(newestAlpha)
    expect(git(fixture.product, "status", "--porcelain=v1")).toBe("")
  })

  it("returns a named partial with the recovery command when a raised checkout cannot settle", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-checkout-failure-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const submodule = join(fixture.product, "packages/alpha")
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
          if (request.repo === submodule && request.args[0] === "checkout" && request.args.at(-1) === newestAlpha) {
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
        code: "submodule-checkout-failed",
        phase: "settle-submodule-checkout",
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
    expect(git(submodule, "rev-parse", "HEAD")).toBe(fixture.alphaBase)
  })

  it("restores a checkout when its staged-pin settlement cannot be observed", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-settlement-observation-failure-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const submodule = join(fixture.product, "packages/alpha")
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
            request.repo === submodule &&
            request.args[0] === "checkout" &&
            request.args.at(-1) === newestAlpha &&
            observed.code === 0
          ) {
            settling = true
            return observed
          }
          if (settling && request.repo === submodule && request.args.join(" ") === "rev-parse HEAD^{commit}") {
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
        code: "submodule-checkout-failed",
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
    expect(git(submodule, "rev-parse", "HEAD")).toBe(fixture.alphaBase)
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

  /**
   * @failure Explicit ordinary conflict resolution cannot finish on its original branch, or discards the human resolution (26988).
   * @level l1
   * @consumer Standalone GitSuper callers resolving an ordinary root merge conflict
   * @testonly none
   * Existing default-refusal rows do not enter or continue a native pending merge.
   */
  it("preserves ordinary conflicts and continues the human resolution on the original branch (26988)", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-continue-"))
    roots.push(fixtureRoot)
    const repository = join(fixtureRoot, "conflict")
    createRepository(repository, "shared.txt", "base\n")
    git(repository, "switch", "-q", "-c", "candidate")
    writeFileSync(join(repository, "shared.txt"), "candidate\n")
    git(repository, "commit", "-q", "-am", "candidate conflict")
    const target = git(repository, "rev-parse", "HEAD")
    git(repository, "switch", "-q", "main")
    writeFileSync(join(repository, "shared.txt"), "main\n")
    git(repository, "commit", "-q", "-am", "main conflict")
    const head = git(repository, "rev-parse", "HEAD")
    const branch = git(repository, "symbolic-ref", "HEAD")
    const upstream = join(fixtureRoot, "upstream.git")
    git(repository, "clone", "-q", "--bare", repository, upstream)
    git(repository, "remote", "add", "origin", upstream)
    git(repository, "config", "branch.main.remote", "origin")
    git(repository, "config", "branch.main.merge", "refs/heads/main")
    const pendingOut = outputSink()
    const pendingErr = outputSink()

    expect(
      await runCli(["--repo", repository, "--json", "merge", target, "--preserve-conflicts"], pendingOut, pendingErr),
    ).toBe(2)
    expect(JSON.parse(pendingOut.output)).toMatchObject({ state: "failed", partial: true })
    // New diagnostics obey ADR-0007; routing is not part of their payload or prose.
    expect(JSON.parse(pendingOut.output)).not.toHaveProperty("detail.owner")
    expect(pendingOut.output).not.toContain("; owner:")
    expect(git(repository, "rev-parse", "HEAD")).toBe(head)
    expect(git(repository, "symbolic-ref", "HEAD")).toBe(branch)
    expect(git(repository, "rev-parse", "MERGE_HEAD")).toBe(target)
    expect(git(repository, "ls-files", "-u")).toContain("shared.txt")

    // CTO correction 4: status reports conflicts; an equal-target pull is a
    // truthful no-op; push publishes the explicitly selected HEAD, not the index.
    const statusOut = outputSink()
    expect(await runCli(["--repo", repository, "--json", "status"], statusOut, outputSink())).toBe(0)
    expect(JSON.parse(statusOut.output)).toMatchObject({ records: expect.arrayContaining(["UU shared.txt"]) })
    const pullOut = outputSink()
    expect(await runCli(["--repo", repository, "--json", "pull", "--ff-only"], pullOut, outputSink())).toBe(0)
    expect(JSON.parse(pullOut.output)).toMatchObject({ state: "unchanged", partial: false })
    // A remote advance must refuse with native conflict state intact, rather
    // than letting the equal-target no-op stand in for pending-root coverage.
    const remoteWork = join(fixtureRoot, "remote-work")
    git(repository, "clone", "-q", upstream, remoteWork)
    advanceRepository(remoteWork, "remote.txt", "remote advance\n")
    git(remoteWork, "push", "-q", "origin", "main")
    const stagesBeforePull = git(repository, "ls-files", "-u")
    const advancedPullOut = outputSink()
    const advancedPullCode = await runCli(
      ["--repo", repository, "--json", "pull", "--ff-only"],
      advancedPullOut,
      outputSink(),
    )
    expect(advancedPullCode, advancedPullOut.output).not.toBe(0)
    expect(JSON.parse(advancedPullOut.output)).toMatchObject({
      state: "failed",
      partial: false,
      detail: { code: "git-failed", phase: "preflight-tree-transition" },
    })
    expect(git(repository, "rev-parse", "HEAD")).toBe(head)
    expect(git(repository, "rev-parse", "MERGE_HEAD")).toBe(target)
    expect(git(repository, "ls-files", "-u")).toBe(stagesBeforePull)
    const pushOut = outputSink()
    expect(
      await runCli(
        ["--repo", repository, "--json", "push", "origin", "HEAD:refs/heads/pending-observation"],
        pushOut,
        outputSink(),
      ),
    ).toBe(0)
    expect(JSON.parse(pushOut.output)).toMatchObject({ state: "updated", partial: false })
    expect(git(upstream, "rev-parse", "refs/heads/pending-observation")).toBe(head)
    expect(git(repository, "rev-parse", "MERGE_HEAD")).toBe(target)
    expect(git(repository, "ls-files", "-u")).toContain("shared.txt")

    // A pending root must be diagnosed before default merge's prospective refusal.
    const defaultPending = await superMerge({ repo: repository, commit: target })
    expect(defaultPending).toMatchObject({
      state: "failed",
      partial: false,
      detail: { code: "merge-already-pending" },
      pending: { branch, head, target, unmergedPaths: ["shared.txt"] },
    })
    expect(defaultPending.detail?.message).toContain("left as found")
    expect(defaultPending.detail).not.toHaveProperty("owner")
    const unreadableTarget = await superMerge({
      repo: repository,
      commit: "refs/heads/missing-continuation-target",
      continue: true,
      expectedHead: head,
      expectedBranch: branch,
    })
    expect(unreadableTarget).toMatchObject({
      state: "failed",
      partial: false,
      pending: { branch, head, target, unmergedPaths: ["shared.txt"] },
    })
    expect(unreadableTarget.detail?.message).toContain("left as found")
    expect(git(repository, "rev-parse", "HEAD")).toBe(head)
    expect(git(repository, "rev-parse", "MERGE_HEAD")).toBe(target)
    expect(git(repository, "ls-files", "-u")).toContain("shared.txt")
    // These leases cannot authorize mutation; the ordinary conflict must remain native.
    for (const [expectedHead, expectedBranch, expectedCode] of [
      [target, branch, "merge-continuation-lease-mismatch"],
      [head, "refs/heads/candidate", "merge-continuation-lease-mismatch"],
      [head, branch, "merge-continuation-unresolved"],
    ] as const) {
      const refused = await superMerge({
        repo: repository,
        commit: target,
        continue: true,
        expectedHead,
        expectedBranch,
      })
      expect(refused).toMatchObject({ state: "failed", partial: false, detail: { code: expectedCode } })
      expect(refused.detail).not.toHaveProperty("owner")
      expect(refused.detail?.message).toContain("left as found")
      expect(git(repository, "rev-parse", "HEAD")).toBe(head)
      expect(git(repository, "rev-parse", "MERGE_HEAD")).toBe(target)
      expect(git(repository, "ls-files", "-u")).toContain("shared.txt")
    }

    // Native abort returns to the original state without a GitSuper abort mode.
    git(repository, "merge", "--abort")
    expect(git(repository, "rev-parse", "HEAD")).toBe(head)
    expect(git(repository, "symbolic-ref", "HEAD")).toBe(branch)
    expect(git(repository, "status", "--porcelain=v1")).toBe("")
    expect(readFileSync(join(repository, "shared.txt"), "utf8")).toBe("main\n")
    expect(await superMerge({ repo: repository, commit: target, preserveConflicts: true })).toMatchObject({
      state: "failed",
      partial: true,
    })
    writeFileSync(join(repository, "shared.txt"), "human resolution\n")
    git(repository, "add", "shared.txt")
    const mergeHeadPath = git(repository, "rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD")
    const expectations = {
      repo: repository,
      commit: target,
      continue: true,
      expectedHead: head,
      expectedBranch: branch,
    }
    for (const nativeHeads of [`${head}\n`, `${target}\n${head}\n`]) {
      writeFileSync(mergeHeadPath, nativeHeads)
      const refused = await superMerge(expectations)
      expect(refused).toMatchObject({ state: "failed", partial: false })
      expect(refused.detail?.code).toMatch(/^merge-continuation-(target|lease)-mismatch$/u)
      expect(readFileSync(mergeHeadPath, "utf8")).toBe(nativeHeads)
      expect(git(repository, "show", ":shared.txt")).toBe("human resolution")
    }
    writeFileSync(mergeHeadPath, `${target}\n`)
    const finishedOut = outputSink()
    const finishedErr = outputSink()
    expect(
      await runCli(
        [
          "--repo",
          repository,
          "--json",
          "merge",
          target,
          "--continue",
          "--expected-head",
          head,
          "--expected-branch",
          branch,
        ],
        finishedOut,
        finishedErr,
      ),
    ).toBe(0)
    expect(JSON.parse(finishedOut.output)).toMatchObject({ state: "updated", partial: false })
    expect(git(repository, "symbolic-ref", "HEAD")).toBe(branch)
    expect(git(repository, "show", "HEAD:shared.txt")).toBe("human resolution")
    expect(git(repository, "show", "-s", "--format=%P", "HEAD")).toBe(`${head} ${target}`)
    expect(git(repository, "ls-files", "-u")).toBe("")
    expect(git(repository, "status", "--porcelain=v1")).toBe("")
  })

  /**
   * @failure git add -A silently lowers a merged pin, or continuation overwrites moved/dirty child work (26988).
   * @level l1
   * @consumer Callers resolving a root conflict with an independently advanced gitlink
   * @testonly none
   * Default conflict-refusal coverage never exposes an index ahead of its resting checkout.
   */
  it("validates staged pins and resting checkouts before continuing an ordinary conflict (26988)", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-continue-pins-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const rootFile = join(fixture.product, "shared.txt")
    writeFileSync(rootFile, "base\n")
    git(fixture.product, "add", "shared.txt")
    git(fixture.product, "commit", "-q", "-m", "root conflict base")
    const child = join(fixtureRoot, "product", "packages/alpha")
    const advanced = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 2\n")
    git(child, "fetch", "-q", "origin")
    git(fixture.product, "switch", "-q", "-c", "candidate-pins")
    git(fixture.product, "update-index", "--cacheinfo", `160000,${advanced},packages/alpha`)
    writeFileSync(rootFile, "candidate\n")
    git(fixture.product, "add", "shared.txt")
    git(fixture.product, "commit", "-q", "-m", "advance pin and root content")
    const target = git(fixture.product, "rev-parse", "HEAD")
    git(fixture.product, "switch", "-q", "main")
    writeFileSync(rootFile, "main\n")
    git(fixture.product, "commit", "-q", "-am", "main content")
    const head = git(fixture.product, "rev-parse", "HEAD")
    expect(await superMerge({ repo: fixture.product, commit: target, preserveConflicts: true })).toMatchObject({
      state: "failed",
      partial: true,
    })
    expect(git(child, "rev-parse", "HEAD")).toBe(fixture.alphaBase)
    expect(git(fixture.product, "rev-parse", ":packages/alpha")).toBe(advanced)
    // The implicit form recognizes extension flags before its existing topology refusal.
    const implicitOut = outputSink()
    const implicitErr = outputSink()
    expect(
      await runCli(
        [
          "-C",
          fixture.product,
          "merge",
          target,
          "--continue",
          "--expected-head",
          head,
          "--expected-branch",
          "refs/heads/main",
        ],
        implicitOut,
        implicitErr,
      ),
    ).toBe(2)
    expect(implicitErr.output).toContain(`explicit git-super --repo ${fixture.product}`)
    expect(implicitErr.output).not.toContain("cannot determine input objects for option")
    writeFileSync(rootFile, "human resolution\n")
    git(fixture.product, "add", "-A")
    expect(git(fixture.product, "rev-parse", ":packages/alpha")).toBe(fixture.alphaBase)
    const options = {
      repo: fixture.product,
      commit: target,
      continue: true,
      expectedHead: head,
      expectedBranch: "refs/heads/main",
    }
    const stale = await superMerge(options)
    expect(stale).toMatchObject({
      state: "failed",
      partial: false,
      detail: { code: "merge-continuation-gitlink-mismatch", paths: ["packages/alpha"] },
    })
    expect(stale.detail?.message).toContain(fixture.alphaBase)
    expect(stale.detail).not.toHaveProperty("owner")
    expect(stale.detail?.message).toContain(advanced)
    expect(stale.detail?.next).toContain(`160000,${advanced},packages/alpha`)
    expect(git(fixture.product, "rev-parse", ":packages/alpha")).toBe(fixture.alphaBase)
    git(fixture.product, "update-index", "--cacheinfo", `160000,${advanced},packages/alpha`)

    git(child, "checkout", "-q", "--detach", advanced)
    const moved = await superMerge(options)
    expect(moved).toMatchObject({
      state: "failed",
      partial: false,
      detail: { code: "merge-resting-checkout-mismatch" },
    })
    expect(git(child, "rev-parse", "HEAD")).toBe(advanced)
    git(child, "checkout", "-q", "--detach", fixture.alphaBase)
    const childFile = join(child, "alpha.ts")
    const childBytes = readFileSync(childFile, "utf8")
    writeFileSync(childFile, "private child work\n")
    const dirty = await superMerge(options)
    expect(dirty).toMatchObject({
      state: "failed",
      partial: false,
      detail: { code: "merge-resting-checkout-mismatch" },
    })
    expect(readFileSync(childFile, "utf8")).toBe("private child work\n")
    writeFileSync(childFile, childBytes)

    // A syntactically valid staged descriptor cannot introduce a gitlink absent from this merge.
    const modules = readFileSync(join(fixture.product, ".gitmodules"), "utf8")
    git(fixture.product, "config", "--file", ".gitmodules", "submodule.extra.path", "vendor/extra")
    git(
      fixture.product,
      "config",
      "--file",
      ".gitmodules",
      "submodule.extra.url",
      "https://git-super.test/owned/beta.git",
    )
    git(fixture.product, "add", ".gitmodules")
    git(fixture.product, "update-index", "--add", "--cacheinfo", `160000,${fixture.betaBase},vendor/extra`)
    const extra = await superMerge(options)
    expect(extra).toMatchObject({
      state: "failed",
      partial: false,
      detail: { code: "merge-continuation-gitlink-mismatch", paths: ["vendor/extra"] },
    })
    expect(git(fixture.product, "rev-parse", ":vendor/extra")).toBe(fixture.betaBase)
    git(fixture.product, "update-index", "--force-remove", "--", "vendor/extra")
    writeFileSync(join(fixture.product, ".gitmodules"), modules)
    git(fixture.product, "add", ".gitmodules")

    const finished = await superMerge(options)
    expect(finished).toMatchObject({ state: "updated", partial: false })
    expect(git(fixture.product, "show", "HEAD:shared.txt")).toBe("human resolution")
    expect(git(fixture.product, "show", "-s", "--format=%P", "HEAD")).toBe(`${head} ${target}`)
    expect(git(fixture.product, "rev-parse", "HEAD:packages/alpha")).toBe(advanced)
    expect(git(child, "rev-parse", "HEAD")).toBe(advanced)
  })

  /**
   * @failure Continuation parses unresolved prospective descriptor text instead of the human's staged resolution (26988).
   * @level l1
   * @consumer Callers resolving a .gitmodules conflict without changing required gitlinks
   * @testonly none
   * The ordinary-file lifecycle never conflicts on the descriptor used by recursive planning.
   */
  it("preserves a resolved descriptor conflict while recomputing only required gitlinks (26988)", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-continue-descriptors-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const modules = join(fixture.product, ".gitmodules")
    const original = readFileSync(modules, "utf8")
    writeFileSync(modules, `# base descriptor\n${original}`)
    git(fixture.product, "commit", "-q", "-am", "descriptor base")
    git(fixture.product, "switch", "-q", "-c", "candidate-descriptors")
    writeFileSync(modules, `# candidate descriptor\n${original}`)
    git(fixture.product, "commit", "-q", "-am", "candidate descriptor")
    const target = git(fixture.product, "rev-parse", "HEAD")
    git(fixture.product, "switch", "-q", "main")
    writeFileSync(modules, `# main descriptor\n${original}`)
    git(fixture.product, "commit", "-q", "-am", "main descriptor")
    const head = git(fixture.product, "rev-parse", "HEAD")
    const pending = await superMerge({ repo: fixture.product, commit: target, preserveConflicts: true })
    expect(pending).toMatchObject({ state: "failed", partial: true, pending: { unmergedPaths: [".gitmodules"] } })
    const resolved = `# human descriptor\n${original}`
    writeFileSync(modules, resolved)
    git(fixture.product, "add", ".gitmodules")
    const finished = await superMerge({
      repo: fixture.product,
      commit: target,
      continue: true,
      expectedHead: head,
      expectedBranch: "refs/heads/main",
    })
    expect(finished).toMatchObject({ state: "updated", partial: false })
    expect(readFileSync(modules, "utf8")).toBe(resolved)
    expect(git(fixture.product, "show", "HEAD:.gitmodules")).toBe(resolved.trim())
    expect(git(fixture.product, "rev-parse", "HEAD:packages/alpha")).toBe(fixture.alphaBase)
    expect(git(fixture.product, "rev-parse", "HEAD:vendor/beta")).toBe(fixture.betaBase)
    expect(git(fixture.product, "show", "-s", "--format=%P", "HEAD")).toBe(`${head} ${target}`)
  })

  /**
   * @failure A hook changes frozen publication inputs yet merge reports success, or rejects harmless ordinary formatting (26988).
   * @level l1
   * @consumer Fresh and continued merges before their success receipt is emitted
   * @testonly none
   * Existing hook rows cover rejection and checkout coherence, not the committed tree's frozen inputs.
   */
  it.each([
    ["fresh", "ordinary"],
    ["fresh", "gitlink"],
    ["fresh", "modules"],
    ["continue", "ordinary"],
    ["continue", "gitlink"],
    ["continue", "modules"],
  ] as const)("verifies frozen publication inputs after %s merge hook changes %s (26988)", async (mode, changed) => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-hook-inputs-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const shared = join(fixture.product, "shared.txt")
    writeFileSync(shared, "base\n")
    git(fixture.product, "add", "shared.txt")
    git(fixture.product, "commit", "-q", "-m", "shared root base")
    const raised = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 2\n")
    git(fixture.product, "switch", "-q", "-c", "candidate-hook-inputs")
    writeFileSync(shared, "candidate\n")
    git(fixture.product, "commit", "-q", "-am", "candidate content")
    const target = git(fixture.product, "rev-parse", "HEAD")
    git(fixture.product, "switch", "-q", "main")
    if (mode === "continue") {
      writeFileSync(shared, "main\n")
      git(fixture.product, "commit", "-q", "-am", "main content")
      expect(await superMerge({ repo: fixture.product, commit: target, preserveConflicts: true })).toMatchObject({
        state: "failed",
        partial: true,
      })
      writeFileSync(shared, "human resolution\n")
      git(fixture.product, "add", "shared.txt")
    }
    const head = git(fixture.product, "rev-parse", "HEAD")
    const hook = git(fixture.product, "rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-commit")
    const action =
      changed === "ordinary"
        ? "printf 'formatted ordinary content\\n' > shared.txt\ngit add shared.txt\n"
        : changed === "gitlink"
          ? `git update-index --cacheinfo 160000,${fixture.alphaBase},packages/alpha\n`
          : "printf '# hook descriptor mutation\\n' >> .gitmodules\ngit add .gitmodules\n"
    writeFileSync(hook, `#!/bin/sh\nset -e\n${action}`)
    chmodSync(hook, 0o755)
    const result = await superMerge({
      repo: fixture.product,
      commit: target,
      ...(mode === "continue" ? { continue: true, expectedHead: head, expectedBranch: "refs/heads/main" } : {}),
    })
    const observed = git(fixture.product, "rev-parse", "HEAD")
    expect(observed).not.toBe(head)
    expect(result.commit).toBe(observed)
    expect(git(fixture.product, "show", "-s", "--format=%P", observed)).toBe(`${head} ${target}`)
    expect(git(join(fixture.product, "packages/alpha"), "rev-parse", "HEAD")).toBe(raised)
    const receipt = `refs/git-super/receipts/${observed}`
    if (changed === "ordinary") {
      expect(result).toMatchObject({ state: "updated", partial: false })
      expect(git(fixture.product, "show", "HEAD:shared.txt")).toBe("formatted ordinary content")
      expect(JSON.parse(git(fixture.product, "show", `${receipt}:receipt.json`))).toMatchObject({
        merge: observed,
        changes: [{ path: "packages/alpha", mode: "160000", from: fixture.alphaBase, to: raised }],
      })
    } else {
      expect(result).toMatchObject({
        state: "failed",
        partial: true,
        commit: observed,
        detail: { code: "merge-postcondition-mismatch" },
      })
      expect(result.detail).not.toHaveProperty("owner")
      expect(() => git(fixture.product, "rev-parse", "--verify", receipt)).toThrow()
      expect(git(fixture.product, "rev-parse", "HEAD")).toBe(observed)
      if (changed === "gitlink") {
        expect(git(fixture.product, "rev-parse", "HEAD:packages/alpha")).toBe(fixture.alphaBase)
      } else expect(git(fixture.product, "show", "HEAD:.gitmodules")).toContain("# hook descriptor mutation")
    }
  })

  /**
   * @failure Explicit conflict entry starts a second operation during a native rebase or cherry-pick (26988).
   * @level l1
   * @consumer Standalone merge callers sharing native repository operation state
   * @testonly none
   * Ordinary MERGE_HEAD rows do not represent the other native operation markers.
   */
  it.each(["rebase", "cherry-pick"] as const)(
    "refuses pending native %s before explicit conflict entry (26988)",
    async (operation) => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-other-pending-"))
      roots.push(fixtureRoot)
      const repository = join(fixtureRoot, "conflict")
      createRepository(repository, "shared.txt", "base\n")
      git(repository, "switch", "-q", "-c", "candidate")
      writeFileSync(join(repository, "shared.txt"), "candidate\n")
      git(repository, "commit", "-q", "-am", "candidate conflict")
      const target = git(repository, "rev-parse", "HEAD")
      git(repository, "switch", "-q", "main")
      writeFileSync(join(repository, "shared.txt"), "main\n")
      git(repository, "commit", "-q", "-am", "main conflict")
      expect(() => git(repository, operation, target)).toThrow()
      const observedHead = git(repository, "rev-parse", "HEAD")
      const stages = git(repository, "ls-files", "--stage", "-z")
      const bytes = readFileSync(join(repository, "shared.txt"), "utf8")
      const result = await superMerge({ repo: repository, commit: target, preserveConflicts: true })
      expect(result).toMatchObject({
        state: "failed",
        partial: false,
        detail: { code: "merge-other-operation-pending" },
      })
      expect(result.detail?.message).toContain(operation === "rebase" ? "rebase-merge" : "CHERRY_PICK_HEAD")
      expect(git(repository, "rev-parse", "HEAD")).toBe(observedHead)
      expect(git(repository, "ls-files", "--stage", "-z")).toBe(stages)
      expect(readFileSync(join(repository, "shared.txt"), "utf8")).toBe(bytes)
    },
  )

  it.each(["shared.txt", "space \tand\nnewline.txt"])(
    "reports a conflict at %j before writing HEAD, the index, or the worktree",
    async (sharedPath) => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-conflict-"))
      roots.push(fixtureRoot)
      const repository = join(fixtureRoot, "conflict")
      createRepository(repository, sharedPath, "base\n")
      git(repository, "switch", "-q", "-c", "candidate")
      writeFileSync(join(repository, sharedPath), "candidate\n")
      git(repository, "commit", "-q", "-am", "candidate conflict")
      const candidate = git(repository, "rev-parse", "HEAD")
      git(repository, "switch", "-q", "main")
      writeFileSync(join(repository, sharedPath), "main\n")
      git(repository, "commit", "-q", "-am", "main conflict")
      const headBefore = git(repository, "rev-parse", "HEAD")
      const statusBefore = git(repository, "status", "--porcelain=v1")
      const stdout = outputSink()
      const stderr = outputSink()

      expect(await runCli(["--repo", repository, "merge", candidate], stdout, stderr)).toBe(1)
      expect(stdout.output).toBe("")
      expect(stderr.output).toContain("merge-conflict")
      expect(stderr.output).toContain(JSON.stringify(sharedPath))
      const detailed = await superMerge({ repo: repository, commit: candidate })
      expect(detailed.detail?.paths).toEqual([sharedPath])
      expect(detailed.detail?.objectIds).toEqual([headBefore, candidate])
      const base = git(repository, "merge-base", headBefore, candidate)
      for (const [stage, commit] of [
        ["base", base],
        ["ours", headBefore],
        ["theirs", candidate],
      ] as const) {
        expect(detailed.detail?.message).toContain(
          `${stage}=${git(repository, "rev-parse", `${commit}:${sharedPath}`)}`,
        )
      }
      expect(detailed.detail?.message).toContain("preflight left HEAD, index, and worktree unchanged")
      expect(detailed.detail?.next).toContain(`Start a fresh branch at ${candidate}`)
      expect(git(repository, "ls-files", "-u")).toBe("")
      const local = createLocalGitProcess()
      const probe = injectionProbe()
      const mergeTreeStderr = "verbatim merge-tree conflict hint"
      const detailedWithStderr = await superMerge({
        repo: repository,
        commit: candidate,
        git: {
          run: async (request) => {
            const result = await local.run(request)
            probe.observe(request)
            if (request.args.includes("merge-tree")) {
              probe.fire("merge-tree stderr")
              return { ...result, stderr: mergeTreeStderr }
            }
            return result
          },
        },
      })
      probe.expectFired("merge-tree stderr")
      expect(detailedWithStderr.detail?.message).toContain(mergeTreeStderr)
      expect(git(repository, "rev-parse", "HEAD")).toBe(headBefore)
      expect(git(repository, "status", "--porcelain=v1")).toBe(statusBefore)

      // The named recovery starts at the target and reapplies our intended
      // file content; merging that fresh carrier must succeed without an
      // in-place conflict state from the refused preflight.
      git(repository, "switch", "-q", "-c", "fresh-carrier", candidate)
      writeFileSync(join(repository, sharedPath), "main\n")
      git(repository, "commit", "-q", "-am", "reapply intended change")
      const freshCarrier = git(repository, "rev-parse", "HEAD")
      git(repository, "switch", "-q", "main")
      expect(await superMerge({ repo: repository, commit: freshCarrier })).toMatchObject({ state: "updated" })
      expect(git(repository, "show", `HEAD:${sharedPath}`)).toBe("main")
    },
  )

  it("reports malformed merge-tree stage records before writing the merge", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-malformed-stages-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const candidate = candidateWithRootChange(fixture, "candidate-malformed-stages")
    const headBefore = git(fixture.product, "rev-parse", "HEAD")
    const statusBefore = git(fixture.product, "status", "--porcelain=v1")
    const malformed = "160000 not-an-object 2\tpackages/alpha"
    const local = createLocalGitProcess()
    const probe = injectionProbe()

    const result = await superMerge({
      repo: fixture.product,
      commit: candidate,
      git: {
        run: async (request) => {
          const observed = await local.run(request)
          probe.observe(request)
          if (request.args.includes("merge-tree")) {
            probe.fire("malformed stage record")
            return { ...observed, code: 1, stdout: `${observed.stdout.split("\0")[0]}\0${malformed}\0` }
          }
          return observed
        },
      },
    })

    probe.expectFired("malformed stage record")
    expect(result).toMatchObject({ state: "failed", partial: false, detail: { code: "merge-preflight-failed" } })
    expect(result.detail?.message).toContain(JSON.stringify(malformed))
    expect(result.detail?.message).toContain(fixture.product)
    expect(git(fixture.product, "rev-parse", "HEAD")).toBe(headBefore)
    expect(git(fixture.product, "status", "--porcelain=v1")).toBe(statusBefore)
  })

  it("merges base-to-ours-to-theirs gitlinks at the descendant pin", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-linear-pins-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const ours = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 2\n")
    const theirs = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 3\n")
    const submodule = join(fixture.product, "packages/alpha")
    git(submodule, "fetch", "-q", "origin")
    git(fixture.product, "switch", "-q", "-c", "candidate-linear")
    git(submodule, "checkout", "-q", theirs)
    git(fixture.product, "add", "packages/alpha")
    git(fixture.product, "commit", "-q", "-m", "pin descendant")
    const candidate = git(fixture.product, "rev-parse", "HEAD")
    git(fixture.product, "switch", "-q", "main")
    git(submodule, "checkout", "-q", ours)
    git(fixture.product, "add", "packages/alpha")
    git(fixture.product, "commit", "-q", "-m", "pin intermediate")

    const result = await superMerge({ repo: fixture.product, commit: candidate })

    expect(result).toMatchObject({ state: "updated", partial: false })
    expect(git(fixture.product, "ls-tree", "HEAD", "packages/alpha")).toContain(theirs)
    expect(git(submodule, "rev-parse", "HEAD")).toBe(theirs)
    expect(git(fixture.product, "status", "--porcelain=v1")).toBe("")
  })

  /**
   * @i/10-yrd/25280. The queue clone's submodule store holds OURS (main's pin)
   * but has never seen THEIRS, which descends from ours and is published only
   * as `refs/git-super/pins/<sha>`. Git cannot fast-forward a submodule whose
   * commit is absent, so it hands git-super a three-stage gitlink conflict; the
   * planner composed it, and the path gate then read ours' own changes (which
   * theirs contains) as "gitlink …: diverged; files overlap". Queue run
   * q-20260923T145509635Z-1de06624 sent two fast-forwards back this way.
   */
  it("fast-forwards a gitlink whose descendant pin the store has never seen (25280)", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-unseen-descendant-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const ours = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 'ours'\n")

    // THEIRS descends from ours and reaches the remote ONLY as a pin ref.
    const authoring = join(fixtureRoot, "alpha-authoring")
    git(fixtureRoot, "clone", "-q", fixture.alpha, authoring)
    const theirs = advanceRepository(authoring, "alpha.ts", "export const alpha = 'theirs'\n")
    git(authoring, "push", "-q", "origin", `${theirs}:refs/git-super/pins/${theirs}`)

    // The candidate forks at the base pin and moves it to theirs.
    git(fixture.product, "switch", "-q", "-c", "candidate-unseen-descendant")
    git(fixture.product, "update-index", "--add", "--cacheinfo", `160000,${theirs},packages/alpha`)
    git(fixture.product, "commit", "-q", "-m", "pin alpha at a descendant the store never saw")
    const candidate = git(fixture.product, "rev-parse", "HEAD")

    // Main moves the same gitlink base → ours.
    git(fixture.product, "switch", "-q", "main")
    const child = join(fixture.product, "packages/alpha")
    git(child, "fetch", "-q", "origin")
    git(child, "checkout", "-q", ours)
    git(fixture.product, "add", "packages/alpha")
    git(fixture.product, "commit", "-q", "-m", "pin alpha at ours")

    // POSITIVE CONTROL: the store holds ours and not theirs, so the merge
    // really starts from the queue clone's state, not from a warm store.
    expect(git(child, "cat-file", "-t", ours)).toBe("commit")
    expect(() => git(child, "cat-file", "-e", `${theirs}^{commit}`)).toThrow()

    const result = await superMerge({ repo: fixture.product, commit: candidate })

    expect(result).toMatchObject({ state: "updated", partial: false })
    expect(git(fixture.product, "rev-parse", "HEAD:packages/alpha")).toBe(theirs)
  })

  it("cannot judge a fast-forward whose current pin is absent, and says so rather than composing (25280)", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-absent-current-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)

    // OURS exists only in a clone nobody fetches from; main records it anyway.
    const ghost = join(fixtureRoot, "alpha-ghost")
    git(fixtureRoot, "clone", "-q", fixture.alpha, ghost)
    const ours = advanceRepository(ghost, "alpha.ts", "export const alpha = 'ours'\n")
    // THEIRS is published as a pin ref and fetchable.
    const authoring = join(fixtureRoot, "alpha-authoring")
    git(fixtureRoot, "clone", "-q", fixture.alpha, authoring)
    const theirs = advanceRepository(authoring, "alpha.ts", "export const alpha = 'theirs'\n")
    git(authoring, "push", "-q", "origin", `${theirs}:refs/git-super/pins/${theirs}`)

    git(fixture.product, "switch", "-q", "-c", "candidate-absent-current")
    git(fixture.product, "update-index", "--add", "--cacheinfo", `160000,${theirs},packages/alpha`)
    git(fixture.product, "commit", "-q", "-m", "pin alpha at theirs")
    const candidate = git(fixture.product, "rev-parse", "HEAD")
    git(fixture.product, "switch", "-q", "main")
    git(fixture.product, "update-index", "--add", "--cacheinfo", `160000,${ours},packages/alpha`)
    git(fixture.product, "commit", "-q", "-m", "pin alpha at an unreadable ours")
    const headBefore = git(fixture.product, "rev-parse", "HEAD")
    const child = join(fixture.product, "packages/alpha")
    expect(() => git(child, "cat-file", "-e", `${ours}^{commit}`)).toThrow()

    const result = await superMerge({ repo: fixture.product, commit: candidate })

    expect(result).toMatchObject({ state: "failed", partial: false, detail: { code: "gitlink-compose-unavailable" } })
    const message = (result as { detail?: { message?: string } }).detail?.message ?? ""
    expect(message).toContain("fast-forward")
    // The probe that failed is the one reading ours, not merely a phrase naming it.
    expect(message).toContain(`merge-base --is-ancestor ${ours} ${theirs}`)
    // Git's own stderr names the missing side; the sha alone also appears in the operation phrase.
    expect(message).toContain(`Not a valid commit name ${ours}`)
    expect(git(fixture.product, "rev-parse", "HEAD")).toBe(headBefore)
  })

  it("refuses a gitlink whose component commit cannot be fetched by naming it, never as diverged (25280)", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-unfetchable-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const ours = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 'ours'\n")

    // THEIRS exists only in a clone nobody can fetch from: no branch, no pin ref.
    const authoring = join(fixtureRoot, "alpha-authoring")
    git(fixtureRoot, "clone", "-q", fixture.alpha, authoring)
    const theirs = advanceRepository(authoring, "alpha.ts", "export const alpha = 'theirs'\n")

    git(fixture.product, "switch", "-q", "-c", "candidate-unfetchable")
    git(fixture.product, "update-index", "--add", "--cacheinfo", `160000,${theirs},packages/alpha`)
    git(fixture.product, "commit", "-q", "-m", "pin alpha at an unpublished commit")
    const candidate = git(fixture.product, "rev-parse", "HEAD")
    git(fixture.product, "switch", "-q", "main")
    const child = join(fixture.product, "packages/alpha")
    git(child, "fetch", "-q", "origin")
    git(child, "checkout", "-q", ours)
    git(fixture.product, "add", "packages/alpha")
    git(fixture.product, "commit", "-q", "-m", "pin alpha at ours")
    const headBefore = git(fixture.product, "rev-parse", "HEAD")

    const result = await superMerge({ repo: fixture.product, commit: candidate })

    expect(result).toMatchObject({ state: "failed", partial: false })
    const message = (result as { detail?: { message?: string } }).detail?.message ?? ""
    // Named: the sha and the side. "could not be fetched" is the phrase yrd
    // routes on for its publish-and-resubmit remedy (yrd-queue-core run.ts).
    expect(message).toContain(`${theirs} (theirs), which could not be fetched`)
    expect(message).not.toContain("diverged")
    expect(git(fixture.product, "rev-parse", "HEAD")).toBe(headBefore)
  })

  /**
   * Containment alone is not a fast-forward: Git also needs the base pin to be
   * an ancestor of current (review of 25280, @dev/review2). Here main REWINDS
   * the pin below the base while the candidate advances from it, so theirs
   * contains ours yet base is not an ancestor of ours. Pinning theirs would
   * skip the composition that names the rewind and leave the checkout
   * mid-merge; the pair must go back to its author as a named refusal.
   */
  it("sends a pin that main rewound back to its author instead of fast-forwarding past the rewind (25280)", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-rewound-current-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const rewound = git(fixture.alpha, "rev-parse", "HEAD")
    const base = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 'base'\n")
    const child = join(fixture.product, "packages/alpha")
    git(child, "fetch", "-q", "origin")
    git(child, "checkout", "-q", base)
    git(fixture.product, "add", "packages/alpha")
    git(fixture.product, "commit", "-q", "-m", "pin alpha at base")

    const authoring = join(fixtureRoot, "alpha-authoring")
    git(fixtureRoot, "clone", "-q", fixture.alpha, authoring)
    const theirs = advanceRepository(authoring, "alpha.ts", "export const alpha = 'theirs'\n")
    git(authoring, "push", "-q", "origin", `${theirs}:refs/git-super/pins/${theirs}`)
    git(fixture.product, "switch", "-q", "-c", "candidate-over-a-rewind")
    git(fixture.product, "update-index", "--add", "--cacheinfo", `160000,${theirs},packages/alpha`)
    git(fixture.product, "commit", "-q", "-m", "pin alpha at theirs")
    const candidate = git(fixture.product, "rev-parse", "HEAD")

    git(fixture.product, "switch", "-q", "main")
    git(child, "checkout", "-q", rewound)
    git(fixture.product, "add", "packages/alpha")
    git(fixture.product, "commit", "-q", "-m", "rewind alpha below the base")
    const headBefore = git(fixture.product, "rev-parse", "HEAD")
    // POSITIVE CONTROL: theirs contains ours, and base does not reach ours.
    git(child, "fetch", "-q", "origin", `refs/git-super/pins/${theirs}`)
    expect(() => git(child, "merge-base", "--is-ancestor", rewound, theirs)).not.toThrow()
    expect(() => git(child, "merge-base", "--is-ancestor", base, rewound)).toThrow()

    const result = await superMerge({ repo: fixture.product, commit: candidate })

    expect(result).toMatchObject({ state: "failed", partial: false, detail: { code: "gitlink-compose-refused" } })
    // 24977: with no overlap gate, the refusal is the rewind itself, named.
    expect(result.detail?.message).toContain(`rewound: the main pin ${rewound} does not descend from the base ${base}`)
    expect(git(fixture.product, "rev-parse", "HEAD")).toBe(headBefore)
    expect(git(fixture.product, "status", "--porcelain=v1")).toBe("")
  })

  it.each([true, false])(
    "names the base, ours, and theirs submodule pins when gitlinks conflict (base present: %s)",
    async (hasBase) => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-conflicting-pins-"))
      roots.push(fixtureRoot)
      const fixture = createProductFixture(fixtureRoot)
      if (!hasBase) {
        git(fixture.product, "update-index", "--force-remove", "packages/alpha")
        git(fixture.product, "commit", "-q", "-m", "remove base gitlink")
      }
      const ours = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 'ours'\n")
      git(fixture.alpha, "switch", "-q", "-c", "submodule-theirs", fixture.alphaBase)
      const theirs = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 'theirs'\n")
      const submodule = join(fixture.product, "packages/alpha")
      git(submodule, "fetch", "-q", "origin")
      git(fixture.product, "switch", "-q", "-c", "candidate-conflicting-pin")
      git(submodule, "checkout", "-q", theirs)
      git(fixture.product, "add", "packages/alpha")
      git(fixture.product, "commit", "-q", "-m", "pin theirs")
      const candidate = git(fixture.product, "rev-parse", "HEAD")
      // The no-base branch has no gitlink; retain its checkout for the next pin.
      git(fixture.product, "switch", "--no-recurse-submodules", "-q", "main")
      git(submodule, "checkout", "-q", ours)
      git(fixture.product, "add", "packages/alpha")
      git(fixture.product, "commit", "-q", "-m", "pin ours")
      const headBefore = git(fixture.product, "rev-parse", "HEAD")
      const statusBefore = git(fixture.product, "status", "--porcelain=v1")
      const stdout = outputSink()
      const stderr = outputSink()

      expect(await runCli(["--repo", fixture.product, "--json", "merge", candidate], stdout, stderr)).toBe(1)
      const result = JSON.parse(stdout.output) as { detail: GitResultDetail }
      // WITH a base the two pins are a composable shape, so the refusal is now
      // the composer's, which names WHICH predicate failed (both sides edited
      // `alpha.ts`) on top of the same stage evidence. Without a base there are
      // no three stages to plan from, so the merge refuses exactly as it did.
      expect(result).toMatchObject({
        state: "failed",
        partial: false,
        detail: { code: hasBase ? "gitlink-compose-refused" : "merge-conflict" },
      })
      expect(result.detail.paths).toEqual(["packages/alpha"])
      expect(result.detail.objectIds).toEqual(
        expect.arrayContaining(hasBase ? [fixture.alphaBase, ours, theirs] : [ours, theirs]),
      )
      expect(result.detail.message).toContain(
        `"packages/alpha": ${hasBase ? `base=${fixture.alphaBase} ` : ""}ours=${ours} theirs=${theirs}`,
      )
      if (!hasBase) {
        expect(result.detail.objectIds).not.toContain(fixture.alphaBase)
        expect(result.detail.message).not.toContain("base=")
      }
      expect(git(fixture.product, "rev-parse", "HEAD")).toBe(headBefore)
      expect(git(fixture.product, "status", "--porcelain=v1")).toBe(statusBefore)
    },
  )

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
    // Each materialized child has its own config; transport rewrites are fixture-local.
    git(worktreeAlpha, "config", `url.${fixture.alpha}.insteadOf`, "https://git-super.test/owned/alpha.git")
    git(
      join(worktree, "vendor/beta"),
      "config",
      `url.${fixture.beta}.insteadOf`,
      "https://git-super.test/owned/beta.git",
    )
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

    expect(result.state, JSON.stringify(result)).toBe("updated")
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
    expect(result.detail?.code).toBe("submodule-history-unreadable")
    expect(result.detail?.message).toContain(`error: Could not read ${unreadable}`)
    expect(result.detail?.objectIds).toContain(unreadable)
    expect(result.detail?.message).not.toContain("merge-conflict")
  })

  it("refuses an unreadable submodule main before merging and names the resource", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-unreadable-main-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const candidate = candidateWithRootChange(fixture, "candidate-unreadable")
    const submodule = join(fixture.product, "packages/alpha")
    git(fixture.product, "config", "submodule.packages/alpha.branch", "main")
    const origin = git(submodule, "config", "--get", "remote.origin.url")
    git(submodule, "config", "--unset-all", `url.${fixture.alpha}.insteadOf`)
    git(submodule, "config", `url.${join(fixtureRoot, "missing-alpha-origin")}.insteadOf`, origin)
    const headBefore = git(fixture.product, "rev-parse", "HEAD")
    const stdout = outputSink()
    const stderr = outputSink()

    expect(await runCli(["--repo", fixture.product, "merge", candidate], stdout, stderr)).toBe(1)
    expect(stdout.output).toBe("")
    expect(stderr.output).toContain("submodule-main-unreadable")
    expect(stderr.output).toContain("packages/alpha")
    expect(stderr.output).toContain(`fetch --no-tags ${origin} +refs/heads/main:refs/remotes/origin/main`)
    expect(stderr.output).toContain("owner: the submodule writer")
    expect(git(fixture.product, "rev-parse", "HEAD")).toBe(headBefore)
  })

  it("does not misreport an ancestry probe failure as an off-main pin", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-ancestry-failure-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const submodule = join(fixture.product, "packages/alpha")
    git(fixture.product, "switch", "-q", "-c", "candidate-ancestry-failure")
    writeFileSync(join(submodule, "alpha.ts"), "export const alpha = 'unprovable'\n")
    git(submodule, "add", "alpha.ts")
    git(submodule, "commit", "-q", "-m", "advance alpha without proof")
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
          if (request.repo === submodule && request.args[0] === "merge-base") {
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

/**
 * @failure  `planGitlinks` reads ONE level. It classifies the root's own
 *           gitlinks against their mains and never descends, so a nested pin --
 *           `km/apps/maddoc` in production, `packages/alpha/apps/maddoc` here --
 *           is neither classified nor validated by a merge. A landing can
 *           therefore record a nested pin that is diverged from its own main, or
 *           that no one can fetch, and say nothing. Until this lands, a nested
 *           component is one of only two cases still allowed a direct hand push
 *           to its component main (@cto, 2026-09-11), so this closes that
 *           exception rather than merely improving the planner.
 * @level    l1
 * @consumer every root submit that carries a nested component.
 */
/**
 * A candidate in the SHAPE OF THE REAL LANDING: a maddoc commit, an alpha commit
 * pinning it, a root commit pinning that alpha. Neither component commit is on
 * its own main, so both are on the AHEAD rung and both get published.
 *
 * Ahead is not decoration. The walk descends only into parents that will be
 * published, so a fixture whose alpha is Equal or Behind never reaches depth 2
 * at all and every nested assertion below would pass vacuously on a level that
 * was never walked.
 */
function advanceNestedThroughAlpha(
  fixture: NestedProductFixture,
  name: string,
  leafContent: string,
): Readonly<{ candidate: string; alphaHead: string; leafHead: string }> {
  const alphaCheckout = join(fixture.product, "packages/alpha")
  const leafCheckout = join(alphaCheckout, "apps/maddoc")
  git(fixture.product, "switch", "-q", "-c", name)
  writeFileSync(join(leafCheckout, "leaf.ts"), leafContent)
  git(leafCheckout, "add", "leaf.ts")
  git(leafCheckout, "commit", "-q", "-m", `${name}: advance maddoc`)
  const leafHead = git(leafCheckout, "rev-parse", "HEAD")
  git(alphaCheckout, "add", "apps/maddoc")
  git(alphaCheckout, "commit", "-q", "-m", `${name}: re-pin maddoc`)
  const alphaHead = git(alphaCheckout, "rev-parse", "HEAD")
  git(fixture.product, "add", "packages/alpha")
  git(fixture.product, "commit", "-q", "-m", `${name}: re-pin alpha`)
  const candidate = git(fixture.product, "rev-parse", "HEAD")
  git(fixture.product, "switch", "-q", "main")
  return { candidate, alphaHead, leafHead }
}

/**
 * Re-pin the nested gitlink at an EXISTING leaf commit, through an Ahead alpha.
 *
 * The candidate alpha is cut from alpha's CURRENT main, not from whatever the
 * product happens to pin. That is what makes it Ahead rather than Diverged --
 * and Diverged would be refused on the more basic rung, so a lowering arm built
 * on a diverged parent can never reach the check it means to exercise.
 */
function repinNestedThroughAlpha(
  fixture: NestedProductFixture,
  name: string,
  leafTarget: string,
): Readonly<{ candidate: string; alphaHead: string }> {
  const alphaCheckout = join(fixture.product, "packages/alpha")
  const leafCheckout = join(alphaCheckout, "apps/maddoc")
  git(fixture.product, "switch", "-q", "-c", name)
  git(alphaCheckout, "fetch", "-q", "origin")
  git(alphaCheckout, "checkout", "-q", git(fixture.alpha, "rev-parse", "main"))
  git(leafCheckout, "fetch", "-q", "origin")
  git(leafCheckout, "checkout", "-q", leafTarget)
  git(alphaCheckout, "add", "apps/maddoc")
  git(alphaCheckout, "commit", "-q", "-m", `${name}: re-pin maddoc at ${leafTarget}`)
  const alphaHead = git(alphaCheckout, "rev-parse", "HEAD")
  git(fixture.product, "add", "packages/alpha")
  git(fixture.product, "commit", "-q", "-m", `${name}: re-pin alpha`)
  const candidate = git(fixture.product, "rev-parse", "HEAD")
  git(fixture.product, "switch", "-q", "main")
  return { candidate, alphaHead }
}

/** Move the leaf's main on, and have ALPHA MAIN record the newer pin. */
function raiseNestedPinOnAlphaMain(fixture: NestedProductFixture, leafContent: string): string {
  const raised = advanceRepository(fixture.leaf, "leaf.ts", leafContent)
  const alphaLeafCheckout = join(fixture.alpha, "apps/maddoc")
  git(alphaLeafCheckout, "fetch", "-q", "origin")
  git(alphaLeafCheckout, "checkout", "-q", raised)
  git(fixture.alpha, "commit", "-q", "-am", "alpha main raises its nested pin")
  return raised
}

describe("git super merge — the nested gitlink chain (24454 row 4)", () => {
  it("walks into an Ahead parent and classifies its nested pin against the nested main", async () => {
    const root = mkdtempSync(join(tmpdir(), "git-super-merge-nested-"))
    roots.push(root)
    const fixture = createNestedProductFixture(root)
    const moved = advanceNestedThroughAlpha(fixture, "candidate-nested", "export const leaf = 3\n")
    const result = await superMerge({ repo: fixture.product, commit: moved.candidate })

    // DEPTH 2 MUST APPEAR AT ALL. Before this row the planner stopped at depth 1
    // and this array held only `packages/alpha` and `vendor/beta`.
    expect(
      result.gitlinks.map((entry) => entry.path),
      "the nested path must be classified, not skipped",
    ).toContain("packages/alpha/apps/maddoc")
    expect(result).toMatchObject({
      state: "updated",
      gitlinks: expect.arrayContaining([
        expect.objectContaining({ path: "packages/alpha", from: moved.alphaHead, state: "kept-ahead" }),
        expect.objectContaining({
          path: "packages/alpha/apps/maddoc",
          from: moved.leafHead,
          to: fixture.leafBase,
          state: "kept-ahead",
        }),
      ]),
    })
    // VALIDATE-ONLY: the nested pin is classified, never rewritten. `to` above is
    // the nested MAIN it was measured against, and the recorded pin is untouched.
    expect(git(join(fixture.product, "packages/alpha"), "rev-parse", `${moved.alphaHead}:apps/maddoc`)).toBe(
      moved.leafHead,
    )
    // A checkout plan is settled against the ROOT index and worktree, so a
    // nested path must never get one -- the same reason a nested raise cannot
    // be applied. The nested checkout happens to exist under the root worktree
    // in this fixture, so nothing would fail loudly if one were planned.
    expect(
      (result.checkouts ?? []).map((row) => row.path),
      "nested paths must not get a root checkout plan",
    ).not.toContain("packages/alpha/apps/maddoc")
  })

  it("does NOT walk into an Equal parent, whose nested pins were validated when it landed", async () => {
    const root = mkdtempSync(join(tmpdir(), "git-super-merge-nested-equal-"))
    roots.push(root)
    const fixture = createNestedProductFixture(root)
    // Alpha's pin already equals alpha main, so the root merge lands a commit
    // alpha main already holds. Re-walking it would re-litigate a landing that
    // was validated when it happened -- and it is what bounds the walk.
    //
    // THE LEAF'S MAIN MOVES ON FIRST, and that is what gives this arm teeth. If
    // the nested pin were Equal as well, a walk into this parent would produce
    // no row either, and the arm would pass whether or not the bound holds.
    // Behind its own main, a walk would classify it `kept-behind` and the row
    // would appear.
    advanceRepository(fixture.leaf, "leaf.ts", "export const leaf = 'moved on'\n")
    const candidate = candidateWithRootChange(fixture, "candidate-equal")
    const result = await superMerge({ repo: fixture.product, commit: candidate })

    expect(result.state).toBe("updated")
    expect(
      result.gitlinks.map((entry) => entry.path),
      "an Equal parent is not descended into",
    ).not.toContain("packages/alpha/apps/maddoc")
  })

  it("records a nested pin BEHIND its own main without raising it", async () => {
    const root = mkdtempSync(join(tmpdir(), "git-super-merge-nested-behind-"))
    roots.push(root)
    const fixture = createNestedProductFixture(root)
    // The nested main moves on; the candidate keeps pinning the older commit,
    // which is exactly what a parent legitimately pinning an older child looks
    // like. It is not a lowering -- alpha main records the same pin.
    const newerLeaf = advanceRepository(fixture.leaf, "leaf.ts", "export const leaf = 9\n")
    const alphaCheckout = join(fixture.product, "packages/alpha")
    git(fixture.product, "switch", "-q", "-c", "candidate-behind")
    writeFileSync(join(alphaCheckout, "alpha.ts"), "export const alpha = 'ahead'\n")
    git(alphaCheckout, "add", "alpha.ts")
    git(alphaCheckout, "commit", "-q", "-m", "advance alpha without touching its nested pin")
    git(fixture.product, "add", "packages/alpha")
    git(fixture.product, "commit", "-q", "-m", "re-pin alpha")
    const candidate = git(fixture.product, "rev-parse", "HEAD")
    git(fixture.product, "switch", "-q", "main")

    const result = await superMerge({ repo: fixture.product, commit: candidate })

    expect(result.state).toBe("updated")
    // KEPT-BEHIND, NOT RAISED. A raise here would rewrite what alpha's commit
    // means, and cannot be applied anyway: raises go through the ROOT index,
    // which holds no entry for a nested path.
    expect(result.gitlinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "packages/alpha/apps/maddoc",
          from: fixture.leafBase,
          to: newerLeaf,
          state: "kept-behind",
        }),
      ]),
    )
    // The descent journal records this rung too (@cto, 24454 row-1 review). This
    // arm is the one worth pinning of the three non-Equal journal lines, because
    // it runs a lowering refusal BEFORE recording -- so the assertion also proves
    // the journal line sits after the check that can throw past it.
    expect(result.descents).toEqual([
      {
        parent: "packages/alpha",
        parentTarget: git(fixture.product, "rev-parse", "HEAD:packages/alpha"),
        children: [{ path: "packages/alpha/apps/maddoc", target: fixture.leafBase, state: "kept-behind" }],
      },
    ])
    expect(
      git(alphaCheckout, "rev-parse", `${git(fixture.product, "rev-parse", "HEAD:packages/alpha")}:apps/maddoc`),
      "the recorded nested pin is untouched",
    ).toBe(fixture.leafBase)
  })

  it("refuses a nested pin that is off its OWN main, before any write", async () => {
    const root = mkdtempSync(join(tmpdir(), "git-super-merge-nested-diverged-"))
    roots.push(root)
    const fixture = createNestedProductFixture(root)
    const moved = advanceNestedThroughAlpha(fixture, "candidate-diverged", "export const leaf = 'unpublished'\n")
    // The nested main moves to a COMPETING commit, so the candidate's nested pin
    // is neither behind it nor ahead of it. This is D1, one level down, and it
    // stays refused: the one-sided composition takes root-level plans only (25389).
    const competingLeaf = advanceRepository(fixture.leaf, "leaf.ts", "export const leaf = 'competing'\n")
    const headBefore = git(fixture.product, "rev-parse", "HEAD")
    const statusBefore = git(fixture.product, "status", "--porcelain=v1")
    const stdout = outputSink()
    const stderr = outputSink()

    const code = await runCli(
      ["--repo", fixture.product, "merge", moved.candidate, "-m", "merge candidate"],
      stdout,
      stderr,
    )

    expect(code).toBe(1)
    expect(stdout.output).toBe("")
    expect(stderr.output).toContain("gitlink-off-main")
    expect(stderr.output, "the refusal names the NESTED path, not just its parent").toContain(
      "packages/alpha/apps/maddoc",
    )
    expect(stderr.output).toContain(moved.leafHead)
    expect(stderr.output).toContain(competingLeaf)
    expect(stderr.output).toContain("owner: the submodule writer")
    expect(git(fixture.product, "rev-parse", "HEAD")).toBe(headBefore)
    expect(git(fixture.product, "status", "--porcelain=v1")).toBe(statusBefore)
  })

  it("refuses a nested pin LOWERED below what the parent's own main records, before any write", async () => {
    const root = mkdtempSync(join(tmpdir(), "git-super-merge-nested-lowered-"))
    roots.push(root)
    const fixture = createNestedProductFixture(root)
    // Alpha main advances its nested pin. The candidate then re-records maddoc at
    // the OLDER commit through an Ahead alpha -- the shape a stale nested
    // checkout committed by accident produces.
    const raisedLeaf = raiseNestedPinOnAlphaMain(fixture, "export const leaf = 2\n")
    const lowered = repinNestedThroughAlpha(fixture, "candidate-lowered", fixture.leafBase)
    const headBefore = git(fixture.product, "rev-parse", "HEAD")
    const statusBefore = git(fixture.product, "status", "--porcelain=v1")
    const stdout = outputSink()
    const stderr = outputSink()

    const code = await runCli(
      ["--repo", fixture.product, "merge", lowered.candidate, "-m", "merge candidate"],
      stdout,
      stderr,
    )

    expect(code).toBe(1)
    expect(stdout.output).toBe("")
    expect(stderr.output).toContain("nested-pin-lowered")
    expect(stderr.output).toContain("packages/alpha/apps/maddoc")
    expect(stderr.output, "the remedy names the pin the author must re-record at or after").toContain(raisedLeaf)
    expect(stderr.output).toContain("owner: the submodule writer")
    expect(git(fixture.product, "rev-parse", "HEAD")).toBe(headBefore)
    expect(git(fixture.product, "status", "--porcelain=v1")).toBe(statusBefore)
  })

  it("refuses a lowering even when the nested pin EQUALS its own main", async () => {
    const root = mkdtempSync(join(tmpdir(), "git-super-merge-nested-equal-lowered-"))
    roots.push(root)
    const fixture = createNestedProductFixture(root)
    // ALPHA MAIN PINS AN OFF-MAIN LEAF COMMIT -- left there by a hand push, the
    // one way a parent main can break "a gitlink points at a commit its own
    // main contains". It is the only shape where a nested pin equal to its own
    // main is still a lowering, and the Equal rung short-circuits before the
    // ladder, so this is the case a check placed after it would never see.
    const alphaLeafCheckout = join(fixture.alpha, "apps/maddoc")
    git(fixture.leaf, "switch", "-q", "-c", "hand-pushed")
    const offLeafMain = advanceRepository(fixture.leaf, "leaf.ts", "export const leaf = 'hand pushed'\n")
    git(fixture.leaf, "switch", "-q", "main")
    const newerLeafMain = advanceRepository(fixture.leaf, "leaf.ts", "export const leaf = 'main moved on'\n")
    git(alphaLeafCheckout, "fetch", "-q", "origin")
    git(alphaLeafCheckout, "checkout", "-q", offLeafMain)
    git(fixture.alpha, "commit", "-q", "-am", "alpha main pins an off-main nested commit")
    // The candidate records the leaf at its own main exactly: the EQUAL rung.
    const lowered = repinNestedThroughAlpha(fixture, "candidate-equal-lowered", newerLeafMain)
    const headBefore = git(fixture.product, "rev-parse", "HEAD")
    const stdout = outputSink()
    const stderr = outputSink()

    const code = await runCli(
      ["--repo", fixture.product, "merge", lowered.candidate, "-m", "merge candidate"],
      stdout,
      stderr,
    )

    expect(code).toBe(1)
    expect(stderr.output).toContain("nested-pin-lowered")
    expect(stderr.output).toContain("packages/alpha/apps/maddoc")
    expect(stderr.output).toContain(offLeafMain)
    expect(git(fixture.product, "rev-parse", "HEAD")).toBe(headBefore)
  })

  it("refuses a nested gitlink whose checkout is absent, instead of reading its PARENT", async () => {
    const root = mkdtempSync(join(tmpdir(), "git-super-merge-nested-absent-"))
    roots.push(root)
    const fixture = createNestedProductFixture(root)
    const moved = advanceNestedThroughAlpha(fixture, "candidate-absent", "export const leaf = 6\n")
    // Git discovery walks UP. With no checkout at the nested path,
    // `rev-parse --show-toplevel` answers with ALPHA -- so without the guard the
    // walk fetches a main, compares an ancestry and classifies a pin in the
    // wrong repository, every step succeeding and every answer meaningless.
    const alphaCheckout = join(fixture.product, "packages/alpha")
    git(alphaCheckout, "submodule", "deinit", "-f", "apps/maddoc")
    const headBefore = git(fixture.product, "rev-parse", "HEAD")
    const stdout = outputSink()
    const stderr = outputSink()

    const code = await runCli(
      ["--repo", fixture.product, "merge", moved.candidate, "-m", "merge candidate"],
      stdout,
      stderr,
    )

    expect(code).toBe(1)
    expect(stderr.output).toContain("gitlink-store-absent")
    expect(stderr.output).toContain("apps/maddoc")
    expect(stderr.output, "the refusal says what to do about it").toContain("initialize that submodule checkout")
    expect(git(fixture.product, "rev-parse", "HEAD")).toBe(headBefore)
  })

  it("reports Diverged, not lowered, when a nested pin is both", async () => {
    const root = mkdtempSync(join(tmpdir(), "git-super-merge-nested-both-"))
    roots.push(root)
    const fixture = createNestedProductFixture(root)
    const raisedLeaf = raiseNestedPinOnAlphaMain(fixture, "export const leaf = 2\n")
    // The parent must be AHEAD, or it is refused on its own rung and the nested
    // level is never walked at all -- an arm that asserts a nested precedence
    // while the parent is Diverged passes on the parent's refusal.
    const alphaCheckout = join(fixture.product, "packages/alpha")
    const leafCheckout = join(alphaCheckout, "apps/maddoc")
    git(fixture.product, "switch", "-q", "-c", "candidate-both")
    git(alphaCheckout, "fetch", "-q", "origin")
    git(alphaCheckout, "checkout", "-q", git(fixture.alpha, "rev-parse", "main"))
    // A nested commit cut from the OLD leaf tip: off leaf main, and below what
    // alpha main records for it. Both refusals apply to the same pin.
    git(leafCheckout, "checkout", "-q", fixture.leafBase)
    writeFileSync(join(leafCheckout, "leaf.ts"), "export const leaf = 'unpublished'\n")
    git(leafCheckout, "add", "leaf.ts")
    git(leafCheckout, "commit", "-q", "-m", "advance maddoc off its own main")
    const divergedLeaf = git(leafCheckout, "rev-parse", "HEAD")
    git(alphaCheckout, "add", "apps/maddoc")
    git(alphaCheckout, "commit", "-q", "-m", "re-pin maddoc at a diverged commit")
    git(fixture.product, "add", "packages/alpha")
    git(fixture.product, "commit", "-q", "-m", "re-pin alpha")
    const candidate = git(fixture.product, "rev-parse", "HEAD")
    git(fixture.product, "switch", "-q", "main")
    const stdout = outputSink()
    const stderr = outputSink()

    const code = await runCli(["--repo", fixture.product, "merge", candidate, "-m", "merge candidate"], stdout, stderr)

    expect(code).toBe(1)
    // Re-recording the gitlink cannot cure a commit that is off its own main, so
    // the lowering remedy would send the author to the wrong fix.
    expect(stderr.output).toContain("gitlink-off-main")
    expect(stderr.output).toContain("packages/alpha/apps/maddoc")
    expect(stderr.output).toContain(divergedLeaf)
    expect(stderr.output, "the more basic refusal wins, and it wins alone").not.toContain("nested-pin-lowered")
    expect(raisedLeaf).not.toBe(divergedLeaf)
  })

  it("classifies the nested level against its PARENT's configured submodule branch", async () => {
    const root = mkdtempSync(join(tmpdir(), "git-super-merge-nested-branch-"))
    roots.push(root)
    const fixture = createNestedProductFixture(root)
    // `submodule.apps/maddoc.branch` is declared by ALPHA, the nested gitlink's
    // superproject. Reading it from the root instead finds nothing, falls back to
    // the leaf's remote HEAD, and measures the pin against the wrong branch.
    git(fixture.leaf, "switch", "-q", "-c", "stable")
    const stable = advanceRepository(fixture.leaf, "leaf.ts", "export const leaf = 'stable'\n")
    git(fixture.leaf, "switch", "-q", "main")
    advanceRepository(fixture.leaf, "leaf.ts", "export const leaf = 'main moved elsewhere'\n")
    const alphaCheckout = join(fixture.product, "packages/alpha")
    git(alphaCheckout, "config", "submodule.apps/maddoc.branch", "stable")
    // The candidate leads `stable`, not `main`. Cutting it from the leaf
    // checkout's current tip would leave it diverged from the very branch this
    // arm is about, and the merge would refuse on the wrong rung.
    const leafCheckout = join(alphaCheckout, "apps/maddoc")
    git(leafCheckout, "fetch", "-q", "origin")
    git(leafCheckout, "checkout", "-q", stable)
    const moved = advanceNestedThroughAlpha(fixture, "candidate-branch", "export const leaf = 'stable + one'\n")
    const result = await superMerge({ repo: fixture.product, commit: moved.candidate })

    expect(result.state).toBe("updated")
    expect(result.gitlinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "packages/alpha/apps/maddoc", to: stable, state: "kept-ahead" }),
      ]),
    )
  })

  it("freezes a publication row for the nested pin, ordered leaf-first", async () => {
    const root = mkdtempSync(join(tmpdir(), "git-super-merge-nested-freeze-"))
    roots.push(root)
    const fixture = createNestedProductFixture(root)
    const moved = advanceNestedThroughAlpha(fixture, "candidate-freeze", "export const leaf = 4\n")
    const result = await superMerge({ repo: fixture.product, commit: moved.candidate })
    expect(result.state).toBe("updated")

    const message = git(fixture.product, "log", "-1", "--format=%B", "HEAD")
    const encoded = message
      .split(/\r?\n/u)
      .find((line) => line.startsWith(`${PUSH_INTENT_TRAILER}:`))
      ?.slice(PUSH_INTENT_TRAILER.length + 1)
      .trim()
    expect(encoded, `the merge must carry a ${PUSH_INTENT_TRAILER} trailer`).toBeDefined()
    const intent = decodePushIntent(encoded ?? "")
    const paths = intent.children.map((child) => child.path)

    // OBJECTS EXISTING IS NOT A LANDING. Without a publication row the nested pin
    // is only retained at refs/git-super/pins and maddoc main never moves, so
    // alpha main would pin a maddoc commit maddoc main does not contain -- the
    // 24493 half-landing, one level down.
    const nested = intent.children.find((child) => child.path === "packages/alpha/apps/maddoc")
    expect(nested, "the nested pin must have a frozen row at all").toBeDefined()
    expect(nested?.pin).toBe(moved.leafHead)
    expect(nested?.publication?.source, "and a publication row that MOVES its main").toBe(moved.leafHead)

    // LEAF-FIRST, ASSERTED BY POSITION. The consumer pushes publication rows in
    // this order and `groupUpdates` preserves first-seen order inside its
    // non-root partition, so this ordering is what keeps alpha main from moving
    // before the maddoc commit it pins is publishable.
    expect(paths.indexOf("packages/alpha/apps/maddoc")).toBeGreaterThanOrEqual(0)
    expect(
      paths.indexOf("packages/alpha/apps/maddoc"),
      "maddoc's row must precede alpha's, or alpha main lands pinning a commit maddoc main lacks",
    ).toBeLessThan(paths.indexOf("packages/alpha"))
  })
})

/**
 * Advance ALPHA only, leaving its nested pin exactly where it is.
 *
 * This is the production shape the descent journal exists for, and the one the
 * 2026-09-11 round `q-20260911T172747065Z-d40efc18` had: the parent is AHEAD and
 * gets published, its nested child is EQUAL to its own main and is recorded as
 * it stands. Equal is the ONLY classification that pushes no settlement row, so
 * before the journal this descent produced no output at all.
 */
function advanceAlphaOnly(
  fixture: NestedProductFixture,
  name: string,
): Readonly<{ candidate: string; alphaHead: string; leafPin: string }> {
  const alphaCheckout = join(fixture.product, "packages/alpha")
  git(fixture.product, "switch", "-q", "-c", name)
  writeFileSync(join(alphaCheckout, "alpha-only.ts"), `export const only = "${name}"\n`)
  git(alphaCheckout, "add", "alpha-only.ts")
  git(alphaCheckout, "commit", "-q", "-m", `${name}: advance alpha without touching maddoc`)
  const alphaHead = git(alphaCheckout, "rev-parse", "HEAD")
  const leafPin = git(alphaCheckout, "rev-parse", "HEAD:apps/maddoc")
  git(fixture.product, "add", "packages/alpha")
  git(fixture.product, "commit", "-q", "-m", `${name}: re-pin alpha`)
  const candidate = git(fixture.product, "rev-parse", "HEAD")
  git(fixture.product, "switch", "-q", "main")
  return { candidate, alphaHead, leafPin }
}

describe("git super merge — the descent journal (24454 follow-up)", () => {
  it("journals an EQUAL nested child, which emits no settlement row of its own", async () => {
    const root = mkdtempSync(join(tmpdir(), "git-super-descent-equal-"))
    roots.push(root)
    const fixture = createNestedProductFixture(root)
    const moved = advanceAlphaOnly(fixture, "candidate-alpha-only")
    const result = await superMerge({ repo: fixture.product, commit: moved.candidate })

    expect(result.state).toBe("updated")
    // THE GAP, asserted as a gap: the nested child is classified and produces
    // NOTHING in gitlinks. If this ever starts containing maddoc, the journal is
    // no longer the only evidence and this test should be re-read, not deleted.
    expect(
      result.gitlinks.map((entry) => entry.path),
      "an Equal nested child must still emit no settlement row",
    ).not.toContain("packages/alpha/apps/maddoc")

    // ...and the descent is nevertheless provable from the output alone.
    expect(result.descents).toEqual([
      {
        parent: "packages/alpha",
        parentTarget: moved.alphaHead,
        children: [{ path: "packages/alpha/apps/maddoc", target: moved.leafPin, state: "equal" }],
      },
    ])
  })

  it("journals a non-EQUAL nested child too, beside the settlement row it already emits", async () => {
    const root = mkdtempSync(join(tmpdir(), "git-super-descent-ahead-"))
    roots.push(root)
    const fixture = createNestedProductFixture(root)
    const moved = advanceNestedThroughAlpha(fixture, "candidate-descent-ahead", "export const leaf = 9\n")
    const result = await superMerge({ repo: fixture.product, commit: moved.candidate })

    expect(result.descents).toEqual([
      {
        parent: "packages/alpha",
        parentTarget: moved.alphaHead,
        children: [{ path: "packages/alpha/apps/maddoc", target: moved.leafHead, state: "kept-ahead" }],
      },
      // THE SECOND ROW IS THE POINT, not noise. An Ahead child is itself a
      // parent the walk descends into, and maddoc has no gitlinks of its own, so
      // its row carries no children. "Descended and found none" and "never
      // descended" are precisely the two states this journal exists to separate,
      // and an empty children array is how the first one says so.
      { parent: "packages/alpha/apps/maddoc", parentTarget: moved.leafHead, children: [] },
    ])
  })

  it("is ABSENT when no parent was Ahead, so a consumer that ignores it sees no change", async () => {
    const root = mkdtempSync(join(tmpdir(), "git-super-descent-none-"))
    roots.push(root)
    const fixture = createNestedProductFixture(root)
    // A root-only change: nothing descends, so there is nothing to journal.
    const candidate = candidateWithRootChange(fixture, "candidate-root-only")
    const result = await superMerge({ repo: fixture.product, commit: candidate })

    expect(result.state).toBe("updated")
    expect(result.descents).toBeUndefined()
  })
})

/**
 * @failure A diverged submodule pin is refused although the two sides changed
 * disjoint files and the component could be merged.
 * @level l1
 * @consumer Yrd settled candidate preparation and landing
 */
describe("git super merge — a diverged gitlink the merge composes", () => {
  /**
   * Main pins `ours`, the candidate pins `theirs`, and the two component
   * commits diverged from the same base. The shape the queue bounces today.
   */
  function divergedAlphaPins(
    fixture: ProductFixture,
    ours: readonly (readonly [string, string])[],
    theirs: readonly (readonly [string, string])[],
  ): Readonly<{ candidate: string; ours: string; theirs: string }> {
    let oursSha = fixture.alphaBase
    for (const [file, content] of ours) oursSha = advanceRepository(fixture.alpha, file, content)
    git(fixture.alpha, "switch", "-q", "-c", "submodule-theirs", fixture.alphaBase)
    let theirsSha = fixture.alphaBase
    for (const [file, content] of theirs) theirsSha = advanceRepository(fixture.alpha, file, content)
    git(fixture.alpha, "switch", "-q", "main")
    const submodule = join(fixture.product, "packages/alpha")
    git(submodule, "fetch", "-q", "origin")
    git(fixture.product, "switch", "-q", "-c", "candidate-diverged-pin")
    git(submodule, "checkout", "-q", theirsSha)
    git(fixture.product, "add", "packages/alpha")
    git(fixture.product, "commit", "-q", "-m", "pin theirs")
    const candidate = git(fixture.product, "rev-parse", "HEAD")
    git(fixture.product, "switch", "-q", "main")
    git(submodule, "checkout", "-q", oursSha)
    git(fixture.product, "add", "packages/alpha")
    git(fixture.product, "commit", "-q", "-m", "pin ours")
    return { candidate, ours: oursSha, theirs: theirsSha }
  }

  /** Every retention ref the component remote holds, newest spelling first. */
  function retainedPins(repository: string): string[] {
    return git(repository, "for-each-ref", "--format=%(refname)", "refs/git-super/pins").split("\n").filter(Boolean)
  }

  it("merges the component itself when the two sides changed disjoint files", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-compose-disjoint-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const pins = divergedAlphaPins(
      fixture,
      [["main-side.ts", "export const main = 1\n"]],
      [["change-side.ts", "export const change = 1\n"]],
    )
    const submodule = join(fixture.product, "packages/alpha")
    const local = createLocalGitProcess()
    // WHAT THE COMPONENT REMOTE HELD AT THE MOMENT THE ROOT MERGE WAS WRITTEN.
    // "Retained BEFORE the root merge records it" is an ORDER, and an order can
    // only be observed while it happens: read after the fact, a present ref says
    // nothing about which of the two writes came first.
    let retainedAtCommit: string[] = []

    const result = await superMerge({
      repo: fixture.product,
      commit: pins.candidate,
      git: {
        run: async (request) => {
          if (request.repo === fixture.product && request.args[0] === "commit") {
            retainedAtCommit = retainedPins(fixture.alpha)
          }
          return local.run(request)
        },
      },
    })

    expect(result).toMatchObject({ state: "updated", partial: false })
    const settled = result.gitlinks.find((row) => row.path === "packages/alpha")
    expect(settled).toMatchObject({ path: "packages/alpha", state: "merged", to: pins.ours })
    const composed = settled?.from ?? ""
    expect(composed).toMatch(/^[0-9a-f]{40}$/u)
    // (a) the component main tip is the FIRST parent and the pin the second.
    expect(git(submodule, "cat-file", "-p", composed).split("\n").slice(1, 3)).toEqual([
      `parent ${pins.ours}`,
      `parent ${pins.theirs}`,
    ])
    // The merge TREE records the composition, not only the report about it.
    expect(git(fixture.product, "ls-tree", "HEAD", "--", "packages/alpha")).toBe(
      `160000 commit ${composed}\tpackages/alpha`,
    )
    expect(git(fixture.product, "log", "-1", "--format=%B", "HEAD")).toContain(
      `Settled: packages/alpha@${composed} merged submodule-main@${pins.ours}`,
    )
    // (b) retained at the component remote BEFORE the root merge commit existed.
    expect(retainedAtCommit).toContain(`refs/git-super/pins/${composed}`)
    expect(git(fixture.alpha, "ls-remote", fixture.alpha, `refs/git-super/pins/${composed}`)).toContain(composed)
    // (c) nothing moved the component's own main.
    expect(git(fixture.alpha, "rev-parse", "refs/heads/main")).toBe(pins.ours)
    expect(git(submodule, "rev-parse", "HEAD")).toBe(composed)
    expect(git(fixture.product, "status", "--porcelain=v1")).toBe("")
    expect(settled).toMatchObject({
      composition: { base: fixture.alphaBase, parent: pins.ours, pin: pins.theirs, files: { parent: 1, pin: 1 } },
    })
  })

  /**
   * THE CASE A REBUILT THREE-WAY WOULD HAVE LOST. Both sides edit one root file
   * in different hunks, which Git merges cleanly, beside a diverged gitlink
   * whose sides are disjoint. The merge Git already wrote carries the merged
   * content; only the gitlink is stated over it. A trivial `read-tree -m`
   * rebuild would have returned this file conflicted and bounced the change.
   */
  it("keeps Git's own content merge for a file both sides changed in different hunks", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-compose-hunks-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    writeFileSync(join(fixture.product, "root.txt"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\n")
    git(fixture.product, "add", "root.txt")
    git(fixture.product, "commit", "-q", "-m", "a root file both sides will edit")
    const ours = advanceRepository(fixture.alpha, "main-side.ts", "export const main = 1\n")
    git(fixture.alpha, "switch", "-q", "-c", "submodule-theirs", fixture.alphaBase)
    const theirs = advanceRepository(fixture.alpha, "change-side.ts", "export const change = 1\n")
    git(fixture.alpha, "switch", "-q", "main")
    const submodule = join(fixture.product, "packages/alpha")
    git(submodule, "fetch", "-q", "origin")
    git(fixture.product, "switch", "-q", "-c", "candidate-hunks")
    git(submodule, "checkout", "-q", theirs)
    writeFileSync(join(fixture.product, "root.txt"), "one\ntwo\nthree\nfour\nfive\nsix\nCHANGE\n")
    git(fixture.product, "add", "packages/alpha", "root.txt")
    git(fixture.product, "commit", "-q", "-m", "pin theirs and edit the last line")
    const candidate = git(fixture.product, "rev-parse", "HEAD")
    git(fixture.product, "switch", "-q", "main")
    git(submodule, "checkout", "-q", ours)
    writeFileSync(join(fixture.product, "root.txt"), "MAIN\ntwo\nthree\nfour\nfive\nsix\nseven\n")
    git(fixture.product, "add", "packages/alpha", "root.txt")
    git(fixture.product, "commit", "-q", "-m", "pin ours and edit the first line")

    const result = await superMerge({ repo: fixture.product, commit: candidate })

    expect(result).toMatchObject({ state: "updated", partial: false })
    const settled = result.gitlinks.find((row) => row.path === "packages/alpha")
    expect(settled).toMatchObject({ path: "packages/alpha", state: "merged" })
    const composed = settled?.from ?? ""
    expect(git(fixture.product, "ls-tree", "HEAD", "--", "packages/alpha")).toBe(
      `160000 commit ${composed}\tpackages/alpha`,
    )
    // BOTH hunks survive: this is Git's content merge, not one side chosen.
    expect(git(fixture.product, "show", "HEAD:root.txt")).toBe("MAIN\ntwo\nthree\nfour\nfive\nsix\nCHANGE")
    expect(git(fixture.product, "status", "--porcelain=v1")).toBe("")
  })

  it("refuses a diverged gitlink whose two sides changed the same file, naming the file", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-compose-overlap-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const pins = divergedAlphaPins(
      fixture,
      [["shared.ts", "export const shared = 'main'\n"]],
      [["shared.ts", "export const shared = 'change'\n"]],
    )
    const headBefore = git(fixture.product, "rev-parse", "HEAD")
    const commitsBefore = git(fixture.alpha, "rev-list", "--all", "--count")

    const result = await superMerge({ repo: fixture.product, commit: pins.candidate })

    expect(result).toMatchObject({ state: "failed", partial: false, detail: { code: "gitlink-compose-refused" } })
    expect(result.detail?.message).toContain("packages/alpha")
    expect(result.detail?.message).toContain("shared.ts")
    expect(result.detail?.paths).toEqual(["packages/alpha"])
    // Nothing created in the store, nothing pushed.
    expect(git(fixture.alpha, "rev-list", "--all", "--count")).toBe(commitsBefore)
    expect(retainedPins(fixture.alpha)).toEqual([])
    expect(git(fixture.product, "rev-parse", "HEAD")).toBe(headBefore)
    expect(git(fixture.product, "status", "--porcelain=v1")).toBe("")
  })

  // 24977 (@cto e8368e85, constraint 5): "clean" is merge-tree's own answer,
  // not file disjointness. The overlap gate this replaces refused exactly this
  // shape, and 25175 and 25066 bounced on it the day it was ruled.
  it("merges the component itself when both sides changed the same file in different places (24977)", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-compose-same-file-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const lines = ["one", "two", "three", "four", "five", "six", "seven"]
    const shared = advanceRepository(fixture.alpha, "shared.ts", `${lines.join("\n")}\n`)
    const ours = advanceRepository(fixture.alpha, "shared.ts", `${["MAIN", ...lines.slice(1)].join("\n")}\n`)
    git(fixture.alpha, "switch", "-q", "-c", "submodule-theirs", shared)
    const theirs = advanceRepository(fixture.alpha, "shared.ts", `${[...lines.slice(0, 6), "CHANGE"].join("\n")}\n`)
    git(fixture.alpha, "switch", "-q", "main")
    const submodule = join(fixture.product, "packages/alpha")
    git(submodule, "fetch", "-q", "origin")
    git(fixture.product, "switch", "-q", "-c", "candidate-same-file")
    git(submodule, "checkout", "-q", theirs)
    git(fixture.product, "add", "packages/alpha")
    git(fixture.product, "commit", "-q", "-m", "pin theirs")
    const candidate = git(fixture.product, "rev-parse", "HEAD")
    git(fixture.product, "switch", "-q", "main")
    git(submodule, "checkout", "-q", ours)
    git(fixture.product, "add", "packages/alpha")
    git(fixture.product, "commit", "-q", "-m", "pin ours")

    const result = await superMerge({ repo: fixture.product, commit: candidate })

    expect(result).toMatchObject({ state: "updated", partial: false })
    const settled = result.gitlinks.find((row) => row.path === "packages/alpha")
    expect(settled).toMatchObject({ path: "packages/alpha", state: "merged" })
    const composed = settled?.from ?? ""
    expect(git(fixture.alpha, "rev-parse", `${composed}^1`, `${composed}^2`)).toBe(`${ours}\n${theirs}`)
    expect(git(fixture.alpha, "show", `${composed}:shared.ts`)).toBe(
      ["MAIN", ...lines.slice(1, 6), "CHANGE"].join("\n"),
    )
    expect(git(fixture.product, "ls-tree", "HEAD", "--", "packages/alpha")).toBe(
      `160000 commit ${composed}\tpackages/alpha`,
    )
  })

  it("refuses a real content conflict inside the component, naming the conflicted path and no other (24977)", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-compose-conflict-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const pins = divergedAlphaPins(
      fixture,
      [
        ["alpha.ts", "export const alpha = 'main'\n"],
        ["main-only.ts", "export const mainOnly = 1\n"],
      ],
      [
        ["alpha.ts", "export const alpha = 'change'\n"],
        ["change-only.ts", "export const changeOnly = 1\n"],
      ],
    )

    const result = await superMerge({ repo: fixture.product, commit: pins.candidate })

    expect(result).toMatchObject({ state: "failed", partial: false, detail: { code: "gitlink-compose-refused" } })
    expect(result.detail?.message).toContain("gitlink packages/alpha: diverged; content conflict in: alpha.ts")
    expect(result.detail?.message).not.toContain("main-only.ts")
    expect(result.detail?.message).not.toContain("change-only.ts")
    expect(result.detail?.message).not.toContain("changed different files")
    expect(retainedPins(fixture.alpha)).toEqual([])
  })

  // 24977: this was a refusal while the overlap gate stood. Git's merge follows
  // the rename, so merge-tree reports it clean and the queue composes it: the
  // edit lands in the renamed file, and nothing is left at the old path.
  it("composes a rename on one side and an edit at the old path on the other, the edit following the rename (24977)", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-compose-rename-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    // `alpha.ts` is the fixture's base file: main renames it, the change edits it.
    const ours = (() => {
      git(fixture.alpha, "mv", "alpha.ts", "renamed.ts")
      git(fixture.alpha, "commit", "-q", "-m", "rename alpha.ts")
      return git(fixture.alpha, "rev-parse", "HEAD")
    })()
    git(fixture.alpha, "switch", "-q", "-c", "submodule-theirs", fixture.alphaBase)
    const theirs = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 'change'\n")
    git(fixture.alpha, "switch", "-q", "main")
    const submodule = join(fixture.product, "packages/alpha")
    git(submodule, "fetch", "-q", "origin")
    git(fixture.product, "switch", "-q", "-c", "candidate-rename")
    git(submodule, "checkout", "-q", theirs)
    git(fixture.product, "add", "packages/alpha")
    git(fixture.product, "commit", "-q", "-m", "pin theirs")
    const candidate = git(fixture.product, "rev-parse", "HEAD")
    git(fixture.product, "switch", "-q", "main")
    git(submodule, "checkout", "-q", ours)
    git(fixture.product, "add", "packages/alpha")
    git(fixture.product, "commit", "-q", "-m", "pin ours")

    const result = await superMerge({ repo: fixture.product, commit: candidate })

    expect(result).toMatchObject({ state: "updated", partial: false })
    const composed = result.gitlinks.find((row) => row.path === "packages/alpha")?.from ?? ""
    expect(git(fixture.alpha, "rev-parse", `${composed}^1`, `${composed}^2`)).toBe(`${ours}\n${theirs}`)
    expect(git(fixture.alpha, "show", `${composed}:renamed.ts`)).toBe("export const alpha = 'change'")
    expect(git(fixture.alpha, "ls-tree", "--name-only", composed, "--", "alpha.ts")).toBe("")
  })

  it("refuses a diverged gitlink whose two sides share no history as unavailable", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-compose-no-base-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const ours = advanceRepository(fixture.alpha, "main-side.ts", "export const main = 1\n")
    git(fixture.alpha, "checkout", "-q", "--orphan", "submodule-orphan")
    git(fixture.alpha, "rm", "-rq", "--cached", ".")
    rmSync(join(fixture.alpha, "alpha.ts"), { force: true })
    rmSync(join(fixture.alpha, "main-side.ts"), { force: true })
    writeFileSync(join(fixture.alpha, "orphan.ts"), "export const orphan = 1\n")
    git(fixture.alpha, "add", "orphan.ts")
    git(fixture.alpha, "commit", "-q", "-m", "an unrelated history")
    const theirs = git(fixture.alpha, "rev-parse", "HEAD")
    git(fixture.alpha, "checkout", "-q", "-f", "main")
    const submodule = join(fixture.product, "packages/alpha")
    git(submodule, "fetch", "-q", "origin")
    git(fixture.product, "switch", "-q", "-c", "candidate-orphan")
    git(submodule, "checkout", "-q", theirs)
    git(fixture.product, "add", "packages/alpha")
    git(fixture.product, "commit", "-q", "-m", "pin an unrelated history")
    const candidate = git(fixture.product, "rev-parse", "HEAD")
    git(fixture.product, "switch", "-q", "main")
    git(submodule, "checkout", "-q", ours)
    git(fixture.product, "add", "packages/alpha")
    git(fixture.product, "commit", "-q", "-m", "pin ours")
    const headBefore = git(fixture.product, "rev-parse", "HEAD")

    const result = await superMerge({ repo: fixture.product, commit: candidate })

    expect(result).toMatchObject({ state: "failed", partial: false, detail: { code: "gitlink-compose-unavailable" } })
    expect(result.detail?.message).toContain("packages/alpha")
    expect(retainedPins(fixture.alpha)).toEqual([])
    expect(git(fixture.product, "rev-parse", "HEAD")).toBe(headBefore)
  })

  // Test 4c: the mixed content-and-gitlink conflict. The composition is never
  // attempted, because one conflicted path is not a gitlink at all.
  it("never composes when an ordinary file conflicts beside the diverged gitlink (4c)", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-compose-content-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    writeFileSync(join(fixture.product, "root.txt"), "base\n")
    git(fixture.product, "add", "root.txt")
    git(fixture.product, "commit", "-q", "-m", "a root file both sides edit")
    const ours = advanceRepository(fixture.alpha, "main-side.ts", "export const main = 1\n")
    git(fixture.alpha, "switch", "-q", "-c", "submodule-theirs", fixture.alphaBase)
    const theirs = advanceRepository(fixture.alpha, "change-side.ts", "export const change = 1\n")
    git(fixture.alpha, "switch", "-q", "main")
    const submodule = join(fixture.product, "packages/alpha")
    git(submodule, "fetch", "-q", "origin")
    git(fixture.product, "switch", "-q", "-c", "candidate-content-conflict")
    git(submodule, "checkout", "-q", theirs)
    writeFileSync(join(fixture.product, "root.txt"), "change\n")
    git(fixture.product, "add", "packages/alpha", "root.txt")
    git(fixture.product, "commit", "-q", "-m", "pin theirs and edit the root file")
    const candidate = git(fixture.product, "rev-parse", "HEAD")
    git(fixture.product, "switch", "-q", "main")
    git(submodule, "checkout", "-q", ours)
    writeFileSync(join(fixture.product, "root.txt"), "main\n")
    git(fixture.product, "add", "packages/alpha", "root.txt")
    git(fixture.product, "commit", "-q", "-m", "pin ours and edit the root file")

    const head = git(fixture.product, "rev-parse", "HEAD")
    const index = git(fixture.product, "ls-files", "--stage", "-z")
    for (const preserveConflicts of [false, true]) {
      const result = await superMerge({ repo: fixture.product, commit: candidate, preserveConflicts })
      expect(result).toMatchObject({ state: "failed", partial: false, detail: { code: "merge-conflict" } })
      expect(result.detail?.paths).toEqual(expect.arrayContaining(["root.txt", "packages/alpha"]))
      if (preserveConflicts) {
        expect(result.detail?.message).toContain(
          '--preserve-conflicts was declined because gitlink paths conflict: "packages/alpha"; nothing was preserved.',
        )
      } else {
        expect(result.detail?.message).not.toContain("--preserve-conflicts was declined")
      }
      expect(git(fixture.product, "rev-parse", "HEAD")).toBe(head)
      expect(git(fixture.product, "ls-files", "--stage", "-z")).toBe(index)
      expect(git(submodule, "rev-parse", "HEAD")).toBe(ours)
      expect(readFileSync(join(fixture.product, "root.txt"), "utf8")).toBe("main\n")
    }
    expect(retainedPins(fixture.alpha)).toEqual([])
  })

  it("fetches an absent component commit from its remote before composing (25011)", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-compose-absent-fetch-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)

    git(fixture.alpha, "switch", "-q", "--detach", fixture.alphaBase)
    const theirs = advanceRepository(fixture.alpha, "change-side.ts", "export const change = 1\n")
    git(fixture.alpha, "switch", "-q", "main")
    git(fixture.alpha, "update-ref", `refs/git-super/pins/${theirs}`, theirs)

    git(fixture.product, "switch", "-q", "-c", "candidate-absent-pin")
    git(fixture.product, "update-index", "--cacheinfo", `160000,${theirs},packages/alpha`)
    git(fixture.product, "commit", "-q", "-m", "pin theirs without fetching it into submodule")
    const candidate = git(fixture.product, "rev-parse", "HEAD")

    const ours = advanceRepository(fixture.alpha, "main-side.ts", "export const main = 1\n")
    const submodule = join(fixture.product, "packages/alpha")
    git(fixture.product, "switch", "-q", "main")
    git(submodule, "fetch", "-q", "origin")
    git(submodule, "checkout", "-q", ours)
    git(fixture.product, "add", "packages/alpha")
    git(fixture.product, "commit", "-q", "-m", "pin ours")

    expect(() => git(submodule, "cat-file", "-e", `${theirs}^{commit}`)).toThrow()

    const result = await superMerge({ repo: fixture.product, commit: candidate })

    expect(result).toMatchObject({ state: "updated", partial: false })
    const settled = result.gitlinks.find((row) => row.path === "packages/alpha")
    expect(settled).toMatchObject({ path: "packages/alpha", state: "merged", to: ours })
    const composed = settled?.from ?? ""
    expect(composed).toMatch(/^[0-9a-f]{40}$/u)
    expect(git(submodule, "cat-file", "-e", `${composed}^{commit}`)).toBe("")
    expect(git(submodule, "cat-file", "-e", `${theirs}^{commit}`)).toBe("")
  })

  it("refuses a diverged gitlink when the component commit cannot be fetched from origin (25011)", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-compose-unfetchable-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const ours = advanceRepository(fixture.alpha, "main-side.ts", "export const main = 1\n")
    const fakeTheirs = "0123456789012345678901234567890123456789"

    const submodule = join(fixture.product, "packages/alpha")
    git(fixture.product, "switch", "-q", "-c", "candidate-unfetchable-pin")
    git(fixture.product, "update-index", "--cacheinfo", `160000,${fakeTheirs},packages/alpha`)
    git(fixture.product, "commit", "-q", "-m", "pin fake theirs")
    const candidate = git(fixture.product, "rev-parse", "HEAD")

    git(fixture.product, "switch", "-q", "main")
    git(submodule, "fetch", "-q", "origin")
    git(submodule, "checkout", "-q", ours)
    git(fixture.product, "add", "packages/alpha")
    git(fixture.product, "commit", "-q", "-m", "pin ours")

    const result = await superMerge({ repo: fixture.product, commit: candidate })

    expect(result).toMatchObject({ state: "failed", partial: false, detail: { code: "gitlink-compose-refused" } })
    expect(result.detail?.message).toContain("could not be fetched")
    expect(result.detail?.paths).toEqual(["packages/alpha"])
  })
})

describe("git super merge — a one-sided fork the merge composes (25389)", () => {
  /**
   * Fork one component the way a single-component change does: root main pins the component base, the
   * candidate pins `theirs` built on that base, and the component main has since moved to `main`. Only the
   * candidate moves the gitlink, so the ROOT merge is clean and has no conflict to compose from.
   */
  function forkComponent(
    fixture: ProductFixture,
    component: "alpha" | "beta",
    main: readonly (readonly [string, string])[],
    theirs: readonly (readonly [string, string])[],
  ): Readonly<{ base: string; main: string; path: string; theirs: string }> {
    const origin = component === "alpha" ? fixture.alpha : fixture.beta
    const base = component === "alpha" ? fixture.alphaBase : fixture.betaBase
    const path = component === "alpha" ? "packages/alpha" : "vendor/beta"
    let mainSha = base
    for (const [file, content] of main) mainSha = advanceRepository(origin, file, content)
    git(origin, "switch", "-q", "-c", "submodule-theirs", base)
    let theirsSha = base
    for (const [file, content] of theirs) theirsSha = advanceRepository(origin, file, content)
    git(origin, "switch", "-q", "main")
    git(join(fixture.product, path), "fetch", "-q", "origin")
    return { base, main: mainSha, path, theirs: theirsSha }
  }

  /** Commit a candidate branch pinning each fork's `theirs`, then return the checkout to root main's pins. */
  function candidatePinning(
    fixture: ProductFixture,
    name: string,
    forks: readonly { path: string; theirs: string; base: string }[],
  ): string {
    git(fixture.product, "switch", "-q", "-c", name)
    for (const fork of forks) git(join(fixture.product, fork.path), "checkout", "-q", fork.theirs)
    git(fixture.product, "add", ...forks.map((fork) => fork.path))
    git(fixture.product, "commit", "-q", "-m", `pin ${forks.map((fork) => fork.path).join(" and ")}`)
    const candidate = git(fixture.product, "rev-parse", "HEAD")
    git(fixture.product, "switch", "-q", "main")
    for (const fork of forks) git(join(fixture.product, fork.path), "checkout", "-q", fork.base)
    return candidate
  }

  function retainedPins(repository: string): string[] {
    return git(repository, "for-each-ref", "--format=%(refname)", "refs/git-super/pins").split("\n").filter(Boolean)
  }

  /**
   * @failure A clean forked component pin is refused as gitlink-off-main, so its author re-cuts by hand (25389).
   * @level l1
   * @consumer Yrd submit and the queue round, which both call git super merge
   */
  it("merges the component when only the candidate moved its gitlink and the component main moved on", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-fork-clean-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const fork = forkComponent(
      fixture,
      "alpha",
      [["main-side.ts", "export const main = 1\n"]],
      [["change-side.ts", "export const change = 1\n"]],
    )
    const candidate = candidatePinning(fixture, "candidate-fork", [fork])
    // THE SHAPE: the root merge alone is clean. Without that, this is the two-sided case.
    expect(git(fixture.product, "merge-tree", "--write-tree", "HEAD", candidate)).toMatch(/^[0-9a-f]{40}$/u)

    const result = await superMerge({ repo: fixture.product, commit: candidate })

    expect(result).toMatchObject({ state: "updated", partial: false })
    const settled = result.gitlinks.find((row) => row.path === "packages/alpha")
    expect(settled).toMatchObject({ state: "merged", to: fork.main })
    const composed = settled?.from ?? ""
    expect(composed).toMatch(/^[0-9a-f]{40}$/u)
    // The component main is the FIRST parent and the pin the second, as in the two-sided composition.
    expect(git(join(fixture.product, "packages/alpha"), "cat-file", "-p", composed).split("\n").slice(1, 3)).toEqual([
      `parent ${fork.main}`,
      `parent ${fork.theirs}`,
    ])
    expect(settled).toMatchObject({
      composition: { base: fork.base, parent: fork.main, pin: fork.theirs, files: { parent: 1, pin: 1 } },
    })
    expect(git(fixture.product, "ls-tree", "HEAD", "--", "packages/alpha")).toBe(
      `160000 commit ${composed}\tpackages/alpha`,
    )
    expect(git(fixture.product, "log", "-1", "--format=%B", "HEAD")).toContain(
      `Settled: packages/alpha@${composed} merged submodule-main@${fork.main}`,
    )
    expect(retainedPins(fixture.alpha)).toEqual([`refs/git-super/pins/${composed}`])
    expect(git(fixture.alpha, "rev-parse", "refs/heads/main")).toBe(fork.main)
    expect(git(fixture.product, "status", "--porcelain=v1")).toBe("")
  })

  it("refuses a fork whose component merge conflicts, naming the file and the component merge, never a root stage", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-fork-conflict-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const fork = forkComponent(
      fixture,
      "alpha",
      [["shared.ts", "export const shared = 'main'\n"]],
      [["shared.ts", "export const shared = 'change'\n"]],
    )
    const candidate = candidatePinning(fixture, "candidate-fork-conflict", [fork])
    const headBefore = git(fixture.product, "rev-parse", "HEAD")

    const result = await superMerge({ repo: fixture.product, commit: candidate })

    expect(result).toMatchObject({
      state: "failed",
      partial: false,
      detail: { code: "gitlink-compose-refused", owner: "the caller" },
    })
    expect(result.detail?.message).toContain("packages/alpha")
    expect(result.detail?.message).toContain("shared.ts")
    expect(result.detail?.message).toContain(`forks from submodule main ${fork.main} at ${fork.base}`)
    expect(result.detail?.message).toContain('moves "packages/alpha" to a pin off its submodule main')
    expect(result.detail?.message).not.toContain("conflicts with current HEAD")
    expect(result.detail?.message).not.toContain("stage")
    expect(result.detail?.evidence).toContain(`merge-tree --write-tree ${fork.main} ${fork.theirs}`)
    expect(retainedPins(fixture.alpha)).toEqual([])
    expect(git(fixture.product, "rev-parse", "HEAD")).toBe(headBefore)
  })

  it("refuses a fork that shares no history with its component main as gitlink-off-main, naming both commits", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-fork-disjoint-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const main = advanceRepository(fixture.alpha, "main-side.ts", "export const main = 1\n")
    git(fixture.alpha, "checkout", "-q", "--orphan", "submodule-orphan")
    git(fixture.alpha, "rm", "-rq", "--cached", ".")
    rmSync(join(fixture.alpha, "alpha.ts"), { force: true })
    rmSync(join(fixture.alpha, "main-side.ts"), { force: true })
    writeFileSync(join(fixture.alpha, "orphan.ts"), "export const orphan = 1\n")
    git(fixture.alpha, "add", "orphan.ts")
    git(fixture.alpha, "commit", "-q", "-m", "an unrelated history")
    const orphan = git(fixture.alpha, "rev-parse", "HEAD")
    git(fixture.alpha, "checkout", "-q", "-f", "main")
    git(join(fixture.product, "packages/alpha"), "fetch", "-q", "origin")
    const candidate = candidatePinning(fixture, "candidate-fork-orphan", [
      { base: fixture.alphaBase, path: "packages/alpha", theirs: orphan },
    ])
    const headBefore = git(fixture.product, "rev-parse", "HEAD")

    const result = await superMerge({ repo: fixture.product, commit: candidate })

    expect(result).toMatchObject({
      state: "failed",
      partial: false,
      detail: { code: "gitlink-off-main", owner: "the submodule writer" },
    })
    expect(result.detail?.message).toContain("shares no history")
    expect(result.detail?.message).toContain(orphan)
    expect(result.detail?.message).toContain(main)
    expect(result.detail?.evidence).toContain(`merge-base ${main} ${orphan}`)
    expect(retainedPins(fixture.alpha)).toEqual([])
    expect(git(fixture.product, "rev-parse", "HEAD")).toBe(headBefore)
  })

  it("composes several forked components in one merge", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-fork-several-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const alpha = forkComponent(fixture, "alpha", [["a-main.ts", "1\n"]], [["a-change.ts", "1\n"]])
    const beta = forkComponent(fixture, "beta", [["b-main.ts", "1\n"]], [["b-change.ts", "1\n"]])
    const candidate = candidatePinning(fixture, "candidate-fork-several", [alpha, beta])

    const result = await superMerge({ repo: fixture.product, commit: candidate })

    expect(result).toMatchObject({ state: "updated", partial: false })
    for (const fork of [alpha, beta]) {
      const settled = result.gitlinks.find((row) => row.path === fork.path)
      expect(settled, fork.path).toMatchObject({
        state: "merged",
        to: fork.main,
        composition: { base: fork.base, parent: fork.main, pin: fork.theirs },
      })
      expect(git(fixture.product, "ls-tree", "HEAD", "--", fork.path)).toBe(
        `160000 commit ${settled?.from ?? ""}\t${fork.path}`,
      )
    }
    expect(retainedPins(fixture.alpha)).toHaveLength(1)
    expect(retainedPins(fixture.beta)).toHaveLength(1)
  })

  /**
   * THE MIXED CASE (@cto 25389 ruling 3). The root merge conflicts on alpha, which the two-sided path composes;
   * beta is a one-sided fork that only shows up in the plan computed on THAT composed tree. The one-sided call
   * composes onto it, and both compositions are reported.
   */
  it("composes a one-sided fork onto the tree a two-sided composition wrote, reporting both", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-fork-mixed-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const alphaOurs = advanceRepository(fixture.alpha, "a-main.ts", "1\n")
    git(fixture.alpha, "switch", "-q", "-c", "submodule-theirs", fixture.alphaBase)
    const alphaTheirs = advanceRepository(fixture.alpha, "a-change.ts", "1\n")
    git(fixture.alpha, "switch", "-q", "main")
    git(join(fixture.product, "packages/alpha"), "fetch", "-q", "origin")
    const beta = forkComponent(fixture, "beta", [["b-main.ts", "1\n"]], [["b-change.ts", "1\n"]])
    const candidate = candidatePinning(fixture, "candidate-fork-mixed", [
      { base: fixture.alphaBase, path: "packages/alpha", theirs: alphaTheirs },
      beta,
    ])
    // Root main moves alpha to its own main, so alpha conflicts at the root and beta does not.
    git(join(fixture.product, "packages/alpha"), "checkout", "-q", alphaOurs)
    git(fixture.product, "add", "packages/alpha")
    git(fixture.product, "commit", "-q", "-m", "pin alpha main")

    const result = await superMerge({ repo: fixture.product, commit: candidate })

    expect(result).toMatchObject({ state: "updated", partial: false })
    expect(result.gitlinks.find((row) => row.path === "packages/alpha")).toMatchObject({
      state: "merged",
      composition: { parent: alphaOurs, pin: alphaTheirs },
    })
    const betaRow = result.gitlinks.find((row) => row.path === "vendor/beta")
    expect(betaRow).toMatchObject({
      state: "merged",
      composition: { base: beta.base, parent: beta.main, pin: beta.theirs },
    })
    expect(git(fixture.product, "ls-tree", "HEAD", "--", "vendor/beta")).toBe(
      `160000 commit ${betaRow?.from ?? ""}\tvendor/beta`,
    )
    expect(git(fixture.product, "status", "--porcelain=v1")).toBe("")
  })
})

describe("git super merge — the root's child mains are fetched together (25303 f2)", () => {
  /** The descent's own read of one child's main: `fetch --no-tags <source> +refs/heads/<branch>:...`. */
  const isMainFetch = (args: readonly string[]): boolean =>
    args[0] === "fetch" && args[1] === "--no-tags" && args.some((arg) => arg.startsWith("+refs/heads/"))

  it("has both children's main fetches in flight at once, where the walk used to hold one", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-f2-overlap-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const candidate = candidateWithRootChange(fixture, "candidate-overlap")
    const local = createLocalGitProcess()
    let inFlight = 0
    let maxInFlight = 0
    let fetches = 0
    let taggedFetches = 0
    let release: () => void = () => undefined
    const bothStarted = new Promise<void>((resolve) => {
      release = resolve
    })
    const recording: GitProcess = {
      run: async (request) => {
        if (!isMainFetch(request.args)) {
          expect(request.env?.GIT_SUPER_PHASE).toBeUndefined()
          return local.run(request)
        }
        fetches += 1
        if (request.env?.GIT_SUPER_PHASE === "refresh") taggedFetches += 1
        maxInFlight = Math.max(maxInFlight, ++inFlight)
        if (inFlight >= 2) release()
        // A one-at-a-time walk never starts the second fetch, so the wait is bounded.
        await Promise.race([bothStarted, new Promise((resolve) => setTimeout(resolve, 1_000))])
        try {
          return await local.run(request)
        } finally {
          inFlight -= 1
        }
      },
    }

    const result = await superMerge({ repo: fixture.product, commit: candidate, git: recording })

    expect(result).toMatchObject({ state: "updated" })
    expect(fetches).toBe(2)
    expect(taggedFetches).toBe(fetches)
    expect(maxInFlight).toBe(2)
  })

  it("still refuses at the first child in entry order when a later child's fetch fails first", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-f2-order-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const candidate = candidateWithRootChange(fixture, "candidate-order")
    for (const path of ["packages/alpha", "vendor/beta"]) {
      git(fixture.product, "config", `submodule.${path}.branch`, "main")
      const child = join(fixture.product, path)
      const origin = git(child, "config", "--get", "remote.origin.url")
      const repository = path === "packages/alpha" ? fixture.alpha : fixture.beta
      git(child, "config", "--unset-all", `url.${repository}.insteadOf`)
      git(child, "config", `url.${join(fixtureRoot, `missing-${path.replace("/", "-")}`)}.insteadOf`, origin)
    }
    const headBefore = git(fixture.product, "rev-parse", "HEAD")
    const local = createLocalGitProcess()
    const finished: string[] = []
    const recording: GitProcess = {
      run: async (request) => {
        if (!isMainFetch(request.args)) return local.run(request)
        // Alpha comes first in entry order, so it is made to fail LAST in time.
        if (request.repo.endsWith("packages/alpha")) await new Promise((resolve) => setTimeout(resolve, 300))
        const result = await local.run(request)
        finished.push(request.repo.endsWith("packages/alpha") ? "packages/alpha" : "vendor/beta")
        return result
      },
    }

    const result = await superMerge({ repo: fixture.product, commit: candidate, git: recording })

    expect(finished).toEqual(["vendor/beta", "packages/alpha"])
    expect(result).toMatchObject({ state: "failed", detail: { code: "submodule-main-unreadable" } })
    expect(result.detail?.paths).toEqual(["packages/alpha"])
    expect(git(fixture.product, "rev-parse", "HEAD")).toBe(headBefore)
  })
})

/**
 * @failure A merge reads each owned child's main twice, once to plan and once to freeze its push, doubling its SSH logins.
 * @level l1
 * @consumer Yrd's compose, whose rounds GitHub throttles by SSH login (@i/10-yrd/25570)
 */
describe("git super merge — each child main is read from its remote once (25570)", () => {
  /** Any read of a remote's refs: the plan's fetch, the freeze's dry-run fetch, a branch lookup. */
  const isRemoteRead = (args: readonly string[]): boolean =>
    args[0] === "ls-remote" || (args[0] === "fetch" && args.some((arg) => arg.startsWith("+refs/heads/")))

  it("freezes the push from the plan's own reads, one remote read per child", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-25570-once-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const candidate = candidateWithRootChange(fixture, "candidate-once")
    // Declared, as every hh root child is, so the plan's one read per child is its fetch.
    for (const path of ["packages/alpha", "vendor/beta"]) {
      git(fixture.product, "config", `submodule.${path}.branch`, "main")
    }
    const local = createLocalGitProcess()
    const reads: string[] = []
    const recording: GitProcess = {
      run: (request) => {
        if (isRemoteRead(request.args)) reads.push(relative(fixture.product, request.repo))
        return local.run(request)
      },
    }

    const result = await superMerge({ repo: fixture.product, commit: candidate, git: recording })

    expect(result).toMatchObject({ state: "updated" })
    expect(reads.sort()).toEqual(["packages/alpha", "vendor/beta"])
  })
})

/**
 * @failure Submit makes per-component remote network fetches during preflight composition checks,
 *          bursting SSH logins over the host ceiling (@i/14-substrate/25626).
 * @level l1
 * @consumer Yrd submit preflight inspection and offline/no-fetch merges
 */
describe("git super merge — bounded reuse of untouched Equal child mains (25626)", () => {
  const isRemoteRead = (args: readonly string[]): boolean =>
    args[0] === "ls-remote" || (args[0] === "fetch" && args.some((arg) => arg.startsWith("+refs/heads/")))

  /**
   * @failure A cold submit refetches every unchanged Equal child despite its present local tracking ref.
   * @level l1
   * @consumer Yrd submit candidate verification
   */
  it("reads unchanged Equal mains locally without an age bound or a refresh stamp when requested", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-25626-local-main-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const candidate = candidateWithRootChange(fixture, "candidate-local-main")
    const invalid = await superMerge({ repo: fixture.product, commit: candidate, unboundedLocalMain: true })
    expect(invalid).toMatchObject({
      state: "failed",
      detail: { code: "unbounded-local-main-requires-no-fetch" },
    })
    expect(invalid.detail?.evidence).toBe("Pass both options together, or omit --unbounded-local-main.")
    expect(invalid.detail?.next).toBe("Rerun with --no-fetch when local Equal classification is intended.")
    const alpha = join(fixture.product, "packages/alpha")
    const before = git(alpha, "reflog", "show", "-1", "--format=%H%x00%gs", "refs/remotes/origin/main")
    const local = createLocalGitProcess()
    const refreshes: string[] = []
    const recording: GitProcess = {
      run: (request) => {
        if (request.env?.GIT_SUPER_PHASE === "refresh") refreshes.push(relative(fixture.product, request.repo))
        return local.run(request)
      },
    }

    const result = await superMerge({
      repo: fixture.product,
      commit: candidate,
      noFetch: true,
      unboundedLocalMain: true,
      git: recording,
    })

    expect(result).toMatchObject({ state: "updated", partial: false })
    expect(refreshes).toEqual([])
    expect(result.unboundedLocalMains?.map((row) => row.path).sort()).toEqual(["packages/alpha", "vendor/beta"])
    expect(git(alpha, "reflog", "show", "-1", "--format=%H%x00%gs", "refs/remotes/origin/main")).toBe(before)
  })

  /**
   * @failure A copied tracking ref classifies Equal when its commit is absent from the child store.
   * @level l1
   * @consumer Yrd submit candidate verification
   */
  it("refuses a local Equal whose pin commit is absent from the child store", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-25626-local-object-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const candidate = candidateWithRootChange(fixture, "candidate-local-object")
    const alpha = join(fixture.product, "packages/alpha")
    const pin = git(alpha, "rev-parse", "refs/remotes/origin/main")
    const local = createLocalGitProcess()
    const unavailable: GitProcess = {
      run: (request) =>
        request.repo === alpha && request.args.join(" ") === `cat-file -e ${pin}^{commit}`
          ? Promise.resolve({ code: 1, stdout: "", stderr: "fixture: child commit absent" })
          : local.run(request),
    }

    const result = await superMerge({
      repo: fixture.product,
      commit: candidate,
      noFetch: true,
      unboundedLocalMain: true,
      git: unavailable,
    })

    expect(result).toMatchObject({
      state: "failed",
      detail: { code: "submodule-main-unreadable", subject: expect.stringContaining("packages/alpha") },
    })
    expect(result.unboundedLocalMains).toBeUndefined()
  })

  it("refreshes untouched Equal mains once per ten minutes, including unchanged refs with logging disabled", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-25626-nofetch-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const candidate = candidateWithRootChange(fixture, "candidate-nofetch")
    for (const path of ["packages/alpha", "vendor/beta"]) {
      git(fixture.product, "config", `submodule.${path}.branch`, "main")
      git(join(fixture.product, path), "config", "core.logAllRefUpdates", "false")
    }
    const local = createLocalGitProcess()
    const reads: string[] = []
    const recording: GitProcess = {
      run: (request) => {
        if (isRemoteRead(request.args)) reads.push(relative(fixture.product, request.repo))
        return local.run(request)
      },
    }

    const result = await superMerge({ repo: fixture.product, commit: candidate, noFetch: true, git: recording })

    expect(result).toMatchObject({ state: "updated" })
    expect(reads.sort()).toEqual(["packages/alpha", "vendor/beta"])
    reads.length = 0

    const advanced = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 2\n")
    const withinTtl = candidateWithRootChange(fixture, "candidate-within-ttl")
    expect(await superMerge({ repo: fixture.product, commit: withinTtl, noFetch: true, git: recording })).toMatchObject(
      { state: "updated" },
    )
    expect(reads).toEqual([])
    expect(git(fixture.product, "rev-parse", "HEAD:packages/alpha")).toBe(fixture.alphaBase)

    // Fake only the reader's clock: the real Git refresh stamp remains wall time.
    const afterTtl = candidateWithRootChange(fixture, "candidate-after-ttl")
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      vi.setSystemTime(Date.now() + 601_000)
      expect(
        await superMerge({ repo: fixture.product, commit: afterTtl, noFetch: true, git: recording }),
      ).toMatchObject({ state: "updated" })
      expect(reads.sort()).toEqual(["packages/alpha", "vendor/beta"])
      expect(git(fixture.product, "rev-parse", "HEAD:packages/alpha")).toBe(advanced)
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * @failure Cached non-Equal child mains raise stale pins or falsely refuse an already published child.
   * @level l1
   * @consumer Yrd round and submit composition
   * @testonly none
   */
  it.each(["Behind", "Ahead", "Diverged"] as const)(
    "refreshes an untouched cached %s before deciding",
    async (classification) => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-stale-main-"))
      roots.push(fixtureRoot)
      const fixture = createProductFixture(fixtureRoot)
      const sub = join(fixture.product, "packages/alpha")
      let fresh = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 2\n")
      git(sub, "fetch", "-q", "origin")
      if (classification === "Behind") fresh = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 3\n")
      if (classification !== "Behind") {
        git(sub, "checkout", "-q", fresh)
        git(fixture.product, "add", "packages/alpha")
        git(fixture.product, "commit", "-q", "-m", "record already published alpha")
      }
      if (classification === "Ahead") {
        git(sub, "update-ref", "refs/remotes/origin/main", fixture.alphaBase)
      } else if (classification === "Diverged") {
        git(sub, "checkout", "-q", fixture.alphaBase)
        const offMain = advanceRepository(sub, "off-main.txt", "other branch\n")
        git(sub, "update-ref", "refs/remotes/origin/main", offMain)
        git(sub, "checkout", "-q", fresh)
      }
      const candidate = candidateWithRootChange(fixture, `candidate-stale-${classification.toLowerCase()}`)
      const local = createLocalGitProcess()
      const refreshed: string[] = []
      const recording: GitProcess = {
        run: (request) => {
          if (request.env?.GIT_SUPER_PHASE === "refresh") refreshed.push(relative(fixture.product, request.repo))
          return local.run(request)
        },
      }
      const result = await superMerge({
        repo: fixture.product,
        commit: candidate,
        noFetch: true,
        unboundedLocalMain: true,
        git: recording,
      })
      expect(result).toMatchObject({ state: "updated", partial: false })
      expect(refreshed).toContain("packages/alpha")
      expect(git(fixture.product, "rev-parse", "HEAD:packages/alpha")).toBe(fresh)
    },
  )

  /**
   * @failure New borrowed round clones reset or lose freshness and refresh every component again.
   * @level l1
   * @consumer Yrd candidate workspaces sharing a persistent reference
   * @testonly none
   */
  it("shares refresh observations across borrowed worktrees without treating copied refs as fresh", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-shared-refresh-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    for (const path of ["packages/alpha", "vendor/beta"]) {
      git(fixture.product, "config", `submodule.${path}.branch`, "main")
    }
    const warm = candidateWithRootChange(fixture, "warm-owner")
    expect(await superMerge({ repo: fixture.product, commit: warm, noFetch: true })).toMatchObject({ state: "updated" })
    const candidate = candidateWithRootChange(fixture, "borrowed-candidate")
    const head = git(fixture.product, "rev-parse", "HEAD")
    const local = createLocalGitProcess()
    const refreshed: string[] = []
    const recording: GitProcess = {
      run: (request) => {
        if (request.env?.GIT_SUPER_PHASE === "refresh") refreshed.push(request.repo)
        return local.run(request)
      },
    }
    const first = join(fixtureRoot, "round-one")
    expect(
      await superWorktreeAdd({ repo: fixture.product, path: first, commit: head, reference: fixture.product }),
    ).toMatchObject({ state: "updated" })
    const firstResult = await superMerge({ repo: first, commit: candidate, noFetch: true, git: recording })
    expect(firstResult, JSON.stringify(firstResult)).toMatchObject({ state: "updated" })
    expect(refreshed).toEqual([])
    const advanced = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 2\n")
    const second = join(fixtureRoot, "round-two")
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      vi.setSystemTime(Date.now() + 601_000)
      expect(
        await superWorktreeAdd({ repo: fixture.product, path: second, commit: head, reference: fixture.product }),
      ).toMatchObject({ state: "updated" })
      expect(await superMerge({ repo: second, commit: candidate, noFetch: true, git: recording })).toMatchObject({
        state: "updated",
      })
      expect(refreshed.sort()).toEqual(
        [
          git(join(fixture.product, "packages/alpha"), "rev-parse", "--absolute-git-dir"),
          git(join(fixture.product, "vendor/beta"), "rev-parse", "--absolute-git-dir"),
        ].sort(),
      )
      expect(git(second, "rev-parse", "HEAD:packages/alpha")).toBe(advanced)
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * @failure Uncorrelated, unreadable, future, or unwritten refresh evidence silently grants stale reuse.
   * @level l1
   * @consumer Merge callers using bounded component freshness
   * @testonly none
   */
  it.each(["changed OID", "unreadable log", "failed stamp", "future clock"] as const)(
    "expires %s evidence and reports unavailable metadata once",
    async (condition) => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-refresh-evidence-"))
      roots.push(fixtureRoot)
      const fixture = createProductFixture(fixtureRoot)
      for (const path of ["packages/alpha", "vendor/beta"]) {
        git(fixture.product, "config", `submodule.${path}.branch`, "main")
      }
      const sub = join(fixture.product, "packages/alpha")
      const local = createLocalGitProcess()
      const refreshes: string[] = []
      const warnings: string[] = []
      let armed = condition === "failed stamp"
      let injected = 0
      const recording: GitProcess = {
        run: (request) => {
          if (request.env?.GIT_SUPER_PHASE === "refresh") refreshes.push(request.repo)
          if (
            armed &&
            request.repo === sub &&
            request.args[0] === "reflog" &&
            ((condition === "unreadable log" && request.args[1] === "show") ||
              (condition === "failed stamp" && request.args[1] === "write"))
          ) {
            injected++
            return Promise.resolve({ code: 1, stdout: "", stderr: "fixture refresh metadata unavailable" })
          }
          return local.run(request)
        },
      }
      const warm = candidateWithRootChange(fixture, "warm-evidence")
      expect(
        await superMerge({
          repo: fixture.product,
          commit: warm,
          noFetch: true,
          git: recording,
          report: (line) => warnings.push(line),
        }),
      ).toMatchObject({ state: "updated" })
      if (condition === "failed stamp") expect(injected).toBe(1)
      refreshes.length = 0
      warnings.length = 0
      injected = 0
      armed = true
      if (condition === "changed OID") {
        const advanced = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 2\n")
        git(sub, "fetch", "-q", "origin")
        git(sub, "checkout", "-q", advanced)
        git(fixture.product, "add", "packages/alpha")
        git(fixture.product, "commit", "-q", "-m", "record separately observed alpha")
      }
      const candidate = candidateWithRootChange(fixture, "candidate-evidence")
      if (condition === "future clock") {
        vi.useFakeTimers({ toFake: ["Date"] })
        vi.setSystemTime(Date.now() - 2_000)
      }
      try {
        expect(
          await superMerge({
            repo: fixture.product,
            commit: candidate,
            noFetch: true,
            git: recording,
            report: (line) => warnings.push(line),
          }),
        ).toMatchObject({ state: "updated" })
        expect(refreshes.sort()).toEqual(
          (condition === "future clock" ? [sub, join(fixture.product, "vendor/beta")] : [sub]).sort(),
        )
        if (condition === "changed OID") expect(warnings).toEqual([])
        else {
          expect(warnings).toHaveLength(condition === "future clock" ? 2 : 1)
          expect(warnings[0]).toContain("refresh cache in")
          expect(warnings[0]).toContain("treating observation as expired")
        }
        if (condition === "unreadable log" || condition === "failed stamp") expect(injected).toBe(1)
      } finally {
        vi.useRealTimers()
      }
    },
  )

  /**
   * @failure Switching to another origin with the same tracking OID reuses the old repository's observation.
   * @level l1
   * @consumer Merge callers changing a component's declared repository
   * @testonly none
   */
  it("expires an Equal observation when the component origin changes despite an identical cached OID", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-refresh-origin-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    for (const path of ["packages/alpha", "vendor/beta"]) {
      git(fixture.product, "config", `submodule.${path}.branch`, "main")
    }
    const warm = candidateWithRootChange(fixture, "warm-origin")
    expect(await superMerge({ repo: fixture.product, commit: warm, noFetch: true })).toMatchObject({ state: "updated" })
    const replacement = join(fixtureRoot, "replacement")
    git(fixtureRoot, "clone", "-q", fixture.alpha, replacement)
    const advanced = advanceRepository(replacement, "alpha.ts", "export const alpha = 2\n")
    const url = "https://git-super.test/owned/replacement-alpha.git"
    const sub = join(fixture.product, "packages/alpha")
    git(sub, "remote", "set-url", "origin", url)
    git(sub, "config", `url.${replacement}.insteadOf`, url)
    git(fixture.product, "config", "--file", ".gitmodules", "submodule.packages/alpha.url", url)
    git(fixture.product, "config", "submodule.packages/alpha.url", url)
    git(fixture.product, "commit", "-q", "-am", "declare replacement origin")
    const candidate = candidateWithRootChange(fixture, "candidate-origin")
    const result = await superMerge({ repo: fixture.product, commit: candidate, noFetch: true })
    expect(result).toMatchObject({ state: "updated", partial: false })
    expect(git(fixture.product, "rev-parse", "HEAD:packages/alpha")).toBe(advanced)
  })

  it("resolves tracking refs from alternates when child clone has no local tracking ref", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-25626-alternates-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    for (const path of ["packages/alpha", "vendor/beta"]) {
      git(fixture.product, "config", `submodule.${path}.branch`, "main")
    }

    // Delete tracking refs in packages/alpha and vendor/beta
    for (const path of ["packages/alpha", "vendor/beta"]) {
      const sub = join(fixture.product, path)
      const subGitdir = git(sub, "rev-parse", "--git-dir")
      const resolvedGitdir = isAbsolute(subGitdir) ? subGitdir : join(sub, subGitdir)
      // Point submodule alternates to the upstream store where refs/remotes/origin/main exists
      const upstreamStore = fixture[path === "packages/alpha" ? "alpha" : "beta"]
      const url = `https://git-super.test/owned/${path === "packages/alpha" ? "alpha" : "beta"}.git`
      git(upstreamStore, "remote", "add", "origin", url)
      git(upstreamStore, "config", `url.${upstreamStore}.insteadOf`, url)
      git(upstreamStore, "update-ref", "refs/remotes/origin/main", git(upstreamStore, "rev-parse", "refs/heads/main"))
      const altFile = join(resolvedGitdir, "objects", "info", "alternates")
      mkdirSync(dirname(altFile), { recursive: true })
      writeFileSync(altFile, `${join(upstreamStore, ".git", "objects")}\n`)
      git(sub, "update-ref", "-d", "refs/remotes/origin/main")
    }

    // Advance upstreamStore for packages/alpha so it is raised by merge and its alternate store asserted
    const upstreamAlpha = fixture.alpha
    writeFileSync(join(upstreamAlpha, "alpha-new.txt"), "alpha new\n")
    git(upstreamAlpha, "add", "alpha-new.txt")
    git(upstreamAlpha, "commit", "-q", "-m", "advance upstream alpha")
    const newAlphaMain = git(upstreamAlpha, "rev-parse", "HEAD")
    git(upstreamAlpha, "update-ref", "refs/remotes/origin/main", newAlphaMain)

    const candidate = candidateWithRootChange(fixture, "candidate-alt")

    const local = createLocalGitProcess()
    const reads: string[] = []
    const recording: GitProcess = {
      run: (request) => {
        if (isRemoteRead(request.args)) reads.push(relative(fixture.product, request.repo))
        return local.run(request)
      },
    }

    const result = await superMerge({ repo: fixture.product, commit: candidate, noFetch: true, git: recording })

    expect(result).toMatchObject({ state: "updated" })
    expect(reads.sort()).toEqual(["../alpha/.git", "../beta/.git"])
    // Tracking ref was NOT written into the checkout (writing no tracking ref at all)
    for (const path of ["packages/alpha", "vendor/beta"]) {
      const sub = join(fixture.product, path)
      expect(() => git(sub, "rev-parse", "--verify", "refs/remotes/origin/main")).toThrow()
    }
    // Result names the alternate store
    expect(result.gitlinks.length).toBeGreaterThan(0)
    for (const gitlink of result.gitlinks) {
      expect(gitlink.store).toBeDefined()
    }
  })

  it("fails loud with submodule-main-unreadable when alternate holds only refs/heads/main", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-heads-only-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const candidate = candidateWithRootChange(fixture, "candidate-heads-only")
    for (const path of ["packages/alpha", "vendor/beta"]) {
      git(fixture.product, "config", `submodule.${path}.branch`, "main")
    }
    for (const path of ["packages/alpha", "vendor/beta"]) {
      const sub = join(fixture.product, path)
      const subGitdir = git(sub, "rev-parse", "--git-dir")
      const resolvedGitdir = isAbsolute(subGitdir) ? subGitdir : join(sub, subGitdir)
      const upstreamStore = fixture[path === "packages/alpha" ? "alpha" : "beta"]
      const altFile = join(resolvedGitdir, "objects", "info", "alternates")
      mkdirSync(dirname(altFile), { recursive: true })
      writeFileSync(altFile, `${join(upstreamStore, ".git", "objects")}\n`)
      git(sub, "update-ref", "-d", "refs/remotes/origin/main")
    }
    const result = await superMerge({ repo: fixture.product, commit: candidate, noFetch: true })
    expect(result).toMatchObject({ state: "failed", detail: { code: "submodule-main-unreadable" } })
    for (const path of ["packages/alpha", "vendor/beta"]) {
      const sub = join(fixture.product, path)
      expect(() => git(sub, "rev-parse", "--verify", "refs/remotes/origin/main")).toThrow()
    }
  })

  it("prefers superproject alternates over submodule alternates", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-alt-order-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const sub = join(fixture.product, "packages/alpha")

    const commitBase = git(sub, "rev-parse", "HEAD")

    // commitSub (ancestor)
    writeFileSync(join(sub, "sub.txt"), "sub\n")
    git(sub, "add", "sub.txt")
    git(sub, "commit", "-q", "-m", "sub commit")
    const commitSub = git(sub, "rev-parse", "HEAD")

    // commitSuper (middle)
    writeFileSync(join(sub, "super.txt"), "super\n")
    git(sub, "add", "super.txt")
    git(sub, "commit", "-q", "-m", "super commit")
    const commitSuper = git(sub, "rev-parse", "HEAD")

    git(sub, "checkout", "-q", commitBase)
    git(sub, "update-ref", "-d", "refs/remotes/origin/main")

    const subGitdir = git(sub, "rev-parse", "--git-dir")
    const resolvedSubGitdir = isAbsolute(subGitdir) ? subGitdir : join(sub, subGitdir)

    // Set up superproject alternate
    const superStoreRoot = mkdtempSync(join(tmpdir(), "super-store-"))
    roots.push(superStoreRoot)
    mkdirSync(join(superStoreRoot, ".git", "objects"), { recursive: true })
    const superAlt = join(fixture.product, ".git", "objects", "info", "alternates")
    mkdirSync(dirname(superAlt), { recursive: true })
    writeFileSync(superAlt, `${join(superStoreRoot, ".git", "objects")}\n`)

    const superStoreAlpha = join(superStoreRoot, "packages/alpha")
    mkdirSync(superStoreAlpha, { recursive: true })
    git(superStoreAlpha, "init", "-q")
    const altSuperAlpha = join(superStoreAlpha, ".git", "objects", "info", "alternates")
    mkdirSync(dirname(altSuperAlpha), { recursive: true })
    writeFileSync(altSuperAlpha, `${join(resolvedSubGitdir, "objects")}\n`)
    git(superStoreAlpha, "update-ref", "refs/remotes/origin/main", commitSuper)
    git(superStoreAlpha, "remote", "add", "origin", "https://git-super.test/owned/alpha.git")
    git(superStoreAlpha, "config", `url.${sub}.insteadOf`, "https://git-super.test/owned/alpha.git")
    git(sub, "update-ref", "refs/heads/main", commitSuper)

    // Set up submodule alternate
    const storeSub = mkdtempSync(join(tmpdir(), "sub-store-"))
    roots.push(storeSub)
    git(storeSub, "init", "-q")
    const altStoreSub = join(storeSub, ".git", "objects", "info", "alternates")
    mkdirSync(dirname(altStoreSub), { recursive: true })
    writeFileSync(altStoreSub, `${join(resolvedSubGitdir, "objects")}\n`)
    git(storeSub, "update-ref", "refs/remotes/origin/main", commitSub)

    const subAlt = join(resolvedSubGitdir, "objects", "info", "alternates")
    mkdirSync(dirname(subAlt), { recursive: true })
    writeFileSync(subAlt, `${join(storeSub, ".git", "objects")}\n`)

    const candidate = candidateWithRootChange(fixture, "candidate-order")

    for (const path of ["packages/alpha", "vendor/beta"]) {
      git(fixture.product, "config", `submodule.${path}.branch`, "main")
    }

    const result = await superMerge({ repo: fixture.product, commit: candidate, noFetch: true })
    expect(result).toMatchObject({ state: "updated" })
    const alphaLink = result.gitlinks?.find((g) => g.path === "packages/alpha")
    expect(alphaLink?.store).toBe(superStoreAlpha)
    expect(alphaLink?.store).not.toBe(join(storeSub, ".git"))
  })

  it("fails loud when alternates file cannot be read", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-alternates-unreadable-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const candidate = candidateWithRootChange(fixture, "candidate-unreadable-alt")
    for (const path of ["packages/alpha", "vendor/beta"]) {
      git(fixture.product, "config", `submodule.${path}.branch`, "main")
    }

    // Delete tracking ref in packages/alpha so alternates are consulted
    const sub = join(fixture.product, "packages/alpha")
    git(sub, "update-ref", "-d", "refs/remotes/origin/main")

    // Make alternates a directory so readFileSync throws EISDIR
    const subGitdir = git(sub, "rev-parse", "--git-dir")
    const resolvedSubGitdir = isAbsolute(subGitdir) ? subGitdir : join(sub, subGitdir)
    const altFile = join(resolvedSubGitdir, "objects", "info", "alternates")
    mkdirSync(altFile, { recursive: true })

    const result = await superMerge({ repo: fixture.product, commit: candidate, noFetch: true })
    expect(result).toMatchObject({
      state: "failed",
      detail: {
        code: "unexpected-error",
        subject: expect.stringContaining("EISDIR"),
      },
    })
  })

  it("fails loud when tracking ref is missing and cannot be resolved locally", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-25626-missing-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const candidate = candidateWithRootChange(fixture, "candidate-missing")
    // Delete local tracking refs in child clones; branch "main" exists on remote
    for (const path of ["packages/alpha", "vendor/beta"]) {
      const sub = join(fixture.product, path)
      git(sub, "update-ref", "-d", "refs/remotes/origin/main")
    }

    const result = await superMerge({
      repo: fixture.product,
      commit: candidate,
      noFetch: true,
      unboundedLocalMain: true,
    })

    expect(result).toMatchObject({ state: "failed", detail: { code: "submodule-main-unreadable" } })
  })

  it("fetches child main only for submodules whose gitlinks are moved by the candidate (25626 Cure a)", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-25626-moved-fetch-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    for (const path of ["packages/alpha", "vendor/beta"]) {
      git(fixture.product, "config", `submodule.${path}.branch`, "main")
    }
    const warm = candidateWithRootChange(fixture, "warm-moved-test")
    expect(await superMerge({ repo: fixture.product, commit: warm, noFetch: true })).toMatchObject({ state: "updated" })

    // Move packages/alpha gitlink in candidate, but leave vendor/beta unmoved
    const alphaSub = join(fixture.product, "packages/alpha")
    writeFileSync(join(alphaSub, "alpha-change.txt"), "alpha change\n")
    git(alphaSub, "add", "alpha-change.txt")
    git(alphaSub, "commit", "-q", "-m", "advance alpha")

    git(fixture.product, "switch", "-q", "-c", "candidate-moved-alpha")
    git(fixture.product, "add", "packages/alpha")
    git(fixture.product, "commit", "-q", "-m", "candidate: move packages/alpha gitlink")
    const candidate = git(fixture.product, "rev-parse", "HEAD")
    git(fixture.product, "switch", "-q", "main")
    git(alphaSub, "checkout", "-q", "HEAD~1")

    const local = createLocalGitProcess()
    const reads: string[] = []
    const recording: GitProcess = {
      run: (request) => {
        if (isRemoteRead(request.args)) reads.push(relative(fixture.product, request.repo))
        return local.run(request)
      },
    }

    const result = await superMerge({
      repo: fixture.product,
      commit: candidate,
      noFetch: true,
      unboundedLocalMain: true,
      git: recording,
    })

    expect(result).toMatchObject({ state: "updated" })
    // Only packages/alpha was moved, so only packages/alpha was fetched; vendor/beta was bypassed!
    expect(reads).toEqual(["packages/alpha"])
  })

  it("Probe R4: refuses at head with gitlink-compose-refused when candidate moves pin that conflicts with upstream child main under noFetch (25626 P3)", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-25626-probe-r4-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    for (const path of ["packages/alpha", "vendor/beta"]) {
      git(fixture.product, "config", `submodule.${path}.branch`, "main")
    }

    // Upstream alpha moves forward on remote origin (fixture.alpha) with a change to alpha.ts
    const upstreamAlpha = fixture.alpha
    writeFileSync(join(upstreamAlpha, "alpha.ts"), "export const alpha = 'upstream main'\n")
    git(upstreamAlpha, "add", "alpha.ts")
    git(upstreamAlpha, "commit", "-q", "-m", "upstream moves alpha.ts")
    const upstreamMain = git(upstreamAlpha, "rev-parse", "HEAD")
    git(upstreamAlpha, "update-ref", "refs/heads/main", upstreamMain)

    // The child clone in fixture.product has stale refs/remotes/origin/main (still at alphaBase)
    const alphaSub = join(fixture.product, "packages/alpha")
    expect(git(alphaSub, "rev-parse", "refs/remotes/origin/main")).not.toBe(upstreamMain)

    // Candidate branch creates a commit on alpha that conflicts on alpha.ts
    git(alphaSub, "checkout", "-q", "-b", "candidate-feature")
    writeFileSync(join(alphaSub, "alpha.ts"), "export const alpha = 'candidate conflict'\n")
    git(alphaSub, "add", "alpha.ts")
    git(alphaSub, "commit", "-q", "-m", "candidate conflicting change")
    const _candidatePin = git(alphaSub, "rev-parse", "HEAD")

    // Record candidatePin in candidate commit on product
    git(fixture.product, "switch", "-q", "-c", "candidate-r4")
    git(fixture.product, "add", "packages/alpha")
    git(fixture.product, "commit", "-q", "-m", "candidate: move alpha to conflicting pin")
    const candidate = git(fixture.product, "rev-parse", "HEAD")
    git(fixture.product, "switch", "-q", "main")
    git(alphaSub, "checkout", "-q", "main")

    // Under noFetch: true, Cure (a) fetches packages/alpha because its gitlink is moved,
    // sees that candidatePin conflicts with upstream main, and fails with gitlink-compose-refused
    const result = await superMerge({ repo: fixture.product, commit: candidate, noFetch: true })

    expect(result).toMatchObject({
      state: "failed",
      detail: {
        code: "gitlink-compose-refused",
        phase: "preflight-merge",
      },
    })
  })

  it("Probe R4 (nested): fetches nested child main when candidate moves nested gitlink onto a conflict under noFetch (25626 Arm G2)", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-25626-nested-g2-"))
    roots.push(fixtureRoot)
    const fixture = createNestedProductFixture(fixtureRoot)
    for (const path of ["packages/alpha", "vendor/beta"]) {
      git(fixture.product, "config", `submodule.${path}.branch`, "main")
    }
    git(fixture.alpha, "config", "submodule.apps/maddoc.branch", "main")

    // Upstream leaf moves forward on remote origin (fixture.leaf)
    const upstreamLeaf = advanceRepository(fixture.leaf, "leaf.ts", "export const leaf = 'upstream main'\n")

    // Local checkout in fixture.product/packages/alpha/apps/maddoc still has stale tracking ref
    const alphaCheckout = join(fixture.product, "packages/alpha")
    const leafCheckout = join(alphaCheckout, "apps/maddoc")
    expect(git(leafCheckout, "rev-parse", "refs/remotes/origin/main")).not.toBe(upstreamLeaf)

    // Candidate branch moves nested maddoc through Ahead alpha to a conflicting commit
    const moved = advanceNestedThroughAlpha(
      fixture,
      "candidate-nested-conflict",
      "export const leaf = 'candidate conflict'\n",
    )

    // Under noFetch: true, the candidate moved the nested gitlink (changedByMerge: true),
    // so fetchSubmoduleMain at line 2152 fetches the moved leaf's main from origin, detects
    // the off-main / diverged pin, and fails with gitlink-off-main.
    // Under Arm G2 (reverting line 2152 to plain noFetch), it reads stale local tracking ref and fails to refuse.
    const result = await superMerge({ repo: fixture.product, commit: moved.candidate, noFetch: true })

    expect(result).toMatchObject({
      state: "failed",
      detail: {
        code: "gitlink-off-main",
      },
    })
  })
})

/**
 * @failure A root merge's phases run with no timing evidence, so its caller's journal is silent across the whole call.
 * @level l1
 * @consumer Yrd's compose journal rows (@i/10-yrd/25303 tier 2)
 */
describe("git super merge — each phase reports how long it took (25303 tier 2)", () => {
  /**
   * The phases cover the whole call, so their sum is the call's wall time. The
   * slack is timer noise: eight values rounded to whole ms, plus the await
   * between the last phase closing and the caller's clock reading. A phase
   * that goes unnamed opens a gap far larger than this.
   */
  const SUM_SLACK_MS = 25

  async function timedMerge(options: Parameters<typeof superMerge>[0]) {
    const started = performance.now()
    const result = await superMerge(options)
    return { result, wall: performance.now() - started }
  }

  function expectCovers(steps: readonly { name: string; ms: number }[] | undefined, wall: number): void {
    expect(steps).toBeDefined()
    for (const step of steps ?? []) expect(Number.isInteger(step.ms) && step.ms >= 0, JSON.stringify(step)).toBe(true)
    const sum = (steps ?? []).reduce((total, step) => total + step.ms, 0)
    expect(Math.abs(wall - sum), `wall ${wall.toFixed(1)} ms, steps sum ${sum} ms`).toBeLessThanOrEqual(SUM_SLACK_MS)
  }

  it("names all eight phases of a pin-moving merge, in order, summing to the call's wall time", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-steps-raise-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const newestAlpha = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 'stepped'\n")
    const candidate = candidateWithRootChange(fixture, "candidate-steps")
    // The call's first git command (finding the root), its commit, and its last
    // (publishing the receipt) are slowed, so time left outside every step at
    // either edge is far larger than the slack.
    const local = createLocalGitProcess()
    const edges: string[] = []
    let calls = 0
    const slowEdges: GitProcess = {
      run: async (request) => {
        const first = calls++ === 0
        const commit = request.args[0] === "commit"
        const receipt = request.args[0] === "update-ref" && request.args[1]?.startsWith("refs/git-super/receipts/")
        if (first || commit || receipt === true) {
          edges.push(request.args.slice(0, 2).join(" "))
          await new Promise((resolve) => setTimeout(resolve, 150))
        }
        return local.run(request)
      },
    }

    const { result, wall } = await timedMerge({ repo: fixture.product, commit: candidate, git: slowEdges })

    expect(result).toMatchObject({
      state: "updated",
      gitlinks: [expect.objectContaining({ path: "packages/alpha", to: newestAlpha, state: "raised" })],
    })
    expect(edges).toEqual([
      "rev-parse --show-toplevel",
      expect.stringMatching(/^commit /u),
      expect.stringMatching(/^update-ref refs\/git-super\/receipts\//u),
    ])
    expect(result.steps?.map((step) => step.name)).toEqual([...SUPER_MERGE_STEPS])
    // Each slowed command lands on the phase that owns it: finding the root is
    // preflight's first command, and the commit and its receipt are commit's
    // first and last, so a boundary moved past either one loses its 150 ms.
    const ms = (name: string) => result.steps?.find((step) => step.name === name)?.ms ?? 0
    expect(ms("preflight")).toBeGreaterThanOrEqual(150)
    expect(ms("commit")).toBeGreaterThanOrEqual(300)
    expectCovers(result.steps, wall)
  })

  it("puts a slow merge-tree's time on the merge-tree step, not on a neighbour", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-steps-slow-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 'slow'\n")
    const candidate = candidateWithRootChange(fixture, "candidate-steps-slow")
    const local = createLocalGitProcess()
    const slowed: GitProcess = {
      run: async (request) => {
        if (request.args.includes("merge-tree")) await new Promise((resolve) => setTimeout(resolve, 400))
        return local.run(request)
      },
    }

    const { result, wall } = await timedMerge({ repo: fixture.product, commit: candidate, git: slowed })

    expect(result).toMatchObject({ state: "updated" })
    const mergeTree = result.steps?.find((step) => step.name === "merge-tree")
    expect(mergeTree?.ms).toBeGreaterThanOrEqual(400)
    for (const step of result.steps ?? []) {
      if (step.name !== "merge-tree") expect(step.ms, step.name).toBeLessThan(400)
    }
    expectCovers(result.steps, wall)
  })

  it("ends a refused merge on the phase that refused it, in the --json result too", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-merge-steps-refused-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 'competing'\n")
    const alpha = join(fixture.product, "packages/alpha")
    git(fixture.product, "switch", "-q", "-c", "candidate-steps-off-main")
    writeFileSync(join(alpha, "alpha.ts"), "export const alpha = 'unpushed'\n")
    git(alpha, "add", "alpha.ts")
    git(alpha, "commit", "-q", "-m", "advance alpha off main")
    git(fixture.product, "add", "packages/alpha")
    git(fixture.product, "commit", "-q", "-m", "pin unpublished alpha")
    const candidate = git(fixture.product, "rev-parse", "HEAD")
    git(fixture.product, "switch", "-q", "main")
    git(alpha, "switch", "-q", "--detach", fixture.alphaBase)

    const { result, wall } = await timedMerge({ repo: fixture.product, commit: candidate })

    // A one-sided fork that conflicts in alpha.ts: refused while planning, where its composition runs (25389).
    expect(result).toMatchObject({ state: "failed", detail: { code: "gitlink-compose-refused" } })
    expect(result.steps?.map((step) => step.name)).toEqual(["preflight", "merge-tree", "plan"])
    expectCovers(result.steps, wall)

    const stdout = outputSink()
    const stderr = outputSink()
    expect(await runCli(["--repo", fixture.product, "--json", "merge", candidate], stdout, stderr)).toBe(1)
    const printed = JSON.parse(stdout.output) as { steps: readonly { name: string }[] }
    expect(printed.steps.map((step) => step.name)).toEqual(["preflight", "merge-tree", "plan"])
  })
})
