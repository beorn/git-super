/**
 * @failure Gate 4 subtracts borrowed objects as owned, samples the effective set, or misses a
 * root OID the entry's own store no longer carries.
 * @level l1
 * @consumer the read-only retention verifier, gate 4; #27443(b)
 * @testonly none
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { defaultGitRun, scanContents, type GitRun } from "../src/retention-contents.ts"
import type { ManifestEntry } from "../src/worktree-removal.ts"

const cleanup: string[] = []
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true })
})

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

const ZERO = "0".repeat(40)

describe("retention contents scan — gate 4 (#27443(b))", () => {
  test("a loose unreferenced OID is at-risk and sourced as owned", () => {
    const { root } = repoWithCommit("git-super-contents-")
    const blob = hashObject(root, "unique-bytes\n")
    const scan = scanContents(root, componentEntries(".git"), [])
    expect(scan.status).toBe("pass")
    const component = scan.components[0]!
    expect(component.atRiskOids).toContain(blob)
    expect(component.atRiskSources[blob]).toBe("owned")
    expect(component.atRisk).toBe(component.atRiskOids.length)
  })

  test("a packed-only OID survives a repack and is still enumerated", () => {
    const { root } = repoWithCommit("git-super-contents-")
    const blob = hashObject(root, "packed-bytes\n")
    git(root, ["repack", "-adq"])
    const scan = scanContents(root, componentEntries(".git"), [])
    expect(scan.status).toBe("pass")
    expect(scan.components[0]!.atRiskOids).toContain(blob)
  })

  test("objects borrowed through a surviving alternate are subtracted, never counted as owned", () => {
    const lender = repoWithCommit("git-super-contents-lender-")
    const borrower = tmp("git-super-contents-borrower-")
    git(borrower, ["init", "-q", "-b", "main"])
    mkdirSync(join(borrower, ".git", "objects", "info"), { recursive: true })
    writeFileSync(join(borrower, ".git", "objects", "info", "alternates"), `${join(lender.root, ".git", "objects")}\n`)
    writeFileSync(join(borrower, ".git", "refs", "heads", "borrowed"), `${lender.head}\n`)
    const scan = scanContents(borrower, componentEntries(".git"), [])
    expect(scan.status).toBe("pass")
    const component = scan.components[0]!
    expect(component.effective).toBeGreaterThan(0)
    expect(component.atRisk).toBe(0)
    expect(component.atRiskOids).not.toContain(lender.head)
  })

  test("a dangling alternate is unknown, never a silent skip", () => {
    const borrower = tmp("git-super-contents-")
    git(borrower, ["init", "-q", "-b", "main"])
    mkdirSync(join(borrower, ".git", "objects", "info"), { recursive: true })
    writeFileSync(join(borrower, ".git", "objects", "info", "alternates"), `${join(borrower, "gone", "objects")}\n`)
    const scan = scanContents(borrower, componentEntries(".git"), [])
    expect(scan.status).toBe("unknown")
    expect(scan.detail).toContain("missing alternate")
  })

  test("a malformed cat-file row is unknown", () => {
    const { root } = repoWithCommit("git-super-contents-")
    const broken: GitRun = (args) =>
      args.includes("cat-file") ? { code: 0, stdout: "not-an-oid blob 3\n", stderr: "" } : defaultGitRun(args)
    const scan = scanContents(root, componentEntries(".git"), [], broken)
    expect(scan.status).toBe("unknown")
    expect(scan.detail).toContain("malformed cat-file row")
  })

  test("a root OID the entry's own store no longer carries is blocked", () => {
    const { root, gitDir } = repoWithCommit("git-super-contents-")
    writeFileSync(join(gitDir, "refs", "heads", "ghost"), `${"a".repeat(40)}\n`)
    const scan = scanContents(root, componentEntries(".git"), [])
    expect(scan.status).toBe("blocked")
    expect(scan.detail).toContain("no longer carries")
    expect(scan.components[0]!.missingRoots).toContain("a".repeat(40))
  })

  test("the creation reflog's zero OIDs are excluded, never missing roots", () => {
    const { root } = repoWithCommit("git-super-contents-")
    const scan = scanContents(root, componentEntries(".git"), [])
    expect(scan.status).toBe("pass")
    expect(scan.components[0]!.missingRoots).toEqual([])
    expect(scan.components[0]!.missingRoots).not.toContain(ZERO)
  })

  test("the per-component bound is unknown with the observed count, not truncation", () => {
    const { root } = repoWithCommit("git-super-contents-")
    let ticks = 0
    const scan = scanContents(
      root,
      componentEntries(".git"),
      [],
      undefined,
      { maxEffectiveOids: 4_000_000, componentMs: 0 },
      () => (ticks += 1000),
    )
    expect(scan.status).toBe("unknown")
    expect(scan.detail).toContain("component bound")
  })

  test("a hung git child is killed at the requested timeout, never blocking the scan", () => {
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

  test("scanContents hands every child the remaining component budget and maps a timeout to unknown", () => {
    const { root } = repoWithCommit("git-super-contents-")
    const seen: Array<number | undefined> = []
    const hanging: GitRun = (args, options) => {
      seen.push(options?.timeoutMs)
      if (args.includes("cat-file")) {
        return { code: 1, stdout: "", stderr: "git cat-file timed out after 5000 ms", timedOut: true }
      }
      return { code: 1, stdout: "", stderr: `git ${args[0] ?? ""} timed out`, timedOut: true }
    }
    const scan = scanContents(root, componentEntries(".git"), [], hanging, {
      maxEffectiveOids: 4_000_000,
      componentMs: 5_000,
    })
    expect(scan.status).toBe("unknown")
    expect(scan.detail).toContain("timed out")
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((value) => value !== undefined && value > 0 && value <= 5_000)).toBe(true)
  })

  test("a TERM-refusing git child is still killed at the deadline with a nonzero status", () => {
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

  test("a healthy git child keeps its own zero status and is not marked timedOut", () => {
    const result = defaultGitRun(["--version"])
    expect(result.code).toBe(0)
    expect(result.timedOut).toBeFalsy()
    expect(result.stdout).toMatch(/^git version/u)
  })
})
