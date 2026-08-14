import { describe, expect, test } from "vitest"
import { gitSuperResult, type GitResultState, type GitSuperRepositoryResult } from "../src/result.ts"

function repository(state: GitResultState): GitSuperRepositoryResult {
  return {
    repository: `/repo/${state}`,
    state,
    refs: [{ source: "source", destination: "destination", state }],
  }
}

describe("GitSuperResult aggregation", () => {
  test("publishes the operation, process, and result seam from the package root", async () => {
    const api = await import("git-super")

    expect(api.superPull).toBeTypeOf("function")
    expect(api.createLocalGitProcess).toBeTypeOf("function")
    expect(api.gitSuperResult).toBeTypeOf("function")
  })

  test.each([
    [["unchanged"], "unchanged", false],
    [["updated", "unchanged"], "updated", false],
    [["failed", "not-run"], "failed", false],
    [["unknown", "unchanged"], "unknown", false],
    [["updated", "failed"], "failed", true],
    [["updated", "unknown"], "failed", true],
    [["updated", "not-run"], "failed", true],
  ] as const)("aggregates %j as %s with partial=%s", (states, state, partial) => {
    expect(gitSuperResult(states.map(repository))).toMatchObject({ state, partial })
  })
})
