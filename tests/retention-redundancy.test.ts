/**
 * @failure A retained copy whose every ref tip a live remote advertisement reaches still pays a witness fsck walk; or a
 *          copy is read as redundant because a FROZEN refs/remotes entry said so rather than a live advertisement.
 * @level l1
 * @consumer Yrd retained-module store sweep batch (#34127) through git-super retention verify (#37792, @cto 1a773179)
 * @reach fs-walk <fixture-only: mkdtempSync(tmpdir()) repositories built by each case>
 * @testonly none
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { defaultGitRun, type ComponentContents, type GitRun, type RefObservations } from "../src/retention-contents.ts"
import { CustodyRunScope, proveRemoteRedundancy } from "../src/retention-custody.ts"

const environment: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Git Super Test",
  GIT_AUTHOR_EMAIL: "git-super@example.test",
  GIT_COMMITTER_NAME: "Git Super Test",
  GIT_COMMITTER_EMAIL: "git-super@example.test",
  GIT_TERMINAL_PROMPT: "0",
}

function git(repo: string, args: readonly string[]): string {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env: environment })
  if (result.status !== 0) throw new Error(`${result.stderr || `git ${args.join(" ")} failed`} in ${repo}`)
  return result.stdout.trim()
}

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A remote with `main` at B (a child of A), and a clone that holds every object the remote advertises. */
function storeFor(
  prefix: string,
): Readonly<{ root: string; remote: string; store: string; first: string; second: string }> {
  const root = mkdtempSync(join(tmpdir(), `git-super-${prefix}-`))
  roots.push(root)
  const remote = join(root, "remote")
  git(root, ["init", "-q", "-b", "main", remote])
  writeFileSync(join(remote, "dep.ts"), "export const dep = 1\n")
  git(remote, ["add", "dep.ts"])
  git(remote, ["commit", "-q", "-m", "first"])
  const first = git(remote, ["rev-parse", "HEAD"])
  writeFileSync(join(remote, "dep.ts"), "export const dep = 2\n")
  git(remote, ["commit", "-q", "-am", "second"])
  const second = git(remote, ["rev-parse", "HEAD"])
  const store = join(root, "store")
  git(root, ["clone", "-q", remote, store])
  return { root, remote, store, first, second }
}

function componentAt(gitDir: string): ComponentContents {
  return {
    component: "vendor/dep",
    gitDir,
    effective: 0,
    independent: 0,
    atRisk: 0,
    atRiskSidecar: { path: join(gitDir, "at-risk.txt"), sha256: "", bytes: 0, count: 0 },
    missingRoots: 0,
    missingRootsSample: [],
    elapsedMs: 0,
  }
}

function prove(
  store: string,
  options: Readonly<{ run?: GitRun; observations?: RefObservations; scope?: CustodyRunScope }> = {},
) {
  // The census reads the component's GIT DIRECTORY, exactly as the live census adapter supplies it.
  const gitDir = join(store, ".git")
  return proveRemoteRedundancy({
    copyRoot: store,
    component: componentAt(gitDir),
    run: options.run ?? defaultGitRun,
    remaining: () => Number.POSITIVE_INFINITY,
    observations: options.observations ?? new Map(),
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    clock: () => Date.parse("2026-11-23T00:00:00.000Z"),
  })
}

describe("retention redundancy against a live remote snapshot (#37792)", () => {
  // @cto 1a773179: "no local refs at all = trivially redundant".
  it("proves a copy with no local ref at all redundant without asking ancestry", async () => {
    const fixture = storeFor("redundant-empty")
    git(fixture.store, ["update-ref", "-d", "refs/heads/main"])
    const outcome = await prove(fixture.store)
    expect(outcome).toMatchObject({
      status: "redundant",
      proof: { snapshotAt: "2026-11-23T00:00:00.000Z", reached: [] },
    })
  })

  // @cto 1a773179: "every non-remote ref tip must be reachable from that snapshot", and the receipt names the ref.
  it("names the advertised ref that reaches a local branch published under its own name", async () => {
    const fixture = storeFor("redundant-named")
    git(fixture.remote, ["branch", "release", fixture.first])
    git(fixture.store, ["fetch", "-q", "origin", "release:refs/heads/release"])
    const outcome = await prove(fixture.store)
    expect(outcome).toMatchObject({ status: "redundant" })
    if (outcome.status !== "redundant") return
    expect(outcome.proof.reached).toEqual(
      expect.arrayContaining([{ ref: "refs/heads/release", tip: fixture.first, remoteRef: "refs/heads/release" }]),
    )
  })

  // A local branch behind the advertised branch tip is reachable from it by ancestry, not by name.
  it("proves a local branch whose tip is an ancestor of the advertised tip", async () => {
    const fixture = storeFor("redundant-ancestor")
    git(fixture.store, ["update-ref", "refs/heads/main", fixture.first])
    const outcome = await prove(fixture.store)
    expect(outcome).toMatchObject({ status: "redundant" })
    if (outcome.status !== "redundant") return
    expect(outcome.proof.reached).toEqual(
      expect.arrayContaining([{ ref: "refs/heads/main", tip: fixture.first, remoteRef: "refs/heads/main" }]),
    )
  })

  // A branch pushed under its OWN name has merely moved; the same-named advertised ref is asked first, so a remote
  // carrying thousands of unrelated refs still finds the answer without walking the whole advertisement.
  it("finds a branch pushed under its own name in an advertisement with many unrelated refs", async () => {
    const fixture = storeFor("redundant-samename")
    git(fixture.remote, ["branch", "topic", fixture.second])
    for (let index = 0; index < 80; index += 1) {
      // Every unrelated ref points at the LATER commit, so exact equality cannot answer: only ancestry can.
      git(fixture.remote, ["branch", `side-${String(index)}`, fixture.second])
    }
    // The store's only local ref is its own branch, still at the tip it had before the push.
    git(fixture.store, ["update-ref", "refs/heads/topic", fixture.first])
    git(fixture.store, ["update-ref", "-d", "refs/heads/main"])
    const outcome = await prove(fixture.store)
    expect(outcome).toMatchObject({ status: "redundant" })
    if (outcome.status !== "redundant") return
    expect(outcome.proof.reached).toEqual([
      { ref: "refs/heads/topic", tip: fixture.first, remoteRef: "refs/heads/topic" },
    ])
    expect(outcome.proof.advertisedRefs).toBeGreaterThan(80)
  })

  // The tip is not published anywhere the snapshot names, so the entry keeps the witness walk it had before.
  it("leaves a tip the snapshot never advertised unproven", async () => {
    const fixture = storeFor("redundant-unpublished")
    writeFileSync(join(fixture.store, "local.ts"), "export const local = 1\n")
    git(fixture.store, ["add", "local.ts"])
    git(fixture.store, ["commit", "-q", "-m", "local only"])
    const outcome = await prove(fixture.store)
    expect(outcome.status).toBe("unproven")
    if (outcome.status !== "unproven") return
    expect(outcome.detail).toContain("reachable from none")
  })

  // @cto 2026-11-25: the order decides how soon a proof is met, never whether it is met. The same fixture proves the
  // same tip with the proving ref ranked first (refs/heads/main) and ranked last (refs/remotes/upstream/main), each
  // behind an unrelated branch that ranks ahead of it.
  it("reaches the same verdict whichever end of the order the proving ref sits at", async () => {
    const early = storeFor("ordered-early")
    const late = storeFor("ordered-late")
    for (const fixture of [early, late]) {
      // An advertised branch ranked ahead of everything, holding a commit that cannot reach the tip.
      git(fixture.remote, ["checkout", "-q", "--orphan", "side"])
      writeFileSync(join(fixture.remote, "side.ts"), "export const side = 1\n")
      git(fixture.remote, ["add", "side.ts"])
      git(fixture.remote, ["commit", "-q", "-m", "unrelated"])
      git(fixture.remote, ["checkout", "-q", "main"])
      // The store holds its own branch one commit behind the advertised tip, so only ancestry can prove it.
      git(fixture.store, ["update-ref", "refs/heads/main", fixture.first])
    }
    // The late fixture advertises the tip ONLY under the last-ranked namespace.
    git(late.remote, ["update-ref", "refs/remotes/upstream/main", late.second])
    git(late.remote, ["update-ref", "-d", "refs/heads/main"])
    const earlyOutcome = await prove(early.store)
    const lateOutcome = await prove(late.store)
    expect(earlyOutcome.status).toBe("redundant")
    expect(lateOutcome.status).toBe("redundant")
    if (earlyOutcome.status !== "redundant" || lateOutcome.status !== "redundant") return
    expect(earlyOutcome.proof.reached).toEqual([
      { ref: "refs/heads/main", tip: early.first, remoteRef: "refs/heads/main" },
    ])
    expect(lateOutcome.proof.reached).toEqual([
      { ref: "refs/heads/main", tip: late.first, remoteRef: "refs/remotes/upstream/main" },
    ])
  })

  // @cto 2026-11-25: a tip nothing reaches is answered only after EVERY candidate is walked, so the verdict stays
  // unknown and the entry keeps its witness proof — never a partial walk reported as "no proof exists".
  it("walks every advertised ref before leaving a tip with no proving ref unproven", async () => {
    const fixture = storeFor("ordered-nothing")
    writeFileSync(join(fixture.store, "local.ts"), "export const local = 1\n")
    git(fixture.store, ["add", "local.ts"])
    git(fixture.store, ["commit", "-q", "-m", "local only"])
    for (let index = 0; index < 40; index += 1) {
      git(fixture.remote, ["update-ref", `refs/heads/side-${String(index)}`, fixture.second])
    }
    const outcome = await prove(fixture.store)
    expect(outcome.status).toBe("unproven")
    if (outcome.status !== "unproven") return
    expect(outcome.detail).toContain("reachable from none")
    // "reachable from none of N" is the full walk; the truncated bound reads "was asked of the first 64".
    expect(outcome.detail).not.toContain("only;")
  })

  // @cto 1a773179: reachability is asked of the snapshot, "never the store's frozen refs/remotes".
  it("does not let a frozen refs/remotes entry decide redundancy", async () => {
    const fixture = storeFor("redundant-frozen")
    writeFileSync(join(fixture.store, "local.ts"), "export const local = 1\n")
    git(fixture.store, ["add", "local.ts"])
    git(fixture.store, ["commit", "-q", "-m", "local only"])
    const unpublished = git(fixture.store, ["rev-parse", "HEAD"])
    // The store's own frozen remote-tracking ref claims this tip is origin's; the live remote never advertised it.
    git(fixture.store, ["update-ref", "refs/remotes/origin/topic", unpublished])
    git(fixture.store, ["branch", "topic", unpublished])
    git(fixture.store, ["update-ref", "-d", "refs/heads/main"])
    const outcome = await prove(fixture.store)
    expect(outcome.status).toBe("unproven")
    if (outcome.status !== "unproven") return
    expect(outcome.detail).toContain("refs/heads/topic")
    expect(outcome.detail).toContain("reachable from none")
  })

  // A ref an ancestry proof cannot speak for keeps the witness path instead of being dropped in silence.
  it("refuses a ref that names a non-commit object", async () => {
    const fixture = storeFor("redundant-blob")
    const run: GitRun = (args, options) => {
      const result = defaultGitRun(args, options)
      if (typeof result !== "object" || !("code" in result)) return result
      if (!args.includes("for-each-ref") || result.code !== 0) return result
      return { ...result, stdout: `${result.stdout}refs/heads/weird\t${fixture.first}\tblob\n` }
    }
    const outcome = await prove(fixture.store, { run })
    expect(outcome.status).toBe("unproven")
    if (outcome.status !== "unproven") return
    expect(outcome.detail).toContain("names a blob")
  })

  // @cto 2026-11-26: the whole advertisement is asked, so a proving ref that ranks past the old 64-candidate bound
  // still proves. Measured on the estate: both unproven components in a 50-entry sample were exactly this case
  // ("first 64 of 4,578" and "first 64 of 7,662"), and one unprovable component sends its entry to an 840 s fsck.
  it("proves a tip whose proving ref ranks past the old 64-candidate bound", async () => {
    const fixture = storeFor("full-walk")
    // An unrelated commit the store also holds, so all 80 side refs are real, askable candidates.
    git(fixture.remote, ["checkout", "-q", "--orphan", "side"])
    writeFileSync(join(fixture.remote, "side.ts"), "export const side = 1\n")
    git(fixture.remote, ["add", "side.ts"])
    git(fixture.remote, ["commit", "-q", "-m", "unrelated"])
    const orphan = git(fixture.remote, ["rev-parse", "HEAD"])
    git(fixture.remote, ["checkout", "-q", "main"])
    for (let index = 0; index < 80; index += 1) {
      git(fixture.remote, ["update-ref", `refs/heads/side-${String(index)}`, orphan])
    }
    // The tip is advertised ONLY under the last-ranked namespace, behind 80 branches that do not reach it.
    git(fixture.remote, ["update-ref", "refs/remotes/upstream/main", fixture.second])
    git(fixture.remote, ["update-ref", "-d", "refs/heads/main"])
    git(fixture.store, ["update-ref", "refs/heads/main", fixture.first])
    git(fixture.store, ["fetch", "-q", "origin", "refs/heads/side-0:refs/heads/side-0"])
    const outcome = await prove(fixture.store)
    expect(outcome.status).toBe("redundant")
    if (outcome.status !== "redundant") return
    // The side branch fetched into the store proves too; the one under test is the tip behind the 80 candidates.
    expect(outcome.proof.reached).toEqual(
      expect.arrayContaining([{ ref: "refs/heads/main", tip: fixture.first, remoteRef: "refs/remotes/upstream/main" }]),
    )
    expect(outcome.proof.advertisedRefs).toBeGreaterThan(64)
  })
})
