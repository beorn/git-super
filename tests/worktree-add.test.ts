/**
 * @failure A worktree is created without its submodules, or left half-materialized after a failed pin.
 * @level l1
 * @consumer Yrd worktree provisioning
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runCli } from "../src/cli.ts"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const environment: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Git Super Test",
  GIT_AUTHOR_EMAIL: "git-super@example.test",
  GIT_COMMITTER_NAME: "Git Super Test",
  GIT_COMMITTER_EMAIL: "git-super@example.test",
  GIT_TERMINAL_PROMPT: "0",
}

function git(repo: string, args: readonly string[]): string {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env: environment })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed in ${repo}`)
  return result.stdout.trim()
}

function outputSink(): { output: string; write(value: string): void } {
  return {
    output: "",
    write(value) {
      this.output += value
    },
  }
}

function initRepository(root: string, file: string, content: string): string {
  mkdirSync(root, { recursive: true })
  git(root, ["init", "-q", "-b", "main"])
  writeFileSync(join(root, file), content)
  git(root, ["add", file])
  git(root, ["commit", "-q", "-m", `add ${file}`])
  return git(root, ["rev-parse", "HEAD"])
}

type SuperFixture = Readonly<{ dependency: string; product: string; pin: string; product_head: string }>

/** One superproject with one submodule, pinned at the dependency's only commit. */
function createSuperproject(fixtureRoot: string): SuperFixture {
  const dependency = join(fixtureRoot, "dependency")
  const product = join(fixtureRoot, "product")
  const pin = initRepository(dependency, "dep.ts", "export const dep = 1\n")
  mkdirSync(product, { recursive: true })
  git(product, ["init", "-q", "-b", "main"])
  git(product, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", dependency, "vendor/dep"])
  git(product, ["commit", "-q", "-m", "add vendor/dep"])
  return { dependency, product, pin, product_head: git(product, ["rev-parse", "HEAD"]) }
}

/**
 * Move the gitlink to an exact commit with plumbing alone, and nothing else.
 *
 * The plumbing is the point: `git submodule update` would fetch the commit into
 * the superproject's store as a side effect, and the reference would then
 * already hold the pin the test needs it to lack. `update-index --cacheinfo`
 * into a scratch index followed by `commit-tree` moves the gitlink without any
 * repository ever asking for the object, and leaves the product's own index and
 * branches untouched.
 */
function pinByPlumbing(fixture: SuperFixture, fixtureRoot: string, pin: string): string {
  const index = join(fixtureRoot, "scratch-index")
  const plumbing = (args: readonly string[]): string => {
    const result = spawnSync("git", ["-C", fixture.product, ...args], {
      encoding: "utf8",
      env: { ...environment, GIT_INDEX_FILE: index },
    })
    if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`)
    return result.stdout.trim()
  }
  plumbing(["read-tree", "HEAD"])
  plumbing(["update-index", "--add", "--cacheinfo", `160000,${pin},vendor/dep`])
  const tree = plumbing(["write-tree"])
  return plumbing(["commit-tree", tree, "-p", fixture.product_head, "-m", "pin the unfetched dep"])
}

/** Advance the dependency in its OWN clone, publish it there, and pin it here. */
function publishUnfetchedPin(fixture: SuperFixture, fixtureRoot: string): Readonly<{ pin: string; commit: string }> {
  const clone = join(fixtureRoot, "dependency-clone")
  const cloned = spawnSync("git", ["clone", "-q", fixture.dependency, clone], { encoding: "utf8", env: environment })
  if (cloned.status !== 0) throw new Error(cloned.stderr || "could not clone the dependency")
  writeFileSync(join(clone, "dep.ts"), "export const dep = 2\n")
  git(clone, ["add", "dep.ts"])
  git(clone, ["commit", "-q", "-m", "advance dep"])
  const pin = git(clone, ["rev-parse", "HEAD"])
  git(clone, ["push", "-q", "origin", "HEAD:refs/heads/feature"])
  return { pin, commit: pinByPlumbing(fixture, fixtureRoot, pin) }
}

function referenceStoreHas(fixture: SuperFixture, pin: string): boolean {
  const result = spawnSync("git", ["-C", join(fixture.product, "vendor/dep"), "cat-file", "-e", `${pin}^{commit}`], {
    encoding: "utf8",
    env: environment,
  })
  return result.status === 0
}

describe("git super worktree add", () => {
  it("materializes a submodule at the pin the reference already holds", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-worktree-add-"))
    roots.push(fixtureRoot)
    const fixture = createSuperproject(fixtureRoot)
    const worktree = join(fixtureRoot, "candidate")
    const stdout = outputSink()
    const stderr = outputSink()

    const code = await runCli(["--repo", fixture.product, "worktree", "add", worktree, "HEAD"], stdout, stderr)

    expect(stderr.output).toContain("1 gitlink (1 borrowed, 0 fetched, 0 absent)")
    expect(code).toBe(0)
    expect(stdout.output).toBe("updated\n")
    expect(stderr.output).toContain(`worktree add ${worktree} at ${fixture.product_head}`)
    expect(git(worktree, ["rev-parse", "HEAD"])).toBe(fixture.product_head)
    expect(git(join(worktree, "vendor/dep"), ["rev-parse", "HEAD"])).toBe(fixture.pin)
    expect(existsSync(join(worktree, "vendor/dep/dep.ts"))).toBe(true)
  })

  it("fetches a pin the reference lacks instead of refusing it", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-worktree-fetch-"))
    roots.push(fixtureRoot)
    const fixture = createSuperproject(fixtureRoot)
    const { pin, commit } = publishUnfetchedPin(fixture, fixtureRoot)
    expect(referenceStoreHas(fixture, pin)).toBe(false)
    const worktree = join(fixtureRoot, "candidate")
    const stdout = outputSink()
    const stderr = outputSink()

    const code = await runCli(["--repo", fixture.product, "worktree", "add", worktree, commit], stdout, stderr)

    expect(stderr.output).toContain("1 gitlink (0 borrowed, 1 fetched, 0 absent)")
    expect(code).toBe(0)
    expect(stdout.output).toBe("updated\n")
    expect(git(join(worktree, "vendor/dep"), ["rev-parse", "HEAD"])).toBe(pin)
    // The object came over the wire rather than out of thin air: the reference
    // store that provably lacked it above now holds it.
    expect(referenceStoreHas(fixture, pin)).toBe(true)
  })

  it("adds a plain worktree and says so when the commit records no .gitmodules", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-worktree-plain-"))
    roots.push(fixtureRoot)
    const solo = join(fixtureRoot, "solo")
    const head = initRepository(solo, "solo.ts", "export const solo = 1\n")
    const worktree = join(fixtureRoot, "candidate")
    const stdout = outputSink()
    const stderr = outputSink()

    const code = await runCli(["--repo", solo, "worktree", "add", worktree, "HEAD"], stdout, stderr)

    expect(code).toBe(0)
    expect(stdout.output).toBe("updated\n")
    // The requested ref is kept beside the object ID it resolved to; reporting
    // only "HEAD" would name a moving target, and reporting only the SHA would
    // lose what the caller actually asked for.
    expect(stderr.output).toBe(
      `worktree add ${worktree} at ${head} (HEAD): no .gitmodules at this commit; plain worktree add\n`,
    )
    expect(git(worktree, ["rev-parse", "HEAD"])).toBe(head)
  })

  it("removes the worktree and names the submodule when its remote is unreachable", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-worktree-unreachable-"))
    roots.push(fixtureRoot)
    const fixture = createSuperproject(fixtureRoot)
    const { pin, commit } = publishUnfetchedPin(fixture, fixtureRoot)
    // Allowed, so the refusal below can only be unreachability: without this the
    // clone would be blocked by protocol policy and the test would pass while
    // proving something else entirely.
    git(fixture.product, ["config", "--local", "protocol.file.allow", "always"])
    rmSync(fixture.dependency, { recursive: true, force: true })
    expect(referenceStoreHas(fixture, pin)).toBe(false)
    const worktree = join(fixtureRoot, "candidate")
    const stdout = outputSink()
    const stderr = outputSink()

    const code = await runCli(["--repo", fixture.product, "worktree", "add", worktree, commit], stdout, stderr)

    expect(code).toBe(2)
    expect(stdout.output).toBe("failed\n")
    expect(stderr.output).toContain("vendor/dep")
    expect(stderr.output).toContain("the worktree was removed")
    expect(existsSync(worktree)).toBe(false)
    expect(git(fixture.product, ["worktree", "list", "--porcelain"])).not.toContain(worktree)
  })

  it("borrows from the repository --reference names rather than the one it stands in", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-worktree-reference-"))
    roots.push(fixtureRoot)
    const fixture = createSuperproject(fixtureRoot)
    // A second superproject, and a pin that exists ONLY inside its submodule
    // store: never pushed to the dependency, never fetched by the product. The
    // named reference is the one place the object can come from, so a dropped
    // --reference cannot produce a passing run.
    const mirror = join(fixtureRoot, "mirror")
    const cloned = spawnSync("git", ["clone", "-q", fixture.product, mirror], { encoding: "utf8", env: environment })
    if (cloned.status !== 0) throw new Error(cloned.stderr || "could not clone the product")
    git(mirror, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q"])
    const mirrored = join(mirror, "vendor/dep")
    git(mirrored, ["checkout", "-q", "-b", "advanced"])
    writeFileSync(join(mirrored, "dep.ts"), "export const dep = 3\n")
    git(mirrored, ["add", "dep.ts"])
    git(mirrored, ["commit", "-q", "-m", "advance dep in the mirror only"])
    const pin = git(mirrored, ["rev-parse", "HEAD"])
    const commit = pinByPlumbing(fixture, fixtureRoot, pin)
    expect(referenceStoreHas(fixture, pin)).toBe(false)
    const worktree = join(fixtureRoot, "candidate")
    const stdout = outputSink()
    const stderr = outputSink()

    const code = await runCli(
      ["--repo", fixture.product, "worktree", "add", worktree, commit, "--reference", mirror],
      stdout,
      stderr,
    )

    expect(stderr.output).toContain("1 gitlink (1 borrowed, 0 fetched, 0 absent)")
    expect(code).toBe(0)
    expect(git(join(worktree, "vendor/dep"), ["rev-parse", "HEAD"])).toBe(pin)
    expect(git(join(worktree, "vendor/dep"), ["show", "-s", "--format=%s", "HEAD"])).toBe(
      "advance dep in the mirror only",
    )
  })

  it("exits 2 with usage for an unknown worktree subcommand", async () => {
    const stdout = outputSink()
    const stderr = outputSink()

    expect(await runCli(["worktree", "remove"], stdout, stderr)).toBe(2)
    expect(stderr.output).toContain("unknown worktree subcommand 'remove'")
    expect(stderr.output).toContain("Usage: git super worktree")
    expect(stdout.output).toBe("")
  })
})
