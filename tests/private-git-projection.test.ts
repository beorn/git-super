/**
 * @failure A seat shares host Git authority or loses root/child commits when retirement runs after restart.
 * @level l2
 * @consumer Hab seat sandbox lifecycle using the durable GitSuper projection record
 * @reach fs-walk <fixture-only: isolated native Git product and retention directories>
 * @testonly none
 */
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { existsSync, readdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import * as GitSuper from "../src/index.ts"
import { createExclusive } from "../src/exclusive.ts"
import { shellQuote } from "../src/shell-command.ts"
import { addNestedAlphaSubmodule, advanceRepository, canonicalTmpdir, createProductFixture, git } from "./fixture.ts"

const roots: string[] = []
// Binding-only fixture: sandbox stop truth is proved separately by its native lifecycle tests.
function certificateFor(projection: GitSuper.PrivateGitProjection): GitSuper.PrivateGitStopCertificate {
  const { checkout, base, branch, createdAt } = projection
  return {
    schema: "hab-sandbox/stop-certificate/1",
    subject: "fixture-unit",
    container: "fixture-stopped-container",
    projection: { checkout, base, branch, createdAt },
    certifiedAt: new Date().toISOString(),
    certifier: "fixture-binding-validator",
  }
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

// CTO63d0a344: retirement needs the sandbox lifetime proof; existing lifecycle tests lacked this gate.
it("refuses retirement without a unit stop certificate", async () => {
  const root = await mkdtemp(join(canonicalTmpdir(), "git-super-stop-certificate-"))
  roots.push(root)
  const fixture = createProductFixture(root)
  const destination = join(root, "seat")
  const projected = await GitSuper.projectPrivateGitWorktree({
    sourceCheckout: fixture.product,
    commit: fixture.productBase,
    branch: "task/seat",
    destination,
    excludedSubmodules: [],
  })
  if (projected.projection === undefined) throw new Error(JSON.stringify(projected.detail))
  const retired = await GitSuper.retirePrivateGitProjection(projected.projection, join(root, "retained"))
  expect(retired.state, "retirement accepted an absent unit stop certificate").toBe("failed")
  expect(retired.detail?.message).toContain("stop certificate")
  expect(existsSync(destination)).toBe(true)
})

// CTOf929e937 + 2dc978d4: durable JSON identity and age prevent reuse across projection lifetimes.
// The missing-certificate test does not exercise malformed fields or older same-path certificates.
it("refuses malformed, mismatched and stale stop certificates without removing native state", async () => {
  const root = await mkdtemp(join(canonicalTmpdir(), "git-super-certificate-binding-"))
  roots.push(root)
  const fixture = createProductFixture(root)
  const destination = join(root, "seat")
  const projected = await GitSuper.projectPrivateGitWorktree({
    sourceCheckout: fixture.product,
    commit: fixture.productBase,
    branch: "task/seat",
    destination,
    excludedSubmodules: [],
  })
  if (projected.projection === undefined) throw new Error(JSON.stringify(projected.detail))
  const projection = projected.projection
  const certificate = certificateFor(projection)
  const earlier = new Date(Date.parse(projection.createdAt) - 1).toISOString()
  const cases = [
    [{ ...certificate, schema: "wrong/1" }, "schema"],
    ...(["subject", "container", "certifier", "certifiedAt"] as const).map(
      (field) => [{ ...certificate, [field]: "" }, field] as const,
    ),
    ...(["checkout", "base", "branch"] as const).map(
      (field) => [{ ...certificate, projection: { ...certificate.projection, [field]: "wrong" } }, field] as const,
    ),
    [{ ...certificate, projection: { ...certificate.projection, createdAt: earlier } }, "createdAt"],
    [{ ...certificate, certifiedAt: earlier }, "predates"],
    [{ ...certificate, certifiedAt: "invalid-date" }, "predates"],
  ] as const
  for (const [input, message] of cases) {
    // Exercise malformed durable input deliberately at the public JSON boundary.
    const result = await GitSuper.retirePrivateGitProjection(
      projection,
      join(root, "retained"),
      input as GitSuper.PrivateGitStopCertificate,
    )
    expect(result.state, JSON.stringify(result)).toBe("failed")
    expect(result.detail?.message).toContain(message)
    expect(existsSync(destination)).toBe(true)
  }
  const { createdAt: _createdAt, ...oldRecord } = projection
  const old = await GitSuper.retirePrivateGitProjection(
    oldRecord as GitSuper.PrivateGitProjection,
    join(root, "retained"),
    certificate,
  )
  expect(old.state).toBe("failed")
  expect(old.detail?.message).toContain("record predates createdAt; re-create the projection")
  expect(existsSync(destination)).toBe(true)
})

it("does not execute configuration changed by another process after preflight", async () => {
  const root = await mkdtemp(join(canonicalTmpdir(), "git-super-config-race-"))
  roots.push(root)
  const fixture = createProductFixture(root)
  const destination = join(root, "seat")
  const projected = await GitSuper.projectPrivateGitWorktree({
    sourceCheckout: fixture.product,
    commit: fixture.productBase,
    branch: "task/seat",
    destination,
    excludedSubmodules: [],
  })
  expect(projected.state, JSON.stringify(projected.detail)).toBe("updated")
  if (projected.projection === undefined) throw new Error("projection omitted its durable record")
  const marker = join(root, "helper-executed")
  const helper = join(root, "helper.ts")
  writeFileSync(
    helper,
    `import { writeFileSync } from "node:fs"; writeFileSync(process.argv[2], "executed"); process.stdout.write("token\\0");`,
  )
  const encoded = join(root, "hostile.config")
  git(root, "config", "--file", encoded, "core.fsmonitor", [process.execPath, helper, marker].map(shellQuote).join(" "))
  const raced = join(root, "configuration-mutated")
  const rootGit = join(destination, ".git")
  const contender = spawn(
    process.execPath,
    [
      "-e",
      `
    import { watch, appendFileSync, readFileSync, writeFileSync } from "node:fs";
    const watcher = watch(process.argv[1], { recursive: true }, (_event, path) => {
      if (!String(path).includes("yrd-worktree-mutations")) return;
      watcher.close();
      appendFileSync(process.argv[2], "\\n" + readFileSync(process.argv[3], "utf8"));
      writeFileSync(process.argv[4], "mutated after custody started");
    });
    process.stdout.write("ready\\n");`,
      rootGit,
      join(rootGit, "config"),
      encoded,
      raced,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  )
  const ended = once(contender, "exit")
  try {
    const [ready] = await once(contender.stdout, "data")
    expect(String(ready)).toContain("ready")
    const retained = await GitSuper.retainPrivateGitProjection(projected.projection, join(root, "retained"))
    await ended
    expect(existsSync(raced), "the native contender did not reach the custody window").toBe(true)
    expect(existsSync(marker), "host custody executed configuration changed after preflight").toBe(false)
    expect(retained.state).toBe("failed")
    expect(existsSync(destination)).toBe(true)
  } finally {
    contender.kill()
    await ended
  }
})

it("refuses seat-configured native Git helpers before host custody can execute them", async () => {
  const root = await mkdtemp(join(canonicalTmpdir(), "git-super-hostile-config-"))
  roots.push(root)
  const fixture = createProductFixture(root)
  const destination = join(root, "seat")
  const projected = await GitSuper.projectPrivateGitWorktree({
    sourceCheckout: fixture.product,
    commit: fixture.productBase,
    branch: "task/seat",
    destination,
    excludedSubmodules: [],
  })
  expect(projected.state, JSON.stringify(projected.detail)).toBe("updated")
  if (projected.projection === undefined) throw new Error("projection omitted its durable record")
  const marker = join(root, "helper-executed")
  const helper = join(root, "fsmonitor.ts")
  writeFileSync(
    helper,
    `import { writeFileSync } from "node:fs"; writeFileSync(process.argv[2], "executed"); process.stdout.write("token\\0");`,
  )
  const command = [process.execPath, helper, marker].map(shellQuote).join(" ")
  const included = join(root, "included.config")
  git(root, "config", "--file", included, "core.fsmonitor", command)
  for (const repository of projected.projection.repositories) {
    const configuration = join(repository.gitDirectory, "config")
    const original = readFileSync(configuration)
    for (const mode of ["direct", "include", "symlink"] as const) {
      if (mode === "direct") git(repository.checkout, "config", "core.fsmonitor", command)
      else if (mode === "include") git(repository.checkout, "config", "include.path", included)
      else {
        unlinkSync(configuration)
        symlinkSync(included, configuration)
      }
      // Positive control: native Git really follows this configuration and launches the helper.
      git(repository.checkout, "status", "--porcelain")
      expect(existsSync(marker), `${repository.path}: ${mode} native positive control`).toBe(true)
      unlinkSync(marker)
      const retained = await GitSuper.retainPrivateGitProjection(projected.projection, join(root, "retained"))
      expect(existsSync(marker), `${repository.path}: host custody executed ${mode} helper configuration`).toBe(false)
      expect(retained.state).toBe("failed")
      expect(retained.detail?.message).toContain("config")
      expect(existsSync(destination)).toBe(true)
      if (mode === "symlink") unlinkSync(configuration)
      writeFileSync(configuration, original)
    }
  }
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

  // Retirement must preserve originals when native state or a live kernel lease makes proof unsafe.
  const retentionRoot = join(root, "retained")
  const stopCertificate = certificateFor(projection)
  const dirtyPath = join(destination, "uncommitted.ts")
  writeFileSync(dirtyPath, "uncommitted work\n")
  const dirty = await GitSuper.retirePrivateGitProjection(projection, retentionRoot, stopCertificate)
  expect(dirty.state).toBe("failed")
  expect(dirty.detail?.message).toContain("dirty")
  expect(existsSync(destination)).toBe(true)
  unlinkSync(dirtyPath)
  const leafRecord = projection.repositories.find((repository) => repository.checkout === leaf)
  if (leafRecord === undefined) throw new Error("projection omitted its native leaf repository")
  const indexLock = join(leafRecord.gitDirectory, "index.lock")
  writeFileSync(indexLock, "native writer\n")
  const locked = await GitSuper.retirePrivateGitProjection(projection, retentionRoot, stopCertificate)
  expect(locked.state).toBe("failed")
  expect(locked.detail?.message).toContain(indexLock)
  expect(existsSync(destination)).toBe(true)
  unlinkSync(indexLock)
  const held = await createExclusive(join(destination, ".git", "yrd-worktree-mutations")).run(() =>
    GitSuper.retirePrivateGitProjection(projection, retentionRoot, stopCertificate),
  )
  expect(held.state).toBe("failed")
  expect(held.detail?.message).toContain("held")
  expect(existsSync(destination)).toBe(true)
  const preserved = await GitSuper.retainPrivateGitProjection(projection, retentionRoot)
  expect(preserved.state, JSON.stringify(preserved.detail)).toBe("updated")
  expect(preserved.manifest).toBeDefined()
  expect(existsSync(destination)).toBe(true)

  // No creator closure or methods survive this JSON boundary. A different process owns retirement.
  const record = join(root, "projection.json")
  writeFileSync(record, JSON.stringify(projection))
  const certificateRecord = join(root, "stop-certificate.json")
  writeFileSync(certificateRecord, JSON.stringify(stopCertificate))
  const entry = new URL("../src/index.ts", import.meta.url).href
  const retiring = spawnSync(
    process.execPath,
    [
      "-e",
      `import { readFileSync } from "node:fs";
       const { retirePrivateGitProjection } = await import(process.argv[1]);
       const projection = JSON.parse(readFileSync(process.argv[2], "utf8"));
       const certificate = JSON.parse(readFileSync(process.argv[4], "utf8"));
       const result = await retirePrivateGitProjection(projection, process.argv[3], certificate);
       process.stdout.write(JSON.stringify(result));`,
      entry,
      record,
      retentionRoot,
      certificateRecord,
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
