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
import { dirname, join } from "node:path"
import { tryAcquireFlock } from "@bearly/flock"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { runCli } from "../src/cli.ts"
import { retireRetainedBatch, type RetentionBatchOptions } from "../src/retention-batch.ts"
import { scanEstate } from "../src/retention-estate.ts"

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
  it("dry run names every candidate it would retire and deletes nothing", async () => {
    const result = await retireRetainedBatch(options())
    expect(result.apply).toBe(false)
    expect(result.stopped).toBeUndefined()
    expect(result.owners).toMatchObject({ leaseMissing: 0, unproved: 0 })
    expect(result.rows.map((row) => row.outcome)).toEqual(["would-retire", "would-retire", "would-retire"])
    expect(readdirSync(root)).toHaveLength(3)
    expect(result.windows).toEqual([])
  })

  it("apply retires every candidate in one measured lease window after an unchanged delta", async () => {
    const result = await retireRetainedBatch(options({ apply: true }))
    expect(result.stopped).toBeUndefined()
    expect(result.rows.map((row) => row.outcome)).toEqual(["retired", "retired", "retired"])
    expect(readdirSync(root)).toEqual([])
    expect(result.windows).toHaveLength(1)
    expect(result.windows[0]).toMatchObject({ delta: "unchanged" })
    expect(result.windows[0]?.holdMs).toBeGreaterThanOrEqual(result.windows[0]?.deltaMs ?? 0)
  })

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

  // @cto 76cc52e6: a live owner with no lease keeps only the stores alternates-connected to it, named; the batch
  // itself is not stopped and unconnected candidates still retire.
  it("a live owner with no lease keeps its alternates-connected entries, named, and retires the rest", async () => {
    const lock = join(common, "modules", "vendor", "dep", "yrd-worktree-mutations", "writer.lock")
    const keptAside = `${lock}.moved`
    cpSync(lock, keptAside)
    rmSync(lock)
    try {
      const dry = await retireRetainedBatch(options())
      expect(dry.owners?.liveUnleased).toBe(1)
      expect(dry.stopped).toBeUndefined()
      expect(dry.rows.every((row) => row.outcome === "kept" && row.reason.includes("no existing writer lease"))).toBe(
        true,
      )
      expect(dry.rows.every((row) => row.reason.includes(join(common, "modules", "vendor", "dep")))).toBe(true)
      const applied = await retireRetainedBatch(options({ apply: true }))
      expect(applied.stopped).toBeUndefined()
      expect(applied.rows.map((row) => row.outcome)).toEqual(["kept", "kept", "kept"])
      expect(readdirSync(root)).toHaveLength(3)
    } finally {
      cpSync(keptAside, lock)
      rmSync(keptAside)
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

  // An unprovable absence must also keep the owner live: historical namespace ancestors can be regular files.
  it.each(["directory", "ancestor-file"])("a retained-store owner without absence proof is live (%s)", async (kind) => {
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
      expect(result.owners?.liveUnleased).toBeGreaterThan(0)
      if (kind === "ancestor-file") {
        expect(warning).toHaveBeenCalledWith(expect.stringContaining("ENOTDIR"))
        const expected = (await scanEstate([fixtureRoot], [])).objectDirs
          .filter((objects) => objects.startsWith(join(root, names[2] as string, "modules") + "/"))
          .map(dirname)
          .sort()
        expect(expected).toHaveLength(2)
        expect(result.owners?.coldProofFailedOwners).toEqual(expected)
        expect(result.owners?.coldProofFailed).toBe(expected.length)
      } else {
        expect(result.owners?.coldProofFailedOwners).toEqual([])
        expect(result.owners?.coldProofFailed).toBe(0)
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
