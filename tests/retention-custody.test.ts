/**
 * @failure Gate 5 accepts an alternate target, `cat-file -e`, a transient reflog, a witness store
 * that borrows from the removal set, or a successful git query that wrote to stderr as durable
 * custody for an at-risk object; or it holds a whole reachable set in memory instead of merging.
 * @level l1
 * @consumer the read-only retention verifier, gate 5; #27443(b)
 * @testonly none
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { defaultGitRun, type ComponentContents, type GitRun } from "../src/retention-contents.ts"
import { scanCustody, type CustodyScan } from "../src/retention-custody.ts"
import { readLines, SidecarWriter } from "../src/retention-stream.ts"

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

function repoWithCommit(prefix: string): { root: string; head: string; tree: string } {
  const root = tmp(prefix)
  git(root, ["init", "-q", "-b", "main"])
  writeFileSync(join(root, "a.txt"), "alpha\n")
  git(root, ["add", "a.txt"])
  git(root, ["commit", "-q", "-m", "first"])
  return { root, head: git(root, ["rev-parse", "HEAD"]), tree: git(root, ["rev-parse", "HEAD^{tree}"]) }
}

async function componentOf(
  atRiskOids: readonly string[],
  sidecarDir: string,
  refSource = "owned",
): Promise<ComponentContents> {
  const writer = new SidecarWriter(sidecarDir, "txt")
  for (const oid of [...atRiskOids].sort()) writer.add(`${oid}\tblob\t${refSource}`)
  const atRiskSidecar = await writer.finish()
  return {
    component: ".git",
    effective: atRiskOids.length,
    independent: 0,
    atRisk: atRiskOids.length,
    atRiskSidecar,
    missingRoots: 0,
    missingRootsSample: [],
    elapsedMs: 0,
  }
}

async function sidecarText(scan: CustodyScan, which: "witness" | "missing"): Promise<string[]> {
  const ref = which === "witness" ? scan.witnessSidecar : scan.missingSidecar
  if (ref === undefined) return []
  const lines: string[] = []
  for await (const line of readLines(ref.path)) lines.push(line)
  return lines
}

describe("retention custody scan — gate 5 (#27443(b))", () => {
  test("a named survivor ref whose closure includes the OID witnesses it", async () => {
    const store = repoWithCommit("git-super-custody-")
    const sidecarDir = tmp("git-super-custody-sidecars-")
    const component = await componentOf([store.head], sidecarDir, "ref refs/heads/main")
    const scan = await scanCustody(store.root, [component], [join(store.root, ".git", "objects")], [], {
      sidecarDir,
    })
    expect(scan.status).toBe("pass")
    expect(scan.witnessCount).toBe(1)
    expect(scan.witnesses).toHaveLength(1)
    expect(scan.witnesses[0]).toMatchObject({ ref: "refs/heads/main", tip: store.head })
    expect(scan.witnesses[0]!.graphDigest).toMatch(/^[0-9a-f]{64}$/u)
    expect(await sidecarText(scan, "witness")).toEqual([
      `${store.head}\t.git\t${join(store.root, ".git", "objects")}\trefs/heads/main\t${store.head}`,
    ])
    expect(scan.missing).toEqual([])
  })

  test("an OID reachable only inside a ref's closure is found through the merge, not by tip equality", async () => {
    const store = repoWithCommit("git-super-custody-")
    const sidecarDir = tmp("git-super-custody-sidecars-")
    const component = await componentOf([store.tree], sidecarDir, "owned")
    const scan = await scanCustody(store.root, [component], [join(store.root, ".git", "objects")], [], {
      sidecarDir,
    })
    expect(scan.status).toBe("pass")
    expect(scan.witnessCount).toBe(1)
    // The witness identity is the ref whose closure carries the tree, whose tip is NOT the tree.
    expect(scan.witnesses[0]).toMatchObject({ ref: "refs/heads/main", tip: store.head })
  })

  test("two at-risk OIDs witnessed by one ref collapse to a single distinct identity", async () => {
    const store = repoWithCommit("git-super-custody-")
    const sidecarDir = tmp("git-super-custody-sidecars-")
    const component = await componentOf([store.head, store.tree], sidecarDir, "owned")
    const scan = await scanCustody(store.root, [component], [join(store.root, ".git", "objects")], [], {
      sidecarDir,
    })
    expect(scan.status).toBe("pass")
    expect(scan.witnessCount).toBe(2)
    expect(scan.witnesses).toHaveLength(1)
  })

  test("an at-risk OID no store reaches is blocked with component, OID, source and a sidecar", async () => {
    const store = repoWithCommit("git-super-custody-")
    const sidecarDir = tmp("git-super-custody-sidecars-")
    const orphan = "b".repeat(40)
    const component = await componentOf([orphan], sidecarDir, "owned")
    const scan = await scanCustody(store.root, [component], [join(store.root, ".git", "objects")], [], {
      sidecarDir,
    })
    expect(scan.status).toBe("blocked")
    expect(scan.missing[0]).toMatchObject({ component: ".git", oid: orphan, source: "owned" })
    expect(scan.detail).toContain(orphan)
    expect(scan.missingSidecar).toBeDefined()
    expect(await sidecarText(scan, "missing")).toEqual([`${orphan}\t.git\towned`])
  })

  test("a witness store borrowing into the removal set is unknown, never a witness", async () => {
    const removal = tmp("git-super-custody-removal-")
    const held = join(removal, "store", "objects")
    mkdirSync(join(held, "pack"), { recursive: true })
    const borrower = repoWithCommit("git-super-custody-borrower-")
    mkdirSync(join(borrower.root, ".git", "objects", "info"), { recursive: true })
    writeFileSync(join(borrower.root, ".git", "objects", "info", "alternates"), `${held}\n`)
    const sidecarDir = tmp("git-super-custody-sidecars-")
    const component = await componentOf([borrower.head], sidecarDir, "owned")
    const scan = await scanCustody(borrower.root, [component], [join(borrower.root, ".git", "objects")], [removal], {
      sidecarDir,
    })
    expect(scan.status).toBe("unknown")
    expect(scan.detail).toContain("removal set")
  })

  test("an fsck failure in a witness store is unknown, never custody", async () => {
    const store = repoWithCommit("git-super-custody-")
    const sidecarDir = tmp("git-super-custody-sidecars-")
    const component = await componentOf([store.head], sidecarDir, "owned")
    const broken: GitRun = (args, options) =>
      args.includes("fsck") ? { code: 1, stdout: "", stderr: "missing blob" } : defaultGitRun(args, options)
    const scan = await scanCustody(store.root, [component], [join(store.root, ".git", "objects")], [], {
      sidecarDir,
      run: broken,
    })
    expect(scan.status).toBe("unknown")
    expect(scan.detail).toContain("fsck --full failed")
  })

  test("a store that is not a Git object directory is unknown", async () => {
    const store = repoWithCommit("git-super-custody-")
    const sidecarDir = tmp("git-super-custody-sidecars-")
    const component = await componentOf([store.head], sidecarDir, "owned")
    const notAStore = tmp("git-super-custody-not-a-store-")
    const scan = await scanCustody(store.root, [component], [notAStore], [], { sidecarDir })
    expect(scan.status).toBe("unknown")
    expect(scan.detail).toContain("not a Git object directory")
  })

  test("fsck gets the custody bound as a hard child deadline, so a hung git is unknown, not a block", async () => {
    const store = repoWithCommit("git-super-custody-")
    const sidecarDir = tmp("git-super-custody-sidecars-")
    const component = await componentOf([store.head], sidecarDir, "owned")
    const seen: Array<{ args: readonly string[]; timeoutMs: number | undefined }> = []
    const running: GitRun = (args, options) => {
      seen.push({ args, timeoutMs: options?.timeoutMs })
      if (args.includes("fsck")) {
        return { code: 1, stdout: "", stderr: "git fsck timed out after 300000 ms", timedOut: true }
      }
      return defaultGitRun(args, options)
    }
    const scan = await scanCustody(store.root, [component], [join(store.root, ".git", "objects")], [], {
      sidecarDir,
      run: running,
    })
    expect(scan.status).toBe("unknown")
    expect(scan.detail).toContain("fsck")
    const fsck = seen.find((entry) => entry.args.includes("fsck"))
    expect(fsck?.timeoutMs).toBe(300_000)
  })

  test("a witness for-each-ref that exits 0 with stderr is unknown, never custody", async () => {
    const store = repoWithCommit("git-super-custody-")
    const sidecarDir = tmp("git-super-custody-sidecars-")
    const component = await componentOf([store.head], sidecarDir, "owned")
    const warned: GitRun = (args, options) =>
      args.includes("for-each-ref")
        ? {
            code: 0,
            stdout: `refs/heads/main\t${store.head}\n`,
            stderr: "error: unable to normalize alternate object path: /gone",
          }
        : defaultGitRun(args, options)
    const scan = await scanCustody(store.root, [component], [join(store.root, ".git", "objects")], [], {
      sidecarDir,
      run: warned,
    })
    expect(scan.status).toBe("unknown")
    expect(scan.detail).toContain("stderr")
  })
})
