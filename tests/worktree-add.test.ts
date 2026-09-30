/**
 * @failure A worktree is created without its submodules, or left half-materialized after a failed pin.
 * @level l1
 * @consumer Yrd worktree provisioning
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runCli } from "../src/cli.ts"
import { acquireExclusive } from "../src/exclusive.ts"
import { tryAcquireFlock } from "@bearly/flock"

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
  /**
   * @failure The CLI hides the writer-lock holder while Yrd waits to materialize a tree (25274).
   * @level l1
   * @consumer Yrd post-merge tree materialization log
   */
  it("reports the lock holder through CLI stderr while worktree add waits", async () => {
    const root = mkdtempSync(join(tmpdir(), "git-super-worktree-cli-wait-"))
    roots.push(root)
    const repo = join(root, "owner")
    const linked = join(root, "linked")
    initRepository(repo, "seed.txt", "seed\n")
    const held = await acquireExclusive(
      join(repo, ".git", "yrd-worktree-mutations"),
      { timeoutMs: 0 },
      "git super merge",
    )
    const stdout = outputSink()
    const stderr = outputSink()
    let released = false
    const release = () => {
      if (released) return
      released = true
      held.release()
    }
    try {
      const invocation = runCli(["--repo", repo, "--json", "worktree", "add", linked, "HEAD"], stdout, stderr)
      for (let poll = 0; poll < 500 && stderr.output === ""; poll += 1) await Bun.sleep(20)
      release()
      expect(await invocation).toBe(0)
      expect(JSON.parse(stdout.output)).toMatchObject({ state: "updated" })
      expect(stderr.output).toMatch(
        /^git-super worktree: waiting for writer lock held by git super merge \(pid:\d+, age \d+ms\)\n$/u,
      )
    } finally {
      release()
    }
  }, 30_000)

  /**
   * @failure A released git-super flock leaves its diagnostic pathname, and blanket .lock refusal strands clean worktrees (25714).
   * @level l1
   * @consumer Yrd environment close through git super worktree remove --retain
   */
  it.each([
    ["dead", 2 ** 22 + 1],
    ["live", process.pid],
  ])(
    "removes a clean tree with a free child writer lease despite a %s pid note",
    async (_label, recordedPid) => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-worktree-free-child-lock-"))
      roots.push(fixtureRoot)
      const fixture = createSuperproject(fixtureRoot)
      const worktree = join(fixtureRoot, "candidate")
      const retained = join(fixtureRoot, "retained")
      expect(
        await runCli(["--repo", fixture.product, "worktree", "add", worktree, "HEAD"], outputSink(), outputSink()),
      ).toBe(0)
      const childGitDir = git(join(worktree, "vendor/dep"), ["rev-parse", "--absolute-git-dir"])
      const lock = await acquireExclusive(
        join(childGitDir, "yrd-worktree-mutations"),
        { timeoutMs: 0 },
        "finished push",
      )
      lock.release()
      const lockPath = join(childGitDir, "yrd-worktree-mutations", "writer.lock")
      const body = JSON.stringify({ pid: recordedPid, holder: "finished push", startedAt: "2026-09-01T00:00:00.000Z" })
      writeFileSync(lockPath, body)

      const stdout = outputSink()
      expect(
        await runCli(
          ["--repo", fixture.product, "--json", "worktree", "remove", worktree, "--retain", retained],
          stdout,
          outputSink(),
        ),
      ).toBe(0)
      const result = JSON.parse(stdout.output) as {
        proof: { writerLocks: Array<{ path: string; body: string; lease: string }> }
      }
      expect(result.proof.writerLocks).toContainEqual({ path: lockPath, body, lease: "free" })
      expect(existsSync(worktree)).toBe(false)
    },
    30_000,
  )

  /**
   * @failure A live child writer can lose its module store, or a later held lease leaves an earlier one held (25714).
   * @level l1
   * @consumer Yrd environment close
   */
  it.each(["child", "second"])(
    "refuses a %s held writer lease without changing the worktree",
    async (heldAt) => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-worktree-held-child-lock-"))
      roots.push(fixtureRoot)
      const fixture = createSuperproject(fixtureRoot)
      const worktree = join(fixtureRoot, "candidate")
      const retained = join(fixtureRoot, "retained")
      expect(
        await runCli(["--repo", fixture.product, "worktree", "add", worktree, "HEAD"], outputSink(), outputSink()),
      ).toBe(0)
      const adminGitDir = git(worktree, ["rev-parse", "--absolute-git-dir"])
      const childGitDir = git(join(worktree, "vendor/dep"), ["rev-parse", "--absolute-git-dir"])
      const childLock = join(childGitDir, "yrd-worktree-mutations", "writer.lock")
      const rootLock = join(adminGitDir, "yrd-worktree-mutations", "writer.lock")
      const free = await acquireExclusive(
        join(childGitDir, "yrd-worktree-mutations"),
        { timeoutMs: 0 },
        "finished child",
      )
      free.release()
      const heldPath = heldAt === "child" ? childLock : rootLock
      const ready = join(fixtureRoot, "holder-ready")
      const holder = Bun.spawn(
        [
          process.execPath,
          "-e",
          `
        import { tryAcquireFlock } from "@bearly/flock";
        import { writeFileSync } from "node:fs";
        const lock = tryAcquireFlock(process.argv[1], { body: "live child note" });
        if (!lock) throw new Error("could not take test lease");
        writeFileSync(process.argv[2], String(process.pid));
        setInterval(() => {}, 1000);
      `,
          heldPath,
          ready,
        ],
        { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
      )
      try {
        for (let poll = 0; poll < 200 && !existsSync(ready) && holder.exitCode === null; poll += 1) await Bun.sleep(10)
        expect(existsSync(ready)).toBe(true)
        const out = outputSink()
        expect(
          await runCli(
            ["--repo", fixture.product, "--json", "worktree", "remove", worktree, "--retain", retained],
            out,
            outputSink(),
          ),
        ).toBe(2)
        expect(out.output).toContain(heldPath)
        expect(out.output).toContain(String(holder.pid))
        expect(out.output).toContain("body note (not authority): live child note")
        expect(existsSync(worktree)).toBe(true)
        expect(existsSync(retained)).toBe(false)
        if (heldAt === "second") {
          const reclaimed = tryAcquireFlock(childLock)
          expect(reclaimed).not.toBeNull()
          reclaimed?.release()
        }
      } finally {
        holder.kill()
        await holder.exited
      }
    },
    30_000,
  )

  /**
   * @failure A writer starts during retention and acquires a lease before its store is removed (25714).
   * @level l1
   * @consumer Yrd environment close
   */
  it("holds the writer lease through the native remove", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-worktree-contender-"))
    roots.push(fixtureRoot)
    const fixture = createSuperproject(fixtureRoot)
    const worktree = join(fixtureRoot, "candidate")
    const retained = join(fixtureRoot, "retained")
    expect(
      await runCli(["--repo", fixture.product, "worktree", "add", worktree, "HEAD"], outputSink(), outputSink()),
    ).toBe(0)
    const childGitDir = git(join(worktree, "vendor/dep"), ["rev-parse", "--absolute-git-dir"])
    const lockPath = join(childGitDir, "yrd-worktree-mutations", "writer.lock")
    expect(existsSync(lockPath)).toBe(false)
    let contender: string | undefined
    const diagnostic = {
      write(value: string) {
        if (!value.startsWith("worktree removal proof ")) return
        const result = spawnSync(
          process.execPath,
          [
            "-e",
            `import {tryAcquireFlock} from "@bearly/flock"; const lock=tryAcquireFlock(process.argv[1]); if(lock){lock.release();process.stdout.write("acquired")}else{process.stdout.write("busy")}`,
            lockPath,
          ],
          { cwd: process.cwd(), encoding: "utf8" },
        )
        expect(result.status).toBe(0)
        contender = result.stdout
      },
    }
    expect(
      await runCli(
        ["--repo", fixture.product, "--json", "worktree", "remove", worktree, "--retain", retained],
        outputSink(),
        diagnostic,
      ),
    ).toBe(0)
    expect(contender).toBe("busy")
    expect(existsSync(worktree)).toBe(false)
  }, 30_000)

  /**
   * @failure A generic Git lock or same-named file outside a Git directory is mistaken for a free writer lease (25714).
   * @level l1
   * @consumer Yrd environment close
   */
  it.each(["index.lock", "other/writer.lock", "modules-root/writer.lock"])(
    "keeps %s as a removal barrier",
    async (relativeLock) => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-worktree-other-lock-"))
      roots.push(fixtureRoot)
      const fixture = createSuperproject(fixtureRoot)
      const worktree = join(fixtureRoot, "candidate")
      const retained = join(fixtureRoot, "retained")
      expect(
        await runCli(["--repo", fixture.product, "worktree", "add", worktree, "HEAD"], outputSink(), outputSink()),
      ).toBe(0)
      const childGitDir = git(join(worktree, "vendor/dep"), ["rev-parse", "--absolute-git-dir"])
      const barrier =
        relativeLock === "modules-root/writer.lock"
          ? join(git(worktree, ["rev-parse", "--absolute-git-dir"]), "modules/yrd-worktree-mutations/writer.lock")
          : join(childGitDir, relativeLock)
      mkdirSync(join(barrier, ".."), { recursive: true })
      writeFileSync(barrier, "do not remove")
      const out = outputSink()
      expect(
        await runCli(
          ["--repo", fixture.product, "--json", "worktree", "remove", worktree, "--retain", retained],
          out,
          outputSink(),
        ),
      ).toBe(2)
      expect(out.output).toContain(`Git lock ${barrier}`)
      expect(existsSync(worktree)).toBe(true)
    },
    30_000,
  )

  /**
   * @failure A killed push leaves its diagnostic pathname and a later removal treats that pathname as a live lock (25714).
   * @level l1
   * @consumer Yrd environment close after an interrupted push
   */
  it("removes a worktree after a push writer is killed and its lock file remains", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-worktree-killed-writer-"))
    roots.push(fixtureRoot)
    const fixture = createSuperproject(fixtureRoot)
    const worktree = join(fixtureRoot, "candidate")
    const retained = join(fixtureRoot, "retained")
    expect(
      await runCli(["--repo", fixture.product, "worktree", "add", worktree, "HEAD"], outputSink(), outputSink()),
    ).toBe(0)
    const childGitDir = git(join(worktree, "vendor/dep"), ["rev-parse", "--absolute-git-dir"])
    const lockDir = join(childGitDir, "yrd-worktree-mutations")
    const lockPath = join(lockDir, "writer.lock")
    const ready = join(fixtureRoot, "push-ready")
    const holder = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
        import { writeFileSync } from "node:fs";
        const { acquireExclusive } = await import(process.argv[3]);
        await acquireExclusive(process.argv[1], { timeoutMs: 0 }, "git super push");
        writeFileSync(process.argv[2], String(process.pid));
        setInterval(() => {}, 1000);
      `,
        lockDir,
        ready,
        join(process.cwd(), "vendor/git-super/src/exclusive.ts"),
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    )
    try {
      for (let poll = 0; poll < 200 && !existsSync(ready) && holder.exitCode === null; poll += 1) await Bun.sleep(10)
      if (!existsSync(ready)) {
        holder.kill()
        await holder.exited
        throw new Error(`push writer did not start: ${await new Response(holder.stderr).text()}`)
      }
      expect(existsSync(ready)).toBe(true)
      expect(existsSync(lockPath)).toBe(true)
    } finally {
      holder.kill("SIGKILL")
      await holder.exited
    }
    expect(existsSync(lockPath)).toBe(true)
    const free = tryAcquireFlock(lockPath)
    expect(free).not.toBeNull()
    free?.release()
    const out = outputSink()
    expect(
      await runCli(
        ["--repo", fixture.product, "--json", "worktree", "remove", worktree, "--retain", retained],
        out,
        outputSink(),
      ),
    ).toBe(0)
    const result = JSON.parse(out.output) as {
      proof: { writerLocks: Array<{ path: string; body: string; lease: string }> }
    }
    expect(result.proof.writerLocks).toContainEqual({
      path: lockPath,
      body: expect.stringContaining("git super push"),
      lease: "free",
    })
    expect(existsSync(worktree)).toBe(false)
  }, 30_000)

  it("retains complete module stores before removing a clean unlocked populated worktree", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-worktree-remove-"))
    roots.push(fixtureRoot)
    const fixture = createSuperproject(fixtureRoot)
    const worktree = join(fixtureRoot, "candidate")
    const retained = join(fixtureRoot, "retained")
    const out = outputSink()
    const err = outputSink()
    expect(await runCli(["--repo", fixture.product, "worktree", "add", worktree, "HEAD"], out, err)).toBe(0)
    const child = join(worktree, "vendor/dep")
    // This object is in no remote or author store. A clean detached HEAD alone
    // cannot prove that removing the child Git directory loses no work.
    git(child, ["checkout", "-q", "-b", "spare"])
    writeFileSync(join(child, "dep.ts"), "export const dep = 42\n")
    git(child, ["add", "dep.ts"])
    git(child, ["commit", "-q", "-m", "private spare object"])
    const spare = git(child, ["rev-parse", "HEAD"])
    git(child, ["checkout", "-q", "--detach", fixture.pin])
    const source = git(child, ["rev-parse", "--absolute-git-dir"])
    const beforeLog = readFileSync(join(source, "logs/HEAD"), "utf8")

    for (const dirty of [join(worktree, "untracked.txt"), join(child, "untracked.txt")]) {
      writeFileSync(dirty, "preserve me")
      const failure = outputSink()
      expect(
        await runCli(
          ["--repo", fixture.product, "--json", "worktree", "remove", worktree, "--retain", retained],
          failure,
          outputSink(),
        ),
      ).toBe(2)
      expect(failure.output).toContain("dirty")
      expect(existsSync(worktree)).toBe(true)
      unlinkSync(dirty)
    }
    git(fixture.product, ["worktree", "lock", "--reason", "held by test", worktree])
    const locked = outputSink()
    expect(
      await runCli(
        ["--repo", fixture.product, "--json", "worktree", "remove", worktree, "--retain", retained],
        locked,
        outputSink(),
      ),
    ).toBe(2)
    expect(locked.output).toContain("held by test")
    git(fixture.product, ["worktree", "unlock", worktree])

    for (const unsafe of [join(worktree, "backup"), join(source, "backup")]) {
      const failure = outputSink()
      expect(
        await runCli(
          ["--repo", fixture.product, "--json", "worktree", "remove", worktree, "--retain", unsafe],
          failure,
          outputSink(),
        ),
      ).toBe(2)
      expect(failure.output).toContain("inside worktree removal paths")
      expect(existsSync(worktree)).toBe(true)
    }
    const output = outputSink()
    let proofBeforeRemoval = false
    const diagnostic = {
      write(value: string) {
        if (value.startsWith("worktree removal proof ")) proofBeforeRemoval = existsSync(worktree)
      },
    }
    expect(
      await runCli(
        ["--repo", fixture.product, "--json", "worktree", "remove", worktree, "--retain", retained],
        output,
        diagnostic,
      ),
    ).toBe(0)
    const result = JSON.parse(output.output) as { state: string; proof: { retained: string; manifest: string } }
    expect(result.state).toBe("updated")
    expect(proofBeforeRemoval).toBe(true)
    expect(existsSync(worktree)).toBe(false)
    expect(existsSync(source)).toBe(false)
    expect(git(fixture.product, ["worktree", "list", "--porcelain"])).not.toContain(worktree)
    const store = join(result.proof.retained, "vendor/dep")
    expect(readFileSync(join(store, "logs/HEAD"), "utf8")).toBe(beforeLog)
    expect(readFileSync(result.proof.manifest, "utf8")).toContain("vendor/dep/refs/heads/spare")
    const rescued = join(fixtureRoot, "rescued.git")
    git(fixtureRoot, ["clone", "--quiet", "--bare", "--no-hardlinks", store, rescued])
    expect(git(rescued, ["rev-parse", "refs/heads/spare"])).toBe(spare)
    expect(git(rescued, ["show", `${spare}:dep.ts`])).toBe("export const dep = 42")
  }, 30_000)

  it("refuses removal when the retention destination cannot be written", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-worktree-retain-fail-"))
    roots.push(fixtureRoot)
    const fixture = createSuperproject(fixtureRoot)
    const worktree = join(fixtureRoot, "candidate")
    const blocker = join(fixtureRoot, "not-a-directory")
    writeFileSync(blocker, "blocked")
    expect(
      await runCli(["--repo", fixture.product, "worktree", "add", worktree, "HEAD"], outputSink(), outputSink()),
    ).toBe(0)
    const out = outputSink()
    expect(
      await runCli(
        ["--repo", fixture.product, "--json", "worktree", "remove", worktree, "--retain", blocker],
        out,
        outputSink(),
      ),
    ).toBe(2)
    expect(out.output).toContain(blocker)
    expect(existsSync(worktree)).toBe(true)
    expect(git(fixture.product, ["worktree", "list", "--porcelain"])).toContain(worktree)
  })

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

  /**
   * @failure A --reference with no store for a gitlink network-clones it instead of refusing.
   *
   * The dependency is deliberately left REACHABLE and `protocol.file.allow` is
   * set to `always`, so the network fallback would succeed if it were taken. A
   * refusal here can therefore only mean the fallback was never reached — which
   * is the whole claim, since `worktree add` passes an unbounded fetch budget.
   */
  it("refuses a reference that holds no store for a gitlink, and borrows once it does", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-worktree-unpopulated-"))
    roots.push(fixtureRoot)
    const fixture = createSuperproject(fixtureRoot)
    git(fixture.product, ["config", "--local", "protocol.file.allow", "always"])
    const worktree = join(fixtureRoot, "candidate")

    // The queue's own shape: cloned --no-checkout, so nothing was ever
    // materialized under it and the gitlink path does not exist at all.
    const bare = join(fixtureRoot, "reference-no-checkout")
    const cloneBare = spawnSync("git", ["clone", "-q", "--no-checkout", fixture.product, bare], {
      encoding: "utf8",
      env: environment,
    })
    if (cloneBare.status !== 0) throw new Error(cloneBare.stderr || "could not clone the product")
    expect(existsSync(join(bare, "vendor/dep"))).toBe(false)

    const bareErr = outputSink()
    expect(
      await runCli(
        ["--repo", fixture.product, "worktree", "add", worktree, "HEAD", "--reference", bare],
        outputSink(),
        bareErr,
      ),
    ).toBe(2)
    expect(bareErr.output).toContain("holds no object store for 1 of 1 gitlink(s)")
    expect(bareErr.output).toContain("vendor/dep — no store at")
    expect(bareErr.output).toContain(`git -C ${bare} submodule update --init -- vendor/dep`)
    expect(bareErr.output).toContain("--max-remote-fallbacks does not reach this")
    // Nothing was cloned and nothing was left standing.
    expect(existsSync(worktree)).toBe(false)
    expect(existsSync(join(bare, "vendor/dep"))).toBe(false)
    expect(git(fixture.product, ["worktree", "list", "--porcelain"])).not.toContain(worktree)

    // The harder shape, and the one a naive existsSync probe passes: a checked
    // out clone whose submodule was never initialized leaves vendor/dep as an
    // EMPTY DIRECTORY, and every git command run there discovers the
    // superproject by walking up rather than failing.
    const empty = join(fixtureRoot, "reference-uninitialized")
    const cloneEmpty = spawnSync("git", ["clone", "-q", fixture.product, empty], {
      encoding: "utf8",
      env: environment,
    })
    if (cloneEmpty.status !== 0) throw new Error(cloneEmpty.stderr || "could not clone the product")
    expect(existsSync(join(empty, "vendor/dep"))).toBe(true)
    expect(existsSync(join(empty, "vendor/dep/dep.ts"))).toBe(false)

    const emptyErr = outputSink()
    expect(
      await runCli(
        ["--repo", fixture.product, "worktree", "add", worktree, "HEAD", "--reference", empty],
        outputSink(),
        emptyErr,
      ),
    ).toBe(2)
    expect(emptyErr.output).toContain("holds no object store for 1 of 1 gitlink(s)")
    expect(emptyErr.output).toContain(`git -C ${empty} submodule update --init -- vendor/dep`)
    expect(existsSync(worktree)).toBe(false)

    // POSITIVE CONTROL. The one command the refusal named, and nothing else,
    // turns the same reference into one that borrows.
    git(empty, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q", "--", "vendor/dep"])
    const stdout = outputSink()
    const stderr = outputSink()
    expect(
      await runCli(
        ["--repo", fixture.product, "worktree", "add", worktree, "HEAD", "--reference", empty],
        stdout,
        stderr,
      ),
    ).toBe(0)
    expect(stderr.output).toContain("1 gitlink (1 borrowed, 0 fetched, 0 absent)")
    expect(git(join(worktree, "vendor/dep"), ["rev-parse", "HEAD"])).toBe(fixture.pin)
  }, 30_000)

  it("exits 2 with usage for an unknown worktree subcommand", async () => {
    const stdout = outputSink()
    const stderr = outputSink()

    expect(await runCli(["--repo", ".", "worktree", "unknown-command"], stdout, stderr)).toBe(2)
    expect(stderr.output).toContain("unknown worktree subcommand 'unknown-command'")
    expect(stderr.output).toContain("Usage: git super worktree")
    expect(stdout.output).toBe("")
  })
})

describe("git super worktree remove routing (24622)", () => {
  it("reaches git-super through runCli without --repo, not native Git", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-worktree-remove-route-"))
    roots.push(fixtureRoot)
    const fixture = createSuperproject(fixtureRoot)
    const worktree = join(fixtureRoot, "candidate")
    const retained = join(fixtureRoot, "retained")
    expect(
      await runCli(["--repo", fixture.product, "worktree", "add", worktree, "HEAD"], outputSink(), outputSink()),
    ).toBe(0)
    const stdout = outputSink()
    const stderr = outputSink()
    const previous = process.cwd()
    process.chdir(fixture.product)
    let code: number
    try {
      code = await runCli(["worktree", "remove", "--retain", retained, worktree], stdout, stderr)
    } finally {
      process.chdir(previous)
    }
    expect(stderr.output).not.toMatch(/unknown option [`']retain[`']/)
    expect(stderr.output).not.toContain("working trees containing submodules cannot be moved or removed")
    expect(stderr.output).not.toMatch(/^usage: git worktree/m)
    expect(code).toBe(0)
    expect(existsSync(worktree)).toBe(false)
  }, 30_000)
})
