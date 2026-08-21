import { isAbsolute, join, resolve } from "node:path"

import { createExclusive } from "./exclusive.ts"
import { createLocalGitProcess, type GitProcess, type GitProcessResult } from "./process.ts"
import { gitSuperResult, type GitResultDetail, type GitSuperResult } from "./result.ts"

export type WriteGitlinkOptions = Readonly<{
  repo: string
  path: string
  commit: string
  git?: GitProcess
}>

type IndexEntry = Readonly<{ mode: string; oid: string; stage: number; path: string }>
type SubmoduleRepository = Readonly<{ repo: string; env?: NodeJS.ProcessEnv }>

const DEFAULT_GIT_TIMEOUT_MS = 30_000
const GITLINK_MODE = "160000"
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu

/** Set one existing gitlink's exact index commit without moving the submodule checkout. */
export async function writeGitlink(options: WriteGitlinkOptions): Promise<GitSuperResult> {
  const fallbackRepository = resolve(options.repo)
  if (!OBJECT_ID.test(options.commit)) {
    const failure = detail(
      "invalid-commit",
      "validate-commit",
      `Gitlink commit ${options.commit} is not an exact 40- or 64-hex object ID.`,
      {
        paths: [options.path],
        objectIds: [options.commit],
        remedy: "Resolve the desired commit to one exact object ID before retrying.",
      },
    )
    return operationResult(fallbackRepository, "failed", failure)
  }
  const pathSegments = options.path.split("/")
  if (
    options.path.trim() === "" ||
    isAbsolute(options.path) ||
    options.path.includes("\0") ||
    pathSegments.some((segment) => segment === "." || segment === "..")
  ) {
    const failure = detail(
      "invalid-gitlink-path",
      "validate-gitlink",
      `Gitlink path '${options.path}' must be a non-empty root-relative path.`,
      {
        paths: [options.path],
        objectIds: [options.commit],
        remedy: "Pass the existing submodule's root-relative index path.",
      },
    )
    return operationResult(fallbackRepository, "failed", failure)
  }

  const process = options.git ?? createLocalGitProcess()
  const git: GitProcess = {
    run: (request) => process.run({ ...request, timeoutMs: request.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS }),
  }
  let repository: string
  try {
    repository = resolve(await required(git, options.repo, ["rev-parse", "--show-toplevel"], "discover-root"))
  } catch (error) {
    return operationResult(fallbackRepository, "failed", errorDetail(error, "discover-root"))
  }

  let wrote = false
  try {
    const exclusive = createExclusive(await lockDirectory(git, repository))
    return await exclusive.run(
      async () => {
        const before = await indexEntries(git, repository, options.path)
        if (before.length === 0 || before.some(({ mode }) => mode !== GITLINK_MODE)) {
          return notGitlink(repository, options.path, options.commit, before)
        }
        const submodule = await submoduleRepository(git, repository, options.path, options.commit)
        if ("state" in submodule) return submodule
        const unavailable = await commitExists(git, repository, submodule, options.path, options.commit)
        if (unavailable !== undefined) return unavailable
        if (
          before.length === 1 &&
          before[0]?.stage === 0 &&
          before[0]?.oid.toLowerCase() === options.commit.toLowerCase()
        ) {
          return operationResult(repository, "unchanged")
        }

        const args = ["update-index", "--cacheinfo", `${GITLINK_MODE},${options.commit},${options.path}`]
        const written = await git.run({ repo: repository, args })
        if (written.code !== 0) {
          throw operationError(repository, args, "write-gitlink", written, {
            paths: [options.path],
            objectIds: [options.commit],
          })
        }
        wrote = true

        let after: IndexEntry[]
        try {
          after = await indexEntries(git, repository, options.path)
        } catch (error) {
          const observation = errorDetail(error, "observe-index")
          const failure = detail(
            "post-write-observation-failed",
            "observe-index",
            `Gitlink ${options.path} may have been written to ${options.commit}, but the resulting index entry could not be read: ${observation.message}`,
            {
              paths: [options.path],
              objectIds: [options.commit],
              remedy: "Inspect `git ls-files --stage` before deciding whether a retry is safe.",
            },
          )
          return operationResult(repository, "unknown", failure)
        }
        if (
          after.length !== 1 ||
          after[0]?.mode !== GITLINK_MODE ||
          after[0]?.stage !== 0 ||
          after[0]?.oid.toLowerCase() !== options.commit.toLowerCase()
        ) {
          const failure = detail(
            "gitlink-observation-mismatch",
            "observe-index",
            `Git reported success, but ${options.path} does not resolve to stage-zero gitlink ${options.commit}.`,
            {
              paths: [options.path],
              objectIds: [options.commit, ...after.map(({ oid }) => oid)],
              remedy: "Inspect `git ls-files --stage` before deciding whether a retry is safe.",
            },
          )
          return operationResult(repository, "unknown", failure)
        }
        return operationResult(repository, "updated")
      },
      { holder: "git super gitlink write" },
    )
  } catch (error) {
    if (wrote) return postWriteCleanupFailure(repository, options.path, options.commit, error)
    return operationResult(repository, "failed", errorDetail(error, "write-gitlink"))
  }
}

function detail(code: string, phase: string, message: string, extra: Partial<GitResultDetail> = {}): GitResultDetail {
  return { code, phase, message, ...extra }
}

function operationResult(
  repository: string,
  state: "updated" | "unchanged" | "failed" | "unknown",
  failure?: GitResultDetail,
): GitSuperResult {
  return gitSuperResult(
    [
      {
        repository,
        state,
        ...(failure === undefined ? {} : { detail: failure }),
        refs: [],
      },
    ],
    failure,
  )
}

function postWriteCleanupFailure(repository: string, path: string, commit: string, error: unknown): GitSuperResult {
  const failure = detail(
    "post-write-lock-release-failed",
    "release-mutation-lock",
    `Gitlink ${path} was written to ${commit}, but the mutation lock could not be released: ${error instanceof Error ? error.message : String(error)}`,
    {
      paths: [path],
      objectIds: [commit],
      remedy:
        "Treat the index write as applied. Inspect the index and lock owner before retrying; restart the caller if it still holds the lock.",
    },
  )
  return {
    state: "failed",
    partial: true,
    detail: failure,
    repositories: [{ repository, state: "updated", refs: [] }],
  }
}

function operationError(
  repository: string,
  args: readonly string[],
  phase: string,
  result: GitProcessResult,
  extra: Partial<GitResultDetail> = {},
): Error & Readonly<{ resultDetail: GitResultDetail }> {
  const message = result.timedOut
    ? `git ${args.join(" ")} timed out in ${repository}`
    : `git ${args.join(" ")} failed in ${repository} (exit ${result.code})${result.stderr ? `\n${result.stderr}` : ""}`
  return Object.assign(new Error(message), {
    resultDetail: detail(result.timedOut ? "git-timeout" : "git-failed", phase, message, {
      remedy: "Resolve the named repository or index condition, then rerun the same gitlink write.",
      ...extra,
    }),
  })
}

function errorDetail(error: unknown, phase: string): GitResultDetail {
  if (typeof error === "object" && error !== null && "resultDetail" in error) {
    return (error as { resultDetail: GitResultDetail }).resultDetail
  }
  if (error instanceof Error && error.message.includes("worktree mutation lock is busy")) {
    return detail("mutation-lock-busy", "acquire-mutation-lock", error.message, {
      remedy: "Wait for the named lock holder to finish, then rerun the same gitlink write.",
    })
  }
  return detail("unexpected-error", phase, error instanceof Error ? error.message : String(error), {
    remedy: "Inspect the named phase and retry only after its underlying condition is understood.",
  })
}

async function required(git: GitProcess, repository: string, args: readonly string[], phase: string): Promise<string> {
  const result = await git.run({ repo: repository, args })
  if (result.code !== 0) throw operationError(repository, args, phase, result)
  return result.stdout.trim()
}

function parseIndexEntries(output: string, repository: string): IndexEntry[] {
  return output
    .split("\0")
    .filter((row) => row !== "")
    .map((row) => {
      const separator = row.indexOf("\t")
      const header = separator < 0 ? "" : row.slice(0, separator)
      const match = /^(\d{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])$/iu.exec(header)
      if (separator < 1 || match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
        throw Object.assign(new Error(`git-super: invalid index entry returned by ${repository}`), {
          resultDetail: detail(
            "invalid-index-entry",
            "observe-index",
            `Git returned an invalid index entry while inspecting ${repository}.`,
            { remedy: "Inspect the index with `git ls-files --stage` and repair it before retrying." },
          ),
        })
      }
      return { mode: match[1], oid: match[2], stage: Number(match[3]), path: row.slice(separator + 1) }
    })
}

async function indexEntries(git: GitProcess, repository: string, path: string): Promise<IndexEntry[]> {
  const args = ["ls-files", "--stage", "-z", "--full-name", "--", path]
  const result = await git.run({ repo: repository, args })
  if (result.code !== 0) throw operationError(repository, args, "observe-index", result, { paths: [path] })
  return parseIndexEntries(result.stdout, repository).filter((entry) => entry.path === path)
}

function notGitlink(repository: string, path: string, commit: string, entries: readonly IndexEntry[]): GitSuperResult {
  const observed =
    entries.length === 0 ? "no exact index entry" : `index modes ${entries.map(({ mode }) => mode).join(", ")}`
  const failure = detail(
    "not-gitlink",
    "validate-gitlink",
    `Cannot write gitlink ${path} in ${repository}: ${observed}; an existing mode-${GITLINK_MODE} entry is required.`,
    {
      paths: [path],
      objectIds: [commit],
      remedy: "Name an existing submodule path; git super gitlink write is update-only and never adds paths.",
    },
  )
  return operationResult(repository, "failed", failure)
}

async function submoduleRepository(
  git: GitProcess,
  repository: string,
  path: string,
  commit: string,
): Promise<SubmoduleRepository | GitSuperResult> {
  const candidate = join(repository, path)
  const args = ["rev-parse", "--show-toplevel"]
  const observed = await git.run({ repo: candidate, args })
  const root = observed.stdout.trim()
  if (observed.code === 0 && root !== "" && resolve(root) === resolve(candidate)) {
    return { repo: resolve(root) }
  }

  const configuredArgs = ["config", "--null", "--file", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"]
  const configured = await git.run({ repo: repository, args: configuredArgs })
  if (configured.code !== 0 && configured.code !== 1) {
    throw operationError(repository, configuredArgs, "locate-submodule-store", configured, {
      paths: [path],
      objectIds: [commit],
      remedy: "Repair the superproject's .gitmodules file, then rerun the same gitlink write.",
    })
  }
  const names =
    configured.code === 0
      ? configured.stdout
          .split("\0")
          .filter((entry) => entry !== "")
          .flatMap((entry) => {
            const separator = entry.indexOf("\n")
            const key = separator < 0 ? "" : entry.slice(0, separator)
            const value = separator < 0 ? "" : entry.slice(separator + 1)
            const match = /^submodule\.(.+)\.path$/u.exec(key)
            return value === path && match?.[1] !== undefined ? [match[1]] : []
          })
      : []
  if (names.length === 1 && names[0] !== undefined) {
    const common = await required(git, repository, ["rev-parse", "--git-common-dir"], "locate-submodule-store")
    const commonDirectory = isAbsolute(common) ? common : resolve(repository, common)
    const store = join(commonDirectory, "modules", names[0])
    const env = { GIT_OBJECT_DIRECTORY: join(store, "objects") }
    const verified = await git.run({ repo: repository, args: ["count-objects", "-v"], env })
    if (verified.code === 0) return { repo: repository, env }
  }

  {
    const failure = detail(
      "submodule-repository-missing",
      "validate-submodule",
      `Cannot verify gitlink ${path} at ${commit}: neither ${candidate} nor its configured common-dir object store is a readable submodule repository.`,
      {
        paths: [path],
        objectIds: [commit],
        remedy: `Initialize or materialize the submodule repository for ${path}, fetch the exact commit, then retry.`,
      },
    )
    return operationResult(repository, "failed", failure)
  }
}

async function commitExists(
  git: GitProcess,
  repository: string,
  submodule: SubmoduleRepository,
  path: string,
  commit: string,
): Promise<GitSuperResult | undefined> {
  const args = ["cat-file", "-e", `${commit}^{commit}`]
  const observed = await git.run({
    repo: submodule.repo,
    args,
    ...(submodule.env === undefined ? {} : { env: submodule.env }),
  })
  if (observed.code === 0) return undefined
  if (
    observed.timedOut === true ||
    observed.stalled === true ||
    observed.failure !== undefined ||
    (observed.signal !== undefined && observed.signal !== null)
  ) {
    const failure = operationError(submodule.repo, args, "validate-commit", observed, {
      paths: [path],
      objectIds: [commit],
    }).resultDetail
    return operationResult(repository, "failed", failure)
  }
  const failure = detail(
    "submodule-commit-missing",
    "validate-commit",
    `Submodule ${path} does not contain commit ${commit}.`,
    {
      paths: [path],
      objectIds: [commit],
      remedy: `Fetch commit ${commit} into submodule ${path}, then rerun the same gitlink write.`,
    },
  )
  return operationResult(repository, "failed", failure)
}

async function lockDirectory(git: GitProcess, repository: string): Promise<string> {
  const common = await required(git, repository, ["rev-parse", "--git-common-dir"], "locate-mutation-lock")
  return join(isAbsolute(common) ? common : resolve(repository, common), "yrd-worktree-mutations")
}
