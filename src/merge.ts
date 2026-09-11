import { isAbsolute, join, resolve } from "node:path"
import { readCommitSubmodules, resolveSubmoduleBranch, type CommitSubmodule } from "./commit-graph.ts"
import { ensureCommitObject } from "./objects.ts"
import { prepareSubmoduleTreeUnderLock } from "./submodule-prepare.ts"
import { capturePushIntent, discoverRepository, rootPushIdentity } from "./push.ts"
import { PUSH_INTENT_TRAILER, sameHostedOwner } from "./push-intent.ts"
import { createExclusive, type Exclusive } from "./exclusive.ts"
import { parseIndexEntries, type IndexEntry } from "./index-entries.ts"
import { createLocalGitProcess, type GitProcess, type GitProcessResult } from "./process.ts"
import type { GitResultDetail, GitSuperRepositoryResult, GitSuperResult } from "./result.ts"

export type SuperMergeGitlinkResult = Readonly<{
  path: string
  from: string
  to: string
  state: "raised" | "kept-ahead" | "kept-behind" | "as-written" | "left-off-main" | "not-run"
}>

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
    /** Additive recovery evidence for submodule checkouts touched by a merge. */
    checkouts?: readonly SuperMergeCheckoutResult[]
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
  state: "raised" | "kept-ahead" | "kept-behind" | "as-written" | "left-off-main"
  changedByMerge: boolean
}>

type GitlinkPlans = Readonly<{
  settlements: readonly GitlinkPlan[]
  stores: ReadonlyMap<string, string>
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
        `Merge ${target} would change ${refusal.path} to ${refusal.from}, which fetched submodule main ${refusal.to} does not contain.`,
        `git -C ${join(root, refusal.path)} merge-base --is-ancestor ${refusal.from} ${refusal.to}`,
        `Rebase ${refusal.path} onto its configured submodule branch, then rerun the same git super merge command.`,
        "the submodule writer",
        { paths: [refusal.path], objectIds: [refusal.from, refusal.to] },
      ),
    )
  }
  const visiblePlans = plans.map(({ changedByMerge: _changedByMerge, ...plan }) => plan)

  const requestedMessage = options.message ?? `Merge ${target.slice(0, 12)} into ${head.slice(0, 12)}`
  const trailers = visiblePlans.map((plan) =>
    plan.state === "raised"
      ? `Settled: ${plan.path}@${plan.to}`
      : `Settled: ${plan.path}@${plan.from} ${plan.state} submodule-main@${plan.to}`,
  )
  try {
    const parsed = await run(git, root, ["interpret-trailers", "--parse"], timeoutMs, requestedMessage)
    if (parsed.code !== 0) throw operationError(root, "parse-merge-trailers", ["interpret-trailers", "--parse"], parsed)
    if (
      parsed.stdout
        .split(/\r?\n/u)
        .some((line) => line.toLowerCase().startsWith(`${PUSH_INTENT_TRAILER.toLowerCase()}:`))
    ) {
      throw new Error(
        `${PUSH_INTENT_TRAILER} is produced from the selected merge tree; remove the caller-supplied trailer`,
      )
    }
    const frozen = await capturePushIntent(
      git,
      root,
      head,
      prospective.tree,
      new Map(visiblePlans.filter((plan) => plan.state === "raised").map((plan) => [plan.path, plan.to])),
      timeoutMs,
      planned.stores,
    )
    if (frozen !== undefined) trailers.push(`${PUSH_INTENT_TRAILER}: ${frozen}`)
  } catch (error) {
    return failed(root, [], resultError(error, "freeze-merge-push"))
  }
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

  const prepared = await prepareSubmoduleCheckouts(git, root, planned.checkouts, timeoutMs)
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
  const completed: SuperMergeGitlinkResult[] = visiblePlans
    .filter((plan) => plan.state !== "raised")
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
        preparedRows,
      )
    }
    completed.push({ ...raise })
  }

  const settledCheckouts = await settleSubmoduleCheckouts(git, root, preparedCheckouts, timeoutMs)
  if (settledCheckouts.failure !== undefined) {
    const restored = await restoreSubmoduleCheckouts(git, root, preparedCheckouts, settledCheckouts.rows, timeoutMs)
    const failure = restored.failure
    const evidence = formatCheckoutEvidence(restored.rows)
    return partial(
      root,
      undefined,
      completed,
      failure === undefined
        ? resultDetailFromGit(
            "submodule-checkout-failed",
            "settle-submodule-checkout",
            join(root, settledCheckouts.failure.plan.path),
            settledCheckouts.failure.args,
            settledCheckouts.failure.result,
            `The prospective merge remains uncommitted because ${settledCheckouts.failure.plan.path} could not be checked out at staged index pin ${settledCheckouts.failure.plan.index}; every affected submodule checkout was restored to its recorded pin.`,
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
            "submodule checkout preparation",
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
          `Git reported that the settled merge commit failed, and HEAD could not be read, so submodule checkouts were not rolled back.`,
          formatCheckoutEvidence(settledCheckouts.rows),
          "Preserve the root and submodule checkouts until the commit outcome is known.",
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
          `Git reported that the settled merge commit failed, but HEAD moved from ${head} to ${observedCommit}; submodule checkouts remain at the staged pins.`,
          formatCheckoutEvidence(settledCheckouts.rows),
          "Preserve the observed commit and inspect the named Git failure before any retry.",
          "the caller",
          { objectIds: [head, observedCommit] },
        ),
        settledCheckouts.rows,
      )
    }

    const restored = await restoreSubmoduleCheckouts(git, root, preparedCheckouts, settledCheckouts.rows, timeoutMs)
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
            `The prospective merge of ${target} and its Settled report remain staged, the concluding commit was not written, and every submodule checkout was restored to its recorded pin.`,
            evidence,
            "Inspect the preserved root merge and named Git failure; move each submodule to its staged index pin before retrying the commit.",
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
  try {
    await writeRootReceipt(git, root, mergeCommit, head, target, raises, timeoutMs)
  } catch (error) {
    return partial(
      root,
      mergeCommit,
      completed,
      obviousDetail(
        "root-receipt-failed",
        `Merge ${mergeCommit} was committed, but its automatic-change receipt could not be published.`,
        resultError(error, "write-root-receipt").message,
        `Preserve merge ${mergeCommit} and inspect refs/git-super/receipts/${mergeCommit} before retrying receipt publication.`,
        "the caller",
        { phase: "write-root-receipt", objectIds: [mergeCommit] },
      ),
      settledCheckouts.rows,
    )
  }

  return {
    state: "updated",
    partial: false,
    commit: mergeCommit,
    gitlinks: completed,
    ...(settledCheckouts.rows.length === 0 ? {} : { checkouts: settledCheckouts.rows }),
    repositories: [{ repository: root, state: "updated", refs: [] }],
  }
}

/** Bind only the producer's actual automatic raises to the completed native merge. */
async function writeRootReceipt(
  git: GitProcess,
  root: string,
  merge: string,
  head: string,
  target: string,
  raises: readonly SuperMergeGitlinkResult[],
  timeoutMs: number,
): Promise<void> {
  if (raises.length === 0) return
  const phase = "write-root-receipt"
  if (!OBJECT_ID.test(merge) || merge.length !== head.length) throw new Error("Receipt merge has an invalid full OID")
  const parents = await required(git, root, ["show", "-s", "--format=%P", merge], phase, timeoutMs)
  if (parents !== `${head} ${target}`) throw new Error(`Receipt merge ${merge} does not retain its exact two parents`)
  const actual = new Map(
    (await readCommitSubmodules({ run: (request) => git.run({ ...request, timeoutMs }) }, root, merge)).map((entry) => [
      entry.path,
      entry.target,
    ]),
  )
  const paths = new Set<string>()
  const changes = raises.map(({ path, from, to, state }) => {
    if (
      state !== "raised" ||
      paths.has(path) ||
      !OBJECT_ID.test(from) ||
      from.length !== merge.length ||
      !OBJECT_ID.test(to) ||
      to.length !== merge.length ||
      from === to ||
      actual.get(path) !== to
    ) {
      throw new Error(`Receipt row ${path} does not match an actual automatic gitlink raise in ${merge}`)
    }
    paths.add(path)
    return { path, mode: "160000", from, to }
  })
  const payload = `${JSON.stringify({ version: 1, merge, changes })}\n`
  const blob = await required(git, root, ["hash-object", "-w", "--stdin"], phase, timeoutMs, payload)
  const tree = await required(git, root, ["mktree", "-z"], phase, timeoutMs, `100644 blob ${blob}\treceipt.json\0`)
  const ref = `refs/git-super/receipts/${merge}`
  const readExisting = async (): Promise<string | undefined> => {
    const args = ["rev-parse", "--verify", "--quiet", ref]
    const result = await run(git, root, args, timeoutMs)
    if (
      result.code === 1 &&
      !result.timedOut &&
      result.failure === undefined &&
      result.stdout === "" &&
      result.stderr === ""
    ) {
      return undefined
    }
    if (result.code !== 0 || result.timedOut || result.failure !== undefined) {
      throw operationError(root, phase, args, result)
    }
    const existing = result.stdout.trim()
    if (
      !OBJECT_ID.test(existing) ||
      existing.length !== merge.length ||
      (await required(git, root, ["cat-file", "-t", existing], phase, timeoutMs)) !== "commit"
    ) {
      throw new Error(`Existing receipt ref ${ref} does not name a commit`)
    }
    // Equal tree OIDs prove the exact sole file and JSON bytes without parsing a second format.
    const binding = await required(git, root, ["show", "-s", "--format=%P%n%T", existing], phase, timeoutMs)
    if (binding !== `${merge}\n${tree}`) {
      throw new Error(`Existing receipt ${existing} at ${ref} conflicts with the validated payload for ${merge}`)
    }
    return existing
  }
  if ((await readExisting()) !== undefined) return
  const receipt = await required(
    git,
    root,
    ["commit-tree", tree, "-p", merge],
    phase,
    timeoutMs,
    `Automatic root changes for ${merge}\n`,
  )
  const args = ["update-ref", ref, receipt, "0".repeat(merge.length)]
  const published = await run(git, root, args, timeoutMs)
  if (published.code === 0 && !published.timedOut && published.failure === undefined) return
  // A competing identical producer may have won the create-only CAS.
  if ((await readExisting()) !== undefined) return
  throw operationError(root, phase, args, published)
}

async function prepareSubmoduleCheckouts(
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
    const submodule = join(root, plan.path)
    const args = ["rev-parse", "HEAD^{commit}"]
    const observed = await run(git, submodule, args, timeoutMs)
    if (observed.code !== 0) {
      return {
        failure: resultDetailFromGit(
          "submodule-checkout-unreadable",
          "prepare-submodule-checkout",
          submodule,
          args,
          observed,
          `The pre-merge checkout pin for ${plan.path} could not be read, so no merge was started.`,
          `git -C ${submodule} rev-parse HEAD^{commit}`,
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
          "submodule-checkout-drift",
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
    const submodule = join(root, plan.path)
    const args = ["status", "--porcelain=v1", "-z", "--untracked-files=all"]
    const submoduleStatus = await run(git, submodule, args, timeoutMs)
    if (submoduleStatus.code !== 0) {
      return resultDetailFromGit("git-failed", "verify-clean", submodule, args, submoduleStatus)
    }
    const submoduleRecords = nulRecords(submoduleStatus.stdout)
    if (submoduleRecords.length > 0) {
      return dirtyWorktreeDetail(
        root,
        commit,
        submoduleRecords.map((record) => `${plan.path}: ${record}`),
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

async function settleSubmoduleCheckouts(
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
    const submodule = join(root, plan.path)
    const args = ["checkout", "--detach", plan.index]
    const checkedOut = await run(git, submodule, args, timeoutMs)
    if (checkedOut.code !== 0) {
      rows[index] = { ...plan, checkout: plan.preCheckout, state: "settle-failed" }
      return { rows, failure: { plan, args, result: checkedOut } }
    }
    const observeArgs = ["rev-parse", "HEAD^{commit}"]
    const observed = await run(git, submodule, observeArgs, timeoutMs)
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

async function restoreSubmoduleCheckouts(
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
    const submodule = join(root, plan.path)
    const args = ["checkout", "--detach", plan.recorded]
    const restored = await run(git, submodule, args, timeoutMs)
    const observed = await run(git, submodule, ["rev-parse", "HEAD^{commit}"], timeoutMs)
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
  if (rows.length === 0) return "submodule-checkouts: none"
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
    "submodule-checkout-rollback-failed",
    "restore-submodule-checkout",
    join(root, path),
    rollbackFailure.args,
    rollbackFailure.result,
    `The root merge remains preserved after ${causeText}, but ${path} could not be restored exactly to recorded pin ${rollbackFailure.plan.recorded}.`,
    formatCheckoutEvidence(rows),
    "Do not retry the commit; preserve the root and submodules, restore every restore-failed row to its recorded pin, then prove recorded, index, and checkout pins again.",
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
  const args = ["-c", "core.commitGraph=false", "merge-tree", "--write-tree", "-z", "--no-messages", head, target]
  const result = await run(git, root, args, timeoutMs)
  const [tree, ...records] = nulRecords(result.stdout)
  if (result.code === 0 && tree !== undefined && OBJECT_ID.test(tree)) return { tree }
  const unreadable = /(?:^|\n)error: Could not read ([0-9a-f]{40,64})(?:\r?$|\s)/imu.exec(result.stderr)?.[1]
  if (unreadable !== undefined) {
    return {
      failure: resultDetailFromGit(
        "submodule-history-unreadable",
        "preflight-merge",
        root,
        args,
        result,
        `The prospective merge of ${target} into ${head} could not read submodule history object ${unreadable}; no commit was written.`,
        `git -C ${root} ${args.join(" ")}`,
        "Repair the named object or its commit graph, then rerun the same git super merge command.",
        "the caller",
        { objectIds: [head, target, unreadable] },
      ),
    }
  }
  if (result.code === 1) {
    let entries: IndexEntry[]
    try {
      entries = parseIndexEntries(
        records.join("\0"),
        (record) => new Error(`${root}: git merge-tree returned a malformed stage record ${JSON.stringify(record)}.`),
      )
      const stageZero = entries.find((entry) => entry.stage === 0)
      if (stageZero !== undefined) {
        throw new Error(
          `${root}: git merge-tree returned stage zero for conflicted path ${JSON.stringify(stageZero.path)}.`,
        )
      }
    } catch (error) {
      return {
        failure: resultDetailFromGit(
          "merge-preflight-failed",
          "preflight-merge",
          root,
          args,
          result,
          `${error instanceof Error ? error.message : String(error)} No commit was written.`,
          undefined,
          "Inspect the named merge-tree output before retrying the same git super merge command.",
          undefined,
          { objectIds: [head, target] },
        ),
      }
    }
    const paths = [...new Set(entries.map((entry) => entry.path))]
    const gitlinks = entries.filter((entry) => entry.mode === "160000")
    const stagesByPath = new Map<string, string[]>()
    for (const entry of gitlinks) {
      const labels = stagesByPath.get(entry.path) ?? []
      const label = entry.stage === 1 ? "base" : entry.stage === 2 ? "ours" : "theirs"
      labels.push(`${label}=${entry.oid}`)
      stagesByPath.set(entry.path, labels)
    }
    const stageEvidence = [...stagesByPath]
      .map(([path, stages]) => `${JSON.stringify(path)}: ${stages.join(" ")}`)
      .join("; ")
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
        `Merge ${target} conflicts with current HEAD ${head}${location}; no commit was written.${stageEvidence ? ` ${stageEvidence}` : ""}`,
        `git -C ${root} ${args.join(" ")}`,
        "Resolve the named conflict on the submitted branch, then rerun the same git super merge command.",
        "the caller",
        { paths, objectIds: [...new Set([head, target, ...gitlinks.map((entry) => entry.oid)])] },
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
  timeoutMs: number,
): Promise<GitlinkPlans> {
  const plans: GitlinkPlan[] = []
  const checkouts = new Map<string, GitlinkCheckoutPlan>()
  const stores = new Map<string, string>()
  const visiting = new Set<string>()
  const completed = new Set<string>()

  const rootMerged = await readCommitSubmodules(git, root, tree)
  if (rootMerged.length === 0) return { settlements: plans, checkouts: [], stores }
  const rootRemote = await rootPushIdentity(git, root)
  const rootBefore = new Map((await readCommitSubmodules(git, root, head)).map((entry) => [entry.path, entry.target]))
  const added = new Set(rootMerged.filter((entry) => !rootBefore.has(entry.path)).map((entry) => entry.path))
  if (added.size > 0) {
    const prepared = await prepareSubmoduleTreeUnderLock({ repo: root, commit: tree, remote: rootRemote, git }, added)
    if (prepared.state === "failed" || prepared.state === "unknown") {
      const message = prepared.detail?.message ?? `Cannot prepare submodules added by tree ${tree} in ${root}`
      throw Object.assign(new Error(message), { resultDetail: prepared.detail })
    }
    for (const submodule of prepared.submodules) {
      await ensureCommitObject({
        repository: submodule.gitdir,
        remote: submodule.url,
        commit: submodule.gitlink,
        timeoutMs,
        git,
      })
      stores.set(submodule.path, submodule.gitdir)
    }
  }

  /**
   * REFUSE A NESTED PIN THAT MOVES BACKWARDS relative to what its parent's main
   * already records for it (@cto 2026-09-11, 24454 row 4).
   *
   * At depth 0 this cannot happen: a root gitlink behind its main is RAISED to
   * main, so the recorded pin is main itself. At depth 1 and below nothing
   * raises, and a stale nested checkout committed by accident is exactly how a
   * pin goes backwards. The invariant is about the parent COMMIT being
   * published, not about which rung the pin landed on, so this runs for every
   * nested entry of a published parent rather than only the Behind ones -- it
   * can refuse nothing that should pass, because equal passes and any
   * descendant passes.
   *
   * DIVERGED IS CHECKED FIRST AND WINS. A pin that is both off its own main and
   * lowered gets the Diverged refusal, because re-recording the gitlink cannot
   * cure a commit that is off its own main and the lowering remedy would send
   * the author to the wrong fix.
   */
  const refuseNestedLowering = async (
    submodule: string,
    path: string,
    entry: CommitSubmodule,
    parentPath: string,
    parentMainPins: ReadonlyMap<string, string>,
  ): Promise<void> => {
    const onParentMain = parentMainPins.get(entry.path)
    if (onParentMain === undefined || onParentMain === entry.target) return
    if (entry.url !== undefined) {
      // Best effort, and for the same reason as the candidate-pin fetch above:
      // a pin this repository cannot read is the SUBMITTER's problem, reported
      // by the command below, never an exception that stops the queue.
      try {
        await ensureCommitObject({ repository: submodule, remote: entry.url, commit: onParentMain, timeoutMs, git })
      } catch {
        // silent-fallback-allow: the next three lines re-ask the same question
        // against the same store and answer it LOUDLY either way — an
        // unexpected code throws `operationError`, and a lowered pin throws
        // with `nested-pin-lowered`, its own cure, and the submodule writer
        // named as owner. The fetch only makes a publishable pin readable; a
        // pin that is not publishable stays exactly as unreadable as it was,
        // and is reported by the check that has always reported it.
      }
    }
    const args = ["merge-base", "--is-ancestor", onParentMain, entry.target]
    const descends = await run(git, submodule, args, timeoutMs)
    if (descends.code === 0) return
    if (descends.code !== 1) throw operationError(submodule, "prove-nested-pin-not-lowered", args, descends)
    const subject =
      `Merge would publish ${parentPath}, recording ${path}@${entry.target}, which does not descend from ` +
      `${onParentMain} already recorded at ${path} by ${parentPath} main.`
    throw Object.assign(new Error(subject), {
      resultDetail: obviousDetail(
        "nested-pin-lowered",
        subject,
        `git -C ${submodule} ${args.join(" ")}`,
        `Re-record the ${path} gitlink in ${parentPath} at or after ${onParentMain}, then rerun the same git super merge command.`,
        "the submodule writer",
        { phase: "inspect-gitlinks", paths: [path], objectIds: [entry.target, onParentMain] },
      ),
    })
  }

  /**
   * ONE LEVEL of the gitlink chain, then the levels below it (24454 row 4).
   *
   * The Equal/Behind/Ahead/Diverged ladder is unchanged; what is new is that it
   * now runs at every depth instead of only the root's own gitlinks. A nested
   * pin -- km/apps/maddoc in production -- used to be neither classified nor
   * validated by a merge, so a landing could record a nested pin diverged from
   * its own main and say nothing about it.
   *
   * NESTED LEVELS ARE VALIDATE-ONLY. A nested pin lives inside its PARENT
   * component's commit, and rewriting that commit is not a root merge's
   * business. It is also mechanically impossible here, which is worth recording
   * because it is easy to talk yourself into: raises are applied with
   * `update-index --cacheinfo 160000,<to>,<path>` against the ROOT index, which
   * holds no entry for `packages/alpha/apps/maddoc`, so a nested raise returns
   * `not-run` and turns a healthy merge partial. Measured 2026-09-11.
   *
   * THE WALK DESCENDS ONLY INTO PARENTS THAT WILL BE PUBLISHED -- the Ahead
   * rung. An Equal or Behind parent lands a commit its own main already holds,
   * and that commit's nested pins were validated when IT landed; re-walking
   * them would re-litigate history. This is also what bounds the walk.
   *
   * The cycle guard and the memo mirror `collectCommitRequirements` in push.ts
   * rather than introducing a second walker; push has walked this chain for as
   * long as it has ordered publication leaf-first.
   */
  const walk = async (
    repository: string,
    prefix: string,
    beforeCommit: string | undefined,
    commit: string,
    parentMainPins: ReadonlyMap<string, string> | undefined,
  ): Promise<void> => {
    const key = `${repository}\0${commit}`
    if (completed.has(key)) return
    if (visiting.has(key)) {
      throw new Error(`recursive gitlink cycle at ${prefix === "" ? "." : prefix} ${commit}`)
    }
    visiting.add(key)
    const nested = prefix !== ""
    const before = new Map(
      beforeCommit === undefined
        ? []
        : (await readCommitSubmodules(git, repository, beforeCommit)).map(
            (entry) => [entry.path, entry.target] as const,
          ),
    )
    for (const entry of await readCommitSubmodules(git, repository, commit)) {
      const path = nested ? `${prefix}/${entry.path}` : entry.path
      const submodule = nested
        ? await discoverRepository(git, join(repository, entry.path), "discover-nested-submodule", true)
        : (stores.get(path) ?? join(repository, entry.path))
      const recordedBefore = before.get(entry.path)
      const recorded = recordedBefore ?? entry.target
      const changedByMerge = recordedBefore !== entry.target
      // A checkout plan is settled against the ROOT index and worktree, so only
      // the root's own gitlinks can have one -- for the same reason a nested
      // raise cannot be applied.
      const settleCheckout = (index: string): void => {
        if (nested || recordedBefore === undefined) return
        checkouts.set(path, { path, recorded, index })
      }
      if (entry.url === undefined) {
        throw new Error(
          `Gitlink ${path}@${entry.target} has no declared .gitmodules URL; declare its remote before merging.`,
        )
      }
      if (!sameHostedOwner(rootRemote, entry.url)) {
        if (changedByMerge) settleCheckout(entry.target)
        plans.push({ path, from: entry.target, to: entry.target, state: "as-written", changedByMerge })
        continue
      }
      // The superproject is the PARENT, not the root: `submodule.<name>.branch`
      // for a nested gitlink is declared in its parent component, not in km.
      const main = await fetchSubmoduleMain(git, repository, submodule, entry, timeoutMs)
      if (entry.target === main) {
        // EQUAL to its own main, and still checked for a lowering (@cto N1).
        // A nested pin equal to its own main can fail to descend from what the
        // parent's main records for it -- but only when that parent main
        // already pins an off-main child, which is the hand-push shape the
        // universal check exists for. Leaving the check out of this branch
        // would make it absent in precisely the case it was written for.
        //
        // It runs per RUNG rather than once above, because DIVERGED must be
        // decided first and suppress it: re-recording a gitlink cannot cure a
        // commit that is off its own main.
        if (nested && parentMainPins !== undefined) {
          await refuseNestedLowering(submodule, path, entry, prefix, parentMainPins)
        }
        if (changedByMerge) settleCheckout(entry.target)
        continue
      }
      // THE CANDIDATE PIN HAS TO BE HERE BEFORE ANYTHING COMPARES IT. Compose opens
      // the worktree at the TARGET sha and populates reference stores for TARGET
      // pins only, and the fetch above brings `+refs/heads/main` and nothing else.
      // So a CREATE-ONLY pin — a new commit in a submodule, which is every real fix
      // in one — is simply absent, and the containment check below dies with exit
      // 128 "Not a valid commit name" for a commit that IS published. `submit`
      // publishes it as `refs/git-super/pins/<sha>`; nothing on this path asked.
      //
      // The ADDED-submodule branch above has done this since it was written; only
      // the EXISTING one was missing it.
      // A FETCH THAT CANNOT SUCCEED IS A MISS, NOT AN ERROR, AND THE DIFFERENCE IS
      // WHO OWNS THE FAILURE. `ensureCommitObject` throws when the object cannot be
      // had; letting that throw escape re-owns a condition that was always the
      // SUBMITTER's. Before this fetch existed, an unfetchable candidate pin
      // surfaced as the `is-ancestor` exit 128 below and the queue failed the
      // change — its author fixes their pin and everyone else keeps merging. A
      // throw here instead STICKS the queue: one bad pin from one seat stops the
      // line for the whole fleet.
      //
      // So the fetch is best-effort by construction. It is here to make a pin that
      // IS publishable readable; a pin that is not stays exactly as unreadable as
      // it was, and the containment check below reports it the way it always did.
      // `tests/../gitlink.test.ts` in the yrd consumer is the acceptance, and it is
      // what caught this — git-super's own suite cannot see the ownership question
      // because ownership is decided one layer up.
      try {
        await ensureCommitObject({ repository: submodule, remote: entry.url, commit: entry.target, timeoutMs, git })
      } catch {
        // silent-fallback-allow: and ONLY here. The next line re-asks the same
        // question against the same store and answers it loudly either way, so
        // nothing is lost — the object is either readable now or it is reported
        // missing by the check that has always reported it. Throwing instead
        // STICKS the queue: one bad pin from one seat stops the line for the
        // whole fleet, which is why this fetch is best-effort by construction.
      }
      const ancestryArgs = ["merge-base", "--is-ancestor", entry.target, main]
      const ancestry = await run(git, submodule, ancestryArgs, timeoutMs)
      if (ancestry.code === 0) {
        // BEHIND its own main. At the root this is raised to main. Nested, it is
        // recorded as it stands -- a parent may legitimately pin an older child
        // -- and only checked for going backwards.
        if (!nested) {
          settleCheckout(main)
          plans.push({ path, from: entry.target, to: main, state: "raised", changedByMerge })
          continue
        }
        if (parentMainPins !== undefined) await refuseNestedLowering(submodule, path, entry, prefix, parentMainPins)
        plans.push({ path, from: entry.target, to: main, state: "kept-behind", changedByMerge })
        continue
      }
      if (ancestry.code === 1) {
        const reverseArgs = ["merge-base", "--is-ancestor", main, entry.target]
        const reverse = await run(git, submodule, reverseArgs, timeoutMs)
        if (reverse.code !== 0 && reverse.code !== 1) {
          throw operationError(submodule, "prove-gitlink-ahead", reverseArgs, reverse)
        }
        const state = reverse.code === 0 ? "kept-ahead" : "left-off-main"
        // DIVERGED IS DECIDED BEFORE LOWERING AND SUPPRESSES IT. The caller turns
        // a changed `left-off-main` into the D1 refusal.
        if (state === "kept-ahead" && nested && parentMainPins !== undefined) {
          await refuseNestedLowering(submodule, path, entry, prefix, parentMainPins)
        }
        if (changedByMerge) settleCheckout(entry.target)
        plans.push({ path, from: entry.target, to: main, state, changedByMerge })
        if (state === "kept-ahead") {
          const mainPins = new Map(
            (await readCommitSubmodules(git, submodule, main)).map((child) => [child.path, child.target] as const),
          )
          await walk(submodule, path, recordedBefore, entry.target, mainPins)
        }
        continue
      }
      throw operationError(submodule, "prove-gitlink-on-main", ancestryArgs, ancestry)
    }
    visiting.delete(key)
    completed.add(key)
  }

  await walk(root, "", head, tree, undefined)
  return { settlements: plans, checkouts: [...checkouts.values()], stores }
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

async function fetchSubmoduleMain(
  git: GitProcess,
  superproject: string,
  submodule: string,
  entry: CommitSubmodule,
  timeoutMs: number,
): Promise<string> {
  const branch = await resolveSubmoduleBranch(
    { run: (request) => git.run({ ...request, timeoutMs }) },
    superproject,
    submodule,
    entry,
    "origin",
  )
  const { path, target: pin } = entry
  const fetchArgs = ["fetch", "--no-tags", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]
  const fetched = await run(git, submodule, fetchArgs, timeoutMs)
  if (fetched.code !== 0) throw submoduleMainError(submodule, path, pin, fetchArgs, fetched)
  const resolveArgs = ["rev-parse", `refs/remotes/origin/${branch}^{commit}`]
  const resolved = await run(git, submodule, resolveArgs, timeoutMs)
  if (resolved.code !== 0) throw submoduleMainError(submodule, path, pin, resolveArgs, resolved)
  return resolved.stdout.trim()
}

function submoduleMainError(
  submodule: string,
  path: string,
  pin: string,
  args: readonly string[],
  result: GitProcessResult,
): Error & Readonly<{ resultDetail: GitResultDetail }> {
  return operationError(
    submodule,
    "read-submodule-main",
    args,
    result,
    obviousDetail(
      "submodule-main-unreadable",
      `Submodule main for ${path} could not be read while inspecting gitlink ${pin}.`,
      `git -C ${submodule} ${args.join(" ")}`,
      `Repair access to the configured submodule branch named in the Git command, then rerun the same git super merge command.`,
      "the submodule writer",
      { paths: [path], objectIds: [pin], phase: "read-submodule-main" },
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
  stdin?: string,
): Promise<string> {
  const result = await run(git, repository, args, timeoutMs, stdin)
  if (result.code !== 0 || result.timedOut || result.failure !== undefined) {
    throw operationError(repository, phase, args, result)
  }
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
