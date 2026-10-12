/**
 * @failure Compaction of a retained child drops a ref value, rewrites the proof after a failed pack, or deletes the copy, so later retention verify either certifies damage or never shrinks the inode pile.
 * @level l1
 * @consumer Yrd environment close through git-super worktree remove --retain; #27443 C1
 * @reach fs-walk <fixture-only: mkdtempSync Git repos under canonicalTmpdir()>
 * @testonly none
 */
import { createHash } from "node:crypto"
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { spawnSync } from "node:child_process"
import { join, sep } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  compactRetainedModules,
  compactRetainedRoot,
  findRetainedGitDirs,
  type CompactionOptions,
} from "../src/retention-compact.ts"
import { createLocalGitWorktreeStore } from "../src/worktree.ts"
import { verifyRetainedEntry } from "../src/retention-verify.ts"
import { manifest, type WorktreeRemovalProof } from "../src/worktree-removal.ts"
import { canonicalTmpdir, createRepository, git as gitCwd } from "./fixture.ts"
import { runCli } from "../src/cli.ts"

const environment: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Git Super Test",
  GIT_AUTHOR_EMAIL: "git-super@example.test",
  GIT_COMMITTER_NAME: "Git Super Test",
  GIT_COMMITTER_EMAIL: "git-super@example.test",
  GIT_TERMINAL_PROMPT: "0",
}

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function gitAt(gitDir: string, args: readonly string[]): string {
  const result = spawnSync("git", ["--git-dir", gitDir, ...args], { encoding: "utf8", env: environment })
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed in ${gitDir}`)
  }
  return result.stdout.trim()
}

function addLooseRemotes(gitDir: string, count: number): void {
  gitAt(gitDir, ["config", "core.logAllRefUpdates", "true"])
  const head = gitAt(gitDir, ["rev-parse", "HEAD"])
  for (let i = 1; i <= count; i += 1) {
    gitAt(gitDir, ["update-ref", `refs/remotes/origin/topic-${String(i)}`, head])
  }
}

function digest(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/** A whole tree's bytes, so a skip can be proven to have changed NOTHING about the child. */
function treeDigest(root: string): string {
  const rows: string[] = []
  const visit = (path: string, relative: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const child = join(path, entry.name)
      const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) visit(child, childRelative)
      else rows.push(`${childRelative} ${createHash("sha256").update(readFileSync(child)).digest("hex")}`)
    }
  }
  visit(root, "")
  return digest(rows.join("\n"))
}

function inRun(common: string = sep): CompactionOptions {
  return { common, preState: { kind: "in-run" } }
}

function outputSink(): { output: string; write(value: string): void } {
  return {
    output: "",
    write(value) {
      this.output += value
    },
  }
}

function writeProof(
  entry: string,
  modulesCopy: string,
  files: Readonly<Record<string, string>>,
  entries: unknown,
): WorktreeRemovalProof {
  const proof: WorktreeRemovalProof = {
    path: join(entry, "checkout"),
    head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    repositories: [],
    modules: join(entry, "original-modules"),
    retained: modulesCopy,
    manifest: join(entry, "manifest.json"),
    createdAt: "2026-10-11T00:00:00.000Z",
    retainUntil: "2020-01-01T00:00:00.000Z",
    writerLocks: [],
    createdWriterLocks: [],
    notCompared: [],
  }
  writeFileSync(
    proof.manifest,
    `${JSON.stringify({ ...proof, files, entries, externalObjectStores: [] }, null, 2)}\n`,
    { flag: "wx" },
  )
  return proof
}

function buildSyntheticEntry(remoteCount = 12): {
  root: string
  entry: string
  gitDir: string
  nested: string
  proof: WorktreeRemovalProof
} {
  const root = mkdtempSync(join(canonicalTmpdir(), "git-super-retention-compact-"))
  roots.push(root)
  const donor = join(root, "donor")
  const nestedDonor = join(root, "nested-donor")
  createRepository(donor, "file.ts", "export const n = 1\n")
  createRepository(nestedDonor, "nested.ts", "export const nested = 1\n")
  const entry = join(root, "retained", "child")
  const modulesCopy = join(entry, "modules")
  const gitDir = join(modulesCopy, "dep")
  const nested = join(gitDir, "modules", "nested")
  mkdirSync(gitDir, { recursive: true })
  cpSync(join(donor, ".git"), gitDir, { recursive: true })
  mkdirSync(nested, { recursive: true })
  cpSync(join(nestedDonor, ".git"), nested, { recursive: true })
  addLooseRemotes(gitDir, remoteCount)
  addLooseRemotes(nested, remoteCount)
  const recorded = manifest(modulesCopy, {
    common: sep,
    checkout: join(entry, "checkout"),
    gitDir: join(entry, "original-modules", ".."),
    modules: modulesCopy,
  })
  const proof = writeProof(entry, modulesCopy, recorded.files, recorded.entries)
  return { root, entry, gitDir, nested, proof }
}

describe("compactRetainedModules", () => {
  it("packs every ref value, drops remote-tracking reflogs, and keeps HEAD plus local reflogs byte-identical", () => {
    const { gitDir, nested, proof } = buildSyntheticEntry()
    const before = {
      refs: gitAt(gitDir, ["for-each-ref", "--format=%(refname) %(objectname)"]),
      nestedRefs: gitAt(nested, ["for-each-ref", "--format=%(refname) %(objectname)"]),
      head: readFileSync(join(gitDir, "HEAD")),
      headValue: gitAt(gitDir, ["rev-parse", "HEAD"]),
      mainLog: readFileSync(join(gitDir, "logs/refs/heads/main")),
      headLog: readFileSync(join(gitDir, "logs/HEAD")),
    }
    expect(existsSync(join(gitDir, "refs/remotes/origin/topic-1"))).toBe(true)
    expect(existsSync(join(gitDir, "logs/refs/remotes/origin/topic-1"))).toBe(true)
    expect(existsSync(join(nested, "refs/remotes/origin/topic-1"))).toBe(true)

    expect(compactRetainedModules(proof, inRun())).toEqual({ status: "ok" })

    expect(gitAt(gitDir, ["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(before.refs)
    expect(gitAt(nested, ["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(before.nestedRefs)
    expect(readFileSync(join(gitDir, "HEAD"))).toEqual(before.head)
    expect(gitAt(gitDir, ["rev-parse", "HEAD"])).toBe(before.headValue)
    expect(readFileSync(join(gitDir, "logs/refs/heads/main"))).toEqual(before.mainLog)
    expect(readFileSync(join(gitDir, "logs/HEAD"))).toEqual(before.headLog)
    expect(readFileSync(join(gitDir, "packed-refs"), "utf8")).toContain("refs/remotes/origin/topic-1")
    expect(readFileSync(join(nested, "packed-refs"), "utf8")).toContain("refs/remotes/origin/topic-1")
    expect(existsSync(join(gitDir, "refs/remotes/origin/topic-1"))).toBe(false)
    expect(existsSync(join(gitDir, "logs/refs/remotes"))).toBe(false)
    expect(existsSync(join(nested, "logs/refs/remotes"))).toBe(false)
    expect(existsSync(join(gitDir, "logs/refs/heads/main"))).toBe(true)
  })

  it("keeps the at-close proof and rewrites files/entries atomically with a compaction record", () => {
    const { entry, proof } = buildSyntheticEntry()
    const beforeBytes = readFileSync(proof.manifest, "utf8")
    const before = JSON.parse(beforeBytes) as {
      createdAt: string
      retainUntil: string
      files: Record<string, string>
    }
    expect(compactRetainedModules(proof, inRun())).toEqual({ status: "ok" })
    const afterBytes = readFileSync(proof.manifest, "utf8")
    const after = JSON.parse(afterBytes) as {
      createdAt: string
      retainUntil: string
      files: Record<string, string>
      entries: Record<string, unknown>
      compaction: {
        packedRefs: boolean
        dropped: string
        refValuesEqual: boolean
        filesBefore: number
        filesAfter: number
        previousManifestDigest: string
      }
    }
    expect(after.createdAt).toBe(before.createdAt)
    expect(after.retainUntil).toBe(before.retainUntil)
    expect(after.compaction).toMatchObject({
      packedRefs: true,
      dropped: "logs/refs/remotes/",
      refValuesEqual: true,
      previousManifestDigest: digest(beforeBytes),
    })
    expect(after.compaction.filesAfter).toBeLessThan(after.compaction.filesBefore)
    expect(after.compaction.filesBefore).toBe(Object.keys(before.files).length)
    const actual = manifest(proof.retained as string, {
      common: sep,
      checkout: proof.path,
      gitDir: join(entry, "original-modules", ".."),
      modules: proof.retained as string,
    })
    expect(actual.files).toEqual(after.files)
    expect(actual.entries).toEqual(after.entries)
  })

  it("does not rewrite the proof or delete the copy when pack-refs fails", () => {
    const { gitDir, proof } = buildSyntheticEntry()
    mkdirSync(join(gitDir, "packed-refs.lock"))
    const before = readFileSync(proof.manifest)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      expect(compactRetainedModules(proof, inRun())).toEqual({
        status: "failed",
        child: gitDir,
        step: "pack-refs",
      })
      expect(readFileSync(proof.manifest)).toEqual(before)
      expect(existsSync(proof.retained as string)).toBe(true)
      expect(existsSync(join(gitDir, "HEAD"))).toBe(true)
      expect(
        warn.mock.calls.some((call) => String(call[0]).includes(gitDir) && String(call[0]).includes("pack-refs")),
      ).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  it("refuses rewrite when an objects-link sits outside the real common dir", () => {
    const { proof, gitDir, entry, root } = buildSyntheticEntry()
    const objects = join(gitDir, "objects")
    const outside = join(root, "outside-objects")
    rmSync(objects, { recursive: true, force: true })
    mkdirSync(outside, { recursive: true })
    symlinkSync(outside, objects)
    const recorded = manifest(proof.retained as string, {
      common: sep,
      checkout: proof.path,
      gitDir: join(entry, "original-modules", ".."),
      modules: proof.retained as string,
    })
    const stored = JSON.parse(readFileSync(proof.manifest, "utf8")) as Record<string, unknown>
    writeFileSync(
      proof.manifest,
      `${JSON.stringify({ ...stored, files: recorded.files, entries: recorded.entries }, null, 2)}\n`,
    )
    const before = readFileSync(proof.manifest)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const result = compactRetainedModules(proof, inRun(join(entry, "not-the-common")))
      expect(result.status).toBe("failed")
      if (result.status !== "failed") throw new Error("expected failed compaction")
      expect(result.step).toBe("rewrite-proof")
      expect(readFileSync(proof.manifest)).toEqual(before)
      expect(existsSync(proof.retained as string)).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  it("gate-2 refuses a damaged child before packing and does not rewrite the proof", () => {
    const { gitDir, proof } = buildSyntheticEntry()
    writeFileSync(join(gitDir, "config"), `${readFileSync(join(gitDir, "config"), "utf8")}\n# damaged\n`)
    const before = readFileSync(proof.manifest)
    const packedBefore = existsSync(join(gitDir, "packed-refs"))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      expect(compactRetainedModules(proof, { common: sep, preState: { kind: "gate-2" } })).toEqual({
        status: "failed",
        child: proof.retained,
        step: "gate-2",
      })
      expect(readFileSync(proof.manifest)).toEqual(before)
      expect(existsSync(join(gitDir, "refs/remotes/origin/topic-1"))).toBe(true)
      expect(existsSync(join(gitDir, "packed-refs"))).toBe(packedBefore)
    } finally {
      warn.mockRestore()
    }
  })

  it("keeps remove() resolved when pack-refs fails after native --force", async () => {
    const root = mkdtempSync(join(canonicalTmpdir(), "git-super-retention-compact-remove-fail-"))
    roots.push(root)
    const dependency = join(root, "dependency")
    const product = join(root, "product")
    mkdirSync(dependency, { recursive: true })
    gitCwd(dependency, "init", "-q", "-b", "main")
    writeFileSync(join(dependency, "dep.ts"), "export const dep = 1\n")
    gitCwd(dependency, "add", "dep.ts")
    gitCwd(dependency, "commit", "-q", "-m", "dep")
    mkdirSync(product, { recursive: true })
    gitCwd(product, "init", "-q", "-b", "main")
    gitCwd(product, "-c", "protocol.file.allow=always", "submodule", "add", "-q", dependency, "vendor/dep")
    gitCwd(product, "commit", "-q", "-m", "add vendor/dep")
    const worktree = join(root, "candidate")
    const retainedRoot = join(root, "retained")
    expect(await runCli(["--repo", product, "worktree", "add", worktree, "HEAD"], outputSink(), outputSink())).toBe(0)
    const moduleGitDir = gitCwd(join(worktree, "vendor/dep"), "rev-parse", "--absolute-git-dir")
    addLooseRemotes(moduleGitDir, 8)
    let captured: WorktreeRemovalProof | undefined
    const store = createLocalGitWorktreeStore({ repo: product })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const outcome = await store.remove(worktree, {
        retention: {
          root: retainedRoot,
          report: (proof) => {
            captured = proof
            if (proof.retained === null) return
            for (const gitDir of findRetainedGitDirs(proof.retained)) {
              mkdirSync(join(gitDir, "packed-refs.lock"))
            }
          },
        },
      })
      expect(existsSync(worktree)).toBe(false)
      expect(outcome).toMatchObject({ compaction: { status: "failed", step: "pack-refs" } })
      expect(captured?.retained).toEqual(expect.any(String))
      const recordedManifest = JSON.parse(readFileSync(captured!.manifest, "utf8")) as { compaction?: unknown }
      expect(recordedManifest.compaction).toBeUndefined()
      expect(existsSync(captured!.retained as string)).toBe(true)
    } finally {
      warn.mockRestore()
    }
  }, 120_000)

  it("keeps remove() resolved when retained-directory discovery fails after native --force", async () => {
    const root = mkdtempSync(join(canonicalTmpdir(), "git-super-retention-compact-discover-fail-"))
    roots.push(root)
    const dependency = join(root, "dependency")
    const product = join(root, "product")
    mkdirSync(dependency, { recursive: true })
    gitCwd(dependency, "init", "-q", "-b", "main")
    writeFileSync(join(dependency, "dep.ts"), "export const dep = 1\n")
    gitCwd(dependency, "add", "dep.ts")
    gitCwd(dependency, "commit", "-q", "-m", "dep")
    mkdirSync(product, { recursive: true })
    gitCwd(product, "init", "-q", "-b", "main")
    gitCwd(product, "-c", "protocol.file.allow=always", "submodule", "add", "-q", dependency, "vendor/dep")
    gitCwd(product, "commit", "-q", "-m", "add vendor/dep")
    const worktree = join(root, "candidate")
    const retainedRoot = join(root, "retained")
    expect(await runCli(["--repo", product, "worktree", "add", worktree, "HEAD"], outputSink(), outputSink())).toBe(0)
    const moduleGitDir = gitCwd(join(worktree, "vendor/dep"), "rev-parse", "--absolute-git-dir")
    addLooseRemotes(moduleGitDir, 8)
    let captured: WorktreeRemovalProof | undefined
    let locked: string | undefined
    const store = createLocalGitWorktreeStore({ repo: product })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const outcome = await store.remove(worktree, {
        retention: {
          root: retainedRoot,
          report: (proof) => {
            captured = proof
            if (proof.retained === null) return
            locked = proof.retained
            chmodSync(proof.retained, 0o000)
          },
        },
      })
      expect(existsSync(worktree)).toBe(false)
      expect(outcome).toMatchObject({ compaction: { status: "failed", child: locked, step: "discovery" } })
      expect(captured?.retained).toEqual(locked)
      const recordedManifest = JSON.parse(readFileSync(captured!.manifest, "utf8")) as { compaction?: unknown }
      expect(recordedManifest.compaction).toBeUndefined()
      expect(existsSync(captured!.retained as string)).toBe(true)
    } finally {
      if (locked !== undefined) chmodSync(locked, 0o755)
      warn.mockRestore()
    }
  }, 120_000)

  it("passes every retention-verify gate on a compacted real-writer child", async () => {
    const root = mkdtempSync(join(canonicalTmpdir(), "git-super-retention-compact-live-"))
    roots.push(root)
    const dependency = join(root, "dependency")
    const product = join(root, "product")
    mkdirSync(dependency, { recursive: true })
    gitCwd(dependency, "init", "-q", "-b", "main")
    writeFileSync(join(dependency, "dep.ts"), "export const dep = 1\n")
    gitCwd(dependency, "add", "dep.ts")
    gitCwd(dependency, "commit", "-q", "-m", "dep")
    mkdirSync(product, { recursive: true })
    gitCwd(product, "init", "-q", "-b", "main")
    gitCwd(product, "-c", "protocol.file.allow=always", "submodule", "add", "-q", dependency, "vendor/dep")
    gitCwd(product, "commit", "-q", "-m", "add vendor/dep")
    const worktree = join(root, "candidate")
    const retainedRoot = join(root, "retained")
    expect(await runCli(["--repo", product, "worktree", "add", worktree, "HEAD"], outputSink(), outputSink())).toBe(0)
    const moduleGitDir = gitCwd(join(worktree, "vendor/dep"), "rev-parse", "--absolute-git-dir")
    addLooseRemotes(moduleGitDir, 8)
    expect(
      await runCli(
        ["--repo", product, "--json", "worktree", "remove", worktree, "--retain", retainedRoot],
        outputSink(),
        outputSink(),
      ),
    ).toBe(0)
    const entries = readdirSync(retainedRoot)
    expect(entries).toHaveLength(1)
    const entry = join(retainedRoot, entries[0] as string)
    const recorded = JSON.parse(readFileSync(join(entry, "manifest.json"), "utf8")) as {
      retainUntil: string
      compaction?: { packedRefs: boolean; refValuesEqual: boolean }
    }
    expect(recorded.compaction).toMatchObject({ packedRefs: true, refValuesEqual: true })
    const result = await verifyRetainedEntry({
      entry,
      root: retainedRoot,
      namespaceRoots: [root],
      artifactDir: join(root, "pass"),
      allowTemporaryArtifactDir: true,
      clock: new Date(Date.parse(recorded.retainUntil) + 1000),
    })
    expect(result.gates.map((gate) => gate.status)).toEqual(["pass", "pass", "pass", "pass", "pass", "pass"])
    expect(result.verdict).toBe("candidate")
  }, 120_000)
})

/**
 * @failure C3 compaction over a declared root replays a stored proof's stale paths, compacts an
 * unverified or foreign manifest, keeps going after a refusal, or deletes an entry.
 * @level l1
 * @consumer #27443 C3 existing-stock compaction through git-super worktree retention compact
 * @reach fs-walk <fixture-only: mkdtempSync Git repos under canonicalTmpdir()>
 * @testonly none
 */
function buildRetainedEntry(retainedRoot: string, name: string, remoteCount = 8): { entry: string; gitDir: string } {
  const donor = mkdtempSync(join(canonicalTmpdir(), "git-super-c3-donor-"))
  roots.push(donor)
  createRepository(donor, "file.ts", "export const n = 1\n")
  const entry = join(retainedRoot, name)
  const modulesCopy = join(entry, "modules")
  const gitDir = join(modulesCopy, "dep")
  mkdirSync(gitDir, { recursive: true })
  cpSync(join(donor, ".git"), gitDir, { recursive: true })
  addLooseRemotes(gitDir, remoteCount)
  const recorded = manifest(modulesCopy, {
    common: sep,
    checkout: join(entry, "checkout"),
    gitDir: join(entry, "original-modules", ".."),
    modules: modulesCopy,
  })
  writeFileSync(
    join(entry, "manifest.json"),
    `${JSON.stringify(
      {
        path: join(entry, "checkout"),
        modules: join(entry, "original-modules"),
        retained: modulesCopy,
        manifest: join(entry, "manifest.json"),
        files: recorded.files,
        entries: recorded.entries,
        externalObjectStores: [],
      },
      null,
      2,
    )}\n`,
    { flag: "wx" },
  )
  return { entry, gitDir }
}

function storedProof(entry: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(entry, "manifest.json"), "utf8")) as Record<string, unknown>
}

function writeStoredProof(entry: string, proof: Record<string, unknown>): void {
  writeFileSync(join(entry, "manifest.json"), `${JSON.stringify(proof, null, 2)}\n`)
}

describe("compactRetainedRoot (C3 existing stock)", () => {
  it("compacts every eligible child, drops remote-tracking reflogs, and records the compaction", () => {
    const scratch = mkdtempSync(join(canonicalTmpdir(), "git-super-c3-"))
    roots.push(scratch)
    const retainedRoot = join(scratch, "retained-modules")
    mkdirSync(retainedRoot, { recursive: true })
    const a = buildRetainedEntry(retainedRoot, "a-entry")
    const b = buildRetainedEntry(retainedRoot, "b-entry")
    expect(existsSync(join(a.gitDir, "logs/refs/remotes/origin/topic-1"))).toBe(true)

    const report = compactRetainedRoot(retainedRoot)

    expect(report.children).toBe(2)
    expect(report.counts.eligible).toBe(2)
    expect(report.processed).toEqual([a.entry, b.entry])
    expect(report.failed).toBeNull()
    for (const { gitDir } of [a, b]) {
      expect(existsSync(join(gitDir, "logs/refs/remotes"))).toBe(false)
      expect(existsSync(join(gitDir, "logs/refs/heads/main"))).toBe(true)
      expect(readFileSync(join(gitDir, "packed-refs"), "utf8")).toContain("refs/remotes/origin/topic-1")
    }
    expect(storedProof(a.entry).compaction).toMatchObject({
      packedRefs: true,
      dropped: "logs/refs/remotes/",
      refValuesEqual: true,
    })
  })

  it("rebuilds a stale-root proof from the child's own directory instead of replaying its paths", () => {
    const scratch = mkdtempSync(join(canonicalTmpdir(), "git-super-c3-stale-"))
    roots.push(scratch)
    const retainedRoot = join(scratch, "retained-modules")
    mkdirSync(retainedRoot, { recursive: true })
    const { entry, gitDir } = buildRetainedEntry(retainedRoot, "stale-entry")
    writeStoredProof(entry, {
      ...storedProof(entry),
      retained: join(scratch, "hh-dev%23main", "retained-modules", "stale-entry", "modules"),
      manifest: join(scratch, "hh-dev%23main", "retained-modules", "stale-entry", "manifest.json"),
    })

    const report = compactRetainedRoot(retainedRoot)

    expect(report.failed).toBeNull()
    expect(report.processed).toEqual([entry])
    expect(existsSync(join(gitDir, "logs/refs/remotes"))).toBe(false)
    // The rewritten proof names the location that exists now, not the stale root it recorded.
    const after = storedProof(entry)
    expect(after.retained).toBe(join(entry, "modules"))
    expect(after.manifest).toBe(join(entry, "manifest.json"))
  })

  it("leaves a compacted stale-root child passing every retention-verify gate in place", async () => {
    const scratch = mkdtempSync(join(canonicalTmpdir(), "git-super-c3-stale-verify-"))
    roots.push(scratch)
    const dependency = join(scratch, "dependency")
    const product = join(scratch, "product")
    mkdirSync(dependency, { recursive: true })
    gitCwd(dependency, "init", "-q", "-b", "main")
    writeFileSync(join(dependency, "dep.ts"), "export const dep = 1\n")
    gitCwd(dependency, "add", "dep.ts")
    gitCwd(dependency, "commit", "-q", "-m", "dep")
    mkdirSync(product, { recursive: true })
    gitCwd(product, "init", "-q", "-b", "main")
    gitCwd(product, "-c", "protocol.file.allow=always", "submodule", "add", "-q", dependency, "vendor/dep")
    gitCwd(product, "commit", "-q", "-m", "add vendor/dep")
    const worktree = join(scratch, "candidate")
    const retainedRoot = join(scratch, "retained")
    expect(await runCli(["--repo", product, "worktree", "add", worktree, "HEAD"], outputSink(), outputSink())).toBe(0)
    addLooseRemotes(gitCwd(join(worktree, "vendor/dep"), "rev-parse", "--absolute-git-dir"), 8)
    expect(
      await runCli(
        ["--repo", product, "--json", "worktree", "remove", worktree, "--retain", retainedRoot],
        outputSink(),
        outputSink(),
      ),
    ).toBe(0)
    const names = readdirSync(retainedRoot)
    expect(names).toHaveLength(1)
    const entry = join(retainedRoot, names[0] as string)
    // Pre-C1 stock: no compaction record, and the recorded LOCATION names the older workdir root
    // that no longer exists. Everything else is the real writer's own proof.
    const legacy = storedProof(entry)
    delete legacy.compaction
    writeStoredProof(entry, {
      ...legacy,
      retained: join(scratch, "hh-dev%23main", "retained", names[0] as string, "modules"),
      manifest: join(scratch, "hh-dev%23main", "retained", names[0] as string, "manifest.json"),
    })
    const retainUntil = String(legacy.retainUntil)

    const report = compactRetainedRoot(retainedRoot)
    expect(report.failed).toBeNull()
    expect(report.processed).toEqual([entry])

    // The point of C3 is a SMALLER entry that is still verifiable. A proof left naming the dead root
    // is refused at gate 1 by the very command that certifies it, so the location must be rewritten.
    const verified = await verifyRetainedEntry({
      entry,
      root: retainedRoot,
      namespaceRoots: [scratch],
      artifactDir: join(scratch, "pass"),
      allowTemporaryArtifactDir: true,
      clock: new Date(Date.parse(retainUntil) + 1000),
    })
    expect(verified.gates.map((gate) => gate.status)).toEqual(["pass", "pass", "pass", "pass", "pass", "pass"])
    expect(verified.verdict).toBe("candidate")
  }, 120_000)

  it("skips and reports already-compacted, no-entries-map, incomplete-proof and no-manifest children by class", () => {
    const scratch = mkdtempSync(join(canonicalTmpdir(), "git-super-c3-classes-"))
    roots.push(scratch)
    const retainedRoot = join(scratch, "retained-modules")
    mkdirSync(retainedRoot, { recursive: true })
    const eligible = buildRetainedEntry(retainedRoot, "a-eligible")
    const compacted = buildRetainedEntry(retainedRoot, "b-compacted")
    writeStoredProof(compacted.entry, {
      ...storedProof(compacted.entry),
      compaction: { at: "2026-01-01T00:00:00.000Z" },
    })
    const legacy = buildRetainedEntry(retainedRoot, "c-legacy")
    const legacyProof = storedProof(legacy.entry)
    delete legacyProof.entries
    writeStoredProof(legacy.entry, legacyProof)
    mkdirSync(join(retainedRoot, "d-no-manifest"))
    writeFileSync(join(retainedRoot, "d-no-manifest", "note.txt"), "orphan\n")
    mkdirSync(join(retainedRoot, "e-unreadable"))
    writeFileSync(join(retainedRoot, "e-unreadable", "manifest.json"), "{ not json\n")
    const incomplete = buildRetainedEntry(retainedRoot, "f-incomplete")
    const incompleteProof = storedProof(incomplete.entry)
    delete incompleteProof.modules
    writeStoredProof(incomplete.entry, incompleteProof)
    // A skip must be proven inert: the child's proof bytes and its whole copy stay byte-identical.
    const legacyProofBefore = readFileSync(join(legacy.entry, "manifest.json"), "utf8")
    const legacyCopyBefore = treeDigest(legacy.gitDir)
    const incompleteCopyBefore = treeDigest(incomplete.gitDir)

    const report = compactRetainedRoot(retainedRoot)

    expect(report.counts).toEqual({
      eligible: 1,
      "refused-gate-2": 0,
      "already-compacted": 1,
      "no-entries-map": 1,
      "incomplete-proof": 1,
      "no-manifest": 2,
    })
    expect(report.processed).toEqual([eligible.entry])
    const classes = Object.fromEntries(report.entries.map((row) => [row.entry, row.classification]))
    expect(classes[compacted.entry]).toBe("already-compacted")
    expect(classes[legacy.entry]).toBe("no-entries-map")
    expect(classes[incomplete.entry]).toBe("incomplete-proof")
    expect(classes[join(retainedRoot, "d-no-manifest")]).toBe("no-manifest")
    // An unreadable manifest is reported with WHY it failed, never silently treated as absent.
    const unreadable = report.entries.find((row) => row.entry === join(retainedRoot, "e-unreadable"))
    expect(unreadable?.classification).toBe("no-manifest")
    expect(unreadable?.detail).toContain("unreadable JSON")
    // A proof missing a location field names the missing field; the value is never invented (CTO F1).
    const missing = report.entries.find((row) => row.entry === incomplete.entry)
    expect(missing?.detail).toContain("modules")
    expect(existsSync(join(legacy.gitDir, "logs/refs/remotes"))).toBe(true)
    expect(existsSync(join(compacted.gitDir, "logs/refs/remotes"))).toBe(true)
    expect(existsSync(join(legacy.gitDir, "packed-refs"))).toBe(false)
    expect(readFileSync(join(legacy.entry, "manifest.json"), "utf8")).toBe(legacyProofBefore)
    expect(treeDigest(legacy.gitDir)).toBe(legacyCopyBefore)
    expect(treeDigest(incomplete.gitDir)).toBe(incompleteCopyBefore)
    expect(storedProof(compacted.entry).compaction).toEqual({ at: "2026-01-01T00:00:00.000Z" })
  })

  it("counts --limit over eligible children only, in sorted order", () => {
    const scratch = mkdtempSync(join(canonicalTmpdir(), "git-super-c3-limit-"))
    roots.push(scratch)
    const retainedRoot = join(scratch, "retained-modules")
    mkdirSync(retainedRoot, { recursive: true })
    mkdirSync(join(retainedRoot, "a-skip"))
    const first = buildRetainedEntry(retainedRoot, "b-first")
    const second = buildRetainedEntry(retainedRoot, "c-second")

    const report = compactRetainedRoot(retainedRoot, { limit: 1 })

    expect(report.limit).toBe(1)
    expect(report.processed).toEqual([first.entry])
    expect(existsSync(join(first.gitDir, "logs/refs/remotes"))).toBe(false)
    expect(existsSync(join(second.gitDir, "logs/refs/remotes"))).toBe(true)
  })

  it("dry-run verifies each eligible child and writes nothing", () => {
    const scratch = mkdtempSync(join(canonicalTmpdir(), "git-super-c3-dry-"))
    roots.push(scratch)
    const retainedRoot = join(scratch, "retained-modules")
    mkdirSync(retainedRoot, { recursive: true })
    const { entry, gitDir } = buildRetainedEntry(retainedRoot, "a-entry")
    const before = readFileSync(join(entry, "manifest.json"), "utf8")

    const report = compactRetainedRoot(retainedRoot, { dryRun: true })

    expect(report.dryRun).toBe(true)
    expect(report.processed).toEqual([entry])
    expect(report.failed).toBeNull()
    expect(existsSync(join(gitDir, "logs/refs/remotes"))).toBe(true)
    expect(existsSync(join(gitDir, "packed-refs"))).toBe(false)
    expect(readFileSync(join(entry, "manifest.json"), "utf8")).toBe(before)
  })

  it("reports a gate-2 refusal by class and carries on to the next eligible child", () => {
    const scratch = mkdtempSync(join(canonicalTmpdir(), "git-super-c3-damaged-"))
    roots.push(scratch)
    const retainedRoot = join(scratch, "retained-modules")
    mkdirSync(retainedRoot, { recursive: true })
    const damaged = buildRetainedEntry(retainedRoot, "a-damaged")
    const after = buildRetainedEntry(retainedRoot, "b-after")
    writeFileSync(join(damaged.gitDir, "description"), "tampered after the proof was written\n")
    const proofBefore = readFileSync(join(damaged.entry, "manifest.json"), "utf8")
    const copyBefore = treeDigest(damaged.gitDir)

    const report = compactRetainedRoot(retainedRoot)

    // A refusal that happened before any write is a known class: skipped, left byte-identical, and
    // the run keeps going (CTO ruling 2026-10-12). It is never silence: the report names it.
    expect(report.failed).toBeNull()
    expect(report.processed).toEqual([after.entry])
    const refused = report.entries.find((row) => row.entry === damaged.entry)
    expect(refused?.classification).toBe("refused-gate-2")
    expect(refused?.refusedStep).toBe("gate-2")
    expect(report.counts["refused-gate-2"]).toBe(1)
    expect(report.counts.eligible).toBe(1)
    expect(readFileSync(join(damaged.entry, "manifest.json"), "utf8")).toBe(proofBefore)
    expect(treeDigest(damaged.gitDir)).toBe(copyBefore)
    expect(existsSync(join(after.gitDir, "logs/refs/remotes"))).toBe(false)
  })

  it("still stops the run on a failure that began mutating the copy", () => {
    const scratch = mkdtempSync(join(canonicalTmpdir(), "git-super-c3-postmutation-"))
    roots.push(scratch)
    const retainedRoot = join(scratch, "retained-modules")
    mkdirSync(retainedRoot, { recursive: true })
    const first = buildRetainedEntry(retainedRoot, "a-unwritable")
    const after = buildRetainedEntry(retainedRoot, "b-after")
    chmodSync(first.gitDir, 0o500)
    try {
      const report = compactRetainedRoot(retainedRoot)

      // pack-refs cannot write: that is past the point of no return, so it stops the run rather than
      // joining the known refusals.
      expect(report.failed?.entry).toBe(first.entry)
      expect(report.failed?.step).toBe("pack-refs")
      expect(report.processed).toEqual([])
      expect(existsSync(join(after.gitDir, "logs/refs/remotes"))).toBe(true)
    } finally {
      chmodSync(first.gitDir, 0o755)
    }
  }, 120_000)

  it("refuses a manifest whose recorded entry name is not this child", () => {
    const scratch = mkdtempSync(join(canonicalTmpdir(), "git-super-c3-foreign-"))
    roots.push(scratch)
    const retainedRoot = join(scratch, "retained-modules")
    mkdirSync(retainedRoot, { recursive: true })
    const { entry } = buildRetainedEntry(retainedRoot, "a-entry")
    writeStoredProof(entry, {
      ...storedProof(entry),
      retained: join(retainedRoot, "someone-else", "modules"),
    })

    const report = compactRetainedRoot(retainedRoot)

    // Another pre-mutation refusal: the class is the family and refusedStep names which refusal.
    expect(report.failed).toBeNull()
    expect(report.processed).toEqual([])
    const row = report.entries.find((candidate) => candidate.entry === entry)
    expect(row?.classification).toBe("refused-gate-2")
    expect(row?.refusedStep).toBe("foreign-proof")
  })

  it("refuses an absent root loudly instead of reporting an empty success", () => {
    expect(() => compactRetainedRoot(join(canonicalTmpdir(), "git-super-c3-absent-root"))).toThrow(
      /is absent or not a directory/,
    )
  })

  it("compacts over the CLI and reports JSON counts", async () => {
    const scratch = mkdtempSync(join(canonicalTmpdir(), "git-super-c3-cli-"))
    roots.push(scratch)
    const retainedRoot = join(scratch, "retained-modules")
    mkdirSync(retainedRoot, { recursive: true })
    const { gitDir } = buildRetainedEntry(retainedRoot, "a-entry")
    const repo = join(scratch, "repo")
    createRepository(repo, "file.ts", "export const n = 1\n")
    const stdout = outputSink()
    const stderr = outputSink()

    const code = await runCli(
      ["--repo", repo, "--json", "worktree", "retention", "compact", "--root", retainedRoot],
      stdout,
      stderr,
    )

    expect(code, stderr.output).toBe(0)
    const result = JSON.parse(stdout.output) as {
      counts: Record<string, number>
      processed: string[]
      failed: unknown
    }
    expect(result.counts.eligible).toBe(1)
    expect(result.processed).toHaveLength(1)
    expect(result.failed).toBeNull()
    expect(existsSync(join(gitDir, "logs/refs/remotes"))).toBe(false)
  })

  it("exits 1 when a child was refused, even though the run carried on past it", async () => {
    const scratch = mkdtempSync(join(canonicalTmpdir(), "git-super-c3-cli-refused-"))
    roots.push(scratch)
    const retainedRoot = join(scratch, "retained-modules")
    mkdirSync(retainedRoot, { recursive: true })
    const damaged = buildRetainedEntry(retainedRoot, "a-damaged")
    const healthy = buildRetainedEntry(retainedRoot, "b-healthy")
    writeFileSync(join(damaged.gitDir, "description"), "tampered after the proof was written\n")
    const repo = join(scratch, "repo")
    createRepository(repo, "file.ts", "export const n = 1\n")
    const stdout = outputSink()
    const stderr = outputSink()

    const code = await runCli(
      ["--repo", repo, "--json", "worktree", "retention", "compact", "--root", retainedRoot],
      stdout,
      stderr,
    )

    expect(code, stderr.output).toBe(1)
    const result = JSON.parse(stdout.output) as {
      counts: Record<string, number>
      processed: string[]
      failed: unknown
    }
    expect(result.failed).toBeNull()
    expect(result.counts["refused-gate-2"]).toBe(1)
    expect(result.processed).toEqual([healthy.entry])
    expect(existsSync(join(healthy.gitDir, "logs/refs/remotes"))).toBe(false)
    expect(existsSync(join(damaged.gitDir, "logs/refs/remotes"))).toBe(true)
  })
})
