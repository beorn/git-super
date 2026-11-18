/**
 * @failure `bytesPlanned` understates what a retirement batch asks an operator to delete - counting apparent size,
 * dropping a subtree it could not read, or reporting nothing for a path that vanished - so the number reads as
 * complete when it is not.
 * @level l1
 * @consumer `yrd env retained --retire-expired` dry-run; #34270
 * @testonly none
 */
import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { formatRetainedBytes, measureRetainedBytes, rankRetainedEntries } from "../src/retention-bytes.ts"
import { runCli } from "../src/cli.ts"

const cleanup: string[] = []
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true })
})

function tmp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  cleanup.push(path)
  return path
}

describe("retained bytes (#34270)", async () => {
  test("counts allocated blocks, not apparent size, and does not depend on the worker count", async () => {
    const root = tmp("git-super-retained-bytes-")
    const store = join(root, "store")
    const pack = join(store, "pack")
    mkdirSync(pack, { recursive: true })
    const small = [join(pack, "a.pack"), join(pack, "b.pack")]
    for (const file of small) writeFileSync(file, "x")
    const paths = [root, store, pack, ...small]

    // `du` semantics: the two one-byte files occupy a block each, which apparent sizes would report as two bytes.
    const allocated = paths.reduce((total, path) => total + statSync(path).blocks * 512, 0)
    const apparent = paths.reduce((total, path) => total + statSync(path).size, 0)
    expect(apparent).toBeLessThan(allocated)

    expect(await measureRetainedBytes([root])).toEqual({ bytes: allocated, unreadable: 0 })
    expect(await measureRetainedBytes([root], 1)).toEqual({ bytes: allocated, unreadable: 0 })
  })

  test("a directory that cannot be listed is counted and named, never silently dropped", async () => {
    const root = tmp("git-super-retained-bytes-locked-")
    mkdirSync(join(root, "kept"))
    writeFileSync(join(root, "kept", "visible"), "x")
    const locked = join(root, "locked")
    mkdirSync(locked)
    writeFileSync(join(locked, "hidden"), "x")
    chmodSync(locked, 0o000)
    try {
      const measured = await measureRetainedBytes([root], 1)
      expect(measured.unreadable).toBe(1)
      expect(measured.unreadableExample).toBe(locked)
      // The locked directory's own blocks are counted; its children are not, and the count says so.
      const visible = [root, join(root, "kept"), join(root, "kept", "visible"), locked].reduce(
        (total, path) => total + statSync(path).blocks * 512,
        0,
      )
      expect(measured.bytes).toBe(visible)
    } finally {
      chmodSync(locked, 0o755)
    }
  })

  // A store that was already removed frees nothing more, so a vanished path is not an unreadable subtree; the
  // total stays honest instead of reporting a ghost error for work another pass already did.
  test("a path that no longer exists adds nothing and is not reported as unreadable", async () => {
    expect(await measureRetainedBytes([join(tmpdir(), "git-super-retained-bytes-absent-xyz")])).toEqual({
      bytes: 0,
      unreadable: 0,
    })
  })

  // The figure an operator reads in the dry-run line: exact bytes always, a rounded size beside them.
  test("the human figure keeps the exact byte count beside the rounded one", async () => {
    expect(formatRetainedBytes(0)).toBe("0 B")
    expect(formatRetainedBytes(999)).toBe("999 B")
    expect(formatRetainedBytes(1536)).toBe("1.5 KiB (1,536 B)")
    expect(formatRetainedBytes(13_014_125_285)).toBe("12.1 GiB (13,014,125,285 B)")
  })

  // @cto 7a5c26cd B1: local clones hard-link packs, so one inode with several names is ordinary, not exotic.
  test("one inode with two links inside the set is counted once, and its bytes are freed", async () => {
    const root = tmp("git-super-retained-bytes-links-")
    const store = join(root, "store")
    const pack = join(store, "pack")
    mkdirSync(pack, { recursive: true })
    const first = join(pack, "a.pack")
    const second = join(pack, "b.pack")
    writeFileSync(first, "x".repeat(4096))
    linkSync(first, second)
    const inode = statSync(first)
    expect(inode.nlink).toBe(2)
    const directories = [root, store, pack].reduce((total, path) => total + statSync(path).blocks * 512, 0)

    const measured = await measureRetainedBytes([root], 1)
    // The inode appears under two names but occupies its blocks once.
    expect(measured).toEqual({ bytes: directories + inode.blocks * 512, unreadable: 0 })
  })

  test("a file also linked outside the set is not counted as freed, it is named separately", async () => {
    const root = tmp("git-super-retained-bytes-shared-")
    const outside = tmp("git-super-retained-bytes-outside-")
    const store = join(root, "store")
    mkdirSync(store, { recursive: true })
    const kept = join(store, "shared.pack")
    writeFileSync(kept, "x".repeat(4096))
    linkSync(kept, join(outside, "shared.pack"))
    const inode = statSync(kept)
    expect(inode.nlink).toBe(2)
    const directories = [root, store].reduce((total, path) => total + statSync(path).blocks * 512, 0)

    const measured = await measureRetainedBytes([root], 1)
    // Removing the store frees nothing of that inode: the outside link keeps the bytes alive.
    expect(measured.bytes).toBe(directories)
    expect(measured.sharedBytes).toBe(inode.blocks * 512)
  })
})

// Accepted requirement (#34920, @cto 34920-ranking-and-bare-r2 §1): Yrd plans a size-ranked batch from one
// measurement per entry. Existing tests measure one aggregate set; none rank, none cover an entry missing or replaced
// around its walk (the walker reads ENOENT as zero), and none bound the loop.
describe("retained entry ranking (#34920)", async () => {
  function entries(sizes: Record<string, number>): { root: string; paths: Record<string, string> } {
    const root = tmp("git-super-rank-")
    const paths: Record<string, string> = {}
    for (const [name, size] of Object.entries(sizes)) {
      const entry = join(root, name)
      mkdirSync(entry, { recursive: true })
      writeFileSync(join(entry, "pack"), "x".repeat(size))
      paths[name] = entry
    }
    return { root, paths }
  }

  test("orders entries by own bytes, largest first, with the entry path breaking ties", async () => {
    const { paths } = entries({ small: 10, large: 300_000, mid: 60_000, tie: 60_000 })
    const ranking = await rankRetainedEntries(Object.values(paths), { deadlineMs: 60_000 })
    expect(ranking.ranked.map((row) => row.entry)).toEqual([paths.large, paths.mid, paths.tie, paths.small])
    expect(ranking.unmeasured).toEqual([])
    expect(ranking.partial).toBe(false)
    expect(ranking.measuredBytes).toBe(ranking.ranked.reduce((sum, row) => sum + row.bytes, 0))
  })

  test("a file hard-linked across two entries counts in neither's own bytes and in both shared bytes", async () => {
    const { paths } = entries({ a: 10, b: 10 })
    writeFileSync(join(paths.a!, "shared"), "y".repeat(200_000))
    linkSync(join(paths.a!, "shared"), join(paths.b!, "shared"))
    const shared = statSync(join(paths.a!, "shared")).blocks * 512
    const ranking = await rankRetainedEntries([paths.a!, paths.b!], { deadlineMs: 60_000 })
    for (const row of ranking.ranked) {
      expect(row.sharedBytes).toBe(shared)
      expect(row.bytes).toBeLessThan(shared)
    }
    // The set reclaims the shared inode too: exclusive scores sum to less than the union, never more.
    const union = await measureRetainedBytes([paths.a!, paths.b!])
    expect(ranking.measuredBytes).toBeLessThan(union.bytes)
  })

  test("an absent entry, or one that disappears or is replaced during its walk, is unmeasured, never ranked zero", async () => {
    const { root, paths } = entries({ kept: 10, gone: 10, vanishing: 10, swapped: 10 })
    rmSync(paths.gone!, { recursive: true })
    const ranking = await rankRetainedEntries(Object.values(paths), {
      deadlineMs: 60_000,
      measure: async (roots) => {
        const measured = await measureRetainedBytes(roots)
        if (roots[0] === paths.vanishing) rmSync(paths.vanishing!, { recursive: true })
        if (roots[0] === paths.swapped) {
          rmSync(paths.swapped!, { recursive: true })
          mkdirSync(join(root, "elsewhere"))
          mkdirSync(paths.swapped!)
        }
        return measured
      },
    })
    expect(ranking.ranked.map((row) => row.entry)).toEqual([paths.kept])
    expect(ranking.unmeasured).toEqual(
      expect.arrayContaining([
        { entry: paths.gone, reason: "absent" },
        { entry: paths.vanishing, reason: "disappeared" },
        { entry: paths.swapped, reason: "replaced" },
      ]),
    )
    expect(ranking.partial).toBe(true)
  })

  test("the soft deadline keeps what was measured and lists every remaining entry as unmeasured", async () => {
    const { paths } = entries({ a: 10, b: 10, c: 10 })
    let now = 0
    const ranking = await rankRetainedEntries(Object.values(paths), {
      deadlineMs: 5,
      monotonic: () => now,
      measure: async (roots) => {
        now += 10
        return measureRetainedBytes(roots)
      },
    })
    expect(ranking.deadlineHit).toBe(true)
    expect(ranking.partial).toBe(true)
    expect(ranking.ranked.map((row) => row.entry)).toEqual([paths.a])
    expect(ranking.unmeasured).toEqual([
      { entry: paths.b, reason: "deadline" },
      { entry: paths.c, reason: "deadline" },
    ])
  })

  function sinkInto(lines: string[]): { write(chunk: string): boolean } {
    return {
      write(chunk: string): boolean {
        lines.push(chunk)
        return true
      },
    }
  }

  test("the CLI mode prints its own JSON result, keeps the batch path scope, and refuses --apply", async () => {
    const { root, paths } = entries({ big: 200_000, small: 10 })
    const required = ["--common", root, "--artifact-dir", join(root, "artifacts"), "--namespace", root]
    const out: string[] = []
    const err: string[] = []
    const base = ["--json", "worktree", "retention", "retire-batch", "--rank-only", "--root", root, ...required]
    expect(await runCli([...base, paths.small!, paths.big!, join(root, "missing")], sinkInto(out), sinkInto(err))).toBe(
      0,
    )
    const ranking = JSON.parse(out.join("")) as { ranked: { entry: string }[]; unmeasured: unknown[] }
    expect(ranking.ranked.map((row) => row.entry)).toEqual([paths.big, paths.small])
    expect(ranking.unmeasured).toEqual([{ entry: join(root, "missing"), reason: "absent" }])

    const outside = join(tmp("git-super-rank-outside-"), "entry")
    mkdirSync(outside)
    const scopeErr: string[] = []
    expect(await runCli([...base, outside], sinkInto([]), sinkInto(scopeErr))).not.toBe(0)
    expect(scopeErr.join("")).toContain("is not a direct child of")

    const applyErr: string[] = []
    expect(await runCli([...base, "--apply", paths.big!], sinkInto([]), sinkInto(applyErr))).not.toBe(0)
    expect(applyErr.join("")).toContain("refuses --apply")

    const emptyErr: string[] = []
    expect(await runCli([...base, join(root, "missing")], sinkInto([]), sinkInto(emptyErr))).toBe(2)
  })
})
