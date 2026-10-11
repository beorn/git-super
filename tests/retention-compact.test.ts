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
import { compactRetainedModules, findRetainedGitDirs, type CompactionOptions } from "../src/retention-compact.ts"
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
