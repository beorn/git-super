/**
 * @failure A successful gitlink mutation is reported as a clean pre-write failure when releasing the shared lock fails.
 * @level l1
 * @consumer @i/10-merge-queue/git-super-one-layer F1 and long-running Yrd callers
 */

import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterEach, expect, test, vi } from "vitest"

vi.mock("@bearly/flock", () => ({
  tryAcquireFlock: () => ({
    release() {
      throw new Error("release exploded")
    },
  }),
}))

import { writeGitlink } from "../src/gitlink.ts"
import { advanceRepository, canonicalTmpdir as tmpdir, createProductFixture, git } from "./fixture.ts"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test("reports a verified write plus lock-release failure as partial", async () => {
  const root = mkdtempSync(join(tmpdir(), "git-super-gitlink-release-"))
  roots.push(root)
  const product = createProductFixture(root)
  const next = advanceRepository(product.alpha, "alpha.ts", "export const alpha = 5\n")
  git(join(product.product, "packages/alpha"), "fetch", "-q", "origin", next)

  const result = await writeGitlink({ repo: product.product, path: "packages/alpha", commit: next })

  expect(result).toMatchObject({
    state: "failed",
    partial: true,
    detail: {
      code: "post-write-lock-release-failed",
      phase: "release-mutation-lock",
      paths: ["packages/alpha"],
      objectIds: [next],
    },
    repositories: [{ repository: product.product, state: "updated", refs: [] }],
  })
  expect(git(product.product, "ls-files", "--stage", "--", "packages/alpha")).toBe(`160000 ${next} 0\tpackages/alpha`)
})
