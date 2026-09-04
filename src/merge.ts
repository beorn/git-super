import { isAbsolute, join, resolve } from "node:path"
import { readCommitSubmodules } from "./commit-graph.ts"
import { createExclusive, type Exclusive } from "./exclusive.ts"
import { createLocalGitProcess, type GitProcess, type GitProcessResult } from "./process.ts"
import type { GitResultDetail, GitSuperRepositoryResult, GitSuperResult } from "./result.ts"

export type SuperMergeGitlinkResult = Readonly<{
  path: string
  from: string
  to: string
  state: "raised" | "left-off-main" | "not-run"
}>

export type SuperMergeResult = GitSuperResult &
  Readonly<{
    commit?: string
    gitlinks: readonly SuperMergeGitlinkResult[]
  }>

export type SuperMergeOptions = Readonly<{
  repo: string
  commit: string
  message?: string
  noVerify?: boolean
  timeoutMs?: number
  git?: GitProcess
  exclusive?: Exclusive
}>

type GitlinkPlan = Readonly<{
  path: string
  from: string
  to: string
  state: "raised" | "left-off-main"
  changedByMerge: boolean
}>

type GitlinkPlans = Readonly<{
  settlements: readonly GitlinkPlan[]
  checkouts: readonly Readonly<{ path: string; to: string }>[]
}>

const DEFAULT_GIT_TIMEOUT_MS = 30_000
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u

export async function superMerge(options: SuperMergeOptions): Promise<SuperMergeResult> {
  const git = options.git ?? createLocalGitProcess()
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS
  const fallbackRoot = resolve(options.repo)
  let root: string
  try {
    root = resolve(await required(git, options.repo, ["rev-parse", "--show-toplevel"], "discover-root", timeoutMs))
  } catch (error) {
    return failed(fallbackRoot, [], resultError(error, "discover-root"))
  }

  try {
    const exclusive = options.exclusive ?? createExclusive(await lockDirectory(git, root, timeoutMs))
    return await exclusive.run(() => mergeUnderLock(git, root, options, timeoutMs), {
      holder: "git super merge",
    })
  } catch (error) {
    return failed(root, [], resultError(error, "merge"))
  }
}

async function mergeUnderLock(
  git: GitProcess,
  root: string,
  options: SuperMergeOptions,
  timeoutMs: number,
): Promise<SuperMergeResult> {
  const status = await required(
    git,
    root,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    "verify-clean",
    timeoutMs,
  )
  if (status !== "") {
    return failed(
      root,
      [],
      obviousDetail(
        "dirty-worktree",
        `The current worktree at ${root} is not clean, so merge ${options.commit} was not started.`,
        `git -C ${root} status --short`,
        "Commit or otherwise preserve the named changes, then rerun the same git super merge command.",
        "the caller",
        { paths: status.split(/\r?\n/u).filter(Boolean) },
      ),
    )
  }

  const head = await required(git, root, ["rev-parse", "HEAD^{commit}"], "resolve-head", timeoutMs)
  let target: string
  try {
    target = await required(git, root, ["rev-parse", `${options.commit}^{commit}`], "resolve-merge-target", timeoutMs)
  } catch (error) {
    return failed(root, [], resultError(error, "resolve-merge-target"))
  }
  const containmentArgs = ["merge-base", "--is-ancestor", target, head]
  const containment = await run(git, root, containmentArgs, timeoutMs)
  if (containment.code === 0) {
    return failed(
      root,
      [],
      obviousDetail(
        "merge-target-already-contained",
        `Merge target ${target} is already contained by current HEAD ${head}, so Git cannot create the required merge commit.`,
        `git -C ${root} merge-base --is-ancestor ${target} ${head}`,
        "Submit a target that is not already contained by the current branch.",
        "the caller",
        { objectIds: [head, target] },
      ),
    )
  }
  if (containment.code !== 1) {
    return failed(
      root,
      [],
      resultDetailFromGit(
        "merge-target-ancestry-unreadable",
        "prove-merge-needed",
        root,
        containmentArgs,
        containment,
        `Containment of merge target ${target} by current HEAD ${head} could not be proved.`,
        `git -C ${root} merge-base --is-ancestor ${target} ${head}`,
        "Repair the object graph, then rerun the same git super merge command.",
        "the caller",
        { objectIds: [head, target] },
      ),
    )
  }
  const prospective = await prospectiveTree(git, root, head, target, timeoutMs)
  if ("failure" in prospective) return failed(root, [], prospective.failure)

  let planned: GitlinkPlans
  try {
    planned = await planGitlinks(git, root, head, prospective.tree, timeoutMs)
  } catch (error) {
    return failed(root, [], resultError(error, "inspect-gitlinks"))
  }
  const plans = planned.settlements
  const refusal = plans.find((plan) => plan.state === "left-off-main" && plan.changedByMerge)
  if (refusal !== undefined) {
    return failed(
      root,
      [],
      obviousDetail(
        "gitlink-off-main",
        `Merge ${target} would change ${refusal.path} to ${refusal.from}, which fetched component main ${refusal.to} does not contain.`,
        `git -C ${join(root, refusal.path)} merge-base --is-ancestor ${refusal.from} ${refusal.to}`,
        `Push ${refusal.from} to ${refusal.path} main, then rerun the same git super merge command.`,
        "the component writer",
        { paths: [refusal.path], objectIds: [refusal.from, refusal.to] },
      ),
    )
  }
  const visiblePlans = plans.map(({ changedByMerge: _changedByMerge, ...plan }) => plan)

  const trailers = visiblePlans.map((plan) =>
    plan.state === "raised"
      ? `Settled: ${plan.path}@${plan.to}`
      : `Settled: ${plan.path}@${plan.from} left-off-main component-main@${plan.to}`,
  )
  const requestedMessage = options.message ?? `Merge ${target.slice(0, 12)} into ${head.slice(0, 12)}`
  let settledMessage = requestedMessage
  if (trailers.length > 0) {
    const trailerArgs = ["interpret-trailers", ...trailers.flatMap((trailer) => ["--trailer", trailer])]
    const trailerResult = await run(git, root, trailerArgs, timeoutMs, requestedMessage)
    if (trailerResult.code !== 0) {
      return failed(
        root,
        [],
        resultDetailFromGit(
          "settlement-message-failed",
          "compose-settlement-report",
          root,
          trailerArgs,
          trailerResult,
          `The Settled report for merge ${target} could not be composed before any commit was written.`,
          `git -C ${root} interpret-trailers`,
          "Repair the merge message or trailer input, then rerun the same git super merge command.",
          "the caller",
        ),
      )
    }
    settledMessage = trailerResult.stdout
  }

  const mergeArgs = ["merge", "--no-ff", "--no-commit", ...(options.noVerify === true ? ["--no-verify"] : []), target]
  const merged = await run(git, root, mergeArgs, timeoutMs)
  if (merged.code !== 0) {
    return mergeApplicationFailure(git, root, head, target, mergeArgs, merged, timeoutMs)
  }
  const completed: SuperMergeGitlinkResult[] = visiblePlans
    .filter((plan) => plan.state === "left-off-main")
    .map((plan) => ({ ...plan }))
  const raises = visiblePlans.filter((plan) => plan.state === "raised")
  for (let index = 0; index < raises.length; index += 1) {
    const raise = raises[index]
    if (raise === undefined) continue
    const args = ["update-index", "--cacheinfo", `160000,${raise.to},${raise.path}`]
    const written = await run(git, root, args, timeoutMs)
    if (written.code !== 0) {
      const notRun = raises.slice(index).map((plan) => ({ ...plan, state: "not-run" as const }))
      return partial(
        root,
        undefined,
        [...completed, ...notRun],
        resultDetailFromGit(
          "gitlink-raise-failed",
          "raise-gitlink",
          root,
          args,
          written,
          `The prospective merge of ${target} was applied, but ${raise.path} was not raised from ${raise.from} to ${raise.to}.`,
          `git -C ${root} status --short`,
          "Inspect and preserve the uncommitted merge before deciding whether a retry is safe.",
          "the caller",
          { paths: [raise.path], objectIds: [raise.from, raise.to] },
        ),
      )
    }
    completed.push({ ...raise })
  }

  const commitArgs = ["commit", ...(options.noVerify === true ? ["--no-verify"] : []), "-F", "-"]
  const committed = await run(git, root, commitArgs, timeoutMs, settledMessage)
  if (committed.code !== 0) {
    return partial(
      root,
      undefined,
      completed,
      resultDetailFromGit(
        "settled-merge-commit-failed",
        "write-settled-merge",
        root,
        commitArgs,
        committed,
        `The prospective merge of ${target} and its Settled report were prepared, but the concluding commit was not written.`,
        `git -C ${root} status --short`,
        "Preserve the uncommitted merge and inspect the named Git failure before retrying.",
        "the caller",
      ),
    )
  }
  const observedSettled = await run(git, root, ["rev-parse", "HEAD^{commit}"], timeoutMs)
  if (observedSettled.code !== 0) {
    return partial(
      root,
      undefined,
      completed,
      resultDetailFromGit(
        "post-commit-observation-failed",
        "observe-settled-merge",
        root,
        ["rev-parse", "HEAD^{commit}"],
        observedSettled,
        `Git reported that the settled merge of ${target} was committed, but the resulting HEAD could not be read.`,
        `git -C ${root} status --short`,
        "Inspect and preserve the checkout before deciding whether a retry is safe.",
        "the caller",
      ),
    )
  }
  const mergeCommit = observedSettled.stdout.trim()

  for (const checkout of planned.checkouts) {
    const args = ["checkout", "--detach", checkout.to]
    const checkedOut = await run(git, join(root, checkout.path), args, timeoutMs)
    if (checkedOut.code !== 0) {
      return partial(
        root,
        mergeCommit,
        completed,
        resultDetailFromGit(
          "component-checkout-failed",
          "settle-component-checkout",
          join(root, checkout.path),
          args,
          checkedOut,
          `Settled merge ${mergeCommit} records ${checkout.path} at ${checkout.to}, but that component checkout could not be detached at the same commit.`,
          `git -C ${join(root, checkout.path)} rev-parse HEAD`,
          `git -C ${root} submodule update --init -- ${checkout.path}`,
          "the caller",
          { paths: [checkout.path], objectIds: [checkout.to] },
        ),
      )
    }
  }

  return {
    state: "updated",
    partial: false,
    commit: mergeCommit,
    gitlinks: completed,
    repositories: [{ repository: root, state: "updated", refs: [] }],
  }
}

async function prospectiveTree(
  git: GitProcess,
  root: string,
  head: string,
  target: string,
  timeoutMs: number,
): Promise<Readonly<{ tree: string }> | Readonly<{ failure: GitResultDetail }>> {
  const args = ["merge-tree", "--write-tree", "--messages", head, target]
  const result = await run(git, root, args, timeoutMs)
  const tree = result.stdout.split(/\r?\n/u)[0]?.trim()
  if (result.code === 0 && tree !== undefined && OBJECT_ID.test(tree)) return { tree }
  if (result.code === 1) {
    return {
      failure: obviousDetail(
        "merge-conflict",
        `Merge ${target} conflicts with current HEAD ${head}; no commit was written.`,
        `git -C ${root} merge-tree --write-tree ${head} ${target}`,
        "Resolve the named conflict on the submitted branch, then rerun the same git super merge command.",
        "the caller",
        { objectIds: [head, target] },
      ),
    }
  }
  return {
    failure: resultDetailFromGit(
      "merge-preflight-failed",
      "preflight-merge",
      root,
      args,
      result,
      `The prospective merge of ${target} into ${head} could not be computed; no commit was written.`,
      `git -C ${root} merge-tree --write-tree ${head} ${target}`,
      "Resolve the reported Git condition, then rerun the same git super merge command.",
      "the caller",
      { objectIds: [head, target] },
    ),
  }
}

async function planGitlinks(
  git: GitProcess,
  root: string,
  head: string,
  tree: string,
  timeoutMs: number,
): Promise<GitlinkPlans> {
  const before = new Map((await readCommitSubmodules(git, root, head)).map((entry) => [entry.path, entry.target]))
  const merged = await readCommitSubmodules(git, root, tree)
  const plans: GitlinkPlan[] = []
  const checkouts = new Map<string, string>()
  for (const entry of merged) {
    const component = join(root, entry.path)
    const main = await fetchComponentMain(git, component, entry.path, entry.target, timeoutMs)
    const changedByMerge = before.get(entry.path) !== entry.target
    if (entry.target === main) {
      if (changedByMerge) checkouts.set(entry.path, entry.target)
      continue
    }
    const ancestry = await run(git, component, ["merge-base", "--is-ancestor", entry.target, main], timeoutMs)
    if (ancestry.code === 0) {
      checkouts.set(entry.path, main)
      plans.push({
        path: entry.path,
        from: entry.target,
        to: main,
        state: "raised",
        changedByMerge,
      })
      continue
    }
    if (ancestry.code === 1) {
      if (changedByMerge) checkouts.set(entry.path, entry.target)
      plans.push({
        path: entry.path,
        from: entry.target,
        to: main,
        state: "left-off-main",
        changedByMerge,
      })
      continue
    }
    throw operationError(
      component,
      "prove-gitlink-on-main",
      ["merge-base", "--is-ancestor", entry.target, main],
      ancestry,
    )
  }
  return { settlements: plans, checkouts: [...checkouts].map(([path, to]) => ({ path, to })) }
}

async function mergeApplicationFailure(
  git: GitProcess,
  root: string,
  head: string,
  target: string,
  args: readonly string[],
  result: GitProcessResult,
  timeoutMs: number,
): Promise<SuperMergeResult> {
  const observed = await run(git, root, ["rev-parse", "HEAD^{commit}"], timeoutMs)
  const status = await run(git, root, ["status", "--porcelain=v1", "--untracked-files=all"], timeoutMs)
  const changed =
    observed.code !== 0 || observed.stdout.trim() !== head || status.code !== 0 || status.stdout.trim() !== ""
  const detail = resultDetailFromGit(
    changed ? "merge-application-partial" : "merge-application-failed",
    "apply-merge",
    root,
    args,
    result,
    changed
      ? `Git did not complete merge ${target}, and the checkout no longer matches its preflight state.`
      : `Git refused merge ${target}; HEAD, index, and worktree remain unchanged.`,
    `git -C ${root} status --short`,
    changed
      ? "Inspect and preserve the partial checkout before deciding whether a retry is safe."
      : "Resolve the reported Git condition, then rerun the same git super merge command.",
    "the caller",
    { objectIds: [head, target] },
  )
  const commit = observed.code === 0 && observed.stdout.trim() !== head ? observed.stdout.trim() : undefined
  return changed ? partial(root, commit, [], detail) : failed(root, [], detail)
}

async function fetchComponentMain(
  git: GitProcess,
  component: string,
  path: string,
  pin: string,
  timeoutMs: number,
): Promise<string> {
  const fetchArgs = ["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"]
  const fetched = await run(git, component, fetchArgs, timeoutMs)
  if (fetched.code !== 0) throw componentMainError(component, path, pin, fetchArgs, fetched)
  const resolveArgs = ["rev-parse", "refs/remotes/origin/main^{commit}"]
  const resolved = await run(git, component, resolveArgs, timeoutMs)
  if (resolved.code !== 0) throw componentMainError(component, path, pin, resolveArgs, resolved)
  return resolved.stdout.trim()
}

function componentMainError(
  component: string,
  path: string,
  pin: string,
  args: readonly string[],
  result: GitProcessResult,
): Error & Readonly<{ resultDetail: GitResultDetail }> {
  return operationError(
    component,
    "read-component-main",
    args,
    result,
    obviousDetail(
      "component-main-unreadable",
      `Component main for ${path} could not be read while inspecting gitlink ${pin}.`,
      `git -C ${component} ${args.join(" ")}`,
      `Repair access to ${path} origin/main, then rerun the same git super merge command.`,
      "the component writer",
      { paths: [path], objectIds: [pin], phase: "read-component-main" },
    ),
  )
}

function obviousDetail(
  code: string,
  subject: string,
  evidence: string,
  next: string,
  owner: string,
  extra: Partial<GitResultDetail> = {},
): GitResultDetail {
  return {
    code,
    phase: extra.phase ?? "preflight",
    message: `${code}: ${subject}; evidence: ${evidence}; next: ${next}; owner: ${owner}`,
    subject,
    evidence,
    next,
    owner,
    remedy: next,
    ...extra,
  }
}

function resultDetailFromGit(
  code: string,
  phase: string,
  repository: string,
  args: readonly string[],
  result: GitProcessResult,
  subject?: string,
  evidence?: string,
  next?: string,
  owner?: string,
  extra: Partial<GitResultDetail> = {},
): GitResultDetail {
  const gitMessage = result.timedOut
    ? `git ${args.join(" ")} timed out in ${repository}`
    : `git ${args.join(" ")} failed in ${repository} (exit ${result.code})${result.stderr ? `: ${result.stderr}` : ""}`
  const detail = obviousDetail(
    code,
    subject ?? gitMessage,
    evidence ?? `git -C ${repository} ${args.join(" ")}`,
    next ?? "Resolve the reported Git condition, then rerun the same git super merge command.",
    owner ?? "the caller",
    { ...extra, phase },
  )
  return subject === undefined ? detail : { ...detail, message: `${detail.message}; git: ${gitMessage}` }
}

function operationError(
  repository: string,
  phase: string,
  args: readonly string[],
  result: GitProcessResult,
  detail?: GitResultDetail,
): Error & Readonly<{ resultDetail: GitResultDetail }> {
  const resultDetail = detail ?? resultDetailFromGit("git-failed", phase, repository, args, result)
  return Object.assign(new Error(resultDetail.message), { resultDetail })
}

function resultError(error: unknown, phase: string): GitResultDetail {
  if (typeof error === "object" && error !== null && "resultDetail" in error) {
    return (error as { resultDetail: GitResultDetail }).resultDetail
  }
  if (error instanceof Error && error.message.includes("worktree mutation lock is busy")) {
    return obviousDetail(
      "mutation-lock-busy",
      error.message,
      "the repository-scoped writer lock",
      "Wait for the named holder to finish, then rerun the same git super merge command.",
      "the current lock holder",
      { phase: "acquire-mutation-lock" },
    )
  }
  return obviousDetail(
    "unexpected-error",
    error instanceof Error ? error.message : String(error),
    phase,
    "Inspect the named phase and retry only after its underlying condition is understood.",
    "the caller",
    { phase },
  )
}

function failed(root: string, gitlinks: readonly SuperMergeGitlinkResult[], detail: GitResultDetail): SuperMergeResult {
  return {
    state: "failed",
    partial: false,
    detail,
    gitlinks,
    repositories: [{ repository: root, state: "failed", detail, refs: [] }],
  }
}

function partial(
  root: string,
  commit: string | undefined,
  gitlinks: readonly SuperMergeGitlinkResult[],
  detail: GitResultDetail,
): SuperMergeResult {
  const repository: GitSuperRepositoryResult = { repository: root, state: "updated", detail, refs: [] }
  return {
    state: "failed",
    partial: true,
    detail,
    ...(commit === undefined ? {} : { commit }),
    gitlinks,
    repositories: [repository],
  }
}

async function run(
  git: GitProcess,
  repository: string,
  args: readonly string[],
  timeoutMs: number,
  stdin?: string,
): Promise<GitProcessResult> {
  return git.run({ repo: repository, args, timeoutMs, ...(stdin === undefined ? {} : { stdin }) })
}

async function required(
  git: GitProcess,
  repository: string,
  args: readonly string[],
  phase: string,
  timeoutMs: number,
): Promise<string> {
  const result = await run(git, repository, args, timeoutMs)
  if (result.code !== 0) throw operationError(repository, phase, args, result)
  return result.stdout.trim()
}

async function lockDirectory(git: GitProcess, repository: string, timeoutMs: number): Promise<string> {
  const commonDir = await required(
    git,
    repository,
    ["rev-parse", "--git-common-dir"],
    "locate-mutation-lock",
    timeoutMs,
  )
  const root = isAbsolute(commonDir) ? commonDir : resolve(repository, commonDir)
  return join(root, "yrd-worktree-mutations")
}
