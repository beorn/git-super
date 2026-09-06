/**
 * @failure An exact root commit cannot bind its direct components to durable,
 *          checkout-free stores, or a repeated preparation changes that binding.
 * @level l4 — real Git common-dir module stores and ordinary submodule materialization.
 * @consumer Yrd captured component readers
 * retire-when: the component-store command is subsumed by a broader Git Super persistent-store lifecycle suite.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "vitest"
import { runCli } from "../src/cli.ts"
import { createLocalGitProcess, type GitProcess, type GitProcessResult } from "../src/process.ts"
import { superSubmodulePrepare } from "../src/submodule-prepare.ts"
import { createProductFixture, git } from "./fixture.ts"

const roots: string[] = []

type AbnormalProcessResult = Readonly<{ label: string; result: GitProcessResult; code: string }>

const abnormalProcessResults: readonly AbnormalProcessResult[] = [
  {
    label: "timed out",
    result: { code: 0, stdout: "commit\n", stderr: "injected timeout", timedOut: true },
    code: "git-timeout",
  },
  {
    label: "ended outside the supervised process contract",
    result: { code: 0, stdout: "commit\n", stderr: "", failure: "injected supervisor failure" },
    code: "git-failed",
  },
]

function resultCause(result: GitProcessResult): string {
  return result.failure ?? result.stderr
}

function abnormalResult(result: GitProcessResult, abnormal: GitProcessResult): GitProcessResult {
  return {
    ...result,
    stderr: abnormal.stderr,
    ...(abnormal.timedOut === true ? { timedOut: true } : {}),
    ...(abnormal.failure === undefined ? {} : { failure: abnormal.failure }),
  }
}

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

test("prepares frozen direct components into durable stores and reuses them through JSON", async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-prepare-"))
  roots.push(fixtureRoot)
  const fixture = createProductFixture(fixtureRoot)
  git(fixture.product, "remote", "add", "origin", fixture.product)
  const common = git(fixture.product, "rev-parse", "--path-format=absolute", "--git-common-dir")
  const alphaStore = join(common, "modules", "packages", "alpha")
  const betaStore = join(common, "modules", "vendor", "beta")
  rmSync(join(fixture.product, "packages", "alpha"), { recursive: true, force: true })
  rmSync(join(fixture.product, "vendor", "beta"), { recursive: true, force: true })
  rmSync(alphaStore, { recursive: true, force: true })
  rmSync(betaStore, { recursive: true, force: true })
  const rootHead = git(fixture.product, "rev-parse", "HEAD")
  const rootIndex = git(fixture.product, "diff", "--cached", "--raw")
  const rootRefs = git(fixture.product, "for-each-ref", "--format=%(refname) %(objectname)")

  const firstOut = outputSink()
  const firstErr = outputSink()
  expect(
    await runCli(
      ["--repo", fixture.product, "submodule", "prepare", fixture.productBase, "--remote", "origin", "--json"],
      firstOut,
      firstErr,
    ),
    firstErr.output,
  ).toBe(0)
  expect(firstErr.output).toBe("")
  const first = JSON.parse(firstOut.output) as {
    state: string
    partial: boolean
    components: Array<{ name: string; path: string; gitlink: string; url: string; gitdir: string }>
  }
  expect(first).toMatchObject({
    state: "updated",
    partial: false,
    components: [
      {
        name: "packages/alpha",
        path: "packages/alpha",
        gitlink: fixture.alphaBase,
        url: fixture.alpha,
        gitdir: alphaStore,
      },
      { name: "vendor/beta", path: "vendor/beta", gitlink: fixture.betaBase, url: fixture.beta, gitdir: betaStore },
    ],
  })
  for (const component of first.components) {
    expect(existsSync(component.gitdir)).toBe(true)
    expect(git(component.gitdir, "config", "--get", "core.bare")).toBe("false")
    expect(git(component.gitdir, "for-each-ref", "--format=%(refname) %(objectname)")).toBe("")
    expect(existsSync(join(component.gitdir, "FETCH_HEAD"))).toBe(false)
  }
  expect(existsSync(join(fixture.product, "packages", "alpha", ".git"))).toBe(false)
  expect(existsSync(join(fixture.product, "vendor", "beta", ".git"))).toBe(false)
  expect(git(fixture.product, "rev-parse", "HEAD")).toBe(rootHead)
  expect(git(fixture.product, "diff", "--cached", "--raw")).toBe(rootIndex)
  expect(git(fixture.product, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(rootRefs)

  // The command must read the frozen blob and preserve a warm store's origin;
  // neither a dirty checkout manifest nor a mutable local origin selects Yrd's URL.
  const manifest = join(fixture.product, ".gitmodules")
  const originalManifest = readFileSync(manifest, "utf8")
  writeFileSync(manifest, "broken working tree metadata\n")
  git(betaStore, "remote", "set-url", "origin", fixture.alpha)

  const warmOut = outputSink()
  const warmErr = outputSink()
  expect(
    await runCli(
      ["--repo", fixture.product, "submodule", "prepare", fixture.productBase, "--remote", "origin", "--json"],
      warmOut,
      warmErr,
    ),
  ).toBe(0)
  expect(warmErr.output).toBe("")
  expect(JSON.parse(warmOut.output)).toMatchObject({
    state: "unchanged",
    partial: false,
    components: first.components,
  })
  expect(git(betaStore, "remote", "get-url", "origin")).toBe(fixture.alpha)
  writeFileSync(manifest, originalManifest)
  git(betaStore, "remote", "set-url", "origin", fixture.beta)

  // This is deliberately source-only: the observer may later fetch one exact
  // OID without creating a tracking ref or FETCH_HEAD before normal checkout.
  for (const component of first.components) {
    git(
      component.gitdir,
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-recurse-submodules",
      "--no-write-fetch-head",
      "--refmap=",
      component.url,
      component.gitlink,
    )
    expect(git(component.gitdir, "for-each-ref", "--format=%(refname) %(objectname)")).toBe("")
    expect(existsSync(join(component.gitdir, "FETCH_HEAD"))).toBe(false)
  }
  git(
    fixture.product,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "update",
    "--init",
    "packages/alpha",
    "vendor/beta",
  )
  expect(git(join(fixture.product, "packages", "alpha"), "rev-parse", "HEAD")).toBe(fixture.alphaBase)
  expect(git(join(fixture.product, "vendor", "beta"), "rev-parse", "HEAD")).toBe(fixture.betaBase)
})

test("serializes concurrent cold preparation through the shared common-dir lock", async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-prepare-concurrent-"))
  roots.push(fixtureRoot)
  const fixture = createProductFixture(fixtureRoot)
  git(fixture.product, "remote", "add", "origin", fixture.product)
  const common = git(fixture.product, "rev-parse", "--path-format=absolute", "--git-common-dir")
  for (const path of ["packages/alpha", "vendor/beta"]) {
    rmSync(join(fixture.product, path), { recursive: true, force: true })
    rmSync(join(common, "modules", path), { recursive: true, force: true })
  }
  const oneOut = outputSink()
  const oneErr = outputSink()
  const twoOut = outputSink()
  const twoErr = outputSink()

  const exits = await Promise.all([
    runCli(
      ["--repo", fixture.product, "submodule", "prepare", fixture.productBase, "--remote", "origin", "--json"],
      oneOut,
      oneErr,
    ),
    runCli(
      ["--repo", fixture.product, "submodule", "prepare", fixture.productBase, "--remote", "origin", "--json"],
      twoOut,
      twoErr,
    ),
  ])

  expect(exits).toEqual([0, 0])
  expect([JSON.parse(oneOut.output).state, JSON.parse(twoOut.output).state].sort()).toEqual(["unchanged", "updated"])
  expect(JSON.parse(oneOut.output).components).toEqual(JSON.parse(twoOut.output).components)
  expect(oneErr.output + twoErr.output).toBe("")
})

test("uses the primary common directory for a linked root", async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-prepare-linked-"))
  roots.push(fixtureRoot)
  const fixture = createProductFixture(fixtureRoot)
  const linked = join(fixtureRoot, "linked")
  git(fixture.product, "remote", "add", "origin", fixture.product)
  git(fixture.product, "worktree", "add", "--detach", linked, fixture.productBase)
  try {
    const common = git(fixture.product, "rev-parse", "--path-format=absolute", "--git-common-dir")
    for (const path of ["packages/alpha", "vendor/beta"])
      {rmSync(join(common, "modules", path), { recursive: true, force: true })}
    const output = outputSink()
    const errors = outputSink()

    expect(
      await runCli(
        ["--repo", linked, "submodule", "prepare", fixture.productBase, "--remote", "origin", "--json"],
        output,
        errors,
      ),
    ).toBe(0)
    expect(errors.output).toBe("")
    expect(JSON.parse(output.output).components.map((component: { gitdir: string }) => component.gitdir)).toEqual([
      join(common, "modules", "packages", "alpha"),
      join(common, "modules", "vendor", "beta"),
    ])
  } finally {
    git(fixture.product, "worktree", "remove", "--force", linked)
  }
})

test("accounts for a store written before its initialization fails", async () => {
  // A failed config step follows `git init --bare`: existing aggregate result
  // accounting must disclose that durable local mutation rather than report a
  // wholly clean failure. The normal CLI journey only covers fully prepared
  // stores, so it cannot expose this partial-write boundary.
  const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-prepare-partial-write-"))
  roots.push(fixtureRoot)
  const fixture = createProductFixture(fixtureRoot)
  git(fixture.product, "remote", "add", "origin", fixture.product)
  const common = git(fixture.product, "rev-parse", "--path-format=absolute", "--git-common-dir")
  const alphaStore = join(common, "modules", "packages", "alpha")
  rmSync(alphaStore, { recursive: true, force: true })

  const local = createLocalGitProcess()
  let rejected = false
  const failing: GitProcess = {
    async run(request) {
      if (!rejected && request.repo === alphaStore && request.args[0] === "config" && request.args[1] === "core.bare") {
        rejected = true
        return { code: 1, stdout: "", stderr: "injected core.bare refusal" }
      }
      return local.run(request)
    },
  }

  const prepared = await superSubmodulePrepare({
    repo: fixture.product,
    commit: fixture.productBase,
    remote: "origin",
    git: failing,
  })

  expect(rejected).toBe(true)
  expect(prepared).toMatchObject({
    state: "failed",
    partial: true,
    detail: { code: "git-failed", phase: "initialize-component-store" },
  })
  expect(prepared.repositories).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ repository: alphaStore, state: "updated" }),
      expect.objectContaining({ repository: fixture.product, state: "failed" }),
    ]),
  )
  expect(existsSync(alphaStore)).toBe(true)
})

test.each(abnormalProcessResults)(
  "refuses a root commit check that $label",
  async ({ result: failedResult, code: expectedCode }) => {
    // A zero exit code is not authority if the runner reports a timeout or
    // supervision failure. Existing real-Git coverage cannot construct that
    // runner result, and accepting it would let preparation mutate stores.
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-prepare-process-failure-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    git(fixture.product, "remote", "add", "origin", fixture.product)
    const common = git(fixture.product, "rev-parse", "--path-format=absolute", "--git-common-dir")
    const alphaStore = join(common, "modules", "packages", "alpha")
    rmSync(alphaStore, { recursive: true, force: true })
    const local = createLocalGitProcess()
    const failing: GitProcess = {
      async run(request) {
        if (request.args[0] === "cat-file" && request.args[1] === "-t") return failedResult
        return local.run(request)
      },
    }

    const prepared = await superSubmodulePrepare({
      repo: fixture.product,
      commit: fixture.productBase,
      remote: "origin",
      git: failing,
    })

    expect(prepared).toMatchObject({
      state: "failed",
      partial: false,
      detail: { code: expectedCode, phase: "validate-root-commit" },
    })
    expect(prepared.detail?.message).toContain(resultCause(failedResult))
    expect(existsSync(alphaStore)).toBe(false)
  },
)

test.each([
  ["target tree", "read-target-tree", (args: readonly string[]) => args[0] === "ls-tree" && args.includes("-r")],
  [
    "target manifest",
    "read-target-manifest",
    (args: readonly string[]) => args[0] === "ls-tree" && args.includes(".gitmodules"),
  ],
  [
    "target submodule configuration",
    "read-target-submodules",
    (args: readonly string[]) => args[0] === "config" && args.includes("--blob"),
  ],
] as const)("refuses abnormal process results while reading the $0", async (_name, phase, matches) => {
  for (const { result: failedResult, code: expectedCode } of abnormalProcessResults) {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-prepare-graph-process-failure-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    git(fixture.product, "remote", "add", "origin", fixture.product)
    const local = createLocalGitProcess()
    const failing: GitProcess = {
      async run(request) {
        const observed = await local.run(request)
        return matches(request.args) ? abnormalResult(observed, failedResult) : observed
      },
    }

    const prepared = await superSubmodulePrepare({
      repo: fixture.product,
      commit: fixture.productBase,
      remote: "origin",
      git: failing,
    })

    expect(prepared).toMatchObject({
      state: "failed",
      partial: false,
      detail: { code: expectedCode, phase },
    })
    expect(prepared.detail?.message).toContain(resultCause(failedResult))
  }
})

test("accounts for a store that a failed initialization already created", async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-prepare-init-partial-write-"))
  roots.push(fixtureRoot)
  const fixture = createProductFixture(fixtureRoot)
  git(fixture.product, "remote", "add", "origin", fixture.product)
  const common = git(fixture.product, "rev-parse", "--path-format=absolute", "--git-common-dir")
  const alphaStore = join(common, "modules", "packages", "alpha")
  rmSync(alphaStore, { recursive: true, force: true })
  const local = createLocalGitProcess()
  let rejected = false
  const failing: GitProcess = {
    async run(request) {
      if (!rejected && request.args[0] === "init" && request.args[1] === "--bare") {
        rejected = true
        mkdirSync(request.args[2] ?? "")
        return { code: 1, stdout: "", stderr: "injected initialization refusal" }
      }
      return local.run(request)
    },
  }

  const prepared = await superSubmodulePrepare({
    repo: fixture.product,
    commit: fixture.productBase,
    remote: "origin",
    git: failing,
  })

  expect(rejected).toBe(true)
  expect(prepared).toMatchObject({
    state: "failed",
    partial: true,
    detail: { code: "git-failed", phase: "initialize-component-store" },
  })
  expect(prepared.repositories).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ repository: alphaStore, state: "updated" }),
      expect.objectContaining({ repository: fixture.product, state: "failed" }),
    ]),
  )
  expect(existsSync(alphaStore)).toBe(true)
})

test.each(abnormalProcessResults)(
  "refuses an origin validation result that $label",
  async ({ result, code: expectedCode }) => {
    const failedResult = { ...result, stdout: "preserved-origin\n" }
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-prepare-origin-process-failure-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    git(fixture.product, "remote", "add", "origin", fixture.product)
    const common = git(fixture.product, "rev-parse", "--path-format=absolute", "--git-common-dir")
    const alphaStore = join(common, "modules", "packages", "alpha")
    rmSync(alphaStore, { recursive: true, force: true })
    const local = createLocalGitProcess()
    const failing: GitProcess = {
      async run(request) {
        if (request.repo === alphaStore && request.args[0] === "remote" && request.args[1] === "get-url") {
          return failedResult
        }
        return local.run(request)
      },
    }

    const prepared = await superSubmodulePrepare({
      repo: fixture.product,
      commit: fixture.productBase,
      remote: "origin",
      git: failing,
    })

    expect(prepared).toMatchObject({
      state: "failed",
      partial: true,
      detail: { code: expectedCode, phase: "validate-component-store" },
    })
    expect(prepared.detail?.message).toContain(resultCause(failedResult))
  },
)

test("uses an explicit root URL without consulting root configuration or a network verb", async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-prepare-explicit-url-"))
  roots.push(fixtureRoot)
  const fixture = createProductFixture(fixtureRoot)
  const common = git(fixture.product, "rev-parse", "--path-format=absolute", "--git-common-dir")
  for (const path of ["packages/alpha", "vendor/beta"])
    {rmSync(join(common, "modules", path), { recursive: true, force: true })}
  const calls: Array<Readonly<{ repo: string; args: readonly string[]; env?: NodeJS.ProcessEnv }>> = []
  const local = createLocalGitProcess()
  const tracing: GitProcess = {
    async run(request) {
      calls.push({
        repo: request.repo,
        args: request.args,
        ...(request.env === undefined ? {} : { env: request.env }),
      })
      return local.run(request)
    },
  }

  const prepared = await superSubmodulePrepare({
    repo: fixture.product,
    commit: fixture.productBase,
    remote: fixture.product,
    git: tracing,
  })

  expect(prepared).toMatchObject({ state: "updated", partial: false })
  expect(
    calls.some(({ repo, args }) => repo === fixture.product && args[0] === "remote" && args[1] === "get-url"),
  ).toBe(false)
  expect(calls.some(({ args }) => ["fetch", "clone", "checkout"].includes(args[0] ?? ""))).toBe(false)
  const frozenReads = calls.filter(
    ({ args }) => args[0] === "cat-file" || args[0] === "ls-tree" || (args[0] === "config" && args.includes("--blob")),
  )
  expect(frozenReads.length).toBeGreaterThan(0)
  expect(frozenReads.every(({ env }) => env?.GIT_NO_LAZY_FETCH === "1")).toBe(true)
})

test("refuses partial and symlinked stores instead of reinitializing them", async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-prepare-invalid-"))
  roots.push(fixtureRoot)
  const fixture = createProductFixture(fixtureRoot)
  git(fixture.product, "remote", "add", "origin", fixture.product)
  const common = git(fixture.product, "rev-parse", "--path-format=absolute", "--git-common-dir")
  const alphaStore = join(common, "modules", "packages", "alpha")
  rmSync(alphaStore, { recursive: true, force: true })
  mkdirSync(alphaStore, { recursive: true })
  writeFileSync(join(alphaStore, "partial"), "do not reinitialize\n")
  const partialOut = outputSink()
  const partialErr = outputSink()

  expect(
    await runCli(
      ["--repo", fixture.product, "submodule", "prepare", fixture.productBase, "--remote", "origin", "--json"],
      partialOut,
      partialErr,
    ),
  ).toBe(2)
  expect(JSON.parse(partialOut.output)).toMatchObject({
    state: "failed",
    partial: false,
    detail: { code: "invalid-component-store", phase: "validate-component-store" },
  })
  expect(existsSync(join(alphaStore, "partial"))).toBe(true)

  rmSync(alphaStore, { recursive: true, force: true })
  rmSync(join(common, "modules", "packages"), { recursive: true, force: true })
  const outside = join(fixtureRoot, "outside")
  mkdirSync(outside)
  symlinkSync(outside, join(common, "modules", "packages"))
  const symlinkOut = outputSink()
  const symlinkErr = outputSink()
  expect(
    await runCli(
      ["--repo", fixture.product, "submodule", "prepare", fixture.productBase, "--remote", "origin", "--json"],
      symlinkOut,
      symlinkErr,
    ),
  ).toBe(2)
  expect(JSON.parse(symlinkOut.output)).toMatchObject({
    state: "failed",
    partial: false,
    detail: { code: "unsafe-submodule-store", phase: "validate-store-path" },
  })
  expect(existsSync(join(outside, "alpha"))).toBe(false)

  // A linked git-dir can point its common directory at the root repository.
  // Its local git-dir, core.bare, and origin all appear valid unless prepare
  // explicitly proves the store owns its own refs and objects.
  rmSync(join(common, "modules", "packages"), { recursive: true, force: true })
  mkdirSync(join(common, "modules", "packages"), { recursive: true })
  git(fixture.product, "init", "--bare", alphaStore)
  git(alphaStore, "config", "core.bare", "false")
  writeFileSync(join(alphaStore, "commondir"), `${common}\n`)
  expect(git(alphaStore, "rev-parse", "--path-format=absolute", "--git-dir")).toBe(alphaStore)
  expect(git(alphaStore, "rev-parse", "--path-format=absolute", "--git-common-dir")).toBe(common)
  expect(git(alphaStore, "config", "--get", "core.bare")).toBe("false")
  expect(git(alphaStore, "remote", "get-url", "origin")).toBe(fixture.product)

  const linkedOut = outputSink()
  const linkedErr = outputSink()
  expect(
    await runCli(
      ["--repo", fixture.product, "submodule", "prepare", fixture.productBase, "--remote", "origin", "--json"],
      linkedOut,
      linkedErr,
    ),
  ).toBe(2)
  expect(JSON.parse(linkedOut.output)).toMatchObject({
    state: "failed",
    partial: false,
    detail: { code: "invalid-component-store", phase: "validate-component-store" },
  })
})
