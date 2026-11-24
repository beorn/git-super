/**
 * @failure An environment whose only copy of some work is its retained store reads as "nothing unpublished", so the
 *          removal skips the copy and the work is destroyed. The predicate's answer must never be a guess: a broken or
 *          absent read is `unknown`, and both callers retain on unknown.
 * @level l1 - a fake git, so the predicate's own decisions are under test, not git itself
 * @consumer every `worktree remove --retain` and every retention-batch entry that asks whether a copy is needed
 * @testonly none
 *
 * #38198 (@cto 2026-11-24T18:14Z): the four cases the ruling names, plus the unknown paths that must never read as
 * "nothing to keep".
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import {
  describeVerdict,
  nothingUnpublished,
  type NothingUnpublishedVerdict,
  type PredicateGit,
} from "../src/nothing-unpublished.ts"

const ENV = "/env/wt"

interface Answers {
  readonly [key: string]: string | Error
}

function fakeGit(answers: Answers): PredicateGit & { readonly calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    text: async (cwd: string, args: readonly string[]) => {
      const key = `${cwd} :: ${args.join(" ")}`
      calls.push(key)
      const answer = answers[key]
      if (answer === undefined) throw new Error(`fake git: no answer for ${key}`)
      if (answer instanceof Error) throw answer
      return answer
    },
  }
}

const base: Answers = {
  [`${ENV} :: submodule foreach --recursive --quiet pwd`]: "",
  [`${ENV} :: for-each-ref --format=%(refname) refs/heads`]: "refs/heads/task/x\n",
  [`${ENV} :: rev-parse --abbrev-ref HEAD`]: "task/x\n",
  [`${ENV} :: for-each-ref --format=%(refname) refs/remotes`]: "refs/remotes/origin/main\n",
  [`${ENV} :: status --porcelain --untracked-files=all`]: "",
  [`${ENV} :: rev-list refs/heads/task/x --not --remotes`]: "",
  [`${ENV} :: for-each-ref --contains refs/heads/task/x --exclude=refs/remotes/*/HEAD --format=%(refname) refs/remotes`]:
    "refs/remotes/origin/task/x\n",
}

const verdictOf = async (answers: Answers): Promise<NothingUnpublishedVerdict> =>
  await nothingUnpublished({ git: fakeGit({ ...base, ...answers }), path: ENV })

describe("nothingUnpublished", () => {
  test("a fully published, clean environment is published and names the remote ref that holds it", async () => {
    const verdict = await verdictOf({})
    expect(verdict).toEqual({
      state: "published",
      heads: ["refs/heads/task/x"],
      provedBy: ["refs/remotes/origin/task/x"],
    })
    expect(describeVerdict(ENV, verdict)).toContain("refs/remotes/origin/task/x")
  })

  test("an unpublished commit is unpublished and names how many", async () => {
    const verdict = await verdictOf({
      [`${ENV} :: rev-list refs/heads/task/x --not --remotes`]: "a".repeat(40) + "\n",
    })
    expect(verdict.state).toBe("unpublished")
    expect(verdict.state === "unpublished" && verdict.reason).toMatch(/1 commit/u)
  })

  test("a dirty worktree keeps the copy", async () => {
    const verdict = await verdictOf({
      [`${ENV} :: status --porcelain --untracked-files=all`]: " M src/a.ts\n",
    })
    expect(verdict.state).toBe("unpublished")
    expect(verdict.state === "unpublished" && verdict.reason).toMatch(/not clean: .*src\/a\.ts/u)
  })

  test("an untracked file keeps the copy", async () => {
    const verdict = await verdictOf({
      [`${ENV} :: status --porcelain --untracked-files=all`]: "?? notes.txt\n",
    })
    expect(verdict.state).toBe("unpublished")
    expect(verdict.state === "unpublished" && verdict.reason).toMatch(/notes\.txt/u)
  })

  test("a failing fetch is unknown with its reason, never a clean verdict", async () => {
    const verdict = await nothingUnpublished({
      git: fakeGit(base),
      path: ENV,
      refreshRemotes: async () => {
        throw new Error("fatal: unable to access remote")
      },
    })
    expect(verdict.state).toBe("unknown")
    expect(verdict.state === "unknown" && verdict.reason).toMatch(/unable to access remote/u)
  })

  test("absent remote-tracking refs are unknown, because nothing could witness publication", async () => {
    const verdict = await verdictOf({
      [`${ENV} :: for-each-ref --format=%(refname) refs/remotes`]: "",
    })
    expect(verdict.state).toBe("unknown")
    expect(verdict.state === "unknown" && verdict.reason).toMatch(/no remote-tracking refs/u)
  })

  test("an unreadable status is unknown, never read as clean", async () => {
    const verdict = await verdictOf({
      [`${ENV} :: status --porcelain --untracked-files=all`]: new Error("fatal: not a git repository"),
    })
    expect(verdict.state).toBe("unknown")
  })

  // A retained copy holds stores, not a checkout: the sweep asks only the heads question, and never pays for a walk
  // that would answer about a working tree the copy does not have.
  test("copy mode proves heads only and never reads a working tree", async () => {
    const git = fakeGit({ ...base, [`${ENV} :: status --porcelain --untracked-files=all`]: new Error("no status") })
    const verdict = await nothingUnpublished({ git, path: ENV, checkWorktree: false })
    expect(verdict.state).toBe("published")
    expect(git.calls.some((call) => call.includes("status --porcelain"))).toBe(false)
  })

  test("a detached HEAD is checked as a head of its own", async () => {
    const verdict = await verdictOf({
      [`${ENV} :: rev-parse --abbrev-ref HEAD`]: "HEAD\n",
      [`${ENV} :: for-each-ref --format=%(refname) refs/heads`]: "",
      [`${ENV} :: rev-list HEAD --not --remotes`]: "b".repeat(40) + "\n",
    })
    expect(verdict.state).toBe("unpublished")
    expect(verdict.heads).toEqual(["HEAD"])
  })

  // The real shape: `--quiet` suppresses Git's "Entering '<path>'" notes, so stdout is the bare `pwd` of each
  // submodule. Reading only the note form made every environment look submodule-free.
  test("an unpublished head inside an initialized submodule keeps the whole environment", async () => {
    const sub = "/env/wt/vendor/component"
    const verdict = await verdictOf({
      [`${ENV} :: submodule foreach --recursive --quiet pwd`]: `${sub}\n`,
      [`${sub} :: for-each-ref --format=%(refname) refs/heads`]: "refs/heads/main\n",
      [`${sub} :: rev-parse --abbrev-ref HEAD`]: "main\n",
      [`${sub} :: for-each-ref --format=%(refname) refs/remotes`]: "refs/remotes/origin/main\n",
      [`${sub} :: status --porcelain --untracked-files=all`]: "",
      [`${sub} :: rev-list refs/heads/main --not --remotes`]: "c".repeat(40) + "\n",
    })
    expect(verdict.state).toBe("unpublished")
    expect(verdict.heads).toContain(`${sub}:refs/heads/main`)
  })
  test("an unquiet git's Entering note is read as the same submodule", async () => {
    const sub = "/env/wt/vendor/component"
    const verdict = await verdictOf({
      [`${ENV} :: submodule foreach --recursive --quiet pwd`]: `Entering '${sub}'\n${sub}\n`,
      [`${sub} :: for-each-ref --format=%(refname) refs/heads`]: "refs/heads/main\n",
      [`${sub} :: rev-parse --abbrev-ref HEAD`]: "main\n",
      [`${sub} :: for-each-ref --format=%(refname) refs/remotes`]: "refs/remotes/origin/main\n",
      [`${sub} :: status --porcelain --untracked-files=all`]: "",
      [`${sub} :: rev-list refs/heads/main --not --remotes`]: "c".repeat(40) + "\n",
    })
    expect(verdict.state).toBe("unpublished")
    // The note and the path name one submodule, so its head is listed once, not twice.
    expect(verdict.heads.filter((head) => head.startsWith(`${sub}:`))).toEqual([`${sub}:refs/heads/main`])
  })
})

/**
 * #38246 (@cto 2026-11-24T21:28Z): the custody rule. A store the removal deletes that holds a stash or a note is not
 * eligible, so the copy is written (creation) or kept (sweep). A store holding only reflogs IS eligible: work must be
 * committed and pushed to count, and a reflog is not custody. These cases use a real modules directory, because the
 * store walk is the filesystem's answer, and a fake git for the refs themselves.
 */
function modulesRoot(): string {
  return mkdtempSync(join(tmpdir(), "nothing-unpublished-modules-"))
}

/** A directory with Git's store signature, so the walk finds it without a real repository behind it. */
function storeUnder(root: string, name: string): string {
  const dir = join(root, name)
  mkdirSync(join(dir, "objects"), { recursive: true })
  writeFileSync(join(dir, "HEAD"), "ref: refs/heads/main\n")
  writeFileSync(join(dir, "config"), "[core]\n\trepositoryformatversion = 0\n")
  return dir
}

/**
 * One published store's answers, keyed exactly as the predicate reads a store: through an explicit --git-dir and
 * --work-tree, because a copy's config still names the removed checkout as its work tree.
 */
function storeArgs(store: string, args: string): string {
  return `${store} :: --git-dir=${store} --work-tree=${store} ${args}`
}

function storeAnswers(store: string, extra: Answers = {}): Answers {
  return {
    [storeArgs(store, "for-each-ref --format=%(refname) refs/stash refs/notes")]: "",
    [storeArgs(store, "for-each-ref --format=%(refname) refs/heads")]: "refs/heads/main\n",
    [storeArgs(store, "rev-parse --abbrev-ref HEAD")]: "main\n",
    [storeArgs(store, "for-each-ref --format=%(refname) refs/remotes")]: "refs/remotes/origin/main\n",
    [storeArgs(store, "rev-list refs/heads/main --not --remotes")]: "",
    [storeArgs(
      store,
      "for-each-ref --contains refs/heads/main --exclude=refs/remotes/*/HEAD --format=%(refname) refs/remotes",
    )]: "refs/remotes/origin/main\n",
    ...extra,
  }
}

describe("nothingUnpublished custody refs (#38246)", () => {
  test("a store holding a stash is not eligible and names the store and the ref", async () => {
    const root = modulesRoot()
    const store = storeUnder(root, "vendor/dep")
    const verdict = await nothingUnpublished({
      git: fakeGit(
        storeAnswers(store, {
          [storeArgs(store, "for-each-ref --format=%(refname) refs/stash refs/notes")]: "refs/stash\n",
        }),
      ),
      modulesRoot: root,
      checkWorktree: false,
    })
    expect(verdict.state).toBe("unpublished")
    expect(verdict.state === "unpublished" && verdict.reason).toBe(`${store} holds refs/stash`)
  })

  test("a store holding a note is not eligible", async () => {
    const root = modulesRoot()
    const store = storeUnder(root, "dep")
    const verdict = await nothingUnpublished({
      git: fakeGit(
        storeAnswers(store, {
          [storeArgs(store, "for-each-ref --format=%(refname) refs/stash refs/notes")]: "refs/notes/commits\n",
        }),
      ),
      modulesRoot: root,
      checkWorktree: false,
    })
    expect(verdict.state).toBe("unpublished")
    expect(verdict.state === "unpublished" && verdict.reason).toBe(`${store} holds refs/notes/commits`)
  })

  test("a store holding only a reflog stays eligible: a reflog is not custody", async () => {
    const root = modulesRoot()
    const store = storeUnder(root, "dep")
    mkdirSync(join(store, "logs", "refs", "heads"), { recursive: true })
    writeFileSync(
      join(store, "logs", "refs", "heads", "main"),
      `${"a".repeat(40)} ${"b".repeat(40)} Probe <p@example.test> 1795000000 +0000\tcommit\n`,
    )
    const verdict = await nothingUnpublished({
      git: fakeGit(storeAnswers(store)),
      modulesRoot: root,
      checkWorktree: false,
    })
    expect(verdict.state).toBe("published")
    expect(verdict.heads).toEqual([`${store}:refs/heads/main`])
  })

  test("a non-store entry under the modules root is unknown, naming it, and never skips the copy", async () => {
    const root = modulesRoot()
    const store = storeUnder(root, "dep")
    writeFileSync(join(root, "stray.txt"), "work nobody recorded\n")
    const verdict = await nothingUnpublished({
      git: fakeGit(storeAnswers(store)),
      modulesRoot: root,
      checkWorktree: false,
    })
    expect(verdict.state).toBe("unknown")
    expect(verdict.state === "unknown" && verdict.reason).toMatch(/stray\.txt.*not a Git store/u)
  })

  test("a copy is proved from its stores alone, with no worktree to read", async () => {
    const root = modulesRoot()
    const store = storeUnder(root, "vendor/dep")
    const git = fakeGit(storeAnswers(store))
    const verdict = await nothingUnpublished({ git, modulesRoot: root, checkWorktree: false })
    expect(verdict.state).toBe("published")
    expect(git.calls.some((call) => call.includes("status --porcelain"))).toBe(false)
    expect(git.calls.some((call) => call.includes("submodule foreach"))).toBe(false)
  })

  test("an empty census proves nothing: no stores and no heads is unknown, never published", async () => {
    const verdict = await nothingUnpublished({
      git: fakeGit({}),
      modulesRoot: modulesRoot(),
      checkWorktree: false,
    })
    expect(verdict.state).toBe("unknown")
    expect(verdict.state === "unknown" && verdict.reason).toMatch(/no head to prove/u)
  })
})
