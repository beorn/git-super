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
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { defaultGitRun, defaultGitStream, type ComponentContents, type GitRun } from "../src/retention-contents.ts"
import { scanCustody, type CustodyScan } from "../src/retention-custody.ts"
import { gitLineStream, RETENTION_STREAM_QUEUE_LINES, readLines, SidecarWriter } from "../src/retention-stream.ts"

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
  // AC: a killed/capped/failed/warning stream outranks its malformed partial row,
  // while a complete malformed stream stays malformed. Existing fixtures only emit valid OIDs.
  test.each([
    { fault: "timeout", code: 1, timedOut: true, capped: false, stderr: "", detail: "ms bound" },
    { fault: "cap", code: 1, timedOut: false, capped: true, stderr: "", detail: "OIDs exceeded" },
    {
      fault: "exit",
      code: 1,
      timedOut: false,
      capped: false,
      stderr: "failed child",
      detail: "failed in witness store",
    },
    {
      fault: "warning",
      code: 0,
      timedOut: false,
      capped: false,
      stderr: "ignored alternate",
      detail: "exited 0 with stderr",
    },
    {
      fault: "complete malformed",
      code: 0,
      timedOut: false,
      capped: false,
      stderr: "",
      detail: "malformed rev-list row",
    },
  ])("drains before classifying a $fault rev-list", async ({ detail, fault: _fault, ...outcome }) => {
    const store = repoWithCommit("git-super-custody-fault-")
    const sidecarDir = tmp("git-super-custody-fault-sidecars-")
    let drained = false
    const scan = await scanCustody(store.root, [], [join(store.root, ".git", "objects")], [], {
      sidecarDir,
      stream: () => ({
        lines: (async function* () {
          yield "partial"
          yield store.head
          drained = true
        })(),
        outcome: Promise.resolve({ ...outcome, bytes: 48, lines: 2 }),
      }),
    })
    expect(scan.status).toBe("unknown")
    expect(scan.detail).toContain(detail)
    expect(drained).toBe(true)
  })

  // AC: drain the real bounded producer before awaiting its outcome. The simple outcome
  // table cannot detect a producer blocked at the 2048-record queue before its read failure.
  test("drains a backpressured malformed rev-list and reports its native read failure", async () => {
    const store = repoWithCommit("git-super-custody-backpressure-")
    const sidecarDir = tmp("git-super-custody-backpressure-sidecars-")
    let highWater = 0
    const scan = await scanCustody(store.root, [], [join(store.root, ".git", "objects")], [], {
      sidecarDir,
      stream: () =>
        gitLineStream(["--version"], {
          onQueueHighWater: (depth) => {
            highWater = Math.max(highWater, depth)
          },
          stdout: (async function* () {
            yield Buffer.from("partial\n" + `${store.head}\n`.repeat(RETENTION_STREAM_QUEUE_LINES + 10))
            throw new Error("injected stdout read failure after queue")
          })(),
        }),
    })
    expect(scan.status).toBe("unknown")
    expect(scan.detail).toContain("failed in witness store")
    expect(scan.detail).toContain("stdout read failed")
    expect(highWater).toBe(RETENTION_STREAM_QUEUE_LINES)
  })

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

  test("complete-commit witness policy uses the actual component Git directory and exact target/pin refs", async () => {
    const store = repoWithCommit("git-super-custody-policy-")
    const unrelatedRoot = tmp("git-super-custody-policy-root-")
    const sidecarDir = tmp("git-super-custody-policy-sidecars-")
    const component = {
      ...(await componentOf([store.head], sidecarDir)),
      gitDir: join(store.root, ".git"),
    }
    const opts = {
      sidecarDir,
      witnessPolicy: { targetBranch: "release" },
    }
    const noPolicyRef = await scanCustody(unrelatedRoot, [component], [join(store.root, ".git", "objects")], [], opts)
    expect(noPolicyRef.status).toBe("blocked")
    git(store.root, ["update-ref", `refs/yrd/pins/${store.head}`, store.head])
    const pinned = await scanCustody(unrelatedRoot, [component], [join(store.root, ".git", "objects")], [], opts)
    expect(pinned.status).toBe("pass")
    expect(pinned.witnesses[0]).toMatchObject({ ref: `refs/yrd/pins/${store.head}`, tip: store.head })
  })

  // AC: redundant policy ancestors must fit the shared proof budget while preserving
  // complete positive custody. The existing small-ref fixtures never spend that budget.
  test("policy ancestor pins fit the shared deadline without repeating their complete graphs", async () => {
    const store = repoWithCommit("git-super-custody-policy-budget-")
    const sidecarDir = tmp("git-super-custody-policy-budget-sidecars-")
    const heads = [store.head]
    for (let index = 0; index < 6; index += 1) {
      const prior = heads.at(-1)!
      git(store.root, ["update-ref", `refs/git-super/pins/${prior}`, prior])
      writeFileSync(join(store.root, "a.txt"), `version ${index}\n`)
      git(store.root, ["commit", "-q", "-a", "-m", `version ${index}`])
      heads.push(git(store.root, ["rev-parse", "HEAD"]))
    }
    const head = heads.at(-1)!
    git(store.root, ["update-ref", `refs/git-super/pins/${head}`, head])
    const component = await componentOf([...heads, store.tree], sidecarDir)
    let clock = 0
    const scan = await scanCustody(store.root, [component], [join(store.root, ".git", "objects")], [], {
      sidecarDir,
      witnessPolicy: { targetBranch: "main" },
      clock: () => clock,
      deadline: 35_000,
      stream(args, options) {
        // Charge actual graph work through the existing clock seam, without sleeps.
        clock += 10_000
        return defaultGitStream(args, options)
      },
    })
    expect(scan.status, scan.detail).toBe("pass")
    expect(scan.witnessCount).toBe(heads.length + 1)
    expect(scan.missing).toEqual([])
    expect(scan.witnesses).toHaveLength(1)
    const witness = scan.witnesses[0]!
    expect(witness.tip).toBe(head)
    expect(git(store.root, ["show-ref", "--verify", "--hash", witness.ref])).toBe(head)
    const graph = git(store.root, ["rev-list", "--objects", head])
      .split("\n")
      .map((line) => line.split(" ")[0])
      .sort()
      .join("\n")
    expect(witness.graphDigest).toBe(createHash("sha256").update(`${graph}\n`).digest("hex"))
  })

  // AC: graph reduction must retain unrelated commits and noncommit policy refs;
  // generic retention is the unchanged coverage control, including a missing OID.
  test("policy graph reduction preserves branched, blob and annotated-tag custody", async () => {
    const store = repoWithCommit("git-super-custody-policy-values-")
    const sidecarDir = tmp("git-super-custody-policy-values-sidecars-")
    git(store.root, ["update-ref", `refs/git-super/pins/${store.head}`, store.head])
    git(store.root, ["switch", "-q", "-c", "side"])
    writeFileSync(join(store.root, "a.txt"), "side\n")
    git(store.root, ["commit", "-q", "-a", "-m", "side"])
    const side = git(store.root, ["rev-parse", "HEAD"])
    git(store.root, ["update-ref", `refs/git-super/pins/${side}`, side])
    git(store.root, ["switch", "-q", "main"])
    writeFileSync(join(store.root, "a.txt"), "main\n")
    git(store.root, ["commit", "-q", "-a", "-m", "main"])
    const main = git(store.root, ["rev-parse", "HEAD"])
    const blobPath = join(sidecarDir, "pinned-blob")
    writeFileSync(blobPath, "only this blob pin keeps me\n")
    const blob = git(store.root, ["hash-object", "-w", blobPath])
    git(store.root, ["update-ref", `refs/git-super/pins/${blob}`, blob])
    git(store.root, ["tag", "-a", "annotated", "-m", "annotation", store.head])
    const tag = git(store.root, ["rev-parse", "refs/tags/annotated"])
    git(store.root, ["update-ref", `refs/git-super/pins/${tag}`, tag])
    const component = await componentOf([main, side, blob, tag, "f".repeat(40)], sidecarDir)
    const stores = [join(store.root, ".git", "objects")]
    const control = await scanCustody(store.root, [component], stores, [], { sidecarDir })
    const scan = await scanCustody(store.root, [component], stores, [], {
      sidecarDir,
      witnessPolicy: { targetBranch: "main" },
    })
    expect(control.status, control.detail).toBe("blocked")
    expect(scan.status, scan.detail).toBe("blocked")
    expect(scan.witnessCount).toBe(4)
    expect(scan.missing).toEqual(control.missing)
    expect(scan.missingCount).toBe(1)
    expect(scan.witnesses).toHaveLength(4)
    expect(scan.witnesses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tip: main }),
        expect.objectContaining({ tip: side }),
        expect.objectContaining({ ref: `refs/git-super/pins/${blob}`, tip: blob }),
        expect.objectContaining({ ref: `refs/git-super/pins/${tag}`, tip: tag }),
      ]),
    )
  })

  // AC: an incomplete or foreign selected-Git answer is unknown, not a smaller
  // successful witness population. Existing rows exercise other Git commands.
  test.each(["", `${"f".repeat(40)}\n`])("an unproven independent-tip answer %j remains unknown", async (stdout) => {
    const store = repoWithCommit("git-super-custody-policy-unproven-")
    const sidecarDir = tmp("git-super-custody-policy-unproven-sidecars-")
    git(store.root, ["update-ref", `refs/git-super/pins/${store.head}`, store.head])
    writeFileSync(join(store.root, "a.txt"), "next\n")
    git(store.root, ["commit", "-q", "-a", "-m", "next"])
    const component = await componentOf([store.head], sidecarDir)
    const scan = await scanCustody(store.root, [component], [join(store.root, ".git", "objects")], [], {
      sidecarDir,
      witnessPolicy: { targetBranch: "main" },
      run: (args, options) =>
        args.includes("merge-base") ? { code: 0, stdout, stderr: "" } : defaultGitRun(args, options),
    })
    expect(scan.status, scan.detail).toBe("unknown")
    expect(scan.detail).toContain("independent")
    expect(scan.witnessCount).toBe(0)
  })

  test("an exhausted shared proof deadline is unknown before witness queries", async () => {
    const store = repoWithCommit("git-super-custody-deadline-")
    const sidecarDir = tmp("git-super-custody-deadline-sidecars-")
    const component = await componentOf([store.head], sidecarDir)
    const scan = await scanCustody(store.root, [component], [join(store.root, ".git", "objects")], [], {
      sidecarDir,
      deadline: 0,
      witnessPolicy: { targetBranch: "main" },
    })
    expect(scan.status).toBe("unknown")
    expect(scan.detail).toContain("shared proof deadline")
  })

  test("a shallow witness graph is unknown even when its refs and fsck pass", async () => {
    const store = repoWithCommit("git-super-custody-shallow-")
    const sidecarDir = tmp("git-super-custody-shallow-sidecars-")
    const component = await componentOf([store.head], sidecarDir)
    const shallow: GitRun = (args, options) =>
      args.includes("--is-shallow-repository")
        ? { code: 0, stdout: "true\n", stderr: "" }
        : defaultGitRun(args, options)
    const scan = await scanCustody(store.root, [component], [join(store.root, ".git", "objects")], [], {
      sidecarDir,
      run: shallow,
      witnessPolicy: { targetBranch: "main" },
    })
    expect(scan.status).toBe("unknown")
    expect(scan.detail).toContain("is shallow")
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
