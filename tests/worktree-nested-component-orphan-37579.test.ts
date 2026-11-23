/**
 * @failure git-super worktree remove leaves a component worktree behind when its checkout sits outside the removed
 *   parent and its registration lives under the parent's admin dir (#37579).
 * @level l1
 * @consumer yrd env close and every super remover; a leftover checkout has a .git pointing at a deleted gitdir
 * @reach fs-walk <fixture-only: isolated Git repositories and their retained children>
 * @testonly none
 */
import { existsSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import { createGitWorktreeStore } from "../src/worktree.ts"
import { createLocalGitProcess } from "../src/process.ts"
import { runCli } from "../src/cli.ts"
import { addNestedAlphaSubmodule, canonicalTmpdir, createProductFixture, git } from "./fixture.ts"

/** One super worktree holding a component worktree whose checkout sits outside it, registered under its admin dir. */
function nestedFixture(root: string) {
  const fixture = createProductFixture(root)
  const target = join(root, "target")
  git(fixture.product, "worktree", "add", "--detach", target)
  git(target, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive")
  const external = join(root, "alpha-external")
  git(join(target, "packages/alpha"), "worktree", "add", "-b", "task/external", external, "HEAD")
  const admin = git(external, "rev-parse", "--absolute-git-dir")
  expect(admin).toContain("/modules/")
  expect(admin).toContain("/worktrees/")
  return { fixture, target, external, admin }
}

describe("#37579 nested component worktree outside the removed parent", () => {
  it("removes a clean component worktree whose HEAD the component store still keeps", async () => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-37579-clean-"))
    try {
      const { fixture, target, external } = nestedFixture(root)
      const lines: string[] = []
      const store = createGitWorktreeStore({
        repo: fixture.product,
        gitProcess: createLocalGitProcess(),
        report: (line) => lines.push(line),
      })
      await store.remove(target)
      expect(existsSync(target)).toBe(false)
      expect(existsSync(external)).toBe(false)
      expect(lines.join("")).toContain(`${external}: will remove (clean, contained)`)
      expect(lines.join("")).toContain(`${external}: removed (clean, contained)`)
    } finally {
      // raw-delete-allow: this isolated mkdtemp fixture owns every path beneath root
      await rm(root, { recursive: true, force: true })
    }
  })

  it("removes a clean component worktree whose own checkout carries an initialized submodule", async () => {
    // 37970 / 95283a71: km and its vendors are submodules, so a km worktree registered under a landing's store
    // refuses plain `git worktree remove` with "working trees containing submodules cannot be moved or removed".
    // The landing then never reaps and deferred never reaches 0.
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-37579-submodule-component-"))
    try {
      const fixture = addNestedAlphaSubmodule(createProductFixture(root))
      const target = join(root, "target")
      git(fixture.product, "worktree", "add", "--detach", target)
      git(target, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive")
      const external = join(root, "alpha-external")
      git(join(target, "packages/alpha"), "worktree", "add", "-b", "task/external", external, "HEAD")
      git(external, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive")
      const lines: string[] = []
      const store = createGitWorktreeStore({
        repo: fixture.product,
        gitProcess: createLocalGitProcess(),
        report: (line) => lines.push(line),
      })
      await store.remove(target)
      expect(existsSync(target)).toBe(false)
      expect(existsSync(external)).toBe(false)
      expect(lines.join("")).toContain(`${external}: will remove (clean, contained)`)
      expect(lines.join("")).toContain(`${external}: removed (clean, contained)`)
    } finally {
      // raw-delete-allow: this isolated mkdtemp fixture owns every path beneath root
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    [
      "modified",
      (root: string, external: string) => writeFileSync(join(external, "dirty.txt"), "work\n"),
      "dirty or untracked work",
    ],
    [
      "untracked",
      (_root: string, external: string) => writeFileSync(join(external, "new.txt"), "untracked\n"),
      "dirty or untracked work",
    ],
  ])("refuses on %s work and leaves the parent intact", async (_name, dirty, reason) => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-37579-dirty-"))
    try {
      const { fixture, target, external } = nestedFixture(root)
      dirty(root, external)
      const store = createGitWorktreeStore({ repo: fixture.product, gitProcess: createLocalGitProcess() })
      const error = await store.remove(target).then(
        () => "",
        (cause: unknown) => String(cause),
      )
      expect(error).toContain("nested component worktree(s)")
      expect(error).toContain(reason)
      expect(error).toContain(external)
      expect(existsSync(target)).toBe(true)
      expect(existsSync(join(external, ".git"))).toBe(true)
    } finally {
      // raw-delete-allow: this isolated mkdtemp fixture owns every path beneath root
      await rm(root, { recursive: true, force: true })
    }
  })

  it("refuses when the component HEAD is not reachable from a ref the store keeps", async () => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-37579-unreachable-"))
    try {
      const { fixture, target, external } = nestedFixture(root)
      // A clean commit that only this worktree knows: commit, detach, then drop the branch through the store.
      git(external, "commit", "-q", "--allow-empty", "-m", "work only this checkout knows")
      const head = git(external, "rev-parse", "HEAD")
      git(external, "checkout", "-q", "--detach", "HEAD")
      const storePath = dirname(dirname(git(external, "rev-parse", "--absolute-git-dir")))
      git(storePath, "--git-dir=" + storePath, "update-ref", "-d", "refs/heads/task/external")
      expect(git(external, "rev-parse", "HEAD")).toBe(head)
      expect(git(storePath, "--git-dir=" + storePath, "for-each-ref", "--format=%(objectname)")).not.toContain(head)
      const store = createGitWorktreeStore({ repo: fixture.product, gitProcess: createLocalGitProcess() })
      const error = await store.remove(target).then(
        () => "",
        (cause: unknown) => String(cause),
      )
      expect(error).toContain("not reachable from a ref")
      expect(existsSync(target)).toBe(true)
      expect(existsSync(join(external, ".git"))).toBe(true)
    } finally {
      // raw-delete-allow: this isolated mkdtemp fixture owns every path beneath root
      await rm(root, { recursive: true, force: true })
    }
  })

  it("dry run names what it would remove and removes nothing", async () => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-37579-dryrun-"))
    try {
      const { fixture, target, external } = nestedFixture(root)
      const lines: string[] = []
      const store = createGitWorktreeStore({
        repo: fixture.product,
        gitProcess: createLocalGitProcess(),
        report: (line) => lines.push(line),
      })
      await store.remove(target, { dryRun: true })
      expect(lines.join("")).toContain(`${external}: will remove (clean, contained)`)
      expect(lines.join("")).not.toContain("removed (clean, contained)")
      expect(existsSync(target)).toBe(true)
      expect(existsSync(join(external, ".git"))).toBe(true)
    } finally {
      // raw-delete-allow: this isolated mkdtemp fixture owns every path beneath root
      await rm(root, { recursive: true, force: true })
    }
  })

  it("carries --dry-run from the command line into the store", async () => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-37579-cli-dryrun-"))
    try {
      const { fixture, target, external } = nestedFixture(root)
      const out = {
        output: "",
        write(value: string) {
          this.output += value
          return true
        },
      }
      const err = { ...out, output: "" }
      const retained = join(root, "retained")
      const code = await runCli(
        ["--repo", fixture.product, "worktree", "remove", target, "--retain", retained, "--dry-run"],
        out,
        err,
      )
      expect(code, err.output).toBe(0)
      expect(out.output + err.output).toContain(`${external}: will remove (clean, contained)`)
      expect(err.output).not.toContain("removed (clean, contained)")
      expect(existsSync(target)).toBe(true)
      expect(existsSync(join(external, ".git"))).toBe(true)
      expect(existsSync(retained)).toBe(false)
    } finally {
      // raw-delete-allow: this isolated mkdtemp fixture owns every path beneath root
      await rm(root, { recursive: true, force: true })
    }
  })
})
