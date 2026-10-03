/**
 * @failure A seat shares host Git authority or loses root/child commits when retirement runs after restart.
 * @level l2
 * @consumer Hab seat sandbox lifecycle using the durable GitSuper projection record
 * @reach fs-walk <fixture-only: isolated native Git product and retention directories>
 * @testonly none
 */
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import * as GitSuper from "../src/index.ts"
import { createExclusive } from "../src/exclusive.ts"
import { cleanGitEnvironment, withGitEnvironment } from "../src/git.ts"
import { createLocalGitProcess } from "../src/process.ts"
import { createGit, createGitWorktreeStore } from "../src/worktree.ts"
import { acquireRemovalWriterLeases, retainWorktreeModules } from "../src/worktree-removal.ts"
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

// CTO63d0a344: copied metadata outside the host baseline must refuse before native Git.
// Existing direct/include/symlink cases cover known configurations, not undeclared stores or hooks.
it.each(["unknown-store", "unknown-hook"] as const)(
  "refuses copied %s metadata before executing native helpers",
  async (kind) => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-unknown-metadata-"))
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
    const marker = join(root, "helper-executed")
    const script = `#!${process.execPath}\nimport { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed"); process.stdout.write("token\\0");\n`
    if (kind === "unknown-store") {
      const checkout = join(root, "unknown-checkout")
      const store = join(destination, ".git/modules/unknown")
      git(root, "init", "--template=", "--separate-git-dir", store, checkout)
      const helper = join(root, "unknown-helper.ts")
      writeFileSync(helper, script)
      git(checkout, "config", "core.fsmonitor", [process.execPath, helper].map(shellQuote).join(" "))
      git(checkout, "status", "--porcelain")
    } else {
      const hooks = join(destination, ".git/hooks")
      mkdirSync(hooks)
      const hook = join(hooks, "post-checkout")
      writeFileSync(hook, script)
      chmodSync(hook, 0o700)
      git(destination, "checkout", "task/seat")
    }
    expect(existsSync(marker), `${kind}: native helper positive control`).toBe(true)
    unlinkSync(marker)
    const retained = await GitSuper.retainPrivateGitProjection(projected.projection, join(root, "retained"))
    expect(retained.state, JSON.stringify(retained)).toBe("failed")
    expect(retained.detail?.message).toContain(kind === "unknown-store" ? "config" : "metadata")
    expect(existsSync(marker), `${kind}: host custody executed an undeclared helper`).toBe(false)
    expect(existsSync(destination)).toBe(true)
    expect(retained.retainedPaths.length).toBeGreaterThan(0)
  },
)

// CTO343fc3e2/0a13f6da: host-selected linked environments borrow declared public stores transitively.
// Existing primary-source fixtures have no public alternates and therefore miss real Yrd source closure.
it.each([
  [false, false, false],
  [true, false, false],
  [false, true, false],
  [false, false, true],
])(
  "projects a public linked source with its declared child object-store lenders; nested=%s; authored=%s; remove donor=%s",
  async (nested, authored, removeDonor) => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-linked-source-closure-"))
    roots.push(root)
    const fixture = nested ? addNestedAlphaSubmodule(createProductFixture(root)) : createProductFixture(root)
    const excludedSubmodules = removeDonor ? [] : ["vendor/beta"]
    if (!removeDonor) {
      git(fixture.product, "config", "-f", ".gitmodules", "submodule.vendor/beta.private", "true")
      git(fixture.product, "add", ".gitmodules")
      git(fixture.product, "commit", "-q", "-m", "declare excluded source child")
    }
    let base = git(fixture.product, "rev-parse", "HEAD")
    const source = join(root, "source")
    const transport = createLocalGitProcess()
    const store = createGitWorktreeStore({ repo: fixture.product, gitProcess: transport })
    await store.add({ kind: "detached", path: source, ref: base })
    await store.materializeSubmodules(source, { excludedSubmodules })
    const alpha = join(source, "packages/alpha")
    const sourceGit = git(alpha, "rev-parse", "--path-format=absolute", "--git-common-dir")
    const durableObjects = join(fixture.product, ".git/modules/packages/alpha/objects")
    expect(readFileSync(join(sourceGit, "objects/info/alternates"), "utf8")).toContain(durableObjects)
    expect(git(alpha, "rev-parse", "HEAD")).toBe(git(join(fixture.product, "packages/alpha"), "rev-parse", "HEAD"))
    // Real Yrd sources can hold a new child commit absent from their public lender.
    // The old table selected only lender-owned commits, so pinning HEAD everywhere looked valid.
    const selected = authored ? advanceRepository(alpha, "authored.txt", "local public work\n") : fixture.alphaBase
    if (authored) {
      expect(() => git(join(fixture.product, "packages/alpha"), "cat-file", "-e", selected)).toThrow()
      git(source, "add", "packages/alpha")
      git(source, "commit", "-q", "-m", "select authored child")
      base = git(source, "rev-parse", "HEAD")
    }
    const projected = await GitSuper.projectPrivateGitWorktree({
      sourceCheckout: source,
      commit: base,
      branch: "task/seat",
      destination: join(root, "seat"),
      excludedSubmodules,
    })
    expect(projected.state, JSON.stringify(projected.detail)).toBe("updated")
    expect(projected.projection?.mounts).toContainEqual({
      source: durableObjects,
      target: durableObjects,
      mode: "ro",
    })
    const privateObjects = join(fixture.product, ".git/modules/vendor/beta/objects")
    expect(projected.projection?.mounts.some((mount) => mount.source === privateObjects)).toBe(removeDonor)
    expect(existsSync(join(source, "vendor/beta/.git"))).toBe(removeDonor)
    if (authored) {
      const lender = join(fixture.product, "packages/alpha")
      const unrelated = git(lender, "commit-tree", "HEAD^{tree}", "-m", "unrelated lender tip")
      git(lender, "update-ref", "--no-deref", "HEAD", unrelated)
      for (const ref of git(lender, "for-each-ref", "--format=%(refname)").split("\n")) {
        if (ref !== "" && !ref.startsWith("refs/git-super/pins/")) git(lender, "update-ref", "-d", ref)
      }
      git(lender, "reflog", "expire", "--expire=now", "--all")
      git(lender, "gc", "--prune=now")
      const child = join(root, "seat/packages/alpha")
      expect(git(child, "rev-parse", "HEAD")).toBe(selected)
      expect(readFileSync(join(child, "authored.txt"), "utf8")).toBe("local public work\n")
      git(child, "fsck", "--full", "--no-reflogs")
    }
    if (nested) {
      const leafObjects = join(fixture.product, ".git/modules/packages/alpha/modules/apps/maddoc/objects")
      expect(projected.projection?.mounts).toContainEqual({ source: leafObjects, target: leafObjects, mode: "ro" })
    }
    if (removeDonor) {
      // A retained private root has a free writer lease, not an active Git lock.
      // Existing retention journeys never remove its linked-source donor afterwards.
      if (projected.projection === undefined) throw new Error("projection omitted its custody record")
      const retained = await GitSuper.retainPrivateGitProjection(projected.projection, join(root, "retained-seat"))
      expect(retained.state, JSON.stringify(retained.detail)).toBe("updated")
      if (retained.manifest === undefined) throw new Error("retention omitted its dependency manifest")
      const proof = JSON.parse(readFileSync(retained.manifest, "utf8")) as {
        retained: string
        externalObjectStores: readonly { target: string }[]
      }
      const donorGit = git(source, "rev-parse", "--absolute-git-dir")
      for (const dependency of proof.externalObjectStores) {
        expect(dependency.target === donorGit || dependency.target.startsWith(`${donorGit}/`)).toBe(false)
      }
      expect(statSync(join(proof.retained, "yrd-worktree-mutations/writer.lock")).size).toBe(0)
      await store.remove(source, {
        retention: {
          root: join(root, "retained-donor"),
          report: (removed) => expect(existsSync(removed.manifest)).toBe(true),
        },
        excludedSubmodules,
      })
      expect(existsSync(source)).toBe(false)
      expect(existsSync(proof.retained)).toBe(true)
      git(fixture.product, "--git-dir", proof.retained, "cat-file", "-e", `${base}^{commit}`)
      return
    }
    const alternates = join(sourceGit, "objects/info/alternates")
    const original = readFileSync(alternates, "utf8")
    for (const unapproved of [privateObjects, join(root, "missing-public-lender")]) {
      writeFileSync(alternates, `${original}${unapproved}\n`)
      const rejected = await GitSuper.projectPrivateGitWorktree({
        sourceCheckout: source,
        commit: base,
        branch: "task/rejected-seat",
        destination: join(root, unapproved === privateObjects ? "rejected-private" : "rejected-missing"),
        excludedSubmodules: ["vendor/beta"],
      })
      expect(rejected.state, JSON.stringify(rejected)).toBe("failed")
      expect(rejected.detail?.message).toContain(unapproved)
      writeFileSync(alternates, original)
      // Each failed attempt preserves its partial tree at its own destination.
      if (unapproved === privateObjects) {
        const rootRecord = rejected.retainedPaths[0]
        if (rootRecord === undefined) throw new Error("failed projection omitted partial root")
        expect(existsSync(rootRecord)).toBe(true)
      }
    }
  },
)

// CTO63d0a344 step 5: publication must not separate the final equality check from removal.
// The helper-config race mutates at lease acquisition, before snapshot; this writes after proof publication.
// CTO0a13f6da and projection Pro: borrowed-object registration alone cannot prove GC lifetime.
// Prior native fsck tests ran while the lender's ordinary refs still held every selected object.
it("keeps borrowed public child commits readable after the lender collects unrelated objects", async () => {
  const root = await mkdtemp(join(canonicalTmpdir(), "git-super-public-lender-gc-"))
  roots.push(root)
  const fixture = createProductFixture(root)
  const source = join(root, "source")
  const store = createGitWorktreeStore({ repo: fixture.product, gitProcess: createLocalGitProcess() })
  await store.add({ kind: "detached", path: source, ref: fixture.productBase })
  await store.materializeSubmodules(source)
  const destination = join(root, "seat")
  const projected = await GitSuper.projectPrivateGitWorktree({
    sourceCheckout: source,
    commit: fixture.productBase,
    branch: "task/seat",
    destination,
    excludedSubmodules: [],
  })
  expect(projected.state, JSON.stringify(projected.detail)).toBe("updated")
  const lender = join(fixture.product, "packages/alpha")
  const unrelated = git(lender, "commit-tree", "HEAD^{tree}", "-m", "unrelated lender tip")
  const collectible = git(lender, "commit-tree", "HEAD^{tree}", "-m", "unreferenced positive GC control")
  git(lender, "update-ref", "--no-deref", "HEAD", unrelated)
  for (const ref of git(lender, "for-each-ref", "--format=%(refname)").split("\n")) {
    if (ref !== "" && !ref.startsWith("refs/git-super/pins/")) git(lender, "update-ref", "-d", ref)
  }
  git(lender, "reflog", "expire", "--expire=now", "--all")
  git(lender, "gc", "--prune=now")
  expect(() => git(lender, "cat-file", "-e", collectible), "GC must actually prune the unreferenced control").toThrow()
  expect(
    () => git(join(destination, "packages/alpha"), "cat-file", "-e", `${fixture.alphaBase}^{commit}`),
    "private child lost a selected commit when its public lender ran GC",
  ).not.toThrow()
  git(join(destination, "packages/alpha"), "fsck", "--full", "--no-reflogs")
})

it("keeps the original when another process writes after custody proof publication", async () => {
  const root = await mkdtemp(join(canonicalTmpdir(), "git-super-final-custody-write-"))
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
  const environment = {
    ...cleanGitEnvironment(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
  }
  const transport = createLocalGitProcess(environment)
  const driver = createGit(transport, environment, 30_000)
  const leases = acquireRemovalWriterLeases(join(destination, ".git"))
  const authored = join(destination, "after-publication.ts")
  let manifestPath: string | undefined
  try {
    await expect(
      withGitEnvironment(environment, () =>
        retainWorktreeModules(
          driver,
          destination,
          destination,
          {
            root: join(root, "retained"),
            report: (proof) => {
              manifestPath = proof.manifest
              const writer = spawnSync(
                process.execPath,
                [
                  "-e",
                  'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[1], "authored after publication\\n");',
                  authored,
                ],
                { encoding: "utf8" },
              )
              expect(writer.status, writer.stderr).toBe(0)
            },
          },
          (repository, path) =>
            createGitWorktreeStore({ repo: repository, gitProcess: transport, env: environment }).inspect(path),
          leases.proof,
          leases.created,
          undefined,
          [],
          [],
          projection,
          undefined,
          () => rmSync(destination, { recursive: true }),
        ),
      ),
    ).rejects.toThrow("changed during retention")
    expect(manifestPath).toBeDefined()
    if (manifestPath === undefined) throw new Error("custody did not reach proof publication")
    expect(existsSync(manifestPath)).toBe(true)
    expect(readFileSync(authored, "utf8")).toBe("authored after publication\n")
    expect(existsSync(destination)).toBe(true)
  } finally {
    leases.release()
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
