/**
 * @failure Git URL checkout reuse conflates distinct repositories or clone naming diverges from native Git.
 * @level l1
 * @consumer Git URL launch and frozen push ownership; existing push tests do not cover general clone identities.
 * @testonly none
 * @reach fs-walk <fixture-only: list native clone destination in a temporary directory>
 */
import { afterEach, describe, expect, test } from "vitest"
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { gitCloneDirectoryName, gitExplicitSourceUrl, gitRemoteIdentity, sameGitRepository } from "../src/remote.ts"
import { hostedRemoteIdentity, sameHostedOwner, sameHostedRepository } from "../src/push-intent.ts"
import { canonicalTmpdir, git } from "./fixture.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("Git remote identity", () => {
  // Acceptance: ambiguity diagnostics give an explicit source URL without losing the user's SSH identity.
  test.each([
    ["git@git.example:acme/team.git", "ssh://git@git.example/acme/team.git"],
    ["alice@work-alias:repo", "ssh://alice@work-alias/repo"],
    ["git@host:/absolute/repo.git", "ssh://git@host/absolute/repo.git"],
    ["https://EXAMPLE.test/team/Repo.git", "https://EXAMPLE.test/team/Repo.git"],
    ["ssh://alice@host:2222/team/Repo.git", "ssh://alice@host:2222/team/Repo.git"],
  ])("makes %s explicit as %s", (remote, explicit) => {
    expect(gitExplicitSourceUrl(remote)).toBe(explicit)
  })

  // Acceptance: reuse compares transport spellings while preserving meaningful host, port and path differences.
  test.each([
    ["https://EXAMPLE.test/team/Repo.git", "git@example.test:team/Repo", true],
    ["https://example.test:443/team/Repo/", "ssh://other@EXAMPLE.test:22/team/Repo.git", true],
    ["https://example.test/team/Repo/.git/", "git@example.test:team/Repo.git/", true],
    ["ssh://git@example.test/repo.git", "other@example.test:repo", true],
    ["https://example.test/team/Repo", "https://example.test/team/repo", false],
    ["ssh://git@example.test:2222/team/repo", "https://example.test/team/repo", false],
    ["https://example.test:444/team/repo", "https://example.test/team/repo", false],
    ["git@work-alias:team/repo", "git@personal-alias:team/repo", false],
  ])("compares %s and %s as %s", (left, right, equal) => {
    expect(sameGitRepository(left, right)).toBe(equal)
  })

  // Acceptance: a source cannot introduce option-shaped hosts/paths, local paths, or credential-bearing URLs.
  test.each([
    "https://-example.test/team/repo",
    "git@-host:repo",
    "ssh://git@host/-repo",
    "git@host:-repo",
    "https://host/-team/repo",
    "file:///team/repo",
    "./repo",
    "https://user:secret@host/team/repo",
    "https://host/team/repo?query",
    "https://host/team/repo#fragment",
  ])("rejects invalid remote %s", (remote) => {
    expect(() => gitRemoteIdentity(remote)).toThrow()
  })

  // Binding condition: broad checkout identity must not broaden the existing push authorization policy.
  test("keeps namespace, credential and legacy spelling constraints on hosted push identity", () => {
    for (const remote of [
      "ssh://git@host/repo",
      "git@host:repo",
      "https://host/team/repo/",
      "https://host/team/repo/.git",
      "https://user@host/team/repo",
      "ssh://user:secret@host/team/repo",
      "file:///team/repo",
    ]) {
      expect(() => hostedRemoteIdentity(remote)).toThrow(/Invalid frozen Git Super push intent/u)
    }
    expect(sameHostedRepository("https://HOST/team/Repo.git", "git@host:team/Repo")).toBe(true)
    expect(sameHostedOwner("https://host/team/Repo", "https://host/other/Repo")).toBe(false)
    expect(sameHostedRepository("ssh://git@host:22/team/repo", "git@host:team/repo")).toBe(false)
  })
})

// Acceptance: child directory names follow native clone, including terminal slash and /.git forms.
test("clone directory names match native Git for supported remote spellings", () => {
  const root = mkdtempSync(join(canonicalTmpdir(), "git-super-clone-name-"))
  roots.push(root)
  const bare = join(root, "source.git")
  git(root, "init", "--bare", "-q", bare)
  const remotes = [
    "https://example.test/team/repo.git",
    "https://example.test/team/repo.git/",
    "https://example.test/team/repo/.git",
    "https://example.test/team/repo/.git/",
    "https://example.test/team/repo.git/.git",
    "https://example.test/team/repo.git.git",
    "ssh://git@example.test/repo.git",
    "git@example.test:repo.git",
    "ssh://git@example.test:2222/team/MyRepo.git",
    "https://example.test/team/space%20repo.git",
  ]
  for (const [index, remote] of remotes.entries()) {
    const cwd = join(root, String(index))
    mkdirSync(cwd)
    git(cwd, "-c", `url.${bare}.insteadOf=${remote}`, "clone", "--", remote)
    expect(readdirSync(cwd), remote).toEqual([gitCloneDirectoryName(remote)])
  }
})
