/**
 * @failure Local branch retirement follows an alias and deletes another branch, including main (#31029).
 * @level l1
 * @consumer Yrd retireLocalBranch and explicit local branch cleanup
 * @testonly none
 * retire-when: subsumed by a broader ref-transaction property suite or symbolic branch refs cannot enter the store.
 * Existing direct-branch tests do not cover symbolic-ref dereferencing or a false successful removal.
 */
import { spawnSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createGitWorktreeStore, createLocalGitWorktreeStore } from "../src/worktree.ts"
import { createLocalGitProcess } from "../src/process.ts"
import { canonicalTmpdir, createRepository, NO_BACKGROUND_MAINTENANCE } from "./fixture.ts"

function git(repo: string, args: readonly string[]): string {
  const result = spawnSync("git", [...NO_BACKGROUND_MAINTENANCE, "-C", repo, ...args], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`)
  return result.stdout
}

/** A ref read that reports absence instead of throwing, so a lost ref is an assertion, not an error. */
function refState(repo: string, ref: string): { present: boolean; oid: string; stderr: string } {
  const result = spawnSync("git", [...NO_BACKGROUND_MAINTENANCE, "-C", repo, "rev-parse", "--verify", ref], {
    encoding: "utf8",
  })
  return { present: result.status === 0, oid: result.stdout.trim(), stderr: result.stderr.trim() }
}

describe("#31029 branch removal must not follow a symbolic ref", () => {
  it.each([
    ["already symbolic", "task/sym"],
    ["rebound before transaction", "task/sym"],
    ["already symbolic", "task/sym;false"],
  ] as const)("keeps refs/heads/main when the named branch is %s (%s)", async (mode, branch) => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-symref-31029-"))
    try {
      const repo = join(root, "repo")
      const tip = createRepository(repo, "root.txt", "root\n")
      const native = createLocalGitProcess()
      let rebound = false
      const store = createGitWorktreeStore({
        repo,
        gitProcess: {
          run: (request) => {
            if (
              mode === "rebound before transaction" &&
              request.args.includes("update-ref") &&
              request.stdin?.includes(`delete refs/heads/${branch} `)
            ) {
              git(repo, ["symbolic-ref", `refs/heads/${branch}`, "refs/heads/main"])
              rebound = true
            }
            return native.run(request)
          },
        },
      })
      git(repo, ["tag", "retained", tip])
      if (mode === "already symbolic") git(repo, ["symbolic-ref", `refs/heads/${branch}`, "refs/heads/main"])
      else git(repo, ["branch", branch, tip])

      let removalError: unknown = null
      try {
        await store.removeBranch({ branch, tip, verify: { ref: "refs/tags/retained", oid: tip } })
      } catch (error) {
        removalError = error
      }

      const main = refState(repo, "refs/heads/main")
      expect(main.present, `refs/heads/main must survive removing symref ${branch}: ${main.stderr}`).toBe(true)
      expect(main.oid).toBe(tip)
      expect(rebound).toBe(mode === "rebound before transaction")
      expect(refState(repo, "refs/tags/retained").oid).toBe(tip)
      if (mode === "already symbolic") {
        expect(removalError).toBeInstanceOf(Error)
        expect(String(removalError)).toMatch(/task\/sym.*symbolic/iu)
        expect(String(removalError)).toContain(`git symbolic-ref --delete 'refs/heads/${branch}'`)
        expect(git(repo, ["symbolic-ref", `refs/heads/${branch}`]).trim()).toBe("refs/heads/main")
        const command = /run (git symbolic-ref --delete .+) to remove only the alias$/u.exec(String(removalError))?.[1]
        if (command === undefined) throw new Error("symbolic refusal names no alias-removal command")
        const copied = spawnSync("sh", ["-c", command], { cwd: repo, encoding: "utf8" })
        expect(copied.status, copied.stderr).toBe(0)
        expect(refState(repo, `refs/heads/${branch}`).present).toBe(false)
        expect(refState(repo, "refs/heads/main").oid).toBe(tip)
      } else {
        // Chief fa34f6ee: the native transaction may remove the literal alias introduced after inspection.
        expect(removalError).toBeNull()
        expect(refState(repo, `refs/heads/${branch}`).present).toBe(false)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("keeps the target when the symref names a branch other than main", async () => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-symref-other-31029-"))
    try {
      const repo = join(root, "repo")
      const tip = createRepository(repo, "root.txt", "root\n")
      const store = createLocalGitWorktreeStore({ repo })
      git(repo, ["branch", "release/keep"])
      git(repo, ["tag", "retained", tip])
      git(repo, ["symbolic-ref", "refs/heads/task/sym", "refs/heads/release/keep"])

      let removalError: unknown = null
      try {
        await store.removeBranch({ branch: "task/sym", tip, verify: { ref: "refs/tags/retained", oid: tip } })
      } catch (error) {
        removalError = error
      }

      const kept = refState(repo, "refs/heads/release/keep")
      expect(kept.present, `refs/heads/release/keep must survive removing its symref: ${kept.stderr}`).toBe(true)
      expect(kept.oid).toBe(tip)
      expect(refState(repo, "refs/tags/retained").oid).toBe(tip)
      expect(removalError).toBeInstanceOf(Error)
      expect(String(removalError)).toMatch(/task\/sym.*symbolic/iu)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("control: a plain branch is still deleted and main is untouched", async () => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-plain-31029-"))
    try {
      const repo = join(root, "repo")
      const tip = createRepository(repo, "root.txt", "root\n")
      const store = createLocalGitWorktreeStore({ repo })
      git(repo, ["branch", "task/plain"])

      await store.removeBranch({ branch: "task/plain", tip })

      expect(refState(repo, "refs/heads/task/plain").present).toBe(false)
      expect(refState(repo, "refs/heads/main").oid).toBe(tip)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
