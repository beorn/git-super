/**
 * @failure Worktree mutations can escape the shared repository lock or accept ambiguous process authority.
 * @level l1
 * @consumer Yrd worktree and deployment stores
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createGitWorktreeStore } from "../src/worktree.ts"

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
      await rm(repo, { recursive: true, force: true })
    }
  })
})
