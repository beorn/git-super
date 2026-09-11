import { isAbsolute, join, resolve } from "node:path"

import { readCommitSubmodules, resolveSubmoduleBranch, type CommitSubmodule } from "./commit-graph.ts"
import { createExclusive, type Exclusive } from "./exclusive.ts"
import { ensureCommitObject } from "./objects.ts"
import {
  readFrozenPushIntent,
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
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u

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
 * 24454 row 4). `expected` is the path the caller believes it asked about;
 * omit it where discovery upward is the intent, as it is for the root.
 */
export async function discoverRepository(
  git: GitProcess,
  path: string,
  phase: string,
  expected?: string,
): Promise<string> {
  const topLevelArgs = ["rev-parse", "--show-toplevel"]
  const topLevel = await git.run({ repo: path, args: topLevelArgs })
  if (topLevel.code === 0 && topLevel.stdout.trim() !== "") {
    const discovered = resolve(topLevel.stdout.trim())
    if (expected !== undefined && discovered !== resolve(expected)) {
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
          remedy: `Initialize the submodule checkout at ${path} (git submodule update --init -- ${path}), then rerun the same command.`,
        }),
      })
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
    normalized.push(planned)
    if (
      update.expectedDestination !== undefined &&
      !sameExpected(update.expectedDestination, observed) &&
      !identicalRetry
    ) {
      mismatches.set(planned, mismatchDetail(planned, observed, "observe-destination"))
    }
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
export async function pushRefUpdates(options: PushRefUpdatesOptions): Promise<GitSuperResult> {
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
    const groups = groupUpdates(await planUpdates(git, options.updates, timeoutMs), root)
    const exclusive = options.exclusive ?? createExclusive(await lockDirectory(git, root))
    return await exclusive.run(
      async () => {
        const results: GitSuperRepositoryResult[] = []
        for (const [index, group] of groups.entries()) {
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
  const before = new Map(
    (await collectCommitRequirements(git, root, [head])).map((entry) => [entry.path, entry.target]),
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
    const update = await childUpdate(git, requirement, timeoutMs)
    const remote = await logicalPushUrl(git, requirement.repository, update.remote)
    if (!sameHostedOwner(rootRemote, remote)) {
      children.push({ ...pin, remote })
      continue
    }
    if (update.expectedDestination === undefined) throw new Error(`No observed destination for ${requirement.path}`)
    if (update.expectedDestination.state === "oid") {
      const args = ["merge-base", "--is-ancestor", update.expectedDestination.oid, update.source]
      const ancestry = await git.run({ repo: requirement.repository, args })
      if (ancestry.code === 1 && before.get(requirement.path) === requirement.target) {
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
  const advertised = await advertisedCommitTips(git, root, remote)
  const reachable = await required(
    git,
    root,
    ["rev-list", "--min-parents=2", ...direct, "--not", ...advertised],
    "find-new-frozen-merges",
  )
  let found = false
  for (const source of new Set([...direct, ...reachable.split(/\r?\n/u).filter(Boolean)])) {
    const intent = await readFrozenPushIntent(git, root, source)
    if (intent === undefined) continue
    const actualRemote = await logicalPushUrl(git, root, remote)
    if (!sameHostedRepository(intent.rootRemote, actualRemote)) {
      throw new Error(`Merge ${source} freezes root remote ${intent.rootRemote}, but this push selects ${actualRemote}`)
    }
    if (direct.has(source)) found = true
    const selected = await collectCommitRequirements(git, root, [source], undefined, intent)
    for (const row of intent.children) {
      const requirement = selected.find((entry) => entry.path === row.path && entry.target === row.pin)
      if (requirement === undefined) {
        throw new Error(`Frozen child ${row.path}@${row.pin} is not selected by merge ${source}`)
      }
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
      const discovered = await discoverRepository(
        git,
        child,
        "discover-submodule",
        prepared === undefined ? child : undefined,
      )
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

async function advertisedCommitTips(
  git: GitProcess,
  repository: string,
  remote: string,
  refPrefixes: readonly string[] = ["refs/"],
): Promise<string[]> {
  const advertised = await git.run({ repo: repository, args: ["ls-remote", "--refs", remote] })
  if (advertised.code !== 0) {
    throw operationError(repository, ["ls-remote", "--refs", remote], "inspect-submodule-remote", advertised)
  }
  const tips: string[] = []
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
    const present = await git.run({ repo: repository, args: ["cat-file", "-e", `${oid}^{object}`] })
    if (present.code !== 0) {
      await required(
        git,
        repository,
        ["fetch", "--no-tags", "--no-write-fetch-head", remote, ref],
        "fetch-submodule-remote-tip",
      )
    }
    const commit = await git.run({ repo: repository, args: ["rev-parse", `${oid}^{commit}`] })
    if (commit.code === 0 && OBJECT_ID.test(commit.stdout.trim())) tips.push(commit.stdout.trim())
  }
  return [...new Set(tips)]
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
      if (await commitAvailableOnRemote(git, requirement.repository, remote, requirement.target)) return true
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

async function childUpdate(git: GitProcess, requirement: CommitRequirement, timeoutMs: number): Promise<RefUpdate> {
  const remote = await configuredPushRemote(git, requirement.repository)
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
  const git: GitProcess = {
    run: (request) => process.run({ ...request, timeoutMs: request.timeoutMs ?? timeoutMs }),
  }
  let root: string
  const retained: GitSuperRepositoryResult[] = []
  try {
    root = await discoverRepository(git, options.repo, "discover-root")
    const remote = options.remote ?? (await configuredPushRemote(git, root))
    const refspecs = options.refspecs ?? []
    const selectedUpdates =
      refspecs.length === 0
        ? await configuredPushUpdates(git, root, remote, options)
        : await Promise.all(refspecs.map((refspec) => refspecUpdate(git, root, remote, refspec)))
    const rootUpdates = applyExplicitLeases(selectedUpdates, options.forceWithLease ?? [])
    const rootSources = rootUpdates.map((update) => update.source).filter((source) => source !== "")
    if (options.recurseSubmodules === "no") {
      return await pushRefUpdates({
        root,
        updates: rootUpdates,
        ...(options.atomic === undefined ? {} : { atomic: options.atomic }),
        ...(options.verify === undefined ? {} : { verify: options.verify }),
        ...(options.pushOptions === undefined ? {} : { pushOptions: options.pushOptions }),
        ...(options.signed === undefined ? {} : { signed: options.signed }),
        timeoutMs,
        git,
        ...(options.exclusive === undefined ? {} : { exclusive: options.exclusive }),
      })
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
      const pushed = await pushRefUpdates({
        root,
        updates: rootUpdates,
        ...(options.atomic === undefined ? {} : { atomic: options.atomic }),
        ...(options.verify === undefined ? {} : { verify: options.verify }),
        ...(options.pushOptions === undefined ? {} : { pushOptions: options.pushOptions }),
        ...(options.signed === undefined ? {} : { signed: options.signed }),
        timeoutMs,
        git,
        ...(options.exclusive === undefined ? {} : { exclusive: options.exclusive }),
      })
      return prependRepositories(pushed, available)
    }
    const frozen = await frozenChildUpdates(git, root, remote, rootUpdates)
    const childUpdates: RefUpdate[] = frozen.updates ?? []
    if (frozen.updates === undefined) {
      const requirements = await collectCommitRequirements(git, root, rootSources)
      for (const requirement of requirements) childUpdates.push(await childUpdate(git, requirement, timeoutMs))
    }
    if (frozen.retention.length > 0) {
      // Validate every frozen destination and root lease before the first retention write.
      await planUpdates(git, [...frozen.retention, ...frozen.publications, ...childUpdates, ...rootUpdates], timeoutMs)
      const result = await pushRefUpdates({
        root,
        updates: frozen.retention,
        timeoutMs,
        git,
        ...(options.exclusive === undefined ? {} : { exclusive: options.exclusive }),
      })
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
      for (const update of frozen.retention) await verifyRetainedSource(git, update)
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
    const pushed = await pushRefUpdates({
      root,
      updates: [...childUpdates, ...(options.recurseSubmodules === "on-demand" ? rootUpdates : [])],
      ...(options.atomic === undefined ? {} : { atomic: options.atomic }),
      ...(options.verify === undefined ? {} : { verify: options.verify }),
      ...(options.pushOptions === undefined ? {} : { pushOptions: options.pushOptions }),
      ...(options.signed === undefined ? {} : { signed: options.signed }),
      timeoutMs,
      git,
      ...(options.exclusive === undefined ? {} : { exclusive: options.exclusive }),
    })
    return prependRepositories(pushed, retained)
  } catch (error) {
    const failure = resultError(error, "plan-push")
    return prependRepositories(failedResult(resolve(options.repo), failure), retained)
  }
}
