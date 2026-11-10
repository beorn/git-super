/**
 * @failure A retirement batch (#33010, @cto dc77f630) deletes on a stale shared scan: a writer with no lease adds an
 *   alternates file between scan and delete, a kept member still borrows from a deleted one, an owner with no lease
 *   file is skipped instead of keeping the batch, or the dry run deletes.
 * @level l2 (real git-super retained entries written by `worktree remove --retain`)
 * @consumer yrd's one-shot retained-modules drain; git super worktree retention retire-batch
 */
import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { tryAcquireFlock } from "@bearly/flock"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { runCli } from "../src/cli.ts"
import { retireRetainedBatch, type RetentionBatchOptions } from "../src/retention-batch.ts"
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
  for (const objects of scanEstate([fixtureRoot], []).objectDirs) {
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

describe("retention retirement batch (#33010)", () => {
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

  it("an owner with no existing writer lease stops the batch before any lease is taken", async () => {
    const lock = join(common, "modules", "vendor", "dep", "yrd-worktree-mutations", "writer.lock")
    const kept = `${lock}.moved`
    cpSync(lock, kept)
    rmSync(lock)
    try {
      const dry = await retireRetainedBatch(options())
      expect(dry.owners?.leaseMissing).toBe(1)
      expect(dry.stopped).toContain("lease-missing")
      expect(dry.rows.every((row) => row.reason.includes("apply would stop first: lease-missing"))).toBe(true)
      const applied = await retireRetainedBatch(options({ apply: true }))
      expect(applied.rows.map((row) => row.outcome)).toEqual(["kept", "kept", "kept"])
      expect(readdirSync(root)).toHaveLength(3)
    } finally {
      cpSync(kept, lock)
      rmSync(kept)
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
