/**
 * @failure A merge records a gitlink commit that submodule main does not contain.
 * @level l1
 * @consumer Yrd settled candidate preparation and landing
 */
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runCli } from "../src/cli.ts"
import { superPush } from "../src/push.ts"
import { decodePushIntent, PUSH_INTENT_TRAILER } from "../src/push-intent.ts"
import { superMerge } from "../src/merge.ts"
import { createLocalGitProcess } from "../src/process.ts"
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

  it("refuses moved off-main pins before changing the checkout", async () => {
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
    expect(refusedStderr.output).toContain("gitlink-off-main")
    expect(refusedStderr.output).toContain("packages/alpha")
    expect(refusedStderr.output).toContain(unpublished)
    expect(refusedStderr.output).toContain(refusedMain)
    expect(refusedStderr.output).toContain("evidence:")
    expect(refusedStderr.output).toContain("next:")
    expect(refusedStderr.output).toContain("owner: the submodule writer")
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
        next: expect.stringContaining("Rebase"),
        owner: "the submodule writer",
      },
    })
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
    const fixture = createProductFixture(fixtureRoot)
    const submodule = join(fixture.product, "packages/alpha")
    const newestAlpha = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 2\n")
    const candidate = candidateWithRootChange(fixture, "candidate-dirty-pre-settled-checkout")
    git(submodule, "fetch", "-q", "origin")
    git(submodule, "checkout", "-q", "--detach", newestAlpha)
    writeFileSync(join(submodule, "alpha.ts"), "export const alpha = 'uncommitted'\n")
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
    expect(git(submodule, "rev-parse", "HEAD")).toBe(newestAlpha)
    expect(git(submodule, "diff", "--", "alpha.ts")).toContain("uncommitted")
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
    const submodule = join(fixture.product, "packages/alpha")
    const betaSubmodule = join(fixture.product, "vendor/beta")
    const newestAlpha = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 2\n")
    const newestBeta = advanceRepository(fixture.beta, "beta.ts", "export const beta = 2\n")
    const candidate = candidateWithRootChange(fixture, "candidate-commit-rollback")
    git(submodule, "fetch", "-q", "origin")
    git(submodule, "checkout", "-q", "--detach", newestAlpha)
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
    expect(git(submodule, "rev-parse", "HEAD")).toBe(fixture.alphaBase)
    expect(git(betaSubmodule, "rev-parse", "HEAD")).toBe(fixture.betaBase)
    expect(git(fixture.product, "rev-parse", "HEAD")).toBe(headBefore)
    expect(git(fixture.product, "rev-parse", "MERGE_HEAD")).toBe(candidate)
    expect(git(fixture.product, "ls-files", "--stage", "--", "packages/alpha")).toContain(newestAlpha)
    expect(git(fixture.product, "ls-files", "--stage", "--", "vendor/beta")).toContain(newestBeta)
  })

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
      expect(result).toMatchObject({ state: "failed", partial: false, detail: { code: "merge-conflict" } })
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
    git(submodule, "remote", "set-url", "origin", join(fixtureRoot, "missing-alpha-origin"))
    const headBefore = git(fixture.product, "rev-parse", "HEAD")
    const stdout = outputSink()
    const stderr = outputSink()

    expect(await runCli(["--repo", fixture.product, "merge", candidate], stdout, stderr)).toBe(1)
    expect(stdout.output).toBe("")
    expect(stderr.output).toContain("submodule-main-unreadable")
    expect(stderr.output).toContain("packages/alpha")
    expect(stderr.output).toContain("fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main")
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
    // is neither behind it nor ahead of it. This is D1, one level down.
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
