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
  rmSync(join(fixtureRoot, "unrelated"), { recursive: true, force: true })
  rmSync(join(common, "worktrees", "cold-owner"), { recursive: true, force: true })
  rmSync(join(fixtureRoot, "revived-owner"), { recursive: true, force: true })
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

  it("a retained-store owner whose env path exists again is live, not cold", async () => {
    const names = readdirSync(root).sort()
    const entries = names.slice(0, 2).map((name) => join(root, name))
    const manifest = JSON.parse(readFileSync(join(root, names[2] as string, "manifest.json"), "utf8")) as {
      path: string
    }
    rmSync(join(root, names[2] as string, "modules", "vendor", "dep", "yrd-worktree-mutations", "writer.lock"))
    mkdirSync(manifest.path, { recursive: true })
    try {
      const result = await retireRetainedBatch({ ...options(), entries })
      expect(result.owners?.liveUnleased).toBeGreaterThan(0)
    } finally {
      rmSync(manifest.path, { recursive: true, force: true })
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
