/**
 * @failure Gate 5 accepts an alternate target, `cat-file -e`, a transient reflog, a witness store
 * that borrows from the removal set, or a successful git query that wrote to stderr as durable
 * custody for an at-risk object; or it holds a whole reachable set in memory instead of merging.
 * @level l1
 * @consumer the read-only retention verifier, gate 5; #27443(b)
 * @testonly none
 * @reach fs-walk <fixture-only: counts lines in the scan's own temporary sidecar directory>
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { defaultGitRun, defaultGitStream, type ComponentContents, type GitRun } from "../src/retention-contents.ts"
import { CustodyIndexScope, DEFAULT_CUSTODY_BOUNDS, scanCustody, type CustodyScan } from "../src/retention-custody.ts"
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
  types: Readonly<Record<string, string>> = {},
): Promise<ComponentContents> {
  const writer = new SidecarWriter(sidecarDir, "txt")
  for (const oid of [...atRiskOids].sort()) writer.add(`${oid}\t${types[oid] ?? "blob"}\t${refSource}`)
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

/** A bare remote, a working repository that publishes to it, and a primary that has not re-fetched. */
function publishedStores(prefix: string, remoteName = "origin.git"): { remote: string; work: string; primary: string } {
  const remote = join(tmp(prefix), remoteName)
  mkdirSync(remote, { recursive: true })
  git(remote, ["init", "-q", "--bare", "-b", "main"])
  const work = tmp(`${prefix}work-`)
  git(work, ["init", "-q", "-b", "main"])
  writeFileSync(join(work, "a.txt"), "alpha\n")
  git(work, ["add", "a.txt"])
  git(work, ["commit", "-q", "-m", "first"])
  git(work, ["push", "-q", remote, "main"])
  const parent = tmp(`${prefix}clone-`)
  git(parent, ["clone", "-q", remote, join(parent, "primary")])
  const primary = join(parent, "primary")
  expect(git(primary, ["rev-parse", "HEAD"])).toBe(git(work, ["rev-parse", "HEAD"]))
  return { remote, work, primary }
}

describe("retention custody scan — gate 5 (#27443(b))", () => {
  // AC #33010: a completed zero-risk input needs no witness read, but missing evidence,
  // an exhausted deadline, absent components or any real risk must never take that path.
  // Existing cases only cover nonempty custody and would not catch unrelated fsck work.
  test.each([
    { fault: "none", status: "pass", detail: "1 component(s); no at-risk objects; no witness needed" },
    { fault: "missing sidecar", status: "unknown", detail: "ENOENT" },
    { fault: "failed stat", status: "unknown", detail: "ENOTDIR" },
    { fault: "expired deadline", status: "unknown", detail: "shared proof deadline is exhausted" },
    { fault: "absent component", status: "unknown", detail: "witness proof reached" },
    { fault: "missing root", status: "unknown", detail: "witness proof reached" },
    { fault: "false zero", status: "unknown", detail: "witness proof reached" },
    { fault: "mixed risk", status: "unknown", detail: "witness proof reached" },
  ])("empty-risk custody preserves $fault evidence", async ({ fault, status, detail }) => {
    const store = repoWithCommit("git-super-custody-zero-")
    const sidecarDir = tmp("git-super-custody-zero-sidecars-")
    const empty = await componentOf([], sidecarDir)
    let component = empty
    if (fault === "missing sidecar") {
      component = { ...empty, atRiskSidecar: { ...empty.atRiskSidecar, path: join(sidecarDir, "absent") } }
    } else if (fault === "failed stat") {
      component = { ...empty, atRiskSidecar: { ...empty.atRiskSidecar, path: join(empty.atRiskSidecar.path, "child") } }
    } else if (fault === "missing root") {
      component = { ...empty, missingRoots: 1, missingRootsSample: [store.head] }
    } else if (fault === "false zero") {
      component = { ...(await componentOf([store.head], sidecarDir)), atRisk: 0 }
    }
    const components = fault === "absent component" ? [] : [component]
    if (fault === "mixed risk") components.push(await componentOf([store.head], sidecarDir))
    let witnessReads = 0
    const scan = await scanCustody(store.root, components, [join(store.root, ".git", "objects")], [], {
      sidecarDir,
      ...(fault === "expired deadline" ? { clock: () => 1, deadline: 1 } : {}),
      run: () => {
        witnessReads += 1
        throw new Error("witness proof reached")
      },
    })
    expect(scan.status).toBe(status)
    expect(scan.detail).toContain(detail)
    expect(scan.witnessCount).toBe(0)
    expect(scan.witnesses).toEqual([])
    if (fault === "none") expect(witnessReads).toBe(0)
  })

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
    const component = await componentOf([store.head], sidecarDir)
    let drained = false
    const scan = await scanCustody(store.root, [component], [join(store.root, ".git", "objects")], [], {
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
    const component = await componentOf([store.head], sidecarDir)
    let highWater = 0
    const scan = await scanCustody(store.root, [component], [join(store.root, ".git", "objects")], [], {
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

  // #34920 (@dev/5 cost plan r2): retention-mode witness indexing wrote every durable ref's FULL closure as its own
  // sidecar, so a component whose history is repeated across many refs and stores cost refs x closure (live: 1,423
  // sidecars, 100,042,074 lines for 484,541 distinct OIDs). The existing witness tests use one or two refs, where the
  // two shapes cannot be told apart.
  function sharedHistoryWitnesses(prefix: string, branches: number) {
    const store = repoWithCommit(prefix)
    for (let index = 0; index < 12; index += 1) {
      writeFileSync(join(store.root, `base-${index}.txt`), `base ${index}\n`)
      git(store.root, ["add", "."])
      git(store.root, ["commit", "-q", "-m", `base ${index}`])
    }
    const base = git(store.root, ["rev-parse", "HEAD"])
    const tips: string[] = []
    for (let index = 0; index < branches; index += 1) {
      git(store.root, ["checkout", "-q", "-b", `topic-${String(index).padStart(2, "0")}`, base])
      writeFileSync(join(store.root, `topic-${index}.txt`), `topic ${index}\n`)
      git(store.root, ["add", "."])
      git(store.root, ["commit", "-q", "-m", `topic ${index}`])
      tips.push(git(store.root, ["rev-parse", "HEAD"]))
    }
    git(store.root, ["checkout", "-q", "main"])
    const parent = tmp(`${prefix}clone-`)
    const clone = join(parent, "clone")
    git(parent, ["clone", "-q", "--no-local", store.root, clone])
    for (let index = 0; index < branches; index += 1) {
      const name = `topic-${String(index).padStart(2, "0")}`
      git(clone, ["branch", "-q", name, `origin/${name}`])
    }
    const stores = [join(store.root, ".git", "objects"), join(clone, ".git", "objects")]
    const distinct = new Set(
      git(store.root, ["rev-list", "--objects", "--all"])
        .split("\n")
        .map((line) => line.slice(0, 40)),
    )
    return { store, clone, stores, base, tips, distinct }
  }

  function sidecarLineTotal(dir: string, exclude: readonly string[]): number {
    let total = 0
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (!name.endsWith(".txt") || exclude.includes(path)) continue
      const text = readFileSync(path, "utf8")
      total += text === "" ? 0 : text.split("\n").filter((line) => line !== "").length
    }
    return total
  }

  test("witness index fragments hold each shared object about once; only the used witness gets a full certificate (#34920)", async () => {
    const fixture = sharedHistoryWitnesses("git-super-custody-shared-", 8)
    const sidecarDir = tmp("git-super-custody-shared-sidecars-")
    // One at-risk object, so exactly one witness is used while all 18 durable refs are considered.
    const component = await componentOf([fixture.base], sidecarDir, "owned")
    const scan = await scanCustody(fixture.store.root, [component], fixture.stores, [], { sidecarDir })
    expect(scan.status).toBe("pass")
    expect(scan.witnesses).toHaveLength(1)
    const used = scan.witnesses[0]!
    const certificate = join(sidecarDir, `${used.graphDigest}.txt`)
    const fullClosure = git(fixture.store.root, ["rev-list", "--objects", used.tip]).split("\n").length
    expect(
      readFileSync(certificate, "utf8")
        .split("\n")
        .filter((line) => line !== ""),
    ).toHaveLength(fullClosure)
    const fragments = sidecarLineTotal(sidecarDir, [
      component.atRiskSidecar.path,
      certificate,
      ...(scan.witnessSidecar === undefined ? [] : [scan.witnessSidecar.path]),
      ...(scan.missingSidecar === undefined ? [] : [scan.missingSidecar.path]),
    ])
    // 2 stores x (main + 8 topics) = 18 refs, each closure ~45 objects: full per-ref closures are ~800 lines. The
    // fragments plus the OID -> first-witness index are each about the ~60-object union; 3x the union bounds both.
    expect(fragments).toBeLessThanOrEqual(3 * fixture.distinct.size)
  })

  function commitOn(root: string, branch: string, file: string): string {
    git(root, ["checkout", "-q", "-b", branch])
    writeFileSync(join(root, file), `${branch}\n`)
    git(root, ["add", "."])
    git(root, ["commit", "-q", "-m", branch])
    const head = git(root, ["rev-parse", "HEAD"])
    git(root, ["checkout", "-q", "main"])
    return head
  }

  /** Each case is two or more witness stores and an at-risk set; `blocked` names OIDs no durable ref reaches. */
  function custodyCase(kind: string): { root: string; stores: string[]; atRisk: string[]; blocked: string[] } {
    const fixture = sharedHistoryWitnesses(`git-super-custody-case-${kind}-`, 5)
    const a = fixture.store.root
    const b = fixture.clone
    const atRisk = [fixture.base, ...fixture.tips, fixture.store.tree]
    const stores = [...fixture.stores]
    const blocked: string[] = []
    if (kind === "earlier tip absent") {
      atRisk.push(commitOn(a, "only-a", "only-a.txt"), commitOn(b, "only-b", "only-b.txt"))
    } else if (kind === "shared alternates") {
      const parent = tmp("git-super-custody-case-alternates-")
      const shared = join(parent, "shared")
      git(parent, ["clone", "-q", "--shared", a, shared])
      git(shared, ["branch", "-q", "topic-01", "origin/topic-01"])
      atRisk.push(commitOn(shared, "alt-only", "alt-only.txt"))
      stores.push(join(shared, ".git", "objects"))
    } else if (kind === "disjoint histories") {
      const other = repoWithCommit("git-super-custody-case-disjoint-")
      atRisk.push(other.head, other.tree, commitOn(other.root, "other-topic", "other.txt"))
      stores.push(join(other.root, ".git", "objects"))
    } else if (kind === "tag tree and blob refs") {
      git(a, ["tag", "-a", "-m", "annotated", "v1", fixture.tips[2]!])
      const lonely = spawnSync("git", ["hash-object", "-w", "--stdin"], {
        cwd: a,
        input: "lonely blob\n",
        encoding: "utf8",
        env: environment,
      }).stdout.trim()
      git(a, ["update-ref", "refs/tags/tree-ref", fixture.store.tree])
      git(a, ["update-ref", "refs/tags/blob-ref", lonely])
      atRisk.push(git(a, ["rev-parse", "refs/tags/v1"]), lonely)
    } else if (kind === "distinct traversal contexts") {
      // A replace ref rewrites b's traversal; the generic runner honours it, so b must not subtract across stores.
      git(b, ["replace", fixture.tips[1]!, fixture.tips[3]!])
    } else if (kind === "blocked") {
      const dangling = spawnSync("git", ["hash-object", "-w", "--stdin"], {
        cwd: a,
        input: "no ref reaches me\n",
        encoding: "utf8",
        env: environment,
      }).stdout.trim()
      atRisk.push(dangling)
      blocked.push(dangling)
    }
    return { root: a, stores, atRisk: [...new Set(atRisk)], blocked }
  }

  // AC (@cto 34920-witness-index-direction item 4): every at-risk object's chosen store/ref/tip, the emitted
  // graphDigest and the verdict equal the old full-closure algorithm, computed here straight from git.
  test.each([
    "shared history",
    "earlier tip absent",
    "shared alternates",
    "disjoint histories",
    "tag tree and blob refs",
    "distinct traversal contexts",
    "blocked",
  ])("witness labels, graphDigest and verdict match the full-closure algorithm: %s (#34920)", async (kind) => {
    const fixture = custodyCase(kind)
    const sidecarDir = tmp("git-super-custody-label-sidecars-")
    const component = await componentOf(fixture.atRisk, sidecarDir, "owned")
    const scan = await scanCustody(fixture.root, [component], fixture.stores, [], { sidecarDir })
    // The full-closure algorithm: stores by realpath, refs by name, each ref's full closure in its own store (honouring
    // that store's replace refs, as the generic runner does); the first ref whose closure holds an OID is its witness.
    // #35062 (@cto 34920-shared-index-ruling-1931 §1): only independent commit tips are ranked (per store, the first
    // ref by name for each tip no other durable commit tip contains), and every noncommit ref is kept. `all` ranks
    // every durable ref: the coverage control the reduction must match exactly.
    const ranked: Array<{ store: string; ref: string; tip: string; closure: string[] }> = []
    const all: Array<{ closure: string[] }> = []
    for (const objects of fixture.stores.map((path) => realpathSync(path)).sort()) {
      const gitDir = join(objects, "..")
      const refs = git(gitDir, [
        "--git-dir",
        gitDir,
        "for-each-ref",
        "--format=%(refname)\t%(objectname)\t%(objecttype)",
      ])
        .split("\n")
        .filter((row) => /^refs\/(?:heads|tags)\//u.test(row))
        .map((row) => row.split("\t") as [string, string, string])
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      const commitRef = new Map<string, string>()
      for (const [ref, tip, type] of refs) if (type === "commit" && !commitRef.has(tip)) commitRef.set(tip, ref)
      const independent = new Set(
        commitRef.size > 1
          ? git(gitDir, ["--git-dir", gitDir, "merge-base", "--independent", ...commitRef.keys()]).split("\n")
          : commitRef.keys(),
      )
      for (const [ref, tip, type] of refs) {
        const closure = git(gitDir, ["--git-dir", gitDir, "rev-list", "--objects", tip])
          .split("\n")
          .map((line) => line.split(" ")[0]!)
        all.push({ closure })
        if (type !== "commit" || (independent.has(tip) && commitRef.get(tip) === ref)) {
          ranked.push({ store: objects, ref, tip, closure })
        }
      }
    }
    const witnessed = [...fixture.atRisk].sort().flatMap((oid) => {
      const first = ranked.find((entry) => entry.closure.includes(oid))
      return first === undefined ? [] : [{ oid, first }]
    })
    // Coverage is unchanged by the reduction: exactly the OIDs some durable ref reaches are witnessed.
    expect(witnessed.map(({ oid }) => oid)).toEqual(
      [...fixture.atRisk].sort().filter((oid) => all.some((entry) => entry.closure.includes(oid))),
    )
    expect(scan.status).toBe(fixture.blocked.length === 0 ? "pass" : "blocked")
    expect(scan.missing.map((target) => target.oid)).toEqual(fixture.blocked)
    expect(await sidecarText(scan, "witness")).toEqual(
      witnessed.map(({ oid, first }) => `${oid}\t.git\t${first.store}\t${first.ref}\t${first.tip}`),
    )
    const used = [
      ...new Map(witnessed.map(({ first }) => [`${first.store}\t${first.ref}\t${first.tip}`, first])).values(),
    ]
    expect(scan.witnesses).toEqual(
      used.map((entry) => ({
        store: entry.store,
        ref: entry.ref,
        tip: entry.tip,
        graphDigest: createHash("sha256")
          .update(`${[...entry.closure].sort().join("\n")}\n`)
          .digest("hex"),
      })),
    )
    if (kind === "distinct traversal contexts") {
      expect(scan.detail).toMatch(/without cross-store subtraction: .*replace refs present/u)
    }
  })

  // AC #35062 (@cto 35047-existing-scope-0158, "required proof"): two batch members sharing one witness index get
  // the same coverage, witnesses, typed loss and exact graphDigests as two scans that each build their own, the
  // index is built once, and a zero-risk member never reaches it. The existing rows build one index per scan, so
  // they cannot show a shared build answering differently for its second member.
  test.each([
    "shared history",
    "earlier tip absent",
    "shared alternates",
    "disjoint histories",
    "tag tree and blob refs",
    "distinct traversal contexts",
    "blocked",
  ])("one shared witness index serves two members exactly as two separate builds do: %s (#35062)", async (kind) => {
    const fixture = custodyCase(kind)
    let fsck = 0
    const run: GitRun = (args, options) => {
      if (args.includes("fsck")) fsck += 1
      return defaultGitRun(args, options)
    }
    const halves = [fixture.atRisk.filter((_, at) => at % 2 === 0), fixture.atRisk.filter((_, at) => at % 2 === 1)]
    const separate: CustodyScan[] = []
    for (const half of halves) {
      const sidecarDir = tmp("git-super-custody-separate-sidecars-")
      separate.push(
        await scanCustody(fixture.root, [await componentOf(half, sidecarDir)], fixture.stores, [], { sidecarDir, run }),
      )
    }
    const separateFsck = fsck
    fsck = 0
    const indexScope = new CustodyIndexScope(tmp("git-super-custody-shared-index-"))
    const shared: CustodyScan[] = []
    for (const half of halves) {
      const sidecarDir = tmp("git-super-custody-shared-sidecars-")
      shared.push(
        await scanCustody(fixture.root, [await componentOf(half, sidecarDir)], fixture.stores, [], {
          sidecarDir,
          run,
          indexScope,
        }),
      )
    }
    const zeroDir = tmp("git-super-custody-shared-zero-")
    const zero = await scanCustody(fixture.root, [await componentOf([], zeroDir)], fixture.stores, [], {
      sidecarDir: zeroDir,
      run,
      indexScope,
    })
    const stores = new Set(fixture.stores.map((store) => realpathSync(store))).size
    expect(separateFsck).toBe(2 * stores)
    expect(fsck).toBe(stores)
    expect(zero.status).toBe("pass")
    expect(zero.detail).toContain("no witness needed")
    for (const [at, alone] of separate.entries()) {
      const together = shared[at]!
      expect(together.status, together.detail).toBe(alone.status)
      expect(together.witnesses).toEqual(alone.witnesses)
      expect(together.witnessCount).toBe(alone.witnessCount)
      expect(together.missing).toEqual(alone.missing)
      expect(together.missingCount).toBe(alone.missingCount)
      expect(together.loss).toEqual(alone.loss)
      expect(await sidecarText(together, "witness")).toEqual(await sidecarText(alone, "witness"))
      expect(await sidecarText(together, "missing")).toEqual(await sidecarText(alone, "missing"))
    }
    expect(shared.flatMap((scan) => scan.missing.map((target) => target.oid)).sort()).toEqual(
      [...fixture.blocked].sort(),
    )
  })

  // AC #35062: a shared index whose file is emptied or removed after its build is unknown for the next member, never
  // a join against a smaller (or no) witness set. A per-scan index is never re-read, so no existing row reaches this.
  // "altered" keeps the size: one hex digit of an indexed OID flipped in place, so only the digest can tell (review2
  // REVISE on f2e10d08). Unchecked, the next member could pair an at-risk OID with a witness it never had.
  test.each(["emptied", "removed", "altered"])(
    "a shared witness index %s after its build is unknown for the next member",
    async (fault) => {
      const fixture = custodyCase("shared history")
      const indexDir = tmp("git-super-custody-shared-fault-")
      const indexScope = new CustodyIndexScope(indexDir)
      const firstDir = tmp("git-super-custody-shared-fault-first-")
      const first = await scanCustody(
        fixture.root,
        [await componentOf([fixture.atRisk[0]!], firstDir)],
        fixture.stores,
        [],
        {
          sidecarDir: firstDir,
          indexScope,
        },
      )
      expect(first.status, first.detail).toBe("pass")
      let altered = 0
      for (const name of readdirSync(indexDir)) {
        const path = join(indexDir, name)
        if (fault === "emptied") writeFileSync(path, "")
        else if (fault === "removed") rmSync(path)
        else {
          const before = readFileSync(path, "utf8")
          if (!/^[0-9a-f]{40}\t/u.test(before)) continue
          const after = (before[0] === "0" ? "1" : "0") + before.slice(1)
          writeFileSync(path, after)
          expect(statSync(path).size).toBe(Buffer.byteLength(before))
          altered += 1
        }
      }
      if (fault === "altered") expect(altered).toBeGreaterThan(0)
      const secondDir = tmp("git-super-custody-shared-fault-second-")
      const second = await scanCustody(
        fixture.root,
        [await componentOf([fixture.atRisk[1]!], secondDir)],
        fixture.stores,
        [],
        {
          sidecarDir: secondDir,
          indexScope,
        },
      )
      expect(second.status).toBe("unknown")
      expect(second.detail).toMatch(fault === "removed" ? /cannot be re-read/u : /no longer matches its reference/u)
      expect(second.witnesses).toEqual([])
    },
  )

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

  // #34920: the walk's timeout is clamped to the shared deadline, so a walk killed there ran out of shared time, not
  // its own 300 s bound. Two measurement runs ended this way and both reported "exceeded the 300000 ms bound".
  test.each([
    { killedBy: "the shared deadline", deadline: 50_000, reachableMs: 300_000, says: "shared proof deadline" },
    { killedBy: "its own walk bound", deadline: 900_000, reachableMs: 40_000, says: "exceeded the 40000 ms bound" },
  ])("a ref walk killed by $killedBy names that limit", async ({ deadline, reachableMs, says }) => {
    const store = repoWithCommit("git-super-custody-walk-limit-")
    const sidecarDir = tmp("git-super-custody-walk-limit-sidecars-")
    const component = await componentOf([store.head], sidecarDir)
    let clock = 0
    const scan = await scanCustody(store.root, [component], [join(store.root, ".git", "objects")], [], {
      sidecarDir,
      witnessPolicy: { targetBranch: "main" },
      bounds: { ...DEFAULT_CUSTODY_BOUNDS, reachableMs },
      clock: () => clock,
      deadline,
      stream(args, options) {
        if (!(args.includes("rev-list") && args.includes("--objects"))) return defaultGitStream(args, options)
        // The child runs until its (clamped) timeout and is killed there.
        clock += options?.timeoutMs ?? 0
        return {
          lines: (async function* () {})(),
          outcome: Promise.resolve({ code: 1, bytes: 0, lines: 0, stderr: "", timedOut: true, capped: false }),
        }
      },
    })
    expect(scan.status).toBe("unknown")
    expect(scan.detail).toContain(says)
    if (says.startsWith("shared")) expect(scan.detail).not.toContain("300000 ms bound")
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

  // 34787 (@cto 34787-component-retention-ruling correction 4): an owner discard must bind to the exact loss, so a
  // blocked gate 5 names it per component: the count by object type and the commit roots with their subjects. The
  // inline `missing` sample (first 100) alone cannot say which commits a discard would lose.
  test("a blocked scan names the loss: counts by type and the commit roots with subjects (34787)", async () => {
    const store = repoWithCommit("git-super-custody-loss-")
    git(store.root, ["switch", "-q", "--detach"])
    writeFileSync(join(store.root, "b.txt"), "beta\n")
    git(store.root, ["add", "b.txt"])
    git(store.root, ["commit", "-q", "-m", "local one"])
    const first = git(store.root, ["rev-parse", "HEAD"])
    writeFileSync(join(store.root, "b.txt"), "gamma\n")
    git(store.root, ["commit", "-q", "-am", "local two"])
    const second = git(store.root, ["rev-parse", "HEAD"])
    const blob = git(store.root, ["rev-parse", "HEAD:b.txt"])
    const sidecarDir = tmp("git-super-custody-loss-sidecars-")
    const component = await componentOf([first, second, blob], sidecarDir, "owned", {
      [first]: "commit",
      [second]: "commit",
    })
    // Only refs/heads/main is durable; the detached line is reachable from HEAD alone, which never witnesses.
    const scan = await scanCustody(store.root, [component], [join(store.root, ".git", "objects")], [], {
      sidecarDir,
    })
    expect(scan.status, scan.detail).toBe("blocked")
    expect(scan.missingCount).toBe(3)
    expect(scan.loss).toEqual([
      { component: ".git", count: 3, types: { blob: 1, commit: 2 }, roots: [{ oid: second, subject: "local two" }] },
    ])
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

  // #35062: the 05:12 dry run rebuilt a failing shared index once per member (~3.5 min each) for one fsck refusal.
  test("a shared witness index whose build failed fails the next member alike without rebuilding it", async () => {
    const fixture = custodyCase("shared history")
    let fsck = 0
    const broken: GitRun = (args, options) => {
      if (!args.includes("fsck")) return defaultGitRun(args, options)
      fsck += 1
      return { code: 1, stdout: "", stderr: "missing blob" }
    }
    const indexScope = new CustodyIndexScope(tmp("git-super-custody-failed-build-"))
    const scans: CustodyScan[] = []
    for (const oid of fixture.atRisk.slice(0, 2)) {
      const sidecarDir = tmp("git-super-custody-failed-build-member-")
      scans.push(
        await scanCustody(fixture.root, [await componentOf([oid], sidecarDir)], fixture.stores, [], {
          sidecarDir,
          run: broken,
          indexScope,
        }),
      )
    }
    expect(scans.map((scan) => scan.status)).toEqual(["unknown", "unknown"])
    expect(scans[1]!.detail).toBe(scans[0]!.detail)
    expect(scans[0]!.detail).toContain("fsck --full failed")
    expect(fsck).toBe(1)
    // A fresh scope (the held window, a later run) builds again and sees the recovery (@cto 0606 §2).
    const recoveredDir = tmp("git-super-custody-failed-build-recovered-")
    const recovered = await scanCustody(
      fixture.root,
      [await componentOf([fixture.atRisk[0]!], recoveredDir)],
      fixture.stores,
      [],
      { sidecarDir: recoveredDir, indexScope: new CustodyIndexScope(tmp("git-super-custody-failed-build-fresh-")) },
    )
    expect(recovered.status, recovered.detail).toBe("pass")
  })

  // AC #35062 (@cto 35062-empty-witness-go-0606 §1): a witness store whose complete, validated ref listing admits no
  // durable root can witness nothing, so it is named and its fsck is not run. The 05:12 dry run kept every at-risk
  // entry unknown because one empty scratch bare repo's fsck printed "No default references" on a successful exit.
  test.each(["a valid survivor witnesses", "only stores without durable refs"])(
    "a witness store with no admitted durable refs is named, never fscked, never a witness: %s",
    async (kind) => {
      const survivor = repoWithCommit("git-super-custody-nonwitness-survivor-")
      const empty = realpathSync(tmp("git-super-custody-nonwitness-empty-"))
      git(empty, ["init", "-q", "--bare"])
      const fsckIn: string[] = []
      const counting: GitRun = (args, options) => {
        if (args.includes("fsck")) fsckIn.push(args.find((arg) => arg.startsWith("--git-dir="))!.slice(10))
        return defaultGitRun(args, options)
      }
      const stores = [
        join(empty, "objects"),
        ...(kind === "a valid survivor witnesses" ? [join(survivor.root, ".git", "objects")] : []),
      ]
      const sidecarDir = tmp("git-super-custody-nonwitness-sidecars-")
      const component = await componentOf([survivor.head], sidecarDir, "owned", { [survivor.head]: "commit" })
      const scan = await scanCustody(survivor.root, [component], stores, [], { sidecarDir, run: counting })
      expect(scan.detail).toContain(`1 witness store(s) with no admitted durable refs; fsck not run: ${empty}`)
      expect(fsckIn).not.toContain(empty)
      expect(scan.witnesses.map((witness) => witness.store)).not.toContain(join(empty, "objects"))
      if (kind === "a valid survivor witnesses") {
        expect(scan.status, scan.detail).toBe("pass")
        expect(fsckIn).toEqual([realpathSync(join(survivor.root, ".git"))])
      } else {
        // Zero candidates never pass a nonempty risk set.
        expect(scan.status, scan.detail).toBe("blocked")
        expect(scan.missing.map((target) => target.oid)).toEqual([survivor.head])
      }
    },
  )

  // review2 REVISE on r4: a noncommit durable root is still an admitted root, so a store whose only ref tags a tree or
  // blob is fscked and witnesses; judging emptiness by commit roots alone would skip it.
  test.each(["tree", "blob"])(
    "a store whose only durable ref tags a %s is fscked and witnesses, never named a non-witness",
    async (kind) => {
      const holder = realpathSync(tmp("git-super-custody-noncommit-only-"))
      git(holder, ["init", "-q", "-b", "main"])
      writeFileSync(join(holder, "payload.txt"), "noncommit root\n")
      const blob = git(holder, ["hash-object", "-w", "payload.txt"])
      git(holder, ["add", "payload.txt"])
      const root = kind === "blob" ? blob : git(holder, ["write-tree"])
      git(holder, ["tag", `only-${kind}`, root])
      expect(git(holder, ["for-each-ref", "--format=%(refname) %(objecttype)"])).toBe(`refs/tags/only-${kind} ${kind}`)
      const fsckIn: string[] = []
      const counting: GitRun = (args, options) => {
        if (args.includes("fsck")) fsckIn.push(args.find((arg) => arg.startsWith("--git-dir="))!.slice(10))
        return defaultGitRun(args, options)
      }
      const sidecarDir = tmp("git-super-custody-noncommit-only-sidecars-")
      const component = await componentOf([root], sidecarDir, "owned", { [root]: kind })
      const scan = await scanCustody(holder, [component], [join(holder, ".git", "objects")], [], {
        sidecarDir,
        run: counting,
      })
      expect(scan.status, scan.detail).toBe("pass")
      expect(scan.witnesses).toEqual([expect.objectContaining({ ref: `refs/tags/only-${kind}`, tip: root })])
      expect(fsckIn).toEqual([join(holder, ".git")])
      expect(scan.detail).not.toContain("no admitted durable refs")
    },
  )

  test("under the publish policy a store with no local refs but a published target tip is still fscked", async () => {
    const { remote, work, primary } = publishedStores("git-super-custody-nonwitness-published-")
    writeFileSync(join(work, "b.txt"), "beta\n")
    git(work, ["add", "b.txt"])
    git(work, ["commit", "-q", "-m", "second"])
    const landed = git(work, ["rev-parse", "HEAD"])
    git(work, ["push", "-q", remote, "main"])
    git(primary, ["checkout", "-q", "--detach"])
    git(primary, ["update-ref", "-d", "refs/heads/main"])
    expect(git(primary, ["for-each-ref", "refs/heads", "refs/tags"])).toBe("")
    const fsckIn: string[] = []
    const counting: GitRun = (args, options) => {
      if (args.includes("fsck")) fsckIn.push(args.find((arg) => arg.startsWith("--git-dir="))!.slice(10))
      return defaultGitRun(args, options)
    }
    const sidecarDir = tmp("git-super-custody-nonwitness-published-sidecars-")
    const component = { ...(await componentOf([landed], sidecarDir, "reflog logs/HEAD")), gitDir: join(work, ".git") }
    const scan = await scanCustody(work, [component], [join(primary, ".git", "objects")], [], {
      sidecarDir,
      run: counting,
      witnessPolicy: { targetBranch: "main" },
    })
    expect(scan.status, scan.detail).toBe("pass")
    expect(scan.witnesses[0]).toMatchObject({ ref: "refs/heads/main", tip: landed })
    expect(fsckIn).toEqual([realpathSync(join(primary, ".git"))])
    expect(scan.detail).not.toContain("no admitted durable refs")
  })

  test("a witness store whose recorded core.worktree is gone is read detached and still witnesses (#34920)", async () => {
    const store = repoWithCommit("git-super-custody-")
    const sidecarDir = tmp("git-super-custody-sidecars-")
    const component = await componentOf([store.head], sidecarDir, "owned")
    // A retained module store: its checkout was removed, but its config still names it (live: vendor/brain8).
    const clone = tmp("git-super-custody-module-")
    git(clone, ["clone", "-q", "--no-hardlinks", store.root, "work"])
    const gitDir = join(clone, "work", ".git")
    git(clone, ["--git-dir", gitDir, "config", "core.worktree", "../../gone-checkout"])
    const scan = await scanCustody(store.root, [component], [join(gitDir, "objects")], [], { sidecarDir })
    expect(scan.detail).not.toContain("cannot chdir")
    expect(scan.status).toBe("pass")
    expect(scan.witnesses[0]).toMatchObject({ ref: "refs/heads/main", tip: store.head })
    // Detached is a command context only: the recorded worktree stays as evidence.
    expect(git(clone, ["config", "--file", join(gitDir, "config"), "core.worktree"])).toBe("../../gone-checkout")
  })

  test("a detached witness store missing an object is still unknown, never custody (#34920)", async () => {
    const store = repoWithCommit("git-super-custody-")
    const sidecarDir = tmp("git-super-custody-sidecars-")
    const component = await componentOf([store.head], sidecarDir, "owned")
    const clone = tmp("git-super-custody-module-")
    git(clone, ["clone", "-q", "--no-hardlinks", store.root, "work"])
    const gitDir = join(clone, "work", ".git")
    const blob = git(clone, ["--git-dir", gitDir, "rev-parse", "HEAD:a.txt"])
    git(clone, ["--git-dir", gitDir, "config", "core.worktree", "../../gone-checkout"])
    rmSync(join(gitDir, "objects", blob.slice(0, 2), blob.slice(2)), { force: true })
    const scan = await scanCustody(store.root, [component], [join(gitDir, "objects")], [], { sidecarDir })
    expect(scan.status).toBe("unknown")
    expect(scan.detail).toContain("fsck --full failed")
    expect(scan.detail).not.toContain("cannot chdir")
  })

  test("a failed core.worktree probe is unknown, never read as absence (#34920)", async () => {
    const store = repoWithCommit("git-super-custody-")
    const sidecarDir = tmp("git-super-custody-sidecars-")
    const component = await componentOf([store.head], sidecarDir, "owned")
    const broken: GitRun = (args, options) =>
      args.includes("core.worktree") ? { code: 3, stdout: "", stderr: "bad config" } : defaultGitRun(args, options)
    const scan = await scanCustody(store.root, [component], [join(store.root, ".git", "objects")], [], {
      sidecarDir,
      run: broken,
    })
    expect(scan.status).toBe("unknown")
    expect(scan.detail).toContain("config --get core.worktree failed")
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

  // AC #35062 (@cto 35062-vanished-witness-go-0445): a witness store removed after the estate scan (a worktree another
  // seat removed) is gone by ENOENT when custody resolves it. It is dropped from witness selection and named; it never
  // proves custody alone. Before this, every at-risk entry in the batch went unknown on that one ENOENT (04:31 run).
  test.each(["another witness survives", "the only witness is gone"])(
    "a witness store gone since the estate scan is named and never a witness: %s",
    async (kind) => {
      const lender = repoWithCommit("git-super-custody-vanish-lender-")
      const survivor = tmp("git-super-custody-vanish-survivor-")
      if (kind === "another witness survives") git(survivor, ["clone", "-q", "--no-local", lender.root, "copy"])
      else {
        git(survivor, ["init", "-q", "-b", "main", "copy"])
        writeFileSync(join(survivor, "copy", "b.txt"), "unrelated\n")
        git(join(survivor, "copy"), ["add", "b.txt"])
        git(join(survivor, "copy"), ["commit", "-q", "-m", "unrelated"])
      }
      const survivorStore = realpathSync(join(survivor, "copy", ".git", "objects"))
      const goneStore = join(lender.root, ".git", "objects")
      rmSync(lender.root, { recursive: true, force: true })
      const sidecarDir = tmp("git-super-custody-vanish-sidecars-")
      const component = await componentOf([lender.head], sidecarDir, "owned", { [lender.head]: "commit" })
      const scan = await scanCustody(join(survivor, "copy"), [component], [goneStore, survivorStore], [], {
        sidecarDir,
      })
      expect(scan.detail).toContain(
        `1 witness store(s) gone since the estate scan, not used as witnesses: ${goneStore}`,
      )
      expect(scan.witnesses.map((witness) => witness.store)).not.toContain(goneStore)
      if (kind === "another witness survives") {
        expect(scan.status, scan.detail).toBe("pass")
        expect(scan.witnesses).toEqual([
          expect.objectContaining({ store: survivorStore, ref: "refs/heads/main", tip: lender.head }),
        ])
      } else {
        expect(scan.status, scan.detail).toBe("blocked")
        expect(scan.missing).toEqual([expect.objectContaining({ oid: lender.head })])
      }
    },
  )

  test("a witness store gone before the next member is never reused from the shared index", async () => {
    const lender = repoWithCommit("git-super-custody-vanish-shared-")
    const survivor = tmp("git-super-custody-vanish-shared-survivor-")
    git(survivor, ["clone", "-q", "--no-local", lender.root, "copy"])
    const survivorStore = realpathSync(join(survivor, "copy", ".git", "objects"))
    const lenderStore = realpathSync(join(lender.root, ".git", "objects"))
    // Only the lender holds the second commit, so before it goes the lender is the sole witness for it.
    writeFileSync(join(lender.root, "c.txt"), "only here\n")
    git(lender.root, ["add", "c.txt"])
    git(lender.root, ["commit", "-q", "-m", "only here"])
    const onlyLender = git(lender.root, ["rev-parse", "HEAD"])
    const indexScope = new CustodyIndexScope(tmp("git-super-custody-vanish-shared-index-"))
    const stores = [lenderStore, survivorStore]
    const firstDir = tmp("git-super-custody-vanish-shared-first-")
    const first = await scanCustody(join(survivor, "copy"), [await componentOf([onlyLender], firstDir)], stores, [], {
      sidecarDir: firstDir,
      indexScope,
    })
    expect(first.status, first.detail).toBe("pass")
    expect(first.witnesses).toEqual([expect.objectContaining({ store: lenderStore })])
    rmSync(lender.root, { recursive: true, force: true })
    const secondDir = tmp("git-super-custody-vanish-shared-second-")
    const second = await scanCustody(
      join(survivor, "copy"),
      [await componentOf([onlyLender, lender.head], secondDir)],
      stores,
      [],
      {
        sidecarDir: secondDir,
        indexScope,
      },
    )
    // The surviving set changed, so the index is rebuilt from it: the gone lender's witness does not carry over.
    expect(second.status, second.detail).toBe("blocked")
    expect(second.missing.map((target) => target.oid)).toEqual([onlyLender])
    expect(second.witnesses.map((witness) => witness.store)).toEqual([survivorStore])
    expect(second.detail).toContain(`not used as witnesses: ${lenderStore}`)
  })

  test("a witness store that cannot be resolved for any reason but absence stays unknown", async () => {
    const store = repoWithCommit("git-super-custody-vanish-eacces-")
    const sidecarDir = tmp("git-super-custody-vanish-eacces-sidecars-")
    const component = await componentOf([store.head], sidecarDir, "owned")
    const fence = tmp("git-super-custody-vanish-fence-")
    git(fence, ["init", "-q", "-b", "main", "inner"])
    const fenced = join(fence, "inner", ".git", "objects")
    chmodSync(fence, 0o000)
    try {
      const scan = await scanCustody(store.root, [component], [join(store.root, ".git", "objects"), fenced], [], {
        sidecarDir,
      })
      expect(scan.status).toBe("unknown")
      expect(scan.detail).toMatch(/EACCES/u)
      expect(scan.detail).not.toContain("gone since the estate scan")
    } finally {
      chmodSync(fence, 0o700)
    }
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

  // What a component's remote publishes now decides durability, never this store's own copy of it.
  // The existing policy fixtures never configure a remote, so a stale local branch was untested.
  test("a branch published after the witness store's last fetch still witnesses the at-risk commit", async () => {
    const { remote, work, primary } = publishedStores("git-super-custody-published-")
    writeFileSync(join(work, "b.txt"), "beta\n")
    git(work, ["add", "b.txt"])
    git(work, ["commit", "-q", "-m", "second"])
    const landed = git(work, ["rev-parse", "HEAD"])
    git(work, ["push", "-q", remote, "main"])
    expect(git(primary, ["rev-parse", "HEAD"])).not.toBe(landed)
    const sidecarDir = tmp("git-super-custody-published-sidecars-")
    const component = {
      ...(await componentOf([landed], sidecarDir, "reflog logs/HEAD")),
      gitDir: join(work, ".git"),
    }
    const scan = await scanCustody(work, [component], [join(primary, ".git", "objects")], [], {
      sidecarDir,
      witnessPolicy: { targetBranch: "main" },
    })
    expect(scan.status).toBe("pass")
    expect(scan.witnessCount).toBe(1)
    expect(scan.witnesses[0]).toMatchObject({ ref: "refs/heads/main", tip: landed })
  })

  test("a remote that cannot be read is unknown and names the remote, never a fallback to local refs", async () => {
    const { work, primary } = publishedStores("git-super-custody-unreachable-")
    writeFileSync(join(work, "b.txt"), "beta\n")
    git(work, ["add", "b.txt"])
    git(work, ["commit", "-q", "-m", "second"])
    const landed = git(work, ["rev-parse", "HEAD"])
    const gone = join(tmp("git-super-custody-gone-"), "absent.git")
    git(primary, ["remote", "set-url", "origin", gone])
    const sidecarDir = tmp("git-super-custody-unreachable-sidecars-")
    const component = {
      ...(await componentOf([landed], sidecarDir)),
      gitDir: join(work, ".git"),
    }
    const scan = await scanCustody(work, [component], [join(primary, ".git", "objects")], [], {
      sidecarDir,
      witnessPolicy: { targetBranch: "main" },
    })
    expect(scan.status).toBe("unknown")
    expect(scan.detail).toContain(gone)
    expect(scan.witnessCount).toBe(0)
  })

  // A rebase rewrites the commit, so the published main never names the refused OID. The stable
  // patch-id is the only witness that commit ever gets; an unlanded patch must never earn it.
  test("a rebased-away at-risk commit passes by patch-id and records its landed twin", async () => {
    const { remote, work, primary } = publishedStores("git-super-custody-rebase-")
    git(work, ["switch", "-q", "-c", "side"])
    writeFileSync(join(work, "b.txt"), "beta\n")
    git(work, ["add", "b.txt"])
    git(work, ["commit", "-q", "-m", "side work"])
    const refused = git(work, ["rev-parse", "HEAD"])
    git(work, ["switch", "-q", "main"])
    // Main moves on, so the cherry-pick keeps the patch but changes the parent: a real rebase.
    writeFileSync(join(work, "a.txt"), "alpha\nmore\n")
    git(work, ["add", "a.txt"])
    git(work, ["commit", "-q", "-m", "main moves"])
    git(work, ["cherry-pick", refused])
    const landed = git(work, ["rev-parse", "HEAD"])
    expect(landed).not.toBe(refused)
    git(work, ["push", "-q", remote, "main"])
    const sidecarDir = tmp("git-super-custody-rebase-sidecars-")
    const component = {
      ...(await componentOf([refused], sidecarDir, "reflog logs/HEAD")),
      gitDir: join(work, ".git"),
    }
    const scan = await scanCustody(work, [component], [join(primary, ".git", "objects")], [], {
      sidecarDir,
      witnessPolicy: { targetBranch: "main" },
    })
    expect(scan.status).toBe("pass")
    expect(scan.rebased).toEqual([
      { component: ".git", oid: refused, landedOid: landed, ref: "refs/heads/main", tip: landed },
    ])
    expect(await sidecarText(scan, "missing")).toEqual([])
  })

  test("a patch that is nowhere on published main stays refused", async () => {
    const { remote, work, primary } = publishedStores("git-super-custody-unlanded-")
    git(work, ["switch", "-q", "-c", "side"])
    writeFileSync(join(work, "c.txt"), "gamma\n")
    git(work, ["add", "c.txt"])
    git(work, ["commit", "-q", "-m", "abandoned experiment"])
    const refused = git(work, ["rev-parse", "HEAD"])
    git(work, ["switch", "-q", "main"])
    git(work, ["push", "-q", remote, "main"])
    const sidecarDir = tmp("git-super-custody-unlanded-sidecars-")
    const component = {
      ...(await componentOf([refused], sidecarDir, "reflog logs/HEAD")),
      gitDir: join(work, ".git"),
    }
    const scan = await scanCustody(work, [component], [join(primary, ".git", "objects")], [], {
      sidecarDir,
      witnessPolicy: { targetBranch: "main" },
    })
    expect(scan.status).toBe("blocked")
    expect(scan.missing.map((entry) => entry.oid)).toEqual([refused])
    expect(scan.rebased).toEqual([])
  })

  // @cto 2026-11-11: `git patch-id --stable` strips whitespace, so a commit whose YAML difference was
  // indentation only earned a false "landed" twin and the removal would delete the only copy.
  // Measured on git 2.56.0 for this exact fixture: --stable 5491e9ce for both sides, --verbatim
  // 95f6a388 vs 8113dd41.
  test("a patch that differs from published main only in leading whitespace stays refused", async () => {
    const { remote, work, primary } = publishedStores("git-super-custody-verbatim-")
    git(work, ["switch", "-q", "-c", "side"])
    writeFileSync(join(work, "conf.yaml"), "key:\n  child: 1\n")
    git(work, ["add", "conf.yaml"])
    git(work, ["commit", "-q", "-m", "indented yaml"])
    const refused = git(work, ["rev-parse", "HEAD"])
    git(work, ["switch", "-q", "main"])
    writeFileSync(join(work, "conf.yaml"), "key:\nchild: 1\n")
    git(work, ["add", "conf.yaml"])
    git(work, ["commit", "-q", "-m", "same yaml, de-indented"])
    git(work, ["push", "-q", remote, "main"])
    const sidecarDir = tmp("git-super-custody-verbatim-sidecars-")
    const component = {
      ...(await componentOf([refused], sidecarDir, "reflog logs/HEAD")),
      gitDir: join(work, ".git"),
    }
    const scan = await scanCustody(work, [component], [join(primary, ".git", "objects")], [], {
      sidecarDir,
      witnessPolicy: { targetBranch: "main" },
    })
    expect(scan.status).toBe("blocked")
    expect(scan.rebased).toEqual([])
    expect(scan.missing.map((entry) => entry.oid)).toEqual([refused])
  })

  // The own read runs in the component copy and the landed read in the primary store. A store's diff
  // config must not change the hash of one patch: measured on git 2.56.0, the same rename commit hashes
  // b3ab7cce with rename detection on and 0a303f30 with diff.renames=false, which without a pinned read
  // would turn an exact rebase into a false refusal.
  test("a store's rename-detection config cannot turn an exact rebase into a refusal", async () => {
    const { remote, work, primary } = publishedStores("git-super-custody-pinned-")
    git(work, ["switch", "-q", "-c", "side"])
    git(work, ["mv", "a.txt", "renamed.txt"])
    git(work, ["commit", "-q", "-m", "rename a"])
    const refused = git(work, ["rev-parse", "HEAD"])
    git(work, ["switch", "-q", "main"])
    writeFileSync(join(work, "b.txt"), "beta\n")
    git(work, ["add", "b.txt"])
    git(work, ["commit", "-q", "-m", "main moves"])
    git(work, ["cherry-pick", refused])
    const landed = git(work, ["rev-parse", "HEAD"])
    expect(landed).not.toBe(refused)
    git(work, ["push", "-q", remote, "main"])
    git(primary, ["config", "diff.renames", "false"])
    git(primary, ["config", "diff.noprefix", "true"])
    const sidecarDir = tmp("git-super-custody-pinned-sidecars-")
    const component = {
      ...(await componentOf([refused], sidecarDir, "reflog logs/HEAD")),
      gitDir: join(work, ".git"),
    }
    const scan = await scanCustody(work, [component], [join(primary, ".git", "objects")], [], {
      sidecarDir,
      witnessPolicy: { targetBranch: "main" },
    })
    expect(scan.status).toBe("pass")
    expect(scan.rebased).toEqual([
      { component: ".git", oid: refused, landedOid: landed, ref: "refs/heads/main", tip: landed },
    ])
  })

  // Two closes of different environments share the primary store, and the proof now fetches into it.
  // Without this, a fetch racing another fetch could be assumed harmless rather than shown so.
  test("two concurrent custody scans against one primary store both pass and leave it intact", async () => {
    const { remote, work, primary } = publishedStores("git-super-custody-concurrent-")
    writeFileSync(join(work, "b.txt"), "beta\n")
    git(work, ["add", "b.txt"])
    git(work, ["commit", "-q", "-m", "second"])
    const landed = git(work, ["rev-parse", "HEAD"])
    git(work, ["push", "-q", remote, "main"])
    const first = tmp("git-super-custody-concurrent-a-")
    const second = tmp("git-super-custody-concurrent-b-")
    const store = [join(primary, ".git", "objects")]
    const [left, right] = await Promise.all([
      scanCustody(
        work,
        [{ ...(await componentOf([landed], first, "reflog logs/HEAD")), gitDir: join(work, ".git") }],
        store,
        [],
        { sidecarDir: first, witnessPolicy: { targetBranch: "main" } },
      ),
      scanCustody(
        work,
        [{ ...(await componentOf([landed], second, "reflog logs/HEAD")), gitDir: join(work, ".git") }],
        store,
        [],
        { sidecarDir: second, witnessPolicy: { targetBranch: "main" } },
      ),
    ])
    expect(left.status).toBe("pass")
    expect(right.status).toBe("pass")
    expect(left.witnesses[0]).toMatchObject({ ref: "refs/heads/main", tip: landed })
    expect(right.witnesses[0]).toMatchObject({ ref: "refs/heads/main", tip: landed })
    // Objects fetched for a read stay unreferenced, which is expected; what must not appear is damage.
    expect(git(primary, ["fsck", "--full", "--no-progress", "--no-dangling"])).toBe("")
  })

  // A candidate must be hashed on its complete patch: a commit that also changed another file is a
  // different patch, and matching its projection would record a landed twin that never carried this.
  test("a published commit that also changed another file is not this commit's landed twin", async () => {
    const { remote, work, primary } = publishedStores("git-super-custody-projection-")
    git(work, ["switch", "-q", "-c", "side"])
    writeFileSync(join(work, "b.txt"), "beta\n")
    git(work, ["add", "b.txt"])
    git(work, ["commit", "-q", "-m", "adds b only"])
    const refused = git(work, ["rev-parse", "HEAD"])
    git(work, ["switch", "-q", "main"])
    writeFileSync(join(work, "b.txt"), "beta\n")
    writeFileSync(join(work, "c.txt"), "gamma\n")
    git(work, ["add", "b.txt", "c.txt"])
    git(work, ["commit", "-q", "-m", "adds b and c"])
    const landed = git(work, ["rev-parse", "HEAD"])
    git(work, ["push", "-q", remote, "main"])
    const sidecarDir = tmp("git-super-custody-projection-sidecars-")
    const component = {
      ...(await componentOf([refused], sidecarDir, "reflog logs/HEAD")),
      gitDir: join(work, ".git"),
    }
    const scan = await scanCustody(work, [component], [join(primary, ".git", "objects")], [], {
      sidecarDir,
      witnessPolicy: { targetBranch: "main" },
    })
    expect(landed).not.toBe(refused)
    expect(scan.status).toBe("blocked")
    expect(scan.rebased).toEqual([])
    expect(scan.missing.map((entry) => entry.oid)).toEqual([refused])
  })

  test("a remote name containing a dot is read whole and its failure is unknown, not a local pass", async () => {
    const { work, primary } = publishedStores("git-super-custody-dotted-")
    writeFileSync(join(work, "b.txt"), "beta\n")
    git(work, ["add", "b.txt"])
    git(work, ["commit", "-q", "-m", "second"])
    const landed = git(work, ["rev-parse", "HEAD"])
    const gone = join(tmp("git-super-custody-dotted-gone-"), "absent.git")
    git(primary, ["remote", "remove", "origin"])
    git(primary, ["remote", "add", "mirror.one", gone])
    const sidecarDir = tmp("git-super-custody-dotted-sidecars-")
    const component = {
      ...(await componentOf([landed], sidecarDir)),
      gitDir: join(work, ".git"),
    }
    const scan = await scanCustody(work, [component], [join(primary, ".git", "objects")], [], {
      sidecarDir,
      witnessPolicy: { targetBranch: "main" },
    })
    expect(scan.status).toBe("unknown")
    expect(scan.detail).toContain("mirror.one")
    expect(scan.witnessCount).toBe(0)
  })

  test("two non-origin remotes leave no authority to choose, so the answer is unknown", async () => {
    const { work, primary } = publishedStores("git-super-custody-two-remotes-")
    writeFileSync(join(work, "b.txt"), "beta\n")
    git(work, ["add", "b.txt"])
    git(work, ["commit", "-q", "-m", "second"])
    const landed = git(work, ["rev-parse", "HEAD"])
    const gone = tmp("git-super-custody-two-remotes-gone-")
    git(primary, ["remote", "remove", "origin"])
    git(primary, ["remote", "add", "alpha", join(gone, "alpha.git")])
    git(primary, ["remote", "add", "beta", join(gone, "beta.git")])
    const sidecarDir = tmp("git-super-custody-two-remotes-sidecars-")
    const component = {
      ...(await componentOf([landed], sidecarDir)),
      gitDir: join(work, ".git"),
    }
    const scan = await scanCustody(work, [component], [join(primary, ".git", "objects")], [], {
      sidecarDir,
      witnessPolicy: { targetBranch: "main" },
    })
    expect(scan.status).toBe("unknown")
    expect(scan.detail).toContain("alpha")
    expect(scan.detail).toContain("beta")
    expect(scan.witnessCount).toBe(0)
  })

  // A remote URL that itself ends in `.url` once made the remote name swallow the value, so origin
  // vanished and a reachable, published environment read as unknown. The name now comes from a
  // listing of names, never from parsing around a value.
  test("a remote whose URL ends in .url is still origin and still witnesses", async () => {
    const { remote, work, primary } = publishedStores("git-super-custody-doturl-", "published.url")
    writeFileSync(join(work, "b.txt"), "beta\n")
    git(work, ["add", "b.txt"])
    git(work, ["commit", "-q", "-m", "second"])
    const landed = git(work, ["rev-parse", "HEAD"])
    git(work, ["push", "-q", remote, "main"])
    expect(git(primary, ["remote"])).toBe("origin")
    const sidecarDir = tmp("git-super-custody-doturl-sidecars-")
    const component = {
      ...(await componentOf([landed], sidecarDir, "reflog logs/HEAD")),
      gitDir: join(work, ".git"),
    }
    const scan = await scanCustody(work, [component], [join(primary, ".git", "objects")], [], {
      sidecarDir,
      witnessPolicy: { targetBranch: "main" },
    })
    expect(scan.status).toBe("pass")
    expect(scan.witnesses[0]).toMatchObject({ ref: "refs/heads/main", tip: landed })
  })
})
