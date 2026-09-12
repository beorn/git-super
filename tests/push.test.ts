import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test } from "vitest"

import { runCli } from "../src/cli.ts"
import { acquireExclusive, createExclusive, type Exclusive } from "../src/exclusive.ts"
import { createLocalGitProcess, type GitProcess } from "../src/process.ts"
import { pushRefUpdates, remoteContainsCommit, superPush, type BeforePushOperation } from "../src/push.ts"
import { encodePushIntent, PUSH_INTENT_TRAILER } from "../src/push-intent.ts"
import { advanceRepository, canonicalTmpdir as tmpdir, createRepository, git } from "./fixture.ts"

const roots: string[] = []
const gitSuperBin = fileURLToPath(new URL("../bin/git-super", import.meta.url))
const gitWorktreeModule = new URL("../src/worktree.ts", import.meta.url).href

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function pushFixture(name: string): Readonly<{ fixture: string; repository: string; remote: string; source: string }> {
  const fixture = mkdtempSync(join(tmpdir(), `git-super-push-${name}-`))
  roots.push(fixture)
  const repository = join(fixture, "repository")
  const remote = join(fixture, "remote.git")
  const source = createRepository(repository, "README.md", "one\n")
  git(fixture, "init", "--bare", "-q", remote)
  return { fixture, repository, remote, source }
}

function update(
  repository: string,
  remote: string,
  source: string,
  expectedDestination?: { state: "missing" } | { state: "oid"; oid: string },
) {
  return {
    repository,
    remote,
    source,
    destination: "refs/heads/main",
    ...(expectedDestination === undefined ? {} : { expectedDestination }),
  }
}

function remoteRefs(repository: string): string {
  return git(repository, "for-each-ref", "--format=%(objectname) %(refname)")
}

function outputSink(): { output: string; write(value: string): void } {
  return {
    output: "",
    write(value) {
      this.output += value
    },
  }
}

function recursivePushFixture(name: string): Readonly<{
  fixture: string
  root: string
  rootRemote: string
  rootBefore: string
  rootSource: string
  child: string
  childRemote: string
  childBefore: string
  childSource: string
}> {
  const fixture = mkdtempSync(join(tmpdir(), `git-super-push-recursive-${name}-`))
  roots.push(fixture)
  const childRemote = join(fixture, "child.git")
  const childSeed = join(fixture, "child-seed")
  git(fixture, "init", "--bare", "-q", "-b", "main", childRemote)
  const childBefore = createRepository(childSeed, "child.txt", "one\n")
  git(childSeed, "remote", "add", "origin", childRemote)
  git(childSeed, "push", "-q", "-u", "origin", "main")

  const rootRemote = join(fixture, "root.git")
  const root = join(fixture, "root")
  git(fixture, "init", "--bare", "-q", "-b", "main", rootRemote)
  mkdirSync(root, { recursive: true })
  git(root, "init", "-q", "-b", "main")
  git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", childRemote, "child")
  git(root, "commit", "-q", "-am", "root one")
  const rootBefore = git(root, "rev-parse", "HEAD")
  git(root, "remote", "add", "origin", rootRemote)
  git(root, "push", "-q", "-u", "origin", "main")

  const child = join(root, "child")
  const childSource = advanceRepository(child, "child.txt", "two\n")
  git(root, "add", "child")
  git(root, "commit", "-q", "-m", "root two")
  const rootSource = git(root, "rev-parse", "HEAD")
  return { fixture, root, rootRemote, rootBefore, rootSource, child, childRemote, childBefore, childSource }
}

function nestedRecursivePushFixture(name: string) {
  const fixture = recursivePushFixture(name)
  const leafRemote = join(fixture.fixture, "leaf.git")
  const leafSeed = join(fixture.fixture, "leaf-seed")
  git(fixture.fixture, "init", "--bare", "-q", "-b", "main", leafRemote)
  const leafBefore = createRepository(leafSeed, "leaf.txt", "one\n")
  git(leafSeed, "remote", "add", "origin", leafRemote)
  git(leafSeed, "push", "-q", "-u", "origin", "main")
  git(fixture.child, "-c", "protocol.file.allow=always", "submodule", "add", "-q", leafRemote, "leaf")
  git(fixture.child, "commit", "-q", "-am", "add leaf")
  git(fixture.root, "add", "child")
  git(fixture.root, "commit", "-q", "-m", "record leaf")

  const leaf = join(fixture.child, "leaf")
  const leafSource = advanceRepository(leaf, "leaf.txt", "two\n")
  git(fixture.child, "add", "leaf")
  git(fixture.child, "commit", "-q", "-m", "bump leaf")
  const childSource = git(fixture.child, "rev-parse", "HEAD")
  git(fixture.root, "add", "child")
  git(fixture.root, "commit", "-q", "-m", "bump nested child")
  const rootSource = git(fixture.root, "rev-parse", "HEAD")
  return { ...fixture, rootSource, childSource, leaf, leafRemote, leafBefore, leafSource }
}

/**
 * A nested gitlink (child/leaf) whose pin never reaches the physical nested clone — the shape a
 * compose checkout takes when it records a submodule bump without ever fetching it. `leafSource`
 * is committed only in a throwaway seed clone, optionally published to `leafRemote` (the nested
 * clone's own `origin`), and pinned into child's tree via `update-index --cacheinfo` so the
 * nested checkout under child/leaf is never advanced past `leafBefore`.
 */
function unfetchedLeafFixture(name: string, publishLeafToOrigin: boolean) {
  const fixture = recursivePushFixture(name)
  const leafRemote = join(fixture.fixture, "leaf.git")
  const leafSeed = join(fixture.fixture, "leaf-seed")
  git(fixture.fixture, "init", "--bare", "-q", "-b", "main", leafRemote)
  const leafBefore = createRepository(leafSeed, "leaf.txt", "one\n")
  git(leafSeed, "remote", "add", "origin", leafRemote)
  git(leafSeed, "push", "-q", "-u", "origin", "main")
  git(fixture.child, "-c", "protocol.file.allow=always", "submodule", "add", "-q", leafRemote, "leaf")
  git(fixture.child, "commit", "-q", "-am", "add leaf")

  const leafSource = advanceRepository(leafSeed, "leaf.txt", "two\n")
  if (publishLeafToOrigin) git(leafSeed, "push", "-q", "origin", "main")

  git(fixture.child, "update-index", "--cacheinfo", "160000", leafSource, "leaf")
  git(fixture.child, "commit", "-q", "-m", "bump leaf without fetching it locally")
  const childSource = git(fixture.child, "rev-parse", "HEAD")
  git(fixture.root, "add", "child")
  git(fixture.root, "commit", "-q", "-m", "bump nested child")
  const rootSource = git(fixture.root, "rev-parse", "HEAD")
  return {
    ...fixture,
    rootSource,
    childSource,
    leaf: join(fixture.child, "leaf"),
    leafRemote,
    leafBefore,
    leafSource,
  }
}

describe("explicit recursive push mechanics", () => {
  test("documents every recursive mode and pushes an explicit root ref through the real CLI", async () => {
    const { repository, remote, source } = pushFixture("cli")
    git(repository, "remote", "add", "origin", remote)
    const help = outputSink()
    const helpErrors = outputSink()

    expect(await runCli(["push", "--help"], help, helpErrors)).toBe(0)
    expect(help.output).toContain("check|on-demand|only|no")
    expect(help.output).toContain("at least one submodule remote")
    expect(help.output).toContain("submodules before the root")
    expect(helpErrors.output).toBe("")

    const stdout = outputSink()
    const stderr = outputSink()
    expect(
      await runCli(
        ["--repo", repository, "push", "--recurse-submodules=no", "origin", "HEAD:refs/heads/main", "--json"],
        stdout,
        stderr,
      ),
    ).toBe(0)
    expect(stderr.output).toBe("")
    expect(JSON.parse(stdout.output)).toMatchObject({ state: "updated", partial: false })
    expect(git(remote, "rev-parse", "refs/heads/main")).toBe(source)
  })

  test.each([
    ["branch override", true, true, "origin"],
    ["push default", false, true, "alternate"],
    ["branch remote", false, false, "origin"],
  ] as const)(
    "uses configured %s and runs the push hook once",
    async (_name, branchOverride, pushDefault, selected) => {
      const { fixture, repository, remote, source: before } = pushFixture("cli-default")
      const alternate = join(fixture, "alternate.git")
      git(fixture, "init", "--bare", "-q", alternate)
      git(repository, "remote", "add", "origin", remote)
      git(repository, "remote", "add", "alternate", alternate)
      git(repository, "push", "-q", "origin", "main")
      git(repository, "push", "-q", "alternate", "main")
      git(repository, "config", "branch.main.remote", "origin")
      git(repository, "config", "branch.main.merge", "refs/heads/main")
      if (pushDefault) git(repository, "config", "remote.pushDefault", "alternate")
      if (branchOverride) git(repository, "config", "branch.main.pushRemote", "origin")
      const source = advanceRepository(repository, "README.md", "two\n")
      const hook = join(repository, ".git", "hooks", "pre-push")
      writeFileSync(`${hook}.calls`, "")
      writeFileSync(hook, '#!/bin/sh\nprintf "called\\n" >> "$0.calls"\n')
      chmodSync(hook, 0o755)
      const stdout = outputSink()
      const stderr = outputSink()

      expect(await runCli(["--repo", repository, "push", "--recurse-submodules=no", "--json"], stdout, stderr)).toBe(0)

      expect(stderr.output).toBe("")
      expect(JSON.parse(stdout.output)).toMatchObject({
        state: "updated",
        repositories: [{ refs: [{ source, destination: "refs/heads/main", state: "updated" }] }],
      })
      expect({
        origin: git(remote, "rev-parse", "refs/heads/main"),
        alternate: git(alternate, "rev-parse", "refs/heads/main"),
        hooks: readFileSync(`${hook}.calls`, "utf8"),
      }).toEqual({
        origin: selected === "origin" ? source : before,
        alternate: selected === "alternate" ? source : before,
        hooks: "called\n",
      })

      const next = advanceRepository(repository, "README.md", "three\n")
      expect(
        await runCli(
          ["--repo", repository, "push", "--recurse-submodules=no", "--no-verify", "--json"],
          outputSink(),
          outputSink(),
        ),
      ).toBe(0)
      expect(git(selected === "origin" ? remote : alternate, "rev-parse", "refs/heads/main")).toBe(next)
      expect(readFileSync(`${hook}.calls`, "utf8")).toBe("called\n")
    },
  )

  test("preserves a configured remote read failure before any push", async () => {
    const { repository, remote } = pushFixture("config-failure")
    git(repository, "remote", "add", "origin", remote)
    git(repository, "config", "branch.main.remote", "origin")
    git(repository, "config", "branch.main.merge", "refs/heads/main")
    const local = createLocalGitProcess()
    let failures = 0
    const failing: GitProcess = {
      run(request) {
        if (request.args[0] === "config" && request.args[2] === "remote.pushDefault") {
          failures += 1
          return Promise.resolve({ code: 128, stdout: "", stderr: "cannot read push configuration" })
        }
        return local.run(request)
      },
    }

    const result = await superPush({ repo: repository, recurseSubmodules: "no", git: failing })

    expect(failures).toBe(1)
    expect(result).toMatchObject({
      state: "failed",
      partial: false,
      detail: {
        code: "git-failed",
        phase: "resolve-push-remote",
        message: expect.stringContaining("cannot read push configuration"),
      },
    })
    expect(git(remote, "for-each-ref", "--format=%(refname)", "refs/heads/main")).toBe("")
  })

  test("fails loudly when neither the CLI nor Git configuration names a push remote", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "git-super-push-no-remote-"))
    roots.push(fixture)
    const repository = join(fixture, "repository")
    createRepository(repository, "README.md", "one\n")
    const stdout = outputSink()

    expect(
      await runCli(["--repo", repository, "push", "--recurse-submodules=no", "--json"], stdout, outputSink()),
    ).toBe(2)
    expect(JSON.parse(stdout.output)).toMatchObject({
      state: "failed",
      partial: false,
      detail: { code: "missing-push-remote", phase: "resolve-push-remote" },
    })
  })

  test("accepts only an explicit CLI lease and refuses when its expected old object is stale", async () => {
    const { repository, remote, source: before } = pushFixture("cli-lease")
    git(repository, "remote", "add", "origin", remote)
    git(repository, "push", "-q", "origin", `${before}:refs/heads/main`)
    const source = advanceRepository(repository, "README.md", "two\n")
    const stdout = outputSink()
    const stderr = outputSink()

    expect(
      await runCli(
        [
          "--repo",
          repository,
          "push",
          "--recurse-submodules=no",
          "--force-with-lease",
          `refs/heads/main:${"f".repeat(40)}`,
          "origin",
          "HEAD:refs/heads/main",
          "--json",
        ],
        stdout,
        stderr,
      ),
    ).toBe(2)

    expect(stderr.output).toBe("")
    expect(JSON.parse(stdout.output)).toMatchObject({
      state: "failed",
      partial: false,
      detail: { code: "destination-changed", phase: "observe-destination" },
    })
    expect(git(remote, "rev-parse", "refs/heads/main")).toBe(before)
    expect(git(repository, "rev-parse", "HEAD")).toBe(source)
  })

  test("check refuses an unpublished child but accepts that commit on any child remote", async () => {
    const fixture = recursivePushFixture("check")
    const stdout = outputSink()
    const stderr = outputSink()
    expect(
      await runCli(
        ["--repo", fixture.root, "push", "--recurse-submodules=check", "origin", "HEAD:refs/heads/main", "--json"],
        stdout,
        stderr,
      ),
    ).toBe(2)
    expect(JSON.parse(stdout.output)).toMatchObject({
      state: "failed",
      partial: false,
      detail: { code: "submodule-commit-unavailable" },
    })
    expect(git(fixture.rootRemote, "rev-parse", "refs/heads/main")).toBe(fixture.rootBefore)

    const backup = join(fixture.fixture, "child-backup.git")
    git(fixture.fixture, "init", "--bare", "-q", "-b", "main", backup)
    git(fixture.child, "remote", "add", "backup", backup)
    git(fixture.child, "push", "-q", "backup", `${fixture.childSource}:refs/heads/main`)
    const retriedOut = outputSink()
    expect(
      await runCli(
        ["--repo", fixture.root, "push", "--recurse-submodules=check", "origin", "HEAD:refs/heads/main", "--json"],
        retriedOut,
        outputSink(),
      ),
    ).toBe(0)
    expect(JSON.parse(retriedOut.output)).toMatchObject({ state: "updated", partial: false })
    expect(git(fixture.rootRemote, "rev-parse", "refs/heads/main")).toBe(fixture.rootSource)
    expect(git(fixture.childRemote, "rev-parse", "refs/heads/main")).toBe(fixture.childBefore)
  })

  test("does not turn a missing initialized child checkout into an empty recursive graph", async () => {
    const fixture = recursivePushFixture("missing-child")
    rmSync(fixture.child, { recursive: true, force: true })
    const stdout = outputSink()

    expect(
      await runCli(
        ["--repo", fixture.root, "push", "--recurse-submodules=check", "origin", "HEAD:refs/heads/main", "--json"],
        stdout,
        outputSink(),
      ),
    ).toBe(2)
    expect(JSON.parse(stdout.output)).toMatchObject({
      state: "failed",
      partial: false,
      detail: { code: "git-failed", phase: "discover-submodule" },
    })
    expect(git(fixture.rootRemote, "rev-parse", "refs/heads/main")).toBe(fixture.rootBefore)
  })

  test.each([
    ["on-demand", true],
    ["only", false],
  ] as const)("%s publishes the missing child before deciding whether to update the root", async (mode, rootMoves) => {
    const fixture = recursivePushFixture(mode)
    const stdout = outputSink()
    const stderr = outputSink()

    expect(
      await runCli(
        ["--repo", fixture.root, "push", `--recurse-submodules=${mode}`, "origin", "HEAD:refs/heads/main", "--json"],
        stdout,
        stderr,
      ),
    ).toBe(0)

    expect(stderr.output).toBe("")
    expect(git(fixture.childRemote, "rev-parse", "refs/heads/main")).toBe(fixture.childSource)
    expect(git(fixture.rootRemote, "rev-parse", "refs/heads/main")).toBe(
      rootMoves ? fixture.rootSource : fixture.rootBefore,
    )
    const result = JSON.parse(stdout.output) as { repositories: Array<{ repository: string; state: string }> }
    expect(result.repositories[0]).toMatchObject({ repository: fixture.child, state: "updated" })
    if (rootMoves) expect(result.repositories.at(-1)).toMatchObject({ repository: fixture.root, state: "updated" })
  })

  /**
   * @failure Recursive push sends a local task tip to the wrong submodule branch.
   * @level l1
   * @consumer Configured submodule forwarding and child-first queue publication
   */
  test.each(["manifest", "override", "remote-head", "dot"] as const)(
    "on-demand publishes only the captured pin using %s branch selection",
    async (selection) => {
      const fixture = recursivePushFixture(`branch-${selection}`)
      const branch = selection === "dot" ? "release" : "stable"
      git(fixture.childRemote, "update-ref", `refs/heads/${branch}`, fixture.childBefore)
      if (selection === "remote-head") {
        git(fixture.childRemote, "symbolic-ref", "HEAD", `refs/heads/${branch}`)
      } else {
        git(
          fixture.root,
          "config",
          "--file",
          ".gitmodules",
          "submodule.child.branch",
          selection === "dot" ? "." : selection === "override" ? "wrong" : branch,
        )
        git(fixture.root, "add", ".gitmodules")
        git(fixture.root, "commit", "-q", "-m", "declare forwarding branch")
      }
      if (selection === "override") git(fixture.root, "config", "submodule.child.branch", branch)
      if (selection === "dot") git(fixture.root, "switch", "-q", "-c", branch)
      const rootSource = git(fixture.root, "rev-parse", "HEAD")
      git(fixture.child, "switch", "-q", "-c", "task/unrelated")
      const extra = advanceRepository(fixture.child, "child.txt", "unrecorded task work\n")
      git(fixture.child, "switch", "-q", "--detach", extra)
      git(fixture.root, "config", "--file", ".gitmodules", "submodule.child.branch", "uncommitted")

      const result = await superPush({
        repo: fixture.root,
        remote: "origin",
        refspecs: [`${rootSource}:refs/heads/main`],
        recurseSubmodules: "on-demand",
      })

      expect(result).toMatchObject({ state: "updated", partial: false })
      expect(git(fixture.childRemote, "rev-parse", `refs/heads/${branch}`)).toBe(fixture.childSource)
      expect(git(fixture.childRemote, "rev-parse", "refs/heads/main")).toBe(fixture.childBefore)
      expect(git(fixture.rootRemote, "rev-parse", "refs/heads/main")).toBe(rootSource)
      expect(result.repositories[0]?.refs[0]).toMatchObject({
        source: fixture.childSource,
        destination: `refs/heads/${branch}`,
      })
    },
  )

  /**
   * @failure Missing branch authority silently publishes to an assumed main.
   * @level l1
   * @consumer Recursive push refusal before any remote mutation
   */
  test.each(["detached-dot", "missing-remote-head"] as const)("refuses %s before publishing", async (selection) => {
    const fixture = recursivePushFixture(selection)
    if (selection === "detached-dot") {
      git(fixture.root, "config", "submodule.child.branch", ".")
      git(fixture.root, "switch", "-q", "--detach", "HEAD")
    } else {
      git(fixture.childRemote, "symbolic-ref", "HEAD", "refs/heads/missing")
    }
    const result = await superPush({
      repo: fixture.root,
      remote: "origin",
      refspecs: ["HEAD:refs/heads/main"],
      recurseSubmodules: "on-demand",
    })
    expect(result).toMatchObject({
      state: "failed",
      partial: false,
      detail: {
        code: selection === "detached-dot" ? "detached-superproject-branch" : "submodule-remote-head-unresolved",
      },
    })
    expect(git(fixture.childRemote, "rev-parse", "refs/heads/main")).toBe(fixture.childBefore)
    expect(git(fixture.rootRemote, "rev-parse", "refs/heads/main")).toBe(fixture.rootBefore)
  })

  /**
   * @failure Publishing an older root pin attempts to rewind its already-ahead submodule branch.
   * @level l1
   * @consumer Recursive publication of commits already contained at the configured destination
   */
  test.each(["on-demand", "only"] as const)("%s keeps an already-ahead child destination", async (mode) => {
    const fixture = recursivePushFixture(`already-ahead-${mode}`)
    const ahead = advanceRepository(fixture.child, "child.txt", "already published\n")
    git(fixture.child, "push", "-q", "origin", "HEAD:refs/heads/main")
    const result = await superPush({
      repo: fixture.root,
      remote: "origin",
      refspecs: ["HEAD:refs/heads/main"],
      recurseSubmodules: mode,
    })
    expect(result.state).toBe(mode === "on-demand" ? "updated" : "unchanged")
    expect(result.repositories[0]).toMatchObject({ repository: fixture.child, state: "unchanged" })
    expect(git(fixture.childRemote, "rev-parse", "refs/heads/main")).toBe(ahead)
    expect(git(fixture.rootRemote, "rev-parse", "refs/heads/main")).toBe(
      mode === "on-demand" ? fixture.rootSource : fixture.rootBefore,
    )
  })

  test("on-demand preserves a published child when the later root hook rejects", async () => {
    const fixture = recursivePushFixture("on-demand-partial")
    const hook = join(fixture.root, ".git", "hooks", "pre-push")
    writeFileSync(hook, "#!/bin/sh\necho root-policy-refused >&2\nexit 23\n")
    chmodSync(hook, 0o755)
    const pushed = Bun.spawnSync([
      process.execPath,
      gitSuperBin,
      "--repo",
      fixture.root,
      "push",
      "--recurse-submodules=on-demand",
      "--atomic",
      "origin",
      "HEAD:refs/heads/main",
      "--json",
    ])

    expect(pushed.exitCode).toBe(2)
    expect(pushed.stderr.toString()).toBe("")
    expect(JSON.parse(pushed.stdout.toString())).toMatchObject({ state: "failed", partial: true })
    expect(git(fixture.childRemote, "rev-parse", "refs/heads/main")).toBe(fixture.childSource)
    expect(git(fixture.rootRemote, "rev-parse", "refs/heads/main")).toBe(fixture.rootBefore)
  })

  test("publishes a nested graph leaf-first, parent-next, and root-last", async () => {
    const fixture = nestedRecursivePushFixture("nested-order")
    const stdout = outputSink()

    expect(
      await runCli(
        ["--repo", fixture.root, "push", "--recurse-submodules=on-demand", "origin", "HEAD:refs/heads/main", "--json"],
        stdout,
        outputSink(),
      ),
    ).toBe(0)

    const result = JSON.parse(stdout.output) as { repositories: Array<{ repository: string; state: string }> }
    expect(result.repositories.map(({ repository }) => repository)).toEqual([fixture.leaf, fixture.child, fixture.root])
    expect(git(fixture.leafRemote, "rev-parse", "refs/heads/main")).toBe(fixture.leafSource)
    expect(git(fixture.childRemote, "rev-parse", "refs/heads/main")).toBe(fixture.childSource)
    expect(git(fixture.rootRemote, "rev-parse", "refs/heads/main")).toBe(fixture.rootSource)
  })

  test("recovers a nested gitlink commit by fetching it from the nested clone's origin", async () => {
    const fixture = unfetchedLeafFixture("nested-fetch-on-miss-present", true)
    expect(() => git(fixture.leaf, "cat-file", "-e", `${fixture.leafSource}^{commit}`)).toThrow()

    const result = await superPush({
      repo: fixture.root,
      remote: "origin",
      refspecs: [`${fixture.rootSource}:refs/heads/main`],
      recurseSubmodules: "on-demand",
    })

    expect(result).toMatchObject({ state: "updated", partial: false })
    expect(git(fixture.leafRemote, "rev-parse", "refs/heads/main")).toBe(fixture.leafSource)
    expect(git(fixture.childRemote, "rev-parse", "refs/heads/main")).toBe(fixture.childSource)
    expect(git(fixture.rootRemote, "rev-parse", "refs/heads/main")).toBe(fixture.rootSource)
    expect(() => git(fixture.leaf, "cat-file", "-e", `${fixture.leafSource}^{commit}`)).not.toThrow()
  })

  test("refuses a nested gitlink commit missing from both the nested clone and its origin", async () => {
    const fixture = unfetchedLeafFixture("nested-fetch-on-miss-absent", false)
    expect(() => git(fixture.leaf, "cat-file", "-e", `${fixture.leafSource}^{commit}`)).toThrow()

    const result = await superPush({
      repo: fixture.root,
      remote: "origin",
      refspecs: [`${fixture.rootSource}:refs/heads/main`],
      recurseSubmodules: "on-demand",
    })

    expect(result).toMatchObject({
      state: "failed",
      partial: false,
      detail: {
        phase: "verify-submodule-commit",
        message: expect.stringContaining(fixture.leafSource),
      },
    })
    expect(result.detail?.paths).toContain("child/leaf")
    expect(result.detail?.objectIds).toContain(fixture.leafSource)
    expect(git(fixture.rootRemote, "rev-parse", "refs/heads/main")).toBe(fixture.rootBefore)
    expect(git(fixture.childRemote, "rev-parse", "refs/heads/main")).toBe(fixture.childBefore)
    expect(git(fixture.leafRemote, "rev-parse", "refs/heads/main")).toBe(fixture.leafBefore)
  })

  test("creates a missing destination through an explicit create-only lease", async () => {
    const { repository, remote, source } = pushFixture("create-only")

    const result = await pushRefUpdates({
      root: repository,
      updates: [
        {
          repository,
          remote,
          source,
          destination: "refs/heads/main",
          expectedDestination: { state: "missing" },
        },
      ],
    })

    expect(git(remote, "rev-parse", "refs/heads/main")).toBe(source)
    expect(result).toMatchObject({
      state: "updated",
      partial: false,
      repositories: [
        {
          repository,
          state: "updated",
          refs: [{ source, destination: "refs/heads/main", state: "updated" }],
        },
      ],
    })
  })

  test("publishes from a bare object store without requiring a working tree", async () => {
    const fixture = pushFixture("bare-source")
    const bare = join(fixture.fixture, "staging.git")
    git(fixture.fixture, "init", "--bare", "-q", bare)
    git(bare, "fetch", "-q", fixture.repository, fixture.source)

    const result = await pushRefUpdates({
      root: bare,
      updates: [update(bare, fixture.remote, fixture.source, { state: "missing" })],
    })

    expect(result).toMatchObject({ state: "updated", partial: false })
    expect(git(fixture.remote, "rev-parse", "refs/heads/main")).toBe(fixture.source)
  })

  test("treats an identical create-only retry as unchanged and refuses a different existing object", async () => {
    const identical = pushFixture("create-only-identical")
    git(identical.repository, "push", "-q", identical.remote, `${identical.source}:refs/heads/main`)

    const retried = await pushRefUpdates({
      root: identical.repository,
      updates: [update(identical.repository, identical.remote, identical.source, { state: "missing" })],
    })

    expect(retried).toMatchObject({ state: "unchanged", partial: false })

    const conflict = pushFixture("create-only-conflict")
    git(conflict.repository, "push", "-q", conflict.remote, `${conflict.source}:refs/heads/main`)
    const different = advanceRepository(conflict.repository, "README.md", "different\n")
    const refused = await pushRefUpdates({
      root: conflict.repository,
      updates: [update(conflict.repository, conflict.remote, different, { state: "missing" })],
    })

    expect(refused).toMatchObject({
      state: "failed",
      partial: false,
      detail: { code: "destination-changed", phase: "observe-destination" },
    })
    expect(git(conflict.remote, "rev-parse", "refs/heads/main")).toBe(conflict.source)
  })

  /**
   * M8.5: a third destination OID must stop all writes and retain every ref outcome.
   * The single-ref lease test cannot detect lost sibling or root rows.
   */
  test("reports every planned ref when a later child has a stale destination", async () => {
    const root = pushFixture("preflight-root")
    const earlier = pushFixture("preflight-earlier-child")
    const stale = pushFixture("preflight-stale-child")
    git(stale.repository, "push", "-q", stale.remote, `${stale.source}:refs/heads/main`)
    const wanted = advanceRepository(stale.repository, "wanted.txt", "wanted\n")
    git(stale.repository, "switch", "-q", "-c", "competing", stale.source)
    const third = advanceRepository(stale.repository, "third.txt", "third\n")
    git(stale.repository, "push", "-q", stale.remote, `${third}:refs/heads/main`)

    const result = await pushRefUpdates({
      root: root.repository,
      updates: [
        update(root.repository, root.remote, root.source, { state: "missing" }),
        update(earlier.repository, earlier.remote, earlier.source, { state: "missing" }),
        update(stale.repository, stale.remote, wanted, { state: "oid", oid: stale.source }),
        {
          ...update(root.repository, root.remote, root.source, { state: "missing" }),
          destination: "refs/checks/frozen",
        },
      ],
    })

    expect(result).toMatchObject({
      state: "failed",
      partial: false,
      detail: { code: "destination-changed", phase: "observe-destination" },
      repositories: [
        {
          repository: earlier.repository,
          state: "not-run",
          refs: [{ source: earlier.source, destination: "refs/heads/main", state: "not-run" }],
        },
        {
          repository: stale.repository,
          state: "failed",
          refs: [
            {
              source: wanted,
              destination: "refs/heads/main",
              state: "failed",
              detail: { objectIds: [stale.source, third] },
            },
          ],
        },
        {
          repository: root.repository,
          state: "not-run",
          refs: [
            { source: root.source, destination: "refs/heads/main", state: "not-run" },
            { source: root.source, destination: "refs/checks/frozen", state: "not-run" },
          ],
        },
      ],
    })
    expect(git(earlier.remote, "for-each-ref", "--format=%(refname)")).toBe("")
    expect(git(root.remote, "for-each-ref", "--format=%(refname)")).toBe("")
    expect(git(stale.remote, "rev-parse", "refs/heads/main")).toBe(third)
  })

  test("updates only when the explicit expected old object still matches", async () => {
    const { repository, remote, source: before } = pushFixture("lease")
    git(repository, "push", "-q", remote, `${before}:refs/heads/main`)
    const source = advanceRepository(repository, "README.md", "two\n")

    const result = await pushRefUpdates({
      root: repository,
      updates: [update(repository, remote, source, { state: "oid", oid: before })],
    })

    expect(result).toMatchObject({ state: "updated", partial: false })
    expect(git(remote, "rev-parse", "refs/heads/main")).toBe(source)
  })

  test("an explicit lease cannot bypass the branch fast-forward invariant without a separate authorization", async () => {
    const { repository, remote, source: base } = pushFixture("leased-non-fast-forward")
    git(repository, "push", "-q", remote, `${base}:refs/heads/main`)
    const wanted = advanceRepository(repository, "wanted.txt", "wanted\n")
    git(repository, "switch", "-q", "-c", "competing", base)
    const competing = advanceRepository(repository, "competing.txt", "competing\n")
    git(repository, "push", "-q", remote, `${competing}:refs/heads/main`)

    const refused = await pushRefUpdates({
      root: repository,
      updates: [update(repository, remote, wanted, { state: "oid", oid: competing })],
    })

    expect(refused).toMatchObject({
      state: "failed",
      partial: false,
      detail: { code: "non-fast-forward-refused", phase: "verify-fast-forward" },
    })
    expect(git(remote, "rev-parse", "refs/heads/main")).toBe(competing)

    const authorized = await pushRefUpdates({
      root: repository,
      updates: [
        {
          ...update(repository, remote, wanted, { state: "oid", oid: competing }),
          allowNonFastForward: true,
        },
      ],
    })

    expect(authorized).toMatchObject({ state: "updated", partial: false })
    expect(git(remote, "rev-parse", "refs/heads/main")).toBe(wanted)
  })

  test("preserves native non-fast-forward refusal when no explicit lease is supplied", async () => {
    const { repository, remote, source: base } = pushFixture("native-non-fast-forward")
    git(repository, "push", "-q", remote, `${base}:refs/heads/main`)
    const wanted = advanceRepository(repository, "wanted.txt", "wanted\n")
    git(repository, "switch", "-q", "-c", "competing", base)
    const competing = advanceRepository(repository, "competing.txt", "competing\n")
    git(repository, "push", "-q", remote, `${competing}:refs/heads/main`)

    const result = await pushRefUpdates({
      root: repository,
      updates: [update(repository, remote, wanted)],
    })

    expect(result).toMatchObject({
      state: "failed",
      partial: false,
      detail: { code: "non-fast-forward-refused", phase: "verify-fast-forward" },
    })
    expect(git(remote, "rev-parse", "refs/heads/main")).toBe(competing)
  })

  test("rechecks the frozen remote value under the mutation lock", async () => {
    const { repository, remote, source: before } = pushFixture("remote-race")
    git(repository, "push", "-q", remote, `${before}:refs/heads/main`)
    const source = advanceRepository(repository, "README.md", "source\n")
    git(repository, "checkout", "-q", "-b", "race", before)
    const other = advanceRepository(repository, "README.md", "other\n")
    git(repository, "push", "-q", remote, `${other}:refs/heads/race`)
    git(repository, "checkout", "-q", "main")
    const racing: Exclusive = {
      async run(operation) {
        git(remote, "update-ref", "refs/heads/main", other)
        return operation()
      },
    }

    const result = await pushRefUpdates({
      root: repository,
      updates: [update(repository, remote, source)],
      exclusive: racing,
    })

    expect(result).toMatchObject({
      state: "failed",
      partial: false,
      detail: { code: "destination-changed", phase: "recheck-destination" },
    })
    expect(git(remote, "rev-parse", "refs/heads/main")).toBe(other)
  })

  test("accepts an identical create-only publication that wins the recheck race", async () => {
    const { repository, remote, source } = pushFixture("create-only-race")
    const racing: Exclusive = {
      async run(operation) {
        git(repository, "push", "-q", remote, `${source}:refs/heads/main`)
        return operation()
      },
    }

    const result = await pushRefUpdates({
      root: repository,
      updates: [update(repository, remote, source, { state: "missing" })],
      exclusive: racing,
    })

    expect(result).toMatchObject({ state: "updated", partial: false })
    expect(git(remote, "rev-parse", "refs/heads/main")).toBe(source)
  })

  test("reports mutation-lock contention before pushing", async () => {
    const { repository, remote, source } = pushFixture("lock")
    const lockDirectory = join(repository, ".git", "yrd-worktree-mutations")
    const held = await acquireExclusive(lockDirectory, { timeoutMs: 0 }, "test holder")
    try {
      const result = await pushRefUpdates({
        root: repository,
        updates: [update(repository, remote, source, { state: "missing" })],
        exclusive: createExclusive(lockDirectory, { timeoutMs: 0 }),
      })

      expect(result).toMatchObject({
        state: "failed",
        partial: false,
        detail: { code: "mutation-lock-busy", phase: "acquire-mutation-lock" },
      })
      expect(git(remote, "for-each-ref", "--format=%(refname)", "refs/heads/main")).toBe("")
    } finally {
      held.release()
    }
  })

  test("lets a receiver hook initialize the same repository when worktree config healing is a no-op", async () => {
    const { repository, remote, source } = pushFixture("receiver-worktree-ready")
    git(repository, "config", "extensions.worktreeConfig", "true")
    const hook = join(remote, "hooks", "pre-receive")
    writeFileSync(
      hook,
      [
        "#!/usr/bin/env bun",
        `import { createLocalGitWorktreeStore } from ${JSON.stringify(gitWorktreeModule)}`,
        `await createLocalGitWorktreeStore({ repo: ${JSON.stringify(repository)}, timeouts: { mutationLock: 25 } }).ready()`,
        "",
      ].join("\n"),
    )
    chmodSync(hook, 0o755)

    const result = await pushRefUpdates({
      root: repository,
      updates: [update(repository, remote, source, { state: "missing" })],
    })

    expect(result, JSON.stringify(result, null, 2)).toMatchObject({ state: "updated", partial: false })
    expect(git(remote, "rev-parse", "refs/heads/main")).toBe(source)
  })

  test("deduplicates identical rows and rejects conflicting destinations before any write", async () => {
    const identical = pushFixture("deduplicate")
    const row = update(identical.repository, identical.remote, identical.source, { state: "missing" })
    const deduplicated = await pushRefUpdates({ root: identical.repository, updates: [row, row] })

    expect(deduplicated.repositories).toHaveLength(1)
    expect(deduplicated.repositories[0]?.refs).toHaveLength(1)

    const conflict = pushFixture("conflict")
    const other = advanceRepository(conflict.repository, "README.md", "two\n")
    const refused = await pushRefUpdates({
      root: conflict.repository,
      updates: [
        update(conflict.repository, conflict.remote, conflict.source, { state: "missing" }),
        update(conflict.repository, conflict.remote, other, { state: "missing" }),
      ],
    })

    expect(refused).toMatchObject({
      state: "failed",
      partial: false,
      detail: { code: "conflicting-destination-updates", phase: "normalize-updates" },
    })
    expect(git(conflict.remote, "for-each-ref", "--format=%(refname)", "refs/heads/main")).toBe("")
  })

  test("runs the ordinary pre-push hook and preserves its rejection", async () => {
    const { repository, remote, source } = pushFixture("hook")
    const hook = join(repository, ".git", "hooks", "pre-push")
    writeFileSync(hook, "#!/bin/sh\necho policy-refused >&2\nexit 17\n")
    chmodSync(hook, 0o755)

    const result = await pushRefUpdates({
      root: repository,
      updates: [update(repository, remote, source, { state: "missing" })],
    })

    expect(result).toMatchObject({
      state: "failed",
      partial: false,
      detail: { code: "push-rejected", phase: "push-refs", message: expect.stringContaining("policy-refused") },
    })
  })

  test("passes atomic, hook, signed-push, push-option, and receive-pack choices to ordinary Git per repository", async () => {
    const { repository, remote, source } = pushFixture("native-options")
    git(remote, "config", "receive.advertisePushOptions", "true")
    const hook = join(repository, ".git", "hooks", "pre-push")
    writeFileSync(hook, "#!/bin/sh\nexit 99\n")
    chmodSync(hook, 0o755)
    const local = createLocalGitProcess()
    const pushArgs: string[][] = []
    const recording: GitProcess = {
      run(request) {
        if (request.args[0] === "push") pushArgs.push([...request.args])
        return local.run(request)
      },
    }

    const result = await pushRefUpdates({
      root: repository,
      updates: [update(repository, remote, source, { state: "missing" })],
      atomic: true,
      verify: false,
      signed: "false",
      pushOptions: ["ci.skip=true"],
      receivePack: "git receive-pack",
      git: recording,
    })

    expect(result.state).toBe("updated")
    expect(pushArgs).toHaveLength(1)
    expect(pushArgs[0]).toEqual(
      expect.arrayContaining([
        "--atomic",
        "--no-verify",
        "--signed=false",
        "--push-option=ci.skip=true",
        "--receive-pack=git receive-pack",
      ]),
    )
  })

  test("emits stable unknown JSON when a rejected CLI push finds a different remote result", async () => {
    const { repository, remote, source: before } = pushFixture("cli-unknown")
    git(repository, "remote", "add", "origin", remote)
    git(repository, "push", "-q", "origin", `${before}:refs/heads/main`)
    const source = advanceRepository(repository, "README.md", "source\n")
    git(repository, "checkout", "-q", "-b", "race", before)
    const other = advanceRepository(repository, "README.md", "other\n")
    git(repository, "push", "-q", "origin", `${other}:refs/heads/race`)
    git(repository, "checkout", "-q", "main")
    const hook = join(repository, ".git", "hooks", "pre-push")
    writeFileSync(
      hook,
      `#!/bin/sh\ngit --git-dir=${JSON.stringify(remote)} update-ref refs/heads/main ${other}\necho raced >&2\nexit 31\n`,
    )
    chmodSync(hook, 0o755)
    const pushed = Bun.spawnSync([
      process.execPath,
      gitSuperBin,
      "--repo",
      repository,
      "push",
      "--recurse-submodules=no",
      "origin",
      "HEAD:refs/heads/main",
      "--json",
    ])

    expect(pushed.exitCode).toBe(2)
    expect(pushed.stderr.toString()).toBe("")
    expect(JSON.parse(pushed.stdout.toString())).toMatchObject({
      state: "unknown",
      partial: false,
      repositories: [
        {
          repository,
          state: "unknown",
          refs: [{ source, destination: "refs/heads/main", state: "unknown" }],
        },
      ],
    })
    expect(git(remote, "rev-parse", "refs/heads/main")).toBe(other)
  })

  test.each([
    ["authentication", "Authentication failed for remote", "authentication-failed"],
    ["atomic", "the receiving end does not support --atomic push", "atomic-unsupported"],
  ] as const)("classifies %s failures without hiding the remote error", async (name, stderr, code) => {
    const { repository, remote, source } = pushFixture(name)
    const local = createLocalGitProcess()
    const failing: GitProcess = {
      run: (request) =>
        request.args[0] === "push" ? Promise.resolve({ code: 1, stdout: "", stderr }) : local.run(request),
    }

    const result = await pushRefUpdates({
      root: repository,
      updates: [update(repository, remote, source, { state: "missing" })],
      ...(name === "atomic" ? { atomic: true } : {}),
      git: failing,
    })

    expect(result).toMatchObject({ state: "failed", partial: false, detail: { code, phase: "push-refs" } })
  })

  test("reports a bounded push timeout", async () => {
    const { repository, remote, source } = pushFixture("timeout")
    const local = createLocalGitProcess()
    const timingOut: GitProcess = {
      run: (request) =>
        request.args[0] === "push"
          ? Promise.resolve({ code: 143, stdout: "", stderr: "transport timed out", timedOut: true })
          : local.run(request),
    }

    const result = await pushRefUpdates({
      root: repository,
      updates: [update(repository, remote, source, { state: "missing" })],
      timeoutMs: 25,
      git: timingOut,
    })

    expect(result).toMatchObject({
      state: "failed",
      partial: false,
      detail: { code: "git-timeout", phase: "push-refs" },
    })
  })

  test("applies the caller timeout to exact destination commit verification", async () => {
    const { repository, remote, source: before } = pushFixture("destination-timeout")
    git(repository, "push", "-q", remote, `${before}:refs/heads/main`)
    const source = advanceRepository(repository, "README.md", "two\n")
    const local = createLocalGitProcess()
    const requests: Array<Readonly<{ args: readonly string[]; timeoutMs?: number }>> = []
    const traced: GitProcess = {
      run(request) {
        requests.push(request)
        return local.run(request)
      },
    }

    const result = await pushRefUpdates({
      root: repository,
      updates: [update(repository, remote, source, { state: "oid", oid: before })],
      timeoutMs: 123_456,
      git: traced,
    })

    expect(result.state).toBe("updated")
    expect(requests.filter(({ args }) => args.includes("cat-file")).map(({ timeoutMs }) => timeoutMs)).toEqual([
      123_456, 123_456, 123_456,
    ])
  })

  test("rejects an invalid timeout before inspecting the repository or remotes", async () => {
    let calls = 0
    const unreachable: GitProcess = {
      run() {
        calls += 1
        throw new Error("Git must not run for invalid input")
      },
    }

    const result = await superPush({
      repo: "/not-inspected",
      recurseSubmodules: "check",
      timeoutMs: 0,
      git: unreachable,
    })

    expect(result).toMatchObject({
      state: "failed",
      partial: false,
      detail: { code: "invalid-timeout", phase: "validate" },
    })
    expect(calls).toBe(0)
  })

  test("recovers an exact success after the transport response is lost", async () => {
    const { repository, remote, source } = pushFixture("lost-response")
    const local = createLocalGitProcess()
    const lost: GitProcess = {
      async run(request) {
        const result = await local.run(request)
        return request.args[0] === "push" ? { code: 1, stdout: "", stderr: "connection lost after send" } : result
      },
    }

    const result = await pushRefUpdates({
      root: repository,
      updates: [update(repository, remote, source, { state: "missing" })],
      git: lost,
    })

    expect(result).toMatchObject({ state: "updated", partial: false })
    expect(git(remote, "rev-parse", "refs/heads/main")).toBe(source)
  })

  test("preserves a successful write as unknown when post-push observation fails", async () => {
    const { repository, remote, source } = pushFixture("post-write-observation")
    const local = createLocalGitProcess()
    let observations = 0
    const unreadableAfterWrite: GitProcess = {
      async run(request) {
        if (request.args[0] === "ls-remote") {
          observations += 1
          if (observations === 3) {
            return { code: 128, stdout: "", stderr: "remote disappeared after write" }
          }
        }
        return local.run(request)
      },
    }

    const result = await pushRefUpdates({
      root: repository,
      updates: [update(repository, remote, source, { state: "missing" })],
      git: unreadableAfterWrite,
    })

    expect(result).toMatchObject({
      state: "unknown",
      partial: false,
      detail: { code: "git-failed", phase: "observe-push-result" },
      repositories: [
        {
          repository,
          state: "unknown",
          refs: [{ source, destination: "refs/heads/main", state: "unknown" }],
        },
      ],
    })
    expect(git(remote, "rev-parse", "refs/heads/main")).toBe(source)
  })

  test("checks exact commit availability on one selected remote", async () => {
    const { repository, remote, source } = pushFixture("remote-availability")
    git(repository, "remote", "add", "origin", remote)
    git(repository, "push", "-q", "origin", `${source}:refs/heads/main`)

    await expect(remoteContainsCommit({ repository, remote: "origin", commit: source })).resolves.toBe(true)

    const unpublished = advanceRepository(repository, "README.md", "two\n")
    await expect(remoteContainsCommit({ repository, remote: "origin", commit: unpublished })).resolves.toBe(false)
  })

  /**
   * M8.5 frozen recovery must reuse captured destinations after child config changes.
   * Ordinary recursive push tests resolve current config and cannot prove this seam.
   * Empty-tree records must retain reachable merge sources without advancing mains;
   * published history must not replay frozen destinations on a later record push.
   * Recovery must fetch retained child sources with the author checkout gone and
   * preserve the checked merge without materializing a replacement worktree.
   * Root landing atomically advances main and the ended record and deletes a leased
   * pause ref; a stale pause lease must refuse before any child main advances.
   * This native-Git workflow includes conflict, fetch failure, retry and cold clone;
   * macOS CI exceeded the default 5s budget, so this one workflow is bounded at 30s.
   */
  test("pushes a frozen merge to its original child destination and resumes an identical result", async () => {
    const fixture = recursivePushFixture("frozen-destination")
    const rootUrl = "https://git-super.test/owned/root.git"
    const childUrl = "https://git-super.test/owned/child.git"
    git(fixture.root, "config", `url.${fixture.rootRemote}.insteadOf`, rootUrl)
    git(fixture.child, "config", `url.${fixture.childRemote}.insteadOf`, childUrl)
    git(fixture.root, "remote", "set-url", "origin", rootUrl)
    git(fixture.root, "config", "--file", ".gitmodules", "submodule.child.url", childUrl)
    git(fixture.root, "commit", "-q", "-am", "declare hosted child identity")
    const candidate = git(fixture.root, "rev-parse", "HEAD")
    const encoded = encodePushIntent({
      version: 1,
      rootRemote: rootUrl,
      children: [
        {
          path: "child",
          remote: childUrl,
          pin: fixture.childSource,
          publication: {
            destination: "refs/heads/main",
            source: fixture.childSource,
            expectedDestination: { state: "oid", oid: fixture.childBefore },
          },
        },
      ],
    })
    const merge = git(
      fixture.root,
      "commit-tree",
      `${candidate}^{tree}`,
      "-p",
      fixture.rootBefore,
      "-p",
      candidate,
      "-m",
      `checked merge\n\n${PUSH_INTENT_TRAILER}: ${encoded}`,
    )
    git(fixture.root, "config", "submodule.child.branch", "changed-after-checks")
    git(fixture.child, "remote", "set-url", "origin", "https://elsewhere.test/external/changed.git")
    const options = {
      repo: fixture.root,
      remote: "origin",
      refspecs: [`${merge}:refs/heads/main`],
      recurseSubmodules: "on-demand" as const,
    }

    const emptyTree = git(fixture.root, "hash-object", "-w", "-t", "tree", "--stdin")
    const record = git(fixture.root, "commit-tree", emptyTree, "-p", merge, "-m", "retain checked merge")
    const recordRef = "refs/checks/frozen"
    const pinRef = `refs/git-super/pins/${fixture.childSource}`
    const recordOptions = { ...options, refspecs: [`${record}:${recordRef}`] }
    git(fixture.childRemote, "update-ref", pinRef, fixture.childBefore)
    expect(await superPush(recordOptions)).toMatchObject({ state: "failed", partial: false })
    expect(git(fixture.rootRemote, "for-each-ref", "--format=%(refname)", recordRef)).toBe("")
    expect(git(fixture.childRemote, "rev-parse", pinRef)).toBe(fixture.childBefore)
    git(fixture.childRemote, "update-ref", "-d", pinRef, fixture.childBefore)

    const process = createLocalGitProcess()
    const calls: string[][] = []
    let rejectFetch = true
    const injected: GitProcess = {
      run: async (request) => {
        calls.push([...request.args])
        if (rejectFetch && request.args[0] === "fetch" && request.args.includes(pinRef)) {
          return { code: 73, stdout: "", stderr: "retained source fetch refused" }
        }
        return process.run(request)
      },
    }
    expect(await superPush({ ...recordOptions, git: injected })).toMatchObject({
      state: "failed",
      partial: true,
      detail: {
        phase: "verify-retained-source-fetch",
        message: expect.stringContaining("retained source fetch refused"),
      },
    })
    expect(git(fixture.childRemote, "rev-parse", pinRef)).toBe(fixture.childSource)
    expect(git(fixture.childRemote, "rev-parse", "refs/heads/main")).toBe(fixture.childBefore)
    expect(git(fixture.rootRemote, "rev-parse", "refs/heads/main")).toBe(fixture.rootBefore)
    expect(git(fixture.rootRemote, "for-each-ref", "--format=%(refname)", recordRef)).toBe("")
    rejectFetch = false
    expect(await superPush({ ...recordOptions, git: injected })).toMatchObject({ state: "updated", partial: false })
    expect(git(fixture.rootRemote, "rev-parse", recordRef)).toBe(record)
    expect(git(fixture.childRemote, "rev-parse", "refs/heads/main")).toBe(fixture.childBefore)
    expect(git(fixture.rootRemote, "rev-parse", "refs/heads/main")).toBe(fixture.rootBefore)
    const retentionPush = calls.findIndex(
      (args) => args[0] === "push" && args.includes(`${fixture.childSource}:${pinRef}`),
    )
    const retentionFetch = calls.findIndex((args) => args[0] === "fetch" && args.includes(pinRef))
    const recordPush = calls.findIndex((args) => args[0] === "push" && args.includes(`${record}:${recordRef}`))
    expect(retentionPush).toBeGreaterThanOrEqual(0)
    expect(retentionFetch).toBeGreaterThan(retentionPush)
    expect(recordPush).toBeGreaterThan(retentionFetch)

    const cold = join(fixture.fixture, "cold")
    git(fixture.fixture, "clone", "-q", "--no-checkout", "--no-local", fixture.rootRemote, cold)
    git(cold, "fetch", "-q", "origin", `${recordRef}:${recordRef}`)
    git(cold, "remote", "set-url", "origin", rootUrl)
    git(cold, "config", "submodule.child.branch", "changed-after-restart")
    expect(existsSync(join(cold, ".git", "objects", "info", "alternates"))).toBe(false)
    expect(existsSync(join(cold, ".git", "modules", "child"))).toBe(false)
    rmSync(fixture.root, { recursive: true, force: true })
    expect(existsSync(fixture.root)).toBe(false)
    const coldProcess = createLocalGitProcess({
      ...globalThis.process.env,
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: `url.${fixture.rootRemote}.insteadOf`,
      GIT_CONFIG_VALUE_0: rootUrl,
      GIT_CONFIG_KEY_1: `url.${fixture.childRemote}.insteadOf`,
      GIT_CONFIG_VALUE_1: childUrl,
    })
    const recoveryCalls: string[][] = []
    const recoveryGit: GitProcess = {
      run: (request) => {
        recoveryCalls.push([...request.args])
        return coldProcess.run(request)
      },
    }
    const pauseRef = "refs/holds/check"
    git(fixture.rootRemote, "update-ref", pauseRef, candidate)
    const ended = git(cold, "commit-tree", emptyTree, "-p", record, "-m", "ended record")
    const recoveryOptions = {
      ...options,
      repo: cold,
      git: recoveryGit,
      atomic: true,
      refspecs: [`${merge}:refs/heads/main`, `${ended}:${recordRef}`, `:${pauseRef}`],
      forceWithLease: [
        `refs/heads/main:${fixture.rootBefore}`,
        `${recordRef}:${record}`,
        `${pauseRef}:${fixture.rootBefore}`,
      ],
    }
    expect(
      await superPush({ ...recoveryOptions, forceWithLease: recoveryOptions.forceWithLease.slice(0, 2) }),
    ).toMatchObject({
      state: "failed",
      partial: false,
      detail: { code: "missing-delete-lease" },
    })
    expect(await superPush(recoveryOptions)).toMatchObject({
      state: "failed",
      partial: false,
      detail: { code: "destination-changed" },
    })
    expect(git(fixture.childRemote, "rev-parse", "refs/heads/main")).toBe(fixture.childBefore)
    expect(git(fixture.rootRemote, "rev-parse", "refs/heads/main")).toBe(fixture.rootBefore)
    expect(git(fixture.rootRemote, "rev-parse", recordRef)).toBe(record)
    expect(git(fixture.rootRemote, "rev-parse", pauseRef)).toBe(candidate)
    git(fixture.rootRemote, "update-ref", pauseRef, fixture.rootBefore, candidate)
    expect(await superPush(recoveryOptions)).toMatchObject({ state: "updated", partial: false })
    expect(git(fixture.rootRemote, "rev-parse", recordRef)).toBe(ended)
    expect(git(fixture.rootRemote, "for-each-ref", "--format=%(refname)", pauseRef)).toBe("")
    expect(recoveryCalls.filter((args) => args[0] === "push" && args.includes(`${merge}:refs/heads/main`))).toEqual([
      expect.arrayContaining([
        "--atomic",
        `${ended}:${recordRef}`,
        `:${pauseRef}`,
        `--force-with-lease=${pauseRef}:${fixture.rootBefore}`,
      ]),
    ])
    expect(recoveryCalls.some((args) => args[0] === "fetch" && args.includes(pinRef))).toBe(true)
    expect(recoveryCalls.some((args) => ["merge", "commit-tree", "worktree"].includes(args[0] ?? ""))).toBe(false)
    expect(existsSync(join(cold, "child"))).toBe(false)
    expect(git(fixture.childRemote, "rev-parse", "refs/heads/main")).toBe(fixture.childSource)
    expect(git(fixture.rootRemote, "rev-parse", "refs/heads/main")).toBe(merge)
    expect(git(fixture.childRemote, "for-each-ref", "--format=%(refname)", "refs/heads/changed-after-checks")).toBe("")
    expect(await superPush(recoveryOptions)).toMatchObject({ state: "unchanged", partial: false })

    const third = git(
      fixture.childRemote,
      "commit-tree",
      `${fixture.childSource}^{tree}`,
      "-p",
      fixture.childSource,
      "-m",
      "later independent main",
    )
    git(fixture.childRemote, "update-ref", "refs/heads/main", third, fixture.childSource)
    const laterRecord = git(cold, "commit-tree", emptyTree, "-p", ended, "-m", "later record")
    expect(
      await superPush({ ...recordOptions, repo: cold, git: recoveryGit, refspecs: [`${laterRecord}:${recordRef}`] }),
    ).toMatchObject({
      state: "updated",
      partial: false,
    })
    expect(git(fixture.childRemote, "rev-parse", "refs/heads/main")).toBe(third)
    expect(git(fixture.rootRemote, "rev-parse", "refs/heads/main")).toBe(merge)
  }, 30_000)

  /** M8.5: malformed or externally targeted saved intent must refuse before any ref write. */
  test.each(["duplicate-field", "external-remote", "invalid-base64"] as const)(
    "refuses %s frozen intent without publishing",
    async (condition) => {
      const fixture = recursivePushFixture(`frozen-${condition}`)
      const rootUrl = "https://git-super.test/owned/root.git"
      git(fixture.root, "config", `url.${fixture.rootRemote}.insteadOf`, rootUrl)
      git(fixture.root, "remote", "set-url", "origin", rootUrl)
      let json = JSON.stringify({
        version: 1,
        rootRemote: rootUrl,
        children: [
          {
            path: "child",
            remote:
              condition === "external-remote"
                ? "https://git-super.test/external/child.git"
                : "https://git-super.test/owned/child.git",
            pin: fixture.childSource,
            publication: {
              destination: "refs/heads/main",
              source: fixture.childSource,
              expectedDestination: { state: "oid", oid: fixture.childBefore },
            },
          },
        ],
      })
      if (condition === "duplicate-field") json = json.replace('{"version":1,', '{"version":0,"version":1,')
      const encoded = condition === "invalid-base64" ? "%%%" : Buffer.from(json).toString("base64")
      const merge = git(
        fixture.root,
        "commit-tree",
        `${fixture.rootSource}^{tree}`,
        "-p",
        fixture.rootBefore,
        "-p",
        fixture.rootSource,
        "-m",
        `invalid merge\n\n${PUSH_INTENT_TRAILER}: ${encoded}`,
      )

      expect(
        await superPush({
          repo: fixture.root,
          remote: "origin",
          refspecs: [`${merge}:refs/heads/main`],
          recurseSubmodules: "on-demand",
        }),
      ).toMatchObject({
        state: "failed",
        partial: false,
        detail: { code: "invalid-frozen-push-intent" },
      })
      expect(git(fixture.childRemote, "rev-parse", "refs/heads/main")).toBe(fixture.childBefore)
      expect(git(fixture.rootRemote, "rev-parse", "refs/heads/main")).toBe(fixture.rootBefore)
    },
  )

  /**
   * @failure A direct multi-repository batch can publish an earlier child before a caller rejects the operation.
   * @level l1
   * @consumer Callers that need one all-or-nothing preflight before child-first ref writes
   */
  test.each(["throw", "reject"] as const)("refuses direct batches when beforePush %ss", async (failure) => {
    const root = pushFixture(`before-push-direct-root-${failure}`)
    const child = pushFixture(`before-push-direct-child-${failure}`)
    let calls = 0
    let reviewed: unknown

    const result = await pushRefUpdates({
      root: root.repository,
      updates: [
        update(root.repository, relative(root.repository, root.remote), root.source, { state: "missing" }),
        update(child.repository, relative(child.repository, child.remote), child.source, { state: "missing" }),
      ],
      beforePush: (operation) => {
        calls += 1
        reviewed = operation
        if (failure === "throw") throw new Error("policy refused direct batch")
        return Promise.reject(new Error("policy rejected direct batch"))
      },
    })

    expect(calls).toBe(1)
    expect(reviewed).toMatchObject({
      updates: [
        {
          repository: child.repository,
          remote: child.remote,
          source: child.source,
          destination: "refs/heads/main",
          expectedDestination: { state: "missing" },
          purpose: "publication",
        },
        {
          repository: root.repository,
          remote: root.remote,
          source: root.source,
          destination: "refs/heads/main",
          expectedDestination: { state: "missing" },
          purpose: "publication",
        },
      ],
    })
    expect(result).toMatchObject({
      state: "failed",
      partial: false,
      detail: { code: "before-push-failed", phase: "before-push" },
    })
    expect(result.detail?.message).toContain(
      failure === "throw" ? "policy refused direct batch" : "policy rejected direct batch",
    )
    expect(remoteRefs(child.remote)).toBe("")
    expect(remoteRefs(root.remote)).toBe("")
  })

  /**
   * @failure An operation policy cannot inspect or refuse an exact leased deletion before the remote ref is removed.
   * @level l1
   * @consumer Callers that protect deletion alongside ordinary publication updates
   */
  test("refuses an exact deletion before its remote ref changes", async () => {
    const fixture = pushFixture("before-push-delete")
    git(fixture.repository, "remote", "add", "origin", fixture.remote)
    git(fixture.repository, "push", "-q", "origin", `${fixture.source}:refs/heads/main`)
    let calls = 0
    let reviewed: unknown

    const result = await pushRefUpdates({
      root: fixture.repository,
      updates: [update(fixture.repository, "origin", "", { state: "oid", oid: fixture.source })],
      beforePush: (operation) => {
        calls += 1
        reviewed = operation
        throw new Error("policy refused deletion")
      },
    })

    expect(calls).toBe(1)
    expect(reviewed).toMatchObject({
      updates: [
        {
          repository: fixture.repository,
          remote: fixture.remote,
          source: "",
          destination: "refs/heads/main",
          expectedDestination: { state: "oid", oid: fixture.source },
          purpose: "publication",
        },
      ],
    })
    expect(result).toMatchObject({
      state: "failed",
      partial: false,
      detail: {
        code: "before-push-failed",
        phase: "before-push",
        message: expect.stringContaining("policy refused deletion"),
      },
    })
    expect(git(fixture.remote, "rev-parse", "refs/heads/main")).toBe(fixture.source)
  })

  /**
   * @failure Recursive publication may advance a child or root after policy rejection because the policy sees no complete operation.
   * @level l1
   * @consumer Recursive push callers that must reject before any root or child remote ref changes
   */
  test("refuses an on-demand root task before every child and root remote write", async () => {
    const fixture = recursivePushFixture("before-push-recursive-refusal")
    const rootBefore = remoteRefs(fixture.rootRemote)
    const childBefore = remoteRefs(fixture.childRemote)
    let calls = 0
    let reviewed: unknown

    const result = await superPush({
      repo: fixture.root,
      remote: "origin",
      refspecs: [`${fixture.rootSource}:refs/heads/task/preflight`],
      recurseSubmodules: "on-demand",
      beforePush: (operation) => {
        calls += 1
        reviewed = operation
        throw new Error("policy refused recursive publication")
      },
    })

    expect(calls).toBe(1)
    expect(reviewed).toMatchObject({
      root: fixture.root,
      updates: [
        expect.objectContaining({
          repository: fixture.child,
          source: fixture.childSource,
          destination: "refs/heads/main",
          purpose: "publication",
        }),
        expect.objectContaining({
          repository: fixture.root,
          source: fixture.rootSource,
          destination: "refs/heads/task/preflight",
          purpose: "publication",
        }),
      ],
    })
    expect(result).toMatchObject({
      state: "failed",
      partial: false,
      detail: { code: "before-push-failed", phase: "before-push" },
    })
    expect(remoteRefs(fixture.childRemote)).toBe(childBefore)
    expect(remoteRefs(fixture.rootRemote)).toBe(rootBefore)
  })

  /**
   * @failure A callback is skipped for ordinary no/check pushes, leaving a caller unable to apply one operation policy.
   * @level l1
   * @consumer Policy injection across every successful recurse-submodules mode
   */
  test.each(["no", "check"] as const)("calls beforePush once for successful %s mode", async (mode) => {
    let calls = 0
    let reviewed: unknown
    const beforePush = (operation: BeforePushOperation) => {
      calls += 1
      reviewed = operation
      expect(Object.isFrozen(operation)).toBe(true)
      expect(Object.isFrozen(operation.updates)).toBe(true)
      expect(Object.isFrozen(operation.updates[0])).toBe(true)
      expect(Object.isFrozen(operation.updates[0]?.expectedDestination)).toBe(true)
    }
    if (mode === "no") {
      const fixture = pushFixture("before-push-no")
      const result = await superPush({
        repo: fixture.repository,
        remote: fixture.remote,
        refspecs: [`${fixture.source}:refs/heads/main`],
        recurseSubmodules: mode,
        beforePush,
      })
      expect(result).toMatchObject({ state: "updated", partial: false })
    } else {
      const fixture = recursivePushFixture("before-push-check")
      git(fixture.child, "push", "-q", "origin", `${fixture.childSource}:refs/heads/main`)
      const result = await superPush({
        repo: fixture.root,
        remote: "origin",
        refspecs: [`${fixture.rootSource}:refs/heads/main`],
        recurseSubmodules: mode,
        beforePush,
      })
      expect(result).toMatchObject({ state: "updated", partial: false })
    }
    expect(calls).toBe(1)
    expect(reviewed).toMatchObject({ updates: [{ purpose: "publication", destination: "refs/heads/main" }] })
  })

  /**
   * @failure A remote ref changed after review can advance despite the reviewed exact old value.
   * @level l1
   * @consumer Policy callbacks that need existing explicit leases to remain authoritative after review
   */
  test("retains the reviewed lease when a callback advances the remote ref", async () => {
    const fixture = pushFixture("before-push-lease")
    git(fixture.repository, "remote", "add", "origin", fixture.remote)
    git(fixture.repository, "push", "-q", "origin", `${fixture.source}:refs/heads/main`)
    const source = advanceRepository(fixture.repository, "README.md", "two\n")
    let calls = 0
    let reviewed: unknown
    let competing = ""

    const result = await superPush({
      repo: fixture.repository,
      remote: "origin",
      refspecs: [`${source}:refs/heads/main`],
      recurseSubmodules: "no",
      beforePush: (operation) => {
        calls += 1
        reviewed = operation
        competing = git(
          fixture.remote,
          "commit-tree",
          `${fixture.source}^{tree}`,
          "-p",
          fixture.source,
          "-m",
          "competing remote advance",
        )
        git(fixture.remote, "update-ref", "refs/heads/main", competing, fixture.source)
      },
    })

    expect(calls).toBe(1)
    expect(reviewed).toMatchObject({
      updates: [
        {
          repository: fixture.repository,
          remote: fixture.remote,
          source,
          destination: "refs/heads/main",
          expectedDestination: { state: "oid", oid: fixture.source },
          purpose: "publication",
        },
      ],
    })
    expect(result).toMatchObject({ state: "failed", partial: false, detail: { code: "destination-changed" } })
    expect(git(fixture.remote, "rev-parse", "refs/heads/main")).toBe(competing)
  })

  /**
   * @failure A callback can mutate its caller-owned expected destination after review and replace the lease that executes.
   * @level l1
   * @consumer Callers that retain mutable RefUpdate input while a beforePush callback runs
   */
  test("keeps a reviewed lease when the caller mutates its original expected destination", async () => {
    const fixture = pushFixture("before-push-mutable-lease")
    git(fixture.repository, "remote", "add", "origin", fixture.remote)
    git(fixture.repository, "push", "-q", "origin", `${fixture.source}:refs/heads/main`)
    const staged = advanceRepository(fixture.repository, "README.md", "staged\n")
    git(fixture.repository, "push", "-q", "origin", `${staged}:refs/heads/staged`)
    const source = advanceRepository(fixture.repository, "README.md", "selected source\n")
    const expectedDestination = { state: "oid" as const, oid: fixture.source }
    let calls = 0

    const result = await pushRefUpdates({
      root: fixture.repository,
      updates: [
        {
          repository: fixture.repository,
          remote: "origin",
          source,
          destination: "refs/heads/main",
          expectedDestination,
        },
      ],
      beforePush: (operation) => {
        calls += 1
        expect(operation.updates[0]?.expectedDestination).toEqual({ state: "oid", oid: fixture.source })
        expectedDestination.oid = staged
        git(fixture.remote, "update-ref", "refs/heads/main", staged, fixture.source)
      },
    })

    expect(calls).toBe(1)
    expect(result).toMatchObject({ state: "failed", partial: false, detail: { code: "destination-changed" } })
    expect(git(fixture.remote, "rev-parse", "refs/heads/main")).toBe(staged)
  })

  /**
   * @failure A remote alias changed in the callback diverts a reviewed child update to a different remote.
   * @level l1
   * @consumer Callers relying on exact reviewed repository and remote identities
   */
  test("executes the reviewed remote when beforePush changes a child remote alias", async () => {
    const fixture = recursivePushFixture("before-push-freeze-remote")
    const alternate = join(fixture.fixture, "alternate-child.git")
    git(fixture.fixture, "init", "--bare", "-q", "-b", "main", alternate)
    let calls = 0

    const result = await superPush({
      repo: fixture.root,
      remote: "origin",
      refspecs: ["HEAD:refs/heads/main"],
      recurseSubmodules: "on-demand",
      beforePush: (operation) => {
        calls += 1
        expect(operation.updates[0]).toMatchObject({ repository: fixture.child, remote: fixture.childRemote })
        git(fixture.child, "remote", "set-url", "origin", alternate)
        advanceRepository(fixture.root, "after-review.txt", "move root source after review\n")
      },
    })

    expect(result).toMatchObject({ state: "updated", partial: false })
    expect(calls).toBe(1)
    expect(git(fixture.childRemote, "rev-parse", "refs/heads/main")).toBe(fixture.childSource)
    expect(git(fixture.rootRemote, "rev-parse", "refs/heads/main")).toBe(fixture.rootSource)
    expect(remoteRefs(alternate)).toBe("")
  })

  /**
   * @failure only mode leaks a root update to policy even though it cannot execute that update.
   * @level l1
   * @consumer Policy injection that distinguishes selected child publication from root preservation
   */
  test("excludes the root update from an only-mode beforePush operation", async () => {
    const fixture = recursivePushFixture("before-push-only")
    let calls = 0

    const result = await superPush({
      repo: fixture.root,
      remote: "origin",
      refspecs: [`${fixture.rootSource}:refs/heads/main`],
      recurseSubmodules: "only",
      beforePush: (operation) => {
        calls += 1
        expect(operation.root).toBe(fixture.root)
        expect(operation.updates).toHaveLength(1)
        expect(operation.updates[0]).toMatchObject({
          repository: fixture.child,
          source: fixture.childSource,
          destination: "refs/heads/main",
          purpose: "publication",
        })
      },
    })

    expect(result).toMatchObject({ state: "updated", partial: false })
    expect(calls).toBe(1)
    expect(git(fixture.childRemote, "rev-parse", "refs/heads/main")).toBe(fixture.childSource)
    expect(git(fixture.rootRemote, "rev-parse", "refs/heads/main")).toBe(fixture.rootBefore)
  })

  /**
   * @failure An empty only-mode operation skips policy or leaks its root-only input as a write.
   * @level l1
   * @consumer Policy callbacks that distinguish no selected writes from root preservation
   */
  test("calls beforePush once with no updates for an empty only-mode operation", async () => {
    const fixture = pushFixture("before-push-empty-only")
    let calls = 0

    const result = await superPush({
      repo: fixture.repository,
      remote: fixture.remote,
      refspecs: [`${fixture.source}:refs/heads/main`],
      recurseSubmodules: "only",
      beforePush: (operation) => {
        calls += 1
        expect(operation.root).toBe(fixture.repository)
        expect(operation.updates).toEqual([])
      },
    })

    expect(result).toMatchObject({ state: "unchanged", partial: false })
    expect(calls).toBe(1)
    expect(remoteRefs(fixture.remote)).toBe("")
  })

  /**
   * @failure A frozen child main can be preceded by an immutable pin write before operation policy rejects it.
   * @level l1
   * @consumer Frozen checked publication refusal before retention, child, or root remotes move
   */
  test("refuses a direct frozen merge before immutable retention or publication", async () => {
    const fixture = recursivePushFixture("before-push-frozen-refusal")
    const rootUrl = "https://git-super.test/owned/root.git"
    const childUrl = "https://git-super.test/owned/child.git"
    git(fixture.root, "config", `url.${fixture.rootRemote}.insteadOf`, rootUrl)
    git(fixture.child, "config", `url.${fixture.childRemote}.insteadOf`, childUrl)
    git(fixture.root, "remote", "set-url", "origin", rootUrl)
    const intent = encodePushIntent({
      version: 1,
      rootRemote: rootUrl,
      children: [
        {
          path: "child",
          remote: childUrl,
          pin: fixture.childSource,
          publication: {
            destination: "refs/heads/main",
            source: fixture.childSource,
            expectedDestination: { state: "oid", oid: fixture.childBefore },
          },
        },
      ],
    })
    const merge = git(
      fixture.root,
      "commit-tree",
      `${fixture.rootSource}^{tree}`,
      "-p",
      fixture.rootBefore,
      "-p",
      fixture.rootSource,
      "-m",
      `checked merge\n\n${PUSH_INTENT_TRAILER}: ${intent}`,
    )
    const rootBefore = remoteRefs(fixture.rootRemote)
    const childBefore = remoteRefs(fixture.childRemote)
    let calls = 0
    let reviewed: unknown

    const result = await superPush({
      repo: fixture.root,
      remote: "origin",
      refspecs: [`${merge}:refs/heads/main`],
      recurseSubmodules: "on-demand",
      beforePush: (operation) => {
        calls += 1
        reviewed = operation
        throw new Error("policy refused frozen publication")
      },
    })

    expect(calls).toBe(1)
    expect(reviewed).toMatchObject({
      root: fixture.root,
      updates: [
        expect.objectContaining({
          repository: fixture.child,
          source: fixture.childSource,
          destination: `refs/git-super/pins/${fixture.childSource}`,
          purpose: "retention",
        }),
        expect.objectContaining({
          repository: fixture.child,
          source: fixture.childSource,
          destination: "refs/heads/main",
          purpose: "publication",
        }),
        expect.objectContaining({
          repository: fixture.root,
          source: merge,
          destination: "refs/heads/main",
          purpose: "publication",
        }),
      ],
    })
    expect(result).toMatchObject({
      state: "failed",
      partial: false,
      detail: { code: "before-push-failed", phase: "before-push" },
    })
    expect(remoteRefs(fixture.childRemote)).toBe(childBefore)
    expect(remoteRefs(fixture.rootRemote)).toBe(rootBefore)
  })

  /**
   * @failure Retention policy either replays a historical frozen branch publication or rejects the record-only retention it needs.
   * @level l1
   * @consumer Inherited checked records that retain immutable sources without branch replay
   */
  test("retains an inherited frozen source without exposing its historical publication", async () => {
    const fixture = recursivePushFixture("before-push-inherited-retention")
    const rootUrl = "https://git-super.test/owned/root.git"
    const childUrl = "https://git-super.test/owned/child.git"
    git(fixture.root, "config", `url.${fixture.rootRemote}.insteadOf`, rootUrl)
    git(fixture.child, "config", `url.${fixture.childRemote}.insteadOf`, childUrl)
    git(fixture.root, "remote", "set-url", "origin", rootUrl)
    const intent = encodePushIntent({
      version: 1,
      rootRemote: rootUrl,
      children: [
        {
          path: "child",
          remote: childUrl,
          pin: fixture.childSource,
          publication: {
            destination: "refs/heads/main",
            source: fixture.childSource,
            expectedDestination: { state: "oid", oid: fixture.childBefore },
          },
        },
      ],
    })
    const merge = git(
      fixture.root,
      "commit-tree",
      `${fixture.rootSource}^{tree}`,
      "-p",
      fixture.rootBefore,
      "-p",
      fixture.rootSource,
      "-m",
      `checked merge\n\n${PUSH_INTENT_TRAILER}: ${intent}`,
    )
    const emptyTree = git(fixture.root, "hash-object", "-w", "-t", "tree", "--stdin")
    const record = git(fixture.root, "commit-tree", emptyTree, "-p", merge, "-m", "retain checked merge")
    const recordRef = "refs/checks/frozen"
    let calls = 0

    const result = await superPush({
      repo: fixture.root,
      remote: "origin",
      refspecs: [`${record}:${recordRef}`],
      recurseSubmodules: "on-demand",
      beforePush: (operation) => {
        calls += 1
        expect(operation.updates).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              repository: fixture.child,
              source: fixture.childSource,
              destination: `refs/git-super/pins/${fixture.childSource}`,
              purpose: "retention",
            }),
            expect.objectContaining({
              repository: fixture.root,
              source: record,
              destination: recordRef,
              purpose: "publication",
            }),
          ]),
        )
        expect(operation.updates).not.toContainEqual(
          expect.objectContaining({
            repository: fixture.child,
            destination: "refs/heads/main",
            purpose: "publication",
          }),
        )
      },
    })

    expect(result).toMatchObject({ state: "updated", partial: false })
    expect(calls).toBe(1)
    expect(git(fixture.childRemote, "rev-parse", `refs/git-super/pins/${fixture.childSource}`)).toBe(
      fixture.childSource,
    )
    expect(git(fixture.childRemote, "rev-parse", "refs/heads/main")).toBe(fixture.childBefore)
    expect(git(fixture.rootRemote, "rev-parse", recordRef)).toBe(record)
  })

  test("reports child success followed by root rejection as partial without rollback", async () => {
    const root = pushFixture("partial-root")
    const child = pushFixture("partial-child")
    const hookDirectory = join(root.repository, ".git", "hooks")
    mkdirSync(hookDirectory, { recursive: true })
    const hook = join(hookDirectory, "pre-push")
    writeFileSync(hook, "#!/bin/sh\necho root-refused >&2\nexit 19\n")
    chmodSync(hook, 0o755)

    const result = await pushRefUpdates({
      root: root.repository,
      updates: [
        update(root.repository, root.remote, root.source, { state: "missing" }),
        update(child.repository, child.remote, child.source, { state: "missing" }),
      ],
    })

    expect(result).toMatchObject({ state: "failed", partial: true })
    expect(result.repositories.map(({ repository, state }) => ({ repository, state }))).toEqual([
      { repository: child.repository, state: "updated" },
      { repository: root.repository, state: "failed" },
    ])
    expect(git(child.remote, "rev-parse", "refs/heads/main")).toBe(child.source)
    expect(git(root.remote, "for-each-ref", "--format=%(refname)", "refs/heads/main")).toBe("")
  })
})
