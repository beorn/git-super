/**
 * @failure Gate 4 subtracts borrowed objects as owned, samples the effective set, holds a whole
 * OID set in memory, misses a root OID the entry's own store no longer carries, or accepts a
 * successful git query whose stderr shows an ignored/unusable alternate as a complete read.
 * @level l1
 * @consumer the read-only retention verifier, gate 4; #27443(b)
 * @reach fs-walk <fixture-only: every case builds an mkdtempSync(tmpdir()) Git repo; no repository source tree is walked>
 * @testonly none
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { afterEach, describe, expect, test } from "vitest"
import {
  defaultGitRun,
  readReflogEntries,
  scanContents,
  type ContentsScan,
  type GitRun,
  type GitStreamFactory,
} from "../src/retention-contents.ts"
import {
  assertStreamComplete,
  gitLineStream,
  readLines,
  type GitLineStream,
  type GitStreamOutcome,
} from "../src/retention-stream.ts"
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
  /**
   * @failure The shared reader loses no-message creation records, splits inside an ident, or silently skips malformed OIDs.
   * @level l1
   * @consumer Retention roots and Yrd environment provenance
   */
  test.each([
    { name: "creation without a TAB", row: `${ZERO} ${"a".repeat(40)} Test <test@example.test> 1 +0000`, message: "" },
    {
      name: "TAB in ident and colon in message",
      row: `${"a".repeat(40)} ${"b".repeat(40)} Test\tName <test@example.test> 2 -0700\tcommit: two words: detail`,
      message: "commit: two words: detail",
    },
    { name: "malformed next OID", row: `${ZERO} invalid Test <test@example.test> 1 +0000`, message: undefined },
  ])("reads shared reflog entries: $name", ({ row, message }) => {
    const path = join(tmp("git-super-reflog-"), "HEAD")
    writeFileSync(path, `${row}\n`)
    if (message === undefined) {
      expect(() => [...readReflogEntries(path)]).toThrow(`malformed reflog record in ${path}`)
    } else {
      expect([...readReflogEntries(path)]).toEqual([{ oldOid: row.slice(0, 40), newOid: row.slice(41, 81), message }])
    }
  })
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
    expect(result.detail).toContain(join(borrower, "gone", "objects"))
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

  test("a capped object list is unknown through the one stream rule, never a partial certificate", async () => {
    const { root } = repoWithCommit("git-super-contents-")
    const stream: GitStreamFactory = (args, options) =>
      args.includes("cat-file") ? lineStreamFrom([], { capped: true }) : gitLineStream(args, options)
    const result = await scan(root, componentEntries(".git"), { stream })
    expect(result.status).toBe("unknown")
    expect(result.detail).toContain("cap")
  })

  test("an effective set one over the declared cap is unknown, not a pass (the real stream boundary)", async () => {
    const { root } = repoWithCommit("git-super-contents-")
    hashObject(root, "over-cap\n")
    const total = git(root, ["cat-file", "--batch-all-objects", "--batch-check"])
      .split("\n")
      .filter((line) => line !== "").length
    expect(total).toBeGreaterThan(1)
    const over = await scan(root, componentEntries(".git"), {
      bounds: { maxEffectiveOids: total - 1, componentMs: 120_000 },
    })
    expect(over.status).toBe("unknown")
    expect(over.detail).toContain("cap")
    const at = await scan(root, componentEntries(".git"), {
      bounds: { maxEffectiveOids: total, componentMs: 120_000 },
    })
    expect(at.status).toBe("pass")
    expect(at.components[0]!.effective).toBe(total)
  })

  test("a successful cat-file stream that wrote to stderr is unknown through the one stream rule", async () => {
    const { root } = repoWithCommit("git-super-contents-")
    const stream: GitStreamFactory = (args, options) =>
      args.includes("cat-file")
        ? lineStreamFrom([`${ZERO} blob 3`], {
            stderr: "error: unable to normalize alternate object path: /gone",
          })
        : gitLineStream(args, options)
    const result = await scan(root, componentEntries(".git"), { stream })
    expect(result.status).toBe("unknown")
    expect(result.detail).toContain("stderr")
  })

  test.skipIf(process.getuid?.() === 0)(
    "a real git cat-file stream that warns on stderr is refused at the stream boundary",
    async () => {
      // Git warns and still exits 0 when an alternate directory cannot be read, and the stdout that
      // follows is shorter than the store. The claim here is deliberately the STREAM boundary: a
      // scan-level fixture cannot isolate it, because the independent-store stream runs
      // `--git-dir=<alternate>/..`, which turns the same unusable target into a non-zero fatal and
      // makes the pre-fix scan unknown for an unrelated cause (measured: a plain unreadable target
      // yields `fatal: not a git repository` before the fix). The healthy control proves the
      // discriminator is the stderr, not the fixture layout.
      const messages = { timedOut: "deadline", capped: "cap", failed: "failed", warned: "warned" }
      const drain = async (iterable: AsyncIterable<string>): Promise<void> => {
        for await (const _line of iterable) void _line
      }
      const { root, gitDir } = repoWithCommit("git-super-contents-")
      const target = join(root, "locked-store")
      mkdirSync(target)
      chmodSync(target, 0o000)
      try {
        mkdirSync(join(gitDir, "objects", "info"), { recursive: true })
        writeFileSync(join(gitDir, "objects", "info", "alternates"), `${target}\n`)
        const broken = gitLineStream([
          `--git-dir=${gitDir}`,
          `--work-tree=${root}`,
          "cat-file",
          "--batch-all-objects",
          "--batch-check",
        ])
        await drain(broken.lines)
        const brokenOutcome = await broken.outcome
        expect(brokenOutcome.code).toBe(0)
        expect(brokenOutcome.stderr).toContain("Permission denied")
        expect(() => assertStreamComplete(brokenOutcome, messages)).toThrow(/warned/u)
      } finally {
        chmodSync(target, 0o755)
      }
      const { root: healthy } = repoWithCommit("git-super-contents-")
      const ok = gitLineStream([
        `--git-dir=${join(healthy, ".git")}`,
        `--work-tree=${healthy}`,
        "cat-file",
        "--batch-all-objects",
        "--batch-check",
      ])
      await drain(ok.lines)
      const okOutcome = await ok.outcome
      expect(okOutcome.code).toBe(0)
      expect(okOutcome.stderr).toBe("")
      expect(() => assertStreamComplete(okOutcome, messages)).not.toThrow()
    },
  )

  test("every synchronous component root query carries the remaining component budget", async () => {
    const { root } = repoWithCommit("git-super-contents-")
    const seen: Array<{ args: string; timeoutMs: number | undefined }> = []
    const run: GitRun = (args, options) => {
      seen.push({ args: args.join(" "), timeoutMs: options?.timeoutMs })
      return defaultGitRun(args, options)
    }
    const result = await scan(root, componentEntries(".git"), {
      run,
      stream: gitLineStream,
      bounds: { maxEffectiveOids: 4_000_000, componentMs: 120_000 },
    })
    expect(result.status).toBe("pass")
    for (const query of ["for-each-ref", "rev-parse", "ls-files"]) {
      expect(seen.some((entry) => entry.args.includes(query))).toBe(true)
    }
    expect(seen.every((entry) => typeof entry.timeoutMs === "number" && entry.timeoutMs > 0)).toBe(true)
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
