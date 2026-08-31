/**
 * @failure Worktree mutations can escape the shared repository lock or accept ambiguous process authority.
 * @level l1
 * @consumer Yrd worktree and deployment stores
 */
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { acquireExclusive } from "../src/exclusive.ts"
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

    try {
      await expect(store.ready()).rejects.toThrow(/holder=outer mutation.*operation=worktree configuration repair/iu)
      expect(requests.map(({ args }) => args)).toEqual([
        ["config", "--local", "--get", "--type=bool", "extensions.worktreeConfig"],
        ["config", "--local", "--get", "--type=bool", "core.bare"],
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      ])
    } finally {
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
})
