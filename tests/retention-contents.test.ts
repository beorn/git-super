/**
 * @failure Gate 4 subtracts borrowed objects as owned, samples the effective set, holds a whole
 * OID set in memory, or misses a root OID the entry's own store no longer carries.
 * @level l1
 * @consumer the read-only retention verifier, gate 4; #27443(b)
 * @testonly none
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { afterEach, describe, expect, test } from "vitest"
import {
  defaultGitRun,
  scanContents,
  type ContentsScan,
  type GitRun,
  type GitStreamFactory,
} from "../src/retention-contents.ts"
import { gitLineStream, readLines, type GitLineStream, type GitStreamOutcome } from "../src/retention-stream.ts"
import type { ManifestEntry } from "../src/worktree-removal.ts"

const cleanup: string[] = []
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true })
})

/** A canned line stream with a canned outcome: the fake `GitStreamFactory` these cases need. */
function lineStreamFrom(lines: readonly string[], outcome?: Partial<GitStreamOutcome>): GitLineStream {
  const bytes = lines.reduce((total, line) => total + Buffer.byteLength(line, "utf8") + 1, 0)
  return {
    lines: Readable.from(lines),
    outcome: Promise.resolve({
      code: outcome?.code ?? 0,
      bytes: outcome?.bytes ?? bytes,
      lines: outcome?.lines ?? lines.length,
      stderr: outcome?.stderr ?? "",
      timedOut: outcome?.timedOut ?? false,
      capped: outcome?.capped ?? false,
    }),
  }
}

function tmp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  cleanup.push(path)
  return path
}

const environment: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Gate4",
  GIT_AUTHOR_EMAIL: "g4@example.test",
  GIT_COMMITTER_NAME: "Gate4",
  GIT_COMMITTER_EMAIL: "g4@example.test",
  GIT_TERMINAL_PROMPT: "0",
}

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: environment })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed in ${cwd}`)
  return result.stdout.trim()
}

function hashObject(cwd: string, content: string): string {
  const result = spawnSync("git", ["hash-object", "-w", "--stdin"], {
    cwd,
    input: content,
    encoding: "utf8",
    env: environment,
  })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

/** A repo whose `.git` is the single component; `entries` only names it for componentsFromManifest. */
function repoWithCommit(prefix: string): { root: string; gitDir: string; head: string } {
  const root = tmp(prefix)
  git(root, ["init", "-q", "-b", "main"])
  writeFileSync(join(root, "a.txt"), "alpha\n")
  git(root, ["add", "a.txt"])
  git(root, ["commit", "-q", "-m", "first"])
  return { root, gitDir: join(root, ".git"), head: git(root, ["rev-parse", "HEAD"]) }
}

function componentEntries(component: string): Record<string, ManifestEntry> {
  return { [`${component}/objects/pack/example.pack`]: { kind: "file", sha256: "0".repeat(64) } as ManifestEntry }
}

async function atRiskOf(scan: ContentsScan): Promise<Array<{ oid: string; type: string; source: string }>> {
  const rows: Array<{ oid: string; type: string; source: string }> = []
  for await (const line of readLines(scan.components[0]!.atRiskSidecar.path)) {
    const [oid, type, source] = line.split("\t")
    rows.push({ oid: oid ?? "", type: type ?? "", source: source ?? "" })
  }
  return rows
}

function scan(
  copyRoot: string,
  entries: Record<string, ManifestEntry>,
  options: Partial<{
    run: GitRun
    stream: GitStreamFactory
    bounds: { maxEffectiveOids: number; componentMs: number }
    clock: () => number
  }> = {},
): Promise<ContentsScan> {
  return scanContents(copyRoot, entries, [], { sidecarDir: tmp("git-super-contents-sidecars-"), ...options })
}

const ZERO = "0".repeat(40)

describe("retention contents scan — gate 4 (#27443(b))", () => {
  test("a loose unreferenced OID is at-risk and sourced as owned", async () => {
    const { root } = repoWithCommit("git-super-contents-")
    const blob = hashObject(root, "unique-bytes\n")
    const result = await scan(root, componentEntries(".git"))
    expect(result.status).toBe("pass")
    const component = result.components[0]!
    const rows = await atRiskOf(result)
    expect(rows.map((row) => row.oid)).toContain(blob)
    expect(rows.find((row) => row.oid === blob)!.source).toBe("owned")
    expect(component.atRisk).toBe(rows.length)
  })

  test("a packed-only OID survives a repack and is still enumerated", async () => {
    const { root } = repoWithCommit("git-super-contents-")
    const blob = hashObject(root, "packed-bytes\n")
    git(root, ["repack", "-adq"])
    const result = await scan(root, componentEntries(".git"))
    expect(result.status).toBe("pass")
    expect((await atRiskOf(result)).map((row) => row.oid)).toContain(blob)
  })

  test("objects borrowed through a surviving alternate are subtracted, never counted as owned", async () => {
    const lender = repoWithCommit("git-super-contents-lender-")
    const borrower = tmp("git-super-contents-borrower-")
    git(borrower, ["init", "-q", "-b", "main"])
    mkdirSync(join(borrower, ".git", "objects", "info"), { recursive: true })
    writeFileSync(join(borrower, ".git", "objects", "info", "alternates"), `${join(lender.root, ".git", "objects")}\n`)
    writeFileSync(join(borrower, ".git", "refs", "heads", "borrowed"), `${lender.head}\n`)
    const result = await scan(borrower, componentEntries(".git"))
    expect(result.status).toBe("pass")
    expect(result.components[0]!.effective).toBeGreaterThan(0)
    expect(result.components[0]!.atRisk).toBe(0)
    expect((await atRiskOf(result)).map((row) => row.oid)).not.toContain(lender.head)
  })

  test("a dangling alternate is unknown, never a silent skip", async () => {
    const borrower = tmp("git-super-contents-")
    git(borrower, ["init", "-q", "-b", "main"])
    mkdirSync(join(borrower, ".git", "objects", "info"), { recursive: true })
    writeFileSync(join(borrower, ".git", "objects", "info", "alternates"), `${join(borrower, "gone", "objects")}\n`)
    const result = await scan(borrower, componentEntries(".git"))
    expect(result.status).toBe("unknown")
    expect(result.detail).toContain("missing alternate")
  })

  test("a malformed cat-file row is unknown, never a silent skip", async () => {
    const { root } = repoWithCommit("git-super-contents-")
    const stream: GitStreamFactory = (args, options) =>
      args.includes("cat-file") ? lineStreamFrom(["not-an-oid blob 3"]) : gitLineStream(args, options)
    const result = await scan(root, componentEntries(".git"), { stream })
    expect(result.status).toBe("unknown")
    expect(result.detail).toContain("malformed cat-file row")
  })

  test("a root OID the entry's own store no longer carries is blocked with its sidecar", async () => {
    const { root, gitDir } = repoWithCommit("git-super-contents-")
    writeFileSync(join(gitDir, "refs", "heads", "ghost"), `${"a".repeat(40)}\n`)
    const result = await scan(root, componentEntries(".git"))
    expect(result.status).toBe("blocked")
    expect(result.detail).toContain("no longer carries")
    const component = result.components[0]!
    expect(component.missingRoots).toBe(1)
    expect(component.missingRootsSample).toContain("a".repeat(40))
    expect(component.missingRootsSidecar).toBeDefined()
    expect(result.detail).toContain("a".repeat(40))
  })

  test("the creation reflog's zero OIDs are excluded, never missing roots", async () => {
    const { root } = repoWithCommit("git-super-contents-")
    const result = await scan(root, componentEntries(".git"))
    expect(result.status).toBe("pass")
    expect(result.components[0]!.missingRoots).toBe(0)
    expect(result.components[0]!.missingRootsSample).not.toContain(ZERO)
  })

  test("the per-component bound is unknown with the observed count, not truncation", async () => {
    const { root } = repoWithCommit("git-super-contents-")
    let ticks = 0
    const result = await scan(root, componentEntries(".git"), {
      bounds: { maxEffectiveOids: 4_000_000, componentMs: 0 },
      clock: () => (ticks += 1000),
    })
    expect(result.status).toBe("unknown")
    expect(result.detail).toContain("component bound")
  })

  test("a hung git child is killed at the requested timeout, never blocking the scan", async () => {
    const bin = tmp("git-super-contents-bin-")
    writeFileSync(join(bin, "git"), "#!/bin/sh\nexec sleep 5\n", { mode: 0o755 })
    const savedPath = process.env.PATH
    process.env.PATH = `${bin}:${savedPath ?? ""}`
    const startedAt = Date.now()
    try {
      const result = defaultGitRun(["--version"], { timeoutMs: 300 })
      expect(result.timedOut).toBe(true)
      expect(result.code).not.toBe(0)
      expect(Date.now() - startedAt).toBeLessThan(3_000)
    } finally {
      process.env.PATH = savedPath
    }
  })

  test("scanContents hands every stream the remaining component budget and maps a timeout to unknown", async () => {
    const { root } = repoWithCommit("git-super-contents-")
    const seen: Array<number | undefined> = []
    const stream: GitStreamFactory = (args, options) => {
      seen.push(options?.timeoutMs)
      return lineStreamFrom([], { code: 1, timedOut: true, stderr: "git cat-file timed out" })
    }
    const result = await scan(root, componentEntries(".git"), {
      stream,
      bounds: { maxEffectiveOids: 4_000_000, componentMs: 5_000 },
    })
    expect(result.status).toBe("unknown")
    expect(result.detail).toContain("component bound")
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((value) => value !== undefined && value > 0 && value <= 5_000)).toBe(true)
  })

  test("a TERM-refusing git child is still killed at the deadline with a nonzero status", async () => {
    const bin = tmp("git-super-contents-bin-")
    writeFileSync(join(bin, "git"), "#!/bin/sh\ntrap '' TERM\nexec sleep 3\n", { mode: 0o755 })
    const savedPath = process.env.PATH
    process.env.PATH = `${bin}:${savedPath ?? ""}`
    const startedAt = Date.now()
    try {
      const result = defaultGitRun(["--version"], { timeoutMs: 100 })
      expect(result.timedOut).toBe(true)
      expect(result.code).not.toBe(0)
      expect(Date.now() - startedAt).toBeLessThan(1_500)
    } finally {
      process.env.PATH = savedPath
    }
  })

  test("a healthy git child keeps its own zero status and is not marked timedOut", async () => {
    const result = defaultGitRun(["--version"])
    expect(result.code).toBe(0)
    expect(result.timedOut).toBeFalsy()
    expect(result.stdout).toMatch(/^git version/u)
  })
})
