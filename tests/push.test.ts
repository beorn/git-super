import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test } from "vitest"

import { runCli } from "../src/cli.ts"
import { acquireExclusive, createExclusive, type Exclusive } from "../src/exclusive.ts"
import { createLocalGitProcess, type GitProcess } from "../src/process.ts"
import { pushRefUpdates, superPush } from "../src/push.ts"
import { advanceRepository, createRepository, git } from "./fixture.ts"

const roots: string[] = []
const gitSuperBin = fileURLToPath(new URL("../bin/git-super", import.meta.url))

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

  test("uses Git's configured default push selection when no refspec is supplied", async () => {
    const { repository, remote, source } = pushFixture("cli-default")
    git(repository, "remote", "add", "origin", remote)
    git(repository, "config", "branch.main.remote", "origin")
    git(repository, "config", "branch.main.merge", "refs/heads/main")
    const stdout = outputSink()
    const stderr = outputSink()

    expect(await runCli(["--repo", repository, "push", "--recurse-submodules=no", "--json"], stdout, stderr)).toBe(0)

    expect(stderr.output).toBe("")
    expect(JSON.parse(stdout.output)).toMatchObject({
      state: "updated",
      repositories: [{ refs: [{ source, destination: "refs/heads/main", state: "updated" }] }],
    })
    expect(git(remote, "rev-parse", "refs/heads/main")).toBe(source)
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

  test("passes atomic, hook, signed-push, and push-option choices to ordinary Git per repository", async () => {
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
      git: recording,
    })

    expect(result.state).toBe("updated")
    expect(pushArgs).toHaveLength(1)
    expect(pushArgs[0]).toEqual(
      expect.arrayContaining(["--atomic", "--no-verify", "--signed=false", "--push-option=ci.skip=true"]),
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
