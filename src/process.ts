import { cleanGitEnvironment, cleanGitRepositoryEnvironment } from "./git.ts"

export { cleanGitEnvironment } from "./git.ts"

export type GitProcessRequest = Readonly<{
  repo: string
  args: readonly string[]
  env?: NodeJS.ProcessEnv
  stdin?: string
  signal?: AbortSignal
  timeoutMs?: number
}>

export type GitProcessResult = Readonly<{
  code: number
  stdout: string
  stderr: string
  failure?: string
  signal?: string | null
  timedOut?: boolean
  stalled?: boolean
}>

/**
 * Read-only network verbs that are safe to re-run after a STALL.
 *
 * Measured 2026-08-21: one `yrd queue run` makes ~90 git calls, and the per-call
 * stall rate against origin was 20-40% all evening. At those numbers the whole
 * operation succeeds about 1e-14 of the time — so a queue run essentially cannot
 * complete, and 0-of-10 observed failures is overdetermined rather than evidence
 * of any queue-specific bug. Retry is the only lever that reaches a usable
 * number: ~99.9% per call is what gets a 90-call operation to 90%.
 *
 * Deliberately NOT every verb. Only calls that are idempotent AND read-only are
 * listed: re-running `push`, `commit`, `merge` or `update-ref` after a stall
 * could act twice, and a stalled mutation may already have reached the remote.
 * `fetch` qualifies because it only advances remote-tracking refs.
 */
const RETRYABLE_READ_ONLY: ReadonlySet<string> = new Set(["ls-remote", "fetch"])

/** Attempts INCLUDING the first. 3 turns a 30% stall into ~2.7% for that call. */
const STALL_ATTEMPTS = 3

/** Backoff before re-running a stalled read. Short: the caller holds a deadline. */
const STALL_BACKOFF_MS = 250

export function isRetryableRead(args: readonly string[]): boolean {
  const verb = args.find((arg) => !arg.startsWith("-"))
  return verb !== undefined && RETRYABLE_READ_ONLY.has(verb)
}

/**
 * Wrap a GitProcess so a STALLED read-only network call is re-run.
 *
 * Exported and injectable so the policy is testable without a real stall: the
 * whole point is behaviour under a condition that is expensive and flaky to
 * reproduce, and a retry policy nobody can test is one nobody can change.
 */
export function withStallRetry(inner: GitProcess): GitProcess {
  return {
    async run(request) {
      // Only a STALL is retried, never a non-zero exit: an exit code is git
      // answering the question, and re-asking would paper over a real failure.
      if (!isRetryableRead(request.args)) return inner.run(request)
      let result = await inner.run(request)
      for (let attempt = 2; result.timedOut === true && attempt <= STALL_ATTEMPTS; attempt += 1) {
        // NO SILENT ERRORS: a retry nobody can see turns a measurable stall
        // rate into an invisible one, and this defect cost an evening precisely
        // because the stalls were being read as something else.
        console.error(
          `git-super: ${request.args[0] ?? "git"} stalled after ${String(request.timeoutMs)}ms in ${request.repo}; ` +
            `retry ${String(attempt)}/${String(STALL_ATTEMPTS)}`,
        )
        await new Promise((resolve) => setTimeout(resolve, STALL_BACKOFF_MS))
        result = await inner.run(request)
      }
      return result
    },
  }
}

/** The one injectable Git process capability used by graph operations. */
export type GitProcess = Readonly<{
  run(request: GitProcessRequest): Promise<GitProcessResult>
}>

/** The supervised runner capability Git needs; its owner retains process lifetime and teardown. */
export type SupervisedProcess = Readonly<{
  run(
    request: Readonly<{
      argv: readonly string[]
      cwd: string
      env: NodeJS.ProcessEnv
      stdin?: string
      signal?: AbortSignal
      timeoutMs?: number
    }>,
  ): Promise<
    Readonly<{
      exitCode: number
      stdout: string
      stderr: string
      signal: string | null
      timedOut: boolean
      stalled?: boolean
      verdict?: string
      sweepFailure?: string
    }>
  >
}>

export type GitProcessDefaults = Readonly<{
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  timeoutMs?: number
}>

/** Fleet runners adapt their supervised process; CLI and development callers use createLocalGitProcess. */
export function adaptProcessGit(process: SupervisedProcess, defaults: GitProcessDefaults = {}): GitProcess {
  return {
    async run(request) {
      const env = {
        ...cleanGitEnvironment(defaults.env ?? globalThis.process.env),
        ...request.env,
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
        TZ: "UTC",
      }
      const result = await process.run({
        argv: ["git", "-C", request.repo, ...request.args],
        cwd: request.repo,
        env,
        ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
        ...((request.signal ?? defaults.signal) === undefined ? {} : { signal: request.signal ?? defaults.signal }),
        ...((request.timeoutMs ?? defaults.timeoutMs) === undefined
          ? {}
          : { timeoutMs: request.timeoutMs ?? defaults.timeoutMs }),
      })
      return {
        code: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        signal: result.signal,
        timedOut: result.timedOut,
        ...(result.stalled === undefined ? {} : { stalled: result.stalled }),
        ...((result.verdict !== undefined && result.verdict !== "EXITED") || result.sweepFailure !== undefined
          ? { failure: result.sweepFailure ?? `process verdict ${result.verdict}` }
          : {}),
      }
    },
  }
}

export function createLocalGitProcess(environment: NodeJS.ProcessEnv = process.env): GitProcess {
  // Local callers own Git policy (for example GIT_ALLOW_PROTOCOL and GIT_CONFIG_*),
  // so only inherited repository pointers are removed; the supervised port uses the full scrubber.
  const baseEnvironment = cleanGitRepositoryEnvironment(environment)

  const runOnce = async (request: GitProcessRequest): Promise<GitProcessResult> => {
    {
      let timedOut = false
      let child: ReturnType<typeof Bun.spawn>
      try {
        child = Bun.spawn(["git", "-C", request.repo, ...request.args], {
          env: { ...baseEnvironment, ...request.env },
          stdin: request.stdin === undefined ? "ignore" : new Blob([request.stdin]),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
          stdout: "pipe",
          stderr: "pipe",
        })
      } catch (error) {
        const failure = error instanceof Error ? error.message : String(error)
        return { code: 1, stdout: "", stderr: failure, failure }
      }
      const timer =
        request.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true
              child.kill()
            }, request.timeoutMs)
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout as ReadableStream<Uint8Array>).text(),
        new Response(child.stderr as ReadableStream<Uint8Array>).text(),
      ])
      if (timer !== undefined) clearTimeout(timer)
      return {
        code,
        stdout,
        stderr: stderr.trim(),
        ...(timedOut ? { timedOut: true } : {}),
      }
    }
  }

  return withStallRetry({ run: runOnce })
}
