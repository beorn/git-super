/**
 * @failure Gate 3 misses a dangling alternate, a survivor borrowing into the removal set, or an
 * unprovable managed namespace, and a partial estate reads as complete.
 * @level l1
 * @consumer the read-only retention verifier, gate 3; #27443(b)
 * @testonly none
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { canonicalEstateScan, scanEstate } from "../src/retention-estate.ts"

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

  test("a dangling alternate target is unknown and names the alternates file", () => {
    const namespace = tmp("git-super-estate-")
    const borrower = objectDir(namespace, "borrower")
    borrow(borrower, join(namespace, "gone", "objects"))
    const scan = scanEstate([namespace], [])
    expect(scan.status).toBe("unknown")
    expect(scan.detail).toContain("alternates")
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
