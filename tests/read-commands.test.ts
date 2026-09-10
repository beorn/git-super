import { afterEach, describe, expect, test } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { flattenCommandNodes, resolveInvocation } from "@silvery/command"
import { commands } from "../src/commands.ts"
import { runCli } from "../src/cli.ts"
import { superIsAncestor } from "../src/merge-base.ts"
import { superStatus } from "../src/status.ts"
import {
  addNestedAlphaSubmodule,
  advanceRepository,
  bumpProductSubmodules,
  canonicalTmpdir,
  createRepository,
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
  // Gate A: existing extension calls use --repo/--json and formatted results.
  // Native callers need unchanged syntax even for names already registered here.
  test("plain repository calls, including registered names, match native Git bytes", async () => {
    const root = mkdtempSync(join(canonicalTmpdir(), "git-super-native-collisions-"))
    roots.push(root)
    createRepository(root, "README.md", "one\n")
    writeFileSync(join(root, "--json"), "one\n")
    git(root, "add", "--", "--json")
    git(root, "commit", "-q", "-m", "add option-shaped filename")
    writeFileSync(join(root, "--json"), "two\n")
    for (const args of [
      ["rev-parse", "HEAD"],
      ["merge-base", "HEAD", "HEAD"],
      ["status", "--porcelain=v1", "-z"],
      ["diff", "--", "--json"],
      ["push", "--quiet", "missing-remote", "HEAD"],
    ]) {
      const argv = ["-C", root, "-c", "color.ui=false", ...args]
      const expected = Bun.spawnSync(["git", ...argv], { stdout: "pipe", stderr: "pipe" })
      const stdout = outputSink()
      const stderr = outputSink()
      expect(await runCli(argv, stdout, stderr), args.join(" ")).toBe(expected.exitCode)
      expect(stdout.output).toBe(expected.stdout.toString())
      expect(stderr.output).toBe(expected.stderr.toString())
    }
  })

  // Gate A: no indexed gitlink does not establish that a push's source is plain.
  // The frozen Yrd conformance cases contain no such source/context mismatch.
  test.each(["worktree", "bare", "unborn"])(
    "refuses a gitlink-bearing push argument from a plain %s context before any push",
    async (kind) => {
      const root = mkdtempSync(join(canonicalTmpdir(), "git-super-argument-topology-"))
      roots.push(root)
      const fixture = createProductFixture(root)
      const empty = Bun.spawnSync(["git", "-C", fixture.product, "mktree"], {
        stdin: Buffer.alloc(0),
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(empty.exitCode).toBe(0)
      const plain = git(fixture.product, "commit-tree", empty.stdout.toString().trim(), "-m", "plain")
      git(fixture.product, "branch", "plain", plain)
      const query = join(root, "query")
      git(root, "clone", "-q", kind === "bare" ? "--bare" : "--no-checkout", fixture.product, query)
      if (kind === "worktree") git(query, "checkout", "-q", "plain")
      else git(query, "symbolic-ref", "HEAD", kind === "bare" ? "refs/heads/plain" : "refs/heads/unborn")
      const destination = join(root, "destination.git")
      git(root, "init", "-q", "--bare", destination)
      const argument = `${fixture.productBase}:refs/heads/main`
      const stdout = outputSink()
      const stderr = outputSink()

      expect(await runCli(["-C", query, "push", destination, argument], stdout, stderr)).not.toBe(0)
      expect(stderr.output).toContain(argument)
      expect(stderr.output).toContain("gitlinks")
      expect(stderr.output).toContain(`--repo ${query}`)
      expect(git(destination, "for-each-ref", "--format=%(refname)")).toBe("")
    },
  )

  test.each(["-h", "--help"])("advertises every registered command in %s help on stdout", async (flag) => {
    // A Usage-only assertion misses commands that still run but disappear
    // from help. Derive expected entries from the owning command tree.
    for (const { path } of flattenCommandNodes(commands)) {
      for (const [depth, name] of path.entries()) {
        const stdout = outputSink()
        const stderr = outputSink()

        expect(await runCli([...path.slice(0, depth), flag], stdout, stderr)).toBe(0)
        if (depth === 0) expect(stdout.output).toContain("Usage: git super [options] [command]")
        expect(stdout.output).toContain("\nCommands:\n")
        const commandSection = stdout.output.split("\nCommands:\n")[1]!
        const advertised = [...commandSection.matchAll(/^  (\S+)/gm)].map((match) => match[1])
        expect(advertised, `${path.slice(0, depth).join(" ")} ${flag}`).toContain(name)
        expect(stderr.output).toBe("")
      }
    }
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

  test("merge-base resolves a ref-name ancestor in the --repo root, never by asking each nested store for the name", () => {
    // Every fixture repository is `init -b main`, so the NAME main exists in the
    // product and in both submodules. Before the fix the resolver asked each
    // nested store `cat-file -e main` and found it everywhere: "ambiguous across
    // ., packages/alpha, vendor/beta" - the refusal that left km's equality half
    // unmeasured on every nightly post-land audit (24411). A name is a question
    // for the root; the oid it names is what ownership is decided on.
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-name-ancestor-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    const productHead = bumpProductSubmodules(fixture)

    const result = superIsAncestor({ repo: fixture.product, ancestor: "main", descendant: productHead })

    expect(result.owningRepository).toBe(".")
    expect(result.comparedTo).toBe(productHead)
    expect(result.isAncestor).toBe(true)
  })

  test("merge-base refuses a ref-name ancestor that resolves only in a nested store, naming the root it looked in", async () => {
    // The name exists - but only inside packages/alpha. The old path would have
    // found it there and answered; the rule is that a name resolves in the --repo
    // root or the call is refused with its own exit 2, never a fall-through.
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-nested-only-name-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)
    git(join(fixture.product, "packages/alpha"), "branch", "alpha-only")

    const stdout = outputSink()
    const stderr = outputSink()
    const code = await runCli(
      ["--repo", fixture.product, "merge-base", "--is-ancestor", "alpha-only", fixture.productBase],
      stdout,
      stderr,
    )

    expect(code).toBe(2)
    expect(stderr.output).toContain("ancestor 'alpha-only' is a name, and it does not resolve to a commit in")
    expect(stderr.output).toContain(fixture.product)
    expect(stderr.output).not.toContain("ambiguous")
  })

  test("the implicit front door refuses a gitlink-carrying argument with exit 2, never merge-base's 1, and still names the --repo form", async () => {
    // The km shape: an argument whose tree carries gitlinks. The refusal is
    // right; its exit code was 1, which merge-base callers read as a measured
    // "not an ancestor" - the post-land audit reported km's settled pin
    // unreachable on that code (24411). A refusal to measure is 2, and the
    // breadcrumb naming the explicit interface must survive the change.
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-front-door-refusal-"))
    roots.push(fixtureRoot)
    const fixture = createProductFixture(fixtureRoot)

    const stdout = outputSink()
    const stderr = outputSink()
    const code = await runCli(
      ["-C", fixture.product, "merge-base", "--is-ancestor", fixture.productBase, "HEAD"],
      stdout,
      stderr,
    )

    expect(code).not.toBe(1)
    expect(code).toBe(2)
    expect(stderr.output).toContain("carries gitlinks")
    expect(stderr.output).toContain(`--repo ${fixture.product}`)
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

  test("requires an exact commit and explicit remote for JSON submodule preparation", async () => {
    // The prepare command has no HEAD or stored-origin fallback. Existing CLI
    // coverage exercises read output but not this persistent-store boundary.
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-prepare-cli-"))
    roots.push(fixtureRoot)
    const repository = join(fixtureRoot, "plain-root")
    const commit = createRepository(repository, "root.ts", "export const root = true\n")
    git(repository, "remote", "add", "origin", repository)

    const missingRemoteOut = outputSink()
    const missingRemoteErr = outputSink()
    expect(
      await runCli(
        ["--repo", repository, "submodule", "prepare", commit, "--json"],
        missingRemoteOut,
        missingRemoteErr,
      ),
    ).toBe(1)
    expect(missingRemoteOut.output).toBe("")
    expect(missingRemoteErr.output).toContain("required option '--remote <name-or-url>' not specified")

    const missingCommitOut = outputSink()
    const missingCommitErr = outputSink()
    expect(
      await runCli(
        ["--repo", repository, "submodule", "prepare", "--remote", "origin", "--json"],
        missingCommitOut,
        missingCommitErr,
      ),
    ).toBe(1)
    expect(missingCommitOut.output).toBe("")
    expect(missingCommitErr.output).toContain("missing required argument 'commit'")

    const output = outputSink()
    const errors = outputSink()
    expect(
      await runCli(
        ["--repo", repository, "submodule", "prepare", commit, "--remote", "origin", "--json"],
        output,
        errors,
      ),
    ).toBe(0)
    expect(errors.output).toBe("")
    expect(JSON.parse(output.output)).toMatchObject({ state: "unchanged", partial: false, submodules: [] })
  })

  test.each([
    ["tree", "HEAD^{tree}"],
    ["blob", "HEAD:root.ts"],
  ])("refuses a %s object instead of treating it as an empty frozen root", async (_kind, expression) => {
    // An object ID alone is not authority to prepare an empty graph: `ls-tree`
    // accepts trees. Existing valid-empty coverage therefore missed this
    // non-commit success path.
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-prepare-noncommit-"))
    roots.push(fixtureRoot)
    const repository = join(fixtureRoot, "plain-root")
    createRepository(repository, "root.ts", "export const root = true\n")
    git(repository, "remote", "add", "origin", repository)
    const object = git(repository, "rev-parse", expression)
    const output = outputSink()
    const errors = outputSink()

    expect(
      await runCli(
        ["--repo", repository, "submodule", "prepare", object, "--remote", "origin", "--json"],
        output,
        errors,
      ),
    ).toBe(2)
    expect(errors.output).toBe("")
    expect(JSON.parse(output.output)).toMatchObject({
      state: "failed",
      partial: false,
      detail: { code: "invalid-root-commit", phase: "validate-root-commit" },
      submodules: [],
    })
  })
})
