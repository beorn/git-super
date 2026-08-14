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

/** Read strict submodule metadata and gitlinks from one frozen commit. */
export async function readCommitSubmodules(
  git: GitProcess,
  repository: string,
  commit: string,
): Promise<CommitSubmodule[]> {
  const treeArgs = ["ls-tree", "-r", "-z", "--full-tree", commit]
  const tree = await git.run({ repo: repository, args: treeArgs })
  if (tree.code !== 0) throw operationError(repository, "read-target-tree", treeArgs, tree)
  const gitlinks = new Map<string, string>()
  for (const entry of tree.stdout.split("\0").filter((value) => value !== "")) {
    const separator = entry.indexOf("\t")
    const match = /^(\d{6}) (\w+) ([0-9a-f]+)$/u.exec(separator < 0 ? "" : entry.slice(0, separator))
    if (separator < 1 || match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
      throw Object.assign(new Error(`target ${commit} has an invalid tree entry`), {
        resultDetail: detail("invalid-target-tree", "read-target-tree", `Target ${commit} has an invalid tree entry.`, {
          objectIds: [commit],
        }),
      })
    }
    if (match[1] !== "160000") continue
    if (match[2] !== "commit") {
      throw Object.assign(new Error(`target ${commit} has an invalid gitlink entry`), {
        resultDetail: detail(
          "invalid-target-gitlink",
          "read-target-tree",
          `Target ${commit} has an invalid gitlink entry.`,
          { paths: [entry.slice(separator + 1)], objectIds: [commit] },
        ),
      })
    }
    gitlinks.set(entry.slice(separator + 1), match[3])
  }
  const manifestArgs = ["ls-tree", commit, "--", ".gitmodules"]
  const manifest = await git.run({ repo: repository, args: manifestArgs })
  if (manifest.code !== 0) throw operationError(repository, "read-target-manifest", manifestArgs, manifest)
  if (manifest.stdout.trim() === "") {
    if (gitlinks.size === 0) return []
    throw Object.assign(new Error(`target ${commit} records gitlinks without .gitmodules`), {
      resultDetail: detail(
        "missing-target-manifest",
        "read-target-manifest",
        `Target ${commit} records gitlinks without .gitmodules.`,
        { paths: [...gitlinks.keys()], objectIds: [commit] },
      ),
    })
  }
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
    const target = gitlinks.get(path)
    if (target === undefined) {
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
      target,
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
  const unconfigured = [...gitlinks.keys()].filter((path) => !configuredPaths.has(path))
  if (unconfigured.length > 0) {
    throw Object.assign(new Error(`target ${commit} records gitlinks without submodule metadata`), {
      resultDetail: detail(
        "unconfigured-target-gitlink",
        "read-target-submodules",
        `Target ${commit} records gitlinks without submodule metadata.`,
        { paths: unconfigured, objectIds: [commit] },
      ),
    })
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

/** Return only gitlinks added or advanced by `head`, using exact commit trees. */
export async function changedCommitGitlinks(
  git: GitProcess,
  repository: string,
  base: string,
  head: string,
): Promise<CommitGitlink[]> {
  const before = new Map((await readCommitGitlinks(git, repository, base)).map((entry) => [entry.path, entry.target]))
  return (await readCommitGitlinks(git, repository, head)).filter((entry) => before.get(entry.path) !== entry.target)
}
