/**
 * @failure A retirement batch (#33010, @cto dc77f630) deletes on a stale shared scan: a writer with no lease adds an
 *   alternates file between scan and delete, a kept member still borrows from a deleted one, an owner with no lease
 *   file is skipped instead of keeping the batch, or the dry run deletes.
 * @level l2 (real git-super retained entries written by `worktree remove --retain`)
 * @consumer yrd's one-shot retained-modules drain; git super worktree retention retire-batch
 * @testonly none
 * @reach fs-walk <fixture-only: estate scans visit mkdtempSync(tmpdir()) Git repositories>
 */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  linkSync,
  mkdtempSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, relative } from "node:path"
import { tryAcquireFlock } from "@bearly/flock"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { runCli } from "../src/cli.ts"
import { retireRetainedBatch, type RetentionBatchOptions, type RetentionBatchResult } from "../src/retention-batch.ts"
import { defaultGitRun, defaultGitStream, type GitStreamFactory } from "../src/retention-contents.ts"
import { scanEstate } from "../src/retention-estate.ts"
import { inspectRetainedEntryInBatch } from "../src/retention-verify.ts"

// A pass-through spy: every test still runs the real verifier; the #35047 deadline row reads its call options.
vi.mock("../src/retention-verify.ts", async (importOriginal) => {
  const verify = await importOriginal<typeof import("../src/retention-verify.ts")>()
  return { ...verify, inspectRetainedEntryInBatch: vi.fn(verify.inspectRetainedEntryInBatch) }
})

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>()
  return { ...fs, rmSync: vi.fn(fs.rmSync), linkSync: vi.fn(fs.linkSync) }
})

const environment: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
}

function git(repo: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { env: environment, encoding: "utf8" }).trim()
}

/** `du`-style allocated bytes for one tree, computed independently of the measurement under test. */
function allocatedBytes(path: string): number {
  const stat = lstatSync(path)
  if (!stat.isDirectory()) return stat.blocks * 512
  return readdirSync(path).reduce((total, name) => total + allocatedBytes(join(path, name)), stat.blocks * 512)
}

const sink = (): { write(value: string): void } => ({ write: () => undefined })

let fixtureRoot: string
let root: string
let pristine: string
let common: string
let eligible: Date

beforeAll(async () => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-retention-batch-"))
  const dependency = join(fixtureRoot, "dependency")
  const product = join(fixtureRoot, "product")
  mkdirSync(dependency, { recursive: true })
  git(dependency, ["init", "-q", "-b", "main"])
  writeFileSync(join(dependency, "dep.ts"), "export const dep = 1\n")
  git(dependency, ["add", "dep.ts"])
  git(dependency, ["commit", "-q", "-m", "dep"])
  mkdirSync(product, { recursive: true })
  git(product, ["init", "-q", "-b", "main"])
  git(product, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", dependency, "vendor/dep"])
  git(product, ["commit", "-q", "-m", "add vendor/dep"])
  common = join(product, ".git")
  root = join(fixtureRoot, "retained")
  for (const name of ["one", "two", "three"]) {
    const worktree = join(fixtureRoot, name)
    expect(await runCli(["--repo", product, "worktree", "add", worktree, "HEAD"], sink(), sink())).toBe(0)
    expect(
      await runCli(["--repo", product, "--json", "worktree", "remove", worktree, "--retain", root], sink(), sink()),
    ).toBe(0)
  }
  expect(readdirSync(root)).toHaveLength(3)
  let latest = 0
  for (const name of readdirSync(root)) {
    const manifest = JSON.parse(readFileSync(join(root, name, "manifest.json"), "utf8")) as { retainUntil: string }
    latest = Math.max(latest, Date.parse(manifest.retainUntil))
  }
  eligible = new Date(latest + 1000)
  // Retirement only opens EXISTING owner leases, so the fixture creates one for every owner outside the root.
  for (const objects of (await scanEstate([fixtureRoot], [])).objectDirs) {
    if (objects.startsWith(`${root}/`)) continue
    const lock = join(dirname(objects), "yrd-worktree-mutations", "writer.lock")
    if (existsSync(lock)) continue
    using lease = tryAcquireFlock(lock)
    expect(lease?.held).toBe(true)
  }
  pristine = join(fixtureRoot, "pristine")
  cpSync(root, pristine, { recursive: true })
}, 180_000)

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true })
})

beforeEach(() => {
  rmSync(root, { recursive: true, force: true })
  cpSync(pristine, root, { recursive: true })
  rmSync(join(fixtureRoot, "artifacts"), { recursive: true, force: true })
  rmSync(join(fixtureRoot, "hand-clone"), { recursive: true, force: true })
  rmSync(join(fixtureRoot, "unrelated"), { recursive: true, force: true })
  rmSync(join(common, "worktrees", "cold-owner"), { recursive: true, force: true })
  rmSync(join(fixtureRoot, "revived-owner"), { recursive: true, force: true })
  rmSync(join(common, "modules", "retained-batch"), { recursive: true, force: true })
  rmSync(join(fixtureRoot, "graph-witness"), { recursive: true, force: true })
  for (const name of ["owner-list-a", "owner-list-b", "store-a", "store-b", "store-x"]) {
    rmSync(join(fixtureRoot, name), { recursive: true, force: true })
  }
})

function options(extra: Partial<RetentionBatchOptions> = {}): RetentionBatchOptions {
  return {
    entries: readdirSync(root)
      .sort()
      .map((name) => join(root, name)),
    root,
    common,
    namespaceRoots: [fixtureRoot],
    artifactDir: join(fixtureRoot, "artifacts"),
    allowTemporaryArtifactDir: true,
    clock: eligible,
    ...extra,
  }
}

/** Seal the cross-entry loan through the real retention writer, rather than editing a certified copy. */
async function linkedBatch(): Promise<RetentionBatchOptions> {
  const batchRoot = join(common, "modules", "retained-batch")
  const lenderCheckout = join(fixtureRoot, "linked-lender")
  const checkout = join(fixtureRoot, "linked-borrower")
  const product = dirname(common)
  expect(await runCli(["--repo", product, "worktree", "add", lenderCheckout, "HEAD"], sink(), sink())).toBe(0)
  expect(
    await runCli(["--repo", product, "worktree", "remove", lenderCheckout, "--retain", batchRoot], sink(), sink()),
  ).toBe(0)
  const before = new Set(readdirSync(batchRoot))
  const lender = join(batchRoot, [...before][0] as string)
  expect(await runCli(["--repo", product, "worktree", "add", checkout, "HEAD"], sink(), sink())).toBe(0)
  const module = git(join(checkout, "vendor", "dep"), ["rev-parse", "--absolute-git-dir"])
  writeFileSync(
    join(module, "objects", "info", "alternates"),
    `${join(lender, "modules", "vendor", "dep", "objects")}\n`,
  )
  let errors = ""
  expect(
    await runCli(["--repo", product, "worktree", "remove", checkout, "--retain", batchRoot], sink(), {
      write: (value) => {
        errors += value
      },
    }),
    errors,
  ).toBe(0)
  const name = readdirSync(batchRoot).find((name) => !before.has(name)) as string
  const borrower = join(batchRoot, name)
  const manifest = JSON.parse(readFileSync(join(borrower, "manifest.json"), "utf8")) as { retainUntil: string }
  return {
    ...options(),
    root: batchRoot,
    entries: [lender, borrower],
    clock: new Date(Date.parse(manifest.retainUntil) + 1000),
  }
}

describe("retention retirement batch (#33010)", async () => {
  // AC33010: two entries and both proof phases share exact immutable common bytes, without changing deletion.
  it("shared batch certificates use one explicit common folder across entries and phases", async () => {
    const entries = readdirSync(root)
      .sort()
      .slice(0, 2)
      .map((name) => join(root, name))
    const result = await retireRetainedBatch(options({ entries, apply: true }))
    expect(result.rows.map((row) => row.outcome)).toEqual(["retired", "retired"])
    const refs = entries.flatMap((entry) =>
      ["pre", "held"].map((phase) => {
        const value = JSON.parse(
          readFileSync(
            join(options().artifactDir, entry.split("/").pop()!, phase, "retirement-certificate.json"),
            "utf8",
          ),
        ) as { commonFactsRef: { path: string } }
        return value.commonFactsRef.path
      }),
    )
    expect(new Set(refs).size).toBe(1)
    expect(new Set(refs.map((ref) => dirname(ref)))).toEqual(new Set([join(options().artifactDir, "common")]))
    expect(result.warnings).toEqual([])
  })

  // AC33010: linking is an allocation optimization; a copy fallback keeps the same outcome and names its cost.
  it("shared batch link fallback preserves outcomes and emits one typed warning", async () => {
    const originalLink = vi.mocked(linkSync).getMockImplementation()!
    let failed = false
    vi.mocked(linkSync).mockImplementation((source, target) => {
      if (!failed && String(target).includes("certificate-alias")) {
        failed = true
        throw new Error("forced link failure")
      }
      // The production primitive is synchronous; keep all unrelated native links unchanged.
      return originalLink(source, target)
    })
    try {
      const result = await retireRetainedBatch(options())
      expect(result.rows.every((row) => row.outcome === "would-retire")).toBe(true)
      expect(result.warnings).toEqual([
        { entry: expect.any(String), phase: "pre", message: expect.stringContaining("forced link failure") },
      ])
    } finally {
      vi.mocked(linkSync).mockImplementation(originalLink)
    }
  })

  // The byte total is what an operator approves a deletion against (#34272), so it is measured from the entries the
  // batch would retire, in allocated blocks, and it says so when it could not read part of them.
  it("a dry run reports the allocated bytes of exactly the entries it would retire", async () => {
    const plan = options()
    const result = await retireRetainedBatch(plan)
    expect(result.rows.every((row) => row.outcome === "would-retire")).toBe(true)
    const planned = result.rows.reduce((total, row) => total + allocatedBytes(row.entry), 0)
    expect(result.bytesUnreadable).toBe(0)
    expect(result.bytesPlanned).toBe(planned)
    // Allocated blocks, not apparent size: the fixture holds directories whose size field is well under their blocks.
    expect(result.bytesPlanned).toBeGreaterThan(planned === 0 ? -1 : 0)
    // #34920: the receipts this batch wrote are reported beside the reclaim figure, measured, not estimated.
    // Each inode once: the batch hard-links shared certificate files between the common folder and entries.
    const inodes = new Map<string, number>()
    const walk = (path: string): void => {
      const stat = lstatSync(path)
      inodes.set(`${stat.dev}:${stat.ino}`, stat.blocks * 512)
      if (stat.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name))
    }
    const evidencePaths = [
      ...result.rows.map((row) => join(plan.artifactDir, basename(row.entry))),
      join(plan.artifactDir, "common"),
    ]
    for (const path of evidencePaths) if (existsSync(path)) walk(path)
    const evidence = [...inodes.values()].reduce((total, bytes) => total + bytes, 0)
    expect(result.bytesEvidence).toBe(evidence)
    expect(result.bytesEvidence).toBeGreaterThan(0)
  })

  // CTO cbd8921c: after successful deletion, an external pointer cleanup failure must say both that the entry
  // is gone and which phase failed. Existing partial-removal coverage fails before bulk deletion finishes.
  it("names a pointer cleanup failure after the entry is gone and keeps later entries", async () => {
    const checkout = join(fixtureRoot, "pointer-cleanup")
    const previous = readdirSync(root).map((name) => join(root, name))
    expect(await runCli(["--repo", dirname(common), "worktree", "add", checkout, "HEAD"], sink(), sink())).toBe(0)
    expect(
      await runCli(["--repo", dirname(common), "worktree", "remove", checkout, "--retain", root], sink(), sink()),
    ).toBe(0)
    const first = readdirSync(root)
      .map((name) => join(root, name))
      .find((entry) => !previous.includes(entry)) as string
    const manifest = JSON.parse(readFileSync(join(first, "manifest.json"), "utf8")) as { retainUntil: string }
    const registry = join(common, "git-super-retained-borrowers")
    // Historical registry input, not current-writer output: keep the native entry and manifest unchanged.
    mkdirSync(registry, { recursive: true })
    const manifestPath = join(first, "manifest.json")
    const pointer = join(registry, `${createHash("sha256").update(manifestPath).digest("hex")}.json`)
    writeFileSync(pointer, `${JSON.stringify({ retained: join(first, "modules"), manifest: manifestPath })}\n`)
    const mode = statSync(registry).mode & 0o777
    const second = previous[0] as string
    try {
      const result = await retireRetainedBatch(
        options({
          entries: [first, second],
          apply: true,
          clock: new Date(Date.parse(manifest.retainUntil) + 1000),
          afterScan: () => chmodSync(registry, 0o555),
        }),
      )
      expect(
        result.rows.map((row) => row.outcome),
        JSON.stringify(result.rows),
      ).toEqual(["failed", "kept"])
      expect(existsSync(first)).toBe(false)
      expect(existsSync(pointer)).toBe(true)
      expect(existsSync(second)).toBe(true)
      expect(result.rows[0]?.reason).toContain("actual entry state: gone")
      expect(result.rows[0]?.reason).toContain("pointer cleanup failed")
    } finally {
      chmodSync(registry, mode)
      rmSync(pointer, { force: true })
    }
  })
  // CTO 2cdcedf4: deleting a selected registry holder must not make the batch re-read its missing registry or
  // owning manifest. Existing fixtures have registries only outside the removal set.
  it("retires a sealed registry holder and continues through every later batch entry", async () => {
    const checkout = join(fixtureRoot, "registry-holder")
    const previous = readdirSync(root).map((name) => join(root, name))
    expect(await runCli(["--repo", dirname(common), "worktree", "add", checkout, "HEAD"], sink(), sink())).toBe(0)
    const module = git(join(checkout, "vendor", "dep"), ["rev-parse", "--absolute-git-dir"])
    mkdirSync(join(module, "git-super-retained-borrowers"))
    expect(
      await runCli(["--repo", dirname(common), "worktree", "remove", checkout, "--retain", root], sink(), sink()),
    ).toBe(0)
    const first = readdirSync(root)
      .map((name) => join(root, name))
      .find((entry) => !previous.includes(entry)) as string
    const manifest = JSON.parse(readFileSync(join(first, "manifest.json"), "utf8")) as { retainUntil: string }
    const input = options({ entries: [first, ...previous], clock: new Date(Date.parse(manifest.retainUntil) + 1000) })
    expect((await scanEstate([fixtureRoot], input.entries)).registries).toContain(
      join(first, "modules", "vendor", "dep", "git-super-retained-borrowers"),
    )
    const dry = await retireRetainedBatch(input)
    expect(
      dry.rows.map((row) => row.outcome),
      JSON.stringify(dry.rows),
    ).toEqual(Array(4).fill("would-retire"))
    const result = await retireRetainedBatch({ ...input, apply: true })
    expect(result.stopped, JSON.stringify(result.rows)).toBeUndefined()
    expect(
      result.rows.map((row) => row.outcome),
      JSON.stringify(result.rows),
    ).toEqual(Array(4).fill("retired"))
    expect(readdirSync(root)).toEqual([])
  })
  // Accepted requirement: no surviving borrower loses its lender, including when a held gate keeps a batch
  // member. The existing already-kept-member test never exercises members that pass preliminary gates.
  it("retires a sealed cross-entry borrower before its lender regardless of requested order", async () => {
    const input = await linkedBatch()
    const dry = await retireRetainedBatch(input)
    expect(
      dry.rows.map((row) => row.outcome),
      JSON.stringify(dry.rows),
    ).toEqual(["would-retire", "would-retire"])
    const result = await retireRetainedBatch({ ...input, apply: true })
    expect(
      result.rows.map((row) => row.outcome),
      JSON.stringify(result.rows),
    ).toEqual(["retired", "retired"])
    expect(result.windows[0]?.entries).toEqual([...input.entries].reverse())
  })

  it("a borrower kept by held re-verification also keeps its candidate lender", async () => {
    const input = await linkedBatch()
    const borrower = input.entries[1] as string
    const result = await retireRetainedBatch({
      ...input,
      apply: true,
      afterScan: () => {
        const path = join(borrower, "manifest.json")
        const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
        manifest.retainUntil = "2999-01-01T00:00:00Z"
        writeFileSync(path, JSON.stringify(manifest))
      },
    })
    expect(
      result.rows.map((row) => row.outcome),
      JSON.stringify(result.rows),
    ).toEqual(["kept", "kept"])
    expect(existsSync(input.entries[0] as string)).toBe(true)
    expect(existsSync(borrower)).toBe(true)
  })
  // Accepted requirement: the production CLI defaults to dry run and requires a complete estate declaration.
  // Direct batch tests cannot prove Commander reaches the batch or that its flags are preserved.
  it("CLI defaults to dry run and names every selected entry without deleting it", async () => {
    let output = ""
    let errors = ""
    const entries = readdirSync(root)
      .sort()
      .map((name) => join(root, name))
    const code = await runCli(
      [
        "--repo",
        dirname(common),
        "--json",
        "worktree",
        "retention",
        "retire-batch",
        "--root",
        root,
        "--common",
        common,
        "--namespace",
        fixtureRoot,
        "--artifact-dir",
        join(fixtureRoot, "artifacts"),
        ...entries,
      ],
      {
        write: (value) => {
          output += value
        },
      },
      {
        write: (value) => {
          errors += value
        },
      },
    )
    expect(code, errors).toBe(0)
    const report = JSON.parse(output) as { apply: boolean; rows: { entry: string; outcome: string }[] }
    expect(report.apply).toBe(false)
    expect(report.rows.map((row) => row.entry)).toEqual(entries)
    expect(report.rows.every((row) => row.outcome !== "retired")).toBe(true)
    expect(readdirSync(root)).toHaveLength(3)
  })

  it("CLI names the missing estate namespace and exits nonzero", async () => {
    let errors = ""
    const entry = join(root, readdirSync(root)[0] as string)
    const code = await runCli(
      [
        "--repo",
        dirname(common),
        "worktree",
        "retention",
        "retire-batch",
        "--root",
        root,
        "--common",
        common,
        "--artifact-dir",
        join(fixtureRoot, "artifacts"),
        entry,
      ],
      sink(),
      {
        write: (value) => {
          errors += value
        },
      },
    )
    expect(code).not.toBe(0)
    expect(errors).toContain("namespace")
    expect(readdirSync(root)).toHaveLength(3)
  })
  // #35047: a 20-entry preliminary pass ran past Yrd's 1200 s timeout with no report and its walk still running. Under
  // the batch proof deadline every unproved entry is kept with the cause, the run reports `stopped` (exit 2), and an
  // apply takes no lease and deletes nothing. The CLI dry run above is the same fixture under the 960 s default.
  it("CLI keeps every entry its proof deadline cuts off, reports the stop, and deletes nothing", async () => {
    let output = ""
    let errors = ""
    const entries = readdirSync(root)
      .sort()
      .map((name) => join(root, name))
    const code = await runCli(
      [
        "--repo",
        dirname(common),
        "--json",
        "worktree",
        "retention",
        "retire-batch",
        "--root",
        root,
        "--common",
        common,
        "--namespace",
        fixtureRoot,
        "--artifact-dir",
        join(fixtureRoot, "artifacts"),
        "--proof-deadline-seconds",
        "0.001",
        "--apply",
        ...entries,
      ],
      {
        write: (value) => {
          output += value
        },
      },
      {
        write: (value) => {
          errors += value
        },
      },
    )
    expect(code, errors).toBe(2)
    const report = JSON.parse(output) as RetentionBatchResult
    expect(report.stopped).toMatch(/^proof-deadline: the batch proof deadline \(1 ms\) passed/u)
    expect(report.rows.map((row) => [row.entry, row.outcome])).toEqual(entries.map((entry) => [entry, "kept"]))
    for (const row of report.rows) expect(row.reason).toContain("proof deadline")
    expect(report.windows).toEqual([])
    expect(readdirSync(root)).toHaveLength(3)
  })

  it("a dry run under an unspent proof deadline is unchanged; a spent one keeps and names every entry", async () => {
    const unspent = await retireRetainedBatch(options({ proofDeadlineMs: 600_000 }))
    expect(unspent.stopped).toBeUndefined()
    expect(unspent.rows.every((row) => row.outcome === "would-retire")).toBe(true)
    const spent = await retireRetainedBatch(options({ proofDeadlineMs: 1 }))
    expect(spent.stopped).toContain("3 entr(ies) were not started")
    expect(spent.rows.map((row) => row.outcome)).toEqual(["kept", "kept", "kept"])
    expect(spent.rows[0]?.reason).toContain("passed before this entry's proof began")
  })

  // 34127 (@cto e8f6c3b5): every entry carries its own boundaries, so a batch names where its budget went instead of
  // reporting one proof total. Turn58: the top-level buckets are the entry's own and cannot overlap, the custody walk's
  // phases sit beside `child` rather than inside its arithmetic, and the certificate write is measured where it runs.
  it("records non-overlapping per-entry boundaries and the measured receipt write", async () => {
    const result = await retireRetainedBatch(options({ proofDeadlineMs: 600_000 }))
    expect(result.stopped).toBeUndefined()
    const topLevel = new Set(["setup", "child", "drain", "receipt"])
    for (const row of result.rows) {
      const timing = result.preliminaryEntryTimings?.[row.entry]
      expect(timing, row.entry).toBeDefined()
      expect(timing?.lastPhase).toBe("receipt")
      expect(timing?.sliceMs).toBeGreaterThan(0)
      expect(timing?.endMs).toBeGreaterThanOrEqual(timing?.startMs ?? 0)
      expect(Object.keys(timing?.phases ?? {}).every((name) => topLevel.has(name))).toBe(true)
      expect(timing?.phases.setup).toBeGreaterThanOrEqual(0)
      expect(timing?.phases.child).toBeGreaterThanOrEqual(0)
      expect(timing?.phases.drain).toBeGreaterThanOrEqual(0)
      // The write ran on this path, so its span is measured rather than inferred from what no phase owns.
      expect(timing?.receiptMs).toBeDefined()
      expect(timing?.receiptMs).toBeGreaterThanOrEqual(0)
      expect(timing?.deadlineCutMs).toBeUndefined()
      // Every subphase is a nested custody operation, measured on its own; none of them may be a top-level bucket.
      expect(Object.keys(timing?.subphases ?? {}).every((name) => !topLevel.has(name))).toBe(true)
      for (const [name, spend] of Object.entries(timing?.subphases ?? {})) {
        expect(spend, name).toBeGreaterThanOrEqual(0)
        // A nested operation is inclusive inside `child`, so it can never exceed it.
        expect(spend, name).toBeLessThanOrEqual(timing?.phases.child ?? 0)
      }
      // Non-overlapping: the top-level buckets cannot exceed the entry's own span, and the residual is reported as
      // measured instead of being clamped to zero.
      expect(timing?.unattributedMs).toBeGreaterThanOrEqual(0)
      expect(timing?.unattributedMs).toBeLessThanOrEqual((timing?.endMs ?? 0) - (timing?.startMs ?? 0))
    }
  })

  // 34127 (@cto turn58): a walk cut INSIDE a named custody phase must keep that name and its spend after the caller
  // enters drain. The reproduced defect reported lastPhase=drain with witnessFsck=1489 ms and proofPhases.witnessFsck=0,
  // which loses exactly the operation the deadline landed in.
  it("keeps the custody phase a spent deadline cut, not the drain that ran after it", async () => {
    const slowCustody = async (args: readonly string[], runOptions?: Parameters<typeof defaultGitRun>[1]) => {
      if (args.includes("core.worktree")) await new Promise((resolve) => setTimeout(resolve, 200))
      return defaultGitRun(args, runOptions)
    }
    const cut = await retireRetainedBatch(options({ proofDeadlineMs: 60, gitRun: slowCustody }))
    expect(cut.rows.every((row) => row.outcome === "kept")).toBe(true)
    const cutTimings = Object.values(cut.preliminaryEntryTimings ?? {}).filter(
      (timing) => timing.deadlineCutMs !== undefined,
    )
    expect(cutTimings.length).toBeGreaterThan(0)
    for (const timing of cutTimings) {
      // The entry died in a live phase; the drain that ran after the cut never takes its name.
      expect(["setup", "child"]).toContain(timing.lastPhase)
      // 34127 (@cto turn60): the cut time is published in the entry's own (batch-relative) coordinates, so it can be
      // checked against the boundaries beside it instead of against a different clock.
      expect(timing.deadlineCutMs).toBeGreaterThanOrEqual(timing.startMs)
      expect(timing.deadlineCutMs).toBeLessThanOrEqual(timing.endMs)
      // Drain was entered after the cut and is measured, but the certificate write was never reached.
      expect(timing.phases.drain).toBeDefined()
      expect(timing.phases.receipt).toBeUndefined()
      expect(timing.receiptMs).toBeUndefined()
      // Whatever phase died keeps a positive spend instead of being dropped with the frame.
      expect(Object.values(timing.phases).reduce((sum, ms) => sum + ms, 0)).toBeGreaterThan(0)
      // A custody subphase, when the run reaches one, carries its own measured spend beside `child` - never a negative
      // or window-derived one.
      for (const [name, spend] of Object.entries(timing.subphases ?? {})) {
        expect(spend, name).toBeGreaterThanOrEqual(0)
        expect(spend, name).toBeLessThanOrEqual(timing.phases.child ?? Number.POSITIVE_INFINITY)
      }
    }
  })

  // 34127 (@cto turn60 defect 1): a slow `rev-list --objects` was charged to `witnessFsck` (1501 ms for a 5.27 ms fsck)
  // and the graph walk that actually spent it reported 0. The operation that ran must own its time.
  it("attributes a slow witness graph walk to refGraph, never to the fsck window left open above it", async () => {
    // @dev/5 saw this test flake once at host load 45: the absolute `fsck < delay` bound is the load-sensitive half. The
    // delay is 800 ms so a real fsck on these tiny stores (~5-20 ms, ~30 ms under contention) cannot reach it.
    const graphDelayMs = 800
    const slowGraph: GitStreamFactory = (args, streamOptions = {}) => {
      const inner = defaultGitStream(args, streamOptions)
      if (!(args.includes("rev-list") && args.includes("--objects"))) return inner
      return {
        lines: (async function* () {
          await new Promise((resolve) => setTimeout(resolve, graphDelayMs))
          yield* inner.lines
        })(),
        outcome: inner.outcome,
      }
    }
    // The witness walk only runs for an entry holding at-risk objects, so one owned blob is written into the shared
    // submodule store before its checkout is retained: the copy carries an object no ref reaches, and the surviving
    // store is a witness that already holds it.
    const worktree = join(fixtureRoot, "graph-witness")
    const before = new Set(readdirSync(root))
    expect(await runCli(["--repo", dirname(common), "worktree", "add", worktree, "HEAD"], sink(), sink())).toBe(0)
    const submodule = join(worktree, "vendor", "dep")
    execFileSync("git", ["-C", submodule, "hash-object", "-w", "--stdin"], {
      env: environment,
      input: "owned by no ref\n",
    })
    expect(
      await runCli(["--repo", dirname(common), "worktree", "remove", worktree, "--retain", root], sink(), sink()),
    ).toBe(0)
    const name = readdirSync(root).find((candidate) => !before.has(candidate)) as string
    const entry = join(root, name)
    const manifest = JSON.parse(readFileSync(join(entry, "manifest.json"), "utf8")) as { retainUntil: string }
    const result = await retireRetainedBatch(
      options({
        entries: [entry],
        proofDeadlineMs: 600_000,
        gitStream: slowGraph,
        clock: new Date(Date.parse(manifest.retainUntil) + 1000),
      }),
    )
    expect(result.stopped).toBeUndefined()
    const refGraph = result.proofPhases?.refGraph
    expect(refGraph, JSON.stringify({ phases: result.proofPhases, rows: result.rows })).toBeDefined()
    expect(refGraph ?? 0).toBeGreaterThanOrEqual(graphDelayMs)
    const timing = result.preliminaryEntryTimings?.[entry]
    expect(timing, entry).toBeDefined()
    const spent = timing?.subphases?.refGraph
    expect(spent).toBeDefined()
    expect(spent ?? 0).toBeGreaterThanOrEqual(graphDelayMs)
    // The fsck figure is reported, and it is the operation's own: the defect was `refGraph = 0` beside a `witnessFsck`
    // that had swallowed the graph's time, and the assertion above is what fails on it. No relative `fsck < graph` bound
    // is asserted: the anc24 sample measured fsck 17 045 ms against refGraph 9 816 ms on the real store, so fsck
    // legitimately exceeds the graph spend and such a bound would only flake under load.
    expect(timing?.subphases?.witnessFsck).toBeDefined()
    expect(timing?.subphases?.witnessFsck ?? 0).toBeGreaterThanOrEqual(0)
    // Every nested operation the walk names keeps its own number; the certificate stage is the one that would silently
    // lose its spend if only fsck and the graph were wired to the entry record.
    expect(timing?.subphases?.witnessCertificates).toBeDefined()
    expect(timing?.subphases?.witnessCertificates ?? 0).toBeLessThanOrEqual(timing?.phases.child ?? 0)
  })

  // #35047 (@dev/review2 REVISE bf2e0b30): the deadline cuts a custody walk already running only if the batch hands it
  // to every verifier call. The spent-deadline rows above are decided by the batch loop and pass without that wire.
  // 37792 (@cto c1f3a921): the preliminary pass hands each not-yet-started entry a fair share of what is left, so the
  // preliminary deadlines differ; every share and the held pass stay inside the one batch deadline.
  it("hands the batch deadline to the held pass and a fair share of it to each preliminary entry", async () => {
    const inspect = vi.mocked(inspectRetainedEntryInBatch)
    inspect.mockClear()
    // 34127 (@cto turn58): the batch deadline is expressed in the monotonic clock it measures entries with.
    const started = performance.now()
    const result = await retireRetainedBatch(options({ apply: true, proofDeadlineMs: 600_000 }))
    const finished = performance.now()
    expect(
      result.rows.map((row) => row.outcome),
      JSON.stringify(result.rows),
    ).toEqual(["retired", "retired", "retired"])
    const calls = inspect.mock.calls.map(([verify]) => ({
      phase: basename(verify.artifactDir as string),
      deadline: verify.deadline,
    }))
    expect(calls.map((call) => call.phase).sort()).toEqual(["held", "held", "held", "pre", "pre", "pre"])
    const held = calls.filter((call) => call.phase === "held").map((call) => call.deadline as number)
    const preliminary = calls.filter((call) => call.phase === "pre").map((call) => call.deadline as number)
    expect(new Set(held).size).toBe(1)
    const batchDeadline = held[0] as number
    expect(batchDeadline).toBeGreaterThanOrEqual(started + 600_000)
    expect(batchDeadline).toBeLessThanOrEqual(finished + 600_000)
    // Each entry takes an equal part of what is left when it starts, so a share it does not use returns to the pool and
    // the slices never shrink below the batch deadline's reach: every one sits inside the batch deadline, and a later
    // entry may hold the whole remainder.
    expect(preliminary).toHaveLength(3)
    for (const deadline of preliminary) {
      expect(deadline).toBeGreaterThan(started)
      expect(deadline).toBeLessThanOrEqual(batchDeadline)
    }
    expect(preliminary[0] as number).toBeLessThan(preliminary[1] as number)
    expect(preliminary[1] as number).toBeLessThanOrEqual(preliminary[2] as number)
  })

  it("dry run names every candidate it would retire and deletes nothing", async () => {
    const result = await retireRetainedBatch(options())
    expect(result.apply).toBe(false)
    expect(result.stopped).toBeUndefined()
    expect(result.owners).toMatchObject({ leaseMissing: 0, unproved: 0 })
    expect(result.rows.map((row) => row.outcome)).toEqual(["would-retire", "would-retire", "would-retire"])
    expect(readdirSync(root)).toHaveLength(3)
    expect(result.windows).toEqual([])
    // #34960: a run with no unproved or unleased owner still writes both lists, empty, and names them.
    expect(readFileSync(result.owners!.unprovedList, "utf8")).toBe("")
    expect(readFileSync(result.owners!.leaseMissingList, "utf8")).toBe("")
    expect(dirname(result.owners!.unprovedList)).toBe(join(fixtureRoot, "artifacts", "owners"))
  })

  // Accepted requirement (#34960, @chief 2a1b5761): the 2026-11-18 production dry run stopped on 221 unproved owners
  // and 2,104 unleased ones but named one of each, so nobody could resolve them owner by owner. The existing tests
  // check the counts, never that every owner behind them is written out.
  // Amended by #34127 (@chief 2026-11-21 14:20): an unproved owner is REPORTED AND SKIPPED, never a batch stop, so the
  // run continues with the proved entries; the listing this requirement asked for stays exactly as it was.
  it("a dry run writes every unproved and every unleased owner and no longer stops on an unproved one", async () => {
    const unproved: string[] = []
    const unleased: string[] = []
    for (const suffix of ["a", "b"]) {
      // A clone with no writer lease is a live owner the batch cannot lease; its alternates name a lender store that
      // is not any repository's own `objects`, which is an object directory with no proved Git owner.
      const store = join(fixtureRoot, `store-${suffix}`)
      mkdirSync(join(store, "pack"), { recursive: true })
      mkdirSync(join(store, "info"), { recursive: true })
      const clone = join(fixtureRoot, `owner-list-${suffix}`)
      mkdirSync(clone, { recursive: true })
      git(clone, ["init", "-q", "-b", "main"])
      writeFileSync(join(clone, ".git", "objects", "info", "alternates"), `${store}\n`)
      unproved.push(store)
      unleased.push(join(clone, ".git"))
    }

    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    let result: Awaited<ReturnType<typeof retireRetainedBatch>>
    try {
      result = await retireRetainedBatch(options())
      // The loud report stays part of the contract: one line naming the count and both lists.
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("2 object director(ies) have no proved Git owner"))
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("identity-unknown-entries.txt"))
    } finally {
      warning.mockRestore()
    }
    // No selected entry borrows from store-a or store-b, so nothing is kept for it and the batch carries on.
    expect(result.stopped).toBeUndefined()
    expect(result.rows.map((row) => row.outcome)).toEqual(["would-retire", "would-retire", "would-retire"])
    expect(result.owners?.unproved).toBe(2)
    expect(result.owners?.identityUnknownEntries).toBe(0)
    expect(readFileSync(result.owners!.unprovedList, "utf8")).toBe(`${unproved.sort().join("\n")}\n`)
    expect(readFileSync(result.owners!.identityUnknownList, "utf8")).toBe("")
    expect(result.owners?.identityUnknownBytes).toBe(
      allocatedBytes(unproved[0] as string) + allocatedBytes(unproved[1] as string),
    )
    const listed = readFileSync(result.owners!.leaseMissingList, "utf8").trimEnd().split("\n")
    expect(listed).toHaveLength(result.owners!.leaseMissing)
    expect(listed).toEqual([...listed].sort())
    expect(listed).toEqual(expect.arrayContaining(unleased))
    expect(readdirSync(root)).toHaveLength(3)
  })

  // @chief 2026-11-21 14:20 (on #34127): an unproved owner keeps the entries that borrow from it, names them, reports
  // its path and bytes, and the batch still reclaims the proved ones — instead of exiting 2 with 0 B reclaimed. The
  // never-delete half is proved by the borrowing entry still being on disk after an apply.
  it("an unproved owner keeps its borrowers and is never deleted, while the proved entries retire", async () => {
    // A real object store that is not any repository's own `objects`: the production shape of an unproved owner
    // (fixture `store-a`/`store-b` above are the same shape, named by a clone that is not a batch entry).
    const store = join(fixtureRoot, "store-x")
    mkdirSync(join(store, "pack"), { recursive: true })
    mkdirSync(join(store, "info"), { recursive: true })
    const borrower = join(root, readdirSync(root).sort()[0] as string)
    const alternates = join(borrower, "modules", "vendor", "dep", "objects", "info", "alternates")
    const declared = existsSync(alternates) ? readFileSync(alternates, "utf8") : ""
    writeFileSync(alternates, `${declared}${declared === "" || declared.endsWith("\n") ? "" : "\n"}${store}\n`)

    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    let dry: Awaited<ReturnType<typeof retireRetainedBatch>>
    let applied: Awaited<ReturnType<typeof retireRetainedBatch>>
    try {
      dry = await retireRetainedBatch(options())
      applied = await retireRetainedBatch(options({ apply: true }))
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("1 object director(ies) have no proved Git owner"))
    } finally {
      warning.mockRestore()
    }
    expect(dry.stopped).toBeUndefined()
    expect(dry.rows.find((row) => row.entry === borrower)?.outcome).toBe("kept")
    expect(dry.rows.find((row) => row.entry === borrower)?.reason).toContain("identity-unknown")
    expect(dry.rows.find((row) => row.entry === borrower)?.reason).toContain(store)
    expect(
      dry.rows.filter((row) => row.entry !== borrower).map((row) => row.outcome),
      JSON.stringify(dry.rows),
    ).toEqual(["would-retire", "would-retire"])
    expect(dry.owners?.identityUnknownEntries).toBe(1)
    expect(readFileSync(dry.owners!.identityUnknownList, "utf8")).toBe(borrower + "\t" + store + "\n")
    expect(readFileSync(dry.owners!.unprovedList, "utf8")).toBe(store + "\n")
    expect(dry.owners?.identityUnknownBytes).toBe(allocatedBytes(store))

    expect(applied.stopped).toBeUndefined()
    expect(applied.rows.find((row) => row.entry === borrower)?.outcome).toBe("kept")
    expect(readdirSync(root)).toEqual([basename(borrower)])
    expect(existsSync(join(store, "pack"))).toBe(true)
  })

  // Accepted requirement (#34920, @cto 34920-ranking-and-bare-r2 §2): a retained store whose config still names
  // its removed checkout (production: "../../../../../../var/wt/<env>/ag") is read as a detached store by every
  // gate, so the batch retires it instead of refusing at candidate contents on "cannot chdir". The existing
  // tests miss it because the fixture's module stores record no core.worktree.
  it.each([false, true])(
    "retires a store whose core.worktree names its removed checkout through every gate (apply %s)",
    async (apply) => {
      const checkout = join(fixtureRoot, "worktree-recorded")
      const previous = readdirSync(root).map((name) => join(root, name))
      expect(await runCli(["--repo", dirname(common), "worktree", "add", checkout, "HEAD"], sink(), sink())).toBe(0)
      const store = join(common, "worktrees", "worktree-recorded", "modules", "vendor", "dep")
      expect(existsSync(join(store, "config")), `module store at ${store}`).toBe(true)
      // Recorded before retention, as git records it for a live checkout: relative to the store, through
      // directories the removal deletes.
      git(fixtureRoot, [
        "config",
        "--file",
        join(store, "config"),
        "core.worktree",
        relative(store, join(checkout, "vendor", "dep")),
      ])
      expect(
        await runCli(["--repo", dirname(common), "worktree", "remove", checkout, "--retain", root], sink(), sink()),
      ).toBe(0)
      const entry = readdirSync(root)
        .map((name) => join(root, name))
        .find((candidate) => !previous.includes(candidate)) as string
      expect(readFileSync(join(entry, "modules", "vendor", "dep", "config"), "utf8")).toContain("worktree = ")
      const manifest = JSON.parse(readFileSync(join(entry, "manifest.json"), "utf8")) as { retainUntil: string }
      const result = await retireRetainedBatch(
        options({ entries: [entry], apply, clock: new Date(Date.parse(manifest.retainUntil) + 1000) }),
      )
      expect(JSON.stringify(result)).not.toContain("cannot chdir")
      expect(result.stopped, JSON.stringify(result.rows)).toBeUndefined()
      expect(
        result.rows.map((row) => row.outcome),
        JSON.stringify(result.rows),
      ).toEqual([apply ? "retired" : "would-retire"])
    },
  )

  it("apply retires every candidate in one measured lease window after an unchanged delta", async () => {
    const result = await retireRetainedBatch(options({ apply: true }))
    expect(result.stopped).toBeUndefined()
    expect(result.rows.map((row) => row.outcome)).toEqual(["retired", "retired", "retired"])
    expect(readdirSync(root)).toEqual([])
    expect(result.windows).toHaveLength(1)
    expect(result.windows[0]).toMatchObject({ delta: "unchanged" })
    expect(result.windows[0]?.holdMs).toBeGreaterThanOrEqual(result.windows[0]?.deltaMs ?? 0)
  })

  /**
   * Retained entries whose own module store holds a commit no other store has, each pushed to its own branch of the
   * dependency repository so a surviving ref witnesses it. Returns the new entries, their branches and the last
   * entry's new blob, which the dependency repository keeps as a loose object.
   */
  async function atRiskEntries(
    names: readonly string[],
  ): Promise<{ entries: string[]; branches: string[]; blob: string }> {
    const product = dirname(common)
    const dependency = join(fixtureRoot, "dependency")
    const entries: string[] = []
    const branches: string[] = []
    let blob = ""
    for (const name of names) {
      const worktree = join(fixtureRoot, name)
      expect(await runCli(["--repo", product, "worktree", "add", worktree, "HEAD"], sink(), sink())).toBe(0)
      const dep = join(worktree, "vendor", "dep")
      writeFileSync(join(dep, `${name}.ts`), `export const value = "${name}"\n`)
      git(dep, ["add", "."])
      git(dep, ["commit", "-q", "-m", name])
      const branch = `keep-${name}`
      git(dep, ["push", "-q", dependency, `HEAD:refs/heads/${branch}`])
      branches.push(branch)
      blob = git(dependency, ["rev-parse", `${branch}:${name}.ts`])
      const before = new Set(readdirSync(root))
      expect(
        await runCli(["--repo", product, "--json", "worktree", "remove", worktree, "--retain", root], sink(), sink()),
      ).toBe(0)
      const made = readdirSync(root).filter((entry) => !before.has(entry))
      expect(made).toHaveLength(1)
      entries.push(join(root, made[0] as string))
    }
    return { entries, branches, blob }
  }

  // AC #35062 (@cto 35047-existing-scope-0158 §1-2): members of one proof phase share one witness index, and the held
  // window joins one built from fresh reads, never the preliminary one. A witness branch deleted, or a witness store
  // whose fsck now fails, between the two passes keeps the affected entries; with no change every member retires.
  // The existing apply rows hold no at-risk objects, so custody never builds an index there and stale reuse of the
  // preliminary index into the held window would pass all of them.
  it.each(["unchanged", "witness deleted", "witness store corrupt"])(
    "members with at-risk objects share one index per phase and the held window's is fresh (%s)",
    async (change) => {
      const dependency = join(fixtureRoot, "dependency")
      const { entries, branches, blob } = await atRiskEntries(["risk-a", "risk-b"])
      const [riskA, riskB] = entries as [string, string]
      const loose = join(dependency, ".git", "objects", blob.slice(0, 2), blob.slice(2))
      expect(existsSync(loose)).toBe(true)
      const looseBytes = readFileSync(loose)
      // The fixture clock predates these entries; move it past their own retainUntil.
      const retainUntil = entries.map((entry) =>
        Date.parse(
          (JSON.parse(readFileSync(join(entry, "manifest.json"), "utf8")) as { retainUntil: string }).retainUntil,
        ),
      )
      const spy = vi.mocked(inspectRetainedEntryInBatch)
      spy.mockClear()
      try {
        const result = await retireRetainedBatch(
          options({
            apply: true,
            clock: new Date(Math.max(eligible.getTime(), ...retainUntil) + 1000),
            afterScan: () => {
              if (change === "witness deleted") git(dependency, ["branch", "-q", "-D", branches[1] as string])
              if (change === "witness store corrupt") rmSync(loose)
            },
          }),
        )
        const calls = spy.mock.calls.map((call, at) => ({ call, result: spy.mock.results[at] }))
        const pre = calls.filter(({ call }) => call[0].artifactDir?.endsWith("/pre") === true)
        const held = calls.filter(({ call }) => call[0].artifactDir?.endsWith("/held") === true)
        expect(pre).toHaveLength(5)
        // Positive control: both new members reached custody and found their own branch in the preliminary pass.
        for (const [entry, branch] of [
          [riskA, branches[0]],
          [riskB, branches[1]],
        ] as const) {
          const found = pre.find(({ call }) => call[0].entry === entry)
          const proof = (await found?.result?.value) as Awaited<ReturnType<typeof inspectRetainedEntryInBatch>>
          expect(proof.verdict, proof.reasons.join("; ")).toBe("candidate")
          expect(proof.witnesses).toEqual(
            expect.arrayContaining([expect.objectContaining({ ref: `refs/heads/${branch}` })]),
          )
        }
        const outcome = (entry: string): string | undefined => result.rows.find((row) => row.entry === entry)?.outcome
        if (change === "unchanged") {
          expect(result.rows.map((row) => row.outcome)).toEqual(result.rows.map(() => "retired"))
          expect(readdirSync(root)).toEqual([])
        } else if (change === "witness deleted") {
          expect(outcome(riskA)).toBe("retired")
          expect(outcome(riskB)).toBe("kept")
          expect(result.rows.find((row) => row.entry === riskB)?.reason).toContain("preliminary and held proofs differ")
          expect(existsSync(riskB)).toBe(true)
        } else {
          expect(outcome(riskA)).toBe("kept")
          expect(outcome(riskB)).toBe("kept")
          expect(existsSync(riskA)).toBe(true)
          expect(existsSync(riskB)).toBe(true)
        }
        // Every preliminary member got one scope, every held member a second, fresh one.
        expect(new Set(pre.map(({ call }) => call[3])).size).toBe(1)
        expect(pre[0]?.call[3]).toBeDefined()
        expect(new Set(held.map(({ call }) => call[3])).size).toBe(1)
        expect(held[0]?.call[3]).toBeDefined()
        expect(held[0]?.call[3]).not.toBe(pre[0]?.call[3])
      } finally {
        if (!existsSync(loose)) writeFileSync(loose, looseBytes)
        for (const branch of branches) {
          if (git(dependency, ["branch", "--list", branch]) !== "") git(dependency, ["branch", "-q", "-D", branch])
        }
      }
    },
    180_000,
  )

  // AC #35062 (@cto 35062-vanished-witness-go-0445): custody now drops a witness store that is gone by ENOENT, but the
  // held phase is unchanged. A witness store outside every entry that existed at the scan and is removed before the
  // lease window still ends the batch through the estate delta, and nothing is deleted.
  it("a witness store removed after the scan still ends the batch at the held estate delta", async () => {
    const dependency = join(fixtureRoot, "dependency")
    const { entries, branches } = await atRiskEntries(["risk-c"])
    const spare = join(fixtureRoot, "spare-witness")
    git(fixtureRoot, ["clone", "-q", "--no-local", dependency, spare])
    const spareStore = join(spare, ".git", "objects")
    const retainUntil = entries.map((entry) =>
      Date.parse(
        (JSON.parse(readFileSync(join(entry, "manifest.json"), "utf8")) as { retainUntil: string }).retainUntil,
      ),
    )
    try {
      const result = await retireRetainedBatch(
        options({
          apply: true,
          clock: new Date(Math.max(eligible.getTime(), ...retainUntil) + 1000),
          afterScan: () => rmSync(spare, { recursive: true, force: true }),
        }),
      )
      expect(result.stopped).toContain("census-shifted")
      expect(result.stopped).toContain("vanished")
      expect(result.stopped).toContain("spare-witness")
      expect(
        result.rows.every((row) => row.outcome === "kept"),
        JSON.stringify(result.rows),
      ).toBe(true)
      for (const entry of entries) expect(existsSync(entry)).toBe(true)
      expect(existsSync(spareStore)).toBe(false)
    } finally {
      rmSync(spare, { recursive: true, force: true })
      for (const branch of branches) {
        if (git(dependency, ["branch", "--list", branch]) !== "") git(dependency, ["branch", "-q", "-D", branch])
      }
    }
  }, 180_000)

  // Accepted requirement: a bounded lease ends with named remaining entries; the old multi-window loop
  // mistakes its own first deletion for an outsider's estate change when it reuses the original scan.
  it("ends after one lease window when the budget expires, naming the remaining entries", async () => {
    const input = options()
    const first = input.entries[0] as string
    const result = await retireRetainedBatch({
      ...input,
      apply: true,
      holdBudgetMs: 100,
      monotonic: () => (existsSync(first) ? 0 : 1000),
    })
    expect(result.rows.map((row) => row.outcome)).toEqual(["retired", "kept", "kept"])
    expect(result.windows).toHaveLength(1)
    expect(result.stopped).toContain("lease budget")
    expect(result.stopped).not.toContain("census-shifted")
    expect(result.rows.slice(1).every((row) => row.reason.includes("lease budget"))).toBe(true)
  })

  // CTO d35ae483: a killed/failed recursive deletion must leave an incomplete entry excluded by the next
  // census. Existing failure tests concern proof/pointer cleanup, not interruption with store files remaining.
  it("removes the manifest before bulk deletion so an interrupted remainder cannot be selected again", async () => {
    const input = options({ apply: true })
    const first = input.entries[0] as string
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs")
    const original = fs.rmSync
    const removal = vi.mocked(rmSync).mockImplementation((path, opts) => {
      if (String(path) === first && opts?.recursive) {
        original(join(first, "modules", "vendor", "dep", "objects"), { recursive: true })
        throw new Error("fixture interruption during bulk removal")
      }
      return original(path, opts)
    })
    try {
      const result = await retireRetainedBatch(input)
      expect(result.rows.map((row) => row.outcome)).toEqual(["failed", "kept", "kept"])
      expect(result.stopped).toContain("retirement-partial")
      expect(existsSync(join(first, "modules"))).toBe(true)
      expect(existsSync(join(first, "modules", "vendor", "dep", "objects"))).toBe(false)
      expect(existsSync(join(first, "manifest.json"))).toBe(false)
    } finally {
      removal.mockImplementation(original)
    }
  })

  // @cto dc77f630 condition 3: a writer that takes no lease (a hand-run clone) is caught by the delta, not the lease.
  it("an alternates file written between scan and delta by a writer with no lease ends the batch with nothing deleted", async () => {
    const lender = join(common, "modules", "vendor", "dep", "objects")
    const result = await retireRetainedBatch(
      options({
        apply: true,
        afterScan: () => {
          const objects = join(fixtureRoot, "hand-clone", ".git", "objects")
          mkdirSync(join(objects, "info"), { recursive: true })
          mkdirSync(join(objects, "pack"), { recursive: true })
          writeFileSync(join(objects, "info", "alternates"), `${lender}\n`)
        },
      }),
    )
    expect(result.stopped).toContain("census-shifted")
    expect(result.stopped).toContain(join(fixtureRoot, "hand-clone"))
    expect(result.rows.map((row) => row.outcome)).toEqual(["kept", "kept", "kept"])
    expect(readdirSync(root)).toHaveLength(3)
    expect(result.windows).toEqual([expect.objectContaining({ entries: [], delta: "changed" })])
  })

  // @cto 2026-11-14 (34127 REVISE): the shape a churning worktree leaves mid-scan. A recorded store that is GONE by
  // the time the lease window opens is caught by the estate delta, not by the owner pass — so any future rule that
  // admits absence has to relax THIS stop, not just the identity-unknown one. Characterization: the stop is the
  // expected behaviour and this test must fail loudly if a change quietly admits it.
  it("a recorded store removed between the scan and the lease window ends the batch, named by the estate delta", async () => {
    // Inside an entry, so the owner pass skips it (entries are the deletion set, not lease owners) and the DELTA is
    // the first gate that can see it go. This is the gate a future "admit absence" rule would have to relax.
    const [first] = readdirSync(root).sort() as [string]
    const vanishing = join(root, first, "modules", "vendor", "vanishing", "objects")
    mkdirSync(join(vanishing, "info"), { recursive: true })
    mkdirSync(join(vanishing, "pack"), { recursive: true })
    const result = await retireRetainedBatch(
      options({ apply: true, afterScan: () => rmSync(vanishing, { recursive: true, force: true }) }),
    )
    expect(result.stopped).toContain("census-shifted")
    expect(result.stopped).toContain(`object directory ${vanishing} vanished`)
    expect(result.stopped).not.toContain("identity-unknown")
    expect(
      result.rows.every((row) => row.outcome === "kept"),
      JSON.stringify(result.rows),
    ).toBe(true)
    expect(readdirSync(root)).toHaveLength(3)
    expect(result.windows).toEqual([expect.objectContaining({ entries: [], delta: "changed" })])
  })

  // @cto 2026-11-14 (34127): the undirected walk that used to keep every alternates-connected store is gone. A live
  // owner with no lease protects the stores it BORROWS FROM (survivorIntoRemoval / entryView), never a sibling that
  // merely borrows from the same common store: alternates is borrower -> lender, one direction only. Amends
  // @cto 76cc52e6, whose guard was kept for the lender case and deleted for the sibling case (see the next test).
  it("a live owner with no lease does not keep a sibling borrower of the same common store", async () => {
    const lock = join(common, "modules", "vendor", "dep", "yrd-worktree-mutations", "writer.lock")
    const keptAside = `${lock}.moved`
    cpSync(lock, keptAside)
    rmSync(lock)
    try {
      const dry = await retireRetainedBatch(options())
      expect(dry.owners?.liveUnleased).toBe(1)
      expect(dry.stopped).toBeUndefined()
      expect(
        dry.rows.map((row) => row.outcome),
        JSON.stringify(dry.rows),
      ).toEqual(["would-retire", "would-retire", "would-retire"])
      const applied = await retireRetainedBatch(options({ apply: true }))
      expect(applied.stopped).toBeUndefined()
      expect(applied.rows.map((row) => row.outcome)).toEqual(["retired", "retired", "retired"])
      expect(readdirSync(root)).toHaveLength(0)
    } finally {
      cpSync(keptAside, lock)
      rmSync(keptAside)
    }
  })

  // The control the deletion above must not lose: a live owner with no lease that BORROWS FROM a candidate keeps it,
  // through the directed survivor check rather than any traversal of the store graph.
  it("a live owner with no lease keeps the entry it borrows from, named as a survivor", async () => {
    const [candidate] = readdirSync(root).sort() as [string]
    const entry = join(root, candidate)
    const borrower = join(fixtureRoot, "live-borrower", ".git")
    mkdirSync(join(borrower, "objects", "info"), { recursive: true })
    mkdirSync(join(borrower, "objects", "pack"), { recursive: true })
    writeFileSync(
      join(borrower, "objects", "info", "alternates"),
      `${join(entry, "modules", "vendor", "dep", "objects")}\n`,
    )
    try {
      const result = await retireRetainedBatch({ ...options({ apply: true }), entries: [entry] })
      const row = result.rows.find((candidate) => candidate.entry === entry)
      expect(row?.outcome, JSON.stringify(result.rows)).toBe("kept")
      expect(row?.reason).toContain("survivor borrower(s) into")
      expect(readdirSync(root)).toHaveLength(3)
      expect(result.owners?.liveUnleased).toBeGreaterThan(0)
    } finally {
      rmSync(join(fixtureRoot, "live-borrower"), { recursive: true, force: true })
    }
  })

  // @cto 76cc52e6: an owner inside a retained store whose env is closed (its manifest path is gone) cannot write,
  // so it needs no lease; the delta covers it. The third store stays out of the batch, so its module gitdirs are
  // outside owners with no writer.lock (the fixture only creates leases outside the root).
  it("owners inside a retained store of a closed env need no lease", async () => {
    const names = readdirSync(root).sort()
    const entries = names.slice(0, 2).map((name) => join(root, name))
    const result = await retireRetainedBatch({ ...options({ apply: true }), entries })
    expect(result.stopped).toBeUndefined()
    expect(result.owners?.cold).toBeGreaterThan(0)
    expect(result.owners?.liveUnleased).toBe(0)
    expect(result.rows.map((row) => row.outcome)).toEqual(["retired", "retired"])
    expect(readdirSync(root)).toEqual(names.slice(2))
  })

  // A present worktree keeps the owner live. A path under a regular file cannot exist, so ENOTDIR is absence proof
  // like ENOENT (#34920): historical namespace ancestors such as hh-dev%23main are now retirement-receipt files.
  it.each(["directory", "ancestor-file"])("a retained-store owner's absence proof (%s)", async (kind) => {
    const names = readdirSync(root).sort()
    const entries = names.slice(0, 2).map((name) => join(root, name))
    const manifest = JSON.parse(readFileSync(join(root, names[2] as string, "manifest.json"), "utf8")) as {
      path: string
    }
    rmSync(join(root, names[2] as string, "modules", "vendor", "dep", "yrd-worktree-mutations", "writer.lock"))
    const ancestor = join(fixtureRoot, "blocked-owner-parent")
    if (kind === "ancestor-file") {
      cpSync(
        join(root, names[2] as string, "modules", "vendor", "dep"),
        join(root, names[2] as string, "modules", "vendor", "other"),
        { recursive: true },
      )
      writeFileSync(ancestor, "not a directory\n")
      manifest.path = join(ancestor, "old-worktree")
      writeFileSync(join(root, names[2] as string, "manifest.json"), JSON.stringify(manifest))
    } else mkdirSync(manifest.path, { recursive: true })
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      const result = await retireRetainedBatch({ ...options(), entries })
      expect(result.owners?.coldProofFailedOwners).toEqual([])
      expect(result.owners?.coldProofFailed).toBe(0)
      if (kind === "ancestor-file") {
        expect(warning).not.toHaveBeenCalledWith(expect.stringContaining("ENOTDIR"))
        expect(result.owners?.liveUnleased).toBe(0)
        expect(result.rows.map((row) => row.outcome)).toEqual(["would-retire", "would-retire"])
      } else {
        expect(result.owners?.liveUnleased).toBeGreaterThan(0)
      }
    } finally {
      warning.mockRestore()
      rmSync(kind === "ancestor-file" ? ancestor : manifest.path, { recursive: true, force: true })
    }
  })

  it("an unrelated live owner with no lease does not stop retirement", async () => {
    const unrelated = join(fixtureRoot, "unrelated")
    mkdirSync(unrelated)
    git(unrelated, ["init", "-q"])
    git(unrelated, [
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-q",
      "-m",
      "unrelated",
    ])
    const result = await retireRetainedBatch(options({ apply: true }))
    expect(result.owners?.liveUnleased).toBe(1)
    expect(result.stopped).toBeUndefined()
    expect(
      result.rows.map((row) => row.outcome),
      JSON.stringify(result.rows),
    ).toEqual(["retired", "retired", "retired"])
  })

  /** Point the third store's manifest under a regular file and drop its lease, so only cold proof can clear it. */
  function strandThirdStore(): { entries: string[]; ancestor: string; worktree: string } {
    const names = readdirSync(root).sort()
    const third = join(root, names[2] as string)
    const manifest = JSON.parse(readFileSync(join(third, "manifest.json"), "utf8")) as { path: string }
    rmSync(join(third, "modules", "vendor", "dep", "yrd-worktree-mutations", "writer.lock"))
    const ancestor = join(fixtureRoot, "blocked-owner-parent")
    writeFileSync(ancestor, "not a directory\n")
    manifest.path = join(ancestor, "old-worktree")
    writeFileSync(join(third, "manifest.json"), JSON.stringify(manifest))
    return { entries: names.slice(0, 2).map((name) => join(root, name)), ancestor, worktree: manifest.path }
  }

  // @cto 34920-retention-calls-r1 item 1: ENOTDIR is absence at discovery AND at the held recheck. An ancestor that
  // becomes a directory proves nothing by itself; only the recorded worktree reappearing ends the batch.
  it.each(["absent", "ancestor-dir", "revived"])(
    "rechecks a worktree recorded under a non-directory before deletion (%s)",
    async (mode) => {
      const { entries, ancestor, worktree } = strandThirdStore()
      try {
        const result = await retireRetainedBatch({
          ...options({
            apply: true,
            afterScan: () => {
              if (mode === "absent") return
              rmSync(ancestor)
              mkdirSync(mode === "revived" ? worktree : ancestor, { recursive: true })
            },
          }),
          entries,
        })
        expect(result.owners?.coldProofFailed).toBe(0)
        expect(result.owners?.liveUnleased).toBe(0)
        if (mode === "revived") {
          expect(result.stopped, JSON.stringify(result.rows)).toContain(`absent worktree ${worktree}`)
          expect(result.rows.every((row) => row.outcome === "kept")).toBe(true)
          expect(readdirSync(root)).toHaveLength(3)
        } else {
          expect(result.stopped, JSON.stringify(result.rows)).toBeUndefined()
          expect(result.rows.map((row) => row.outcome)).toEqual(["retired", "retired"])
          expect(readdirSync(root)).toHaveLength(1)
        }
      } finally {
        rmSync(ancestor, { recursive: true, force: true })
      }
    },
  )

  // @cto 34920-retention-calls-r1 item 2: unreadable cold evidence (here a malformed manifest) is incomplete owner
  // evidence. The dry run still reports but stops, apply deletes nothing, and the CLI exits 2 for both.
  it.each([false, true])("unreadable cold evidence stops the batch before any deletion (apply=%s)", async (apply) => {
    const names = readdirSync(root).sort()
    const third = join(root, names[2] as string)
    rmSync(join(third, "modules", "vendor", "dep", "yrd-worktree-mutations", "writer.lock"))
    writeFileSync(join(third, "manifest.json"), "{ not json")
    const entries = names.slice(0, 2).map((name) => join(root, name))
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    let output = ""
    try {
      // Library at an eligible clock: the stop alone decides, every other gate passes.
      const direct = await retireRetainedBatch({ ...options({ apply }), entries })
      expect(direct.stopped).toContain("@gate/retention-cold-proof: cold-proof-incomplete")
      expect(direct.owners?.coldProofFailed).toBeGreaterThan(0)
      expect(
        direct.rows.map((row) => row.outcome),
        JSON.stringify(direct.rows),
      ).toEqual(apply ? ["kept", "kept"] : ["would-retire", "would-retire"])
      expect(direct.windows).toEqual([])
      expect(readdirSync(root)).toHaveLength(3)
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("stops before any deletion"))
      // CLI at the real clock: the same stop reaches the caller as exit 2 with the full report.
      const code = await runCli(
        [
          "--repo",
          dirname(common),
          "--json",
          "worktree",
          "retention",
          "retire-batch",
          "--root",
          root,
          "--common",
          common,
          "--namespace",
          fixtureRoot,
          "--artifact-dir",
          join(fixtureRoot, "artifacts"),
          ...(apply ? ["--apply"] : []),
          ...entries,
        ],
        {
          write: (value) => {
            output += value
          },
        },
        sink(),
      )
      const report = JSON.parse(output) as RetentionBatchResult
      expect(code, output).toBe(2)
      expect(report.stopped).toContain("@gate/retention-cold-proof: cold-proof-incomplete")
      expect(report.owners?.coldProofFailed).toBeGreaterThan(0)
      expect(report.rows.map((row) => row.entry)).toEqual(entries)
      expect(report.rows.every((row) => row.outcome !== "retired")).toBe(true)
      expect(readdirSync(root)).toHaveLength(3)
    } finally {
      warning.mockRestore()
    }
  })

  // Accepted requirement: a linked-worktree owner is cold only while its recorded worktree is absent; the
  // ordinary estate delta cannot see a re-created empty worktree (no objects), so this needs its own regression.
  it.each([false, true])("rechecks an absent linked worktree before deletion (revived=%s)", async (revived) => {
    const owner = join(common, "worktrees", "cold-owner")
    mkdirSync(owner, { recursive: true })
    git(owner, ["init", "--bare", "-q"])
    git(owner, ["fetch", "-q", join(fixtureRoot, "dependency"), "main:refs/heads/main"])
    git(owner, ["symbolic-ref", "HEAD", "refs/heads/main"])
    const worktree = join(fixtureRoot, "revived-owner")
    writeFileSync(join(owner, "gitdir"), `${join(worktree, ".git")}\n`)
    const result = await retireRetainedBatch(
      options({
        apply: true,
        afterScan: () => {
          if (revived) mkdirSync(worktree)
        },
      }),
    )
    expect(result.owners?.cold).toBeGreaterThan(0)
    expect(result.owners?.liveUnleased).toBe(0)
    if (revived) {
      expect(result.stopped, JSON.stringify(result.rows)).toContain("cold owner")
      expect(result.rows.every((row) => row.outcome === "kept")).toBe(true)
      expect(readdirSync(root)).toHaveLength(3)
    } else {
      expect(result.stopped).toBeUndefined()
      expect(
        result.rows.map((row) => row.outcome),
        JSON.stringify(result.rows),
      ).toEqual(["retired", "retired", "retired"])
    }
  })

  it("keeps a member that a kept member still borrows from, naming the borrower", async () => {
    const [first, second] = readdirSync(root)
      .sort()
      .map((name) => join(root, name))
    // `first` gains an alternates line into `second`: its bytes no longer match its manifest, so it is kept, and
    // deleting `second` would break it.
    const borrower = join(first as string, "modules", "vendor", "dep", "objects")
    const target = join(second as string, "modules", "vendor", "dep", "objects")
    expect(existsSync(target)).toBe(true)
    writeFileSync(join(borrower, "info", "alternates"), `${target}\n`, { flag: "a" })
    const result = await retireRetainedBatch(options())
    const rows = new Map(result.rows.map((row) => [row.entry, row]))
    expect(rows.get(first as string)?.outcome).toBe("kept")
    expect(rows.get(second as string)?.outcome).toBe("kept")
    expect(rows.get(second as string)?.reason).toContain(`kept batch member ${first} still borrows from it`)
  })
})
