const GITLINK_MODE = "160000"
/**
 * EVERY path a side changed, DELETIONS INCLUDED. A delete is a change, and it is
 * the one a rename hides: with `--no-renames` a rename is a delete at the old
 * path plus an add at the new one, so leaving `D` out lets a side that renamed a
 * file read as disjoint from a side that edited it where it used to be.
 */
const EVERY_CHANGE = "ACDMRT"
/** Paths whose composed blob a caller can read back as review evidence. */
const READABLE_BLOBS = "AMRT"
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu

export type SubmoduleConflictStage = Readonly<{
  stage: number
  mode: string
  oid: string
}>

export type SubmoduleTreeConflict = Readonly<{
  path: string
  origin?: string
  stages: readonly SubmoduleConflictStage[]
}>

export type SubmoduleResolution =
  | Readonly<{ kind: "pin"; path: string; sha: string }>
  | Readonly<{
      kind: "compose"
      path: string
      origin: string
      baseSha: string
      currentSha: string
      incomingSha: string
    }>
export type SubmodulePinResolution = Extract<SubmoduleResolution, { kind: "pin" }>
export type SubmoduleCommitResolution = Extract<SubmoduleResolution, { kind: "compose" }>

export type SubmoduleCompositionConflict = Readonly<{
  kind: "content" | "invalid-gitlink"
  path: string
}>

export type SubmoduleCompositionPlan =
  | Readonly<{ status: "planned"; resolutions: readonly SubmoduleResolution[] }>
  | Readonly<{ status: "refused"; conflicts: readonly SubmoduleCompositionConflict[] }>

export type SubmoduleCompositionGitRequest = GitProcessRequest & Readonly<{ env: NodeJS.ProcessEnv; timeoutMs: number }>

export type SubmoduleReviewedBlob = Readonly<{ path: string; oid: string; content: string }>

export type SubmoduleExecutedResolution =
  | SubmodulePinResolution
  | (SubmoduleCommitResolution & Readonly<{ sha: string; reviewedBlobs: readonly SubmoduleReviewedBlob[] }>)

export type SubmoduleCompositionExecution =
  | Readonly<{ status: "composed"; resolutions: readonly SubmoduleExecutedResolution[] }>
  | Readonly<{
      status: "refused"
      failure: Readonly<{
        kind: "conflict" | "unavailable"
        path: string
        operation: string
        detail: string
      }>
    }>

export type SubmoduleCompositionExecutionOptions = Readonly<{
  inject: Readonly<{
    git: GitProcess
    storeForOrigin(origin: string): string
  }>
  commit: Readonly<{
    author: Readonly<{ name: string; email: string }>
    message(resolution: SubmoduleCommitResolution): string
  }>
  reviewPath?: (path: string) => boolean
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  timeoutMs?: number
}>

type GitlinkStages = Readonly<{ baseSha: string; currentSha: string; incomingSha: string }>

/**
 * Classify root merge conflicts into deterministic, workflow-neutral Gitlink
 * resolutions. The caller owns authored messages, refs, refusals, and policy.
 */
export function planSubmoduleComposition(conflicts: readonly SubmoduleTreeConflict[]): SubmoduleCompositionPlan {
  const seen = new Set<string>()
  const parsed = new Map<string, GitlinkStages>()
  const refused = new Map<string, SubmoduleCompositionConflict>()

  for (const conflict of conflicts) {
    if (seen.has(conflict.path)) refused.set(conflict.path, { kind: "invalid-gitlink", path: conflict.path })
    seen.add(conflict.path)
    const stages = parseGitlinkStages(conflict)
    if (stages === undefined) {
      refused.set(conflict.path, {
        kind: hasGitlinkStage(conflict) ? "invalid-gitlink" : "content",
        path: conflict.path,
      })
      continue
    }
    parsed.set(conflict.path, stages)
    if (directPin(stages) === undefined && !validOrigin(conflict.origin)) {
      refused.set(conflict.path, { kind: "invalid-gitlink", path: conflict.path })
    }
  }

  if (refused.size > 0) {
    return { status: "refused", conflicts: [...refused.values()].toSorted((a, b) => compareText(a.path, b.path)) }
  }

  const resolutions: SubmoduleResolution[] = []
  for (const conflict of conflicts.toSorted((a, b) => compareText(a.path, b.path))) {
    const stages = parsed.get(conflict.path)
    if (stages === undefined) throw new Error(`git-super: missing planned gitlink stages for '${conflict.path}'`)
    const pin = directPin(stages)
    if (pin !== undefined) {
      resolutions.push({ kind: "pin", path: conflict.path, sha: pin })
      continue
    }
    const origin = conflict.origin
    if (origin === undefined) throw new Error(`git-super: missing planned submodule origin for '${conflict.path}'`)
    resolutions.push({ kind: "compose", path: conflict.path, origin, ...stages })
  }
  return { status: "planned", resolutions }
}

/**
 * What each side of a planned composition changed since its base, and where the
 * two sides touched the same path.
 *
 * `files` empty means the two sides are disjoint at PATH level — a stricter
 * predicate than Git's own line-level merge, and one a caller can put in a
 * refusal a person reads. `counts` is the size of each side's change, which is
 * the evidence a caller's journal carries for a composition it admitted.
 */
export type SubmoduleCompositionOverlap = Readonly<{
  path: string
  files: readonly string[]
  counts: Readonly<{ current: number; incoming: number }>
}>

/**
 * Measure every planned composition's two sides BEFORE any of them is composed.
 *
 * Separate from `composeSubmoduleCommits` because a caller that gates on path
 * disjointness must refuse before a commit object exists — a composition
 * created and then discarded leaves an object in the store that the refusal
 * says nothing about.
 */
export async function findSubmoduleCompositionOverlaps(
  plan: Extract<SubmoduleCompositionPlan, { status: "planned" }>,
  options: SubmoduleCompositionExecutionOptions,
): Promise<readonly SubmoduleCompositionOverlap[]> {
  const context = createGitContext(options)
  const overlaps: SubmoduleCompositionOverlap[] = []
  for (const resolution of plan.resolutions) {
    if (resolution.kind === "pin") continue
    const store = options.inject.storeForOrigin(resolution.origin)
    if (store.length === 0) throw new Error(`store locator returned an empty path for '${resolution.path}'`)
    const current = await changedPaths(context, store, resolution.baseSha, resolution.currentSha, EVERY_CHANGE)
    const incoming = await changedPaths(context, store, resolution.baseSha, resolution.incomingSha, EVERY_CHANGE)
    const both = new Set(incoming)
    overlaps.push({
      path: resolution.path,
      files: current.filter((path) => both.has(path)).toSorted(compareText),
      counts: { current: current.length, incoming: incoming.length },
    })
  }
  return overlaps
}

/** Construct deterministic two-parent composition commits without publishing refs. */
export async function composeSubmoduleCommits(
  plan: Extract<SubmoduleCompositionPlan, { status: "planned" }>,
  options: SubmoduleCompositionExecutionOptions,
): Promise<SubmoduleCompositionExecution> {
  const context = createGitContext(options)
  const resolutions: SubmoduleExecutedResolution[] = []
  for (const resolution of plan.resolutions) {
    if (resolution.kind === "pin") {
      resolutions.push(resolution)
      continue
    }
    const executed = await composeSubmoduleCommit(context, options, resolution)
    if (executed.status === "refused") return executed
    resolutions.push(executed.resolution)
  }
  return { status: "composed", resolutions }
}

type GitContext = Readonly<{
  git: GitProcess
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
  timeoutMs: number
}>

type ExecutedComposition =
  | Readonly<{ status: "composed"; resolution: SubmoduleExecutedResolution }>
  | Extract<SubmoduleCompositionExecution, { status: "refused" }>

async function composeSubmoduleCommit(
  context: GitContext,
  options: SubmoduleCompositionExecutionOptions,
  resolution: SubmoduleCommitResolution,
): Promise<ExecutedComposition> {
  let operation = "locate its full local store"
  try {
    const store = options.inject.storeForOrigin(resolution.origin)
    if (store.length === 0) throw new Error("store locator returned an empty path")

    operation = "inspect repository depth"
    const shallow = await requiredGit(context, store, ["rev-parse", "--is-shallow-repository"], operation)
    if (shallow !== "false") {
      return refused("unavailable", resolution.path, operation, "the submodule store is shallow")
    }

    operation = "verify planned commits"
    await requiredGit(context, store, ["cat-file", "-e", `${resolution.baseSha}^{commit}`], operation)
    await requiredGit(context, store, ["cat-file", "-e", `${resolution.currentSha}^{commit}`], operation)
    await requiredGit(context, store, ["cat-file", "-e", `${resolution.incomingSha}^{commit}`], operation)

    operation = "verify the planned merge base"
    for (const parent of [resolution.currentSha, resolution.incomingSha]) {
      if (!(await isAncestor(context, store, resolution.baseSha, parent))) {
        return refused(
          "unavailable",
          resolution.path,
          operation,
          `planned base '${resolution.baseSha}' is not an ancestor of parent '${parent}'`,
        )
      }
    }

    operation = "find a merge base"
    const mergeBase = await runGit(context, store, ["merge-base", resolution.currentSha, resolution.incomingSha])
    if (mergeBase.code === 1 && settled(mergeBase)) {
      return refused("unavailable", resolution.path, operation, "the submodule histories have no merge base")
    }
    if (!settled(mergeBase) || mergeBase.code !== 0) throw new Error(gitDetail(mergeBase))
    objectId(mergeBase.stdout, operation)

    operation = "materialize the composed tree"
    const merged = await runGit(context, store, [
      "merge-tree",
      "--write-tree",
      "--name-only",
      resolution.currentSha,
      resolution.incomingSha,
    ])
    if (merged.code === 1 && settled(merged)) {
      return refused("conflict", resolution.path, operation, gitDetail(merged))
    }
    if (!settled(merged) || merged.code !== 0) throw new Error(gitDetail(merged))
    const tree = objectId(merged.stdout.split(/\r?\n/u)[0] ?? "", operation)

    operation = "read caller-selected overlap evidence"
    const reviewedBlobs = await readBothChangedBlobs(context, store, resolution, tree, options.reviewPath)

    operation = "create the composition commit"
    const sha = await createCompositionCommit(context, store, resolution, tree, options.commit)
    return {
      status: "composed",
      resolution: { ...resolution, sha, reviewedBlobs },
    }
  } catch (cause) {
    return refused("unavailable", resolution.path, operation, messageOf(cause))
  }
}

function createGitContext(options: SubmoduleCompositionExecutionOptions): GitContext {
  const source = options.env ?? globalThis.process.env
  const env = Object.fromEntries(
    Object.entries(source).filter(([key, value]) => value !== undefined && !key.startsWith("GIT_")),
  ) as NodeJS.ProcessEnv
  return {
    git: options.inject.git,
    env: { ...env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", TZ: "UTC" },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    timeoutMs: options.timeoutMs ?? 30_000,
  }
}

async function runGit(
  context: GitContext,
  repo: string,
  args: readonly string[],
  options: Readonly<{ stdin?: string; env?: NodeJS.ProcessEnv }> = {},
): Promise<GitProcessResult> {
  return context.git.run({
    repo,
    args,
    env: options.env ?? context.env,
    timeoutMs: context.timeoutMs,
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  })
}

async function requiredGit(
  context: GitContext,
  repo: string,
  args: readonly string[],
  operation: string,
  options: Readonly<{ stdin?: string; env?: NodeJS.ProcessEnv; trim?: boolean }> = {},
): Promise<string> {
  const result = await runGit(context, repo, args, options)
  if (!settled(result) || result.code !== 0) throw new Error(`${operation} failed: ${gitDetail(result)}`)
  return options.trim === false ? result.stdout : result.stdout.trim()
}

function settled(result: GitProcessResult): boolean {
  return (
    result.failure === undefined &&
    result.timedOut !== true &&
    result.stalled !== true &&
    (result.signal === undefined || result.signal === null)
  )
}

function gitDetail(result: GitProcessResult): string {
  const output = result.stderr.trim() || result.stdout.trim() || `git exited ${result.code}`
  if (result.failure !== undefined) return `${result.failure}: ${output}`
  if (result.stalled) return `git stalled: ${output}`
  if (result.timedOut) return `git timed out: ${output}`
  if (result.signal !== undefined && result.signal !== null) return `git terminated by ${result.signal}: ${output}`
  return output
}

function objectId(output: string, operation: string): string {
  const oid = output.trim()
  if (!OBJECT_ID.test(oid)) throw new Error(`${operation} returned invalid object identity '${oid}'`)
  return oid
}

async function isAncestor(context: GitContext, store: string, base: string, tip: string): Promise<boolean> {
  const result = await runGit(context, store, ["merge-base", "--is-ancestor", base, tip])
  if (!settled(result)) throw new Error(gitDetail(result))
  if (result.code === 0) return true
  if (result.code === 1) return false
  throw new Error(gitDetail(result))
}

async function readBothChangedBlobs(
  context: GitContext,
  store: string,
  resolution: SubmoduleCommitResolution,
  tree: string,
  include: ((path: string) => boolean) | undefined,
): Promise<SubmoduleReviewedBlob[]> {
  if (include === undefined) return []
  const current = await changedPaths(context, store, resolution.baseSha, resolution.currentSha, READABLE_BLOBS)
  const incoming = new Set(
    await changedPaths(context, store, resolution.baseSha, resolution.incomingSha, READABLE_BLOBS),
  )
  const paths = current.filter((path) => incoming.has(path) && include(path)).toSorted(compareText)
  const reviewed: SubmoduleReviewedBlob[] = []
  for (const path of paths) {
    const entry = await requiredGit(context, store, ["ls-tree", "-z", tree, "--", path], `locate '${path}'`, {
      trim: false,
    })
    if (entry === "") continue
    const tab = entry.indexOf("\t")
    const header = tab === -1 ? entry : entry.slice(0, tab)
    const [mode, type, oid] = header.split(" ")
    if (mode === undefined || type !== "blob" || oid === undefined || !OBJECT_ID.test(oid)) {
      throw new Error(`composed path '${path}' is not a readable blob`)
    }
    const content = await requiredGit(context, store, ["cat-file", "blob", oid], `read '${path}'`, { trim: false })
    reviewed.push({ path, oid, content })
  }
  return reviewed
}

/**
 * `--no-renames` IS THE GATE, not a formatting preference. Under rename
 * detection `--name-only` reports only a rename's NEW path, so a file renamed on
 * one side and edited at its old path on the other reads as two disjoint paths
 * and passes a path-set intersection that should have refused it.
 */
async function changedPaths(
  context: GitContext,
  store: string,
  base: string,
  tip: string,
  filter: string,
): Promise<string[]> {
  const output = await requiredGit(
    context,
    store,
    ["diff", "--name-only", "-z", "--no-renames", `--diff-filter=${filter}`, base, tip, "--"],
    "enumerate changed paths",
    { trim: false },
  )
  return output.split("\0").filter((path) => path !== "")
}

async function createCompositionCommit(
  context: GitContext,
  store: string,
  resolution: SubmoduleCommitResolution,
  tree: string,
  commit: SubmoduleCompositionExecutionOptions["commit"],
): Promise<string> {
  const currentTime = await commitTime(context, store, resolution.currentSha)
  const incomingTime = await commitTime(context, store, resolution.incomingSha)
  const date = `${Math.max(currentTime, incomingTime)} +0000`
  const env = {
    ...context.env,
    GIT_AUTHOR_NAME: commit.author.name,
    GIT_AUTHOR_EMAIL: commit.author.email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: commit.author.name,
    GIT_COMMITTER_EMAIL: commit.author.email,
    GIT_COMMITTER_DATE: date,
  }
  return objectId(
    await requiredGit(
      context,
      store,
      ["commit-tree", tree, "-p", resolution.currentSha, "-p", resolution.incomingSha],
      "create composition commit",
      { stdin: `${commit.message(resolution)}\n`, env },
    ),
    "create composition commit",
  )
}

async function commitTime(context: GitContext, store: string, sha: string): Promise<number> {
  const output = await requiredGit(context, store, ["show", "-s", "--format=%ct", sha], "read parent time")
  if (!/^\d+$/u.test(output)) throw new Error(`parent '${sha}' has invalid commit time '${output}'`)
  const timestamp = Number(output)
  if (!Number.isSafeInteger(timestamp)) throw new Error(`parent '${sha}' commit time is outside the safe range`)
  return timestamp
}

function refused(
  kind: "conflict" | "unavailable",
  path: string,
  operation: string,
  detail: string,
): Extract<SubmoduleCompositionExecution, { status: "refused" }> {
  return { status: "refused", failure: { kind, path, operation, detail } }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function parseGitlinkStages(conflict: SubmoduleTreeConflict): GitlinkStages | undefined {
  if (conflict.path.length === 0 || conflict.path.includes("\0") || conflict.stages.length !== 3) return undefined
  if (conflict.stages.some((stage) => stage.mode !== GITLINK_MODE || !OBJECT_ID.test(stage.oid))) return undefined
  const base = conflict.stages.find(({ stage }) => stage === 1)
  const current = conflict.stages.find(({ stage }) => stage === 2)
  const incoming = conflict.stages.find(({ stage }) => stage === 3)
  if (base === undefined || current === undefined || incoming === undefined) return undefined
  if (new Set(conflict.stages.map(({ stage }) => stage)).size !== 3) return undefined
  return { baseSha: base.oid, currentSha: current.oid, incomingSha: incoming.oid }
}

function directPin(stages: GitlinkStages): string | undefined {
  if (stages.currentSha === stages.incomingSha) return stages.currentSha
  if (stages.baseSha === stages.currentSha) return stages.incomingSha
  if (stages.baseSha === stages.incomingSha) return stages.currentSha
  return undefined
}

function validOrigin(origin: string | undefined): origin is string {
  return origin !== undefined && origin.length > 0 && !origin.includes("\0")
}

function hasGitlinkStage(conflict: SubmoduleTreeConflict): boolean {
  return conflict.stages.some((stage) => stage.mode === GITLINK_MODE)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
import type { GitProcess, GitProcessRequest, GitProcessResult } from "./process.ts"
