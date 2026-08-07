/**
 * @failure Worktree mutations can escape the shared repository lock or accept ambiguous process authority.
 * @level l1
 * @consumer Yrd worktree and deployment stores
 */
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
})
