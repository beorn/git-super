/**
 * @failure Gate 3 misses a dangling alternate, a survivor borrowing into the removal set, or an
 * unprovable managed namespace, and a partial estate reads as complete.
 * @level l1
 * @consumer the read-only retention verifier, gate 3; #27443(b)
 * @testonly none
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import {
  canonicalEstateScan,
  DEFAULT_ESTATE_BOUNDS,
  estateDelta,
  newEstateWalkRecord,
  scanEstate,
  type EstateWalkRecord,
} from "../src/retention-estate.ts"

const cleanup: string[] = []
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true })
})

function tmp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  cleanup.push(path)
  return path
}

/** One Git object directory with the pack/info shape the estate walk recognises. */
function objectDir(parent: string, name: string): string {
  const objects = join(parent, name, "objects")
  mkdirSync(join(objects, "pack"), { recursive: true })
  mkdirSync(join(objects, "info"), { recursive: true })
  return objects
}

function borrow(objects: string, target: string): void {
  writeFileSync(join(objects, "info", "alternates"), `${target}\n`)
}

describe("retention estate scan — gate 3 (#27443(b))", async () => {
  test("canonical estate facts ignore walk order while preserving edges, bounds, duplicates and future values", async () => {
    const namespace = tmp("git-super-estate-canonical-")
    const otherRoot = tmp("git-super-estate-other-")
    const lender = objectDir(namespace, "lender")
    borrow(objectDir(namespace, "borrower-a"), lender)
    borrow(objectDir(namespace, "borrower-b"), lender)
    const scan = await scanEstate([namespace, otherRoot], [dirname(lender)])
    expect(scan.status).toBe("blocked")
    expect(scan.borrowers).toHaveLength(2)
    expect(scan.survivorIntoRemoval).toHaveLength(2)
    expect(scan.detail).toContain(join(namespace, "borrower-a", "objects"))
    const permuted = {
      ...scan,
      roots: [...scan.roots].reverse(),
      objectDirs: [...scan.objectDirs].reverse(),
      borrowers: [...scan.borrowers].reverse(),
      registries: [...scan.registries].reverse(),
      survivorIntoRemoval: [...scan.survivorIntoRemoval].reverse(),
    }
    expect(canonicalEstateScan(permuted)).toBe(canonicalEstateScan(scan))
    expect(canonicalEstateScan({ ...scan, borrowers: [...scan.borrowers, ...scan.borrowers] })).not.toBe(
      canonicalEstateScan(scan),
    )
    expect(
      canonicalEstateScan({
        ...scan,
        borrowers: scan.borrowers.map((edge, index) => (index === 0 ? { ...edge, borrower: "/changed" } : edge)),
      }),
    ).not.toBe(canonicalEstateScan(scan))
    expect(canonicalEstateScan({ ...scan, status: "unknown", detail: "scan hit its bound" })).not.toBe(
      canonicalEstateScan(scan),
    )
    expect(canonicalEstateScan({ ...scan, future: { z: 1, a: 2 } })).toBe(
      canonicalEstateScan({ ...permuted, future: { a: 2, z: 1 } }),
    )
    expect(canonicalEstateScan({ ...scan, ordered: [1, 2] })).not.toBe(
      canonicalEstateScan({ ...scan, ordered: [2, 1] }),
    )
  })

  test("an estate whose borrows stay inside N passes and reports the reverse links", async () => {
    const namespace = tmp("git-super-estate-")
    const lender = objectDir(namespace, "lender")
    const borrower = objectDir(namespace, "borrower")
    borrow(borrower, lender)
    const scan = await scanEstate([namespace], [tmp("git-super-estate-removal-")])
    expect(scan.status).toBe("pass")
    expect(scan.alternatesFiles).toBe(1)
    expect(scan.borrowers).toEqual([{ borrower, target: lender }])
  })

  test("a survivor borrowing into the removal set blocks with both paths named", async () => {
    const namespace = tmp("git-super-estate-")
    const removal = tmp("git-super-estate-removal-")
    const holder = objectDir(removal, "kept")
    const borrower = objectDir(namespace, "live")
    borrow(borrower, holder)
    const scan = await scanEstate([namespace], [removal])
    expect(scan.status).toBe("blocked")
    expect(scan.detail).toContain(borrower)
    expect(scan.survivorIntoRemoval).toEqual([{ borrower, target: holder }])
  })

  test("a missing namespace root is unknown, never a silent skip", async () => {
    const scan = await scanEstate([join(tmpdir(), "git-super-estate-does-not-exist-xyz")], [])
    expect(scan.status).toBe("unknown")
    expect(scan.detail).toContain("cannot be proven complete")
  })

  // #33010 (@cto e497078d): a line naming a path that does not exist cannot be a loan from any store that does, so
  // it is excluded BY NAME and the pass continues; it never ends the inventory for every other entry.
  test("a dangling alternates line is excluded by name and counted, and the pass completes", async () => {
    const namespace = tmp("git-super-estate-")
    const borrower = objectDir(namespace, "borrower")
    const gone = join(namespace, "gone", "objects")
    borrow(borrower, gone)
    const scan = await scanEstate([namespace], [])
    expect(scan.status).toBe("pass")
    expect(scan.danglingAlternates).toEqual([
      { store: borrower, alternatesFile: join(borrower, "info", "alternates"), line: gone, target: gone },
    ])
    expect(scan.detail).toContain("1 dangling alternates line(s) excluded")
  })

  test("a relative dangling line is resolved against its own objects directory before it is excluded", async () => {
    const namespace = tmp("git-super-estate-")
    const borrower = objectDir(namespace, "borrower")
    borrow(borrower, "../../gone/objects")
    const scan = await scanEstate([namespace], [])
    expect(scan.status).toBe("pass")
    expect(scan.danglingAlternates).toMatchObject([
      { line: "../../gone/objects", target: join(namespace, "gone", "objects") },
    ])
  })

  test("exclusion is per line: a store's other lines still count as loans, so its lender stays refused", async () => {
    const namespace = tmp("git-super-estate-")
    const removal = tmp("git-super-estate-removal-")
    const candidate = objectDir(removal, "C")
    const borrower = objectDir(namespace, "X")
    writeFileSync(join(borrower, "info", "alternates"), `${join(namespace, "gone", "objects")}\n${candidate}\n`)
    const scan = await scanEstate([namespace], [removal])
    expect(scan.status).toBe("blocked")
    expect(scan.survivorIntoRemoval).toEqual([{ borrower, target: candidate }])
    expect(scan.danglingAlternates).toHaveLength(1)
  })

  test("an alternate naming an existing non-directory still ends the pass as unknown", async () => {
    const namespace = tmp("git-super-estate-")
    const borrower = objectDir(namespace, "borrower")
    const file = join(namespace, "not-a-store")
    writeFileSync(file, "x")
    borrow(borrower, file)
    const scan = await scanEstate([namespace], [])
    expect(scan.status).toBe("unknown")
    expect(scan.detail).toContain("non-directory alternate")
  })

  // #33010 (@cto dc77f630 conditions 1 and 3): a batch reuses one scan, so a lease-held delta must catch every
  // change to the SET of object dirs, alternates files and registries since the scan, including writes by a writer
  // that never takes the lease (a hand-run clone or worktree add).
  describe("estate delta under the lease", async () => {
    const scene = async (): Promise<{
      namespace: string
      record: EstateWalkRecord
      scan: Awaited<ReturnType<typeof scanEstate>>
    }> => {
      const namespace = tmp("git-super-estate-delta-")
      const lender = objectDir(namespace, "lender")
      borrow(objectDir(namespace, "borrower"), lender)
      objectDir(join(namespace, "deep", "repo"), ".git")
      const record = newEstateWalkRecord()
      const scan = await scanEstate([namespace], [], DEFAULT_ESTATE_BOUNDS, Date.now, record)
      expect(scan.status).toBe("pass")
      return { namespace, record, scan }
    }

    test("an untouched estate is unchanged, even when unrelated files were written", async () => {
      const { namespace, record, scan } = await scene()
      writeFileSync(join(namespace, "deep", "build-output.txt"), "noise\n")
      mkdirSync(join(namespace, "deep", "node_modules", "pkg"), { recursive: true })
      expect(estateDelta(record, scan)).toEqual({ status: "unchanged", changedDirs: 1 })
    })

    test("an alternates file added between scan and delta ends the batch, naming the file", async () => {
      const { namespace, record, scan } = await scene()
      const repo = join(namespace, "deep", "repo", ".git", "objects")
      borrow(repo, join(namespace, "lender", "objects"))
      const delta = estateDelta(record, scan)
      expect(delta.status).toBe("changed")
      expect(delta.status === "changed" && delta.detail).toContain(join(repo, "info", "alternates"))
    })

    test("a rewritten alternates file of the same length ends the batch by its change time", async () => {
      const { namespace, record, scan } = await scene()
      const file = join(namespace, "borrower", "objects", "info", "alternates")
      const bytes = readFileSync(file, "utf8")
      const stamp = statSync(file)
      writeFileSync(file, bytes.replace("lender", "lendex"))
      utimesSync(file, stamp.atime, stamp.mtime)
      expect(estateDelta(record, scan).status).toBe("changed")
    })

    // Accepted requirement: the reused scan detects every changed alternates declaration. A symlink's own
    // lstat cannot see writes to its target; a broken borrower can gain a valid loan while remaining broken.
    test("an alternates symlink target gaining a surviving loan ends the batch", async () => {
      const namespace = tmp("git-super-estate-delta-link-")
      const lender = objectDir(namespace, "lender")
      const borrower = objectDir(namespace, "borrower")
      const target = join(namespace, "alternates-target")
      writeFileSync(target, `${join(namespace, "gone", "objects")}\n`)
      symlinkSync(target, join(borrower, "info", "alternates"))
      const record = newEstateWalkRecord()
      const scan = await scanEstate([namespace], [dirname(lender)], DEFAULT_ESTATE_BOUNDS, Date.now, record)
      expect(scan.status).toBe("pass")
      expect(scan.danglingAlternates).toHaveLength(1)
      writeFileSync(target, `${join(namespace, "gone", "objects")}\n${lender}\n`)
      expect(estateDelta(record, scan).status).toBe("changed")
    })

    test("a new repository in a new directory ends the batch", async () => {
      const { namespace, record, scan } = await scene()
      objectDir(join(namespace, "fresh", "clone"), ".git")
      const delta = estateDelta(record, scan)
      expect(delta.status).toBe("changed")
      expect(delta.status === "changed" && delta.detail).toContain(join(namespace, "fresh", "clone", ".git", "objects"))
    })

    test("a vanished object directory ends the batch", async () => {
      const { namespace, record, scan } = await scene()
      rmSync(join(namespace, "deep", "repo", ".git"), { recursive: true })
      expect(estateDelta(record, scan).status).toBe("changed")
    })

    // Live estate 2026-11-10: a worktree closed during the 7-minute walk made the whole batch scan unknown.
    test("a directory that vanishes mid-walk is tolerated only when the walk is recorded for a delta", async () => {
      const namespace = tmp("git-super-estate-vanish-")
      objectDir(join(namespace, "stays"), ".git")
      const doomed = join(namespace, "doomed")
      mkdirSync(join(doomed, "inner"), { recursive: true })
      let calls = 0
      // The clock runs once at the start and once per popped directory: call 3 comes after the root listed `doomed`
      // and before `doomed` is read, whichever order the directory read returns.
      const clock = (): number => {
        calls += 1
        if (calls === 3) rmSync(doomed, { recursive: true, force: true })
        return 0
      }
      const record = newEstateWalkRecord()
      const recorded = await scanEstate([namespace], [], { ...DEFAULT_ESTATE_BOUNDS, workers: 1 }, clock, record)
      expect(recorded.status).toBe("pass")
      expect(recorded.detail).toContain("vanished during the walk")
      mkdirSync(join(doomed, "inner"), { recursive: true })
      calls = 0
      expect((await scanEstate([namespace], [], { ...DEFAULT_ESTATE_BOUNDS, workers: 1 }, clock)).status).toBe(
        "unknown",
      )
    })

    test("a store moved mid-walk into an already-read directory is caught by the delta", async () => {
      const { namespace, record, scan } = await scene()
      // After the scan read `deep`, a writer moves a new repository into it: deep's stamp moves.
      objectDir(join(namespace, "deep", "moved-in"), ".git")
      expect(estateDelta(record, scan).status).toBe("changed")
    })

    test("a changed borrower registry record ends the batch", async () => {
      const namespace = tmp("git-super-estate-delta-registry-")
      const registry = join(namespace, "common", "git-super-retained-borrowers")
      mkdirSync(registry, { recursive: true })
      const manifest = join(namespace, "manifest.json")
      writeFileSync(manifest, "{}\n")
      writeFileSync(join(registry, "a.json"), JSON.stringify({ retained: join(namespace, "kept"), manifest }))
      const record = newEstateWalkRecord()
      const scan = await scanEstate([namespace], [], DEFAULT_ESTATE_BOUNDS, Date.now, record)
      expect(scan.status).toBe("pass")
      writeFileSync(join(registry, "b.json"), JSON.stringify({ retained: join(namespace, "other"), manifest }))
      expect(estateDelta(record, scan).status).toBe("changed")
    })
  })

  test("the scan bound is an unknown verdict carrying the observed count, not a truncation", async () => {
    const namespace = tmp("git-super-estate-")
    const borrower = objectDir(namespace, "borrower")
    borrow(borrower, objectDir(namespace, "lender"))
    const scan = await scanEstate([namespace], [], { maxAlternatesFiles: 0, scanMs: 180_000 })
    expect(scan.status).toBe("unknown")
    expect(scan.detail).toContain("cap 0")
  })

  // #34270 (@chief 431033e5): the walk is a bounded pool. Only the overlap may change, never the node set, so the
  // concurrent scan is compared against `workers: 1`, the serial walk the scan used before this change.
  describe("the concurrent walk reads the same estate as the serial one (#34270)", async () => {
    const scene = (): { namespace: string; removal: string; store: string; linked: string } => {
      const namespace = tmp("git-super-estate-pool-")
      const removal = tmp("git-super-estate-pool-removal-")
      const store = objectDir(join(namespace, "a", "repo"), ".git")
      const linked = objectDir(join(namespace, "b", "far", "elsewhere"), ".git")
      // An `objects` link at a third depth, borrowing the store the walk also reaches directly.
      mkdirSync(join(namespace, "c", "link-holder"), { recursive: true })
      symlinkSync(store, join(namespace, "c", "link-holder", "objects"))
      // A borrower registry two levels deeper than either store, naming a manifest of its own.
      const registry = join(namespace, "d", "e", "git-super-retained-borrowers")
      mkdirSync(registry, { recursive: true })
      const manifest = join(namespace, "d", "e", "manifest.json")
      writeFileSync(manifest, "{}\n")
      writeFileSync(join(registry, "one.json"), JSON.stringify({ retained: linked, manifest }))
      // A survivor borrowing into the removal set, with a dangling line beside it.
      const survivor = objectDir(join(namespace, "f", "survivor"), ".git")
      const kept = objectDir(removal, "kept")
      writeFileSync(join(survivor, "info", "alternates"), `${join(namespace, "gone", "objects")}\n${kept}\n`)
      return { namespace, removal, store, linked }
    }

    test("a store, an `objects` link and a registry at different depths canonicalise identically at any worker count", async () => {
      const { namespace, removal, store, linked } = scene()
      const concurrentRecord = newEstateWalkRecord()
      const concurrent = await scanEstate([namespace], [removal], DEFAULT_ESTATE_BOUNDS, Date.now, concurrentRecord)
      const serialRecord = newEstateWalkRecord()
      const serial = await scanEstate(
        [namespace],
        [removal],
        { ...DEFAULT_ESTATE_BOUNDS, workers: 1 },
        Date.now,
        serialRecord,
      )

      // The fixture must carry every shape, or the equality below would be vacuously true.
      expect(concurrent.status).toBe("blocked")
      expect(concurrent.registries).toHaveLength(1)
      expect(concurrent.danglingAlternates).toHaveLength(1)
      expect(concurrent.objectDirs).toEqual(expect.arrayContaining([store, linked]))
      expect(concurrent.borrowers).toHaveLength(3)
      expect(concurrent.borrowers.map((edge) => edge.target)).toContain(store)

      expect(canonicalEstateScan(concurrent)).toBe(canonicalEstateScan(serial))
      // The lease-held delta re-stats what the walk recorded, so the record must match entry for entry too.
      for (const field of ["dirs", "alternates", "objectLinks", "registries"] as const) {
        expect([...concurrentRecord[field].entries()].sort()).toEqual([...serialRecord[field].entries()].sort())
      }
      expect(estateDelta(concurrentRecord, concurrent).status).toBe("unchanged")
      expect(estateDelta(serialRecord, serial).status).toBe("unchanged")
    })

    test("a directory the walk cannot list still ends the pass as unknown, at any worker count", async () => {
      const namespace = tmp("git-super-estate-unreadable-")
      objectDir(join(namespace, "readable", "repo"), ".git")
      const locked = join(namespace, "locked")
      objectDir(locked, "repo")
      chmodSync(locked, 0o000)
      try {
        for (const scan of [
          await scanEstate([namespace], []),
          await scanEstate([namespace], [], { ...DEFAULT_ESTATE_BOUNDS, workers: 1 }),
        ]) {
          expect(scan.status).toBe("unknown")
          expect(scan.detail).toContain(`cannot read ${locked}`)
        }
      } finally {
        chmodSync(locked, 0o755)
      }
    })

    // @cto 7a5c26cd B2: the object-store probe runs outside visit's own try blocks. A probe that fails there must be a
    // verdict naming the directory, exactly as the serial walk answered, never a rejected scan.
    test("an `objects` probe that fails ends the pass as unknown instead of throwing", async () => {
      const namespace = tmp("git-super-estate-probe-")
      objectDir(join(namespace, "readable", "repo"), ".git")
      const broken = join(namespace, "broken", "objects")
      mkdirSync(join(broken, "info"), { recursive: true })
      // `pack` is a symlink loop, so stat reports ELOOP: not an absence the walk may skip, and not a crash either.
      symlinkSync(join(broken, "pack"), join(broken, "pack"))
      for (const scan of [
        await scanEstate([namespace], []),
        await scanEstate([namespace], [], { ...DEFAULT_ESTATE_BOUNDS, workers: 1 }),
      ]) {
        expect(scan.status).toBe("unknown")
        // The probe runs while `broken` is being listed, so that directory is the one the verdict names.
        expect(scan.detail).toContain(`cannot read ${join(namespace, "broken")}`)
        expect(scan.detail).toContain(join(broken, "pack"))
      }
    })

    // @cto R1: an alternates file reached through a dangling symlink is a read failure, not an absence. Answering
    // "absent" would proceed with no alternates while estateDelta's sync stamp throws on the same link, so every batch
    // on such an estate would end "changed" with nothing naming the cure.
    test("an alternates file that is a dangling symlink ends the pass as unknown", async () => {
      const namespace = tmp("git-super-estate-dangling-alternates-")
      const objects = objectDir(namespace, "repo")
      const alternates = join(objects, "info", "alternates")
      symlinkSync(join(namespace, "gone", "alternates-target"), alternates)
      for (const scan of [
        await scanEstate([namespace], []),
        await scanEstate([namespace], [], { ...DEFAULT_ESTATE_BOUNDS, workers: 1 }),
      ]) {
        expect(scan.status).toBe("unknown")
        expect(scan.detail).toContain(alternates)
      }
    })
  })
})
