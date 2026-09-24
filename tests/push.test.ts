import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test, vi } from "vitest"

import { runCli } from "../src/cli.ts"
import { acquireExclusive, createExclusive, type Exclusive } from "../src/exclusive.ts"
import { createLocalGitProcess, type GitProcess } from "../src/process.ts"
import { capturePushIntent, pushRefUpdates, remoteContainsCommit, superPush } from "../src/push.ts"
import { decodePushIntent, encodePushIntent, PUSH_INTENT_TRAILER } from "../src/push-intent.ts"
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

function outputSink(): { output: string; write(value: string): void } {
  return {
    output: "",
    write(value) {
      this.output += value
    },
  }
}

/** A remote read of one destination: the retired whole-advertisement ls-remote, or its by-name dry-run fetch (25570). */
function isObservation(args: readonly string[]): boolean {
  return args[0] === "ls-remote" || (args[0] === "fetch" && args.includes("--dry-run"))
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
    expect(help.output).toContain(
      "to refs/git-super/pins/<sha> unless the root destination is main, which publishes to refs/heads/<branch> from .gitmodules",
    )
    expect(help.output).toContain("only publishes submodules the same way")
    expect(help.output).toContain("no updates only root refs")
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

  // 25570: the child remote advertises every task branch it holds (8,584 heads on hh-dev's origin), so check asks
  // for the ONE commit by SHA instead of listing and fetching every advertised tip. A commit reachable only under a
  // task branch, and not its tip, is the case a tips-only server would wrongly call unavailable.
  test("check asks each child remote for the one commit by SHA, in a throwaway repository it removes", async () => {
    const fixture = recursivePushFixture("check-by-sha")
    const beyond = advanceRepository(fixture.child, "child.txt", "three\n")
    git(fixture.child, "push", "-q", "origin", `${beyond}:refs/heads/task/beyond`)
    for (let index = 0; index < 20; index++) {
      git(fixture.childRemote, "update-ref", `refs/heads/task/crowd-${index}`, fixture.childBefore)
    }
    const local = createLocalGitProcess()
    const requests: { repo: string; args: readonly string[] }[] = []
    const recording: GitProcess = {
      run(request) {
        requests.push({ repo: request.repo, args: request.args })
        return local.run(request)
      },
    }

    const result = await superPush({
      repo: fixture.root,
      recurseSubmodules: "check",
      remote: "origin",
      refspecs: ["HEAD:refs/heads/main"],
      git: recording,
    })

    expect(result).toMatchObject({ state: "updated", partial: false })
    expect(git(fixture.rootRemote, "rev-parse", "refs/heads/main")).toBe(fixture.rootSource)
    // The root push still observes its own destination; the child is asked nothing but the one commit.
    expect(requests.filter(({ repo, args }) => repo === fixture.child && args[0] === "ls-remote")).toEqual([])
    const asked = requests.filter(({ repo, args }) => repo !== fixture.root && args[0] === "fetch")
    expect(asked.map(({ args }) => args.at(-1))).toEqual([fixture.childSource])
    expect(asked[0]?.args).toEqual(expect.arrayContaining(["--depth=1", "--filter=tree:0", "--no-tags"]))
    expect(asked[0]?.repo).not.toBe(fixture.child)
    expect(existsSync(asked[0]?.repo ?? fixture.child)).toBe(false)
  })

  test("check fails loud, and still removes its throwaway repository, when a child remote cannot answer", async () => {
    const fixture = recursivePushFixture("check-unreachable")
    git(fixture.child, "remote", "set-url", "origin", join(fixture.fixture, "no-such-remote.git"))
    const local = createLocalGitProcess()
    const probes: string[] = []
    const recording: GitProcess = {
      run(request) {
        if (request.args[0] === "fetch") probes.push(request.repo)
        return local.run(request)
      },
    }

    const result = await superPush({
      repo: fixture.root,
      recurseSubmodules: "check",
      remote: "origin",
      refspecs: ["HEAD:refs/heads/main"],
      git: recording,
    })

    expect(result).toMatchObject({ state: "failed", detail: { code: "submodule-availability-unknown" } })
    expect(result.detail?.message).toContain("no-such-remote.git")
    expect(git(fixture.rootRemote, "rev-parse", "refs/heads/main")).toBe(fixture.rootBefore)
    expect(probes).toHaveLength(1)
    expect(existsSync(probes[0] ?? fixture.child)).toBe(false)
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

  // 25570: `ls-remote <remote> <ref>` filters on the client, so each observation carried the remote's whole
  // advertisement. Observed by name, a destination advertises itself and nothing else, and writes no local ref.
  test("observes a destination by name: only that ref is advertised, and no local ref is written", async () => {
    const { fixture, repository, remote, source } = pushFixture("observe-by-name")
    git(repository, "push", "-q", remote, `${source}:refs/heads/task/seed`)
    for (let index = 0; index < 30; index++) git(remote, "update-ref", `refs/heads/task/crowd-${index}`, source)
    const packets = join(fixture, "observe-packets.log")
    writeFileSync(packets, "")
    const local = createLocalGitProcess()
    const observations: string[][] = []
    const traced: GitProcess = {
      run(request) {
        if (request.args[0] === "ls-remote") throw new Error(`observed with ls-remote: ${request.args.join(" ")}`)
        if (!isObservation(request.args)) return local.run(request)
        observations.push([...request.args])
        return local.run({ ...request, env: { ...request.env, GIT_TRACE_PACKET: packets } })
      },
    }

    const result = await pushRefUpdates({
      root: repository,
      updates: [update(repository, remote, source, { state: "missing" })],
      git: traced,
    })

    expect(result).toMatchObject({ state: "updated", partial: false })
    expect(git(remote, "rev-parse", "refs/heads/main")).toBe(source)
    expect(observations.length).toBeGreaterThanOrEqual(2)
    for (const args of observations) expect(args.at(-1)).toMatch(/^\+refs\/heads\/main:refs\/git-super\/observed\//u)
    const advertised = readFileSync(packets, "utf8")
      .split("\n")
      .filter((line) => /packet:.*< [0-9a-f]{40} refs\//u.test(line))
    // Absent before the write (nothing advertised), present after it (main alone), never a crowd branch.
    expect(advertised.length).toBeGreaterThanOrEqual(1)
    expect(advertised.every((line) => line.endsWith(" refs/heads/main"))).toBe(true)
    expect(git(repository, "for-each-ref", "--format=%(refname)", "refs/git-super/observed")).toBe("")
  })

  test("preserves a successful write as unknown when post-push observation fails", async () => {
    const { repository, remote, source } = pushFixture("post-write-observation")
    const local = createLocalGitProcess()
    let observations = 0
    const unreadableAfterWrite: GitProcess = {
      async run(request) {
        if (isObservation(request.args)) {
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

  /**
   * 24901: a root push to refs/heads/task/x while a child tracks origin/main
   * must leave that child's origin main unchanged. Before the fix, childUpdate
   * read .gitmodules branch=main and sent the child commit to refs/heads/main
   * regardless of the root destination.
   *
   * @failure A task-branch push silently advances every child's main.
   * @level l1
   * @consumer 24901 regression — git-super push to a non-main root destination
   */
  test.each(["on-demand", "only"] as const)(
    "%s to a task branch leaves the child's main unchanged (24901)",
    async (mode) => {
      const fixture = recursivePushFixture(`task-branch-child-main-${mode}`)

      const result = await superPush({
        repo: fixture.root,
        remote: "origin",
        refspecs: [`${fixture.rootSource}:refs/heads/task/feature-x`],
        recurseSubmodules: mode,
      })

      // The child's main must not have moved.
      expect(git(fixture.childRemote, "rev-parse", "refs/heads/main")).toBe(fixture.childBefore)

      // The child commit must be reachable somewhere (pins ref or the task branch itself).
      const childPinRef = `refs/git-super/pins/${fixture.childSource}`
      const childReachable =
        git(fixture.childRemote, "for-each-ref", "--format=%(refname)", childPinRef) === childPinRef
      expect(childReachable).toBe(true)

      // The root task branch was created (on-demand pushes root too; only does not).
      if (mode === "on-demand") {
        expect(git(fixture.rootRemote, "rev-parse", "refs/heads/task/feature-x")).toBe(fixture.rootSource)
      }
      expect(result.state).not.toBe("failed")
    },
  )

  /**
   * Control for 24901: the queue's publication to main still moves each child's
   * main to the merged commit — the non-main guard does not break the happy path.
   *
   * @level l1
   * @consumer Queue publication to main with recursive child forwarding
   */
  test.each(["on-demand", "only"] as const)(
    "%s to main still forwards the child's main (24901 control)",
    async (mode) => {
      const fixture = recursivePushFixture(`main-child-forward-${mode}`)

      const result = await superPush({
        repo: fixture.root,
        remote: "origin",
        refspecs: [`${fixture.rootSource}:refs/heads/main`],
        recurseSubmodules: mode,
      })

      // The child's main must have advanced.
      expect(git(fixture.childRemote, "rev-parse", "refs/heads/main")).toBe(fixture.childSource)
      expect(result.state).toBe("updated")
    },
  )

  /**
   * 24901 row 4: push reports every ref it moved, by repository and ref name.
   *
   * @level l1
   * @consumer 24901 row 4 — reporting of moved refs
   */
  test("push reports every ref it moved by repository and ref name (24901)", async () => {
    const fixture = recursivePushFixture("report-moved-refs")

    const result = await superPush({
      repo: fixture.root,
      remote: "origin",
      refspecs: [`${fixture.rootSource}:refs/heads/task/feature-x`],
      recurseSubmodules: "on-demand",
    })

    expect(result.state).toBe("updated")
    const movedRefs = result.repositories.flatMap((repo) =>
      repo.refs
        .filter((ref) => ref.state === "updated")
        .map((ref) => ({ repository: repo.repository, destination: ref.destination })),
    )
    expect(movedRefs).toEqual([
      { repository: fixture.child, destination: `refs/git-super/pins/${fixture.childSource}` },
      { repository: fixture.root, destination: "refs/heads/task/feature-x" },
    ])
  })

  test("CLI push reports every ref it moved by repository and ref name (24901)", async () => {
    const fixture = recursivePushFixture("cli-report-moved-refs")
    const stdout = outputSink()
    const stderr = outputSink()

    expect(
      await runCli(
        [
          "--repo",
          fixture.root,
          "push",
          "--recurse-submodules=on-demand",
          "origin",
          `${fixture.rootSource}:refs/heads/task/feature-x`,
        ],
        stdout,
        stderr,
      ),
    ).toBe(0)

    expect(stdout.output).toContain(fixture.child)
    expect(stdout.output).toContain(`refs/git-super/pins/${fixture.childSource}`)
    expect(stdout.output).toContain(fixture.root)
    expect(stdout.output).toContain("refs/heads/task/feature-x")
    expect(stderr.output).toBe("")
  })

  test("CLI push uses the pull progress switch and writes phase/count only when enabled", async () => {
    const { repository, remote, source } = pushFixture("cli-progress")
    const stdout = outputSink()
    const stderr = outputSink()
    vi.stubEnv("GIT_SUPER_PROGRESS", "1")
    try {
      expect(
        await runCli(
          ["--repo", repository, "push", "--recurse-submodules=no", remote, `${source}:refs/heads/main`],
          stdout,
          stderr,
        ),
      ).toBe(0)
    } finally {
      vi.unstubAllEnvs()
    }
    expect(stderr.output).toMatch(/git-super push: select-root 0\/1 \+\d+ms/u)
    expect(stderr.output).toMatch(/git-super push: write-remote 0\/1 \+\d+ms/u)
  })

  /**
   * 24901 R9: a mixed root push containing both an unchanged root main and a task
   * branch that introduces or updates a child must leave that child's remote main
   * unchanged. Before the fix, rootTargetsMain checked whether ANY root destination
   * was refs/heads/main, which advanced child main to the task-only commit.
   *
   * @failure Mixed-ref push advances child main to task-only commit.
   * @level l1
   * @consumer 24901 R9 regression — mixed-ref root push child isolation
   */
  test("mixed root push leaves child main unchanged and publishes task pin (24901 R9)", async () => {
    const fixture = recursivePushFixture("mixed-root-push-r9")

    const result = await superPush({
      repo: fixture.root,
      remote: "origin",
      recurseSubmodules: "on-demand",
      refspecs: [`${fixture.rootBefore}:refs/heads/main`, `${fixture.rootSource}:refs/heads/task/new-feature`],
    })

    // Child remote main must not move to childSource
    expect(git(fixture.childRemote, "rev-parse", "refs/heads/main")).toBe(fixture.childBefore)

    // Child remote pin must be created for the task's child commit
    const childPinRef = `refs/git-super/pins/${fixture.childSource}`
    expect(git(fixture.childRemote, "for-each-ref", "--format=%(refname)", childPinRef)).toBe(childPinRef)

    // Root remote main remains at rootBefore, root remote task branch points to rootSource
    expect(git(fixture.rootRemote, "rev-parse", "refs/heads/main")).toBe(fixture.rootBefore)
    expect(git(fixture.rootRemote, "rev-parse", "refs/heads/task/new-feature")).toBe(fixture.rootSource)
    expect(result.state).not.toBe("failed")
  })

  /**
   * 24901 R9 control: mixed root push with shared child forwards child main when
   * the updated child commit is required by root main as well as task refs.
   *
   * @level l1
   * @consumer 24901 R9 shared-child control — identical child commit
   */
  test("mixed root push with shared child forwards child main when required by main (24901 control)", async () => {
    const fixture = recursivePushFixture("mixed-root-shared-child")

    const result = await superPush({
      repo: fixture.root,
      remote: "origin",
      recurseSubmodules: "on-demand",
      refspecs: [`${fixture.rootSource}:refs/heads/main`, `${fixture.rootSource}:refs/heads/task/feature-shared`],
    })

    // Because root main requires childSource, child main forwards to childSource
    expect(git(fixture.childRemote, "rev-parse", "refs/heads/main")).toBe(fixture.childSource)
    expect(git(fixture.rootRemote, "rev-parse", "refs/heads/main")).toBe(fixture.rootSource)
    expect(git(fixture.rootRemote, "rev-parse", "refs/heads/task/feature-shared")).toBe(fixture.rootSource)
    expect(result.state).toBe("updated")
  })

  /**
   * 24901 R9 control: mixed root push with divergent child commits forwards child
   * main to the commit required by root main and publishes a pin for the task-only commit.
   *
   * @level l1
   * @consumer 24901 R9 shared-child control — divergent child commits
   */
  test("mixed root push with divergent child commits forwards main commit and pins task commit (24901 control)", async () => {
    const fixture = recursivePushFixture("mixed-root-divergent-child")

    const childTaskCommit = advanceRepository(fixture.child, "child.txt", "three-task\n")
    git(fixture.root, "add", "child")
    git(fixture.root, "commit", "-q", "-m", "root task with child three")
    const rootTaskSource = git(fixture.root, "rev-parse", "HEAD")

    const result = await superPush({
      repo: fixture.root,
      remote: "origin",
      recurseSubmodules: "on-demand",
      refspecs: [`${fixture.rootSource}:refs/heads/main`, `${rootTaskSource}:refs/heads/task/feature-divergent`],
    })

    // Child remote main must advance to childSource (required by root main), NOT childTaskCommit
    expect(git(fixture.childRemote, "rev-parse", "refs/heads/main")).toBe(fixture.childSource)

    // Child remote pin must exist for childTaskCommit (required only by root task)
    const taskPinRef = `refs/git-super/pins/${childTaskCommit}`
    expect(git(fixture.childRemote, "for-each-ref", "--format=%(refname)", taskPinRef)).toBe(taskPinRef)

    expect(git(fixture.rootRemote, "rev-parse", "refs/heads/main")).toBe(fixture.rootSource)
    expect(git(fixture.rootRemote, "rev-parse", "refs/heads/task/feature-divergent")).toBe(rootTaskSource)
    expect(result.state).toBe("updated")
  })
})

/**
 * @i/10-yrd/25303. A queue merge that moves ONE of a root's children froze a
 * publication row for every child, and `git super push` worked through all of
 * them: 16 retentions, 16 child mains observed twice, a fetch-back per pin and
 * two spawns per advertised root ref. These fixtures give a root two owned
 * children and a frozen merge that moves only `child`; `other` keeps its pin.
 * `childMain` shapes the moved child's remote main at capture: at its pin
 * (`pinned`), run ahead by a direct push that the new pin contains (`ahead`),
 * or diverged from the pinned history (`diverged`).
 */
function twoChildFrozenMerge(name: string, childMain: "pinned" | "ahead" | "diverged" = "pinned") {
  const fixture = mkdtempSync(join(tmpdir(), `git-super-push-25303-${name}-`))
  roots.push(fixture)
  const hosted = (repo: string) => `https://git-super.test/owned/${repo}.git`
  const remotes = {
    root: join(fixture, "root.git"),
    child: join(fixture, "child.git"),
    other: join(fixture, "other.git"),
  }
  const before: Record<"child" | "other", string> = { child: "", other: "" }
  for (const name of ["child", "other"] as const) {
    const seed = join(fixture, `${name}-seed`)
    git(fixture, "init", "--bare", "-q", "-b", "main", remotes[name])
    before[name] = createRepository(seed, `${name}.txt`, "one\n")
    git(seed, "remote", "add", "origin", remotes[name])
    git(seed, "push", "-q", "-u", "origin", "main")
  }
  const root = join(fixture, "root")
  git(fixture, "init", "--bare", "-q", "-b", "main", remotes.root)
  mkdirSync(root, { recursive: true })
  git(root, "init", "-q", "-b", "main")
  for (const name of ["child", "other"] as const) {
    git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", remotes[name], name)
  }
  git(root, "commit", "-q", "-am", "root one")
  const rootBefore = git(root, "rev-parse", "HEAD")
  git(root, "remote", "add", "origin", remotes.root)
  git(root, "push", "-q", "-u", "origin", "main")

  const child = join(root, "child")
  let expected = before.child
  if (childMain === "ahead") {
    expected = advanceRepository(child, "child.txt", "ahead\n")
    git(child, "push", "-q", remotes.child, `${expected}:refs/heads/main`)
  }
  const childSource = advanceRepository(child, "child.txt", "two\n")
  if (childMain === "diverged") {
    const elsewhere = join(fixture, "child-elsewhere")
    git(fixture, "clone", "-q", remotes.child, elsewhere)
    expected = advanceRepository(elsewhere, "child.txt", "diverged\n")
    git(elsewhere, "push", "-q", "origin", `${expected}:refs/heads/main`)
  }
  git(root, "add", "child")
  git(root, "commit", "-q", "-m", "move child only")
  for (const name of ["root", "child", "other"] as const) {
    const repo = name === "root" ? root : join(root, name)
    for (const target of ["root", "child", "other"] as const) {
      git(repo, "config", `url.${remotes[target]}.insteadOf`, hosted(target))
    }
  }
  git(root, "remote", "set-url", "origin", hosted("root"))
  for (const name of ["child", "other"] as const) git(join(root, name), "remote", "set-url", "origin", hosted(name))
  git(root, "config", "--file", ".gitmodules", "submodule.child.url", hosted("child"))
  git(root, "config", "--file", ".gitmodules", "submodule.other.url", hosted("other"))
  git(root, "commit", "-q", "-am", "declare hosted identities")
  const candidate = git(root, "rev-parse", "HEAD")
  // The intent exactly as capture froze it before 25303: a publication row for
  // EVERY owned child, the unchanged one a no-op at its own main.
  const encoded = encodePushIntent({
    version: 1,
    rootRemote: hosted("root"),
    children: [
      {
        path: "child",
        remote: hosted("child"),
        pin: childSource,
        publication: {
          destination: "refs/heads/main",
          source: childSource,
          expectedDestination: { state: "oid", oid: expected },
        },
      },
      {
        path: "other",
        remote: hosted("other"),
        pin: before.other,
        publication: {
          destination: "refs/heads/main",
          source: before.other,
          expectedDestination: { state: "oid", oid: before.other },
        },
      },
    ],
  })
  const merge = git(
    root,
    "commit-tree",
    `${candidate}^{tree}`,
    "-p",
    rootBefore,
    "-p",
    candidate,
    "-m",
    `checked merge\n\n${PUSH_INTENT_TRAILER}: ${encoded}`,
  )
  const emptyTree = git(root, "hash-object", "-w", "-t", "tree", "--stdin")
  // A record retaining the merge: its push takes the OBSERVED path, because
  // its direct source carries no intent.
  const record = git(root, "commit-tree", emptyTree, "-p", merge, "-m", "retain checked merge")
  const calls: { args: string[]; repo: string }[] = []
  let inFlight = 0
  let maxObserveInFlight = 0
  const local = createLocalGitProcess()
  const recording: GitProcess = {
    run: async (request) => {
      calls.push({ args: [...request.args], repo: request.repo })
      const observe = isObservation(request.args)
      if (observe) maxObserveInFlight = Math.max(maxObserveInFlight, ++inFlight)
      try {
        return await local.run(request)
      } finally {
        if (observe) inFlight -= 1
      }
    },
  }
  const moveMain = (repo: "child" | "other"): string => {
    const tree = git(remotes[repo], "hash-object", "-w", "-t", "tree", "--stdin")
    const moved = git(remotes[repo], "commit-tree", tree, "-m", "moved outside the queue")
    git(remotes[repo], "update-ref", "refs/heads/main", moved)
    return moved
  }
  return {
    fixture,
    root,
    remotes,
    hosted,
    before,
    expected,
    rootBefore,
    childSource,
    merge,
    record,
    calls,
    moveMain,
    maxObserveInFlight: () => maxObserveInFlight,
    /** One frozen merge to main: the leased path, yrd's publish command. */
    push: () =>
      superPush({
        repo: root,
        remote: "origin",
        refspecs: [`${merge}:refs/heads/main`],
        recurseSubmodules: "only",
        git: recording,
      }),
    /** The merge to main plus its record: the observed path. */
    pushWithRecord: () =>
      superPush({
        repo: root,
        remote: "origin",
        refspecs: [`${merge}:refs/heads/main`, `${record}:refs/checks/retained`],
        recurseSubmodules: "only",
        git: recording,
      }),
  }
}

describe("a frozen push works only on the children its merge moved (25303, observed path)", () => {
  test("publishes and retains the moved child and never asks the unchanged one's remote", async () => {
    const shape = twoChildFrozenMerge("moved-only")
    const elsewhere = shape.moveMain("other")

    expect(await shape.pushWithRecord()).toMatchObject({ state: "updated", partial: false })

    expect(git(shape.remotes.child, "rev-parse", "refs/heads/main")).toBe(shape.childSource)
    expect(git(shape.remotes.child, "rev-parse", `refs/git-super/pins/${shape.childSource}`)).toBe(shape.childSource)
    expect(git(shape.remotes.other, "rev-parse", "refs/heads/main")).toBe(elsewhere)
    expect(git(shape.remotes.other, "for-each-ref", "--format=%(refname)", "refs/git-super/pins")).toBe("")
    const touchingOther = shape.calls.filter(({ args }) => args.some((arg) => arg.includes(shape.hosted("other"))))
    expect(touchingOther).toEqual([])
    // The moved child's main is observed once per plan and once after its
    // push, never twice in one plan.
    const childMainReads = shape.calls.filter(
      ({ args }) =>
        isObservation(args) &&
        args.includes(shape.hosted("child")) &&
        args.some((arg) => arg.startsWith("+refs/heads/main:")),
    )
    expect(childMainReads.length).toBe(4)
  })

  test("does not fetch back a pin the retention push found already at its source", async () => {
    const shape = twoChildFrozenMerge("retained")
    const pinRef = `refs/git-super/pins/${shape.childSource}`
    git(join(shape.root, "child"), "push", "-q", shape.remotes.child, `${shape.childSource}:${pinRef}`)

    expect(await shape.pushWithRecord()).toMatchObject({ state: "updated", partial: false })

    expect(git(shape.remotes.child, "rev-parse", "refs/heads/main")).toBe(shape.childSource)
    const fetchBack = shape.calls.filter(({ args }) => args[0] === "fetch" && args.includes(pinRef))
    expect(fetchBack).toEqual([])
  })

  test("reads the root's advertisement in a fixed number of processes, however many refs it has", async () => {
    const shape = twoChildFrozenMerge("advertisement")
    for (let index = 0; index < 40; index += 1) {
      git(shape.remotes.root, "update-ref", `refs/heads/extra-${index}`, shape.rootBefore)
    }
    // Three advertised refs whose commits this clone has never seen.
    const foreign = join(shape.fixture, "foreign")
    git(shape.fixture, "clone", "-q", shape.remotes.root, foreign)
    const unseen = [0, 1, 2].map((index) => {
      const commit = advanceRepository(foreign, "foreign.txt", `foreign ${index}\n`)
      git(foreign, "push", "-q", "origin", `${commit}:refs/heads/foreign-${index}`)
      return commit
    })
    expect(() => git(shape.root, "cat-file", "-e", `${unseen[0]}^{commit}`)).toThrow()

    expect(await shape.pushWithRecord()).toMatchObject({ state: "updated", partial: false })

    const inRoot = shape.calls.filter(({ repo }) => repo === shape.root)
    const perRef = inRoot.filter(
      ({ args }) =>
        (args[0] === "cat-file" && args[1] === "-e" && args[2]?.endsWith("^{object}")) ||
        (args[0] === "rev-parse" && args[1]?.endsWith("^{commit}")),
    )
    // The plan still checks each pushed source once; what may not appear is a spawn per advertised ref
    // (45 refs here, two spawns each before 25303).
    expect(perRef.length).toBeLessThan(5)
    const foreignFetches = inRoot.filter(
      ({ args }) => args[0] === "fetch" && args.some((arg) => arg.startsWith("refs/heads/foreign-")),
    )
    expect(foreignFetches).toHaveLength(1)
    expect(foreignFetches[0]?.args.filter((arg) => arg.startsWith("refs/heads/foreign-")).sort()).toEqual([
      "refs/heads/foreign-0",
      "refs/heads/foreign-1",
      "refs/heads/foreign-2",
    ])
    for (const commit of unseen) expect(git(shape.root, "cat-file", "-t", commit)).toBe("commit")
  })

  test("uses one object batch when every advertised ref is present", async () => {
    const shape = twoChildFrozenMerge("present-batch")
    expect(await shape.pushWithRecord()).toMatchObject({ state: "updated" })
    const batches = shape.calls.filter(
      ({ repo, args }) => repo === shape.root && args[0] === "cat-file" && args[1]?.startsWith("--batch-check"),
    )
    expect(batches).toHaveLength(1)
  })

  test("refuses an advertised object still missing after a successful fetch", async () => {
    const { fixture, repository, remote, source } = pushFixture("missing-after-fetch")
    git(repository, "remote", "add", "origin", remote)
    git(repository, "push", "-q", "origin", `${source}:refs/heads/main`)
    const foreign = join(fixture, "foreign")
    git(fixture, "clone", "-q", remote, foreign)
    const missing = advanceRepository(foreign, "foreign.txt", "unseen\n")
    git(foreign, "push", "-q", "origin", `${missing}:refs/heads/foreign`)
    const local = createLocalGitProcess()
    const withoutFetch: GitProcess = {
      run(request) {
        if (request.args[0] === "fetch") return Promise.resolve({ code: 0, stdout: "", stderr: "" })
        return local.run(request)
      },
    }
    await expect(
      remoteContainsCommit({ repository, remote: "origin", commit: source, git: withoutFetch }),
    ).rejects.toThrow(new RegExp(`${missing}.*refs/heads/foreign.*origin.*remains missing`, "u"))
  })

  test("peels a fetched annotated tag in the second batch without rereading present refs", async () => {
    const { fixture, repository, remote, source } = pushFixture("fetched-tag")
    git(repository, "remote", "add", "origin", remote)
    git(repository, "push", "-q", "origin", `${source}:refs/heads/main`)
    const foreign = join(fixture, "tag-author")
    git(fixture, "clone", "-q", remote, foreign)
    git(foreign, "tag", "-a", "release", source, "-m", "release")
    git(foreign, "push", "-q", "origin", "refs/tags/release")
    const local = createLocalGitProcess()
    const batches: string[] = []
    const counting: GitProcess = {
      run(request) {
        if (request.args[0] === "cat-file" && request.args[1]?.startsWith("--batch-check")) {
          batches.push(request.stdin ?? "")
        }
        return local.run(request)
      },
    }
    expect(await remoteContainsCommit({ repository, remote: "origin", commit: source, git: counting })).toBe(true)
    expect(batches).toHaveLength(2)
    expect(batches[1]?.trim().split("\n")).toHaveLength(2)
    expect(batches[1]).toContain(`${git(foreign, "rev-parse", "refs/tags/release")}^{commit}`)
  })

  test("keeps Git process count bounded as advertised refs grow", async () => {
    const countFor = async (count: number): Promise<{ calls: number; batches: number }> => {
      const { repository, remote, source } = pushFixture(`ref-count-${count}`)
      git(repository, "remote", "add", "origin", remote)
      git(repository, "push", "-q", "origin", `${source}:refs/heads/main`)
      for (let index = 1; index < count; index++) git(remote, "update-ref", `refs/heads/tip-${index}`, source)
      const local = createLocalGitProcess()
      let calls = 0
      let batches = 0
      const counting: GitProcess = {
        run(request) {
          calls++
          if (request.args[0] === "cat-file" && request.args[1]?.startsWith("--batch-check")) batches++
          return local.run(request)
        },
      }
      expect(await remoteContainsCommit({ repository, remote: "origin", commit: source, git: counting })).toBe(true)
      return { calls, batches }
    }
    const one = await countFor(1)
    const many = await countFor(64)
    expect(many.calls - one.calls).toBeLessThan(5)
    expect(many.batches).toBe(1)
  }, 30_000)

  test("keeps Git process count bounded as newly reachable merges grow", async () => {
    const countFor = async (count: number): Promise<number> => {
      const { repository, remote, source } = pushFixture(`merge-count-${count}`)
      git(repository, "push", "-q", remote, `${source}:refs/heads/main`)
      const tree = git(repository, "rev-parse", `${source}^{tree}`)
      const side = git(repository, "commit-tree", tree, "-p", source, "-m", "side")
      let head = source
      for (let index = 0; index < count; index++) {
        head = git(repository, "commit-tree", tree, "-p", head, "-p", side, "-m", `merge ${index}`)
      }
      const local = createLocalGitProcess()
      let calls = 0
      const counting: GitProcess = {
        run(request) {
          calls++
          return local.run(request)
        },
      }
      expect(
        (
          await superPush({
            repo: repository,
            remote,
            refspecs: [`${head}:refs/heads/main`],
            recurseSubmodules: "on-demand",
            git: counting,
          })
        ).state,
      ).toBe("updated")
      return calls
    }
    expect((await countFor(16)) - (await countFor(1))).toBeLessThan(5)
  }, 30_000)

  test.each(["plan", "recheck"] as const)(
    "reports phase and count within 10 seconds through %s until first write",
    async (stage) => {
      const { repository, remote, source } = pushFixture(`progress-${stage}`)
      const local = createLocalGitProcess()
      let release: (() => void) | undefined
      let reached!: () => void
      const held = new Promise<void>((resolve) => {
        reached = resolve
      })
      let observations = 0
      let writes = 0
      const stalled: GitProcess = {
        run(request) {
          if (isObservation(request.args)) {
            observations++
            if ((stage === "plan" && observations === 1) || (stage === "recheck" && observations === 2)) {
              reached()
              return new Promise((resolve) => {
                release = () => void local.run(request).then(resolve)
              })
            }
          }
          if (request.args[0] === "push") writes++
          return local.run(request)
        },
      }
      const reports: string[] = []
      vi.useFakeTimers()
      try {
        const operation = superPush({
          repo: repository,
          remote,
          refspecs: [`${source}:refs/heads/main`],
          recurseSubmodules: "no",
          git: stalled,
          report: (line) => reports.push(line),
        })
        await held
        await vi.advanceTimersByTimeAsync(stage === "plan" ? 25_000 : 10_000)
        expect(writes).toBe(0)
        expect(reports.some((line) => /git-super push: .*\d+\/\d+ \+9000ms/u.test(line))).toBe(true)
        if (stage === "plan") {
          expect(reports.some((line) => /git-super push: .*\d+\/\d+ \+18000ms/u.test(line))).toBe(true)
        }
        release?.()
        await expect(operation).resolves.toMatchObject({ state: "updated" })
        const count = reports.length
        await vi.advanceTimersByTimeAsync(20_000)
        expect(reports).toHaveLength(count)
      } finally {
        release?.()
        vi.useRealTimers()
      }
    },
    30_000,
  )

  test("reports a held writer lock within ten seconds despite timer jitter", async () => {
    const { repository, remote, source } = pushFixture("progress-lock")
    let release: (() => void) | undefined
    let reached!: () => void
    const held = new Promise<void>((resolve) => {
      reached = resolve
    })
    const exclusive: Exclusive = {
      run(operation) {
        reached()
        return new Promise((resolve, reject) => {
          release = () => void operation().then(resolve, reject)
        })
      },
    }
    const reports: string[] = []
    vi.useFakeTimers()
    // A nominal 10s interval fires late under load; the heartbeat needs room for that delay.
    const originalSetInterval = globalThis.setInterval
    const jitteredInterval = vi
      .spyOn(globalThis, "setInterval")
      .mockImplementation((callback, delay, ...args) => originalSetInterval(callback, Number(delay) + 500, ...args))
    try {
      const operation = superPush({
        repo: repository,
        remote,
        refspecs: [`${source}:refs/heads/main`],
        recurseSubmodules: "no",
        exclusive,
        report: (line) => reports.push(line),
      })
      await held
      await vi.advanceTimersByTimeAsync(10_000)
      expect(reports).toContain("git-super push: wait-writer-lock 0/1 +9500ms\n")
      release?.()
      await expect(operation).resolves.toMatchObject({ state: "updated" })
    } finally {
      release?.()
      jitteredInterval.mockRestore()
      vi.useRealTimers()
    }
  }, 30_000)

  test("capture asks the one changed-set rule: an unchanged child whose main diverged freezes no publication", async () => {
    const shape = twoChildFrozenMerge("capture")
    shape.moveMain("other")
    const tree = git(shape.root, "rev-parse", `${shape.merge}^{tree}`)

    const encoded = await capturePushIntent(
      createLocalGitProcess(),
      shape.root,
      shape.rootBefore,
      tree,
      new Map(),
      30_000,
    )

    const intent = decodePushIntent(encoded ?? "")
    expect(intent.children.find((row) => row.path === "other")).toEqual({
      path: "other",
      remote: shape.hosted("other"),
      pin: shape.before.other,
    })
    expect(intent.children.find((row) => row.path === "child")?.publication).toMatchObject({
      destination: "refs/heads/main",
      source: shape.childSource,
    })
  })

  test("observes a plan's destinations concurrently, at most four at a time", async () => {
    const shape = twoChildFrozenMerge("concurrent")

    expect(await shape.pushWithRecord()).toMatchObject({ state: "updated", partial: false })

    expect(shape.maxObserveInFlight()).toBeGreaterThan(1)
    expect(shape.maxObserveInFlight()).toBeLessThanOrEqual(4)
  })
})

describe("one frozen merge to main is published by leased pushes alone (25303 item 9)", () => {
  const pushesIn = (shape: ReturnType<typeof twoChildFrozenMerge>) =>
    shape.calls.filter(({ args }) => args[0] === "push")

  test("(a) a one-gitlink merge makes no ls-remote and exactly one push, to the moved child", async () => {
    const shape = twoChildFrozenMerge("leased")
    const elsewhere = shape.moveMain("other")

    expect(await shape.push()).toMatchObject({ state: "updated", partial: false })

    expect(shape.calls.filter(({ args }) => isObservation(args))).toEqual([])
    const pushes = pushesIn(shape)
    expect(pushes).toHaveLength(1)
    expect(pushes[0]?.args).toEqual(
      expect.arrayContaining([
        "--atomic",
        `--force-with-lease=refs/heads/main:${shape.before.child}`,
        shape.hosted("child"),
        `${shape.childSource}:refs/git-super/pins/${shape.childSource}`,
        `${shape.childSource}:refs/heads/main`,
      ]),
    )
    expect(git(shape.remotes.child, "rev-parse", "refs/heads/main")).toBe(shape.childSource)
    expect(git(shape.remotes.child, "rev-parse", `refs/git-super/pins/${shape.childSource}`)).toBe(shape.childSource)
    expect(git(shape.remotes.other, "rev-parse", "refs/heads/main")).toBe(elsewhere)
    expect(git(shape.remotes.root, "rev-parse", "refs/heads/main")).toBe(shape.rootBefore)
  })

  test("(b) a child main moved after capture is refused at the push, naming the ref and its holder", async () => {
    const shape = twoChildFrozenMerge("moved-after-capture")
    const holder = shape.moveMain("child")

    const result = await shape.push()

    expect(result).toMatchObject({
      state: "failed",
      detail: { code: "destination-changed", phase: "leased-child-push" },
    })
    expect(result.detail?.message).toContain("refs/heads/main")
    expect(result.detail?.message).toContain(`the remote holds oid:${holder}`)
    expect(result.detail?.message).toContain(`expected oid:${shape.before.child}`)
    expect(git(shape.remotes.child, "rev-parse", "refs/heads/main")).toBe(holder)
    // Atomic: the pin in the same push was not written either.
    expect(git(shape.remotes.child, "for-each-ref", "--format=%(refname)", "refs/git-super/pins")).toBe("")
    expect(pushesIn(shape)).toHaveLength(1)
  })

  test("(c) a child main that ran ahead but lies in the new pin's history lands through the lease", async () => {
    const shape = twoChildFrozenMerge("ran-ahead", "ahead")
    expect(git(shape.remotes.child, "rev-parse", "refs/heads/main")).toBe(shape.expected)
    expect(shape.expected).not.toBe(shape.before.child)

    expect(await shape.push()).toMatchObject({ state: "updated", partial: false })

    expect(git(shape.remotes.child, "rev-parse", "refs/heads/main")).toBe(shape.childSource)
    expect(shape.calls.filter(({ args }) => isObservation(args))).toEqual([])
  })

  test("(d) a diverged child main is refused BEFORE any push, naming the three commits", async () => {
    const shape = twoChildFrozenMerge("diverged", "diverged")

    const result = await shape.push()

    expect(result).toMatchObject({
      state: "failed",
      detail: { code: "diverged-pin", phase: "leased-child-fast-forward" },
    })
    for (const oid of [shape.expected, shape.childSource]) expect(result.detail?.message).toContain(oid)
    expect(result.detail?.objectIds).toEqual([shape.expected, shape.childSource, shape.childSource])
    expect(pushesIn(shape)).toEqual([])
    expect(git(shape.remotes.child, "rev-parse", "refs/heads/main")).toBe(shape.expected)
  })

  test("re-running a landed publication is an identical no-op through the same leased push", async () => {
    const shape = twoChildFrozenMerge("resume")
    expect(await shape.push()).toMatchObject({ state: "updated", partial: false })
    shape.calls.length = 0

    // Git reports a ref that already holds the pushed value as up to date, lease
    // or not, so the retry settles as unchanged with no read and no write.
    const again = await shape.push()

    expect(again).toMatchObject({ state: "unchanged", partial: false })
    expect(shape.calls.filter(({ args }) => isObservation(args))).toEqual([])
    expect(git(shape.remotes.child, "rev-parse", "refs/heads/main")).toBe(shape.childSource)
  })
})

describe("a nested gitlink counts as moved only when its own pin moved (25303, review of P1)", () => {
  test("capture freezes no publication for a nested child whose parent moved but whose own pin did not", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "git-super-push-25303-nested-"))
    roots.push(fixture)
    const hosted = (repo: string) => `https://git-super.test/owned/${repo}.git`
    const remotes = {
      root: join(fixture, "root.git"),
      child: join(fixture, "child.git"),
      leaf: join(fixture, "leaf.git"),
    }
    const allow = ["-c", "protocol.file.allow=always"]

    git(fixture, "init", "--bare", "-q", "-b", "main", remotes.leaf)
    const leafSeed = join(fixture, "leaf-seed")
    const leafFirst = createRepository(leafSeed, "leaf.txt", "zero\n")
    const leafPin = advanceRepository(leafSeed, "leaf.txt", "one\n")
    git(leafSeed, "push", "-q", remotes.leaf, "main")

    git(fixture, "init", "--bare", "-q", "-b", "main", remotes.child)
    const childSeed = join(fixture, "child-seed")
    createRepository(childSeed, "child.txt", "one\n")
    git(childSeed, ...allow, "submodule", "add", "-q", remotes.leaf, "leaf")
    git(childSeed, "commit", "-q", "-am", "add leaf")
    git(childSeed, "push", "-q", remotes.child, "main")

    git(fixture, "init", "--bare", "-q", "-b", "main", remotes.root)
    const root = join(fixture, "root")
    mkdirSync(root, { recursive: true })
    git(root, "init", "-q", "-b", "main")
    git(root, ...allow, "submodule", "add", "-q", remotes.child, "child")
    git(root, ...allow, "submodule", "update", "-q", "--init", "--recursive")
    git(root, "commit", "-q", "-am", "root one")
    const rootBefore = git(root, "rev-parse", "HEAD")
    git(root, "remote", "add", "origin", remotes.root)
    git(root, "push", "-q", "-u", "origin", "main")

    const child = join(root, "child")
    const leaf = join(child, "leaf")
    for (const repo of [root, child, leaf]) {
      for (const target of ["root", "child", "leaf"] as const) {
        git(repo, "config", `url.${remotes[target]}.insteadOf`, hosted(target))
      }
    }
    git(root, "remote", "set-url", "origin", hosted("root"))
    git(child, "remote", "set-url", "origin", hosted("child"))
    git(leaf, "remote", "set-url", "origin", hosted("leaf"))
    // The child moves (a file and its declared leaf identity); the leaf's own pin does not.
    git(child, "config", "--file", ".gitmodules", "submodule.leaf.url", hosted("leaf"))
    advanceRepository(child, "child.txt", "two\n")
    git(child, "commit", "-q", "-am", "declare the hosted leaf")
    git(root, "config", "--file", ".gitmodules", "submodule.child.url", hosted("child"))
    git(root, "add", "child", ".gitmodules")
    git(root, "commit", "-q", "-m", "move child only")
    expect(git(root, "rev-parse", "HEAD:child")).not.toBe(git(root, "rev-parse", `${rootBefore}:child`))
    expect(git(child, "rev-parse", "HEAD:leaf")).toBe(leafPin)

    // The leaf's main diverged from its pin: a sibling of the pin, not in its history.
    const elsewhere = join(fixture, "leaf-elsewhere")
    git(fixture, "clone", "-q", remotes.leaf, elsewhere)
    git(elsewhere, "checkout", "-q", "-b", "sibling", leafFirst)
    const diverged = advanceRepository(elsewhere, "leaf.txt", "sibling\n")
    git(elsewhere, "push", "-q", "--force", "origin", `${diverged}:refs/heads/main`)

    const tree = git(root, "rev-parse", "HEAD^{tree}")
    const encoded = await capturePushIntent(createLocalGitProcess(), root, rootBefore, tree, new Map(), 30_000)

    const intent = decodePushIntent(encoded ?? "")
    expect(intent.children.find((row) => row.path === "child/leaf")).toEqual({
      path: "child/leaf",
      remote: hosted("leaf"),
      pin: leafPin,
    })
    expect(intent.children.find((row) => row.path === "child")?.publication).toBeDefined()
  })
})
