/**
 * @failure Gate 5 accepts an alternate target, `cat-file -e`, a transient reflog, or a witness
 * store that borrows from the removal set as durable custody for an at-risk object.
 * @level l1
 * @consumer the read-only retention verifier, gate 5; #27443(b)
 * @testonly none
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { defaultGitRun, type ComponentContents } from "../src/retention-contents.ts"
import { scanCustody } from "../src/retention-custody.ts"

const cleanup: string[] = []
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true })
})

function tmp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  cleanup.push(path)
  return path
}

const environment: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Gate5",
  GIT_AUTHOR_EMAIL: "g5@example.test",
  GIT_COMMITTER_NAME: "Gate5",
  GIT_COMMITTER_EMAIL: "g5@example.test",
  GIT_TERMINAL_PROMPT: "0",
}

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: environment })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed in ${cwd}`)
  return result.stdout.trim()
}

function repoWithCommit(prefix: string): { root: string; head: string } {
  const root = tmp(prefix)
  git(root, ["init", "-q", "-b", "main"])
  writeFileSync(join(root, "a.txt"), "alpha\n")
  git(root, ["add", "a.txt"])
  git(root, ["commit", "-q", "-m", "first"])
  return { root, head: git(root, ["rev-parse", "HEAD"]) }
}

function componentOf(head: string, atRiskOids: readonly string[]): ComponentContents {
  const sources = Object.fromEntries(atRiskOids.map((oid) => [oid, oid === head ? "ref refs/heads/main" : "owned"]))
  return {
    component: ".git",
    effective: atRiskOids.length,
    independent: 0,
    atRisk: atRiskOids.length,
    missingRoots: [],
    atRiskOids,
    atRiskSources: sources,
    elapsedMs: 0,
  }
}

describe("retention custody scan — gate 5 (#27443(b))", () => {
  test("a named survivor ref whose closure includes the OID witnesses it", () => {
    const store = repoWithCommit("git-super-custody-")
    const scan = scanCustody(
      store.root,
      [componentOf(store.head, [store.head])],
      [join(store.root, ".git", "objects")],
      [join(store.root, "unused-removal")],
    )
    expect(scan.status).toBe("pass")
    expect(scan.witnesses).toHaveLength(1)
    expect(scan.witnesses[0]).toMatchObject({ component: ".git", oid: store.head, ref: "refs/heads/main" })
    expect(scan.witnesses[0]!.graphDigest).toMatch(/^[0-9a-f]{64}$/u)
    expect(scan.missing).toEqual([])
  })

  test("an at-risk OID no store reaches is blocked with component, OID and source", () => {
    const store = repoWithCommit("git-super-custody-")
    const orphan = "b".repeat(40)
    const scan = scanCustody(store.root, [componentOf(store.head, [orphan])], [join(store.root, ".git", "objects")], [])
    expect(scan.status).toBe("blocked")
    expect(scan.missing[0]).toMatchObject({ component: ".git", oid: orphan, source: "owned" })
    expect(scan.detail).toContain(orphan)
  })

  test("a witness store borrowing into the removal set is unknown, never a witness", () => {
    const removal = tmp("git-super-custody-removal-")
    const held = join(removal, "store", "objects")
    mkdirSync(join(held, "pack"), { recursive: true })
    const borrower = repoWithCommit("git-super-custody-borrower-")
    mkdirSync(join(borrower.root, ".git", "objects", "info"), { recursive: true })
    writeFileSync(join(borrower.root, ".git", "objects", "info", "alternates"), `${held}\n`)
    const scan = scanCustody(
      borrower.root,
      [componentOf(borrower.head, [borrower.head])],
      [join(borrower.root, ".git", "objects")],
      [removal],
    )
    expect(scan.status).toBe("unknown")
    expect(scan.detail).toContain("removal set")
  })

  test("an fsck failure in a witness store is unknown, never custody", () => {
    const store = repoWithCommit("git-super-custody-")
    const broken = (args: readonly string[]) =>
      args.includes("fsck") ? { code: 1, stdout: "", stderr: "missing blob" } : defaultGitRun(args)
    const scan = scanCustody(
      store.root,
      [componentOf(store.head, [store.head])],
      [join(store.root, ".git", "objects")],
      [],
      broken,
    )
    expect(scan.status).toBe("unknown")
    expect(scan.detail).toContain("fsck --full failed")
  })

  test("a store that is not a Git object directory is unknown", () => {
    const store = repoWithCommit("git-super-custody-")
    const notAStore = tmp("git-super-custody-not-a-store-")
    const scan = scanCustody(store.root, [componentOf(store.head, [store.head])], [notAStore], [])
    expect(scan.status).toBe("unknown")
    expect(scan.detail).toContain("not a Git object directory")
  })
})
