/**
 * #27120 AC1. A private submodule store (`<admin dir>/modules/<name>`) is live Git storage inside a
 * worktree's deletion custody, so `worktree remove` refuses it (R2). The ruled retirement route is
 * operator-performed and the tool stays blind, which makes this verifier's whole job a metadata
 * question: do the store's refs and HEAD still equal what its remote advertises?
 *
 * The cases below are the ones the name table in the plan pins: the conventional-clone positive,
 * tracking-value drift, a deleted mapped source, a tracking ref for an unqueried remote, local-only
 * namespaces, a detached HEAD no advertised value carries, and the two ways this must never lie —
 * an unreachable remote is `unproven`, and no failure path may relay raw stderr or a private path.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, expect, test } from "vitest"
import {
  PRIVATE_STORE_GIT_REQUESTS,
  PRIVATE_STORE_NOT_COVERED,
  verifyPrivateStoreCandidate,
} from "../src/private-store-candidate.ts"
import { createLocalGitProcess, type GitProcess } from "../src/process.ts"
import { canonicalTmpdir, git } from "./fixture.ts"
import { runCli } from "../src/cli.ts"

function sink(): { output: string; write(value: string): void } {
  return {
    output: "",
    write(value: string) {
      this.output += value
    },
  }
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

type StoreFixture = Readonly<{
  root: string
  remote: string
  store: string
  first: string
  second: string
}>

/** A bare remote with two commits on `main`, and a bare store carrying origin's refspecs. */
function storeFixture(): StoreFixture {
  const root = mkdtempSync(join(canonicalTmpdir(), "git-super-private-store-"))
  roots.push(root)
  const work = join(root, "work")
  const remote = join(root, "remote.git")
  const store = join(root, "modules", "vendor", "brain8")
  git(root, "init", "-q", "-b", "main", work)
  writeFileSync(join(work, "vendor.txt"), "first\n")
  git(work, "add", "vendor.txt")
  git(work, "commit", "-qm", "first")
  const first = git(work, "rev-parse", "HEAD")
  writeFileSync(join(work, "vendor.txt"), "second\n")
  git(work, "commit", "-qam", "second")
  const second = git(work, "rev-parse", "HEAD")
  git(root, "init", "-q", "--bare", "-b", "main", remote)
  git(work, "remote", "add", "origin", remote)
  git(work, "push", "-q", "origin", "main")
  git(root, "init", "-q", "--bare", store)
  git(store, "remote", "add", "origin", remote)
  git(store, "fetch", "-q", "origin")
  return { root, remote, store, first, second }
}

/** The conventional clone shape the AC1 fixture must carry: the local branch plus origin's trackers. */
function conventionalClone(fixture: StoreFixture): void {
  git(fixture.store, "update-ref", "refs/heads/main", fixture.second)
  git(fixture.store, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
  git(fixture.store, "update-ref", "refs/remotes/origin/main", fixture.second)
}

test("the conventional clone shape is a candidate", async () => {
  const fixture = storeFixture()
  conventionalClone(fixture)
  const result = await verifyPrivateStoreCandidate({ store: fixture.store, checkout: join(fixture.root, "env") })
  expect(result.verdict).toBe("candidate")
  expect(result.reasons).toEqual([])
  expect(result.notCovered).toBe(PRIVATE_STORE_NOT_COVERED)
  expect(result.head).toMatchObject({ state: "symbolic" })
  const tracked = result.refs.find((row) => row.ref === "refs/remotes/origin/main")
  expect(tracked).toMatchObject({ mappedFrom: "refs/heads/main", state: "equal" })
  expect(result.refs.find((row) => row.ref === "refs/heads/main")).toMatchObject({ state: "equal" })
  expect(result.paths).toEqual([`'${join(fixture.root, "env")}'`, `'${fixture.store}'`])
})

test("a lagging tracking ref fails by name, so a fetch-and-recheck can clear it", async () => {
  const fixture = storeFixture()
  conventionalClone(fixture)
  git(fixture.store, "update-ref", "refs/remotes/origin/main", fixture.first)
  const result = await verifyPrivateStoreCandidate({ store: fixture.store })
  expect(result.verdict).toBe("not-a-candidate")
  expect(result.reasons.map((reason) => reason.code)).toEqual(["value-differs"])
  expect(result.reasons[0]?.message).toBe(
    "refs/remotes/origin/main: value differs from the advertised refs/heads/main (behind or diverged)",
  )
})

test("a tracking ref whose mapped source the remote no longer advertises is named", async () => {
  const fixture = storeFixture()
  conventionalClone(fixture)
  git(fixture.store, "update-ref", "refs/remotes/origin/gone", fixture.second)
  const result = await verifyPrivateStoreCandidate({ store: fixture.store })
  expect(result.verdict).toBe("not-a-candidate")
  expect(result.reasons.map((reason) => reason.code)).toEqual(["mapped-source-unadvertised"])
  expect(result.reasons[0]?.message).toContain("maps to refs/heads/gone")
})

test("a tracking ref for a remote the store does not configure is never mapped silently", async () => {
  const fixture = storeFixture()
  conventionalClone(fixture)
  git(fixture.store, "update-ref", "refs/remotes/elsewhere/main", fixture.second)
  const result = await verifyPrivateStoreCandidate({ store: fixture.store })
  expect(result.verdict).toBe("not-a-candidate")
  expect(result.reasons.map((reason) => reason.code)).toEqual(["tracking-unqueried-remote"])
})

test("local-only namespaces and a stash are not candidates", async () => {
  const fixture = storeFixture()
  conventionalClone(fixture)
  git(fixture.store, "update-ref", "refs/notes/local", fixture.second)
  git(fixture.store, "update-ref", "refs/stash", fixture.second)
  const result = await verifyPrivateStoreCandidate({ store: fixture.store })
  expect(result.verdict).toBe("not-a-candidate")
  expect(result.reasons.map((reason) => reason.code).sort()).toEqual(["local-only", "local-stash"])
})

test("a detached HEAD that no advertised value carries is named", async () => {
  const fixture = storeFixture()
  git(fixture.store, "update-ref", "--no-deref", "HEAD", fixture.first)
  const result = await verifyPrivateStoreCandidate({ store: fixture.store })
  expect(result.verdict).toBe("not-a-candidate")
  expect(result.head).toMatchObject({ state: "detached", advertised: false })
  expect(result.reasons.map((reason) => reason.code)).toEqual(["detached-head-unadvertised"])
})

test("an unreachable remote is unproven, never a candidate and never a leaked path", async () => {
  const fixture = storeFixture()
  conventionalClone(fixture)
  const privatePath = join(fixture.root, "private-remote-does-not-exist.git")
  git(fixture.store, "remote", "set-url", "origin", privatePath)
  const result = await verifyPrivateStoreCandidate({ store: fixture.store })
  expect(result.verdict).toBe("unproven")
  expect(result.reasons.map((reason) => reason.code)).toEqual(["unavailable-transport"])
  expect(JSON.stringify(result)).not.toContain(privatePath)
})

test("the verifier issues only allowlisted, read-only Git requests", async () => {
  const fixture = storeFixture()
  conventionalClone(fixture)
  const inner = createLocalGitProcess(globalThis.process.env, { attempts: 1 })
  const seen: string[] = []
  const git: GitProcess = {
    async run(request) {
      seen.push(request.args[0] ?? "")
      return inner.run(request)
    },
  }
  const result = await verifyPrivateStoreCandidate({ store: fixture.store, git })
  expect(result.verdict).toBe("candidate")
  expect(seen.length).toBeGreaterThan(0)
  for (const verb of seen) expect(PRIVATE_STORE_GIT_REQUESTS).toContain(verb)
})

test("the operator card carries the verdict, named reasons, the not-covered line and the paths", async () => {
  const fixture = storeFixture()
  conventionalClone(fixture)
  git(fixture.store, "update-ref", "refs/remotes/origin/gone", fixture.second)
  const checkout = join(fixture.root, "env")
  const stdout = sink()
  const stderr = sink()
  const code = await runCli(
    ["worktree", "private-store", "verify", fixture.store, "--checkout", checkout],
    stdout,
    stderr,
  )
  expect(stderr.output).toBe("")
  expect(code).toBe(3)
  const lines = stdout.output.split("\n").filter(Boolean)
  expect(lines[0]).toBe("not-a-candidate")
  expect(lines[1]).toBe(
    `mapped-source-unadvertised: refs/remotes/origin/gone: maps to refs/heads/gone, which the remote does not advertise (the branch may be deleted; this commit may exist only here)`,
  )
  expect(stdout.output).toContain(PRIVATE_STORE_NOT_COVERED)
  expect(lines.slice(-2)).toEqual([`'${checkout}'`, `'${fixture.store}'`])
})
