/**
 * @failure A contained writer can mutate shared refs/config or strand private commits when its projection retires.
 * @level l0
 * @consumer Hab container workspaces
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { tempTree } from "removely"
import { describe, expect, it } from "vitest"
import {
  preparePrivateGitMetadataProjection,
  preservePrivateGitMetadataProjection,
  retirePrivateGitMetadataProjection,
} from "git-super/projection"
import { tryGit } from "../src/git.ts"
import { addNestedAlphaSubmodule, createProductFixture, git } from "./fixture.ts"

function privateGit(worktree: string, gitDirectory: string, ...args: string[]): string {
  return git(worktree, "--git-dir", gitDirectory, "--work-tree", worktree, ...args)
}

describe("private Git metadata projection", () => {
  it("projects recursive private metadata and preserves commits without touching shared metadata", async () => {
    await using fixture = await tempTree("git-super-projection-")
    const product = addNestedAlphaSubmodule(createProductFixture(fixture.path)).product
    const worktree = fixture.resolve("seat")
    git(product, "worktree", "add", "-q", "-b", "seat", worktree)
    git(worktree, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive")
    git(product, "config", "--local", "core.hooksPath", "host-hooks")

    const sharedRefsBefore = git(product, "show-ref")
    const sharedConfigPath = git(product, "rev-parse", "--path-format=absolute", "--git-path", "config")
    const sharedConfigBefore = readFileSync(sharedConfigPath, "utf8")
    const storageRoot = fixture.resolve("projection")
    const projection = await preparePrivateGitMetadataProjection({ storageRoot, worktree })

    expect(projection.repositories.map(({ relativePath }) => relativePath)).toEqual([
      ".",
      "packages/alpha",
      "packages/alpha/apps/maddoc",
      "vendor/beta",
    ])
    expect(projection.mounts.filter(({ kind }) => kind === "private-git-directory")).toHaveLength(4)
    expect(projection.mounts.filter(({ kind }) => kind === "borrowed-objects")).toHaveLength(4)
    expect(projection.mounts.filter(({ kind }) => kind === "git-file-overlay")).toHaveLength(4)
    expect(projection.mounts.every(({ source, target }) => existsSync(source) && target.startsWith("/"))).toBe(true)
    expect(projection.mounts.filter(({ kind }) => kind === "borrowed-objects").every(({ readOnly }) => readOnly)).toBe(
      true,
    )
    expect(
      projection.mounts.filter(({ kind }) => kind === "private-git-directory").every(({ readOnly }) => !readOnly),
    ).toBe(true)

    const root = projection.repositories.find(({ relativePath }) => relativePath === ".")
    expect(root).toBeDefined()
    if (root === undefined) throw new Error("root projection missing")
    expect(privateGit(worktree, root.privateGitDirectory, "config", "--local", "--get", "core.hooksPath")).toBe(
      "/dev/null",
    )
    writeFileSync(`${worktree}/contained.txt`, "private\n")
    privateGit(worktree, root.privateGitDirectory, "add", "contained.txt")
    privateGit(worktree, root.privateGitDirectory, "commit", "-q", "-m", "contained commit")
    const privateSha = privateGit(worktree, root.privateGitDirectory, "rev-parse", "HEAD")

    expect(git(product, "show-ref")).toBe(sharedRefsBefore)
    expect(readFileSync(sharedConfigPath, "utf8")).toBe(sharedConfigBefore)
    expect(tryGit(product, ["cat-file", "-e", `${privateSha}^{commit}`]).exitCode).not.toBe(0)

    const preservation = await preservePrivateGitMetadataProjection({
      refNamespace: "refs/hab-preserved/seat-5",
      storageRoot,
    })
    const preservedRoot = preservation.refs.find(({ relativePath }) => relativePath === ".")
    expect(preservedRoot).toBeDefined()
    if (preservedRoot === undefined) throw new Error("root preservation evidence missing")
    expect(git(product, "rev-parse", preservedRoot.preservedRef)).toBe(privateSha)
    expect(readFileSync(sharedConfigPath, "utf8")).toBe(sharedConfigBefore)

    await expect(retirePrivateGitMetadataProjection({ storageRoot })).resolves.toMatchObject({ kind: "preserved" })
    expect(existsSync(storageRoot)).toBe(false)
  })

  it("retires an unchanged projection without adding preservation refs", async () => {
    await using fixture = await tempTree("git-super-projection-unchanged-")
    const product = createProductFixture(fixture.path).product
    const worktree = fixture.resolve("seat")
    git(product, "worktree", "add", "-q", "-b", "seat", worktree)
    git(worktree, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive")
    const sharedRefsBefore = git(product, "show-ref")
    const storageRoot = fixture.resolve("projection")
    await preparePrivateGitMetadataProjection({ storageRoot, worktree })

    await expect(retirePrivateGitMetadataProjection({ storageRoot })).resolves.toMatchObject({ kind: "unchanged" })
    expect(git(product, "show-ref")).toBe(sharedRefsBefore)
    expect(existsSync(storageRoot)).toBe(false)
  })

  it("preserves reflog-only commits and refuses retirement when preservation is absent or stale", async () => {
    await using fixture = await tempTree("git-super-projection-retire-")
    const product = createProductFixture(fixture.path).product
    const worktree = fixture.resolve("seat")
    git(product, "worktree", "add", "-q", "-b", "seat", worktree)
    git(worktree, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive")
    const storageRoot = fixture.resolve("projection")
    const projection = await preparePrivateGitMetadataProjection({ storageRoot, worktree })
    const root = projection.repositories.find(({ relativePath }) => relativePath === ".")
    if (root === undefined) throw new Error("root projection missing")

    writeFileSync(`${worktree}/reflog-only.txt`, "private then reset\n")
    privateGit(worktree, root.privateGitDirectory, "add", "reflog-only.txt")
    privateGit(worktree, root.privateGitDirectory, "commit", "-q", "-m", "reflog-only commit")
    const reflogOnlySha = privateGit(worktree, root.privateGitDirectory, "rev-parse", "HEAD")
    privateGit(worktree, root.privateGitDirectory, "reset", "--hard", "HEAD^")
    await expect(retirePrivateGitMetadataProjection({ storageRoot })).rejects.toThrow("preservation")
    const preservation = await preservePrivateGitMetadataProjection({
      refNamespace: "refs/hab-preserved/seat-5",
      storageRoot,
    })
    expect(preservation.refs).toContainEqual(
      expect.objectContaining({ sourceRef: `unreferenced:${reflogOnlySha}`, sha: reflogOnlySha }),
    )
    expect(tryGit(product, ["cat-file", "-e", `${reflogOnlySha}^{commit}`]).exitCode).toBe(0)

    writeFileSync(`${worktree}/after-preserve.txt`, "new private commit\n")
    privateGit(worktree, root.privateGitDirectory, "add", "after-preserve.txt")
    privateGit(worktree, root.privateGitDirectory, "commit", "-q", "-m", "after preservation")
    await expect(retirePrivateGitMetadataProjection({ storageRoot })).rejects.toThrow("changed after preservation")
    expect(existsSync(storageRoot)).toBe(true)
  })

  it("refuses to retire or claim preservation for a dirty private index", async () => {
    await using fixture = await tempTree("git-super-projection-dirty-")
    const product = createProductFixture(fixture.path).product
    const worktree = fixture.resolve("seat")
    git(product, "worktree", "add", "-q", "-b", "seat", worktree)
    git(worktree, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive")
    const storageRoot = fixture.resolve("projection")
    const projection = await preparePrivateGitMetadataProjection({ storageRoot, worktree })
    const root = projection.repositories.find(({ relativePath }) => relativePath === ".")
    if (root === undefined) throw new Error("root projection missing")

    writeFileSync(`${worktree}/staged.txt`, "staged but not committed\n")
    privateGit(worktree, root.privateGitDirectory, "add", "staged.txt")
    await expect(retirePrivateGitMetadataProjection({ storageRoot })).rejects.toThrow("preservation")
    await expect(
      preservePrivateGitMetadataProjection({ refNamespace: "refs/hab-preserved/seat-5", storageRoot }),
    ).rejects.toThrow("dirty private Git state")
  })

  it("refuses storage that overlaps the checkout", async () => {
    await using fixture = await tempTree("git-super-projection-overlap-")
    const product = createProductFixture(fixture.path).product
    await expect(
      preparePrivateGitMetadataProjection({ storageRoot: `${product}/.private-git`, worktree: product }),
    ).rejects.toThrow("must not overlap")
  })

  it("mounts private metadata directly over an ordinary checkout Git directory", async () => {
    await using fixture = await tempTree("git-super-projection-directory-")
    const worktree = createProductFixture(fixture.path).alpha
    const storageRoot = fixture.resolve("projection")
    const projection = await preparePrivateGitMetadataProjection({ storageRoot, worktree })
    const root = projection.repositories[0]

    expect(root).toMatchObject({ gitEntryKind: "directory", relativePath: ".", worktree })
    expect(root).not.toHaveProperty("gitFile")
    expect(projection.mounts).toContainEqual({
      kind: "private-git-directory",
      source: root?.privateGitDirectory,
      target: `${worktree}/.git`,
      readOnly: false,
    })
    await expect(retirePrivateGitMetadataProjection({ storageRoot })).resolves.toMatchObject({ kind: "unchanged" })
  })
})
