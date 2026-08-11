/**
 * @failure Worktree mutations can escape the shared repository lock or accept ambiguous process authority.
 * @level l1
 * @consumer Yrd worktree and deployment stores
 */
import { existsSync, realpathSync } from "node:fs"
import { mkdtemp, writeFile } from "node:fs/promises"
import { safeRemove } from "removely"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  createGitWorktreeStore,
  createLocalGitWorktreeStore,
  runLocalGitWorktreeMutationSync,
} from "../src/worktree.ts"

function git(repo: string, args: readonly string[]): string {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`)
  return result.stdout
}

describe("createGitWorktreeStore", () => {
  it("requires exactly one injected Git execution capability", () => {
    expect(() => createGitWorktreeStore({ repo: "/repo" })).toThrow(/requires an injected process or Git runner/iu)
    expect(() =>
      createGitWorktreeStore({
        repo: "/repo",
        process: { run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }) },
        git: { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
      }),
    ).toThrow(/either an injected process or Git runner/iu)
  })

  it("lets pool policy reset a slot branch at an explicit base", async () => {
    const repo = await mkdtemp(join(tmpdir(), "git-super-reset-branch-"))
    const calls: Array<{ repo: string; args: readonly string[] }> = []
    const store = createGitWorktreeStore({
      repo,
      git: {
        run: async (cwd, args) => {
          calls.push({ repo: cwd, args })
          if (args[0] === "rev-parse") return { code: 0, stdout: `${join(repo, ".git")}\n`, stderr: "" }
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
      await safeRemove(repo, { within: realpathSync(tmpdir()), allowMissing: true })
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
      await safeRemove(root, { within: realpathSync(tmpdir()), allowMissing: true })
    }
  })
})
