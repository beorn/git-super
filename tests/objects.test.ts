import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import { ensureCommitObject } from "../src/objects.ts"
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
})
