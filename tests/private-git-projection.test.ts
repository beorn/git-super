/**
 * @failure A seat shares host Git authority or loses root/child commits when retirement runs after restart.
 * @level l2
 * @consumer Hab seat sandbox lifecycle using the durable GitSuper projection record
 * @reach fs-walk <fixture-only: isolated native Git product and retention directories>
 * @testonly none
 */
import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import * as GitSuper from "../src/index.ts"
import { addNestedAlphaSubmodule, advanceRepository, canonicalTmpdir, createProductFixture, git } from "./fixture.ts"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it("isolates native root and nested-child authoring and retires from a durable record in another process", async () => {
  const root = await mkdtemp(join(canonicalTmpdir(), "git-super-projection-"))
  roots.push(root)
  const fixture = addNestedAlphaSubmodule(createProductFixture(root))
  git(fixture.product, "config", "-f", ".gitmodules", "submodule.vendor/beta.private", "true")
  git(fixture.product, "add", ".gitmodules")
  git(fixture.product, "commit", "-q", "-m", "declare private fixture child")
  const base = git(fixture.product, "rev-parse", "HEAD")
  const sourceConfig = readFileSync(join(fixture.product, ".git", "config"), "utf8")
  const destination = join(root, "seat")

  const result = await GitSuper.projectPrivateGitWorktree({
    sourceCheckout: fixture.product,
    commit: base,
    branch: "task/seat",
    destination,
    excludedSubmodules: ["vendor/beta"],
  })
  expect(result.state, JSON.stringify(result.detail)).toBe("updated")
  const projection = result.projection
  expect(projection).toMatchObject({ checkout: destination, base, branch: "task/seat" })
  if (projection === undefined) throw new Error("successful projection omitted its durable record")
  expect(statSync(join(destination, ".git")).isDirectory()).toBe(true)
  expect(existsSync(join(destination, "vendor/beta", ".git"))).toBe(false)
  expect(projection.excluded).toContainEqual(expect.objectContaining({ path: "vendor/beta", reason: "excluded" }))
  expect(projection.mounts).toContainEqual({ source: destination, target: destination, mode: "rw" })
  expect(projection.mounts.some((mount: { mode: "ro" | "rw" }) => mount.mode === "ro")).toBe(true)
  for (const mount of projection.mounts) expect(mount.target).toBe(mount.source)
  const privateConfig = git(destination, "config", "--local", "--list")
  expect(privateConfig).not.toMatch(/remote\..*\.url=|credential\.|include\./u)

  const alpha = join(destination, "packages/alpha")
  const leaf = join(alpha, "apps/maddoc")
  const leafCommit = advanceRepository(leaf, "leaf.ts", "export const leaf = 2\n")
  git(alpha, "add", "apps/maddoc")
  git(alpha, "commit", "-q", "-m", "author nested child pin")
  git(destination, "add", "packages/alpha")
  git(destination, "commit", "-q", "-m", "author root pin")
  const rootCommit = git(destination, "rev-parse", "HEAD")
  const danglingRoot = git(destination, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "unreferenced root commit")
  const danglingLeaf = git(leaf, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "unreferenced child commit")
  expect(git(fixture.product, "rev-parse", "HEAD")).toBe(base)
  expect(git(join(fixture.product, "packages/alpha/apps/maddoc"), "rev-parse", "HEAD")).toBe(fixture.leafBase)
  expect(readFileSync(join(fixture.product, ".git", "config"), "utf8")).toBe(sourceConfig)

  // No creator closure or methods survive this JSON boundary. A different process owns retirement.
  const record = join(root, "projection.json")
  writeFileSync(record, JSON.stringify(projection))
  const retentionRoot = join(root, "retained")
  const entry = new URL("../src/index.ts", import.meta.url).href
  const retiring = spawnSync(
    process.execPath,
    [
      "-e",
      `import { readFileSync } from "node:fs";
       const { retirePrivateGitProjection } = await import(process.argv[1]);
       const projection = JSON.parse(readFileSync(process.argv[2], "utf8"));
       const result = await retirePrivateGitProjection(projection, process.argv[3]);
       process.stdout.write(JSON.stringify(result));`,
      entry,
      record,
      retentionRoot,
    ],
    { encoding: "utf8" },
  )
  expect(retiring.status, retiring.stderr).toBe(0)
  const retired = JSON.parse(retiring.stdout)
  if (
    typeof retired !== "object" ||
    retired === null ||
    !("state" in retired) ||
    !("manifest" in retired) ||
    !("retainedPaths" in retired) ||
    typeof retired.manifest !== "string" ||
    !Array.isArray(retired.retainedPaths)
  ) {
    throw new Error(`retirement omitted its durable proof: ${retiring.stdout}`)
  }
  expect(retired.state, JSON.stringify(retired)).toBe("updated")
  expect(existsSync(destination)).toBe(false)
  expect(existsSync(retired.manifest)).toBe(true)
  expect(retired.retainedPaths.length).toBeGreaterThan(0)
  for (const path of retired.retainedPaths) {
    if (typeof path !== "string") throw new Error("retirement returned a non-path retained value")
    expect(existsSync(path)).toBe(true)
  }

  // Inspect native retained repositories without fixing an internal manifest layout in the test.
  const stores = readdirSync(retentionRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name === "objects")
    .map((entry) => entry.parentPath)
  for (const commit of [rootCommit, leafCommit, danglingRoot, danglingLeaf]) {
    const readable = stores.some(
      (store) => spawnSync("git", ["--git-dir", store, "cat-file", "-e", `${commit}^{commit}`]).status === 0,
    )
    expect(readable, `retirement lost authored object ${commit}`).toBe(true)
  }
})
