/**
 * @failure Node library consumers cannot resolve Git or receive the named Bun CLI refusal.
 * @level l2
 * @consumer Git-super library users on Node and Bun.
 * @testonly none
 * process.test.ts owns the Bun CLI/fd3 lifecycle; its Bun launch helpers cannot run under Node.
 */
import { afterEach, expect, test, vi } from "vitest"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { delegateNativeGit, nativeGitExecutable } from "../src/process.ts"

const roots: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test("library resolves executable Git on the inherited PATH, skipping non-executable entries", () => {
  const executable = nativeGitExecutable()
  expect(execFileSync(executable, ["--version"], { encoding: "utf8" })).toMatch(/^git version /u)
  if (typeof Bun !== "undefined") {
    const bunExecutable = Bun.which("git", { PATH: process.env.PATH ?? "" })
    expect(bunExecutable).not.toBeNull()
    expect(realpathSync(executable)).toBe(realpathSync(bunExecutable as string))
  }
  const root = mkdtempSync(join(tmpdir(), "git-super-library-path-"))
  roots.push(root)
  const first = join(root, "first")
  const second = join(root, "second")
  mkdirSync(first)
  mkdirSync(second)
  writeFileSync(join(first, "git"), "not executable", { mode: 0o644 })
  symlinkSync(executable, join(second, "git"))
  vi.stubEnv("PATH", `${first}:${second}`)
  expect(nativeGitExecutable()).toBe(join(second, "git"))
  if (typeof Bun !== "undefined") expect(nativeGitExecutable()).toBe(Bun.which("git", { PATH: `${first}:${second}` }))
})

test("library names a missing Git and refuses executable recursion", () => {
  const root = mkdtempSync(join(tmpdir(), "git-super-library-missing-"))
  roots.push(root)
  vi.stubEnv("PATH", root)
  expect(() => nativeGitExecutable()).toThrow("native Git executable 'git' was not found on PATH")
  symlinkSync(join(import.meta.dirname, "../bin/git-super"), join(root, "git"))
  expect(() => nativeGitExecutable()).toThrow("native Git resolves to git-super itself")
})

// Node must refuse delegation while Bun must remain eligible; process.test.ts owns fd3/native exec lifetime.
test("native delegation allows Bun and gives Node the named CLI floor refusal", async () => {
  let stdout = ""
  let stderr = ""
  const out = {
    write: (value: string | Uint8Array) => {
      stdout += Buffer.from(value).toString()
    },
  }
  const err = {
    write: (value: string | Uint8Array) => {
      stderr += Buffer.from(value).toString()
    },
  }
  if (typeof Bun === "undefined") {
    await expect(delegateNativeGit(["--version"], out, err, false)).rejects.toThrow("Bun CLI requires Bun >=1.3.14")
    expect({ stdout, stderr }).toEqual({ stdout: "", stderr: "" })
  } else {
    expect(await delegateNativeGit(["--version"], out, err, false)).toBe(0)
    expect(stdout).toMatch(/^git version /u)
    expect(stderr).toBe("")
  }
})
