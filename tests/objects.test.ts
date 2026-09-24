import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import { danglingRefs, ensureCommitObject, pinRef } from "../src/objects.ts"
import { createLocalGitProcess, type GitProcess } from "../src/process.ts"
import { advanceRepository, createRepository, git } from "./fixture.ts"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("exact commit objects", () => {
  test("fetches one missing commit and then observes it locally", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "git-super-object-"))
    roots.push(fixture)
    const upstream = join(fixture, "upstream")
    const checkout = join(fixture, "checkout")
    createRepository(upstream, "README.md", "one\n")
    git(fixture, "clone", "-q", upstream, checkout)
    const target = advanceRepository(upstream, "README.md", "two\n")

    await expect(ensureCommitObject({ repository: checkout, remote: "origin", commit: target })).resolves.toBe(
      "fetched",
    )
    await expect(ensureCommitObject({ repository: checkout, remote: "origin", commit: target })).resolves.toBe(
      "present",
    )
  })

  /**
   * A fetch that lands an object with NO ref pointing at it leaves it
   * unreachable, and the next `gc` in that repository is free to take it. The
   * fetch here therefore names a destination ref, the same convention the
   * reference warm-up and the retention rows already use.
   *
   * This is not hypothetical and it is not new: `reference.ts` learned it the
   * hard way on 2026-09-09, and this was the third bare-sha fetch left in the
   * tree.
   */
  test("the fetched commit SURVIVES gc --prune=now, because the fetch names a destination ref", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "git-super-object-gc-"))
    roots.push(fixture)
    const upstream = join(fixture, "upstream")
    const checkout = join(fixture, "checkout")
    createRepository(upstream, "README.md", "one\n")
    git(fixture, "clone", "-q", upstream, checkout)
    const target = advanceRepository(upstream, "README.md", "two\n")

    expect(await ensureCommitObject({ repository: checkout, remote: "origin", commit: target })).toBe("fetched")
    // Nothing else in this checkout reaches `target`: origin/main is still the
    // first commit, so only the fetch's own ref can keep it alive.
    git(checkout, "gc", "--prune=now")

    expect(git(checkout, "cat-file", "-t", `${target}^{commit}`)).toBe("commit")
  })

  test("the destination ref is named for the object, so a repeat fetch only rewrites it to itself", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "git-super-object-ref-"))
    roots.push(fixture)
    const upstream = join(fixture, "upstream")
    const checkout = join(fixture, "checkout")
    createRepository(upstream, "README.md", "one\n")
    git(fixture, "clone", "-q", upstream, checkout)
    const target = advanceRepository(upstream, "README.md", "two\n")

    await ensureCommitObject({ repository: checkout, remote: "origin", commit: target })
    expect(git(checkout, "rev-parse", pinRef(target))).toBe(target)
  })
})

describe("danglingRefs", () => {
  /**
   * A packed ref whose object is gone makes every fetch fail with git's "bad
   * object" text, which can name a different ref (hh 25050, 25051). The scan
   * must list it, read no object while listing, and cost two processes.
   */
  test("names a packed ref whose object is gone, in two git processes, and nothing else", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "git-super-dangling-"))
    roots.push(fixture)
    const repository = join(fixture, "repository")
    createRepository(repository, "README.md", "one\n")
    const lost = git(repository, "commit-tree", git(repository, "write-tree"), "-p", "HEAD", "-m", "record")
    git(repository, "update-ref", "refs/yrd/main/task/lost@abc", lost)
    git(repository, "pack-refs", "--all")
    expect(readFileSync(join(repository, ".git", "packed-refs"), "utf8")).toContain(
      `${lost} refs/yrd/main/task/lost@abc`,
    )
    rmSync(join(repository, ".git", "objects", lost.slice(0, 2), lost.slice(2)))

    const inner = createLocalGitProcess()
    const calls: string[][] = []
    const counted: GitProcess = {
      run: async (request) => {
        calls.push([...request.args])
        return inner.run(request)
      },
    }

    await expect(danglingRefs(counted, repository)).resolves.toEqual([
      { ref: "refs/yrd/main/task/lost@abc", oid: lost },
    ])
    expect(calls.map((args) => args[0])).toEqual(["for-each-ref", "cat-file"])
  })

  test("an intact repository scans to an empty list", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "git-super-dangling-"))
    roots.push(fixture)
    const repository = join(fixture, "repository")
    createRepository(repository, "README.md", "one\n")
    await expect(danglingRefs(createLocalGitProcess(), repository)).resolves.toEqual([])
  })

  test("a scan that cannot run throws with git's text, never an empty list", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "git-super-dangling-"))
    roots.push(fixture)
    await expect(danglingRefs(createLocalGitProcess(), join(fixture, "not-a-repository"))).rejects.toThrow(
      /git for-each-ref .*failed/u,
    )
  })

  test("the shared object batch keeps dangling-scan failure text", async () => {
    const oid = "a".repeat(40)
    const repository = "/missing-object-store"
    const stub: GitProcess = {
      run(request) {
        return Promise.resolve(
          request.args[0] === "for-each-ref"
            ? { code: 0, stdout: `${oid} refs/heads/lost\n`, stderr: "" }
            : { code: 1, stdout: "", stderr: "object database unavailable\n" },
        )
      },
    }
    await expect(danglingRefs(stub, repository)).rejects.toThrow(
      `git cat-file --batch-check=%(objectname) %(objecttype) failed (exit 1) in ${repository}\nobject database unavailable`,
    )
  })
})
