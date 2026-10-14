import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"
import { appendFile, lstat, readFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { createExclusive, DEFAULT_MUTATION_LOCK_WAIT_MS } from "./exclusive.ts"
import { ARCHIVE_REF_PREFIX } from "./archive-ref.ts"
import {
  acquireRemovalWriterLeases,
  assertExcludedRemovalCustody,
  inspectRemovalStatus,
  prepareRemovalBorrowers,
  rehomeBorrowers,
  retainWorktreeModules,
  type WorktreeRemovalProof,
  type WorktreeRetention,
} from "./worktree-removal.ts"
export { inspectRemovalStatus } from "./worktree-removal.ts"
import { compactRetainedModules, type CompactionResult } from "./retention-compact.ts"
import { cleanGitEnvironment, probeRepository } from "./git.ts"
import { createLocalGitProcess, type GitProcess, type GitProcessResult } from "./process.ts"
import { createProgressReporter } from "./progress.ts"
import { materializeSubmodulesWithProcess } from "./submodules.ts"
import { superStatus, type SuperStatusResult } from "./status.ts"
import { removalBorrowers } from "./worktree-administration.ts"

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
  /** Reports writer-lock contention without writing to stderr from the library. */
  report?: (line: string) => void
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

export type RegisteredWorktree = Readonly<{
  path: string
  head?: string
  /** Full local ref when this worktree has a branch checked out. */
  branch?: string
  detached: boolean
  locked?: string
}>

/** A rebase or bisect owns a branch even when Git's worktree porcelain says detached.
 * Shared with branch-triage; the operation's own state is the authority.
 */
export function worktreeOperationBranch(worktreePath: string): Readonly<{ branch: string; operation: string }> | null {
  const dotGit = join(worktreePath, ".git")
  if (!existsSync(dotGit)) return null
  let gitDir = dotGit
  if (!statSync(dotGit).isDirectory()) {
    const declaration = /^gitdir:\s*(.+)$/mu.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim()
    if (declaration === undefined || declaration === "") {
      throw new Error(`cannot read worktree operation at ${worktreePath}: ${dotGit} has no gitdir declaration`)
    }
    gitDir = isAbsolute(declaration) ? declaration : resolve(worktreePath, declaration)
  }
  for (const source of [
    { file: "rebase-merge/head-name", operation: "rebase-merge" },
    { file: "rebase-apply/head-name", operation: "rebase-apply" },
    { file: "BISECT_START", operation: "bisect" },
  ]) {
    const path = join(gitDir, source.file)
    if (!existsSync(path)) continue
    const branch = readFileSync(path, "utf8")
      .trim()
      .replace(/^refs\/heads\//u, "")
    if (branch === "") throw new Error(`cannot identify the branch held by ${source.operation}: ${path} is empty`)
    return { branch, operation: source.operation }
  }
  return null
}

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
    options?: Readonly<{ env?: NodeJS.ProcessEnv; stdin?: string }>,
  ): Promise<GitResult> => {
    const result = await process.run({
      repo,
      args,
      env: options?.env === undefined ? env : { ...env, ...options.env },
      ...(signal === undefined ? {} : { signal }),
      ...(options?.stdin === undefined ? {} : { stdin: options.stdin }),
      timeoutMs,
    })
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
      await delay(attempt * 5)
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
  if (!(await poisonedWorktreeConfigNeedsHealing(git, repo))) return
  await relocateSharedBare(git, repo)
}

async function poisonedWorktreeConfigNeedsHealing(git: Git, repo: string): Promise<boolean> {
  if ((await localBool(git, repo, "extensions.worktreeConfig")) !== true) return false
  return (await localBool(git, repo, "core.bare")) === true
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
    mutationLock: options.timeouts?.mutationLock ?? DEFAULT_MUTATION_LOCK_WAIT_MS,
  }
  // Still checked at run time: TypeScript cannot speak for a JavaScript caller,
  // and a missing capability must fail here rather than as a null dereference
  // several frames deeper.
  if (options.gitProcess === undefined) {
    throw new Error("git-super: Git worktree capability requires one injected GitProcess")
  }
  const git = createGit(options.gitProcess, options.env ?? process.env, timeouts.operation, options.signal)
  const configuredProcess = (hooks?: WorktreeHookPolicy): GitProcess => ({
    async run(request) {
      const result = await git.run(request.repo, withHookPolicy(request.args, hooks), true, request.timeoutMs, {
        ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
        ...(request.env === undefined ? {} : { env: request.env }),
      })
      return { code: result.code, stdout: result.stdout, stderr: result.stderr }
    },
  })
  const assertRemovalRoot = async (path: string) => {
    const discovered = await git.text(path, ["rev-parse", "--show-toplevel"])
    const prefix = await git.text(path, ["rev-parse", "--show-prefix"])
    const identity = probeRepository(discovered, prefix)
    if (identity.kind === "absent") {
      throw new Error(
        `${path} is not a worktree root; its git dir resolves to the parent repository ${identity.discovered}`,
      )
    }
  }
  const prepareRemoval = async (path: string, excludedSubmodules?: readonly string[]) => {
    await assertRemovalRoot(path)
    const gitDir = realpathSync(await git.text(path, ["rev-parse", "--absolute-git-dir"]))
    const common = realpathSync(await git.text(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))
    const custody = await assertExcludedRemovalCustody(
      git,
      configuredProcess(),
      path,
      gitDir,
      common,
      excludedSubmodules,
    )
    if (custody.notCompared.some((entry) => entry.reason !== "excluded")) {
      return { gitDir, rehome: undefined, notCompared: custody.notCompared }
    }
    const rehome = await prepareRemovalBorrowers(git, path, common, gitDir, custody, excludedSubmodules)
    return {
      gitDir,
      rehome,
      notCompared: [...custody.notCompared, ...rehome.notCompared],
    }
  }
  // Reuse removal's consulted population: native children can belong to independent
  // stores even though their checkouts die with the root directory.
  const captureLinkedChildren = async (path: string, rootGitDir: string, excluded: readonly string[]) => {
    const within = (parent: string, child: string) => {
      const local = relative(parent, child)
      return local === "" || (local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local))
    }
    const children: Array<{
      path: string
      common: string
      admin: string
      pointer: string
      primary: string
      branch?: string
      tip?: string
    }> = []
    for (const entry of superStatus({ repo: path, excludedSubmodules: excluded }).consultedRepositories) {
      if (entry.path === ".") continue
      const child = realpathSync(entry.root)
      if (!within(path, child) || child === path) continue
      const admin = realpathSync(await git.text(child, ["rev-parse", "--absolute-git-dir"]))
      const common = realpathSync(await git.text(child, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))
      if (admin === common || within(path, common) || within(rootGitDir, common)) continue
      const rows = await listWorktrees(git, common)
      const registered = rows.find((row) => row.path === child)
      const primaryRow = rows[0]
      if (registered === undefined || primaryRow === undefined) {
        throw new Error(`linked child ${child} has no exact native registration in ${common}`)
      }
      const primary = realpathSync(await git.text(primaryRow.path, ["rev-parse", "--show-toplevel"]))
      if (within(path, primary) || within(rootGitDir, primary)) continue
      if (realpathSync(await git.text(primary, ["rev-parse", "--absolute-git-dir"])) !== common) {
        throw new Error(`linked child ${child} has no independent primary for ${common}`)
      }
      const pointer = resolve(admin, (await readFile(join(admin, "gitdir"), "utf8")).trim())
      if (pointer !== join(child, ".git")) {
        throw new Error(`linked child ${child} has mismatched administration backpointer ${pointer}`)
      }
      children.push({ path: child, common, admin, pointer, primary, branch: registered.branch, tip: registered.head })
    }
    return children.sort((a, b) => b.path.length - a.path.length)
  }
  const runWithMutationLock = async <Result>(
    dir: string,
    holder: string,
    operation: () => Promise<Result>,
  ): Promise<Result> => {
    const progress = createProgressReporter(
      options.report,
      (owner) => `git-super worktree: waiting for writer lock held by ${owner}\n`,
    )
    try {
      return await createExclusive(dir, {
        timeoutMs: timeouts.mutationLock,
        onContended: progress.phase,
      }).run(
        () => {
          progress.cancel()
          return operation()
        },
        { holder },
      )
    } finally {
      progress.cancel()
    }
  }
  let mutations: Promise<string> | undefined
  const mutationLock = (): Promise<string> => {
    mutations ??= (async () => {
      const needsConfigHealing = await poisonedWorktreeConfigNeedsHealing(git, repo)
      const commonDir = (await git.run(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim()
      if (commonDir === "") throw new Error("git rev-parse returned an empty common directory")
      const dir = join(commonDir, "yrd-worktree-mutations")
      if (needsConfigHealing) {
        await runWithMutationLock(dir, "worktree configuration repair", () => healPoisonedWorktreeConfig(git, repo))
      }
      return dir
    })()
    return mutations
  }
  const mutate = async <Result>(holder: string, operation: () => Promise<Result>): Promise<Result> =>
    runWithMutationLock(await mutationLock(), holder, operation)

  /**
   * Why a worktree still holds this branch NAME, or undefined when none does.
   * One predicate for both the retirement write and its dry run (28989): a dry
   * run that disagreed with the write would be worse than no dry run at all.
   */
  const branchHolder = async (branch: string): Promise<string | undefined> => {
    const ref = `refs/heads/${branch}`
    for (const row of await listWorktrees(git, repo)) {
      const operation = row.branch === undefined ? worktreeOperationBranch(row.path) : null
      if (row.branch === ref || operation?.branch === branch) {
        return `branch ${branch} is ${
          operation === null ? "checked out" : `held by ${operation.operation}`
        } at ${row.path}; keep it until the worktree releases it`
      }
    }
    return undefined
  }

  return Object.freeze({
    repo,
    git,
    branchHolder,
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
      materializeOptions: Readonly<{
        force?: boolean
        hooks?: WorktreeHookPolicy
        /** Literal root-relative paths left empty and uninitialized: no init, store or gitfile. */
        excludedSubmodules?: readonly string[]
      }> = {},
    ): Promise<void> {
      const materializeProcess = configuredProcess(materializeOptions.hooks)
      const result = await materializeSubmodulesWithProcess(materializeProcess, {
        worktree: path,
        referenceWorktree: repo,
        ...(materializeOptions.force === true ? { force: true } : {}),
        ...(materializeOptions.excludedSubmodules === undefined
          ? {}
          : { excludedSubmodules: materializeOptions.excludedSubmodules }),
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
    async remove(
      path: string,
      removeOptions: Readonly<{
        operation?: string
        unlock?: boolean
        retention?: WorktreeRetention
        excludedSubmodules?: readonly string[]
        noRehome?: boolean
        preserved?: readonly string[]
      }> = {},
    ): Promise<void | Readonly<{ borrowers: readonly string[] }> | Readonly<{ compaction: CompactionResult }>> {
      await assertRemovalRoot(path)
      // The selected checkout can be the removal target. Its registry outlives it.
      const removalRepo = await git.text(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
      let stagingPath: string | undefined
      let borrowed: Readonly<{ borrowers: readonly string[] }> | undefined
      let removalProof: WorktreeRemovalProof | undefined
      let compaction: CompactionResult | undefined
      let children: Awaited<ReturnType<typeof captureLinkedChildren>> = []
      await mutate(removeOptions.operation ?? `worktree remove ${path}`, async () => {
        if (removeOptions.retention !== undefined && removeOptions.unlock === true) {
          throw new Error(`retained worktree removal cannot unlock ${path}; resolve its holder first`)
        }
        const { gitDir, rehome, notCompared } = await prepareRemoval(path, removeOptions.excludedSubmodules)
        if (notCompared.some((entry) => entry.reason !== "excluded")) {
          throw Object.assign(
            new Error(
              `worktree removal refused: ${notCompared
                .filter((entry) => entry.reason !== "excluded")
                .map((entry) => entry.message)
                .join("; ")}`,
            ),
            { notCompared },
          )
        }
        if (rehome === undefined) throw new Error(`worktree ${path} has no prepared borrower custody`)
        const writerLeases = acquireRemovalWriterLeases(gitDir)
        const resolvedPath = resolve(path)
        try {
          if (removeOptions.noRehome === true) {
            const borrowers = rehome.inspect()
            if (borrowers.length > 0) {
              borrowed = { borrowers }
              return
            }
          }
          if (removeOptions.retention !== undefined) {
            removalProof = await retainWorktreeModules(
              git,
              repo,
              path,
              removeOptions.retention,
              (repository, target) => inspectWorktree(git, repository, target),
              writerLeases.proof,
              writerLeases.created,
              removeOptions.noRehome === true ? () => [] : rehome.run,
              removeOptions.excludedSubmodules,
              notCompared,
              undefined,
              undefined,
              undefined,
              removeOptions.preserved,
            )
          } else {
            if (removeOptions.unlock === true) await unlockWorktree(git, repo, path)
            if (removeOptions.noRehome !== true) rehome.run()
          }
          children = await captureLinkedChildren(resolvedPath, gitDir, removeOptions.excludedSubmodules ?? [])

          // Target-only two-phase removal (#27551, CTO ruling beadc3d2):
          // Phase 1 (under mutation lock):
          // Rename the worktree directory to <parent>/.trash/<uuid> on the same filesystem.
          // Leave a stub at the original path holding only its .git gitlink file.
          // Run existing `git worktree remove --force <path>` + verification.
          // On EXDEV, fall back to today's in-lock removal with a warning.
          const parentDir = dirname(resolvedPath)
          const trashDir = join(parentDir, ".trash")
          const targetStaging = join(trashDir, randomUUID())
          const gitlinkPath = join(resolvedPath, ".git")

          if (existsSync(gitlinkPath)) {
            try {
              mkdirSync(trashDir, { recursive: true })
              renameSync(resolvedPath, targetStaging)
              // Ownership changes at rename, even if creating the Git stub fails.
              stagingPath = targetStaging
              mkdirSync(resolvedPath, { recursive: true })
              copyFileSync(join(targetStaging, ".git"), gitlinkPath)
            } catch (stageError) {
              if (
                stagingPath === undefined &&
                stageError !== null &&
                typeof stageError === "object" &&
                "code" in stageError &&
                stageError.code === "EXDEV"
              ) {
                console.warn(
                  `git-super: worktree removal staging rename across devices failed (EXDEV); falling back to in-lock removal for '${path}'`,
                )
              } else {
                throw stageError
              }
            }
          }

          await git.run(removalRepo, ["worktree", "remove", "--force", path], false, timeouts.cleanup)
          if (existsSync(path) || (await inspectWorktree(git, removalRepo, path)).registered) {
            throw new Error(`git reported success but did not fully remove worktree '${path}'`)
          }
        } catch (error) {
          if (stagingPath !== undefined && existsSync(stagingPath)) {
            let retainedStaging = stagingPath
            try {
              if (existsSync(resolvedPath)) {
                // Only remove our Git stub. Unexpected contents block restoration
                // rather than being recursively deleted with the original error.
                rmSync(join(resolvedPath, ".git"), { force: true })
                rmdirSync(resolvedPath)
              }
              renameSync(stagingPath, resolvedPath)
              stagingPath = undefined
            } catch (restoreError) {
              // The staging directory survives as the recovery record. Mark it so the clean-root
              // sweep preserves it even after the admin entry is pruned: the sweep keys on this
              // marker (#28800), and an unmarked directory is reclaimed as ordinary leftover trash
              // once quiescent and holder-free (#28906).
              let markerNote = ""
              try {
                writeFileSync(join(retainedStaging, ".restore-failed"), `restore-failed\ntarget ${resolvedPath}\n`)
              } catch (markerError) {
                const detail = markerError instanceof Error ? markerError.message : String(markerError)
                // The in-directory marker failed, so fall back to the sweep's other recogniser --
                // the '.restore-failed' name suffix -- and keep the retained record recoverable
                // instead of letting it be reclaimed as leftover trash (#28906 REVISE).
                const suffixedStaging = `${retainedStaging}.restore-failed`
                try {
                  renameSync(retainedStaging, suffixedStaging)
                  retainedStaging = suffixedStaging
                  markerNote = `; the in-directory marker could not be written (${detail}), so the retained record is marked by its '.restore-failed' name suffix`
                } catch (fallbackError) {
                  const fallbackDetail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
                  markerNote = `; the recovery record is UNMARKED, so the clean-root sweep will reclaim it as leftover (marker write failed: ${detail}; '.restore-failed' name-suffix fallback failed: ${fallbackDetail})`
                  console.warn(
                    `git-super: failed to mark retained restore-failed record in '${retainedStaging}': ${detail}; name-suffix fallback failed: ${fallbackDetail}`,
                  )
                }
              }
              throw writerLeases.refusal(
                new Error(
                  `worktree removal failed: ${error instanceof Error ? error.message : String(error)}; restoration to '${resolvedPath}' failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}; contents retained at '${retainedStaging}'${markerNote}`,
                  { cause: new AggregateError([error, restoreError], "worktree removal and restoration failed") },
                ),
              )
            }
          }
          throw writerLeases.refusal(error)
        } finally {
          writerLeases.release()
        }
      })

      try {
        // After native --force: pack-refs + drop remote reflogs on the retained copy, then rewrite
        // the proof so gate 2 still matches. Compaction must not throw: --force already succeeded,
        // so a throw would record a failed close for a worktree that is gone (R2). On failure every
        // ref value stays intact, the proof is not rewritten (later retention verify refuses), and
        // the copy is never deleted.
        if (removalProof?.retained != null) {
          compaction = compactRetainedModules(removalProof, {
            common: removalRepo,
            preState: { kind: "in-run" },
          })
        }
      } finally {
        // Phase 2 (outside mutation lock):
        // Delete the staging directory synchronously in the caller. Never fire-and-forget.
        if (stagingPath !== undefined) {
          try {
            rmSync(stagingPath, { recursive: true, force: true })
            try {
              rmdirSync(dirname(stagingPath))
            } catch (error) {
              // Other removals may still own entries in the shared staging directory.
              if (
                error === null ||
                typeof error !== "object" ||
                !("code" in error) ||
                (error.code !== "ENOTEMPTY" && error.code !== "EEXIST")
              ) {
                console.warn(
                  `git-super: failed to remove staging parent '${dirname(stagingPath)}': ${error instanceof Error ? error.message : String(error)}`,
                )
              }
            }
          } catch (error) {
            console.warn(
              `git-super: failed to delete staged worktree directory '${stagingPath}': ${error instanceof Error ? error.message : String(error)}`,
            )
          }
        }
      }
      if (borrowed !== undefined) return borrowed
      const failures: Error[] = []
      for (const child of children) {
        try {
          // Any new contents belong to the next owner, even if the old pointer was reused.
          await lstat(child.path).then(
            () => {
              throw new Error("checkout path survives or was rebound; left untouched")
            },
            (error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error
            },
          )
          if (
            realpathSync(child.common) !== child.common ||
            realpathSync(await git.text(child.primary, ["rev-parse", "--absolute-git-dir"])) !== child.common
          ) {
            throw new Error("independent primary store changed since capture")
          }
          const current = (await listWorktrees(git, child.common)).find((row) => row.path === child.path)
          if (current === undefined) continue
          if (
            current.branch !== child.branch ||
            current.head !== child.tip ||
            resolve(child.admin, (await readFile(join(child.admin, "gitdir"), "utf8")).trim()) !== child.pointer
          ) {
            throw new Error("native registration or administration identity changed since capture")
          }
          await createGitWorktreeStore({ ...options, repo: child.primary }).recoverDestroyed(child.path)
        } catch (cause) {
          let state: string
          try {
            state = (await listWorktrees(git, child.common)).some((row) => row.path === child.path)
              ? "registration kept"
              : "registration removed; cleanup incomplete"
          } catch (inspectionError) {
            state = `registration state unreadable: ${String(inspectionError)}`
          }
          failures.push(
            new Error(
              `root removed; child ${child.path} ${state}: ${String(cause)}; inspect ${child.common} and retry createGitWorktreeStore({ repo: ${JSON.stringify(child.primary)}, gitProcess }).recoverDestroyed(${JSON.stringify(child.path)})`,
              { cause },
            ),
          )
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, failures.map((error) => error.message).join("; "))
      if (compaction !== undefined) return { compaction }
      return undefined
    },
    async prune(
      pruneOptions: Readonly<{
        expire?: string
        verbose?: boolean
        operation?: string
      }> = {},
    ): Promise<void> {
      await mutate(pruneOptions.operation ?? "worktree prune", async () => {
        return git.run(repo, [
          "worktree",
          "prune",
          ...(pruneOptions.expire === undefined ? [] : ["--expire", pruneOptions.expire]),
          ...(pruneOptions.verbose === true ? ["--verbose"] : []),
        ])
      })
    },
    async inspect(path: string): Promise<WorktreeInspection> {
      return inspectWorktree(git, repo, path)
    },
    /** This read-only inventory is a snapshot, not permission: removal rechecks under its mutation lock. */
    async list(): Promise<readonly RegisteredWorktree[]> {
      return listWorktrees(git, repo)
    },
    /**
     * Remove a local name only while its exact commit remains archived. The existing worktree writer lock
     * excludes a concurrent store.add; the ref transaction also refuses a moved branch or archive.
     * Callers own eligibility, attribution and journal policy. This never removes a worktree or remote ref.
     */
    async removeArchivedBranch(input: Readonly<{ branch: string; tip: string; archiveRef: string }>): Promise<void> {
      await mutate(`retire branch ${input.branch}`, async () => {
        const { branch, tip, archiveRef } = input
        if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(tip)) {
          throw new Error(`branch ${branch}: expected a full SHA1 or SHA256 tip, got ${JSON.stringify(tip)}`)
        }
        await git.run(repo, ["check-ref-format", "--branch", branch])
        await git.run(repo, ["check-ref-format", archiveRef])
        if (!archiveRef.startsWith(`${ARCHIVE_REF_PREFIX}/`)) {
          throw new Error(`branch ${branch}: custody ref ${archiveRef} is outside ${ARCHIVE_REF_PREFIX}/`)
        }
        const ref = `refs/heads/${branch}`
        const held = await branchHolder(branch)
        if (held !== undefined) throw new Error(held)
        await git.run(
          repo,
          ["-c", "core.fsync=loose-object,reference", "-c", "core.fsyncMethod=fsync", "update-ref", "--stdin"],
          false,
          timeouts.operation,
          { stdin: `start\nverify ${archiveRef} ${tip}\ndelete ${ref} ${tip}\nprepare\ncommit\n` },
        )
      })
    },
    /**
     * This read-only inspection is a snapshot, not permission: remove rechecks admission under its mutation lock.
     * A removal refused by a non-excluded `notCompared` entry carries that refusal and inspects no `borrowers`.
     */
    async inspectRemoval(
      path: string,
      inspectOptions: Readonly<{ excludedSubmodules?: readonly string[] }> = {},
    ): Promise<
      Pick<SuperStatusResult, "records" | "notCompared" | "consultedRepositories" | "uninitializedSubmodules"> &
        Readonly<{ borrowers: readonly string[] }>
    > {
      const prepared = await prepareRemoval(path, inspectOptions.excludedSubmodules)
      const status = inspectRemovalStatus(path, inspectOptions.excludedSubmodules)
      // 27811: prepareRemoval prepares no borrower custody exactly when a non-excluded entry already refuses removal,
      // and remove() reports that refusal before it needs custody. Inspection returns the same refusal, so its caller
      // sees what removal would say; a refused removal inspects no borrowers, so the list is empty beside that refusal.
      // Missing custody without such a refusal is an impossible state and stays loud.
      const refused = prepared.notCompared.some((entry) => entry.reason !== "excluded")
      if (prepared.rehome === undefined && !refused) {
        throw new Error(`worktree ${path} has no prepared borrower custody`)
      }
      return {
        borrowers: prepared.rehome === undefined ? [] : prepared.rehome.inspect(),
        records: status.records,
        notCompared: [...prepared.notCompared, ...status.notCompared],
        consultedRepositories: status.consultedRepositories,
        uninitializedSubmodules: status.uninitializedSubmodules,
      }
    },
    async recoverDestroyed(path: string, operation = `recover destroyed worktree ${path}`): Promise<void> {
      await mutate(operation, async () => {
        try {
          await lstat(join(path, ".git"))
          throw new Error(`yrd: refusing destroyed-worktree recovery while '${path}/.git' still exists`)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
        if (!(await inspectWorktree(git, repo, path)).registered) return
        const common = realpathSync(await git.text(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))
        let directory: string | undefined
        const unreadable: string[] = []
        for (const candidate of removalBorrowers(common, common)) {
          const pointerPath = join(candidate.adminDir, "gitdir")
          let pointer: string
          try {
            pointer = (await readFile(pointerPath, "utf8")).trim()
          } catch (error) {
            unreadable.push(`${pointerPath}: ${String(error)}`)
            continue
          }
          if (resolve(dirname(pointer)) === resolve(path)) {
            directory = candidate.adminDir
            break
          }
        }
        if (directory === undefined) {
          throw new Error(
            `registered destroyed worktree '${path}' has no administration identity${unreadable.length === 0 ? "" : `; unreadable administration pointers: ${unreadable.join("; ")}`}`,
          )
        }
        const writerLeases = acquireRemovalWriterLeases(directory)
        try {
          rehomeBorrowers(common, directory, join(directory, "modules"))
          await git.run(repo, ["worktree", "remove", "--force", path], false, timeouts.cleanup)
          if ((await inspectWorktree(git, repo, path)).registered) {
            throw new Error(`yrd: destroyed worktree '${path}' survived explicit recovery`)
          }
        } catch (error) {
          throw writerLeases.refusal(error)
        } finally {
          writerLeases.release()
        }
      })
    },
  })
}

async function inspectWorktree(git: Git, repo: string, path: string): Promise<WorktreeInspection> {
  const row = (await listWorktrees(git, repo)).find((entry) => entry.path === resolve(path))
  if (row === undefined) return { registered: false }
  const { path: _path, branch: _branch, ...fields } = row
  return { registered: true, ...fields }
}

async function listWorktrees(git: Git, repo: string): Promise<RegisteredWorktree[]> {
  const listed = await git.run(repo, ["worktree", "list", "--porcelain", "-z"])
  const rows: RegisteredWorktree[] = []
  for (const record of listed.stdout.split("\0\0")) {
    if (record === "") continue
    const fields = record.split("\0").filter((field) => field !== "")
    const worktree = fields.find((field) => field.startsWith("worktree "))
    if (worktree === undefined || worktree === "worktree ") {
      throw new Error("git worktree list --porcelain -z returned a non-empty record without a worktree path")
    }
    const head = fields.find((field) => field.startsWith("HEAD "))?.slice("HEAD ".length)
    const branch = fields.find((field) => field.startsWith("branch "))?.slice("branch ".length)
    const locked = fields.find((field) => field === "locked" || field.startsWith("locked "))
    rows.push({
      path: resolve(worktree.slice("worktree ".length)),
      ...(head === undefined ? {} : { head }),
      ...(branch === undefined ? {} : { branch }),
      detached: fields.includes("detached"),
      ...(locked === undefined ? {} : { locked: locked === "locked" ? "" : locked.slice("locked ".length) }),
    })
  }
  return rows
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

/**
 * The private-store custody reader belongs to the same public surface as the removal it guards, so a caller
 * that removes a worktree WITHOUT the git-super primitive (a plain `rmSync`, a bare `git worktree prune`, the
 * `yrd env close` refusal, 27058) reaches the ONE implementation rather than writing a second one beside it.
 */
export {
  assertNoPrivateStore,
  PrivateStoreRefusalError,
  type PrivateStoreCustody,
  type PrivateStoreRefusal,
} from "./worktree-removal.ts"
