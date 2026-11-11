/**
 * @failure Gate 3 misses a dangling alternate, a survivor borrowing into the removal set, or an
 * unprovable managed namespace, and a partial estate reads as complete.
 * @level l1
 * @consumer the read-only retention verifier, gate 3; #27443(b)
 * @testonly none
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
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

describe("retention estate scan — gate 3 (#27443(b))", () => {
  test("canonical estate facts ignore walk order while preserving edges, bounds, duplicates and future values", () => {
    const namespace = tmp("git-super-estate-canonical-")
    const otherRoot = tmp("git-super-estate-other-")
    const lender = objectDir(namespace, "lender")
    borrow(objectDir(namespace, "borrower-a"), lender)
    borrow(objectDir(namespace, "borrower-b"), lender)
    const scan = scanEstate([namespace, otherRoot], [dirname(lender)])
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

  test("an estate whose borrows stay inside N passes and reports the reverse links", () => {
    const namespace = tmp("git-super-estate-")
    const lender = objectDir(namespace, "lender")
    const borrower = objectDir(namespace, "borrower")
    borrow(borrower, lender)
    const scan = scanEstate([namespace], [tmp("git-super-estate-removal-")])
    expect(scan.status).toBe("pass")
    expect(scan.alternatesFiles).toBe(1)
    expect(scan.borrowers).toEqual([{ borrower, target: lender }])
  })

  test("a survivor borrowing into the removal set blocks with both paths named", () => {
    const namespace = tmp("git-super-estate-")
    const removal = tmp("git-super-estate-removal-")
    const holder = objectDir(removal, "kept")
    const borrower = objectDir(namespace, "live")
    borrow(borrower, holder)
    const scan = scanEstate([namespace], [removal])
    expect(scan.status).toBe("blocked")
    expect(scan.detail).toContain(borrower)
    expect(scan.survivorIntoRemoval).toEqual([{ borrower, target: holder }])
  })

  test("a missing namespace root is unknown, never a silent skip", () => {
    const scan = scanEstate([join(tmpdir(), "git-super-estate-does-not-exist-xyz")], [])
    expect(scan.status).toBe("unknown")
    expect(scan.detail).toContain("cannot be proven complete")
  })

  // #33010 (@cto e497078d): a line naming a path that does not exist cannot be a loan from any store that does, so
  // it is excluded BY NAME and the pass continues; it never ends the inventory for every other entry.
  test("a dangling alternates line is excluded by name and counted, and the pass completes", () => {
    const namespace = tmp("git-super-estate-")
    const borrower = objectDir(namespace, "borrower")
    const gone = join(namespace, "gone", "objects")
    borrow(borrower, gone)
    const scan = scanEstate([namespace], [])
    expect(scan.status).toBe("pass")
    expect(scan.danglingAlternates).toEqual([
      { store: borrower, alternatesFile: join(borrower, "info", "alternates"), line: gone, target: gone },
    ])
    expect(scan.detail).toContain("1 dangling alternates line(s) excluded")
  })

  test("a relative dangling line is resolved against its own objects directory before it is excluded", () => {
    const namespace = tmp("git-super-estate-")
    const borrower = objectDir(namespace, "borrower")
    borrow(borrower, "../../gone/objects")
    const scan = scanEstate([namespace], [])
    expect(scan.status).toBe("pass")
    expect(scan.danglingAlternates).toMatchObject([
      { line: "../../gone/objects", target: join(namespace, "gone", "objects") },
    ])
  })

  test("exclusion is per line: a store's other lines still count as loans, so its lender stays refused", () => {
    const namespace = tmp("git-super-estate-")
    const removal = tmp("git-super-estate-removal-")
    const candidate = objectDir(removal, "C")
    const borrower = objectDir(namespace, "X")
    writeFileSync(join(borrower, "info", "alternates"), `${join(namespace, "gone", "objects")}\n${candidate}\n`)
    const scan = scanEstate([namespace], [removal])
    expect(scan.status).toBe("blocked")
    expect(scan.survivorIntoRemoval).toEqual([{ borrower, target: candidate }])
    expect(scan.danglingAlternates).toHaveLength(1)
  })

  test("an alternate naming an existing non-directory still ends the pass as unknown", () => {
    const namespace = tmp("git-super-estate-")
    const borrower = objectDir(namespace, "borrower")
    const file = join(namespace, "not-a-store")
    writeFileSync(file, "x")
    borrow(borrower, file)
    const scan = scanEstate([namespace], [])
    expect(scan.status).toBe("unknown")
    expect(scan.detail).toContain("non-directory alternate")
  })

  // #33010 (@cto dc77f630 conditions 1 and 3): a batch reuses one scan, so a lease-held delta must catch every
  // change to the SET of object dirs, alternates files and registries since the scan, including writes by a writer
  // that never takes the lease (a hand-run clone or worktree add).
  describe("estate delta under the lease", () => {
    const scene = (): { namespace: string; record: EstateWalkRecord; scan: ReturnType<typeof scanEstate> } => {
      const namespace = tmp("git-super-estate-delta-")
      const lender = objectDir(namespace, "lender")
      borrow(objectDir(namespace, "borrower"), lender)
      objectDir(join(namespace, "deep", "repo"), ".git")
      const record = newEstateWalkRecord()
      const scan = scanEstate([namespace], [], DEFAULT_ESTATE_BOUNDS, Date.now, record)
      expect(scan.status).toBe("pass")
      return { namespace, record, scan }
    }

    test("an untouched estate is unchanged, even when unrelated files were written", () => {
      const { namespace, record, scan } = scene()
      writeFileSync(join(namespace, "deep", "build-output.txt"), "noise\n")
      mkdirSync(join(namespace, "deep", "node_modules", "pkg"), { recursive: true })
      expect(estateDelta(record, scan)).toEqual({ status: "unchanged", changedDirs: 1 })
    })

    test("an alternates file added between scan and delta ends the batch, naming the file", () => {
      const { namespace, record, scan } = scene()
      const repo = join(namespace, "deep", "repo", ".git", "objects")
      borrow(repo, join(namespace, "lender", "objects"))
      const delta = estateDelta(record, scan)
      expect(delta.status).toBe("changed")
      expect(delta.status === "changed" && delta.detail).toContain(join(repo, "info", "alternates"))
    })

    test("a rewritten alternates file of the same length ends the batch by its change time", () => {
      const { namespace, record, scan } = scene()
      const file = join(namespace, "borrower", "objects", "info", "alternates")
      const bytes = readFileSync(file, "utf8")
      const stamp = statSync(file)
      writeFileSync(file, bytes.replace("lender", "lendex"))
      utimesSync(file, stamp.atime, stamp.mtime)
      expect(estateDelta(record, scan).status).toBe("changed")
    })

    test("a new repository in a new directory ends the batch", () => {
      const { namespace, record, scan } = scene()
      objectDir(join(namespace, "fresh", "clone"), ".git")
      const delta = estateDelta(record, scan)
      expect(delta.status).toBe("changed")
      expect(delta.status === "changed" && delta.detail).toContain(join(namespace, "fresh", "clone", ".git", "objects"))
    })

    test("a vanished object directory ends the batch", () => {
      const { namespace, record, scan } = scene()
      rmSync(join(namespace, "deep", "repo", ".git"), { recursive: true })
      expect(estateDelta(record, scan).status).toBe("changed")
    })

    // Live estate 2026-11-10: a worktree closed during the 7-minute walk made the whole batch scan unknown.
    test("a directory that vanishes mid-walk is tolerated only when the walk is recorded for a delta", () => {
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
      const recorded = scanEstate([namespace], [], DEFAULT_ESTATE_BOUNDS, clock, record)
      expect(recorded.status).toBe("pass")
      expect(recorded.detail).toContain("vanished during the walk")
      mkdirSync(join(doomed, "inner"), { recursive: true })
      calls = 0
      expect(scanEstate([namespace], [], DEFAULT_ESTATE_BOUNDS, clock).status).toBe("unknown")
    })

    test("a store moved mid-walk into an already-read directory is caught by the delta", () => {
      const { namespace, record, scan } = scene()
      // After the scan read `deep`, a writer moves a new repository into it: deep's stamp moves.
      objectDir(join(namespace, "deep", "moved-in"), ".git")
      expect(estateDelta(record, scan).status).toBe("changed")
    })

    test("a changed borrower registry record ends the batch", () => {
      const namespace = tmp("git-super-estate-delta-registry-")
      const registry = join(namespace, "common", "git-super-retained-borrowers")
      mkdirSync(registry, { recursive: true })
      const manifest = join(namespace, "manifest.json")
      writeFileSync(manifest, "{}\n")
      writeFileSync(join(registry, "a.json"), JSON.stringify({ retained: join(namespace, "kept"), manifest }))
      const record = newEstateWalkRecord()
      const scan = scanEstate([namespace], [], DEFAULT_ESTATE_BOUNDS, Date.now, record)
      expect(scan.status).toBe("pass")
      writeFileSync(join(registry, "b.json"), JSON.stringify({ retained: join(namespace, "other"), manifest }))
      expect(estateDelta(record, scan).status).toBe("changed")
    })
  })

  test("the scan bound is an unknown verdict carrying the observed count, not a truncation", () => {
    const namespace = tmp("git-super-estate-")
    const borrower = objectDir(namespace, "borrower")
    borrow(borrower, objectDir(namespace, "lender"))
    const scan = scanEstate([namespace], [], { maxAlternatesFiles: 0, scanMs: 180_000 })
    expect(scan.status).toBe("unknown")
    expect(scan.detail).toContain("cap 0")
  })
})
