import { describe, expect, test } from "vitest"
import { resolveSubmoduleOrigin } from "../src/submodule-origin.ts"

describe("submodule origin resolution", () => {
  test("keeps absolute and scp-like remotes", () => {
    expect(resolveSubmoduleOrigin("/repo", undefined, "https://example.com/x.git")).toBe("https://example.com/x.git")
    expect(resolveSubmoduleOrigin("/repo", undefined, "git@github.com:owner/x.git")).toBe("git@github.com:owner/x.git")
  })

  test.each([
    ["https://github.com/owner/super.git", "./dep.git", "https://github.com/owner/super.git/dep.git"],
    ["git@github.com:owner/super.git", "./dep.git", "git@github.com:owner/super.git/dep.git"],
    ["https://github.com/owner/super.git", "../dep.git", "https://github.com/owner/dep.git"],
    ["git@github.com:owner/super.git", "../dep.git", "git@github.com:owner/dep.git"],
  ])("resolves %s plus %s", (origin, relative, expected) => {
    expect(resolveSubmoduleOrigin("/repo", origin, relative)).toBe(expected)
  })

  test("fails loudly when a relative URL has no superproject origin", () => {
    expect(() => resolveSubmoduleOrigin("/repo", undefined, "../dep.git")).toThrow(/no superproject origin/u)
  })
})
