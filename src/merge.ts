import { isAbsolute, join, resolve } from "node:path"
import { readCommitSubmodules } from "./commit-graph.ts"
import { createExclusive, type Exclusive } from "./exclusive.ts"
import { createLocalGitProcess, type GitProcess, type GitProcessResult } from "./process.ts"
import type { GitResultDetail, GitSuperRepositoryResult, GitSuperResult } from "./result.ts"

export type SuperMergeGitlinkResult = Readonly<
  { path: string; from: string } & (
    | Readonly<{ to: string; state: "raised" | "kept-ahead" | "left-off-main" | "not-run" }>
    | Readonly<{ to?: string; state: "as-written"; detail?: GitResultDetail }>
  )
>

export type SuperMergeCheckoutResult = Readonly<{
  path: string
  recorded: string
  index: string
  preCheckout: string
  checkout?: string
  state: "settled" | "settle-failed" | "restored" | "restore-failed" | "not-run"
}>

export type SuperMergeResult = GitSuperResult &
  Readonly<{
    commit?: string
    gitlinks: readonly SuperMergeGitlinkResult[]
    /** Additive recovery evidence for component checkouts touched by a merge. */
    checkouts?: readonly SuperMergeCheckoutResult[]
  }>

export type SuperMergeOptions = Readonly<{
  repo: string
  commit: string
  message?: string
  pinAsWritten?: readonly string[]
  noVerify?: boolean
  timeoutMs?: number
  git?: GitProcess
  exclusive?: Exclusive
}>

type GitlinkPlan = Readonly<
  { path: string; from: string; changedByMerge: boolean } & (
    | Readonly<{ to: string; state: "raised" | "kept-ahead" | "left-off-main" }>
    | Readonly<{ to?: string; state: "as-written"; detail?: GitResultDetail }>
  )
>

type GitlinkPlans = Readonly<{
  settlements: readonly GitlinkPlan[]
  checkouts: readonly GitlinkCheckoutPlan[]
}>

type GitlinkCheckoutPlan = Readonly<{
  path: string
  recorded: string
  index: string
}>

type PreparedCheckout = GitlinkCheckoutPlan & Readonly<{ preCheckout: string }>

type CheckoutFailure = Readonly<{
  plan: PreparedCheckout
  args: readonly string[]
  result: GitProcessResult
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
  const statusArgs = ["status", "--porcelain=v1", "-z", "--untracked-files=all"]
  const status = await run(git, root, statusArgs, timeoutMs)
  if (status.code !== 0) {
    return failed(root, [], resultDetailFromGit("git-failed", "verify-clean", root, statusArgs, status))
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
    planned = await planGitlinks(git, root, head, prospective.tree, options.pinAsWritten ?? [], timeoutMs)
  } catch (error) {
    return failed(root, [], resultError(error, "inspect-gitlinks"))
  }
  const plans = planned.settlements
  const refusal = plans.find(
    (plan): plan is GitlinkPlan & { to: string; state: "left-off-main" } =>
      plan.state === "left-off-main" && plan.changedByMerge,
  )
  if (refusal !== undefined) {
    return failed(
      root,
      [],
      obviousDetail(
        "component-main-moved",
        `Merge ${target} would change ${refusal.path} to authored pin ${refusal.from}, which has diverged from fetched component main ${refusal.to}.`,
        `git -C ${join(root, refusal.path)} merge-base --is-ancestor ${refusal.from} ${refusal.to}; git -C ${join(root, refusal.path)} merge-base --is-ancestor ${refusal.to} ${refusal.from}`,
        `Rebase the change's ${refusal.path} history onto component main ${refusal.to}, then rerun the same git super merge command.`,
        "the change author",
        { paths: [refusal.path], objectIds: [refusal.from, refusal.to] },
      ),
    )
  }
  const visiblePlans: SuperMergeGitlinkResult[] = plans.map(({ changedByMerge: _changedByMerge, ...plan }) => plan)

  const trailers = visiblePlans.map((plan) =>
    plan.state === "raised"
      ? `Settled: ${plan.path}@${plan.to}`
      : plan.state === "kept-ahead"
        ? `Settled: ${plan.path}@${plan.from} kept-ahead component-main@${plan.to}`
        : plan.state === "as-written"
          ? `Settled: ${plan.path}@${plan.from} as-written${plan.to === undefined ? "" : ` component-main@${plan.to}`}`
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

  const prepared = await prepareComponentCheckouts(git, root, planned.checkouts, timeoutMs)
  if ("failure" in prepared) return failed(root, [], prepared.failure, prepared.rows)
  const preparedCheckouts = prepared.checkouts
  const preparedRows = checkoutResults(preparedCheckouts)
  const statusFailure = await validateWorktreeStatus(
    git,
    root,
    options.commit,
    status.stdout,
    preparedCheckouts,
    timeoutMs,
  )
  if (statusFailure !== undefined) return failed(root, [], statusFailure, preparedRows)

  // Interim for alternate-backed worktree modules: Git 2.55 can treat a split
  // commit-graph read failure as a submodule conflict. Keep this on both the
  // preflight and application paths until the minimal reproduction below no
  // longer diverges with core.commitGraph enabled.
  const mergeArgs = [
    "-c",
    "core.commitGraph=false",
    "merge",
    "--no-ff",
    "--no-commit",
    ...(options.noVerify === true ? ["--no-verify"] : []),
    target,
  ]
  const merged = await run(git, root, mergeArgs, timeoutMs)
  if (merged.code !== 0) {
    return mergeApplicationFailure(git, root, head, target, mergeArgs, merged, timeoutMs)
  }
  const completed = visiblePlans
    .filter((plan): plan is Exclude<SuperMergeGitlinkResult, { state: "raised" }> => plan.state !== "raised")
    .map((plan) => ({ ...plan }))
  const raises = visiblePlans.filter(
    (plan): plan is SuperMergeGitlinkResult & { to: string; state: "raised" } => plan.state === "raised",
  )
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
        preparedRows,
      )
    }
    completed.push({ ...raise })
  }

  const settledCheckouts = await settleComponentCheckouts(git, root, preparedCheckouts, timeoutMs)
  if (settledCheckouts.failure !== undefined) {
    const restored = await restoreComponentCheckouts(git, root, preparedCheckouts, settledCheckouts.rows, timeoutMs)
    const failure = restored.failure
    const evidence = formatCheckoutEvidence(restored.rows)
    return partial(
      root,
      undefined,
      completed,
      failure === undefined
        ? resultDetailFromGit(
            "component-checkout-failed",
            "settle-component-checkout",
            join(root, settledCheckouts.failure.plan.path),
            settledCheckouts.failure.args,
            settledCheckouts.failure.result,
            `The prospective merge remains uncommitted because ${settledCheckouts.failure.plan.path} could not be checked out at staged index pin ${settledCheckouts.failure.plan.index}; every affected component checkout was restored to its recorded pin.`,
            evidence,
            "Inspect the preserved root merge and the named checkout failure before deciding whether a retry is safe.",
            "the caller",
            {
              paths: [settledCheckouts.failure.plan.path],
              objectIds: [settledCheckouts.failure.plan.recorded, settledCheckouts.failure.plan.index],
            },
          )
        : rollbackFailureDetail(
            root,
            "component checkout preparation",
            settledCheckouts.failure,
            failure,
            restored.rows,
          ),
      restored.rows,
    )
  }

  const commitArgs = ["commit", ...(options.noVerify === true ? ["--no-verify"] : []), "-F", "-"]
  const committed = await run(git, root, commitArgs, timeoutMs, settledMessage)
  if (committed.code !== 0) {
    const observedHead = await run(git, root, ["rev-parse", "HEAD^{commit}"], timeoutMs)
    if (observedHead.code !== 0) {
      return partial(
        root,
        undefined,
        completed,
        resultDetailFromGit(
          "settled-merge-commit-state-unknown",
          "observe-rejected-settled-merge",
          root,
          ["rev-parse", "HEAD^{commit}"],
          observedHead,
          `Git reported that the settled merge commit failed, and HEAD could not be read, so component checkouts were not rolled back.`,
          formatCheckoutEvidence(settledCheckouts.rows),
          "Preserve the root and component checkouts until the commit outcome is known.",
          "the caller",
        ),
        settledCheckouts.rows,
      )
    }
    const observedCommit = observedHead.stdout.trim()
    if (observedCommit !== head) {
      return partial(
        root,
        observedCommit,
        completed,
        resultDetailFromGit(
          "settled-merge-commit-reported-failed",
          "write-settled-merge",
          root,
          commitArgs,
          committed,
          `Git reported that the settled merge commit failed, but HEAD moved from ${head} to ${observedCommit}; component checkouts remain at the staged pins.`,
          formatCheckoutEvidence(settledCheckouts.rows),
          "Preserve the observed commit and inspect the named Git failure before any retry.",
          "the caller",
          { objectIds: [head, observedCommit] },
        ),
        settledCheckouts.rows,
      )
    }

    const restored = await restoreComponentCheckouts(git, root, preparedCheckouts, settledCheckouts.rows, timeoutMs)
    const evidence = formatCheckoutEvidence(restored.rows)
    return partial(
      root,
      undefined,
      completed,
      restored.failure === undefined
        ? resultDetailFromGit(
            "settled-merge-commit-failed",
            "write-settled-merge",
            root,
            commitArgs,
            committed,
            `The prospective merge of ${target} and its Settled report remain staged, the concluding commit was not written, and every component checkout was restored to its recorded pin.`,
            evidence,
            "Inspect the preserved root merge and named Git failure; move each component to its staged index pin before retrying the commit.",
            "the caller",
          )
        : rollbackFailureDetail(root, "the rejected settled merge commit", undefined, restored.failure, restored.rows),
      restored.rows,
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
      settledCheckouts.rows,
    )
  }
  const mergeCommit = observedSettled.stdout.trim()

  return {
    state: "updated",
    partial: false,
    commit: mergeCommit,
    gitlinks: completed,
    ...(settledCheckouts.rows.length === 0 ? {} : { checkouts: settledCheckouts.rows }),
    repositories: [{ repository: root, state: "updated", refs: [] }],
  }
}

async function prepareComponentCheckouts(
  git: GitProcess,
  root: string,
  plans: readonly GitlinkCheckoutPlan[],
  timeoutMs: number,
): Promise<
  | Readonly<{ checkouts: readonly PreparedCheckout[] }>
  | Readonly<{ failure: GitResultDetail; rows: readonly SuperMergeCheckoutResult[] }>
> {
  const checkouts: PreparedCheckout[] = []
  for (const plan of plans) {
    const component = join(root, plan.path)
    const args = ["rev-parse", "HEAD^{commit}"]
    const observed = await run(git, component, args, timeoutMs)
    if (observed.code !== 0) {
      return {
        failure: resultDetailFromGit(
          "component-checkout-unreadable",
          "prepare-component-checkout",
          component,
          args,
          observed,
          `The pre-merge checkout pin for ${plan.path} could not be read, so no merge was started.`,
          `git -C ${component} rev-parse HEAD^{commit}`,
          `Restore an initialized checkout for ${plan.path} at recorded pin ${plan.recorded}, then rerun the merge.`,
          "the caller",
          { paths: [plan.path], objectIds: [plan.recorded, plan.index] },
        ),
        rows: checkoutResults(checkouts),
      }
    }
    const preCheckout = observed.stdout.trim()
    if (!OBJECT_ID.test(preCheckout) || (preCheckout !== plan.recorded && preCheckout !== plan.index)) {
      const row: SuperMergeCheckoutResult = {
        ...plan,
        preCheckout,
        checkout: preCheckout,
        state: "not-run",
      }
      return {
        failure: obviousDetail(
          "component-checkout-drift",
          `Before the merge, ${plan.path} records ${plan.recorded} but its checkout is ${preCheckout}; no merge was started.`,
          formatCheckoutEvidence([row]),
          `Restore ${plan.path} to recorded pin ${plan.recorded}, then rerun the merge.`,
          "the caller",
          { paths: [plan.path], objectIds: [plan.recorded, plan.index, preCheckout] },
        ),
        rows: [...checkoutResults(checkouts), row],
      }
    }
    checkouts.push({ ...plan, preCheckout })
  }
  return { checkouts }
}

async function validateWorktreeStatus(
  git: GitProcess,
  root: string,
  commit: string,
  status: string,
  plans: readonly PreparedCheckout[],
  timeoutMs: number,
): Promise<GitResultDetail | undefined> {
  const alreadySettled = plans.filter((plan) => plan.preCheckout === plan.index)
  const allowedRootRecords = new Set(alreadySettled.map((plan) => ` M ${plan.path}`))
  const unexpectedRootRecords = nulRecords(status).filter((record) => !allowedRootRecords.has(record))
  if (unexpectedRootRecords.length > 0) return dirtyWorktreeDetail(root, commit, unexpectedRootRecords)

  for (const plan of alreadySettled) {
    const component = join(root, plan.path)
    const args = ["status", "--porcelain=v1", "-z", "--untracked-files=all"]
    const componentStatus = await run(git, component, args, timeoutMs)
    if (componentStatus.code !== 0) {
      return resultDetailFromGit("git-failed", "verify-clean", component, args, componentStatus)
    }
    const componentRecords = nulRecords(componentStatus.stdout)
    if (componentRecords.length > 0) {
      return dirtyWorktreeDetail(
        root,
        commit,
        componentRecords.map((record) => `${plan.path}: ${record}`),
      )
    }
  }
  return undefined
}

function nulRecords(output: string): string[] {
  return output.split("\0").filter(Boolean)
}

function dirtyWorktreeDetail(root: string, commit: string, paths: readonly string[]): GitResultDetail {
  return obviousDetail(
    "dirty-worktree",
    `The current worktree at ${root} is not clean, so merge ${commit} was not started.`,
    `git -C ${root} status --short`,
    "Commit or otherwise preserve the named changes, then rerun the same git super merge command.",
    "the caller",
    { paths },
  )
}

function checkoutResults(plans: readonly PreparedCheckout[]): SuperMergeCheckoutResult[] {
  return plans.map((plan) => ({
    ...plan,
    checkout: plan.preCheckout,
    state: plan.preCheckout === plan.index ? "settled" : "not-run",
  }))
}

async function settleComponentCheckouts(
  git: GitProcess,
  root: string,
  plans: readonly PreparedCheckout[],
  timeoutMs: number,
): Promise<
  Readonly<{
    rows: readonly SuperMergeCheckoutResult[]
    failure?: CheckoutFailure
  }>
> {
  const rows = checkoutResults(plans)
  for (let index = 0; index < plans.length; index += 1) {
    const plan = plans[index]
    if (plan === undefined) continue
    if (plan.preCheckout === plan.index) continue
    const component = join(root, plan.path)
    const args = ["checkout", "--detach", plan.index]
    const checkedOut = await run(git, component, args, timeoutMs)
    if (checkedOut.code !== 0) {
      rows[index] = { ...plan, checkout: plan.preCheckout, state: "settle-failed" }
      return { rows, failure: { plan, args, result: checkedOut } }
    }
    const observeArgs = ["rev-parse", "HEAD^{commit}"]
    const observed = await run(git, component, observeArgs, timeoutMs)
    const checkout = observed.stdout.trim()
    if (observed.code !== 0 || checkout !== plan.index) {
      const result =
        observed.code !== 0
          ? observed
          : {
              code: 1,
              stdout: observed.stdout,
              stderr: `checkout observation mismatch: expected ${plan.index}, observed ${checkout}`,
            }
      rows[index] = { ...plan, ...(checkout === "" ? {} : { checkout }), state: "settle-failed" }
      return { rows, failure: { plan, args: observeArgs, result } }
    }
    rows[index] = { ...plan, checkout, state: "settled" }
  }
  return { rows }
}

async function restoreComponentCheckouts(
  git: GitProcess,
  root: string,
  plans: readonly PreparedCheckout[],
  currentRows: readonly SuperMergeCheckoutResult[],
  timeoutMs: number,
): Promise<Readonly<{ rows: readonly SuperMergeCheckoutResult[]; failure?: CheckoutFailure }>> {
  const rows = [...currentRows]
  let failure: CheckoutFailure | undefined
  for (let index = plans.length - 1; index >= 0; index -= 1) {
    const plan = plans[index]
    if (plan === undefined) continue
    const row = rows[index]
    if (row?.state !== "settled" && row?.state !== "settle-failed") continue
    const component = join(root, plan.path)
    const args = ["checkout", "--detach", plan.recorded]
    const restored = await run(git, component, args, timeoutMs)
    const observed = await run(git, component, ["rev-parse", "HEAD^{commit}"], timeoutMs)
    const checkout = observed.code === 0 ? observed.stdout.trim() : undefined
    if (restored.code !== 0 || checkout !== plan.recorded) {
      const result =
        restored.code !== 0
          ? restored
          : observed.code !== 0
            ? observed
            : {
                code: 1,
                stdout: observed.stdout,
                stderr: `rollback observation mismatch: expected ${plan.recorded}, observed ${checkout ?? "unreadable"}`,
              }
      rows[index] = { ...plan, ...(checkout === undefined ? {} : { checkout }), state: "restore-failed" }
      failure ??= { plan, args, result }
      continue
    }
    rows[index] = { ...plan, checkout, state: "restored" }
  }
  return { rows, ...(failure === undefined ? {} : { failure }) }
}

function formatCheckoutEvidence(rows: readonly SuperMergeCheckoutResult[]): string {
  if (rows.length === 0) return "component-checkouts: none"
  return rows
    .map(
      (row) =>
        `${row.path}: recorded=${row.recorded} index=${row.index} checkout=${row.checkout ?? "unreadable"} pre-checkout=${row.preCheckout} state=${row.state}`,
    )
    .join(" | ")
}

function rollbackFailureDetail(
  root: string,
  cause: string,
  checkoutFailure: CheckoutFailure | undefined,
  rollbackFailure: CheckoutFailure,
  rows: readonly SuperMergeCheckoutResult[],
): GitResultDetail {
  const path = rollbackFailure.plan.path
  const causeText =
    checkoutFailure === undefined
      ? cause
      : `${cause} failed for ${checkoutFailure.plan.path} before ${path} rollback was attempted`
  return resultDetailFromGit(
    "component-checkout-rollback-failed",
    "restore-component-checkout",
    join(root, path),
    rollbackFailure.args,
    rollbackFailure.result,
    `The root merge remains preserved after ${causeText}, but ${path} could not be restored exactly to recorded pin ${rollbackFailure.plan.recorded}.`,
    formatCheckoutEvidence(rows),
    "Do not retry the commit; preserve the root and components, restore every restore-failed row to its recorded pin, then prove recorded, index, and checkout pins again.",
    "the caller",
    {
      paths: rows.filter((row) => row.state === "restore-failed").map((row) => row.path),
      objectIds: [
        ...new Set(
          rows.flatMap((row) => [
            row.recorded,
            row.index,
            row.preCheckout,
            ...(row.checkout === undefined ? [] : [row.checkout]),
          ]),
        ),
      ],
    },
  )
}

async function prospectiveTree(
  git: GitProcess,
  root: string,
  head: string,
  target: string,
  timeoutMs: number,
): Promise<Readonly<{ tree: string }> | Readonly<{ failure: GitResultDetail }>> {
  const args = [
    "-c",
    "core.commitGraph=false",
    "merge-tree",
    "--write-tree",
    "--name-only",
    "-z",
    "--no-messages",
    head,
    target,
  ]
  const result = await run(git, root, args, timeoutMs)
  const [tree, ...paths] = nulRecords(result.stdout)
  if (result.code === 0 && tree !== undefined && OBJECT_ID.test(tree)) return { tree }
  const unreadable = /(?:^|\n)error: Could not read ([0-9a-f]{40,64})(?:\r?$|\s)/imu.exec(result.stderr)?.[1]
  if (unreadable !== undefined) {
    return {
      failure: resultDetailFromGit(
        "component-history-unreadable",
        "preflight-merge",
        root,
        args,
        result,
        `The prospective merge of ${target} into ${head} could not read component history object ${unreadable}; no commit was written.`,
        `git -C ${root} ${args.join(" ")}`,
        "Repair the named object or its commit graph, then rerun the same git super merge command.",
        "the caller",
        { objectIds: [head, target, unreadable] },
      ),
    }
  }
  if (result.code === 1) {
    const location =
      paths.length === 0
        ? "; Git reported no conflicted paths"
        : ` at ${paths.map((path) => JSON.stringify(path)).join(", ")}`
    return {
      failure: resultDetailFromGit(
        "merge-conflict",
        "preflight-merge",
        root,
        args,
        result,
        `Merge ${target} conflicts with current HEAD ${head}${location}; no commit was written.`,
        `git -C ${root} ${args.join(" ")}`,
        "Resolve the named conflict on the submitted branch, then rerun the same git super merge command.",
        "the caller",
        { paths, objectIds: [head, target] },
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
      `git -C ${root} ${args.join(" ")}`,
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
  pinAsWrittenPaths: readonly string[],
  timeoutMs: number,
): Promise<GitlinkPlans> {
  const before = new Map((await readCommitSubmodules(git, root, head)).map((entry) => [entry.path, entry.target]))
  const merged = await readCommitSubmodules(git, root, tree)
  const mergedPaths = new Set(merged.map((entry) => entry.path))
  const pinAsWritten = new Set(pinAsWrittenPaths)
  const invalidPath = [...pinAsWritten].find((path) => !mergedPaths.has(path))
  if (invalidPath !== undefined) {
    const detail = obviousDetail(
      "invalid-gitlink-path",
      `Pin-as-written path ${invalidPath} is not a direct gitlink in the prospective merge tree.`,
      `git -C ${root} ls-tree ${tree} -- ${invalidPath}`,
      "Name an exact direct gitlink path from the prospective merge tree.",
      "the caller",
      { phase: "validate-pin-as-written", paths: [invalidPath], objectIds: [tree] },
    )
    throw Object.assign(new Error(detail.message), { resultDetail: detail })
  }
  const plans: GitlinkPlan[] = []
  const checkouts = new Map<string, GitlinkCheckoutPlan>()
  for (const entry of merged) {
    const component = join(root, entry.path)
    const recordedBefore = before.get(entry.path)
    const recorded = recordedBefore ?? entry.target
    const changedByMerge = recordedBefore !== entry.target
    if (!changedByMerge) continue
    await requireComponentPin(git, component, entry.path, entry.target, timeoutMs)
    if (pinAsWritten.has(entry.path)) {
      checkouts.set(entry.path, { path: entry.path, recorded, index: entry.target })
      try {
        const main = await fetchComponentMain(git, component, entry.path, entry.target, timeoutMs)
        if (entry.target !== main) {
          plans.push({
            path: entry.path,
            from: entry.target,
            to: main,
            state: "as-written",
            changedByMerge,
          })
        }
      } catch (error) {
        const detail = resultError(error, "read-component-main")
        if (detail.code !== "component-main-unreadable") throw error
        plans.push({
          path: entry.path,
          from: entry.target,
          state: "as-written",
          changedByMerge,
          detail,
        })
      }
      continue
    }
    const main = await fetchComponentMain(git, component, entry.path, entry.target, timeoutMs)
    if (entry.target === main) {
      checkouts.set(entry.path, { path: entry.path, recorded, index: entry.target })
      continue
    }
    const ancestry = await run(git, component, ["merge-base", "--is-ancestor", entry.target, main], timeoutMs)
    if (ancestry.code === 0) {
      checkouts.set(entry.path, { path: entry.path, recorded, index: main })
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
      const descends = await run(git, component, ["merge-base", "--is-ancestor", main, entry.target], timeoutMs)
      if (descends.code === 0) {
        checkouts.set(entry.path, { path: entry.path, recorded, index: entry.target })
        plans.push({
          path: entry.path,
          from: entry.target,
          to: main,
          state: "kept-ahead",
          changedByMerge,
        })
        continue
      }
      if (descends.code !== 1) {
        throw operationError(
          component,
          "prove-gitlink-descends-from-main",
          ["merge-base", "--is-ancestor", main, entry.target],
          descends,
        )
      }
      checkouts.set(entry.path, { path: entry.path, recorded, index: entry.target })
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
  return { settlements: plans, checkouts: [...checkouts.values()] }
}

async function requireComponentPin(
  git: GitProcess,
  component: string,
  path: string,
  pin: string,
  timeoutMs: number,
): Promise<void> {
  const args = ["cat-file", "-e", `${pin}^{commit}`]
  const result = await run(git, component, args, timeoutMs)
  if (result.code === 0) return
  throw operationError(
    component,
    "read-component-pin",
    args,
    result,
    obviousDetail(
      "component-pin-unreadable",
      `Authored gitlink pin ${pin} for ${path} is not a readable commit in its component repository.`,
      `git -C ${component} ${args.join(" ")}`,
      `Publish and materialize ${pin} in ${path}, then rerun the same git super merge command.`,
      "the change author",
      { phase: "read-component-pin", paths: [path], objectIds: [pin] },
    ),
  )
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

function failed(
  root: string,
  gitlinks: readonly SuperMergeGitlinkResult[],
  detail: GitResultDetail,
  checkouts: readonly SuperMergeCheckoutResult[] = [],
): SuperMergeResult {
  return {
    state: "failed",
    partial: false,
    detail,
    gitlinks,
    ...(checkouts.length === 0 ? {} : { checkouts }),
    repositories: [{ repository: root, state: "failed", detail, refs: [] }],
  }
}

function partial(
  root: string,
  commit: string | undefined,
  gitlinks: readonly SuperMergeGitlinkResult[],
  detail: GitResultDetail,
  checkouts: readonly SuperMergeCheckoutResult[] = [],
): SuperMergeResult {
  const repository: GitSuperRepositoryResult = { repository: root, state: "updated", detail, refs: [] }
  return {
    state: "failed",
    partial: true,
    detail,
    ...(commit === undefined ? {} : { commit }),
    gitlinks,
    ...(checkouts.length === 0 ? {} : { checkouts }),
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
