import { isAbsolute, join, resolve } from "node:path"

import { readCommitGitlinks } from "./commit-graph.ts"
import { createExclusive, type Exclusive } from "./exclusive.ts"
import { createLocalGitProcess, type GitProcess, type GitProcessResult } from "./process.ts"
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
  signed?: PushSignedMode
  timeoutMs?: number
  git?: GitProcess
  exclusive?: Exclusive
}>

type PlannedUpdate = Readonly<{
  repository: string
  remote: string
  source: string
  destination: string
  expectedDestination: ExpectedDestination
}>

type PushGroup = Readonly<{
  repository: string
  remote: string
  updates: readonly PlannedUpdate[]
}>

type CommitRequirement = Readonly<{
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

async function planUpdates(git: GitProcess, input: readonly RefUpdate[]): Promise<PlannedUpdate[]> {
  if (input.length === 0) {
    throw Object.assign(new Error("git super push requires at least one ref update"), {
      resultDetail: detail("empty-push", "validate", "No ref updates were selected.", {
        remedy: "Supply an explicit source:destination refspec or explicit library RefUpdate.",
      }),
    })
  }
  const normalized: PlannedUpdate[] = []
  for (const update of input) {
    if (!OBJECT_ID.test(update.source)) {
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
    const repository = await required(git, update.repository, ["rev-parse", "--show-toplevel"], "discover-repository")
    await required(git, repository, ["cat-file", "-e", `${update.source}^{object}`], "verify-source-object")
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
    if (update.expectedDestination !== undefined && !sameExpected(update.expectedDestination, observed)) {
      const planned = { ...update, repository, expectedDestination: update.expectedDestination }
      throw Object.assign(new Error("remote destination does not match its explicit expectation"), {
        resultDetail: mismatchDetail(planned, observed, "observe-destination"),
      })
    }
    normalized.push({
      repository,
      remote: update.remote,
      source: update.source,
      destination: update.destination,
      expectedDestination: update.expectedDestination ?? observed,
    })
  }

  const byDestination = new Map<string, PlannedUpdate>()
  for (const update of normalized) {
    const key = `${update.repository}\0${update.remote}\0${update.destination}`
    const prior = byDestination.get(key)
    if (prior === undefined) {
      byDestination.set(key, update)
      continue
    }
    if (prior.source === update.source && sameExpected(prior.expectedDestination, update.expectedDestination)) continue
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
  return [...byDestination.values()]
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

function refResult(update: PlannedUpdate, state: GitResultState, failure?: GitResultDetail): GitSuperRefResult {
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

async function applyGroup(
  git: GitProcess,
  group: PushGroup,
  options: Pick<PushRefUpdatesOptions, "atomic" | "pushOptions" | "signed" | "verify">,
): Promise<GitSuperRepositoryResult> {
  const rechecked = await Promise.all(
    group.updates.map((update) => observeDestination(git, update, "recheck-destination")),
  )
  for (const [index, observed] of rechecked.entries()) {
    const update = group.updates[index]
    if (update !== undefined && observed !== undefined && !sameExpected(update.expectedDestination, observed)) {
      const failure = mismatchDetail(update, observed, "recheck-destination")
      return {
        repository: group.repository,
        state: "failed",
        detail: failure,
        refs: group.updates.map((entry) => refResult(entry, "failed", failure)),
      }
    }
  }

  const pending = group.updates.filter(
    (update) => update.expectedDestination.state === "missing" || update.expectedDestination.oid !== update.source,
  )
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
    ...group.updates.map(lease),
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
    if (observed?.state === "oid" && observed.oid === update.source) {
      const state =
        update.expectedDestination.state === "oid" && update.expectedDestination.oid === update.source
          ? "unchanged"
          : "updated"
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
  const root = resolve(options.root)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    const failure = detail("invalid-timeout", "validate", "Git command timeout must be a positive finite number.")
    return failedResult(root, failure)
  }
  const process = options.git ?? createLocalGitProcess()
  const git: GitProcess = {
    run: (request) => process.run({ ...request, timeoutMs: request.timeoutMs ?? timeoutMs }),
  }
  let groups: PushGroup[]
  try {
    const repository = await required(git, root, ["rev-parse", "--show-toplevel"], "discover-root")
    groups = groupUpdates(await planUpdates(git, options.updates), repository)
    const exclusive = options.exclusive ?? createExclusive(await lockDirectory(git, repository))
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
  if (sourceName === "") {
    throw Object.assign(new Error(`deleting a remote ref is outside the git super push subset: ${refspec}`), {
      resultDetail: detail("delete-refspec-refused", "validate", `Delete refspec ${refspec} is not accepted.`, {
        remedy: "Delete the ref with an explicit ordinary Git command after confirming its exact target.",
      }),
    })
  }
  if (sourceName.includes("*")) {
    throw Object.assign(new Error(`pattern refspec is outside the git super push subset: ${refspec}`), {
      resultDetail: detail("pattern-refspec-refused", "validate", `Pattern refspec ${refspec} is not accepted.`, {
        remedy: "Resolve the pattern into exact source:destination rows before pushing.",
      }),
    })
  }
  const source = await required(git, root, ["rev-parse", `${sourceName}^{object}`], "resolve-push-source")
  let destination = separator < 0 ? "" : refspec.slice(separator + 1)
  if (destination === "") {
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
  const pushDefault = await git.run({ repo: root, args: ["config", "--get", "remote.pushDefault"] })
  if (pushDefault.code === 0 && pushDefault.stdout.trim() !== "") return pushDefault.stdout.trim()
  const branch = await git.run({ repo: root, args: ["symbolic-ref", "--quiet", "--short", "HEAD"] })
  if (branch.code === 0 && branch.stdout.trim() !== "") {
    for (const suffix of ["pushRemote", "remote"] as const) {
      const configured = await git.run({
        repo: root,
        args: ["config", "--get", `branch.${branch.stdout.trim()}.${suffix}`],
      })
      if (configured.code === 0 && configured.stdout.trim() !== "") return configured.stdout.trim()
    }
  }
  const origin = await git.run({ repo: root, args: ["remote", "get-url", "--push", "origin"] })
  if (origin.code === 0) return "origin"
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
  const args = ["push", "--porcelain", "--dry-run", "--recurse-submodules=no", ...nativePushOptions(options), remote]
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

async function collectCommitRequirements(
  git: GitProcess,
  root: string,
  commits: readonly string[],
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
    for (const entry of await readCommitGitlinks(git, repository, commit)) {
      const childPath = path === "." ? entry.path : `${path}/${entry.path}`
      const child = join(repository, entry.path)
      const discovered = await required(git, child, ["rev-parse", "--show-toplevel"], "discover-submodule")
      await required(git, discovered, ["cat-file", "-e", `${entry.target}^{commit}`], "verify-submodule-commit")
      await walk(discovered, childPath, entry.target)
      requirements.push({ repository: discovered, path: childPath, target: entry.target })
    }
    visiting.delete(key)
    completed.add(key)
  }
  for (const commit of new Set(commits)) await walk(root, ".", commit)
  return requirements.filter(
    (requirement, index, all) =>
      all.findIndex(
        (candidate) => candidate.repository === requirement.repository && candidate.target === requirement.target,
      ) === index,
  )
}

async function advertisedCommitTips(git: GitProcess, repository: string, remote: string): Promise<string[]> {
  const advertised = await git.run({ repo: repository, args: ["ls-remote", "--refs", remote] })
  if (advertised.code !== 0)
    throw operationError(repository, ["ls-remote", "--refs", remote], "inspect-submodule-remote", advertised)
  const tips: string[] = []
  for (const line of advertised.stdout.split(/\r?\n/u).filter((row) => row !== "")) {
    const [oid, ref] = line.split(/\s+/u, 2)
    if (oid === undefined || ref === undefined || !OBJECT_ID.test(oid) || !ref.startsWith("refs/")) continue
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
    let tips: string[]
    try {
      tips = await advertisedCommitTips(git, requirement.repository, remote)
    } catch (error) {
      failures.push(`${remote}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    for (const tip of tips) {
      const contains = await git.run({
        repo: requirement.repository,
        args: ["merge-base", "--is-ancestor", requirement.target, tip],
      })
      if (contains.code === 0) return true
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

async function childUpdate(git: GitProcess, requirement: CommitRequirement): Promise<RefUpdate> {
  const head = await git.run({ repo: requirement.repository, args: ["symbolic-ref", "--quiet", "HEAD"] })
  const containing = await required(
    git,
    requirement.repository,
    ["for-each-ref", "--format=%(refname)", "--contains", requirement.target, "refs/heads"],
    "find-submodule-push-ref",
  )
  const candidates = containing.split(/\r?\n/u).filter((ref) => ref.startsWith("refs/heads/"))
  const current = head.code === 0 && candidates.includes(head.stdout.trim()) ? head.stdout.trim() : undefined
  const branch = current ?? (candidates.length === 1 ? candidates[0] : undefined)
  if (branch === undefined) {
    throw Object.assign(new Error(`no unambiguous local branch publishes ${requirement.target}`), {
      resultDetail: detail(
        candidates.length === 0 ? "submodule-commit-unpublishable" : "ambiguous-submodule-push-ref",
        "find-submodule-push-ref",
        candidates.length === 0
          ? `No local branch in ${requirement.path} contains ${requirement.target}.`
          : `More than one local branch in ${requirement.path} contains ${requirement.target}.`,
        {
          paths: [requirement.path],
          objectIds: [requirement.target],
          remedy: "Check out or leave exactly one intended local branch containing the recorded commit, then retry.",
        },
      ),
    })
  }
  const source = await required(
    git,
    requirement.repository,
    ["rev-parse", `${branch}^{commit}`],
    "resolve-submodule-push-source",
  )
  const remote = await configuredPushRemote(git, requirement.repository)
  return { repository: requirement.repository, remote, source, destination: branch }
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
  try {
    root = await required(git, options.repo, ["rev-parse", "--show-toplevel"], "discover-root")
    const remote = options.remote ?? (await configuredPushRemote(git, root))
    const refspecs = options.refspecs ?? []
    const selectedUpdates =
      refspecs.length === 0
        ? await configuredPushUpdates(git, root, remote, options)
        : await Promise.all(refspecs.map((refspec) => refspecUpdate(git, root, remote, refspec)))
    const rootUpdates = applyExplicitLeases(selectedUpdates, options.forceWithLease ?? [])
    if (options.recurseSubmodules === "no") {
      return pushRefUpdates({
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
    const requirements = await collectCommitRequirements(
      git,
      root,
      rootUpdates.map((update) => update.source),
    )
    if (options.recurseSubmodules === "check") {
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
              refs: rootUpdates.map((update) =>
                refResult(
                  { ...update, expectedDestination: update.expectedDestination ?? { state: "missing" } },
                  "not-run",
                  failure,
                ),
              ),
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
    const childUpdates: RefUpdate[] = []
    for (const requirement of requirements) childUpdates.push(await childUpdate(git, requirement))
    if (childUpdates.length === 0 && options.recurseSubmodules === "only") {
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
    return pushRefUpdates({
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
  } catch (error) {
    const failure = resultError(error, "plan-push")
    return failedResult(resolve(options.repo), failure)
  }
}
