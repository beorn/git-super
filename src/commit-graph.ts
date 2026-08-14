import type { GitProcess, GitProcessResult } from "./process.ts"
import type { GitResultDetail } from "./result.ts"

export type CommitGitlink = Readonly<{ path: string; target: string }>

function detail(code: string, phase: string, message: string, extra: Partial<GitResultDetail> = {}): GitResultDetail {
  return { code, phase, message, ...extra }
}

function operationError(
  repository: string,
  phase: string,
  args: readonly string[],
  result: GitProcessResult,
): Error & Readonly<{ resultDetail: GitResultDetail }> {
  const message = result.timedOut
    ? `git ${args.join(" ")} timed out in ${repository}`
    : `git ${args.join(" ")} failed in ${repository} (exit ${result.code})${result.stderr ? `\n${result.stderr}` : ""}`
  return Object.assign(new Error(message), {
    resultDetail: detail(result.timedOut ? "git-timeout" : "git-failed", phase, message, {
      remedy: "Resolve the named commit-tree read failure, then rerun the same graph operation.",
    }),
  })
}

async function required(git: GitProcess, repository: string, args: readonly string[], phase: string): Promise<string> {
  const result = await git.run({ repo: repository, args })
  if (result.code !== 0) throw operationError(repository, phase, args, result)
  return result.stdout.trim()
}

/** Read strict gitlink entries from one frozen commit without consulting a checkout's HEAD. */
export async function readCommitGitlinks(
  git: GitProcess,
  repository: string,
  commit: string,
): Promise<CommitGitlink[]> {
  const manifestArgs = ["ls-tree", commit, "--", ".gitmodules"]
  const manifest = await git.run({ repo: repository, args: manifestArgs })
  if (manifest.code !== 0) throw operationError(repository, "read-target-manifest", manifestArgs, manifest)
  if (manifest.stdout.trim() === "") return []
  if (!/^100[0-9]{3} blob [0-9a-f]+\t\.gitmodules\s*$/mu.test(manifest.stdout)) {
    throw Object.assign(new Error(`target ${commit} has an invalid .gitmodules entry`), {
      resultDetail: detail(
        "invalid-target-manifest",
        "read-target-manifest",
        `Target ${commit} has an invalid .gitmodules entry.`,
        { paths: [".gitmodules"], objectIds: [commit] },
      ),
    })
  }
  const configuredArgs = ["config", "--blob", `${commit}:.gitmodules`, "--get-regexp", "^submodule\\..*\\.path$"]
  const configured = await git.run({ repo: repository, args: configuredArgs })
  if (configured.code === 1 && configured.stdout.trim() === "" && configured.stderr === "") return []
  if (configured.code !== 0) throw operationError(repository, "read-target-submodules", configuredArgs, configured)
  const paths = configured.stdout
    .split(/\r?\n/u)
    .filter((line) => line !== "")
    .map((line) => line.slice(line.search(/\s/u) + 1))
    .sort()
  const entries: CommitGitlink[] = []
  for (const path of paths) {
    const tree = await required(git, repository, ["ls-tree", commit, "--", path], "read-target-gitlink")
    const match = /^160000 commit ([0-9a-f]+)\t/u.exec(tree)
    if (match?.[1] === undefined) {
      throw Object.assign(new Error(`target ${commit} does not record submodule path ${path}`), {
        resultDetail: detail(
          "missing-target-gitlink",
          "read-target-gitlink",
          `Target ${commit} does not record ${path} as a gitlink.`,
          { paths: [path], objectIds: [commit] },
        ),
      })
    }
    entries.push({ path, target: match[1] })
  }
  return entries
}
