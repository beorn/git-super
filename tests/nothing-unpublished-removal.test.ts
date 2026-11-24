/**
 * @failure 38198: `worktree remove --retain` writes a retained copy of an environment that holds nothing unique
 *          (spending the estate one copy at a time), or it skips that copy on a broken read — a failed fetch, no
 *          remote-tracking refs, an unpublished commit, a dirty worktree — and destroys the only copy of the work.
 * @level l1
 * @consumer yrd env close --retain, whose receipt must say `not-retained` with the refs that proved it
 * @reach fs-walk <fixture-only: mkdtemp Git repositories and one local bare remote the test owns>
 * @testonly none
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createLocalGitWorktreeStore } from "../src/worktree.ts"
import type { WorktreeRemovalProof } from "../src/worktree-removal.ts"
import { canonicalTmpdir, createRepository, git } from "./fixture.ts"

/** A product repo whose `main` is pushed to a local bare remote, so remote-tracking refs are real evidence. */
function repoWithRemote(root: string): { repo: string; remote: string } {
  const remote = join(root, "origin.git")
  mkdirSync(remote, { recursive: true })
  git(remote, "init", "-q", "--bare", "-b", "main")
  const repo = join(root, "product")
  createRepository(repo, "product.ts", "export const product = 1\n")
  git(repo, "remote", "add", "origin", remote)
  git(repo, "push", "-q", "origin", "main")
  return { repo, remote }
}

async function removeWithRetention(
  repo: string,
  linked: string,
  retentionRoot: string,
): Promise<{ proof: WorktreeRemovalProof }> {
  const store = createLocalGitWorktreeStore({ repo })
  const proofs: WorktreeRemovalProof[] = []
  await store.remove(linked, {
    retention: { root: retentionRoot, report: (proof) => void proofs.push(proof) },
  })
  expect(proofs).toHaveLength(1)
  return { proof: proofs[0] as WorktreeRemovalProof }
}

describe("worktree remove --retain with the nothing-unpublished predicate (#38198)", () => {
  it("writes no copy when every head is published and the worktree is clean", async () => {
    const root = mkdtempSync(join(canonicalTmpdir(), "git-super-38198-published-"))
    try {
      const { repo } = repoWithRemote(root)
      const linked = join(root, "env")
      git(repo, "worktree", "add", "-q", "-b", "dev", linked, "main")
      const retentionRoot = join(root, "retained")
      const lines: string[] = []
      // The report stream is the operator's only view of the verdict, so the skip has to name it.
      const store = createLocalGitWorktreeStore({ repo, report: (line) => void lines.push(line) })
      const proofs: WorktreeRemovalProof[] = []
      await store.remove(linked, {
        retention: { root: retentionRoot, report: (proof) => void proofs.push(proof) },
      })
      expect(lines.join("\n")).toContain("nothing-unpublished:")
      expect(proofs).toHaveLength(1)
      const proof = proofs[0] as WorktreeRemovalProof
      expect(proof.retained).toBeNull()
      expect(proof.retention?.kind).toBe("not-retained")
      if (proof.retention?.kind !== "not-retained") throw new Error("expected a not-retained receipt")
      expect(proof.retention.provedBy).toContain("refs/remotes/origin/main")
      expect(proof.retention.reason).toContain("refs/remotes/origin/main")
      // No copy anywhere: the estate did not grow by one entry for an environment holding nothing unique.
      expect(existsSync(retentionRoot)).toBe(false)
      expect(existsSync(linked)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("writes the copy when the environment holds a commit no remote ref reaches", async () => {
    const root = mkdtempSync(join(canonicalTmpdir(), "git-super-38198-unpublished-"))
    try {
      const { repo } = repoWithRemote(root)
      const linked = join(root, "env")
      git(repo, "worktree", "add", "-q", "-b", "dev", linked, "main")
      writeFileSync(join(linked, "local.ts"), "export const local = 1\n")
      git(linked, "add", "local.ts")
      git(linked, "commit", "-q", "-m", "local only")
      const retentionRoot = join(root, "retained")
      const { proof } = await removeWithRetention(repo, linked, retentionRoot)
      expect(proof.retention?.kind).toBe("retained")
      const entries = readdirSync(retentionRoot)
      expect(entries).toHaveLength(1)
      expect(existsSync(join(retentionRoot, entries[0] as string, "manifest.json"))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("never treats a dirty worktree as nothing to keep", async () => {
    const root = mkdtempSync(join(canonicalTmpdir(), "git-super-38198-dirty-"))
    try {
      const { repo } = repoWithRemote(root)
      const linked = join(root, "env")
      git(repo, "worktree", "add", "-q", "-b", "dev", linked, "main")
      writeFileSync(join(linked, "uncommitted.ts"), "export const local = 1\n")
      const retentionRoot = join(root, "retained")
      const store = createLocalGitWorktreeStore({ repo })
      const proofs: WorktreeRemovalProof[] = []
      // Retention's own dirty-store gate refuses this; what the predicate must NOT do is answer `published` and let
      // the uncommitted file die. Either way the environment and its file survive.
      await expect(
        store.remove(linked, {
          retention: { root: retentionRoot, report: (proof) => void proofs.push(proof) },
        }),
      ).rejects.toThrow(/dirty/u)
      expect(existsSync(join(linked, "uncommitted.ts"))).toBe(true)
      expect(proofs).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("writes the copy when publication cannot be proved at all", async () => {
    const root = mkdtempSync(join(canonicalTmpdir(), "git-super-38198-unknown-"))
    try {
      const repo = join(root, "product")
      createRepository(repo, "product.ts", "export const product = 1\n")
      const linked = join(root, "env")
      git(repo, "worktree", "add", "-q", "-b", "dev", linked, "main")
      const { proof } = await removeWithRetention(repo, linked, join(root, "retained"))
      // No remote-tracking refs: unknown, never "nothing to keep".
      expect(proof.retention?.kind).toBe("retained")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
