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
  remedy = "Restore access to the named exact commit, then rerun the same graph operation.",
  style: "graph" | "scan" = "graph",
  messageOverride?: string,
): Error & Readonly<{ resultDetail: GitResultDetail }> {
  const reason = result.timedOut
    ? "timed out"
    : result.failure !== undefined
      ? `could not run: ${result.failure}`
      : `failed (exit ${result.code})`
  const message =
    messageOverride ??
    (style === "scan"
      ? `git ${args.join(" ")} ${reason} in ${repository}${result.stderr ? `\n${result.stderr.trim()}` : ""}`
      : result.timedOut
        ? `git ${args.join(" ")} timed out in ${repository}`
        : `git ${args.join(" ")} failed in ${repository} (exit ${result.code})${result.stderr ? `\n${result.stderr}` : ""}`)
  return Object.assign(new Error(message), {
    resultDetail: {
      code: result.timedOut ? "git-timeout" : "git-failed",
      phase,
      message,
      remedy,
    },
  })
}

export type CheckedObject =
  | Readonly<{ input: string; oid: string; type: string }>
  | Readonly<{ input: string; missing: true }>

/** The one batch-check process and answer parser for object scans. */
export async function batchCheckObjects(
  git: GitProcess,
  repository: string,
  names: readonly string[],
  phase: string,
  remedy = "Restore access to the named exact commit, then rerun the same graph operation.",
  timeoutMs?: number,
  errorStyle: "graph" | "scan" = "graph",
): Promise<readonly CheckedObject[]> {
  if (names.length === 0) return []
  const args = ["cat-file", "--batch-check=%(objectname) %(objecttype)"]
  const checked = await git.run({
    repo: repository,
    args,
    stdin: `${names.join("\n")}\n`,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  })
  if (checked.code !== 0 || checked.timedOut || checked.failure !== undefined || checked.signal) {
    throw operationError(repository, args, phase, checked, remedy, errorStyle)
  }
  const answers = checked.stdout.split(/\r?\n/u).filter(Boolean)
  if (answers.length !== names.length) {
    throw operationError(
      repository,
      args,
      phase,
      {
        ...checked,
        code: 1,
        stderr: `git cat-file --batch-check answered ${answers.length} lines for ${names.length} names`,
      },
      remedy,
      errorStyle,
      errorStyle === "scan"
        ? `git cat-file --batch-check answered ${answers.length} lines for ${names.length} refs in ${repository}`
        : undefined,
    )
  }
  return answers.map((answer, index) => {
    const input = names[index]
    if (input === undefined) throw new Error(`Missing input for object answer ${index} in ${repository}`)
    if (answer === `${input} missing`) return { input, missing: true }
    const [oid, type, extra] = answer.split(" ")
    if (extra !== undefined || oid === undefined || type === undefined || !OBJECT_ID.test(oid) || type === "missing") {
      throw new Error(`Malformed object answer for ${input} in ${repository}: ${answer}`)
    }
    return { input, oid, type }
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

/** One local ref whose object this repository no longer has. */
export type DanglingRef = Readonly<{ ref: string; oid: string }>

/**
 * Every local ref that names a missing object, from ONE `for-each-ref` and ONE
 * `cat-file --batch-check`. The explicit `for-each-ref` format reads no object,
 * so a packed ref whose object is gone is still listed; the default format reads
 * `%(objecttype)` and dies on it. `cat-file` is fed object ids only (a whole
 * "<oid> <ref>" line would be read as one object name) and answers one line per
 * id, in order, so the two lists pair by position.
 *
 * An empty result means scanned, none dangling. A scan that cannot run throws
 * with git's text, never an empty list that would read as a clean repository.
 */
export async function danglingRefs(git: GitProcess, repository: string): Promise<readonly DanglingRef[]> {
  const listArgs = ["for-each-ref", "--format=%(objectname) %(refname)"] as const
  const listed = await git.run({ repo: repository, args: listArgs, timeoutMs: DEFAULT_GIT_TIMEOUT_MS })
  if (listed.timedOut || listed.failure !== undefined || listed.code !== 0) {
    throw operationError(repository, listArgs, "scan-dangling-refs", listed, undefined, "scan")
  }
  const refs = listed.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const space = line.indexOf(" ")
      return { oid: line.slice(0, space), ref: line.slice(space + 1) }
    })
  if (refs.length === 0) return []
  const answers = await batchCheckObjects(
    git,
    repository,
    refs.map(({ oid }) => oid),
    "scan-dangling-refs",
    undefined,
    DEFAULT_GIT_TIMEOUT_MS,
    "scan",
  )
  return refs.filter((_, index) => answers[index] !== undefined && "missing" in answers[index])
}
