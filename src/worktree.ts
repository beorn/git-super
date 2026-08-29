import { existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { appendFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { createExclusive } from "./exclusive.ts"
import { cleanGitEnvironment } from "./git.ts"
import { createLocalGitProcess, type GitProcess, type GitProcessResult } from "./process.ts"
import { materializeSubmodulesWithProcess } from "./submodules.ts"

export type GitResult = Readonly<{ code: number; stdout: string; stderr: string }>
export type Git = ReturnType<typeof createGit>

export type GitWorktreeStoreOptions = Readonly<{
  repo: string
  /**
   * The ONE injected Git capability. Required, and that is the point: while
   * three capability fields coexisted, "none supplied" and "two supplied" were
   * both representable and both had to be rejected at run time. One required
   * field makes each unrepresentable instead of merely detected.
   */
  gitProcess: GitProcess
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  timeouts?: Partial<GitWorktreeTimeouts>
}>

export type GitWorktreeTimeouts = Readonly<{
  operation: number
  cleanup: number
  mutationLock: number
}>

export type WorktreeHookPolicy = "inherit" | "quarantine"

export type WorktreeInspection = Readonly<{
  registered: boolean
  head?: string
  detached?: boolean
  locked?: string
}>

export type WorktreeAdd = Readonly<{ hooks?: WorktreeHookPolicy; lockReason?: string; operation?: string }> &
  (
    | Readonly<{ kind: "branch"; path: string; branch: string }>
    | Readonly<{ kind: "new-branch"; path: string; branch: string; ref: string }>
    | Readonly<{ kind: "reset-branch"; path: string; branch: string; ref: string }>
    | Readonly<{ kind: "ref"; path: string; ref: string }>
    | Readonly<{ kind: "detached"; path: string; ref: string }>
  )

const GIT_TIMEOUT_MS = 30_000
/** Worktree removal is correctness-critical and can exceed an interactive timeout under host load. */
const GIT_CLEANUP_TIMEOUT_MS = 120_000

export type LocalGitWorktreeStoreOptions = Omit<GitWorktreeStoreOptions, "gitProcess">

export type LocalGitWorktreeMutation =
  | Readonly<{ kind: "add-detached"; repo: string; path: string; ref: string; operation?: string }>
  | Readonly<{ kind: "remove"; repo: string; path: string; operation?: string; unlock?: boolean }>

export type LocalGitWorktreeMutationResult = Readonly<{ exitCode: number; stdout: string; stderr: string }>

/** Standard local-process adapter; hosts add policy, never another Git mutation runner. */
export function createLocalGitWorktreeStore(options: LocalGitWorktreeStoreOptions): GitWorktreeStore {
  return createGitWorktreeStore({
    ...options,
    gitProcess: createLocalGitProcess(options.env),
  })
}

/** Synchronous host seam for callers whose public transaction is intentionally synchronous. */
export function runLocalGitWorktreeMutationSync(request: LocalGitWorktreeMutation): LocalGitWorktreeMutationResult {
  const child = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./worktree-runner.ts", import.meta.url)), JSON.stringify(request)],
    { encoding: "utf8", env: cleanGitEnvironment(process.env) },
  )
  return {
    exitCode: child.status ?? 1,
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? child.error?.message ?? "git-super worktree runner failed",
  }
}

/**
 * The one Git VIEW: ergonomics over the one transport, and the only place
 * allowed to hold them. Exported so no caller has to hand-roll a rival — six
 * independently-declared git surfaces is how this codebase learned that a
 * private convenience wrapper is just a transport with a smaller blast radius.
 */
export function createGit(
  process: GitProcess,
  environment: NodeJS.ProcessEnv,
  operationTimeoutMs: number,
  signal?: AbortSignal,
) {
  const env = cleanGitEnvironment(environment)
  /**
   * Why the call did not SETTLE, or undefined when git actually answered.
   *
   * "git exited non-zero" is an answer. "git never finished" is not, and the
   * two must never collapse into one another — that collapse is what turns a
   * stalled repository into a clean-looking result.
   *
   * A timeout NAMES ITS BOUND, and a generic transport `failure` string must
   * not mask it: "timed out" without the limit that produced it sends the
   * reader hunting for a hang that was in fact a configured ceiling, and seven
   * suites across four packages assert the `timed out after <n>ms` shape.
   */
  const unsettledReason = (result: GitProcessResult, timeoutMs: number): string | undefined => {
    if (result.stalled === true) return "stalled"
    if (result.timedOut === true) return `timed out after ${String(timeoutMs)}ms`
    return result.failure ?? result.signal ?? undefined
  }

  const run = async (
    repo: string,
    args: readonly string[],
    allowFailure = false,
    timeoutMs = operationTimeoutMs,
  ): Promise<GitResult> => {
    const result = await process.run({ repo, args, env, ...(signal === undefined ? {} : { signal }), timeoutMs })
    const unsettled = unsettledReason(result, timeoutMs)
    if (unsettled !== undefined) {
      const message = `git ${args.join(" ")} ${unsettled} in ${repo}`
      if (!allowFailure) throw new Error(message)
      return { code: result.code === 0 ? 1 : result.code, stdout: result.stdout, stderr: result.stderr || message }
    }
    if (!allowFailure && result.code !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} exited ${result.code}`)
    }
    return { code: result.code, stdout: result.stdout, stderr: result.stderr }
  }
  const mutateConfig = async (repo: string, args: readonly string[]): Promise<GitResult> => {
    let result: GitResult | undefined
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      result = await run(repo, args, true)
      if (result.code === 0 || !result.stderr.includes("could not lock config file")) return result
      await Bun.sleep(attempt * 5)
    }
    if (result === undefined) throw new Error("git-super: Git config retry did not run")
    return result
  }
  const commit = async (repo: string, ref: string): Promise<string> =>
    text(repo, ["rev-parse", "--verify", `${ref}^{commit}`])

  /**
   * Read a VALUE out of git: trimmed stdout, throwing when git says no.
   *
   * The trim belongs to the CALL, not to a whole Git surface. Hoisting it to
   * the surface is what produced two "identical" `{code, stdout, stderr}`
   * transports that silently disagreed — one of them feeding a sha straight
   * into `reset --hard`, where a trailing newline breaks the reset. Ask for
   * `text` when you want a sha or a config value; ask for `run` when you want
   * a payload (a diff, a porcelain status) that must survive verbatim.
   */
  const text = async (repo: string, args: readonly string[], timeoutMs?: number): Promise<string> =>
    (await run(repo, args, false, timeoutMs)).stdout.trim()

  /**
   * Same, but a non-zero exit yields undefined instead of throwing — for the
   * questions where "cannot answer" is a real answer rather than a fault (an
   * unreadable submodule object, a ref that is simply absent).
   */
  const optionalText = async (
    repo: string,
    args: readonly string[],
    timeoutMs = operationTimeoutMs,
  ): Promise<string | undefined> => {
    const result = await process.run({ repo, args, env, ...(signal === undefined ? {} : { signal }), timeoutMs })
    // A TIMEOUT IS NOT AN ANSWER, so it stays fatal here. Mapping every
    // non-zero outcome to undefined would conflate "no such ref" with "the
    // repository is unreachable" and with "git never finished asking",
    // quietly downgrading a stalled repository into a clean-looking sweep.
    const unsettled = unsettledReason(result, timeoutMs)
    if (unsettled !== undefined) throw new Error(`git ${args.join(" ")} ${unsettled} in ${repo}`)
    return result.code === 0 ? result.stdout.trim() : undefined
  }

  return Object.freeze({ run, mutateConfig, commit, text, optionalText })
}

async function localConfig(git: Git, repo: string, key: string): Promise<string | undefined> {
  const configured = await git.run(repo, ["config", "--local", "--get", key], true)
  if (configured.code === 1) return undefined
  if (configured.code !== 0) throw new Error(configured.stderr.trim() || `could not inspect shared ${key} config`)
  return configured.stdout.trim()
}

async function localBool(git: Git, repo: string, key: string): Promise<boolean | undefined> {
  const configured = await git.run(repo, ["config", "--local", "--get", "--type=bool", key], true)
  if (configured.code === 1) return undefined
  if (configured.code !== 0) throw new Error(configured.stderr.trim() || `could not inspect shared ${key} config`)
  return configured.stdout.trim() === "true"
}

async function removeLegacySharedPushDefault(git: Git, repo: string): Promise<void> {
  const configured = await localConfig(git, repo, "remote.pushDefault")
  if (configured !== "bay") return
  const removed = await git.mutateConfig(repo, ["config", "--local", "--unset-all", "remote.pushDefault"])
  if (removed.code === 0) return
  if ((await localConfig(git, repo, "remote.pushDefault")) !== "bay") return
  throw new Error(
    removed.stderr.trim() ||
      "could not remove legacy shared remote.pushDefault=bay; run 'git config --local --unset-all remote.pushDefault'",
  )
}

async function relocateSharedWorktree(git: Git, repo: string, worktree: string): Promise<void> {
  if (worktree === "") throw new Error("Git core.worktree is empty")
  const moved = await git.mutateConfig(repo, ["config", "--worktree", "core.worktree", worktree])
  if (moved.code !== 0) throw new Error(moved.stderr || "could not set primary worktree config")
  const removed = await git.mutateConfig(repo, ["config", "--local", "--unset-all", "core.worktree"])
  if (removed.code === 0) return
  if ((await localConfig(git, repo, "core.worktree")) !== undefined) {
    throw new Error(removed.stderr || "could not remove shared core.worktree config")
  }
}

async function relocateSharedBare(git: Git, repo: string): Promise<void> {
  // With extensions.worktreeConfig enabled, a shared core.bare=true poisons every linked worktree.
  // Scope the known non-bare primary worktree explicitly, then remove the inherited shared value.
  if ((await localBool(git, repo, "core.bare")) !== true) return
  const scoped = await git.mutateConfig(repo, ["config", "--worktree", "core.bare", "false"])
  if (scoped.code !== 0) throw new Error(scoped.stderr || "could not scope core.bare to the main worktree")
  const removed = await git.mutateConfig(repo, ["config", "--local", "--unset-all", "core.bare"])
  if (removed.code === 0) return
  if ((await localBool(git, repo, "core.bare")) !== undefined) {
    throw new Error(removed.stderr || "could not remove shared core.bare config")
  }
}

async function prepareWorktreeConfig(git: Git, repo: string, required: boolean): Promise<void> {
  const worktree = await localConfig(git, repo, "core.worktree")
  if (worktree === undefined && !required) return
  const enabled = await git.mutateConfig(repo, ["config", "extensions.worktreeConfig", "true"])
  if (enabled.code !== 0) throw new Error(enabled.stderr || "could not enable worktree config")
  await relocateSharedBare(git, repo)
  if (worktree !== undefined) await relocateSharedWorktree(git, repo, worktree)
}

async function healPoisonedWorktreeConfig(git: Git, repo: string): Promise<void> {
  if ((await localBool(git, repo, "extensions.worktreeConfig")) !== true) return
  await relocateSharedBare(git, repo)
}

async function ignoreInRepositoryRoot(git: Git, repo: string, root: string): Promise<void> {
  const local = relative(repo, root)
  if (local === "" || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) return
  const normalized = local.split(sep).join("/")
  if (/\r|\n/u.test(normalized)) throw new Error("configured worktree root contains a newline")
  const ignored = await git.run(repo, ["check-ignore", "--quiet", "--no-index", "--", normalized], true)
  if (ignored.code === 0) return
  if (ignored.code !== 1) throw new Error(ignored.stderr || `git check-ignore exited ${ignored.code}`)
  const exclude = (
    await git.run(repo, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"])
  ).stdout.trim()
  if (exclude === "") throw new Error("git rev-parse returned an empty exclude path")
  const escaped = normalized.replace(/([\\[\]*?!#])/gu, "\\$1")
  await appendFile(exclude, `\n/${escaped}/\n`, { encoding: "utf8", mode: 0o600 })
}

export function createGitWorktreeStore(options: GitWorktreeStoreOptions) {
  const repo = resolve(options.repo)
  const timeouts: GitWorktreeTimeouts = {
    operation: options.timeouts?.operation ?? GIT_TIMEOUT_MS,
    cleanup: options.timeouts?.cleanup ?? GIT_CLEANUP_TIMEOUT_MS,
    mutationLock: options.timeouts?.mutationLock ?? GIT_TIMEOUT_MS,
  }
  // Still checked at run time: TypeScript cannot speak for a JavaScript caller,
  // and a missing capability must fail here rather than as a null dereference
  // several frames deeper.
  if (options.gitProcess === undefined) {
    throw new Error("git-super: Git worktree capability requires one injected GitProcess")
  }
  const git = createGit(options.gitProcess, options.env ?? process.env, timeouts.operation, options.signal)
  let mutations: Promise<ReturnType<typeof createExclusive>> | undefined
  const mutationLock = (): Promise<ReturnType<typeof createExclusive>> => {
    mutations ??= (async () => {
      const commonDir = (await git.run(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim()
      if (commonDir === "") throw new Error("git rev-parse returned an empty common directory")
      const lock = createExclusive(join(commonDir, "yrd-worktree-mutations"), {
        timeoutMs: timeouts.mutationLock,
      })
      await lock.run(() => healPoisonedWorktreeConfig(git, repo), { holder: "worktree configuration repair" })
      return lock
    })()
    return mutations
  }
  const mutate = async <Result>(holder: string, operation: () => Promise<Result>): Promise<Result> =>
    (await mutationLock()).run(operation, { holder })

  return Object.freeze({
    repo,
    git,
    async ready(): Promise<void> {
      await mutationLock()
    },
    async removeLegacySharedPushDefault(): Promise<void> {
      if ((await localConfig(git, repo, "remote.pushDefault")) !== "bay") return
      await mutate("Bay legacy push configuration cleanup", () => removeLegacySharedPushDefault(git, repo))
    },
    async prepareRoot(root: string, required = false): Promise<void> {
      await mutate(`prepare worktree root ${resolve(root)}`, async () => {
        await git.run(repo, ["rev-parse", "--show-toplevel"])
        await ignoreInRepositoryRoot(git, repo, resolve(root))
        await prepareWorktreeConfig(git, repo, required)
      })
    },
    async add(input: WorktreeAdd): Promise<void> {
      await mutate(input.operation ?? `worktree add ${input.path}`, async () => {
        if (existsSync(input.path)) {
          throw new Error(`workspace path '${input.path}' already exists; inspect or remove it explicitly`)
        }
        const addArgs =
          input.kind === "branch"
            ? ["worktree", "add", input.path, input.branch]
            : input.kind === "new-branch"
              ? ["worktree", "add", "-b", input.branch, input.path, input.ref]
              : input.kind === "reset-branch"
                ? ["worktree", "add", "-B", input.branch, input.path, input.ref]
                : input.kind === "detached"
                  ? ["worktree", "add", "--detach", input.path, input.ref]
                  : ["worktree", "add", input.path, input.ref]
        const insertion = addArgs.indexOf("add") + 1
        addArgs.splice(
          insertion,
          0,
          ...(input.lockReason === undefined ? [] : ["--lock", "--reason", input.lockReason]),
        )
        await git.run(repo, withHookPolicy(addArgs, input.hooks))
      })
    },
    async materializeSubmodules(
      path: string,
      materializeOptions: Readonly<{ force?: boolean; hooks?: WorktreeHookPolicy }> = {},
    ): Promise<void> {
      const materializeProcess: GitProcess = {
        async run(request) {
          const result = await git.run(
            request.repo,
            withHookPolicy(request.args, materializeOptions.hooks),
            true,
            request.timeoutMs,
          )
          return { code: result.code, stdout: result.stdout, stderr: result.stderr }
        },
      }
      const result = await materializeSubmodulesWithProcess(materializeProcess, {
        worktree: path,
        referenceWorktree: repo,
        ...(materializeOptions.force === true ? { force: true } : {}),
      })
      if (result.code !== 0) {
        throw new Error(result.stderr || result.stdout || "could not materialize worktree submodules")
      }
    },
    async lock(path: string, reason: string): Promise<void> {
      await mutate(`worktree lock ${path}`, () => git.run(repo, ["worktree", "lock", "--reason", reason, path]))
    },
    async unlock(path: string): Promise<void> {
      await mutate(`worktree unlock ${path}`, () => unlockWorktree(git, repo, path))
    },
    async remove(path: string, removeOptions: Readonly<{ operation?: string; unlock?: boolean }> = {}): Promise<void> {
      await mutate(removeOptions.operation ?? `worktree remove ${path}`, async () => {
        if (removeOptions.unlock === true) await unlockWorktree(git, repo, path)
        await git.run(repo, ["worktree", "remove", "--force", path], false, timeouts.cleanup)
        if (existsSync(path) || (await inspectWorktree(git, repo, path)).registered) {
          throw new Error(`git reported success but did not fully remove worktree '${path}'`)
        }
      })
    },
    async prune(
      pruneOptions: Readonly<{ expire?: string; verbose?: boolean; operation?: string }> = {},
    ): Promise<void> {
      await mutate(pruneOptions.operation ?? "worktree prune", () =>
        git.run(repo, [
          "worktree",
          "prune",
          ...(pruneOptions.expire === undefined ? [] : ["--expire", pruneOptions.expire]),
          ...(pruneOptions.verbose === true ? ["--verbose"] : []),
        ]),
      )
    },
    async inspect(path: string): Promise<WorktreeInspection> {
      return inspectWorktree(git, repo, path)
    },
    async recoverDestroyed(path: string, operation = `recover destroyed worktree ${path}`): Promise<void> {
      await mutate(operation, async () => {
        if (existsSync(join(path, ".git"))) {
          throw new Error(`yrd: refusing destroyed-worktree recovery while '${path}/.git' still exists`)
        }
        if (!(await inspectWorktree(git, repo, path)).registered) return
        await git.run(repo, ["worktree", "prune", "--expire=now"])
        if ((await inspectWorktree(git, repo, path)).registered) {
          throw new Error(`yrd: destroyed worktree '${path}' survived explicit recovery`)
        }
      })
    },
  })
}

async function inspectWorktree(git: Git, repo: string, path: string): Promise<WorktreeInspection> {
  const listed = await git.run(repo, ["worktree", "list", "--porcelain", "-z"])
  const target = resolve(path)
  for (const record of listed.stdout.split("\0\0")) {
    const fields = record.split("\0").filter((field) => field !== "")
    const worktree = fields.find((field) => field.startsWith("worktree "))
    if (worktree === undefined || resolve(worktree.slice("worktree ".length)) !== target) continue
    const head = fields.find((field) => field.startsWith("HEAD "))?.slice("HEAD ".length)
    const locked = fields.find((field) => field === "locked" || field.startsWith("locked "))
    return {
      registered: true,
      ...(head === undefined ? {} : { head }),
      detached: fields.includes("detached"),
      ...(locked === undefined ? {} : { locked: locked === "locked" ? "" : locked.slice("locked ".length) }),
    }
  }
  return { registered: false }
}

export type GitWorktreeStore = Awaited<ReturnType<typeof createGitWorktreeStore>>

async function unlockWorktree(git: Git, repo: string, path: string): Promise<void> {
  const result = await git.run(repo, ["worktree", "unlock", path], true)
  if (result.code !== 0 && !/not locked/iu.test(result.stderr)) {
    throw new Error(result.stderr.trim() || `could not unlock worktree '${path}'`)
  }
}

function withHookPolicy(args: readonly string[], policy: WorktreeHookPolicy | undefined): string[] {
  return policy === "quarantine" ? ["-c", "core.hooksPath=/dev/null", ...args] : [...args]
}
