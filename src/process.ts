import {
  applyGitObjectContext,
  cleanGitEnvironment,
  cleanGitRepositoryEnvironment,
  type GitObjectContext,
} from "./git.ts"
import {
  accessSync,
  appendFileSync,
  constants,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs"
import { spawn } from "node:child_process"
import type { Readable } from "node:stream"
import { constants as osConstants, tmpdir } from "node:os"
import { delimiter, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { fullJitter } from "@bearly/pacing"

export { applyGitObjectContext, cleanGitEnvironment, validateGitObjectContext, type GitObjectContext } from "./git.ts"

export type ProcessOutputSink = Readonly<{ write(value: string | Uint8Array): unknown }>

/** Resolve the native executable separately; selecting this binary must not recurse. */
export function nativeGitExecutable(): string {
  let executable: string | undefined
  for (const directory of process.env.PATH?.split(delimiter) ?? []) {
    const candidate = resolve(directory, "git")
    try {
      if (!statSync(candidate).isFile()) continue
      accessSync(candidate, constants.X_OK)
      executable = candidate
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "EACCES") {
        throw new Error(`git-super: cannot inspect native Git candidate ${candidate}`, { cause: error })
      }
    }
  }
  if (executable === undefined) throw new Error("git-super: native Git executable 'git' was not found on PATH")
  if (realpathSync(executable) === realpathSync(fileURLToPath(new URL("../bin/git-super", import.meta.url)))) {
    throw new Error(`git-super: native Git resolves to git-super itself: ${executable}`)
  }
  return executable
}

/** Raw transport shared by local graph policy and native CLI delegation. */
function spawnGit(
  args: readonly string[],
  options: {
    env: NodeJS.ProcessEnv
    stdin: "inherit" | "ignore" | "pipe"
    input?: string
    signal?: AbortSignal
    detached?: boolean
  },
) {
  options.signal?.throwIfAborted()
  const child = spawn(nativeGitExecutable(), [...args], {
    env: options.env,
    stdio: [options.stdin, "pipe", "pipe"],
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.detached === undefined ? {} : { detached: options.detached }),
  })
  // Exit and pipe closure are distinct: descendants may retain the pipes after Git exits.
  // An async exec failure has no exit event. It must still settle this handle.
  const exited = new Promise<Pick<GitProcessResult, "code" | "signal" | "failure">>((resolve) => {
    child.once("error", (error) => resolve({ code: 1, failure: String(error) }))
    child.once("exit", (code, signal) =>
      resolve({
        code: code ?? (signal === null ? 1 : 128 + (osConstants.signals[signal] ?? 0)),
        ...(signal === null ? {} : { signal, failure: `native Git terminated by signal ${signal}` }),
        ...(code === null && signal === null ? { failure: "native Git exited without an exit code or signal" } : {}),
      }),
    )
  })
  let inputFailure: string | undefined
  child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
    // Git may deliberately stop reading. EPIPE never replaces its exit result.
    if (error.code !== "EPIPE") inputFailure = `native Git stdin failed: ${String(error)}`
  })
  if (options.input !== undefined) child.stdin?.end(options.input)
  return {
    pid: child.pid,
    stdout: child.stdout as Readable,
    stderr: child.stderr as Readable,
    exited,
    kill: () => child.kill("SIGTERM"),
    inputFailure: () => inputFailure,
  }
}

/** Capture pipes independently so a stream failure cannot replace the native process outcome. */
async function captureGit(child: ReturnType<typeof spawnGit>): Promise<GitProcessResult> {
  const collect = async (stream: Readable) => {
    const chunks: Buffer[] = []
    let failure: string | undefined
    try {
      for await (const bytes of stream as AsyncIterable<unknown>) chunks.push(nativeOutputBytes(bytes))
    } catch (error) {
      failure = `native Git output capture failed: ${String(error)}`
    }
    return { text: Buffer.concat(chunks).toString("utf8"), failure }
  }
  const [outcome, stdout, stderr] = await Promise.all([child.exited, collect(child.stdout), collect(child.stderr)])
  const failure =
    outcome.failure ?? stdout.failure ?? stderr.failure ?? (outcome.code === 0 ? child.inputFailure() : undefined)
  return {
    ...outcome,
    stdout: stdout.text,
    stderr: stderr.text || outcome.failure || "",
    ...(failure === undefined ? {} : { failure }),
  }
}

function nativeOutputBytes(value: unknown): Buffer {
  if (typeof value === "string" || value instanceof Uint8Array) return Buffer.from(value)
  throw new TypeError("native Git output stream yielded a non-byte chunk")
}

/** Native command output for dispatch observations. No scrub, retry or text trimming. */
export async function readNativeGit(args: readonly string[]): Promise<GitProcessResult> {
  const child = spawnGit(args, { env: process.env, stdin: "ignore" })
  return captureGit(child)
}

/** The executable replaces itself so native Git owns stdin, bytes, signals and lifetime. */
export async function delegateNativeGit(
  args: readonly string[],
  stdout: ProcessOutputSink,
  stderr: ProcessOutputSink,
  replaceProcess: boolean,
): Promise<number> {
  if (typeof Bun === "undefined") {
    throw new Error("git-super: native delegation is a Bun CLI operation; Bun CLI requires Bun >=1.3.14")
  }
  if (replaceProcess) {
    if (process.execve === undefined) {
      throw new Error(`git-super: Bun ${Bun.version} lacks process.execve; use Bun >=1.3.14 for native Git delegation`)
    }
    const executable = nativeGitExecutable()
    process.execve(executable, [executable, ...args], process.env)
  }
  // In-process CLI consumers retain their process and supply the output sinks.
  const child = spawnGit(args, { env: process.env, stdin: "inherit" })
  const forward = async (stream: Readable, sink: ProcessOutputSink) => {
    for await (const bytes of stream as AsyncIterable<unknown>) sink.write(nativeOutputBytes(bytes))
  }
  const [outcome, out, err] = await Promise.allSettled([
    child.exited,
    forward(child.stdout, stdout),
    forward(child.stderr, stderr),
  ])
  if (outcome.status === "rejected") throw outcome.reason
  if (outcome.value.code !== 0) return outcome.value.code
  if (out.status === "rejected") throw out.reason
  if (err.status === "rejected") throw err.reason
  return outcome.value.code
}

export type GitProcessRequest = Readonly<{
  repo: string
  args: readonly string[]
  env?: NodeJS.ProcessEnv
  stdin?: string
  signal?: AbortSignal
  timeoutMs?: number
  /**
   * Run the command in its own process group, so a signal to the caller's group (a terminal's Ctrl-C) does not reach
   * it. Its group is appended to the file {@link APPLY_GROUPS_ENV} names, when set, for a backstop to kill (24907).
   */
  detached?: boolean
  /**
   * Opt-in backstop (24907): the command runs in its own group, SIGTERM still goes to its pid at `timeoutMs`, and at
   * `backstopMs` SIGKILL goes to its group and to every group a detached descendant recorded in the file
   * {@link APPLY_GROUPS_ENV} names. Nothing of the command survives it.
   */
  backstopMs?: number
}>

export type GitProcessResult = Readonly<{
  code: number
  stdout: string
  stderr: string
  failure?: string
  signal?: string | null
  timedOut?: boolean
  stalled?: boolean
  /** What the backstop killed, when it fired: loud, never a quiet timeout. */
  backstop?: string
}>

/**
 * The FILE a detached command's process group is appended to, one pgid per line (24907). A child cannot change its
 * parent's environment, so the record is this file: git-super appends to it, the parent's backstop reads it.
 */
export const APPLY_GROUPS_ENV = "GIT_SUPER_APPLY_GROUPS"

/** Append a detached child's group to the record, when the caller armed one; a failed write is said, not swallowed. */
function recordApplyGroup(pid: number): void {
  const file = process.env[APPLY_GROUPS_ENV]
  if (file === undefined || file === "") return
  try {
    appendFileSync(file, `${String(pid)}\n`)
  } catch (error) {
    process.stderr.write(
      `git-super: could not record process group ${String(pid)} in ${file} (${error instanceof Error ? error.message : String(error)}); ` +
        "a backstop will not see it\n",
    )
  }
}

/** SIGKILL a command's own group and every group its detached descendants recorded; never throws. */
function killBackstopGroups(pid: number, groupsFile: string, afterMs: number): string {
  let recorded: number[] = []
  let unreadable = ""
  try {
    recorded = readFileSync(groupsFile, "utf8")
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((group) => Number.isSafeInteger(group) && group > 1)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ENOENT") unreadable = `; the group record ${groupsFile} was unreadable (${code ?? String(error)})`
  }
  const groups = [...new Set([pid, ...recorded])]
  const failures: string[] = []
  for (const group of groups) {
    try {
      process.kill(-group, "SIGKILL")
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ESRCH") failures.push(`${String(group)}: ${code ?? String(error)}`)
    }
  }
  return (
    `backstop at ${String(afterMs)}ms: SIGKILL to process group(s) ${groups.join(", ")}` +
    ` (${String(recorded.length)} recorded by the command)${unreadable}` +
    (failures.length === 0 ? "" : `; kill(s) FAILED: ${failures.join(", ")}`)
  )
}

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
const PUBLICKEY_BACKOFF_MS = 3_000

export function isRetryableRead(args: readonly string[]): boolean {
  const verb = args.find((arg) => !arg.startsWith("-"))
  return verb !== undefined && RETRYABLE_READ_ONLY.has(verb)
}

/** OpenSSH's exact publickey refusal line, distinct from other exit-128 failures. */
export function isExactPublickeyRefusal(result: Pick<GitProcessResult, "code" | "stderr">): boolean {
  return (
    result.code !== 0 &&
    result.stderr.split(/\r?\n/u).some((line) => /^(?:\S+: )?Permission denied \(publickey\)\.$/u.test(line))
  )
}

/**
 * The lines a read prints when its SSH session drops mid-read, and nothing else (measured 2026-09-25). A
 * client of a shared ControlMaster connection prints only Git's own fatal lines when the master dies; a
 * direct connection names the close first. A refusal always adds a line of its own (publickey, repository not found,
 * `ssh: connect ...`), so it never matches, and an unknown line means no retry: today's behaviour, never a wrong one.
 */
const SSH_SESSION_DROP_LINES: readonly RegExp[] = [
  /^Connection to \S+ closed by remote host\.$/u,
  /^fatal: Could not read from remote repository\.$/u,
  /^Please make sure you have the correct access rights$/u,
  /^and the repository exists\.$/u,
  /^fatal: expected flush after ref listing$/u,
]

/** An exit 128 whose every non-empty stderr line is a measured session-drop line. */
export function isSshSessionDrop(result: Pick<GitProcessResult, "code" | "stderr">): boolean {
  if (result.code !== 128) return false
  const lines = result.stderr.split(/\r?\n/u).filter((line) => line.trim() !== "")
  return lines.length > 0 && lines.every((line) => SSH_SESSION_DROP_LINES.some((drop) => drop.test(line)))
}

/** Preserve Git's SSH selection while enabling OpenSSH's offered-key trace. */
export function verboseSshRetryEnvironment(
  env: NodeJS.ProcessEnv,
  coreSshCommand: string | undefined,
): Readonly<{ env: NodeJS.ProcessEnv; command: string }> {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const selected =
    env.GIT_SSH_COMMAND !== undefined
      ? env.GIT_SSH_COMMAND
      : coreSshCommand !== undefined
        ? coreSshCommand
        : env.GIT_SSH !== undefined
          ? quote(env.GIT_SSH)
          : "ssh"
  if (selected.trim() === "") throw new Error("git-super: effective SSH command is empty after a publickey refusal")
  const command = `${selected} -v`
  return { env: { ...env, GIT_SSH_COMMAND: command }, command }
}

/** An exit 1 with no output is Git's documented absent config answer. */
export function coreSshCommandFromConfig(result: GitProcessResult, repo: string): string | undefined {
  if (result.failure !== undefined || result.timedOut || result.stalled || result.signal) {
    const reason =
      result.failure ??
      (result.timedOut
        ? "timed out"
        : result.stalled
          ? "stalled"
          : result.signal
            ? `signal ${result.signal}`
            : "incomplete")
    throw new Error(
      `git-super: cannot read core.sshCommand in ${repo}: ${reason}; exit ${String(result.code)}: ${result.stderr}`,
    )
  }
  if (result.code === 1 && result.stdout === "" && result.stderr === "") return undefined
  if (result.code !== 0) {
    throw new Error(`git-super: cannot read core.sshCommand in ${repo}: exit ${String(result.code)}: ${result.stderr}`)
  }
  return result.stdout.replace(/\r?\n$/u, "")
}

function waitForReadRetry(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer)
      resolve(false)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve(true)
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/**
 * Wrap a GitProcess so a STALLED read-only network call is re-run.
 *
 * Exported and injectable so the policy is testable without a real stall: the
 * whole point is behaviour under a condition that is expensive and flaky to
 * reproduce, and a retry policy nobody can test is one nobody can change.
 */
export type StallRetryOptions = Readonly<{ attempts?: 1 | 3; objects?: GitObjectContext }>

export function withStallRetry(inner: GitProcess, options: StallRetryOptions = {}): GitProcess {
  return withReadRetry(inner, options, globalThis.process.env)
}

function withReadRetry(inner: GitProcess, options: StallRetryOptions, environment: NodeJS.ProcessEnv): GitProcess {
  const attempts = options.attempts ?? STALL_ATTEMPTS
  if (attempts !== 1 && attempts !== STALL_ATTEMPTS) throw new Error("Git read attempts must be 1 or 3.")
  return {
    async run(request) {
      if (!isRetryableRead(request.args)) return inner.run(request)
      let result = await inner.run(request)
      let stallAttempt = 1
      let retriedSsh = false
      while (true) {
        if (result.timedOut === true && stallAttempt < attempts) {
          stallAttempt += 1
          const delayMs = 1 + Math.floor(fullJitter(STALL_BACKOFF_MS, STALL_BACKOFF_MS, 0))
          // NO SILENT ERRORS: a retry nobody can see turns a measurable stall
          // rate into an invisible one, and this defect cost an evening precisely
          // because the stalls were being read as something else.
          console.error(
            `git-super: ${request.args[0] ?? "git"} stalled after ${String(request.timeoutMs)}ms in ${request.repo}; ` +
              `retry ${String(stallAttempt)}/${String(attempts)} after ${String(delayMs)}ms`,
          )
          if (!(await waitForReadRetry(delayMs, request.signal))) return result
          result = await inner.run(request)
          continue
        }
        // One announced SSH retry per read, for either predicate (25282, 25616): the announcement names which matched.
        const ssh = isExactPublickeyRefusal(result)
          ? "Permission denied (publickey)."
          : isSshSessionDrop(result)
            ? "SSH session dropped"
            : undefined
        if (
          attempts > 1 &&
          !retriedSsh &&
          result.failure === undefined &&
          (result.signal === undefined || result.signal === null) &&
          result.timedOut !== true &&
          result.stalled !== true &&
          ssh !== undefined
        ) {
          retriedSsh = true
          if (request.signal?.aborted) return result
          if (ssh === "SSH session dropped") {
            const delayMs = 1 + Math.floor(fullJitter(PUBLICKEY_BACKOFF_MS, PUBLICKEY_BACKOFF_MS, 0))
            console.error(
              `git-super: git ${request.args.join(" ")} in ${request.repo}: ${ssh}; ` +
                `retry 2/2 after ${String(delayMs)}ms`,
            )
            if (!(await waitForReadRetry(delayMs, request.signal))) return result
            result = await inner.run(request)
            continue
          }
          const effectiveEnv = { ...environment, ...request.env }
          let verbose: ReturnType<typeof verboseSshRetryEnvironment>
          try {
            const config =
              effectiveEnv.GIT_SSH_COMMAND === undefined
                ? coreSshCommandFromConfig(
                    await inner.run({ ...request, args: ["config", "--get", "core.sshCommand"] }),
                    request.repo,
                  )
                : undefined
            verbose = verboseSshRetryEnvironment(effectiveEnv, config)
          } catch (error) {
            console.error(
              `git-super: git ${request.args.join(" ")} in ${request.repo}: Permission denied (publickey).; ` +
                `SSH retry skipped: ${String(error)}`,
            )
            return result
          }
          const delayMs = 1 + Math.floor(fullJitter(PUBLICKEY_BACKOFF_MS, PUBLICKEY_BACKOFF_MS, 0))
          console.error(
            `git-super: git ${request.args.join(" ")} in ${request.repo}: Permission denied (publickey).; ` +
              `retry 2/2 after ${String(delayMs)}ms with ${verbose.command}`,
          )
          if (!(await waitForReadRetry(delayMs, request.signal))) return result
          result = await inner.run({
            ...request,
            env: { ...request.env, GIT_SSH_COMMAND: verbose.command },
          })
          continue
        }
        return result
      }
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
  objects?: GitObjectContext
  signal?: AbortSignal
  timeoutMs?: number
}>

/** Fleet runners adapt their supervised process; CLI and development callers use createLocalGitProcess. */
export function adaptProcessGit(process: SupervisedProcess, defaults: GitProcessDefaults = {}): GitProcess {
  return {
    async run(request) {
      const env = applyGitObjectContext(
        {
          ...cleanGitEnvironment(defaults.env ?? globalThis.process.env),
          ...request.env,
          GIT_TERMINAL_PROMPT: "0",
          LC_ALL: "C",
          TZ: "UTC",
        },
        defaults.objects,
      )
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

export function createLocalGitProcess(environment?: NodeJS.ProcessEnv, options: StallRetryOptions = {}): GitProcess {
  // Local callers own Git policy (for example GIT_ALLOW_PROTOCOL and GIT_CONFIG_*),
  // so only inherited repository pointers are removed; the supervised port uses the full scrubber.
  const baseEnvironment = cleanGitRepositoryEnvironment(environment, options.objects)

  const runOnce = async (request: GitProcessRequest): Promise<GitProcessResult> => {
    {
      let timedOut = false
      let backstop: string | undefined
      let child: ReturnType<typeof spawnGit>
      // The backstop's record of the groups this command's detached descendants start (24907).
      const groupsDir =
        request.backstopMs === undefined ? undefined : mkdtempSync(join(tmpdir(), "git-super-apply-groups-"))
      const groupsFile = groupsDir === undefined ? undefined : join(groupsDir, "groups")
      try {
        child = spawnGit(["-C", request.repo, ...request.args], {
          env: applyGitObjectContext(
            {
              ...baseEnvironment,
              ...request.env,
              ...(groupsFile === undefined ? {} : { [APPLY_GROUPS_ENV]: groupsFile }),
            },
            options.objects,
          ),
          stdin: request.stdin === undefined ? "ignore" : "pipe",
          ...(request.stdin === undefined ? {} : { input: request.stdin }),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
          ...(request.detached === true || groupsFile !== undefined ? { detached: true } : {}),
        })
      } catch (error) {
        if (groupsDir !== undefined) rmSync(groupsDir, { recursive: true, force: true })
        const failure = error instanceof Error ? error.message : String(error)
        return { code: 1, stdout: "", stderr: failure, failure }
      }
      if (request.detached === true && child.pid !== undefined) recordApplyGroup(child.pid)
      const timer =
        request.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true
              child.kill()
            }, request.timeoutMs)
      const backstopTimer =
        request.backstopMs === undefined || groupsFile === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true
              if (child.pid !== undefined) {
                backstop = killBackstopGroups(child.pid, groupsFile, request.backstopMs as number)
              }
            }, request.backstopMs)
      try {
        const result = await captureGit(child)
        return {
          ...result,
          stderr: result.stderr.trim(),
          ...(timedOut ? { timedOut: true } : {}),
          ...(backstop === undefined ? {} : { backstop }),
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        if (backstopTimer !== undefined) clearTimeout(backstopTimer)
        if (groupsDir !== undefined) rmSync(groupsDir, { recursive: true, force: true })
      }
    }
  }

  return withReadRetry({ run: runOnce }, options, baseEnvironment)
}
