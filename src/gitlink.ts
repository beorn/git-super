import { isAbsolute, join, resolve } from "node:path"

import { createExclusive, type Exclusive } from "./exclusive.ts"
import { parseIndexEntries, type IndexEntry } from "./index-entries.ts"
import { createLocalGitProcess, type GitProcess, type GitProcessResult } from "./process.ts"
import { gitSuperResult, type GitResultDetail, type GitSuperResult } from "./result.ts"

export type WriteGitlinkOptions = Readonly<{
  repo: string
  path: string
  commit: string
  git?: GitProcess
  /**
   * `held` states that the caller already owns this repository's writer lock,
   * so the write must not try to take it again. `git super merge` holds the
   * lock across its whole operation, and a carrier it builds inside that window
   * would otherwise deadlock against itself. Defaults to `acquire`.
   */
  lock?: "acquire" | "held"
}>

type SubmoduleRepository = Readonly<{ repo: string; env?: NodeJS.ProcessEnv }>

const DEFAULT_GIT_TIMEOUT_MS = 30_000
const GITLINK_MODE = "160000"
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu
/**
 * An abbreviated object name Git itself would consider (its minimum abbreviation is four
 * characters). Admitted here and resolved to one exact object IN the submodule repository
 * before anything is written (#28554): a prefix that names no commit, or more than one,
 * is refused loudly rather than silently leaving the index untouched.
 */
const ABBREVIATED_OBJECT_ID = /^[0-9a-f]{4,64}$/iu

/** Set one existing gitlink's exact index commit without moving the submodule checkout. */
export async function writeGitlink(options: WriteGitlinkOptions): Promise<GitSuperResult> {
  const fallbackRepository = resolve(options.repo)
  if (!ABBREVIATED_OBJECT_ID.test(options.commit)) {
    const failure = detail(
      "invalid-commit",
      "validate-commit",
      `Gitlink commit ${options.commit} is not a hex object ID; pass a full 40- or 64-hex object ID, or an abbreviation of at least 4 hex characters.`,
      {
        paths: [options.path],
        objectIds: [options.commit],
        remedy: `Get the full ID with \`git -C <submodule> rev-parse ${options.commit}\`, then rerun \`bun git-super --repo <dir> gitlink write ${options.path} <full-oid>\`.`,
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
  let target = options.commit.toLowerCase()
  let postWriteResult: GitSuperResult | undefined
  try {
    const exclusive: Exclusive =
      options.lock === "held"
        ? { run: (operation) => operation() }
        : createExclusive(await lockDirectory(git, repository))
    return await exclusive.run(
      async () => {
        const before = await indexEntries(git, repository, options.path)
        if (before.length === 0 || before.some(({ mode }) => mode !== GITLINK_MODE)) {
          return notGitlink(repository, options.path, options.commit, before)
        }
        const submodule = await submoduleRepository(git, repository, options.path, options.commit)
        if ("state" in submodule) return submodule
        const resolved = await resolveCommitId(git, repository, submodule, options.path, options.commit)
        if (typeof resolved !== "string") return resolved
        target = resolved
        const unavailable = await commitExists(git, repository, submodule, options.path, target)
        if (unavailable !== undefined) return unavailable
        if (before.length === 1 && before[0]?.stage === 0 && before[0]?.oid.toLowerCase() === target) {
          return operationResult(repository, "unchanged")
        }

        const args = ["update-index", "--cacheinfo", `${GITLINK_MODE},${target},${options.path}`]
        const written = await git.run({ repo: repository, args })
        if (written.code !== 0) {
          throw operationError(repository, args, "write-gitlink", written, {
            paths: [options.path],
            objectIds: [target],
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
            `Gitlink ${options.path} may have been written to ${target}, but the resulting index entry could not be read: ${observation.message}`,
            {
              paths: [options.path],
              objectIds: [target],
              remedy: "Inspect `git ls-files --stage` before deciding whether a retry is safe.",
            },
          )
          postWriteResult = operationResult(repository, "unknown", failure)
          return postWriteResult
        }
        if (
          after.length !== 1 ||
          after[0]?.mode !== GITLINK_MODE ||
          after[0]?.stage !== 0 ||
          after[0]?.oid.toLowerCase() !== target
        ) {
          const failure = detail(
            "gitlink-observation-mismatch",
            "observe-index",
            `Git reported success, but ${options.path} does not resolve to stage-zero gitlink ${target}.`,
            {
              paths: [options.path],
              objectIds: [target, ...after.map(({ oid }) => oid)],
              remedy: "Inspect `git ls-files --stage` before deciding whether a retry is safe.",
            },
          )
          postWriteResult = operationResult(repository, "unknown", failure)
          return postWriteResult
        }
        postWriteResult = operationResult(repository, "updated")
        return postWriteResult
      },
      { holder: "git super gitlink write" },
    )
  } catch (error) {
    if (wrote) return postWriteCleanupFailure(repository, options.path, target, error, postWriteResult)
    return operationResult(repository, "failed", errorDetail(error, "write-gitlink"))
  }
}

/**
 * Resolve the caller's commit to ONE exact object ID inside the submodule repository
 * (#28554). A full ID passes through unchanged; an abbreviation is expanded by Git in the
 * repository that must contain it, and a prefix that names no commit — or more than one —
 * returns a loud refusal naming the full-sha requirement and the command form that works,
 * never a silent no-op.
 */
async function resolveCommitId(
  git: GitProcess,
  repository: string,
  submodule: SubmoduleRepository,
  path: string,
  commit: string,
): Promise<string | GitSuperResult> {
  if (OBJECT_ID.test(commit)) return commit.toLowerCase()
  const args = ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`]
  const observed = await git.run({
    repo: submodule.repo,
    args,
    ...(submodule.env === undefined ? {} : { env: submodule.env }),
  })
  const resolved = observed.stdout.trim()
  if (observed.code === 0 && OBJECT_ID.test(resolved)) return resolved.toLowerCase()
  const ambiguity = observed.stderr.trim()
  const failure = detail(
    "invalid-commit",
    "resolve-commit",
    `Gitlink commit ${commit} does not resolve to exactly one commit in submodule ${path}; pass the full 40-hex object ID instead — \`git -C <submodule> rev-parse ${commit}\` prints it, then rerun \`bun git-super --repo <dir> gitlink write ${path} <full-oid>\`.`,
    {
      paths: [path],
      objectIds: [commit],
      ...(ambiguity === "" ? {} : { evidence: ambiguity }),
      remedy: `Get the full ID with \`git -C <submodule> rev-parse ${commit}\`, then rerun \`bun git-super --repo <dir> gitlink write ${path} <full-oid>\`.`,
    },
  )
  return operationResult(repository, "failed", failure)
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

function postWriteCleanupFailure(
  repository: string,
  path: string,
  commit: string,
  error: unknown,
  postWriteResult: GitSuperResult | undefined,
): GitSuperResult {
  const verified = postWriteResult?.state === "updated"
  const observationDetail = postWriteResult?.repositories[0]?.detail ?? postWriteResult?.detail
  const failure = detail(
    verified ? "post-write-lock-release-failed" : "post-write-observation-and-lock-release-failed",
    "release-mutation-lock",
    verified
      ? `Gitlink ${path} was written to ${commit}, but the mutation lock could not be released: ${error instanceof Error ? error.message : String(error)}`
      : `Git accepted the write for ${path} at ${commit}, but the resulting index state could not be verified and the mutation lock could not be released: ${error instanceof Error ? error.message : String(error)}`,
    {
      paths: [path],
      objectIds: [commit],
      remedy: verified
        ? "Treat the index write as applied. Inspect the index and lock owner before retrying; restart the caller if it still holds the lock."
        : "Treat the index state as unknown. Inspect `git ls-files --stage` and the lock owner before retrying; restart the caller if it still holds the lock.",
    },
  )
  return {
    state: "failed",
    partial: true,
    detail: failure,
    repositories: [
      {
        repository,
        state: verified ? "updated" : "unknown",
        ...(observationDetail === undefined ? {} : { detail: observationDetail }),
        refs: [],
      },
    ],
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

async function indexEntries(git: GitProcess, repository: string, path: string): Promise<IndexEntry[]> {
  const args = ["ls-files", "--stage", "-z", "--full-name", "--", path]
  const result = await git.run({ repo: repository, args })
  if (result.code !== 0) throw operationError(repository, args, "observe-index", result, { paths: [path] })
  return parseIndexEntries(result.stdout, (record, entryPath) => {
    const evidence = `Invalid index record: ${JSON.stringify(record)}`
    return Object.assign(new Error(`git-super: invalid index entry returned by ${repository}`), {
      resultDetail: detail(
        "invalid-index-entry",
        "observe-index",
        `Git returned an invalid index entry while inspecting ${repository}. ${evidence}`,
        {
          remedy: "Inspect the index with `git ls-files --stage` and repair it before retrying.",
          evidence,
          ...(entryPath === undefined ? {} : { paths: [entryPath] }),
        },
      ),
    })
  }).filter((entry) => entry.path === path)
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
