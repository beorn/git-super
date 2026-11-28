/**
 * @failure Chunked retained retirement (#34127, @cto 2026-11-24 chunk ruling) loses the run's real work or stops being
 *   fail-closed: a deadline that arrives mid-sweep discards the entries already proved (the 2026-11-24 nightly firing
 *   discarded 7 of 7), a later run always restarts at the same kept head so the tail is never examined, a proof that
 *   moved before its lease is deleted anyway, or a partial run reads as a failure.
 * @level l2 (real git-super retained entries written by `worktree remove --retain`)
 * @consumer the nightly host-store-cleanup retained arm through yrd's `env retained`
 * @testonly a fake monotonic clock and the afterChunk seam, so "the deadline arrives between two chunks" is a fact of
 *   the test rather than a race; no production path reads either.
 * @reach fs-walk <fixture-only: estate scans visit mkdtempSync(tmpdir()) Git repositories>
 */
import { execFileSync } from "node:child_process"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { tryAcquireFlock } from "@bearly/flock"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { runCli } from "../src/cli.ts"
import { retireRetainedBatchInChunks, type RetentionChunkOptions } from "../src/retention-chunks.ts"
import { scanEstate } from "../src/retention-estate.ts"

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

const sink = (): { write(value: string): void } => ({ write: () => undefined })

let fixtureRoot: string
let root: string
let pristine: string
let common: string
let eligible: Date

beforeAll(async () => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-retention-chunks-"))
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
  // raw-delete-allow: the .retired fixtures this file creates under its own mkdtemp fixture root.
  rmSync(join(fixtureRoot, ".retired"), { recursive: true, force: true })
})

function options(extra: Partial<RetentionChunkOptions> = {}): RetentionChunkOptions {
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
    remoteRedundancy: false,
    apply: true,
    chunkSize: 1,
    ...extra,
  }
}

describe("chunked retained retirement (#34127)", () => {
  it("retires chunk by chunk and finishes on the whole estate, with no remainder", async () => {
    const result = await retireRetainedBatchInChunks(options())
    expect(result.outcome).toBe("complete")
    expect(result.retired).toBe(3)
    expect(result.examined).toBe(3)
    expect(result.total).toBe(3)
    expect(result.nextCursor).toBeNull()
    expect(result.chunks).toHaveLength(3)
    expect(readdirSync(root)).toHaveLength(0)
  }, 120_000)

  // #34127 (@cto b682a7ed): one run ages `.retired` once. Every chunk is a separate batch, so only the first is given the
  // age limit; the run reports that chunk's verdicts, one row per directory.
  it("ages .retired in the first chunk only and reports its rows once", async () => {
    const old = eligible.getTime() - 8 * 24 * 60 * 60 * 1000
    const aged = join(fixtureRoot, ".retired", new Date(old).toISOString().slice(0, 10))
    mkdirSync(join(aged, "logs"), { recursive: true })
    utimesSync(aged, new Date(old), new Date(old))
    const result = await retireRetainedBatchInChunks(options({ retiredMaxAgeMs: 7 * 24 * 60 * 60 * 1000 }))
    expect(result.chunks).toHaveLength(3)
    expect(result.retiredAged).toEqual([expect.objectContaining({ path: aged, outcome: "retired" })])
    expect(result.chunks.slice(1).map((chunk) => chunk.retiredAged)).toEqual([undefined, undefined])
    expect(existsSync(aged)).toBe(false)
  }, 120_000)

  it("a deadline between two chunks keeps what it already retired and names the rest", async () => {
    const clock = { now: 0 }
    const cursorFile = join(fixtureRoot, "cursor.json")
    const result = await retireRetainedBatchInChunks(
      options({
        monotonic: () => clock.now,
        // The run may spend 40 s in total; the first chunk uses little, and the clock jumps between chunks.
        deadlineMs: 40_000,
        cursorFile,
        afterChunk: () => {
          clock.now += 10_000_000
        },
      }),
    )
    expect(result.outcome).toBe("partial")
    // The deadline arrives after the first chunk, and that retirement stands: this is the whole point of the ruling.
    expect(result.retired).toBe(1)
    expect(result.chunks).toHaveLength(1)
    expect(result.rows.filter((row) => row.outcome === "retired")).toHaveLength(1)
    expect(result.stopped).toMatch(/^deadline: 2 of 3 entries not examined/u)
    expect(result.nextCursor).not.toBeNull()
    expect(readdirSync(root)).toHaveLength(2)
    const cursor = JSON.parse(readFileSync(cursorFile, "utf8")) as { lastExamined: string }
    expect(result.nextCursor).toBe(cursor.lastExamined)
  }, 120_000)

  it("the next run begins after the cursor and wraps, so a kept head cannot starve the tail", async () => {
    const cursorFile = join(fixtureRoot, "cursor.json")
    const head = readdirSync(root)
      .sort()
      .map((name) => join(root, name))
    // The cursor left by a run that stopped at the first entry: the next run must begin at the second and wrap.
    writeFileSync(cursorFile, JSON.stringify({ lastExamined: head[0] }) + "\n")
    const next = await retireRetainedBatchInChunks(options({ apply: false, chunkSize: 1, cursorFile }))
    expect(next.rows.map((row) => row.entry)).toEqual([head[1], head[2], head[0]])
    expect(next.outcome).toBe("complete")
    expect(next.nextCursor).toBeNull()
    expect(readdirSync(root), "a dry run deletes nothing").toHaveLength(3)
  }, 120_000)

  /**
   * @failure #33010 (@cto c9e2666a): one census shift ended every remaining chunk, so on a host where yrd-submit
   *          worktrees come and go all night a run retired 0. The shifted chunk is now re-proved ONCE on a fresh scan:
   *          that scan sees the new borrower, keeps the entry it borrows, and the rest retire on their own fresh proofs.
   */
  it("a census shift re-proves its chunk once on a fresh scan, keeping the borrowed entry and retiring the rest", async () => {
    const [first] = readdirSync(root).sort() as [string]
    const result = await retireRetainedBatchInChunks(
      options({
        chunkSize: 2,
        // A writer with no lease opens a borrower of a SELECTED entry between the scan and the held window, which
        // the reference-scoped delta must catch (#33010 @cto 2026-11-25: a new store borrowing nothing selected is
        // churn, and this one borrows an entry this chunk deletes).
        // Written once, after the first scan: the re-proof's fresh scan finds it already there, as a real borrower is.
        afterScan: () => {
          const alternates = join(fixtureRoot, "revived-owner", "objects", "info", "alternates")
          if (existsSync(alternates)) return
          mkdirSync(dirname(alternates), { recursive: true })
          writeFileSync(alternates, `${join(root, first, "modules", "vendor", "dep", "objects")}\n`)
        },
      }),
    )
    expect(result.chunks[0]?.stoppedKind, JSON.stringify(result.chunks.map((chunk) => chunk.stopped))).toBe("shifted")
    expect(result.reproved).toBe(2)
    // The fresh scan sees the revived owner borrowing `first`: kept, and still on disk. The others retire.
    expect(result.rows.find((row) => row.entry === join(root, first))?.outcome, JSON.stringify(result.rows)).toBe(
      "kept",
    )
    expect(
      readdirSync(root),
      JSON.stringify(result.rows.map((row) => [basename(row.entry), row.outcome, row.reason.slice(0, 200)])),
    ).toEqual([first])
    expect(result.retired).toBe(2)
    // Each entry is counted once, its re-proof replacing the row the shift left.
    expect(result.examined).toBe(3)
    expect(new Set(result.rows.map((row) => row.entry)).size).toBe(result.rows.length)
  }, 120_000)

  // A shift is the only stop a chunk re-proves; any other condition (here the common owner's writer lease file is gone,
  // so the window cannot exclude writers) still ends the run before anything is deleted.
  it("a condition stop other than a shift still ends the run", async () => {
    const lock = join(common, "yrd-worktree-mutations", "writer.lock")
    const aside = `${lock}.aside`
    renameSync(lock, aside)
    let result
    try {
      result = await retireRetainedBatchInChunks(options())
    } finally {
      renameSync(aside, lock)
    }
    expect(
      result.chunks.map((chunk) => chunk.stoppedKind),
      JSON.stringify(result.chunks.map((chunk) => chunk.stopped)),
    ).toEqual(["stop"])
    expect(result.stopped).toContain("lease-missing")
    expect(result.retired).toBe(0)
    expect(readdirSync(root)).toHaveLength(3)
  }, 120_000)
})

describe("an outside borrower keeps its lender on the cheap gate (#33010, @cto 5d68de61)", () => {
  /**
   * @failure #33010: the #38246 cheap gate returned before gate 3, so an entry whose heads were all published retired
   *          while an outside store's alternates still named a store inside it, leaving that borrower dangling. Found on
   *          base d8bb979 with a bare objects tree; @cto asked for a real Git directory borrower as well.
   */
  it.each(["a bare objects tree", "a real Git directory"])(
    "a borrower that is %s, present at scan time, keeps the entry it borrows from; the rest retire",
    async (shape) => {
      const [first] = readdirSync(root).sort() as [string]
      const lent = join(root, first, "modules", "vendor", "dep", "objects")
      const owner = join(fixtureRoot, "outside-borrower")
      if (shape === "a real Git directory") {
        git(fixtureRoot, ["init", "-q", owner])
      } else {
        mkdirSync(join(owner, "objects", "pack"), { recursive: true })
      }
      const store = shape === "a real Git directory" ? join(owner, ".git", "objects") : join(owner, "objects")
      mkdirSync(join(store, "info"), { recursive: true })
      writeFileSync(join(store, "info", "alternates"), `${lent}\n`)
      try {
        const result = await retireRetainedBatchInChunks(options({ chunkSize: 3 }))
        const row = result.rows.find((candidate) => candidate.entry === join(root, first))
        expect(row?.outcome, JSON.stringify(result.rows.map((r) => [basename(r.entry), r.outcome, r.reason]))).toBe(
          "kept",
        )
        expect(row?.reason).toContain(store)
        expect(existsSync(lent)).toBe(true)
        expect(readdirSync(root)).toEqual([first])
        expect(result.retired).toBe(2)
      } finally {
        rmSync(owner, { recursive: true, force: true })
      }
    },
    120_000,
  )
})
