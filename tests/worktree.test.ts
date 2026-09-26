/**
 * @failure Worktree mutations can escape the shared repository lock or accept ambiguous process authority.
 * @level l1
 * @consumer Yrd worktree and deployment stores
 */
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { acquireExclusive, DEFAULT_MUTATION_LOCK_WAIT_MS } from "../src/exclusive.ts"
import {
  createGitWorktreeStore,
  createLocalGitWorktreeStore,
  runLocalGitWorktreeMutationSync,
  type GitWorktreeStoreOptions,
} from "../src/worktree.ts"
import type { GitProcessRequest } from "../src/process.ts"

function git(repo: string, args: readonly string[]): string {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`)
  return result.stdout
}

describe("createGitWorktreeStore", () => {
  /**
   * @failure Tree materialization gives up after 30 s while a queue merge still holds the shared writer lock (25274).
   * @level l1
   * @consumer Yrd post-merge tree materialization
   */
  it("resolves a writer-lock wait of four minutes by default: under yrd's five-minute per-call cap with room for the add", () => {
    // The inequality against yrd's constant is pinned by the host's test; this is the value it relies on.
    expect(DEFAULT_MUTATION_LOCK_WAIT_MS).toBe(4 * 60_000)
  })

  it("waits for a merge holding the writer lock before adding a worktree, using the shared default wait", async () => {
    const root = await mkdtemp(join(tmpdir(), "git-super-worktree-writer-wait-"))
    const repo = join(root, "owner")
    const linked = join(root, "linked")
    git(root, ["init", "-q", "-b", "main", repo])
    git(repo, ["config", "user.email", "test@example.com"])
    git(repo, ["config", "user.name", "Test"])
    await writeFile(join(repo, "seed.txt"), "seed\n")
    git(repo, ["add", "seed.txt"])
    git(repo, ["commit", "-q", "-m", "seed"])

    const held = await acquireExclusive(
      join(repo, ".git", "yrd-worktree-mutations"),
      { timeoutMs: 0 },
      "git super merge",
    )
    // The lock remains real; advance only the reporter's clock past 30 seconds.
    // The old assertion saw its first line but missed a silent long wait (25274 slice 2).
    const release = Bun.sleep(1_500).then(() => held.release())
    const reports: string[] = []
    let operation: Promise<void> | undefined
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] })
    try {
      const store = createLocalGitWorktreeStore({
        repo,
        report: (line: string) => reports.push(line),
      })
      operation = store.add({ kind: "detached", path: linked, ref: "HEAD" })
      for (let poll = 0; poll < 100 && reports.length === 0; poll += 1) await Bun.sleep(10)
      expect(reports).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(31_000)
      expect(reports.length).toBeGreaterThanOrEqual(4)
      await operation
      expect(existsSync(linked)).toBe(true)
      for (const line of reports) {
        expect(line).toMatch(
          /^git-super worktree: waiting for writer lock held by git super merge \(pid:\d+, age \d+ms\)\n$/u,
        )
      }
    } finally {
      try {
        await release
        if (operation !== undefined) await Promise.allSettled([operation])
      } finally {
        vi.useRealTimers()
        await rm(root, { recursive: true, force: true })
      }
    }
  }, 30_000)

  it("uses the canonical GitProcess request internally", async () => {
    const repo = await mkdtemp(join(tmpdir(), "git-super-process-port-"))
    const requests: GitProcessRequest[] = []
    const store = createGitWorktreeStore({
      repo,
      gitProcess: {
        async run(request) {
          requests.push(request)
          if (request.args.includes("extensions.worktreeConfig")) {
            return { code: 1, stdout: "", stderr: "", timedOut: false }
          }
          return { code: 0, stdout: `${join(repo, ".git")}\n`, stderr: "", timedOut: false }
        },
      },
    })

    try {
      await store.ready()
      expect(requests.map(({ repo: requestRepo, args }) => ({ repo: requestRepo, args }))).toEqual([
        { repo, args: ["config", "--local", "--get", "--type=bool", "extensions.worktreeConfig"] },
        { repo, args: ["rev-parse", "--path-format=absolute", "--git-common-dir"] },
      ])
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it("checks the heal guards before locking and still takes the lock when repair is required", async () => {
    const repo = await mkdtemp(join(tmpdir(), "git-super-config-heal-lock-"))
    const commonDir = join(repo, ".git")
    const lockDirectory = join(commonDir, "yrd-worktree-mutations")
    const requests: GitProcessRequest[] = []
    const held = await acquireExclusive(lockDirectory, { timeoutMs: 0 }, "outer mutation")
    const store = createGitWorktreeStore({
      repo,
      timeouts: { mutationLock: 0 },
      gitProcess: {
        async run(request) {
          requests.push(request)
          if (request.args.includes("extensions.worktreeConfig") || request.args.includes("core.bare")) {
            return { code: 0, stdout: "true\n", stderr: "", timedOut: false }
          }
          return { code: 0, stdout: `${commonDir}\n`, stderr: "", timedOut: false }
        },
      },
    })

    const stderr = vi.spyOn(process.stderr, "write")
    try {
      await expect(store.ready()).rejects.toThrow(
        /timeout=0ms; holder=outer mutation.*operation=worktree configuration repair/iu,
      )
      expect(stderr).not.toHaveBeenCalled()
      expect(requests.map(({ args }) => args)).toEqual([
        ["config", "--local", "--get", "--type=bool", "extensions.worktreeConfig"],
        ["config", "--local", "--get", "--type=bool", "core.bare"],
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      ])
    } finally {
      stderr.mockRestore()
      held.release()
      await rm(repo, { recursive: true, force: true })
    }
  })

  it("refuses to build without the one injected Git capability", () => {
    // A JavaScript caller can still omit it, so this run-time refusal stays.
    // What is GONE is the companion assertion that TWO capabilities are
    // rejected: the options type now carries exactly one capability field, so
    // "two were supplied" is unrepresentable rather than merely detected.
    expect(() => createGitWorktreeStore({ repo: "/repo" } as unknown as GitWorktreeStoreOptions)).toThrow(
      /requires one injected GitProcess/iu,
    )
  })

  it("lets pool policy reset a slot branch at an explicit base", async () => {
    const repo = await mkdtemp(join(tmpdir(), "git-super-reset-branch-"))
    const calls: Array<{ repo: string; args: readonly string[] }> = []
    const store = createGitWorktreeStore({
      repo,
      gitProcess: {
        run: async (request) => {
          calls.push({ repo: request.repo, args: request.args })
          if (request.args[0] === "rev-parse") return { code: 0, stdout: `${join(repo, ".git")}\n`, stderr: "" }
          return { code: 0, stdout: "", stderr: "" }
        },
      },
    })

    try {
      const path = join(repo, ".worktrees/repo-wt5")
      await store.add({
        kind: "reset-branch",
        path,
        branch: "wt5",
        ref: "refs/remotes/origin/main",
        hooks: "quarantine",
      })

      expect(calls.at(-1)).toEqual({
        repo,
        args: ["-c", "core.hooksPath=/dev/null", "worktree", "add", "-B", "wt5", path, "refs/remotes/origin/main"],
      })
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it("adds and fully removes a real linked worktree through the local adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "git super worktree "))
    const repo = join(root, "owner")
    const linked = join(root, "linked worktree")
    git(root, ["init", "-q", "-b", "main", repo])
    git(repo, ["config", "user.email", "test@example.com"])
    git(repo, ["config", "user.name", "Test"])
    await writeFile(join(repo, "seed.txt"), "seed\n")
    git(repo, ["add", "seed.txt"])
    git(repo, ["commit", "-q", "-m", "seed"])

    try {
      const store = createLocalGitWorktreeStore({ repo })
      await store.add({ kind: "detached", path: linked, ref: "HEAD" })
      expect(existsSync(linked)).toBe(true)
      await store.lock(linked, "test locked cleanup")

      expect(runLocalGitWorktreeMutationSync({ kind: "remove", repo, path: linked, unlock: true }).exitCode).toBe(0)
      expect(existsSync(linked)).toBe(false)
      expect(git(repo, ["worktree", "list", "--porcelain"])).not.toContain(linked)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("removes a lender worktree and re-homes borrower alternates cleanly (25908)", async () => {
    const root = await mkdtemp(join(tmpdir(), "git-super-rehome-"))
    const subRemote = join(root, "sub-remote.git")
    const repo = join(root, "owner")
    const lender = join(root, "lender")
    const borrower = join(root, "borrower")
    const retainedDir = join(root, "retained")

    git(root, ["init", "-q", "--bare", "-b", "main", subRemote])
    const subWork = join(root, "sub-work")
    git(root, ["clone", "-q", subRemote, subWork])
    git(subWork, ["config", "user.email", "test@example.com"])
    git(subWork, ["config", "user.name", "Test"])
    await writeFile(join(subWork, "sub.txt"), "sub content\n")
    git(subWork, ["add", "sub.txt"])
    git(subWork, ["commit", "-q", "-m", "init sub"])
    git(subWork, ["push", "-q", "origin", "main"])

    git(root, ["init", "-q", "-b", "main", repo])
    git(repo, ["config", "user.email", "test@example.com"])
    git(repo, ["config", "user.name", "Test"])
    await writeFile(join(repo, "root.txt"), "root\n")
    git(repo, ["add", "root.txt"])
    git(repo, ["commit", "-q", "-m", "init root"])
    git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", subRemote, "vendor/sub"])
    git(repo, ["commit", "-q", "-m", "add submodule"])

    try {
      const store = createLocalGitWorktreeStore({ repo })
      await store.add({ kind: "detached", path: lender, ref: "HEAD" })
      await store.materializeSubmodules(lender)

      await store.add({ kind: "detached", path: borrower, ref: "HEAD" })
      const borrowerSub = join(borrower, "vendor/sub")
      const lenderSubAdmin = join(repo, ".git", "worktrees", "lender", "modules", "vendor/sub")
      const borrowerSubAdmin = join(repo, ".git", "worktrees", "borrower", "modules", "vendor/sub")
      const durableSubObjects = join(repo, ".git", "modules", "vendor/sub", "objects")
      const lenderSubObjects = join(lenderSubAdmin, "objects")

      await store.materializeSubmodules(borrower)
      const altFile = join(borrowerSubAdmin, "objects", "info", "alternates")
      await writeFile(altFile, `${lenderSubObjects}\n${durableSubObjects}\n`, "utf8")

      await store.remove(lender, {
        retention: {
          root: retainedDir,
          report: () => {},
        },
      })
      expect(existsSync(lender)).toBe(false)

      const altContent = await readFile(altFile, "utf8")
      expect(altContent).not.toContain(lenderSubObjects)
      expect(altContent).toContain(durableSubObjects)

      const fsck = spawnSync("git", ["-C", borrowerSub, "fsck", "--full"], { encoding: "utf8" })
      expect(fsck.status).toBe(0)
      expect(fsck.stderr).toBe("")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("dissociates borrower with repack -a -d when lender is packed with a unique commit (25908 cure)", async () => {
    const root = await mkdtemp(join(tmpdir(), "git-super-repack-"))
    const subRemote = join(root, "sub-remote.git")
    const repo = join(root, "owner")
    const lender = join(root, "lender")
    const borrower = join(root, "borrower")
    const retainedDir = join(root, "retained")

    git(root, ["init", "-q", "--bare", "-b", "main", subRemote])
    const subWork = join(root, "sub-work")
    git(root, ["clone", "-q", subRemote, subWork])
    git(subWork, ["config", "user.email", "test@example.com"])
    git(subWork, ["config", "user.name", "Test"])
    await writeFile(join(subWork, "sub.txt"), "sub content\n")
    git(subWork, ["add", "sub.txt"])
    git(subWork, ["commit", "-q", "-m", "init sub"])
    git(subWork, ["push", "-q", "origin", "main"])

    git(root, ["init", "-q", "-b", "main", repo])
    git(repo, ["config", "user.email", "test@example.com"])
    git(repo, ["config", "user.name", "Test"])
    await writeFile(join(repo, "root.txt"), "root\n")
    git(repo, ["add", "root.txt"])
    git(repo, ["commit", "-q", "-m", "init root"])
    git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", subRemote, "vendor/sub"])
    git(repo, ["commit", "-q", "-m", "add submodule"])

    try {
      const store = createLocalGitWorktreeStore({ repo })
      await store.add({ kind: "detached", path: lender, ref: "HEAD" })
      await store.materializeSubmodules(lender)

      const lenderSub = join(lender, "vendor/sub")
      git(lenderSub, ["config", "user.email", "test@example.com"])
      git(lenderSub, ["config", "user.name", "Test"])
      await writeFile(join(lenderSub, "lender-private.txt"), "lender only\n")
      git(lenderSub, ["add", "lender-private.txt"])
      git(lenderSub, ["commit", "-q", "-m", "lender only commit"])
      const lenderCommit = git(lenderSub, ["rev-parse", "HEAD"]).trim()

      git(lender, ["add", "vendor/sub"])
      git(lender, ["commit", "-q", "-m", "update sub in lender"])

      git(lenderSub, ["repack", "-a", "-d"])

      await store.add({ kind: "detached", path: borrower, ref: "HEAD" })
      const borrowerSub = join(borrower, "vendor/sub")
      const lenderSubAdmin = join(repo, ".git", "worktrees", "lender", "modules", "vendor/sub")
      const borrowerSubAdmin = join(repo, ".git", "worktrees", "borrower", "modules", "vendor/sub")
      const durableSubObjects = join(repo, ".git", "modules", "vendor/sub", "objects")
      const lenderSubObjects = join(lenderSubAdmin, "objects")

      await store.materializeSubmodules(borrower)
      const altFile = join(borrowerSubAdmin, "objects", "info", "alternates")
      await writeFile(altFile, `${lenderSubObjects}\n${durableSubObjects}\n`, "utf8")

      git(borrowerSub, ["update-ref", "refs/heads/main", lenderCommit])
      git(borrowerSub, ["symbolic-ref", "HEAD", "refs/heads/main"])

      expect(git(borrowerSub, ["cat-file", "-t", lenderCommit]).trim()).toBe("commit")

      await store.remove(lender, {
        retention: {
          root: retainedDir,
          report: () => {},
        },
      })
      expect(existsSync(lender)).toBe(false)
      expect(existsSync(lenderSubAdmin)).toBe(false)

      const fsck = spawnSync("git", ["-C", borrowerSub, "fsck", "--full"], { encoding: "utf8" })
      expect(fsck.status).toBe(0)
      expect(fsck.stderr).toBe("")

      const readCommit = spawnSync("git", ["-C", borrowerSub, "cat-file", "-t", lenderCommit], { encoding: "utf8" })
      expect(readCommit.status).toBe(0)
      expect(readCommit.stdout.trim()).toBe("commit")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
