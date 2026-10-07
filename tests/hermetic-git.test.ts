/**
 * @reach fs-walk <fixture-only: the trace2 directory a fixture commit writes under mkdtempSync(canonicalTmpdir())>
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { canonicalTmpdir, createRepository } from "./fixture.ts"

describe("hermetic Git for tests", () => {
  /**
   * @failure A fixture `git commit` starts a detached `git maintenance run --auto` whose repack writes
   * objects/pack/tmp_* while a test snapshots that store, so a store comparison sees Git's own background work:
   * CI read a tmp_rev_* that vanished between readdir and open (#27900).
   * @level l1
   * @consumer every test that compares an object store before and after git-super runs
   * @testonly none
   */
  it("a fixture commit starts no background maintenance or automatic gc", () => {
    const root = mkdtempSync(join(canonicalTmpdir(), "git-super-hermetic-"))
    const trace = join(root, "trace2")
    mkdirSync(trace)
    const previous = process.env["GIT_TRACE2_EVENT"]
    process.env["GIT_TRACE2_EVENT"] = trace
    try {
      createRepository(join(root, "repo"), "file.txt", "content\n")
    } finally {
      if (previous === undefined) delete process.env["GIT_TRACE2_EVENT"]
      else process.env["GIT_TRACE2_EVENT"] = previous
    }
    try {
      const commands = readdirSync(trace).flatMap((file) =>
        readFileSync(join(trace, file), "utf8")
          .split("\n")
          .filter((line) => line.includes('"event":"cmd_name"'))
          .map((line) => (JSON.parse(line) as { name: string }).name),
      )
      expect(commands).toContain("commit")
      expect(commands).not.toContain("maintenance")
      expect(commands).not.toContain("gc")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
