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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
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
  const result = await verifyPrivateStoreCandidate({ store: fixture.store, checkout: join(fixture.root, "env") })
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
  const result = await verifyPrivateStoreCandidate({ store: fixture.store, checkout: join(fixture.root, "env") })
  expect(result.verdict).toBe("not-a-candidate")
  expect(result.reasons.map((reason) => reason.code)).toEqual(["mapped-source-unadvertised"])
  expect(result.reasons[0]?.message).toContain("maps to refs/heads/gone")
})

test("a tracking ref for a remote the store does not configure is never mapped silently", async () => {
  const fixture = storeFixture()
  conventionalClone(fixture)
  git(fixture.store, "update-ref", "refs/remotes/elsewhere/main", fixture.second)
  const result = await verifyPrivateStoreCandidate({ store: fixture.store, checkout: join(fixture.root, "env") })
  expect(result.verdict).toBe("not-a-candidate")
  expect(result.reasons.map((reason) => reason.code)).toEqual(["tracking-unqueried-remote"])
})

test("local-only namespaces and a stash are not candidates", async () => {
  const fixture = storeFixture()
  conventionalClone(fixture)
  git(fixture.store, "update-ref", "refs/notes/local", fixture.second)
  git(fixture.store, "update-ref", "refs/stash", fixture.second)
  const result = await verifyPrivateStoreCandidate({ store: fixture.store, checkout: join(fixture.root, "env") })
  expect(result.verdict).toBe("not-a-candidate")
  expect(result.reasons.map((reason) => reason.code).sort()).toEqual(["local-only", "local-stash"])
})

test("a detached HEAD that no advertised value carries is named", async () => {
  const fixture = storeFixture()
  git(fixture.store, "update-ref", "--no-deref", "HEAD", fixture.first)
  const result = await verifyPrivateStoreCandidate({ store: fixture.store, checkout: join(fixture.root, "env") })
  expect(result.verdict).toBe("not-a-candidate")
  expect(result.head).toMatchObject({ state: "detached", advertised: false })
  expect(result.reasons.map((reason) => reason.code)).toEqual(["detached-head-unadvertised"])
})

test("an unreachable remote is unproven, never a candidate and never a leaked path", async () => {
  const fixture = storeFixture()
  conventionalClone(fixture)
  const privatePath = join(fixture.root, "private-remote-does-not-exist.git")
  git(fixture.store, "remote", "set-url", "origin", privatePath)
  const result = await verifyPrivateStoreCandidate({ store: fixture.store, checkout: join(fixture.root, "env") })
  expect(result.verdict).toBe("unproven")
  expect(result.reasons.map((reason) => reason.code)).toEqual(["unavailable-transport"])
  expect(JSON.stringify(result)).not.toContain(privatePath)
})

test("the verifier issues exactly the allowlisted, read-only Git requests", async () => {
  const fixture = storeFixture()
  conventionalClone(fixture)
  const inner = createLocalGitProcess(globalThis.process.env, { attempts: 1 })
  const seen: string[][] = []
  const git: GitProcess = {
    async run(request) {
      seen.push([...request.args])
      return inner.run(request)
    },
  }
  const result = await verifyPrivateStoreCandidate({
    store: fixture.store,
    checkout: join(fixture.root, "env"),
    git,
  })
  expect(result.verdict).toBe("candidate")
  // The exact argv, not membership in a verb list: nothing may read the index, the reflog, an object,
  // or any content, and nothing may fetch, push or mutate a ref or the store.
  expect(new Set(seen.map((args) => args.join(" ")))).toEqual(
    new Set([
      "rev-parse --git-dir",
      "config --get-regexp ^remote\\..*\\.fetch$",
      "ls-remote --refs origin",
      "for-each-ref --format=%(refname)%00%(objectname)%00%(symref)",
      "symbolic-ref --quiet HEAD",
      "rev-parse HEAD",
    ]),
  )
  for (const args of seen) expect(PRIVATE_STORE_GIT_REQUESTS).toContain(args[0] ?? "")
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

test("a tracking ref is compared with its OWN remote's advertisement, never another remote's", async () => {
  const root = mkdtempSync(join(canonicalTmpdir(), "git-super-private-store-two-"))
  roots.push(root)
  const work = join(root, "work")
  const originRemote = join(root, "origin.git")
  const upstreamRemote = join(root, "upstream.git")
  git(root, "init", "-q", "-b", "main", work)
  writeFileSync(join(work, "vendor.txt"), "one\n")
  git(work, "add", "vendor.txt")
  git(work, "commit", "-qm", "one")
  const older = git(work, "rev-parse", "HEAD")
  writeFileSync(join(work, "vendor.txt"), "two\n")
  git(work, "commit", "-qam", "two")
  const newer = git(work, "rev-parse", "HEAD")
  git(root, "init", "-q", "--bare", "-b", "main", originRemote)
  git(work, "remote", "add", "origin", originRemote)
  git(work, "push", "-q", "origin", "main")
  git(originRemote, "update-ref", "refs/heads/main", older)
  git(root, "init", "-q", "--bare", "-b", "main", upstreamRemote)
  git(work, "push", "-q", upstreamRemote, "main")
  const store = join(root, "modules", "vendor", "brain8")
  git(root, "init", "-q", "--bare", store)
  git(store, "remote", "add", "origin", originRemote)
  git(store, "remote", "add", "upstream", upstreamRemote)
  git(store, "fetch", "-q", "origin")
  git(store, "fetch", "-q", "upstream")
  git(store, "update-ref", "refs/heads/main", newer)
  git(store, "update-ref", "refs/remotes/origin/main", newer)
  git(store, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
  const result = await verifyPrivateStoreCandidate({ store, checkout: join(root, "env") })
  expect(result.verdict).toBe("not-a-candidate")
  // origin advertises `older` under refs/heads/main while upstream advertises `newer`. A flattened
  // cross-remote map would let upstream's value stand in for origin's and read this row as `equal`.
  expect(result.refs.find((row) => row.ref === "refs/remotes/origin/main")).toMatchObject({
    mappedFrom: "refs/heads/main",
    value: newer,
    advertised: older,
    state: "differs",
  })
  expect(result.reasons.map((reason) => reason.code)).toContain("value-differs")
})

test("a configured destination outside refs/remotes is mapped, never read as local-only", async () => {
  const fixture = storeFixture()
  git(fixture.store, "config", "remote.origin.fetch", "+refs/heads/*:refs/cache/*")
  git(fixture.store, "update-ref", "-d", "refs/remotes/origin/main")
  git(fixture.store, "update-ref", "-d", "refs/remotes/origin/HEAD")
  git(fixture.store, "fetch", "-q", "origin")
  git(fixture.store, "update-ref", "refs/heads/main", fixture.second)
  git(fixture.store, "update-ref", "refs/cache/main", fixture.second)
  const result = await verifyPrivateStoreCandidate({ store: fixture.store, checkout: join(fixture.root, "env") })
  expect(result.verdict).toBe("candidate")
  expect(result.refs.find((row) => row.ref === "refs/cache/main")).toMatchObject({
    mappedFrom: "refs/heads/main",
    state: "equal",
  })
})

test("a checkout that still holds bytes is a named refusal, never a candidate", async () => {
  const fixture = storeFixture()
  conventionalClone(fixture)
  const checkout = join(fixture.root, "env")
  mkdirSync(join(checkout, "vendor", "brain8"), { recursive: true })
  writeFileSync(join(checkout, "vendor", "brain8", "PRIVATE-SENTINEL.txt"), "secret\n")
  const result = await verifyPrivateStoreCandidate({ store: fixture.store, checkout })
  expect(result.verdict).toBe("not-a-candidate")
  expect(result.reasons.map((reason) => reason.code)).toEqual(["checkout-not-empty"])
  // A directory listing is all the check may use: no entry name ever reaches the result.
  expect(JSON.stringify(result)).not.toContain("PRIVATE-SENTINEL")
})

test("the empty-first precondition cannot be stated without a declared checkout", async () => {
  const fixture = storeFixture()
  conventionalClone(fixture)
  const stdout = sink()
  const stderr = sink()
  const code = await runCli(["worktree", "private-store", "verify", fixture.store], stdout, stderr)
  expect(code).toBe(2)
  expect(stdout.output).toBe("")
  expect(stderr.output).toContain("--checkout")
})

test("a source-only refspec maps nothing, so a fabricated tracker cannot read as equal", async () => {
  const fixture = storeFixture()
  // Real Git writes FETCH_HEAD for a source-only refspec and creates no ref at all. A verifier that
  // synthesized refs/remotes/<remote>/<branch> would invent a mapping for a ref Git never wrote.
  git(fixture.store, "config", "remote.origin.fetch", "+refs/heads/main")
  git(fixture.store, "update-ref", "-d", "refs/remotes/origin/main")
  git(fixture.store, "update-ref", "-d", "refs/remotes/origin/HEAD")
  git(fixture.store, "update-ref", "refs/heads/main", fixture.second)
  git(fixture.store, "update-ref", "refs/remotes/origin/main", fixture.second)
  const result = await verifyPrivateStoreCandidate({ store: fixture.store, checkout: join(fixture.root, "env") })
  expect(result.verdict).toBe("not-a-candidate")
  expect(result.refs.find((row) => row.ref === "refs/remotes/origin/main")).toMatchObject({
    mappedFrom: null,
    state: "unadvertised",
  })
  expect(result.reasons.map((reason) => reason.code)).toEqual(["local-only"])
})

test("a malformed advertisement is a named unproven reason and never relays the raw line", async () => {
  const fixture = storeFixture()
  conventionalClone(fixture)
  const inner = createLocalGitProcess(globalThis.process.env, { attempts: 1 })
  const sentinel = "PRIVATE-SENTINEL-SUBJECT"
  const git: GitProcess = {
    async run(request) {
      if (request.args[0] === "ls-remote" && request.args[1] === "--refs") {
        return { code: 0, stdout: `refs/heads/${sentinel}\n`, stderr: "" }
      }
      return inner.run(request)
    },
  }
  const result = await verifyPrivateStoreCandidate({ store: fixture.store, checkout: join(fixture.root, "env"), git })
  expect(result.verdict).toBe("unproven")
  expect(result.reasons.map((reason) => reason.code)).toEqual(["malformed-advert"])
  expect(result.reasons[0]?.message).not.toContain(sentinel)
  expect(JSON.stringify(result)).not.toContain(sentinel)
})

test("no failure path relays a private name into stdout or stderr", async () => {
  const fixture = storeFixture()
  conventionalClone(fixture)
  const privatePath = join(fixture.root, "PRIVATE-SENTINEL-REMOTE.git")
  git(fixture.store, "remote", "set-url", "origin", privatePath)
  const checkout = join(fixture.root, "env")
  mkdirSync(checkout, { recursive: true })
  writeFileSync(join(checkout, "PRIVATE-SENTINEL-FILE.txt"), "secret\n")
  const stdout = sink()
  const stderr = sink()
  const code = await runCli(
    ["worktree", "private-store", "verify", fixture.store, "--checkout", checkout],
    stdout,
    stderr,
  )
  expect(code).toBe(4)
  expect(stdout.output + stderr.output).not.toContain("PRIVATE-SENTINEL")
})

// @cto's THREE NO-RE-READ items on the reviewed component (round-3 GO, 2026-10-11): each of these
// pins a field that used to say more than it could prove.

test("a FAILING LOCAL READ is the store's own fault, named by verb, never a network code", async () => {
  const fixture = storeFixture()
  conventionalClone(fixture)
  const inner = createLocalGitProcess(globalThis.process.env, { attempts: 1 })
  const git: GitProcess = {
    async run(request) {
      if (request.args[0] === "for-each-ref") return { code: 124, stdout: "", stderr: "", timedOut: true }
      return inner.run(request)
    },
  }
  const result = await verifyPrivateStoreCandidate({ store: fixture.store, checkout: join(fixture.root, "env"), git })
  expect(result.verdict).toBe("unproven")
  // Not `unavailable-transport`: nothing here left the machine, so no remote may be blamed.
  expect(result.reasons.map((reason) => reason.code)).toEqual(["local-read-failed"])
  expect(result.reasons[0]?.message).toContain("git for-each-ref did not complete")
  expect(result.reasons[0]?.message).not.toContain("ls-remote")
})

test("a store with NO configured remote is named `no-configured-remote`, not an unreadable store", async () => {
  const fixture = storeFixture()
  const bare = join(fixture.root, "no-remote.git")
  git(fixture.root, "init", "-q", "--bare", "-b", "main", bare)
  const result = await verifyPrivateStoreCandidate({ store: bare, checkout: join(fixture.root, "env") })
  // `git config --get-regexp` exits 1 when nothing matches. The store read fine; it just has no remote.
  expect(result.verdict).toBe("unproven")
  expect(result.reasons.map((reason) => reason.code)).toEqual(["no-configured-remote"])
  expect(result.reasons[0]?.message).toContain("no fetch refspec")
})

test("a symbolic HEAD claims advertisement only where the ref it rides on does", async () => {
  const fixture = storeFixture()
  conventionalClone(fixture)
  // HEAD rides refs/heads/main; move that branch off the advertised value.
  git(fixture.store, "symbolic-ref", "HEAD", "refs/heads/main")
  git(fixture.store, "update-ref", "refs/heads/main", fixture.first)
  const result = await verifyPrivateStoreCandidate({ store: fixture.store, checkout: join(fixture.root, "env") })
  expect(result.verdict).toBe("not-a-candidate")
  expect(result.head).toMatchObject({ state: "symbolic", attachedTo: "refs/heads/main", advertised: false })
  expect(result.refs.find((row) => row.ref === "refs/heads/main")).toMatchObject({ state: "differs" })
})
