import type { GitProcess, GitProcessResult } from "./process.ts"
import type { GitResultDetail } from "./result.ts"

export type CommitGitlink = Readonly<{ path: string; target: string }>
export type CommitSubmodule = CommitGitlink & Readonly<{ name: string; url?: string }>

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

/** Read strict submodule metadata and gitlinks from one frozen commit. */
export async function readCommitSubmodules(
  git: GitProcess,
  repository: string,
  commit: string,
): Promise<CommitSubmodule[]> {
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
  const configuredArgs = [
    "config",
    "--null",
    "--blob",
    `${commit}:.gitmodules`,
    "--get-regexp",
    "^submodule\\..*\\.(path|url)$",
  ]
  const configured = await git.run({ repo: repository, args: configuredArgs })
  if (configured.code === 1 && configured.stdout.trim() === "" && configured.stderr === "") return []
  if (configured.code !== 0) throw operationError(repository, "read-target-submodules", configuredArgs, configured)
  const configuredByName = new Map<string, { path?: string; url?: string }>()
  for (const entry of configured.stdout.split("\0").filter((value) => value !== "")) {
    const separator = entry.indexOf("\n")
    const match = /^submodule\.(.+)\.(path|url)$/u.exec(separator < 0 ? "" : entry.slice(0, separator))
    if (separator < 1 || match?.[1] === undefined || match[2] === undefined) {
      throw Object.assign(new Error(`target ${commit} has invalid submodule metadata`), {
        resultDetail: detail(
          "invalid-target-submodule-config",
          "read-target-submodules",
          `Target ${commit} has invalid submodule metadata.`,
          { paths: [".gitmodules"], objectIds: [commit] },
        ),
      })
    }
    const property = match[2] as "path" | "url"
    const value = entry.slice(separator + 1)
    const current = configuredByName.get(match[1]) ?? {}
    if (current[property] !== undefined && current[property] !== value) {
      throw Object.assign(new Error(`target ${commit} has conflicting submodule ${property} metadata`), {
        resultDetail: detail(
          "conflicting-target-submodule-config",
          "read-target-submodules",
          `Target ${commit} defines conflicting ${property} values for submodule ${match[1]}.`,
          { paths: [".gitmodules"], objectIds: [commit] },
        ),
      })
    }
    current[property] = value
    configuredByName.set(match[1], current)
  }
  const entries: CommitSubmodule[] = []
  const configuredPaths = new Map<string, CommitSubmodule>()
  for (const [name, configuredEntry] of [...configuredByName].sort(([, left], [, right]) =>
    (left.path ?? "").localeCompare(right.path ?? ""),
  )) {
    if (configuredEntry.path === undefined) continue
    const path = configuredEntry.path
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
    const submodule: CommitSubmodule = {
      name,
      path,
      target: match[1],
      ...(configuredEntry.url === undefined ? {} : { url: configuredEntry.url }),
    }
    const previous = configuredPaths.get(path)
    if (previous !== undefined && previous.url !== submodule.url) {
      throw Object.assign(new Error(`target ${commit} has conflicting submodule URLs for ${path}`), {
        resultDetail: detail(
          "conflicting-target-submodule-path",
          "read-target-submodules",
          `Target ${commit} maps submodule path ${path} to conflicting URLs.`,
          { paths: [path], objectIds: [commit] },
        ),
      })
    }
    if (previous === undefined) {
      configuredPaths.set(path, submodule)
      entries.push(submodule)
    }
  }
  return entries
}

/** Read strict gitlink entries without consulting a checkout's HEAD. */
export async function readCommitGitlinks(
  git: GitProcess,
  repository: string,
  commit: string,
): Promise<CommitGitlink[]> {
  return (await readCommitSubmodules(git, repository, commit)).map(({ path, target }) => ({ path, target }))
}
