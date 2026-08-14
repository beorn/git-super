import { createLocalGitProcess, type GitProcess, type GitProcessResult } from "./process.ts"
import type { GitResultDetail } from "./result.ts"

export type EnsureCommitObjectOptions = Readonly<{
  repository: string
  remote: string
  commit: string
  timeoutMs?: number
  git?: GitProcess
}>

const DEFAULT_GIT_TIMEOUT_MS = 30_000
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u

function operationError(
  repository: string,
  args: readonly string[],
  phase: string,
  result: GitProcessResult,
): Error & Readonly<{ resultDetail: GitResultDetail }> {
  const message = result.timedOut
    ? `git ${args.join(" ")} timed out in ${repository}`
    : `git ${args.join(" ")} failed in ${repository} (exit ${result.code})${result.stderr ? `\n${result.stderr}` : ""}`
  return Object.assign(new Error(message), {
    resultDetail: {
      code: result.timedOut ? "git-timeout" : "git-failed",
      phase,
      message,
      remedy: "Restore access to the named exact commit, then rerun the same graph operation.",
    },
  })
}

/** Ensure an exact commit exists locally, fetching only that object when it is missing. */
export async function ensureCommitObject(options: EnsureCommitObjectOptions): Promise<"fetched" | "present"> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Git command timeout must be a positive finite number.")
  }
  if (!OBJECT_ID.test(options.commit)) {
    throw new Error(`exact commit fetch requires an object ID: ${options.commit}`)
  }
  const process = options.git ?? createLocalGitProcess()
  const git: GitProcess = {
    run: (request) => process.run({ ...request, timeoutMs: request.timeoutMs ?? timeoutMs }),
  }
  const verifyArgs = ["cat-file", "-e", `${options.commit}^{commit}`]
  const present = await git.run({ repo: options.repository, args: verifyArgs })
  if (present.code === 0) return "present"
  const fetchArgs = [
    "fetch",
    "--no-tags",
    "--no-recurse-submodules",
    "--no-write-fetch-head",
    options.remote,
    options.commit,
  ]
  const fetched = await git.run({ repo: options.repository, args: fetchArgs })
  if (fetched.code !== 0) throw operationError(options.repository, fetchArgs, "fetch-exact-commit", fetched)
  const verified = await git.run({ repo: options.repository, args: verifyArgs })
  if (verified.code !== 0) throw operationError(options.repository, verifyArgs, "verify-exact-commit", verified)
  return "fetched"
}
