const GITLINK_MODE = "160000"
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

export type SubmodulePinResolution = Readonly<{
  kind: "pin"
  path: string
  sha: string
}>

export type SubmoduleCommitResolution = Readonly<{
  kind: "compose"
  path: string
  origin: string
  baseSha: string
  currentSha: string
  incomingSha: string
}>

export type SubmoduleResolution = SubmodulePinResolution | SubmoduleCommitResolution

export type SubmoduleCompositionConflict = Readonly<{
  kind: "content" | "invalid-gitlink"
  path: string
}>

export type SubmoduleCompositionPlan =
  | Readonly<{ status: "planned"; resolutions: readonly SubmoduleResolution[] }>
  | Readonly<{ status: "refused"; conflicts: readonly SubmoduleCompositionConflict[] }>

export type SubmoduleCompositionGitRequest = Readonly<{
  repo: string
  args: readonly string[]
  env: NodeJS.ProcessEnv
  stdin?: string
  signal?: AbortSignal
  timeoutMs: number
}>

export type SubmoduleCompositionGitResult = Readonly<{
  code: number
  stdout: string
  stderr: string
  failure?: string
  signal?: string | null
  timedOut?: boolean
  stalled?: boolean
}>

export type SubmoduleCompositionGit = Readonly<{
  run(request: SubmoduleCompositionGitRequest): Promise<SubmoduleCompositionGitResult>
}>

export type SubmoduleReviewedBlob = Readonly<{ path: string; oid: string; content: string }>

export type SubmoduleExecutedResolution =
  | SubmodulePinResolution
  | Readonly<{
      kind: "compose"
      path: string
      sha: string
      reviewedBlobs: readonly SubmoduleReviewedBlob[]
    }>

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
    git: SubmoduleCompositionGit
    storeForOrigin(origin: string): string
  }>
  commit: Readonly<{
    author: Readonly<{ name: string; email: string }>
    committer?: Readonly<{ name: string; email: string }>
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
  const duplicates = new Set(duplicateConflictPaths(conflicts))
  const parsed = new Map<string, GitlinkStages>()
  const refused = new Map<string, SubmoduleCompositionConflict>()

  for (const conflict of conflicts) {
    const stages = parseGitlinkStages(conflict)
    if (stages === undefined) {
      refused.set(conflict.path, {
        kind: hasGitlinkStage(conflict) ? "invalid-gitlink" : "content",
        path: conflict.path,
      })
      continue
    }
    parsed.set(conflict.path, stages)
    if (duplicates.has(conflict.path) || (directPin(stages) === undefined && !validOrigin(conflict.origin))) {
      refused.set(conflict.path, { kind: "invalid-gitlink", path: conflict.path })
    }
  }

  if (refused.size > 0) {
    return { status: "refused", conflicts: [...refused.values()].toSorted(compareConflicts) }
  }

  const resolutions: SubmoduleResolution[] = []
  for (const conflict of conflicts.toSorted(compareConflictPaths)) {
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
  git: SubmoduleCompositionGit
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
      return unavailable(resolution.path, operation, "the submodule store is shallow")
    }

    operation = "verify planned commits"
    await requiredGit(context, store, ["cat-file", "-e", `${resolution.baseSha}^{commit}`], operation)
    await requiredGit(context, store, ["cat-file", "-e", `${resolution.currentSha}^{commit}`], operation)
    await requiredGit(context, store, ["cat-file", "-e", `${resolution.incomingSha}^{commit}`], operation)

    operation = "verify the planned merge base"
    for (const parent of [resolution.currentSha, resolution.incomingSha]) {
      if (!(await isAncestor(context, store, resolution.baseSha, parent))) {
        return unavailable(
          resolution.path,
          operation,
          `planned base '${resolution.baseSha}' is not an ancestor of parent '${parent}'`,
        )
      }
    }

    operation = "find a merge base"
    const mergeBase = await runGit(context, store, ["merge-base", resolution.currentSha, resolution.incomingSha])
    if (mergeBase.code === 1 && settled(mergeBase)) {
      return unavailable(resolution.path, operation, "the submodule histories have no merge base")
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
      return conflict(resolution.path, operation, gitDetail(merged))
    }
    if (!settled(merged) || merged.code !== 0) throw new Error(gitDetail(merged))
    const tree = objectId(merged.stdout.split(/\r?\n/u)[0] ?? "", operation)

    operation = "read caller-selected overlap evidence"
    const reviewedBlobs = await readBothChangedBlobs(context, store, resolution, tree, options.reviewPath)

    operation = "create the composition commit"
    const sha = await createCompositionCommit(context, store, resolution, tree, options.commit)
    return {
      status: "composed",
      resolution: { kind: "compose", path: resolution.path, sha, reviewedBlobs },
    }
  } catch (cause) {
    return unavailable(resolution.path, operation, messageOf(cause))
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
): Promise<SubmoduleCompositionGitResult> {
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

function settled(result: SubmoduleCompositionGitResult): boolean {
  return (
    result.failure === undefined &&
    result.timedOut !== true &&
    result.stalled !== true &&
    (result.signal === undefined || result.signal === null)
  )
}

function gitDetail(result: SubmoduleCompositionGitResult): string {
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
  const current = await changedPaths(context, store, resolution.baseSha, resolution.currentSha)
  const incoming = new Set(await changedPaths(context, store, resolution.baseSha, resolution.incomingSha))
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

async function changedPaths(context: GitContext, store: string, base: string, tip: string): Promise<string[]> {
  const output = await requiredGit(
    context,
    store,
    ["diff", "--name-only", "-z", "--diff-filter=AMRT", base, tip, "--"],
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
  const committer = commit.committer ?? commit.author
  const env = {
    ...context.env,
    GIT_AUTHOR_NAME: commit.author.name,
    GIT_AUTHOR_EMAIL: commit.author.email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: committer.name,
    GIT_COMMITTER_EMAIL: committer.email,
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

function conflict(
  path: string,
  operation: string,
  detail: string,
): Extract<SubmoduleCompositionExecution, { status: "refused" }> {
  return { status: "refused", failure: { kind: "conflict", path, operation, detail } }
}

function unavailable(
  path: string,
  operation: string,
  detail: string,
): Extract<SubmoduleCompositionExecution, { status: "refused" }> {
  return { status: "refused", failure: { kind: "unavailable", path, operation, detail } }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function parseGitlinkStages(conflict: SubmoduleTreeConflict): GitlinkStages | undefined {
  if (conflict.path.length === 0 || conflict.path.includes("\0") || conflict.stages.length !== 3) return undefined
  const stages = new Map<number, SubmoduleConflictStage>()
  for (const stage of conflict.stages) {
    if (
      (stage.stage !== 1 && stage.stage !== 2 && stage.stage !== 3) ||
      stage.mode !== GITLINK_MODE ||
      !OBJECT_ID.test(stage.oid) ||
      stages.has(stage.stage)
    ) {
      return undefined
    }
    stages.set(stage.stage, stage)
  }
  const base = stages.get(1)
  const current = stages.get(2)
  const incoming = stages.get(3)
  if (base === undefined || current === undefined || incoming === undefined) return undefined
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

function duplicateConflictPaths(conflicts: readonly SubmoduleTreeConflict[]): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const conflict of conflicts) {
    if (seen.has(conflict.path)) duplicates.add(conflict.path)
    seen.add(conflict.path)
  }
  return [...duplicates]
}

function compareConflictPaths(left: SubmoduleTreeConflict, right: SubmoduleTreeConflict): number {
  return compareText(left.path, right.path)
}

function compareConflicts(left: SubmoduleCompositionConflict, right: SubmoduleCompositionConflict): number {
  return compareText(left.path, right.path)
}

function hasGitlinkStage(conflict: SubmoduleTreeConflict): boolean {
  return conflict.stages.some((stage) => stage.mode === GITLINK_MODE)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
