import { afterEach, describe, expect, test } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLocalGitProcess } from "../src/process.ts"
import { createRepository } from "./fixture.ts"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("GitProcess", () => {
  test("reports a bounded Git command timeout explicitly", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "git-super-process-timeout-"))
    roots.push(fixture)
    createRepository(fixture, "README.md", "one\n")

    const result = await createLocalGitProcess().run({
      repository: fixture,
      args: ["-c", "alias.pause=!sleep 1", "pause"],
      timeoutMs: 10,
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.timedOut).toBe(true)
  })
})
