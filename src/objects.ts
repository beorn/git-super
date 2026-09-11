import { createLocalGitProcess, type GitProcess, type GitProcessResult } from "./process.ts"
import type { GitResultDetail } from "./result.ts"

export type EnsureCommitObjectOptions = Readonly<{
  repository: string
  remote: string
  commit: string
  timeoutMs?: number
  git?: GitProcess
  /**
   * Whether the fetch anchors the object under {@link pinRef}. Defaults to TRUE,
   * because an object fetched with no ref pointing at it is prunable and the
   * caller that asked for it usually needs it to still be there afterwards.
   *
   * `false` is for a caller that must leave the store's REFS untouched —
   * `observe` is the one, and its own test asserts exactly that. Such a caller
   * accepts that what it fetched is garbage-collectable, which is the right
   * trade for an observation and the wrong one for anything that then acts.
   */
  anchor?: boolean
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

/**
 * Where a fetched exact commit is anchored, named for the object itself.
 *
 * ONE HOME FOR THIS SPELLING. The reference warm-up and the retention rows
 * already write into this namespace; this is the third construction of the same
 * string and the point at which a fourth literal becomes the defect rather than
 * the convenience. Naming the ref after the sha means a repeat fetch for the
 * same object only ever rewrites the ref to the value it already has.
 */
export function pinRef(commit: string): string {
  return `refs/git-super/pins/${commit}`
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
    // A DESTINATION REF, not a bare want. A fetch that lands the object with no
    // ref pointing at it leaves it unreachable, and the next `gc` in this
    // repository is free to take it — `reference.ts` learned exactly this on
    // 2026-09-09 and this was the third bare-sha fetch left in the tree.
    options.anchor === false ? options.commit : `${options.commit}:${pinRef(options.commit)}`,
  ]
  const fetched = await git.run({ repo: options.repository, args: fetchArgs })
  if (fetched.code !== 0) throw operationError(options.repository, fetchArgs, "fetch-exact-commit", fetched)
  const verified = await git.run({ repo: options.repository, args: verifyArgs })
  if (verified.code !== 0) throw operationError(options.repository, verifyArgs, "verify-exact-commit", verified)
  return "fetched"
}
