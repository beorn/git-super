import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import { ensureCommitObject, pinRef } from "../src/objects.ts"
import { advanceRepository, createRepository, git } from "./fixture.ts"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("exact commit objects", () => {
  test("fetches one missing commit and then observes it locally", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "git-super-object-"))
    roots.push(fixture)
    const upstream = join(fixture, "upstream")
    const checkout = join(fixture, "checkout")
    createRepository(upstream, "README.md", "one\n")
    git(fixture, "clone", "-q", upstream, checkout)
    const target = advanceRepository(upstream, "README.md", "two\n")

    await expect(ensureCommitObject({ repository: checkout, remote: "origin", commit: target })).resolves.toBe(
      "fetched",
    )
    await expect(ensureCommitObject({ repository: checkout, remote: "origin", commit: target })).resolves.toBe(
      "present",
    )
  })

  /**
   * A fetch that lands an object with NO ref pointing at it leaves it
   * unreachable, and the next `gc` in that repository is free to take it. The
   * fetch here therefore names a destination ref, the same convention the
   * reference warm-up and the retention rows already use.
   *
   * This is not hypothetical and it is not new: `reference.ts` learned it the
   * hard way on 2026-09-09, and this was the third bare-sha fetch left in the
   * tree.
   */
  test("the fetched commit SURVIVES gc --prune=now, because the fetch names a destination ref", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "git-super-object-gc-"))
    roots.push(fixture)
    const upstream = join(fixture, "upstream")
    const checkout = join(fixture, "checkout")
    createRepository(upstream, "README.md", "one\n")
    git(fixture, "clone", "-q", upstream, checkout)
    const target = advanceRepository(upstream, "README.md", "two\n")

    expect(await ensureCommitObject({ repository: checkout, remote: "origin", commit: target })).toBe("fetched")
    // Nothing else in this checkout reaches `target`: origin/main is still the
    // first commit, so only the fetch's own ref can keep it alive.
    git(checkout, "gc", "--prune=now")

    expect(git(checkout, "cat-file", "-t", `${target}^{commit}`)).toBe("commit")
  })

  test("the destination ref is named for the object, so a repeat fetch only rewrites it to itself", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "git-super-object-ref-"))
    roots.push(fixture)
    const upstream = join(fixture, "upstream")
    const checkout = join(fixture, "checkout")
    createRepository(upstream, "README.md", "one\n")
    git(fixture, "clone", "-q", upstream, checkout)
    const target = advanceRepository(upstream, "README.md", "two\n")

    await ensureCommitObject({ repository: checkout, remote: "origin", commit: target })
    expect(git(checkout, "rev-parse", pinRef(target))).toBe(target)
  })
})
