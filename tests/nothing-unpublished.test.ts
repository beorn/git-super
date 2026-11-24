/**
 * #38198 (@cto 2026-11-24T18:14Z): the four cases the ruling names, plus the unknown paths that must never read as
 * "nothing to keep". Every case is a fake git, so the predicate's own decisions are what is under test — not git.
 */
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

  test("an unpublished head inside an initialized submodule keeps the whole environment", async () => {
    const sub = "/env/wt/vendor/component"
    const verdict = await verdictOf({
      [`${ENV} :: submodule foreach --recursive --quiet pwd`]: `Entering '${sub}'\n`,
      [`${sub} :: for-each-ref --format=%(refname) refs/heads`]: "refs/heads/main\n",
      [`${sub} :: rev-parse --abbrev-ref HEAD`]: "main\n",
      [`${sub} :: for-each-ref --format=%(refname) refs/remotes`]: "refs/remotes/origin/main\n",
      [`${sub} :: status --porcelain --untracked-files=all`]: "",
      [`${sub} :: rev-list refs/heads/main --not --remotes`]: "c".repeat(40) + "\n",
    })
    expect(verdict.state).toBe("unpublished")
    expect(verdict.heads).toContain(`${sub}:refs/heads/main`)
  })
})
