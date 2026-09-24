import { isAbsolute, join, resolve } from "node:path"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { batchCheck, type BatchCheckResult, type GitResult } from "gitomic"

import {
  changedGitlinks,
  readCommitGitlinks,
  readCommitSubmodules,
  resolveSubmoduleBranch,
  type CommitGitlink,
  type CommitSubmodule,
} from "./commit-graph.ts"
import { createExclusive, type Exclusive } from "./exclusive.ts"
import { mapInOrder } from "./map-in-order.ts"
import { ensureCommitObject } from "./objects.ts"
import {
  readFrozenPushIntent,
  readFrozenPushIntents,
  encodePushIntent,
  sameHostedOwner,
  sameHostedRepository,
  type FrozenPushIntent,
} from "./push-intent.ts"
import { createLocalGitProcess, type GitProcess, type GitProcessResult } from "./process.ts"
import { superSubmodulePrepare, type PreparedSubmodule } from "./submodule-prepare.ts"
import {
  gitSuperResult,
  type ExpectedDestination,
  type GitResultDetail,
  type GitResultState,
  type GitSuperRefResult,
  type GitSuperRepositoryResult,
  type GitSuperResult,
  type RefUpdate,
} from "./result.ts"

export type PushSignedMode = "false" | "if-asked" | "true"
export type PushRecurseMode = "check" | "no" | "on-demand" | "only"

export type SuperPushOptions = Readonly<{
  repo: string
  remote?: string
  refspecs?: readonly string[]
  recurseSubmodules: PushRecurseMode
  atomic?: boolean
  verify?: boolean
  pushOptions?: readonly string[]
  forceWithLease?: readonly string[]
  signed?: PushSignedMode
  timeoutMs?: number
  git?: GitProcess
  exclusive?: Exclusive
  /** Receives phase/count lines while a push plans and waits to write (25142). The CLI binds it to stderr. */
  report?: (message: string) => void
}>

export type PushRefUpdatesOptions = Readonly<{
  root: string
  updates: readonly RefUpdate[]
  atomic?: boolean
  verify?: boolean
  pushOptions?: readonly string[]
  receivePack?: string
  signed?: PushSignedMode
  timeoutMs?: number
  git?: GitProcess
  exclusive?: Exclusive
}>

export type RemoteCommitAvailabilityOptions = Readonly<{
  repository: string
  remote: string
  commit: string
  refPrefixes?: readonly string[]
  timeoutMs?: number
  git?: GitProcess
}>

type PlannedUpdate = Readonly<{
  repository: string
  remote: string
  source: string
  destination: string
  expectedDestination: ExpectedDestination
  explicitExpectation: boolean
  allowNonFastForward: boolean
}>

type PushGroup = Readonly<{
  repository: string
  remote: string
  updates: readonly PlannedUpdate[]
}>

type CommitRequirement = Readonly<{
  superproject: string
  entry: CommitSubmodule
  repository: string
  path: string
  target: string
}>

const DEFAULT_GIT_TIMEOUT_MS = 30_000
const PUSH_PROGRESS_INTERVAL_MS = 9_000
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u
/** Remote observations one push plan runs at once (25303: reads concurrent, writes stay ordered). */
const PLAN_READ_CONCURRENCY = 4
/** Absent advertised refs fetched per `git fetch`, bounding argv however many are absent. */
const ADVERTISED_FETCH_BATCH = 256

function createPushProgress(report?: (message: string) => void) {
  const startedAt = Date.now()
  let current = "select-root 0/1"
  let timer: ReturnType<typeof setInterval> | undefined
  let failure: unknown
  const cancel = (): void => {
    if (timer !== undefined) globalThis.clearInterval(timer)
    timer = undefined
  }
  const emit = (): void => {
    report?.(`git-super push: ${current} +${Date.now() - startedAt}ms\n`)
  }
  const check = (): void => {
    if (failure !== undefined) throw failure
  }
  return {
    phase(name: string): void {
      check()
      current = name
      emit()
      if (report !== undefined && timer === undefined) {
        timer = globalThis.setInterval(() => {
          try {
            emit()
          } catch (error) {
            failure = error
            cancel()
          }
        }, PUSH_PROGRESS_INTERVAL_MS)
        timer.unref?.()
      }
    },
    beforeWrite(): void {
      check()
      current = "write-remote 0/1"
      emit()
      cancel()
    },
    cancel,
  }
}

function detail(code: string, phase: string, message: string, extra: Partial<GitResultDetail> = {}): GitResultDetail {
  return { code, phase, message, ...extra }
}

function failedResult(repository: string, failure: GitResultDetail): GitSuperResult {
  return gitSuperResult([{ repository, state: "failed", detail: failure, refs: [] }], failure)
}

async function required(git: GitProcess, repository: string, args: readonly string[], phase: string): Promise<string> {
  const result = await git.run({ repo: repository, args })
  if (result.code !== 0) throw operationError(repository, args, phase, result)
  return result.stdout.trim()
}

/**
 * The repository AT a path, refusing to answer with a different one.
 *
 * `rev-parse --show-toplevel` answers from wherever Git's discovery walks UP
 * to. For a nested submodule directory that was never checked out, that is the
 * PARENT's toplevel -- so a caller asking for `km/apps/maddoc` is handed `km`,
 * and then fetches a main, compares an ancestry and classifies a pin in the
 * wrong repository, every step succeeding and every answer meaningless.
 *
 * Both gitlink walks -- push's requirement collector and merge's planner --
 * resolve nested stores through here, so the guard lives here once (@cto N2,
 * 24454 row 4). Pass `guard` where the path is the CLAIM -- a gitlink that must
 * be its own repository; leave it off where discovery upward is the intent, as
 * it is for the root and for a prepared store that deliberately lives
 * elsewhere.
 */
export async function discoverRepository(git: GitProcess, path: string, phase: string, guard = false): Promise<string> {
  const topLevelArgs = ["rev-parse", "--show-toplevel"]
  const topLevel = await git.run({ repo: path, args: topLevelArgs })
  if (topLevel.code === 0 && topLevel.stdout.trim() !== "") {
    const discovered = resolve(topLevel.stdout.trim())
    if (guard) {
      // ASK GIT, DO NOT COMPARE PATHS. `--show-prefix` is the path from the
      // discovered repository's root down to the directory git was run in, so
      // "" means this directory IS that root and anything else means discovery
      // walked up out of it. Comparing `--show-toplevel` against the caller's
      // string instead compares a PHYSICAL path with a LEXICAL one, and any
      // symlink anywhere above either would make them differ while naming the
      // same directory (@cto, 24454 row 4; no path under /hh or /tmp is a
      // symlink today, so that mismatch cannot fire yet -- which is exactly
      // when to remove the way it could).
      const prefixArgs = ["rev-parse", "--show-prefix"]
      const prefix = await git.run({ repo: path, args: prefixArgs })
      if (prefix.code !== 0) throw operationError(path, prefixArgs, phase, prefix)
      if (prefix.stdout.trim() !== "") {
        // NOTE the distinction this rests on: an EMPTY working tree that still
        // carries its own `.git` is that gitlink's repository and passes here.
        // The queue's own clone holds `km/apps/maddoc` in exactly that shape.
        // Only a path with NO repository at all makes discovery answer with the
        // parent, and that is the condition worth refusing.
        //
        // The code is IN the message, as the merge planner's refusals put it
        // there: this reaches a reader through the CLI as text, and a reader who
        // cannot see the code cannot look the condition up.
        const message =
          `gitlink-store-absent: gitlink ${path} has no repository of its own; Git discovery answered with ` +
          `${discovered}, a different repository, so nothing read there would be about ${path}. ` +
          `next: initialize that submodule checkout, then rerun the same command; owner: the caller`
        throw Object.assign(new Error(message), {
          resultDetail: detail("gitlink-store-absent", phase, message, {
            paths: [path],
            remedy: `Initialize the submodule checkout at ${path}, then rerun the same command.`,
          }),
        })
      }
    }
    return discovered
  }
  const bare = await git.run({ repo: path, args: ["rev-parse", "--is-bare-repository"] })
  if (bare.code === 0 && bare.stdout.trim() === "true") {
    return resolve(await required(git, path, ["rev-parse", "--absolute-git-dir"], phase))
  }
  const inside = await git.run({ repo: path, args: ["rev-parse", "--is-inside-git-dir"] })
  if (inside.code === 0 && inside.stdout.trim() === "true") {
    return resolve(await required(git, path, ["rev-parse", "--absolute-git-dir"], phase))
  }
  throw operationError(path, topLevelArgs, phase, topLevel)
}

function operationError(
  repository: string,
  args: readonly string[],
  phase: string,
  result: GitProcessResult,
): Error & Readonly<{ resultDetail: GitResultDetail }> {
  const timedOut = result.timedOut === true
  const message = timedOut
    ? `git ${args.join(" ")} timed out in ${repository}`
    : `git ${args.join(" ")} failed in ${repository} (exit ${result.code})${result.stderr ? `\n${result.stderr}` : ""}`
  return Object.assign(new Error(message), {
    resultDetail: detail(timedOut ? "git-timeout" : "git-failed", phase, message, {
      remedy: "Resolve the named Git transport or repository condition, then rerun the same push.",
    }),
  })
}

function resultError(error: unknown, phase: string): GitResultDetail {
  if (typeof error === "object" && error !== null && "resultDetail" in error) {
    return (error as { resultDetail: GitResultDetail }).resultDetail
  }
  if (error instanceof Error && error.message.includes("worktree mutation lock is busy")) {
    return detail("mutation-lock-busy", "acquire-mutation-lock", error.message, {
      remedy: "Wait for the named lock holder to finish, then rerun git super push.",
    })
  }
  return detail("unexpected-error", phase, error instanceof Error ? error.message : String(error), {
    remedy: "Inspect the named phase and retry only after its underlying condition is understood.",
  })
}

function expectedKey(expected: ExpectedDestination): string {
  return expected.state === "missing" ? "missing" : `oid:${expected.oid}`
}

function sameExpected(left: ExpectedDestination, right: ExpectedDestination): boolean {
  return expectedKey(left) === expectedKey(right)
}

function isIdenticalSuccess(source: string, observed: ExpectedDestination): boolean {
  return source === "" ? observed.state === "missing" : observed.state === "oid" && observed.oid === source
}

async function observeDestination(
  git: GitProcess,
  update: Pick<PlannedUpdate, "repository" | "remote" | "destination">,
  phase: string,
): Promise<ExpectedDestination> {
  const output = await required(
    git,
    update.repository,
    ["ls-remote", "--refs", update.remote, update.destination],
    phase,
  )
  if (output === "") return { state: "missing" }
  const rows = output.split(/\r?\n/u).filter((row) => row !== "")
  const objectIds = rows.flatMap((row) => {
    const [oid, destination] = row.split(/\s+/u, 2)
    return destination === update.destination && oid !== undefined && OBJECT_ID.test(oid) ? [oid] : []
  })
  if (rows.length !== 1 || objectIds.length !== 1 || objectIds[0] === undefined) {
    throw Object.assign(new Error(`remote destination ${update.destination} did not resolve unambiguously`), {
      resultDetail: detail(
        "ambiguous-remote-destination",
        phase,
        `Remote ${update.remote} destination ${update.destination} did not resolve to zero or one object.`,
        {
          objectIds,
          remedy: "Use one exact destination ref and inspect the remote advertisement before retrying.",
        },
      ),
    })
  }
  return { state: "oid", oid: objectIds[0] }
}

function mismatchDetail(update: PlannedUpdate, observed: ExpectedDestination, phase: string): GitResultDetail {
  return detail(
    "destination-changed",
    phase,
    `Remote ${update.remote} destination ${update.destination} changed from ${expectedKey(update.expectedDestination)} to ${expectedKey(observed)}.`,
    {
      objectIds: [
        ...(update.expectedDestination.state === "oid" ? [update.expectedDestination.oid] : []),
        ...(observed.state === "oid" ? [observed.oid] : []),
      ],
      remedy: "Replan against the current remote ref; implicit or stale tracking-ref leases are never used.",
    },
  )
}

async function planUpdates(git: GitProcess, input: readonly RefUpdate[], timeoutMs: number): Promise<PlannedUpdate[]> {
  if (input.length === 0) {
    throw Object.assign(new Error("git super push requires at least one ref update"), {
      resultDetail: detail("empty-push", "validate", "No ref updates were selected.", {
        remedy: "Supply an explicit source:destination refspec or explicit library RefUpdate.",
      }),
    })
  }
  const normalized: PlannedUpdate[] = []
  const mismatches = new Map<PlannedUpdate, GitResultDetail>()
  // Each update's validation and observation are reads, so they run up to
  // PLAN_READ_CONCURRENCY at a time; the results are assembled, and the first
  // failure raised, in input order, exactly as the sequential loop did (25303).
  // Argument checks refuse before any process runs, as the sequential loop did.
  for (const update of input) {
    if (update.source === "" && update.expectedDestination === undefined) {
      throw Object.assign(new Error(`Deleting ${update.destination} requires an exact destination lease`), {
        resultDetail: detail(
          "missing-delete-lease",
          "validate",
          `Deletion of ${update.destination} has no explicit expected destination.`,
          {
            remedy: "Supply --force-with-lease=<ref>:<expected-old-oid> or an explicit RefUpdate.expectedDestination.",
          },
        ),
      })
    }
    if (update.source !== "" && !OBJECT_ID.test(update.source)) {
      throw Object.assign(new Error(`push source must be an exact object ID: ${update.source}`), {
        resultDetail: detail(
          "non-object-source",
          "validate",
          `Push source ${update.source} is not an exact object ID.`,
          {
            remedy: "Resolve symbolic sources during planning and pass the frozen object ID.",
          },
        ),
      })
    }
    if (update.remote.trim() === "") {
      throw Object.assign(new Error("push remote must not be empty"), {
        resultDetail: detail("empty-remote", "validate", "Push remote must not be empty."),
      })
    }
  }
  const planOne = async (update: RefUpdate): Promise<{ planned: PlannedUpdate; mismatch?: GitResultDetail }> => {
    const repository = await discoverRepository(git, update.repository, "discover-repository")
    if (update.source !== "") {
      await required(git, repository, ["cat-file", "-e", `${update.source}^{object}`], "verify-source-object")
    }
    const validDestination = await git.run({ repo: repository, args: ["check-ref-format", update.destination] })
    if (validDestination.code !== 0) {
      throw Object.assign(new Error(`invalid push destination ${update.destination}`), {
        resultDetail: detail("invalid-destination", "validate", `Push destination ${update.destination} is invalid.`, {
          remedy: "Use one full ref name such as refs/heads/main.",
        }),
      })
    }
    const observed = await observeDestination(
      git,
      { repository, remote: update.remote, destination: update.destination },
      "observe-destination",
    )
    const branchDestination = update.destination.startsWith("refs/heads/")
    if (branchDestination && update.source !== "") {
      await required(git, repository, ["cat-file", "-e", `${update.source}^{commit}`], "verify-branch-source")
      if (observed.state === "oid" && update.allowNonFastForward !== true) {
        await ensureCommitObject({
          repository,
          remote: update.remote,
          commit: observed.oid,
          timeoutMs,
          git,
        })
      }
    }
    const identicalRetry = isIdenticalSuccess(update.source, observed)
    const planned = {
      repository,
      remote: update.remote,
      source: update.source,
      destination: update.destination,
      expectedDestination: identicalRetry ? observed : (update.expectedDestination ?? observed),
      explicitExpectation: update.expectedDestination !== undefined,
      allowNonFastForward: update.allowNonFastForward === true,
    }
    if (
      update.expectedDestination !== undefined &&
      !sameExpected(update.expectedDestination, observed) &&
      !identicalRetry
    ) {
      return { planned, mismatch: mismatchDetail(planned, observed, "observe-destination") }
    }
    return { planned }
  }
  for (const { planned, mismatch } of await mapInOrder(input, PLAN_READ_CONCURRENCY, planOne)) {
    normalized.push(planned)
    if (mismatch !== undefined) mismatches.set(planned, mismatch)
  }

  const byDestination = new Map<string, PlannedUpdate>()
  for (const update of normalized) {
    const key = `${update.repository}\0${update.remote}\0${update.destination}`
    const prior = byDestination.get(key)
    if (prior === undefined) {
      byDestination.set(key, update)
      continue
    }
    if (
      prior.source === update.source &&
      sameExpected(prior.expectedDestination, update.expectedDestination) &&
      prior.allowNonFastForward === update.allowNonFastForward
    ) {
      continue
    }
    throw Object.assign(new Error(`conflicting updates select ${update.remote} ${update.destination}`), {
      resultDetail: detail(
        "conflicting-destination-updates",
        "normalize-updates",
        `Two updates select ${update.remote} ${update.destination} with different sources or expectations.`,
        {
          objectIds: [prior.source, update.source],
          remedy: "Submit one unambiguous source and expected old value for each remote destination ref.",
        },
      ),
    })
  }
  const planned = [...byDestination.values()]
  if (mismatches.size > 0) {
    const failure = mismatches.values().next().value
    if (failure === undefined) throw new Error("preflight mismatch lost its failure detail")
    throw Object.assign(new Error("remote destination does not match its explicit expectation"), {
      resultDetail: failure,
      plannedUpdates: planned,
      preflightMismatches: mismatches,
    })
  }
  return planned
}

function groupUpdates(updates: readonly PlannedUpdate[], root: string): PushGroup[] {
  const groups = new Map<string, { repository: string; remote: string; updates: PlannedUpdate[] }>()
  for (const update of updates) {
    const key = `${update.repository}\0${update.remote}`
    const group = groups.get(key) ?? { repository: update.repository, remote: update.remote, updates: [] }
    group.updates.push(update)
    groups.set(key, group)
  }
  const ordered = [...groups.values()]
  return [
    ...ordered.filter((group) => group.repository !== root),
    ...ordered.filter((group) => group.repository === root),
  ]
}

async function lockDirectory(git: GitProcess, root: string): Promise<string> {
  const common = await required(git, root, ["rev-parse", "--git-common-dir"], "locate-mutation-lock")
  return join(isAbsolute(common) ? common : resolve(root, common), "yrd-worktree-mutations")
}

function lease(update: PlannedUpdate): string {
  const expected = update.expectedDestination.state === "missing" ? "" : update.expectedDestination.oid
  return `--force-with-lease=${update.destination}:${expected}`
}

function refResult(
  update: Pick<PlannedUpdate, "destination" | "source">,
  state: GitResultState,
  failure?: GitResultDetail,
): GitSuperRefResult {
  return {
    source: update.source,
    destination: update.destination,
    state,
    ...(failure === undefined ? {} : { detail: failure }),
  }
}

function notRunGroup(group: PushGroup, failure: GitResultDetail): GitSuperRepositoryResult {
  return {
    repository: group.repository,
    state: "not-run",
    detail: failure,
    refs: group.updates.map((update) => refResult(update, "not-run", failure)),
  }
}

function preflightFailureResult(
  root: string,
  updates: readonly PlannedUpdate[],
  mismatches: ReadonlyMap<PlannedUpdate, GitResultDetail>,
): GitSuperResult {
  const first = mismatches.values().next().value
  if (first === undefined) throw new Error("preflight failure result requires at least one mismatch")
  return gitSuperResult(
    groupUpdates(updates, root).map((group) => {
      const failure = group.updates.map((update) => mismatches.get(update)).find((detail) => detail !== undefined)
      if (failure === undefined) return notRunGroup(group, first)
      return {
        repository: group.repository,
        state: "failed",
        detail: failure,
        refs: group.updates.map((update) => {
          const mismatch = mismatches.get(update)
          return mismatch === undefined ? refResult(update, "not-run", first) : refResult(update, "failed", mismatch)
        }),
      }
    }),
    first,
  )
}

function repositoryState(refs: readonly GitSuperRefResult[]): GitResultState {
  const states = refs.map((ref) => ref.state)
  if (states.includes("failed")) return "failed"
  if (states.includes("unknown")) return "unknown"
  if (states.includes("not-run")) return "not-run"
  if (states.includes("updated")) return "updated"
  return "unchanged"
}

function pushFailureCode(result: GitProcessResult): string {
  if (result.timedOut === true) return "git-timeout"
  if (/does not support --atomic|atomic push is not supported/iu.test(result.stderr)) return "atomic-unsupported"
  if (
    /authentication failed|permission denied|could not read username|terminal prompts disabled/iu.test(result.stderr)
  ) {
    return "authentication-failed"
  }
  return "push-rejected"
}

async function verifyFastForwardUpdate(git: GitProcess, update: PlannedUpdate): Promise<GitResultDetail | undefined> {
  if (
    update.source === "" ||
    update.allowNonFastForward ||
    !update.destination.startsWith("refs/heads/") ||
    update.expectedDestination.state === "missing" ||
    update.expectedDestination.oid === update.source
  ) {
    return undefined
  }
  const ancestry = await git.run({
    repo: update.repository,
    args: ["merge-base", "--is-ancestor", update.expectedDestination.oid, update.source],
  })
  if (ancestry.code === 0) return undefined
  if (ancestry.code !== 1) {
    throw operationError(
      update.repository,
      ["merge-base", "--is-ancestor", update.expectedDestination.oid, update.source],
      "verify-fast-forward",
      ancestry,
    )
  }
  return detail(
    "non-fast-forward-refused",
    "verify-fast-forward",
    `Refusing to rewrite ${update.remote} ${update.destination} from ${update.expectedDestination.oid} to ${update.source}.`,
    {
      objectIds: [update.expectedDestination.oid, update.source],
      remedy: "Publish a descendant commit, or make the caller explicitly authorize a non-fast-forward update.",
    },
  )
}

async function applyGroup(
  git: GitProcess,
  group: PushGroup,
  options: Pick<PushRefUpdatesOptions, "atomic" | "pushOptions" | "receivePack" | "signed" | "verify">,
): Promise<GitSuperRepositoryResult> {
  const rechecked = await Promise.all(
    group.updates.map((update) => observeDestination(git, update, "recheck-destination")),
  )
  for (const [index, observed] of rechecked.entries()) {
    const update = group.updates[index]
    if (
      update !== undefined &&
      observed !== undefined &&
      !sameExpected(update.expectedDestination, observed) &&
      !isIdenticalSuccess(update.source, observed)
    ) {
      const failure = mismatchDetail(update, observed, "recheck-destination")
      return {
        repository: group.repository,
        state: "failed",
        detail: failure,
        refs: group.updates.map((entry) => refResult(entry, "failed", failure)),
      }
    }
  }

  for (const update of group.updates) {
    const failure = await verifyFastForwardUpdate(git, update)
    if (failure !== undefined) {
      return {
        repository: group.repository,
        state: "failed",
        detail: failure,
        refs: group.updates.map((entry) => refResult(entry, "failed", failure)),
      }
    }
  }

  const pending = group.updates.filter((update) => !isIdenticalSuccess(update.source, update.expectedDestination))
  if (pending.length === 0) {
    return {
      repository: group.repository,
      state: "unchanged",
      refs: group.updates.map((update) => refResult(update, "unchanged")),
    }
  }
  const args = [
    "push",
    "--porcelain",
    "--recurse-submodules=no",
    ...(options.atomic === true ? ["--atomic"] : []),
    ...(options.verify === false ? ["--no-verify"] : []),
    ...(options.signed === undefined ? [] : [`--signed=${options.signed}`]),
    ...(options.pushOptions ?? []).map((option) => `--push-option=${option}`),
    ...(options.receivePack === undefined ? [] : [`--receive-pack=${options.receivePack}`]),
    ...group.updates.filter((update) => update.explicitExpectation).map(lease),
    group.remote,
    ...group.updates.map((update) => `${update.source}:${update.destination}`),
  ]
  const pushed = await git.run({ repo: group.repository, args })
  const observations = await Promise.allSettled(
    group.updates.map((update) => observeDestination(git, update, "observe-push-result")),
  )
  const pushFailure =
    pushed.code === 0
      ? undefined
      : detail(
          pushFailureCode(pushed),
          "push-refs",
          pushed.timedOut === true
            ? `git push timed out in ${group.repository}`
            : `git push failed in ${group.repository} (exit ${pushed.code})${pushed.stderr ? `\n${pushed.stderr}` : ""}`,
          {
            remedy: "Inspect the exact repository/ref result and remote evidence before retrying.",
          },
        )
  const observationFailure = observations.find(
    (observation): observation is PromiseRejectedResult => observation.status === "rejected",
  )
  const groupFailure =
    observationFailure === undefined ? pushFailure : resultError(observationFailure.reason, "observe-push-result")
  const refs = group.updates.map((update, index) => {
    const observation = observations[index]
    if (observation === undefined || observation.status === "rejected") {
      const unknown =
        observation === undefined
          ? detail(
              "missing-push-observation",
              "observe-push-result",
              `No post-push observation was recorded for ${group.remote} ${update.destination}.`,
              { remedy: "Inspect the exact remote ref before retrying." },
            )
          : resultError(observation.reason, "observe-push-result")
      return refResult(update, "unknown", unknown)
    }
    const observed = observation.value
    if (isIdenticalSuccess(update.source, observed)) {
      const state = isIdenticalSuccess(update.source, update.expectedDestination) ? "unchanged" : "updated"
      return refResult(update, state)
    }
    if (pushFailure === undefined) {
      const unknown = detail(
        "push-observation-mismatch",
        "observe-push-result",
        `Git reported success but ${group.remote} ${update.destination} does not equal ${update.source}.`,
        { remedy: "Preserve the command output and inspect the remote before any retry." },
      )
      return refResult(update, "unknown", unknown)
    }
    return sameExpected(update.expectedDestination, observed)
      ? refResult(update, "failed", pushFailure)
      : refResult(update, "unknown", pushFailure)
  })
  return {
    repository: group.repository,
    state: repositoryState(refs),
    ...(groupFailure === undefined ? {} : { detail: groupFailure }),
    refs,
  }
}

/** Apply exact remote ref updates child-first and root-last using explicit leases. */
async function runPushRefUpdates(
  options: PushRefUpdatesOptions,
  phase?: (name: string) => void,
): Promise<GitSuperResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS
  let root = resolve(options.root)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    const failure = detail("invalid-timeout", "validate", "Git command timeout must be a positive finite number.")
    return failedResult(root, failure)
  }
  const process = options.git ?? createLocalGitProcess()
  const git: GitProcess = {
    run: (request) => process.run({ ...request, timeoutMs: request.timeoutMs ?? timeoutMs }),
  }
  try {
    root = await discoverRepository(git, root, "discover-root")
    phase?.(`plan-ref-updates 0/${options.updates.length}`)
    const groups = groupUpdates(await planUpdates(git, options.updates, timeoutMs), root)
    phase?.(`wait-writer-lock 0/${groups.length}`)
    const exclusive = options.exclusive ?? createExclusive(await lockDirectory(git, root))
    return await exclusive.run(
      async () => {
        const results: GitSuperRepositoryResult[] = []
        for (const [index, group] of groups.entries()) {
          phase?.(`recheck-ref-updates ${index}/${groups.length}`)
          const result = await applyGroup(git, group, options)
          results.push(result)
          if (result.state === "failed" || result.state === "unknown") {
            const failure =
              result.detail ?? detail("push-incomplete", "push-refs", `Push did not complete in ${group.repository}.`)
            results.push(...groups.slice(index + 1).map((remaining) => notRunGroup(remaining, failure)))
            return gitSuperResult(results, failure)
          }
        }
        return gitSuperResult(results)
      },
      { holder: "git super push" },
    )
  } catch (error) {
    if (typeof error === "object" && error !== null && "plannedUpdates" in error && "preflightMismatches" in error) {
      const preflight = error as {
        plannedUpdates: readonly PlannedUpdate[]
        preflightMismatches: ReadonlyMap<PlannedUpdate, GitResultDetail>
      }
      return preflightFailureResult(root, preflight.plannedUpdates, preflight.preflightMismatches)
    }
    const failure = resultError(error, "push")
    return failedResult(root, failure)
  }
}

export async function pushRefUpdates(options: PushRefUpdatesOptions): Promise<GitSuperResult> {
  return runPushRefUpdates(options)
}

function pushInputFailure(repository: string, code: string, message: string, remedy: string): GitSuperResult {
  const failure = detail(code, "validate", message, { remedy })
  return failedResult(resolve(repository), failure)
}

function normalizeDestination(destination: string): string {
  return destination.startsWith("refs/") ? destination : `refs/heads/${destination}`
}

async function refspecUpdate(git: GitProcess, root: string, remote: string, refspec: string): Promise<RefUpdate> {
  if (refspec.startsWith("+")) {
    throw Object.assign(new Error(`force refspec is outside the git super push subset: ${refspec}`), {
      resultDetail: detail("force-refspec-refused", "validate", `Force refspec ${refspec} is not accepted.`, {
        remedy: "Use an exact expected destination with an explicit lease instead of '+'.",
      }),
    })
  }
  const separator = refspec.indexOf(":")
  const sourceName = separator < 0 ? refspec : refspec.slice(0, separator)
  if (sourceName.includes("*")) {
    throw Object.assign(new Error(`pattern refspec is outside the git super push subset: ${refspec}`), {
      resultDetail: detail("pattern-refspec-refused", "validate", `Pattern refspec ${refspec} is not accepted.`, {
        remedy: "Resolve the pattern into exact source:destination rows before pushing.",
      }),
    })
  }
  const source =
    sourceName === "" ? "" : await required(git, root, ["rev-parse", `${sourceName}^{object}`], "resolve-push-source")
  let destination = separator < 0 ? "" : refspec.slice(separator + 1)
  if (destination === "" && sourceName !== "") {
    destination = await required(
      git,
      root,
      ["rev-parse", "--symbolic-full-name", sourceName],
      "resolve-push-destination",
    )
  }
  if (destination === "" || destination.includes("*")) {
    throw Object.assign(new Error(`push destination is not one exact ref: ${refspec}`), {
      resultDetail: detail("ambiguous-push-destination", "validate", `Refspec ${refspec} has no exact destination.`, {
        remedy: "Supply one exact source:destination refspec.",
      }),
    })
  }
  return { repository: root, remote, source, destination: normalizeDestination(destination) }
}

async function configuredPushRemote(git: GitProcess, root: string): Promise<string> {
  const branchArgs = ["symbolic-ref", "--quiet", "--short", "HEAD"]
  const branch = await git.run({ repo: root, args: branchArgs })
  if (branch.code !== 0 && !(branch.code === 1 && branch.stdout === "" && branch.stderr === "")) {
    throw operationError(root, branchArgs, "resolve-push-remote", branch)
  }
  const branchName = branch.stdout.trim()
  const keys = [
    ...(branchName === "" ? [] : [`branch.${branchName}.pushRemote`]),
    "remote.pushDefault",
    ...(branchName === "" ? [] : [`branch.${branchName}.remote`]),
  ]
  for (const key of keys) {
    const args = ["config", "--get", key]
    const configured = await git.run({ repo: root, args })
    if (configured.code === 0) return configured.stdout.trim()
    if (!(configured.code === 1 && configured.stdout === "" && configured.stderr === "")) {
      throw operationError(root, args, "resolve-push-remote", configured)
    }
  }
  const originArgs = ["remote", "get-url", "--push", "origin"]
  const origin = await git.run({ repo: root, args: originArgs })
  if (origin.code === 0) return "origin"
  if (origin.code !== 2) throw operationError(root, originArgs, "resolve-push-remote", origin)
  throw Object.assign(new Error("Git has no configured push remote"), {
    resultDetail: detail("missing-push-remote", "resolve-push-remote", "Git has no configured push remote.", {
      remedy: "Supply a remote explicitly or configure remote.pushDefault / branch.<name>.remote.",
    }),
  })
}

function nativePushOptions(options: Pick<SuperPushOptions, "atomic" | "pushOptions" | "signed" | "verify">): string[] {
  return [
    ...(options.atomic === true ? ["--atomic"] : []),
    ...(options.verify === false ? ["--no-verify"] : []),
    ...(options.signed === undefined ? [] : [`--signed=${options.signed}`]),
    ...(options.pushOptions ?? []).map((option) => `--push-option=${option}`),
  ]
}

async function configuredPushUpdates(
  git: GitProcess,
  root: string,
  remote: string,
  options: Pick<SuperPushOptions, "atomic" | "pushOptions" | "signed" | "verify">,
): Promise<RefUpdate[]> {
  // The preview resolves refspecs; only the actual push runs the caller's hook.
  const args = [
    "push",
    "--porcelain",
    "--dry-run",
    "--recurse-submodules=no",
    ...nativePushOptions({ ...options, verify: false }),
    remote,
  ]
  const planned = await git.run({ repo: root, args })
  if (planned.code !== 0) throw operationError(root, args, "resolve-default-refspecs", planned)
  const updates: RefUpdate[] = []
  for (const line of planned.stdout.split(/\r?\n/u)) {
    const fields = line.split("\t")
    if (fields.length < 2) continue
    const pair = fields[1]
    if (pair === undefined) continue
    const separator = pair.indexOf(":")
    if (separator < 1 || separator === pair.length - 1) continue
    const sourceName = pair.slice(0, separator)
    const destination = pair.slice(separator + 1)
    if (!sourceName.startsWith("refs/") || !destination.startsWith("refs/")) continue
    const source = await required(git, root, ["rev-parse", `${sourceName}^{object}`], "resolve-push-source")
    updates.push({ repository: root, remote, source, destination })
  }
  if (updates.length === 0) {
    throw Object.assign(new Error("Git's default push selected no exact ref updates"), {
      resultDetail: detail(
        "empty-default-push",
        "resolve-default-refspecs",
        "Git's configured default push selected no exact ref updates.",
        { remedy: "Supply one exact source:destination refspec or repair the branch push configuration." },
      ),
    })
  }
  return updates
}

function parseExplicitLeases(values: readonly string[]): Map<string, ExpectedDestination> {
  const leases = new Map<string, ExpectedDestination>()
  for (const value of values) {
    const separator = value.indexOf(":")
    if (separator < 1) {
      throw Object.assign(new Error(`implicit force-with-lease is not accepted: ${value}`), {
        resultDetail: detail(
          "implicit-lease-refused",
          "validate",
          `Lease ${value} does not name its exact expected old value.`,
          { remedy: "Use --force-with-lease=<full-ref>:<expected-oid>, or an empty expected value for create-only." },
        ),
      })
    }
    const destination = value.slice(0, separator)
    const expected = value.slice(separator + 1)
    if (!destination.startsWith("refs/") || (expected !== "" && !OBJECT_ID.test(expected))) {
      throw Object.assign(new Error(`invalid explicit lease ${value}`), {
        resultDetail: detail("invalid-explicit-lease", "validate", `Lease ${value} is invalid.`, {
          remedy: "Use one full destination ref and either an exact object ID or an empty create-only expectation.",
        }),
      })
    }
    const parsed: ExpectedDestination = expected === "" ? { state: "missing" } : { state: "oid", oid: expected }
    const prior = leases.get(destination)
    if (prior !== undefined && !sameExpected(prior, parsed)) {
      throw Object.assign(new Error(`conflicting explicit leases select ${destination}`), {
        resultDetail: detail(
          "conflicting-explicit-leases",
          "validate",
          `Two different expected values were supplied for ${destination}.`,
          { remedy: "Supply exactly one expected old value per destination ref." },
        ),
      })
    }
    leases.set(destination, parsed)
  }
  return leases
}

function applyExplicitLeases(updates: readonly RefUpdate[], values: readonly string[]): RefUpdate[] {
  const leases = parseExplicitLeases(values)
  const selected = new Set<string>()
  const leased = updates.map((update) => {
    const expectedDestination = leases.get(update.destination)
    if (expectedDestination === undefined) return update
    selected.add(update.destination)
    return { ...update, expectedDestination }
  })
  const unused = [...leases.keys()].filter((destination) => !selected.has(destination))
  if (unused.length > 0) {
    throw Object.assign(new Error(`explicit lease selects no pushed ref: ${unused.join(", ")}`), {
      resultDetail: detail(
        "lease-without-update",
        "validate",
        `Explicit lease selects no pushed destination: ${unused.join(", ")}.`,
        { remedy: "Remove the lease or add its exact source:destination refspec." },
      ),
    })
  }
  return leased
}

/** The configured logical URL is frozen before transport rewrites are applied by Git. */
async function logicalPushUrl(git: GitProcess, repository: string, remote: string): Promise<string> {
  if (remote.includes(":") || remote.startsWith("/") || remote.startsWith(".")) return remote
  for (const property of ["pushurl", "url"]) {
    const args = ["config", "--get-all", `remote.${remote}.${property}`]
    const result = await git.run({ repo: repository, args })
    if (result.code === 1 && result.failure === undefined && result.timedOut !== true) continue
    if (result.code !== 0 || result.failure !== undefined || result.timedOut === true) {
      throw operationError(repository, args, "resolve-frozen-remote", result)
    }
    const urls = result.stdout.trim().split(/\r?\n/u)
    if (urls.length !== 1 || urls[0] === undefined || urls[0] === "") {
      throw new Error(`Frozen push requires exactly one logical URL for ${remote} in ${repository}`)
    }
    return urls[0]
  }
  throw new Error(`Frozen push remote ${remote} has no declared URL in ${repository}`)
}

/** Freeze the existing recursive planner's inputs before the merge is committed or checked. */
export async function capturePushIntent(
  git: GitProcess,
  root: string,
  head: string,
  tree: string,
  rootPins: ReadonlyMap<string, string>,
  timeoutMs: number,
  rootStores?: ReadonlyMap<string, string>,
): Promise<string | undefined> {
  const requirements = await collectCommitRequirements(git, root, [tree], rootPins, undefined, rootStores)
  if (requirements.length === 0) return undefined
  const rootRemote = await logicalPushUrl(git, root, await configuredPushRemote(git, root))
  const changed = await changedRowPaths(
    git,
    await readCommitGitlinks(git, root, head),
    requirements
      .filter((requirement) => requirement.superproject === root)
      .map((requirement) => ({ path: requirement.path, target: requirement.target })),
    requirements,
  )
  const children: FrozenPushIntent["children"][number][] = []
  for (const requirement of requirements) {
    const declared = requirement.entry.url
    if (declared === undefined) {
      throw new Error(
        `Gitlink ${requirement.path}@${requirement.target} has no declared .gitmodules URL; declare its remote before freezing the push.`,
      )
    }
    const pin = { path: requirement.path, remote: declared, pin: requirement.target }
    // An external declaration can never be converted into write authority by local config.
    if (!sameHostedOwner(rootRemote, declared)) {
      children.push(pin)
      continue
    }
    const update = await childUpdate(git, requirement, timeoutMs, ["refs/heads/main"])
    const remote = await logicalPushUrl(git, requirement.repository, update.remote)
    if (!sameHostedOwner(rootRemote, remote)) {
      children.push({ ...pin, remote })
      continue
    }
    if (update.expectedDestination === undefined) throw new Error(`No observed destination for ${requirement.path}`)
    if (update.expectedDestination.state === "oid") {
      const args = ["merge-base", "--is-ancestor", update.expectedDestination.oid, update.source]
      const ancestry = await git.run({ repo: requirement.repository, args })
      if (ancestry.code === 1 && !changed.has(requirement.path)) {
        children.push({ ...pin, remote })
        continue
      }
      if (ancestry.code !== 0) throw operationError(requirement.repository, args, "freeze-child-fast-forward", ancestry)
    }
    children.push({
      ...pin,
      remote,
      publication: {
        destination: update.destination,
        source: update.source,
        expectedDestination: update.expectedDestination,
      },
    })
  }
  return encodePushIntent({ version: 1, rootRemote, children })
}

/** Read logical root identity before transport rewrites, using the ordinary push selection. */
export async function rootPushIdentity(git: GitProcess, root: string): Promise<string> {
  return logicalPushUrl(git, root, await configuredPushRemote(git, root))
}

async function frozenChildUpdates(
  git: GitProcess,
  root: string,
  remote: string,
  rootUpdates: readonly RefUpdate[],
): Promise<{
  updates: RefUpdate[] | undefined
  retention: RefUpdate[]
  publications: RefUpdate[]
}> {
  const updates: RefUpdate[] = []
  const retention: RefUpdate[] = []
  const publications: RefUpdate[] = []
  const direct = new Set(rootUpdates.map((update) => update.source).filter((source) => source !== ""))
  if (direct.size === 0) return { updates: undefined, retention, publications }
  const advertisement = await readAdvertisement(git, root, remote)
  const advertised = await advertisedTips(git, root, remote, advertisement)
  // WORK IS PROPORTIONAL TO THE CHANGE (25303). What the remote's root already
  // records at a destination this push moves was published by the push that
  // put it there, so only the gitlinks a merge moves past that are retained or
  // published. The frozen trailer stays the merge's snapshot, never the work
  // list: a merge moving one of 16 children did 15 no-op publications, and an
  // unchanged child's main moving elsewhere could stop the line for a change
  // that never touched it. A destination the remote lacks has no base, so
  // every gitlink counts as changed there.
  const destinations = new Set(rootUpdates.filter((update) => update.source !== "").map((update) => update.destination))
  const bases: CommitGitlink[][] = []
  for (const row of advertisement) {
    if (destinations.has(row.ref)) bases.push(await readCommitGitlinks(git, root, row.oid))
  }
  const reachable = await required(
    git,
    root,
    ["rev-list", "--min-parents=2", ...direct, "--not", ...advertised],
    "find-new-frozen-merges",
  )
  const sources = [...new Set([...direct, ...reachable.split(/\r?\n/u).filter(Boolean)])]
  const intents = await readFrozenPushIntents(git, root, sources)
  let found = false
  for (const source of sources) {
    const intent = intents.get(source)
    if (intent === undefined) continue
    const actualRemote = await logicalPushUrl(git, root, remote)
    if (!sameHostedRepository(intent.rootRemote, actualRemote)) {
      throw new Error(`Merge ${source} freezes root remote ${intent.rootRemote}, but this push selects ${actualRemote}`)
    }
    if (direct.has(source)) found = true
    const selected = await collectCommitRequirements(git, root, [source], undefined, intent)
    const moved = await readCommitGitlinks(git, root, source)
    // A row is unchanged when ANY base the remote holds already records it.
    let changed = new Set(selected.map((requirement) => requirement.path))
    for (const base of bases) {
      const against = await changedRowPaths(git, base, moved, selected)
      changed = new Set([...changed].filter((path) => against.has(path)))
    }
    for (const row of intent.children) {
      const requirement = selected.find((entry) => entry.path === row.path && entry.target === row.pin)
      if (requirement === undefined) {
        throw new Error(`Frozen child ${row.path}@${row.pin} is not selected by merge ${source}`)
      }
      if (!changed.has(row.path)) continue
      if (sameHostedOwner(intent.rootRemote, row.remote)) {
        for (const pin of new Set([row.pin, ...(row.publication === undefined ? [] : [row.publication.source])])) {
          retention.push({
            repository: requirement.repository,
            remote: row.remote,
            source: pin,
            destination: `refs/git-super/pins/${pin}`,
            expectedDestination: { state: "missing" },
          })
        }
      } else if (!direct.has(source)) {
        throw new Error(
          `Cannot retain merge ${source}: external child ${row.path}@${row.pin} has no authorized immutable source prerequisite; no external refs were written`,
        )
      }
      if (row.publication === undefined) continue
      const args = ["merge-base", "--is-ancestor", row.pin, row.publication.source]
      const contains = await git.run({ repo: requirement.repository, args })
      if (contains.code !== 0) throw operationError(requirement.repository, args, "bind-frozen-publication", contains)
      const update = { repository: requirement.repository, remote: row.remote, ...row.publication }
      publications.push(update)
      if (direct.has(source)) updates.push(update)
    }
    for (const requirement of selected) {
      if (!intent.children.some((row) => row.path === requirement.path && row.pin === requirement.target)) {
        throw new Error(`Frozen merge ${source} has no child disposition for ${requirement.path}@${requirement.target}`)
      }
    }
  }
  return { updates: found ? updates : undefined, retention, publications }
}

async function verifyRetainedSource(git: GitProcess, update: RefUpdate): Promise<void> {
  await required(
    git,
    update.repository,
    ["fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", update.remote, update.destination],
    "verify-retained-source-fetch",
  )
  const observed = await observeDestination(git, update, "verify-retained-source-ref")
  if (!isIdenticalSuccess(update.source, observed)) {
    throw new Error(`Retained source ${update.remote} ${update.destination} no longer names ${update.source}`)
  }
}

async function prepareFrozenChildren(
  git: GitProcess,
  repository: string,
  path: string,
  commit: string,
  frozen: FrozenPushIntent,
): Promise<ReadonlyMap<string, PreparedSubmodule>> {
  const remote =
    path === "." ? frozen.rootRemote : frozen.children.find((row) => row.path === path && row.pin === commit)?.remote
  if (remote === undefined) throw new Error(`Frozen merge has no repository identity for ${path}@${commit}`)
  const prepared = await superSubmodulePrepare({ repo: repository, commit, remote, git })
  if (prepared.state === "failed" || prepared.state === "unknown") {
    const failure =
      prepared.detail ??
      detail(
        "prepare-frozen-children-failed",
        "recover-frozen-sources",
        `Cannot prepare frozen children in ${repository}`,
      )
    throw Object.assign(new Error(failure.message), { resultDetail: failure })
  }
  return new Map(prepared.submodules.map((entry) => [entry.path, entry]))
}

/**
 * Verify a child's pinned commit exists in its discovered store, recovering it from the store's
 * own `origin` remote when it is missing. The frozen path recovers a retained pin from its
 * declared remote; an ordinary (non-frozen) child — most commonly a nested gitlink resolved from
 * the parent's on-disk checkout rather than a prefetched store — has no such declaration, so this
 * is the fallback for that case.
 */
async function verifyOrRecoverSubmoduleCommit(
  git: GitProcess,
  discovered: string,
  childPath: string,
  target: string,
): Promise<void> {
  const verifyArgs = ["cat-file", "-e", `${target}^{commit}`]
  const present = await git.run({ repo: discovered, args: verifyArgs })
  if (present.code === 0) return
  if (present.timedOut === true || present.failure !== undefined) {
    throw operationError(discovered, verifyArgs, "verify-submodule-commit", present)
  }
  const originArgs = ["remote", "get-url", "origin"]
  const origin = await git.run({ repo: discovered, args: originArgs })
  if (origin.code !== 0) {
    const message = `Nested submodule ${childPath}@${target} is missing from ${discovered}, which has no origin remote to recover it from.`
    throw Object.assign(new Error(message), {
      resultDetail: detail("submodule-has-no-remote", "verify-submodule-commit", message, {
        paths: [childPath],
        objectIds: [target],
        remedy:
          "Configure an origin remote for the nested submodule clone, or fetch the exact commit manually, then rerun the same push.",
      }),
    })
  }
  try {
    await ensureCommitObject({ repository: discovered, remote: "origin", commit: target, git })
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error)
    const message = `Nested submodule ${childPath}@${target} is missing from ${discovered} and could not be recovered from origin (${origin.stdout.trim()}): ${cause}`
    throw Object.assign(new Error(message), {
      resultDetail: detail("submodule-commit-unrecoverable", "verify-submodule-commit", message, {
        paths: [childPath],
        objectIds: [target],
        remedy: "Publish the exact nested commit to its origin remote, then rerun the same push.",
      }),
    })
  }
}

async function collectCommitRequirements(
  git: GitProcess,
  root: string,
  commits: readonly string[],
  rootPins?: ReadonlyMap<string, string>,
  frozen?: FrozenPushIntent,
  rootStores?: ReadonlyMap<string, string>,
): Promise<CommitRequirement[]> {
  const completed = new Set<string>()
  const visiting = new Set<string>()
  const requirements: CommitRequirement[] = []
  const walk = async (repository: string, path: string, commit: string): Promise<void> => {
    const key = `${repository}\0${commit}`
    if (completed.has(key)) return
    if (visiting.has(key)) {
      throw Object.assign(new Error(`recursive gitlink cycle at ${path} ${commit}`), {
        resultDetail: detail("gitlink-cycle", "read-push-graph", `Recursive gitlink cycle at ${path}.`, {
          paths: [path],
          objectIds: [commit],
          remedy: "Repair the cyclic target commit graph before pushing it recursively.",
        }),
      })
    }
    visiting.add(key)
    const stores = frozen === undefined ? undefined : await prepareFrozenChildren(git, repository, path, commit, frozen)
    for (const recorded of await readCommitSubmodules(git, repository, commit)) {
      const target = path === "." ? rootPins?.get(recorded.path) : undefined
      const entry = target === undefined ? recorded : { ...recorded, target }
      const childPath = path === "." ? entry.path : `${path}/${entry.path}`
      const store = stores?.get(entry.path)
      if (stores !== undefined && store === undefined) {
        throw new Error(`No prepared store for frozen child ${childPath}`)
      }
      // A PREPARED store is deliberately somewhere else, so its toplevel is not
      // expected to be the gitlink's path and the guard below does not apply to
      // it. The guard is for the fallback, where the path IS the claim.
      const prepared = store?.gitdir ?? (path === "." ? rootStores?.get(entry.path) : undefined)
      const child = prepared ?? join(repository, entry.path)
      const discovered = await discoverRepository(git, child, "discover-submodule", prepared === undefined)
      if (frozen !== undefined) {
        const row = frozen.children.find((candidate) => candidate.path === childPath && candidate.pin === entry.target)
        if (row === undefined) throw new Error(`Frozen merge has no child disposition for ${childPath}@${entry.target}`)
        for (const source of new Set([row.pin, ...(row.publication === undefined ? [] : [row.publication.source])])) {
          const args = ["cat-file", "-e", `${source}^{commit}`]
          const present = await git.run({ repo: discovered, args })
          if (present.code === 0) continue
          if (present.timedOut === true || present.failure !== undefined) {
            throw operationError(discovered, args, "recover-frozen-source", present)
          }
          if (!sameHostedOwner(frozen.rootRemote, row.remote)) {
            throw new Error(
              `External child ${childPath}@${source} is unavailable locally and has no authorized cold recovery prerequisite`,
            )
          }
          await verifyRetainedSource(git, {
            repository: discovered,
            remote: row.remote,
            source,
            destination: `refs/git-super/pins/${source}`,
          })
          await required(git, discovered, args, "verify-recovered-source")
        }
      }
      await verifyOrRecoverSubmoduleCommit(git, discovered, childPath, entry.target)
      await walk(discovered, childPath, entry.target)
      requirements.push({
        superproject: repository,
        entry,
        repository: discovered,
        path: childPath,
        target: entry.target,
      })
    }
    visiting.delete(key)
    completed.add(key)
  }
  for (const commit of new Set(commits)) await walk(root, ".", commit)
  return requirements.filter(
    (requirement, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.repository === requirement.repository &&
          candidate.target === requirement.target &&
          candidate.entry.name === requirement.entry.name &&
          candidate.entry.branch === requirement.entry.branch,
      ) === index,
  )
}

/**
 * The exact rows `after` moves relative to `before`: the top-level gitlinks
 * from the one rule, changedGitlinks, and under each moved parent the nested
 * gitlinks its OWN two commits differ in, read from the parent's store (one
 * tree read per moved parent that has nested rows). A parent new to `after`
 * has no previous commit, so every row under it counts as changed. An
 * unreadable previous commit throws: the merge fails loud rather than
 * guessing (25303, review of P1).
 */
async function changedRowPaths(
  git: GitProcess,
  before: readonly CommitGitlink[],
  after: readonly CommitGitlink[],
  requirements: readonly CommitRequirement[],
  prefix = "",
): Promise<Set<string>> {
  const paths = new Set<string>()
  const previous = new Map(before.map((entry) => [entry.path, entry.target]))
  for (const entry of changedGitlinks(before, after)) {
    const path = prefix === "" ? entry.path : `${prefix}/${entry.path}`
    paths.add(path)
    const nested = requirements.filter((requirement) => requirement.path.startsWith(`${path}/`))
    if (nested.length === 0) continue
    const was = previous.get(entry.path)
    const store = requirements.find(
      (requirement) => requirement.path === path && requirement.target === entry.target,
    )?.repository
    if (was === undefined || store === undefined) {
      for (const requirement of nested) paths.add(requirement.path)
      continue
    }
    const inner = await changedRowPaths(
      git,
      await readCommitGitlinks(git, store, was),
      await readCommitGitlinks(git, store, entry.target),
      requirements,
      path,
    )
    for (const nestedPath of inner) paths.add(nestedPath)
  }
  return paths
}

type AdvertisedRef = Readonly<{ oid: string; ref: string }>

/** One `ls-remote --refs`: the remote's refs under the prefixes, as it advertised them. */
async function readAdvertisement(
  git: GitProcess,
  repository: string,
  remote: string,
  refPrefixes: readonly string[] = ["refs/"],
): Promise<AdvertisedRef[]> {
  const advertised = await git.run({ repo: repository, args: ["ls-remote", "--refs", remote] })
  if (advertised.code !== 0) {
    throw operationError(repository, ["ls-remote", "--refs", remote], "inspect-submodule-remote", advertised)
  }
  const rows: AdvertisedRef[] = []
  for (const line of advertised.stdout.split(/\r?\n/u).filter((row) => row !== "")) {
    const [oid, ref] = line.split(/\s+/u, 2)
    if (
      oid === undefined ||
      ref === undefined ||
      !OBJECT_ID.test(oid) ||
      !refPrefixes.some((prefix) => ref.startsWith(prefix))
    ) {
      continue
    }
    rows.push({ oid, ref })
  }
  return rows
}

/**
 * Read raw presence and commit peel together in one batch. Only absent refs
 * need a bounded fetch and a second batch over that subset (25142).
 */
async function advertisedTips(
  git: GitProcess,
  repository: string,
  remote: string,
  rows: readonly AdvertisedRef[],
): Promise<string[]> {
  const queries = (selected: readonly AdvertisedRef[]): string[] =>
    selected.flatMap((row) => [row.oid, `${row.oid}^{commit}`])
  const remedy = "Fetch the named advertised ref and retry the push after its object is available."
  const inspect = async (names: readonly string[]): Promise<readonly BatchCheckResult[]> => {
    let timedOut = false
    try {
      return await batchCheck(repository, names, {
        run: async (args, options): Promise<GitResult> => {
          const result = await git.run({
            repo: repository,
            args: args[0] === "-C" ? args.slice(2) : args,
            ...(options?.input === undefined ? {} : { stdin: options.input.toString() }),
          })
          timedOut = result.timedOut === true
          return {
            code:
              result.code === 0 && (result.timedOut || result.failure !== undefined || result.signal) ? 1 : result.code,
            stdout: Buffer.from(result.stdout),
            stderr: Buffer.from(
              result.failure ??
                (result.timedOut
                  ? `git cat-file timed out${result.stderr ? `: ${result.stderr}` : ""}`
                  : result.signal
                    ? `git cat-file stopped by ${result.signal}${result.stderr ? `: ${result.stderr}` : ""}`
                    : result.stderr),
            ),
          }
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw Object.assign(new Error(message, { cause: error }), {
        resultDetail: detail(timedOut ? "git-timeout" : "git-failed", "inspect-advertised-objects", message, {
          remedy,
        }),
      })
    }
  }
  const first = await inspect(queries(rows))
  const absent = rows.filter((_, index) => {
    const answer = first[index * 2]
    return answer !== undefined && "missing" in answer
  })
  for (let start = 0; start < absent.length; start += ADVERTISED_FETCH_BATCH) {
    await required(
      git,
      repository,
      [
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        remote,
        ...absent.slice(start, start + ADVERTISED_FETCH_BATCH).map((row) => row.ref),
      ],
      "fetch-submodule-remote-tip",
    )
  }
  const fetched = absent.length === 0 ? [] : await inspect(queries(absent))
  const tips = new Set<string>()
  const collect = (
    selected: readonly AdvertisedRef[],
    answers: readonly BatchCheckResult[],
    afterFetch: boolean,
  ): void => {
    selected.forEach((row, index) => {
      const raw = answers[index * 2]
      const peeled = answers[index * 2 + 1]
      if (raw === undefined || peeled === undefined) {
        throw new Error(`Missing object answer for ${row.ref} in ${repository}`)
      }
      if ("missing" in raw) {
        if (afterFetch) {
          throw new Error(`Advertised object ${row.oid} at ${row.ref} from ${remote} remains missing in ${repository}`)
        }
        return
      }
      if (raw.oid !== row.oid) {
        throw new Error(`Advertised object ${row.oid} at ${row.ref} changed identity in ${repository}`)
      }
      if (!("missing" in peeled)) {
        if (peeled.type !== "commit") {
          throw new Error(`Advertised ref ${row.ref} did not peel to a commit in ${repository}`)
        }
        tips.add(peeled.oid)
      }
    })
  }
  collect(rows, first, false)
  collect(absent, fetched, true)
  return [...tips]
}

async function advertisedCommitTips(
  git: GitProcess,
  repository: string,
  remote: string,
  refPrefixes: readonly string[] = ["refs/"],
): Promise<string[]> {
  return advertisedTips(git, repository, remote, await readAdvertisement(git, repository, remote, refPrefixes))
}

async function commitAvailableOnRemote(
  git: GitProcess,
  repository: string,
  remote: string,
  commit: string,
  refPrefixes?: readonly string[],
): Promise<boolean> {
  for (const tip of await advertisedCommitTips(git, repository, remote, refPrefixes)) {
    const contains = await git.run({ repo: repository, args: ["merge-base", "--is-ancestor", commit, tip] })
    if (contains.code === 0) return true
    if (contains.code !== 1) {
      throw operationError(
        repository,
        ["merge-base", "--is-ancestor", commit, tip],
        "check-remote-availability",
        contains,
      )
    }
  }
  return false
}

/** Fetch advertised remote tips as needed and test whether one contains an exact local commit. */
export async function remoteContainsCommit(options: RemoteCommitAvailabilityOptions): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw Object.assign(new Error("Git command timeout must be a positive finite number."), {
      resultDetail: detail("invalid-timeout", "validate", "Git command timeout must be a positive finite number."),
    })
  }
  if (!OBJECT_ID.test(options.commit)) {
    throw Object.assign(new Error(`remote availability requires an exact commit ID: ${options.commit}`), {
      resultDetail: detail(
        "non-object-source",
        "validate",
        `Remote availability requires an exact commit ID: ${options.commit}.`,
      ),
    })
  }
  const process = options.git ?? createLocalGitProcess()
  const git: GitProcess = {
    run: (request) => process.run({ ...request, timeoutMs: request.timeoutMs ?? timeoutMs }),
  }
  const repository = await discoverRepository(git, options.repository, "discover-repository")
  await required(git, repository, ["cat-file", "-e", `${options.commit}^{commit}`], "verify-source-commit")
  return commitAvailableOnRemote(git, repository, options.remote, options.commit, options.refPrefixes)
}

/** The remote's own refusal of a want it will not serve: upload-pack's text, stable under LC_ALL=C. */
const NOT_SERVED = "upload-pack: not our ref"

/**
 * Whether `remote` serves `commit`, asked with ONE fetch of that commit by SHA (25570).
 *
 * Listing the remote to find a tip that contains the commit carried its whole advertisement, 8,584 heads on
 * hh-dev's origin, then fetched every tip missing here. Asking for the commit advertises no refs at all.
 *
 * ASSUMPTION: the remote serves any commit reachable from one of its refs, tip or not, as GitHub does (measured
 * 2026-09-24, main~3 of hh-dev, receipt /hh/var/@dev10/25570/check-mode-filter-probe.txt). A server serving only
 * advertised tips would answer "not our ref" for a reachable non-tip commit, and this would call it unavailable.
 *
 * The ask runs in a throwaway repository, never the child's store: a fetch whose wanted object is already local
 * never contacts the remote, and the child always holds the commit it pins. `--depth=1 --filter=tree:0` transfers
 * that one commit object (88 objects under blob:none on hh-dev, 1 under tree:0). "not our ref" is the one answer
 * that means unavailable; every other failure is loud, never read as unavailable.
 */
async function remoteServesCommit(
  git: GitProcess,
  repository: string,
  remote: string,
  commit: string,
): Promise<boolean> {
  const declared = (await required(git, repository, ["remote", "get-url", remote], "resolve-submodule-remote")).trim()
  // A scp-like or scheme URL passes as written; a bare path is the remote's store, relative to its repository.
  const url =
    declared.includes("://") || /^[^/]+:/u.test(declared) || isAbsolute(declared)
      ? declared
      : resolve(repository, declared)
  const scratch = mkdtempSync(join(tmpdir(), "git-super-serves-"))
  try {
    await required(git, scratch, ["init", "--quiet"], "prepare-availability-probe")
    const args = ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--depth=1", "--filter=tree:0", url, commit]
    const asked = await git.run({ repo: scratch, args, env: { LC_ALL: "C" } })
    if (asked.code === 0 && asked.failure === undefined && asked.timedOut !== true) return true
    if (asked.timedOut !== true && asked.stderr.includes(`${NOT_SERVED} ${commit}`)) return false
    throw operationError(repository, args, "check-remote-availability", asked)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

async function commitAvailableOnAnyRemote(git: GitProcess, requirement: CommitRequirement): Promise<boolean> {
  const listed = await required(git, requirement.repository, ["remote"], "list-submodule-remotes")
  const remotes = listed.split(/\r?\n/u).filter((remote) => remote !== "")
  if (remotes.length === 0) {
    throw Object.assign(new Error(`submodule ${requirement.path} has no remotes`), {
      resultDetail: detail(
        "submodule-has-no-remote",
        "check-submodule-availability",
        `Submodule ${requirement.path} has no configured remote.`,
        { paths: [requirement.path], objectIds: [requirement.target] },
      ),
    })
  }
  const failures: string[] = []
  for (const remote of remotes) {
    try {
      if (await remoteServesCommit(git, requirement.repository, remote, requirement.target)) return true
    } catch (error) {
      failures.push(`${remote}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (failures.length === remotes.length) {
    throw Object.assign(new Error(`could not inspect any remote for ${requirement.path}`), {
      resultDetail: detail(
        "submodule-availability-unknown",
        "check-submodule-availability",
        `Could not inspect any configured remote for ${requirement.path}: ${failures.join("; ")}`,
        {
          paths: [requirement.path],
          objectIds: [requirement.target],
          remedy: "Restore one configured submodule remote and rerun the same recursive push.",
        },
      ),
    })
  }
  return false
}

/**
 * 24901: when no root destination is refs/heads/main, the child must not go to
 * its .gitmodules branch (which is usually main).  Instead it publishes to
 * refs/git-super/pins/<sha>, exactly like the frozen-intent path.
 */
async function childUpdate(
  git: GitProcess,
  requirement: CommitRequirement,
  timeoutMs: number,
  rootDestinations: readonly string[],
): Promise<RefUpdate> {
  const remote = await configuredPushRemote(git, requirement.repository)
  const rootTargetsMain = rootDestinations.some((destination) => destination === "refs/heads/main")
  if (!rootTargetsMain) {
    // Create-only pin: the child commit is reachable but no branch moves.
    return {
      repository: requirement.repository,
      remote,
      source: requirement.target,
      destination: `refs/git-super/pins/${requirement.target}`,
      expectedDestination: { state: "missing" },
    }
  }
  const branch = await resolveSubmoduleBranch(
    git,
    requirement.superproject,
    requirement.repository,
    requirement.entry,
    remote,
  )
  const destination = `refs/heads/${branch}`
  const observed = await observeDestination(
    git,
    { repository: requirement.repository, remote, destination },
    "observe-submodule-destination",
  )
  let source = requirement.target
  if (observed.state === "oid") {
    await ensureCommitObject({ repository: requirement.repository, remote, commit: observed.oid, timeoutMs, git })
    const args = ["merge-base", "--is-ancestor", requirement.target, observed.oid]
    const contained = await git.run({ repo: requirement.repository, args })
    if (contained.code === 0 && !contained.timedOut && contained.failure === undefined) source = observed.oid
    else if (contained.code !== 1 || contained.timedOut || contained.failure !== undefined) {
      throw operationError(requirement.repository, args, "prove-submodule-destination-contains-pin", contained)
    }
  }
  return { repository: requirement.repository, remote, source, destination, expectedDestination: observed }
}

function availabilityResult(
  requirement: CommitRequirement,
  state: "failed" | "unchanged",
  failure?: GitResultDetail,
): GitSuperRepositoryResult {
  return {
    repository: requirement.repository,
    state,
    ...(failure === undefined ? {} : { detail: failure }),
    refs: [],
  }
}

function prependRepositories(
  result: GitSuperResult,
  repositories: readonly GitSuperRepositoryResult[],
): GitSuperResult {
  return gitSuperResult([...repositories, ...result.repositories], result.detail)
}

type LeasedChildPush = Readonly<{
  repository: string
  remote: string
  refspecs: readonly string[]
  publication?: Readonly<{ destination: string; source: string; expected: ExpectedDestination }>
}>

const PORCELAIN_REF = /^([ +\-*!=])\t([^\t]*):([^\t]+)\t(.*)$/u

/** One child's leased atomic push, judged by git's own `--porcelain` report: no observation before or after. */
async function pushLeasedChild(
  git: GitProcess,
  child: LeasedChildPush,
  options: Pick<SuperPushOptions, "pushOptions" | "signed" | "verify">,
): Promise<GitSuperRepositoryResult> {
  const lease =
    child.publication === undefined
      ? []
      : [
          `--force-with-lease=${child.publication.destination}:${child.publication.expected.state === "oid" ? child.publication.expected.oid : ""}`,
        ]
  const args = [
    "push",
    "--porcelain",
    "--atomic",
    "--recurse-submodules=no",
    ...(options.verify === false ? ["--no-verify"] : []),
    ...(options.signed === undefined ? [] : [`--signed=${options.signed}`]),
    ...(options.pushOptions ?? []).map((option) => `--push-option=${option}`),
    ...lease,
    child.remote,
    ...child.refspecs,
  ]
  const pushed = await git.run({ repo: child.repository, args })
  const reported = new Map<string, { flag: string; summary: string }>()
  for (const line of pushed.stdout.split(/\r?\n/u)) {
    const match = PORCELAIN_REF.exec(line)
    if (match?.[1] !== undefined && match[3] !== undefined) {
      reported.set(match[3], { flag: match[1], summary: match[4] ?? "" })
    }
  }
  let failure: GitResultDetail | undefined
  if (pushed.code !== 0 || pushed.timedOut === true || pushed.failure !== undefined) {
    const publication = child.publication
    const refused = publication === undefined ? undefined : reported.get(publication.destination)
    if (publication !== undefined && refused?.flag === "!") {
      // The one diagnostic read: WHO holds the ref the lease expected.
      const holder = await observeDestination(
        git,
        { repository: child.repository, remote: child.remote, destination: publication.destination },
        "name-lease-holder",
      ).then(expectedKey, (error: unknown) => `unreadable (${error instanceof Error ? error.message : String(error)})`)
      failure = detail(
        "destination-changed",
        "leased-child-push",
        `Leased push to ${child.remote} ${publication.destination} was refused (${refused.summary}): the merge expected ${expectedKey(publication.expected)} and the remote holds ${holder}. The push is atomic, so none of its refs was written.`,
        {
          objectIds: [...(publication.expected.state === "oid" ? [publication.expected.oid] : []), publication.source],
          remedy: "The child main moved after the merge was captured; re-judge the change against the current main.",
        },
      )
    } else {
      failure = detail(
        pushFailureCode(pushed),
        "leased-child-push",
        pushed.timedOut === true
          ? `git push timed out in ${child.repository}`
          : `git push failed in ${child.repository} (exit ${pushed.code})${pushed.stderr ? `\n${pushed.stderr}` : ""}`,
        { remedy: "Inspect the exact repository/ref result and remote evidence before retrying." },
      )
    }
  }
  const refs = child.refspecs.map((refspec): GitSuperRefResult => {
    const separator = refspec.indexOf(":")
    const source = refspec.slice(0, separator)
    const destination = refspec.slice(separator + 1)
    const row = reported.get(destination)
    if (row === undefined) {
      return refResult(
        { source, destination },
        failure === undefined ? "unknown" : "failed",
        failure ??
          detail("missing-push-report", "leased-child-push", `git push reported nothing for ${destination}.`, {
            remedy: "Inspect the exact remote ref before retrying.",
          }),
      )
    }
    if (row.flag === "!") return refResult({ source, destination }, "failed", failure)
    if (failure !== undefined) return refResult({ source, destination }, "not-run", failure)
    return refResult({ source, destination }, row.flag === "=" ? "unchanged" : "updated")
  })
  return {
    repository: child.repository,
    state: repositoryState(refs),
    ...(failure === undefined ? {} : { detail: failure }),
    refs,
  }
}

/**
 * ITEM 9 OF THE 25303 MERGE-PATH REDESIGN: A LEASED PUSH REPLACES EVERY PRE-CHECK.
 * A queue merge publishes by pushing ONE frozen merge to the root's main. Each
 * child whose gitlink the merge moved (the one changed-set rule, first parent
 * against the merge) gets ONE atomic push carrying its pin and its main, leased
 * on the main capture observed. There is no pre-validate, retention recheck or
 * fetch-back, and no observation afterwards: git's porcelain report is the
 * outcome. A child main that moved after capture is refused by the lease (one
 * diagnostic read names who holds it). A child main that DIVERGED from the pin
 * is refused before any push, because a lease would otherwise overwrite it.
 * Any other shape (records, several refspecs, a non-main destination) answers
 * undefined and takes the observed path.
 */
async function leasedFrozenPush(
  git: GitProcess,
  root: string,
  remote: string,
  rootUpdates: readonly RefUpdate[],
  options: SuperPushOptions,
  timeoutMs: number,
  progress: ReturnType<typeof createPushProgress>,
): Promise<GitSuperResult | undefined> {
  const [update, ...others] = rootUpdates
  if (update === undefined || others.length > 0 || update.source === "" || update.destination !== "refs/heads/main") {
    return undefined
  }
  const intent = await readFrozenPushIntent(git, root, update.source)
  if (intent === undefined) return undefined
  const actualRemote = await logicalPushUrl(git, root, remote)
  if (!sameHostedRepository(intent.rootRemote, actualRemote)) {
    throw new Error(
      `Merge ${update.source} freezes root remote ${intent.rootRemote}, but this push selects ${actualRemote}`,
    )
  }
  const firstParent = await required(
    git,
    root,
    ["rev-parse", "--verify", `${update.source}^1^{commit}`],
    "read-merge-first-parent",
  )
  const selected = await collectCommitRequirements(git, root, [update.source], undefined, intent)
  const changed = await changedRowPaths(
    git,
    await readCommitGitlinks(git, root, firstParent),
    await readCommitGitlinks(git, root, update.source),
    selected,
  )
  const children: LeasedChildPush[] = []
  for (const row of intent.children) {
    const requirement = selected.find((entry) => entry.path === row.path && entry.target === row.pin)
    if (requirement === undefined) {
      throw new Error(`Frozen child ${row.path}@${row.pin} is not selected by merge ${update.source}`)
    }
    if (!changed.has(row.path) || !sameHostedOwner(intent.rootRemote, row.remote)) continue
    const pins = [...new Set([row.pin, ...(row.publication === undefined ? [] : [row.publication.source])])]
    const refspecs = pins.map((pin) => `${pin}:refs/git-super/pins/${pin}`)
    if (row.publication === undefined) {
      children.push({ repository: requirement.repository, remote: row.remote, refspecs })
      continue
    }
    const { destination, source, expectedDestination } = row.publication
    const bindArgs = ["merge-base", "--is-ancestor", row.pin, source]
    const bound = await git.run({ repo: requirement.repository, args: bindArgs })
    if (bound.code !== 0) throw operationError(requirement.repository, bindArgs, "bind-frozen-publication", bound)
    if (expectedDestination.state === "oid" && expectedDestination.oid !== source) {
      // A lease lets a NON-fast-forward through whenever the remote still holds
      // the expected value, so a diverged main would be overwritten and its
      // commits lost. ADR-0015's diverged-pin refusal, before any push.
      const args = ["merge-base", "--is-ancestor", expectedDestination.oid, source]
      const ancestry = await git.run({ repo: requirement.repository, args })
      if (ancestry.code !== 0) {
        const failure = detail(
          "diverged-pin",
          "leased-child-fast-forward",
          `Merge ${update.source} would move ${row.remote} ${destination} from ${expectedDestination.oid} to ${source} (pin ${row.pin}), which is not a fast-forward${ancestry.code === 1 ? "" : ` (git merge-base exited ${ancestry.code}${ancestry.stderr ? `: ${ancestry.stderr.trim()}` : ""})`}; nothing was pushed.`,
          {
            paths: [row.path],
            objectIds: [expectedDestination.oid, source, row.pin],
            remedy:
              "The child main diverged from the pinned history; re-judge the change against the current child main.",
          },
        )
        return gitSuperResult(
          [
            { repository: requirement.repository, state: "failed", detail: failure, refs: [] },
            { repository: root, state: "not-run", detail: failure, refs: [refResult(update, "not-run", failure)] },
          ],
          failure,
        )
      }
    }
    refspecs.push(`${source}:${destination}`)
    children.push({
      repository: requirement.repository,
      remote: row.remote,
      refspecs,
      publication: { destination, source, expected: expectedDestination },
    })
  }
  const exclusive = options.exclusive ?? createExclusive(await lockDirectory(git, root))
  progress.phase(`wait-writer-lock 0/${children.length + 1}`)
  return exclusive.run(
    async () => {
      const results = await mapInOrder(children, PLAN_READ_CONCURRENCY, (child) => pushLeasedChild(git, child, options))
      const failed = results.find((result) => result.state === "failed" || result.state === "unknown")
      if (failed !== undefined) {
        const failure =
          failed.detail ??
          detail("push-incomplete", "leased-child-push", `Push did not complete in ${failed.repository}.`)
        return gitSuperResult(
          [
            ...results,
            { repository: root, state: "not-run", detail: failure, refs: [refResult(update, "not-run", failure)] },
          ],
          failure,
        )
      }
      if (options.recurseSubmodules !== "on-demand") {
        return gitSuperResult(
          results.length > 0 ? results : [{ repository: root, state: "not-run", refs: [refResult(update, "not-run")] }],
        )
      }
      // The root is the commit point, so it goes last, on the ordinary leased path.
      const pushed = await runPushRefUpdates(
        {
          root,
          updates: rootUpdates,
          ...(options.atomic === undefined ? {} : { atomic: options.atomic }),
          ...(options.verify === undefined ? {} : { verify: options.verify }),
          ...(options.pushOptions === undefined ? {} : { pushOptions: options.pushOptions }),
          ...(options.signed === undefined ? {} : { signed: options.signed }),
          timeoutMs,
          git,
          exclusive: { run: (operation) => operation() },
        },
        progress.phase,
      )
      return prependRepositories(pushed, results)
    },
    { holder: "git super push" },
  )
}

/** Plan ordinary CLI refspecs into exact rows, then execute the selected recursive mode. */
export async function superPush(options: SuperPushOptions): Promise<GitSuperResult> {
  if (!(["check", "no", "on-demand", "only"] as const).includes(options.recurseSubmodules)) {
    return pushInputFailure(
      options.repo,
      "invalid-recurse-mode",
      `Unknown recurse-submodules mode ${options.recurseSubmodules}.`,
      "Choose check, on-demand, only, or no.",
    )
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return pushInputFailure(
      options.repo,
      "invalid-timeout",
      "Git command timeout must be a positive finite number.",
      "Supply one positive finite timeout in milliseconds.",
    )
  }
  const process = options.git ?? createLocalGitProcess()
  const progress = createPushProgress(options.report)
  const git: GitProcess = {
    run: (request) => {
      if (request.args[0] === "push" && !request.args.includes("--dry-run")) progress.beforeWrite()
      return process.run({ ...request, timeoutMs: request.timeoutMs ?? timeoutMs })
    },
  }
  let root: string
  const retained: GitSuperRepositoryResult[] = []
  try {
    progress.phase("select-root 0/1")
    root = await discoverRepository(git, options.repo, "discover-root")
    progress.phase("select-root 1/1")
    const remote = options.remote ?? (await configuredPushRemote(git, root))
    const refspecs = options.refspecs ?? []
    const selectedUpdates =
      refspecs.length === 0
        ? await configuredPushUpdates(git, root, remote, options)
        : await Promise.all(refspecs.map((refspec) => refspecUpdate(git, root, remote, refspec)))
    const rootUpdates = applyExplicitLeases(selectedUpdates, options.forceWithLease ?? [])
    const rootSources = rootUpdates.map((update) => update.source).filter((source) => source !== "")
    if (options.recurseSubmodules === "no") {
      return await runPushRefUpdates(
        {
          root,
          updates: rootUpdates,
          ...(options.atomic === undefined ? {} : { atomic: options.atomic }),
          ...(options.verify === undefined ? {} : { verify: options.verify }),
          ...(options.pushOptions === undefined ? {} : { pushOptions: options.pushOptions }),
          ...(options.signed === undefined ? {} : { signed: options.signed }),
          timeoutMs,
          git,
          ...(options.exclusive === undefined ? {} : { exclusive: options.exclusive }),
        },
        progress.phase,
      )
    }
    if (options.recurseSubmodules === "check") {
      const requirements = await collectCommitRequirements(git, root, rootSources)
      const available: GitSuperRepositoryResult[] = []
      for (const requirement of requirements) {
        if (await commitAvailableOnAnyRemote(git, requirement)) {
          available.push(availabilityResult(requirement, "unchanged"))
          continue
        }
        const failure = detail(
          "submodule-commit-unavailable",
          "check-submodule-availability",
          `Commit ${requirement.target} from ${requirement.path} is not reachable from any configured submodule remote.`,
          {
            paths: [requirement.path],
            objectIds: [requirement.target],
            remedy: "Publish the exact child commit to at least one configured child remote, then rerun check mode.",
          },
        )
        return gitSuperResult(
          [
            ...available,
            availabilityResult(requirement, "failed", failure),
            {
              repository: root,
              state: "not-run",
              detail: failure,
              refs: rootUpdates.map((update) => refResult(update, "not-run", failure)),
            },
          ],
          failure,
        )
      }
      const pushed = await runPushRefUpdates(
        {
          root,
          updates: rootUpdates,
          ...(options.atomic === undefined ? {} : { atomic: options.atomic }),
          ...(options.verify === undefined ? {} : { verify: options.verify }),
          ...(options.pushOptions === undefined ? {} : { pushOptions: options.pushOptions }),
          ...(options.signed === undefined ? {} : { signed: options.signed }),
          timeoutMs,
          git,
          ...(options.exclusive === undefined ? {} : { exclusive: options.exclusive }),
        },
        progress.phase,
      )
      return prependRepositories(pushed, available)
    }
    progress.phase("scan-frozen-history 0/1")
    const leased = await leasedFrozenPush(git, root, remote, rootUpdates, options, timeoutMs, progress)
    if (leased !== undefined) return leased
    const frozen = await frozenChildUpdates(git, root, remote, rootUpdates)
    progress.phase("scan-frozen-history 1/1")
    const childUpdates: RefUpdate[] = frozen.updates ?? []
    if (frozen.updates === undefined) {
      const requirementDestinations = new Map<string, { requirement: CommitRequirement; destinations: Set<string> }>()
      for (const update of rootUpdates) {
        if (update.source === "") continue
        const reqs = await collectCommitRequirements(git, root, [update.source])
        for (const req of reqs) {
          const key = `${req.repository}\0${req.target}\0${req.entry.name}\0${req.entry.branch ?? ""}`
          const existing = requirementDestinations.get(key)
          if (existing !== undefined) {
            existing.destinations.add(update.destination)
          } else {
            requirementDestinations.set(key, {
              requirement: req,
              destinations: new Set([update.destination]),
            })
          }
        }
      }
      for (const { requirement, destinations } of requirementDestinations.values()) {
        childUpdates.push(await childUpdate(git, requirement, timeoutMs, Array.from(destinations)))
      }
    }
    if (frozen.retention.length > 0) {
      // Validate every frozen destination and root lease before the first retention write.
      // A direct merge's publications ARE its childUpdates (the same objects); planning them once halves the
      // child-main observations of this pass (25303).
      await planUpdates(
        git,
        [...frozen.retention, ...new Set([...frozen.publications, ...childUpdates]), ...rootUpdates],
        timeoutMs,
      )
      const result = await runPushRefUpdates(
        {
          root,
          updates: frozen.retention,
          timeoutMs,
          git,
          ...(options.exclusive === undefined ? {} : { exclusive: options.exclusive }),
        },
        progress.phase,
      )
      retained.push(...result.repositories)
      if (result.state === "failed" || result.state === "unknown") {
        return gitSuperResult(
          [
            ...retained,
            {
              repository: root,
              state: "not-run",
              refs: rootUpdates.map((update) => refResult(update, "not-run", result.detail)),
            },
          ],
          result.detail,
        )
      }
      // A pin the retention push found already at its exact source was observed there under the lease, so
      // only a pin this push wrote is fetched back to prove it retained (25303).
      const alreadyRetained = new Set(
        result.repositories.flatMap((repository) =>
          repository.refs
            .filter((ref) => ref.state === "unchanged")
            .map((ref) => `${repository.repository}\0${ref.destination}\0${ref.source}`),
        ),
      )
      for (const update of frozen.retention) {
        if (alreadyRetained.has(`${update.repository}\0${update.destination}\0${update.source}`)) continue
        await verifyRetainedSource(git, update)
      }
    }
    if (childUpdates.length === 0 && options.recurseSubmodules === "only") {
      if (retained.length > 0) return gitSuperResult(retained)
      return gitSuperResult([
        {
          repository: root,
          state: "not-run",
          refs: rootUpdates.map((update) => ({
            source: update.source,
            destination: update.destination,
            state: "not-run",
          })),
        },
      ])
    }
    const pushed = await runPushRefUpdates(
      {
        root,
        updates: [...childUpdates, ...(options.recurseSubmodules === "on-demand" ? rootUpdates : [])],
        ...(options.atomic === undefined ? {} : { atomic: options.atomic }),
        ...(options.verify === undefined ? {} : { verify: options.verify }),
        ...(options.pushOptions === undefined ? {} : { pushOptions: options.pushOptions }),
        ...(options.signed === undefined ? {} : { signed: options.signed }),
        timeoutMs,
        git,
        ...(options.exclusive === undefined ? {} : { exclusive: options.exclusive }),
      },
      progress.phase,
    )
    return prependRepositories(pushed, retained)
  } catch (error) {
    const failure = resultError(error, "plan-push")
    return prependRepositories(failedResult(resolve(options.repo), failure), retained)
  } finally {
    progress.cancel()
  }
}
