import { copyFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { readCommitGitlinks } from "./commit-graph.ts"
import { createExclusive, type Exclusive } from "./exclusive.ts"
import { ensureCommitObject } from "./objects.ts"
import { createLocalGitProcess, type GitProcess, type GitProcessResult } from "./process.ts"
import { gitSuperResult, type GitResultDetail, type GitSuperRepositoryResult, type GitSuperResult } from "./result.ts"

export type SuperPullOptions = Readonly<{
  repo: string
  repository?: string
  refspecs?: readonly string[]
  ffOnly: boolean
  dryRun?: boolean
  timeoutMs?: number
  git?: GitProcess
  exclusive?: Exclusive
}>

type PullPlan = Readonly<{
  root: string
  repository: string
  refspecs: readonly string[]
  remoteRef?: string
  observedRemoteTarget?: string
  repositories: readonly PullRepositoryPlan[]
}>

type PullRepositoryPlan = Readonly<{
  repository: string
  path: string
  current: string
  target: string
}>

const DEFAULT_GIT_TIMEOUT_MS = 30_000
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u

function detail(code: string, phase: string, message: string, extra: Partial<GitResultDetail> = {}): GitResultDetail {
  return { code, phase, message, ...extra }
}

async function run(git: GitProcess, repository: string, args: readonly string[], environment?: NodeJS.ProcessEnv) {
  return git.run({ repo: repository, args, ...(environment === undefined ? {} : { env: environment }) })
}

async function required(git: GitProcess, repository: string, args: readonly string[], phase: string): Promise<string> {
  const result = await run(git, repository, args)
  if (result.code !== 0) throw operationError(repository, phase, args, result)
  return result.stdout.trim()
}

function operationError(
  repository: string,
  phase: string,
  args: readonly string[],
  result: GitProcessResult,
): Error & Readonly<{ resultDetail: GitResultDetail }> {
  const message = result.timedOut
    ? `git ${args.join(" ")} timed out in ${repository}`
    : `git ${args.join(" ")} failed in ${repository} (exit ${result.code})${result.stderr ? `\n${result.stderr}` : ""}`
  return Object.assign(new Error(message), {
    resultDetail: detail(result.timedOut ? "git-timeout" : "git-failed", phase, message, {
      remedy: "Resolve the reported Git condition, then rerun the same git super pull command.",
    }),
  })
}

function resultError(error: unknown, phase: string): GitResultDetail {
  if (typeof error === "object" && error !== null && "resultDetail" in error) {
    return (error as { resultDetail: GitResultDetail }).resultDetail
  }
  if (error instanceof Error && error.message.includes("worktree mutation lock is busy")) {
    return detail("mutation-lock-busy", "acquire-mutation-lock", error.message, {
      remedy: "Wait for the named lock holder to finish, then rerun git super pull.",
    })
  }
  return detail("unexpected-error", phase, error instanceof Error ? error.message : String(error), {
    remedy: "Inspect the named phase and rerun after the underlying condition is resolved.",
  })
}

async function planPull(git: GitProcess, options: SuperPullOptions): Promise<PullPlan> {
  if (!options.ffOnly)
    throw Object.assign(new Error("git super pull requires --ff-only"), {
      resultDetail: detail("ff-only-required", "validate", "git super pull requires --ff-only"),
    })
  const root = await required(git, options.repo, ["rev-parse", "--show-toplevel"], "discover-root")
  const { repository, refspecs, remoteRef, exactTarget } = await resolvePullTarget(git, root, options)
  await required(
    git,
    root,
    ["fetch", "--no-recurse-submodules", "--no-write-fetch-head", repository, ...refspecs],
    "fetch-root-target",
  )
  const observedRemoteTarget =
    remoteRef === undefined
      ? undefined
      : await observeRemoteTarget(git, root, repository, remoteRef, "observe-root-target")
  const targetObject = observedRemoteTarget ?? exactTarget
  if (targetObject === undefined) {
    throw Object.assign(new Error("git super pull could not resolve the requested root target"), {
      resultDetail: detail(
        "unresolved-root-target",
        "freeze-root-target",
        "The requested root refspec did not name one remote ref or exact object ID.",
        { remedy: "Use one unambiguous remote ref or exact commit object ID as the pull target." },
      ),
    })
  }
  await ensureCommitObject({
    repository: root,
    remote: repository,
    commit: targetObject,
    timeoutMs: options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
    git,
  })
  const target = await required(git, root, ["rev-parse", `${targetObject}^{commit}`], "freeze-root-target")
  const current = await required(git, root, ["rev-parse", "HEAD^{commit}"], "freeze-root-current")
  const ancestor = await run(git, root, ["merge-base", "--is-ancestor", current, target])
  if (ancestor.code !== 0) {
    throw Object.assign(new Error(`git super pull --ff-only refused divergent root ${root}`), {
      resultDetail: detail(
        "non-fast-forward",
        "prove-root-ancestry",
        `Current ${current} is not an ancestor of ${target}.`,
        {
          objectIds: [current, target],
          remedy: "Reconcile the local branch explicitly; git super pull never merges, rebases, stashes, or forces.",
        },
      ),
    })
  }
  const repositories = await freezeRepositoryGraph(git, root, current, target)
  await proveRepositoryTransitions(git, repositories)
  return {
    root,
    repository,
    refspecs,
    ...(remoteRef === undefined ? {} : { remoteRef }),
    ...(observedRemoteTarget === undefined ? {} : { observedRemoteTarget }),
    repositories,
  }
}

async function configuredUpstream(
  git: GitProcess,
  root: string,
): Promise<Readonly<{ repository: string; ref: string }>> {
  const branch = await run(git, root, ["symbolic-ref", "--quiet", "--short", "HEAD"])
  if (branch.code !== 0 || branch.stdout.trim() === "") {
    throw Object.assign(new Error("git super pull requires a configured upstream when no root refspec is given"), {
      resultDetail: detail(
        "configured-upstream-required",
        "resolve-default-target",
        "The current checkout has no branch whose configured upstream can select the pull target.",
        { remedy: "Check out a branch with an upstream, or name both the repository and root refspec explicitly." },
      ),
    })
  }
  const configured = await required(
    git,
    root,
    [
      "for-each-ref",
      "--count=1",
      "--format=%(upstream:remotename)%00%(upstream:remoteref)",
      `refs/heads/${branch.stdout.trim()}`,
    ],
    "resolve-default-target",
  )
  const [repository, ref] = configured.split("\0")
  if (repository === undefined || repository === "" || ref === undefined || ref === "") {
    throw Object.assign(new Error("git super pull requires a configured upstream when no root refspec is given"), {
      resultDetail: detail(
        "configured-upstream-required",
        "resolve-default-target",
        `Branch ${branch.stdout.trim()} has no configured upstream.`,
        { remedy: "Configure the branch upstream, or name both the repository and root refspec explicitly." },
      ),
    })
  }
  return { repository, ref }
}

async function resolvePullTarget(
  git: GitProcess,
  root: string,
  options: SuperPullOptions,
): Promise<Readonly<{ repository: string; refspecs: readonly string[]; remoteRef?: string; exactTarget?: string }>> {
  const refspecs = options.refspecs ?? []
  if (refspecs.length > 1) {
    throw Object.assign(new Error("git super pull currently requires one root refspec"), {
      resultDetail: detail("multiple-pull-heads", "validate-refspecs", "More than one root refspec was requested.", {
        remedy: "Pull one root branch at a time so --ff-only has one frozen target.",
      }),
    })
  }
  if (refspecs.length === 0) {
    const upstream = await configuredUpstream(git, root)
    return {
      repository: options.repository ?? upstream.repository,
      refspecs: [upstream.ref],
      remoteRef: upstream.ref,
    }
  }
  const repository = options.repository ?? (await configuredUpstream(git, root)).repository
  const requested = refspecs[0]
  if (requested === undefined) throw new Error("git-super: validated pull target contained no refspec")
  const source = requested.replace(/^\+/u, "").split(":", 1)[0]
  return {
    repository,
    refspecs,
    ...(source === undefined || source === ""
      ? {}
      : OBJECT_ID.test(source)
        ? { exactTarget: source }
        : { remoteRef: source }),
  }
}

async function observeRemoteTarget(
  git: GitProcess,
  root: string,
  repository: string,
  remoteRef: string,
  phase: string,
): Promise<string> {
  const observed = await required(git, root, ["ls-remote", "--exit-code", repository, remoteRef], phase)
  const objectIds = [
    ...new Set(
      observed
        .split(/\r?\n/u)
        .filter((line) => line !== "")
        .map((line) => line.split(/\s/u, 1)[0])
        .filter((oid): oid is string => oid !== undefined && OBJECT_ID.test(oid)),
    ),
  ]
  if (objectIds.length !== 1 || objectIds[0] === undefined) {
    throw Object.assign(new Error(`remote ref ${remoteRef} did not resolve to exactly one object`), {
      resultDetail: detail(
        "ambiguous-remote-target",
        phase,
        `Remote ref ${remoteRef} did not resolve to exactly one object.`,
        {
          objectIds,
          remedy: "Use one unambiguous branch or ref as the pull target.",
        },
      ),
    })
  }
  return objectIds[0]
}

async function refuseUnpublishedDetachedHead(
  git: GitProcess,
  repository: string,
  recorded: string | undefined,
  actual: string,
): Promise<void> {
  if (recorded === undefined || actual === recorded) return
  const branch = await run(git, repository, ["symbolic-ref", "-q", "HEAD"])
  if (branch.code === 0) return
  const refs = await required(
    git,
    repository,
    ["for-each-ref", "--format=%(refname)", "--contains", actual],
    "find-durable-submodule-ref",
  )
  if (refs !== "") return
  throw Object.assign(
    new Error(`detached submodule HEAD ${actual} in ${repository} is not reachable from a durable ref`),
    {
      resultDetail: detail(
        "unpublished-detached-submodule",
        "protect-submodule-head",
        `Detached HEAD ${actual} differs from recorded commit ${recorded ?? "missing"} and is not reachable from a durable ref.`,
        {
          objectIds: [actual, ...(recorded === undefined ? [] : [recorded])],
          remedy: "Create a branch or tag for the detached commit, then rerun git super pull.",
        },
      ),
    },
  )
}

async function freezeRepositoryGraph(
  git: GitProcess,
  root: string,
  current: string,
  target: string,
): Promise<PullRepositoryPlan[]> {
  const repositories: PullRepositoryPlan[] = []
  const walk = async (repository: string, path: string, from: string, to: string): Promise<void> => {
    repositories.push({ repository, path, current: from, target: to })
    const entries = await readCommitGitlinks(git, repository, to)
    for (const entry of entries) {
      const childPath = path === "." ? entry.path : `${path}/${entry.path}`
      const childRepository = join(repository, entry.path)
      const discovered = await run(git, childRepository, ["rev-parse", "--show-toplevel"])
      if (discovered.code !== 0) {
        throw Object.assign(new Error(`submodule ${childPath} is not initialized`), {
          resultDetail: detail(
            "submodule-not-initialized",
            "freeze-target-graph",
            `Submodule ${childPath} is not initialized.`,
            {
              paths: [childPath],
              objectIds: [entry.target],
              remedy: "Initialize the recorded submodule checkout, then rerun git super pull.",
            },
          ),
        })
      }
      await ensureCommitObject({ repository: childRepository, remote: "origin", commit: entry.target, git })
      const actual = await required(git, childRepository, ["rev-parse", "HEAD^{commit}"], "freeze-submodule-current")
      const priorTree = await run(git, repository, ["ls-tree", from, "--", entry.path])
      const recorded = /^160000 commit ([0-9a-f]+)\t/mu.exec(priorTree.stdout)?.[1]
      await refuseUnpublishedDetachedHead(git, childRepository, recorded, actual)
      await walk(childRepository, childPath, actual, entry.target)
    }
  }
  await walk(root, ".", current, target)
  return repositories
}

async function proveRepositoryTransitions(git: GitProcess, repositories: readonly PullRepositoryPlan[]): Promise<void> {
  for (const repository of repositories) {
    await proveTreeTransition(git, repository.repository, repository.current, repository.target)
  }
}

async function proveTreeTransition(
  git: GitProcess,
  repository: string,
  current: string,
  target: string,
): Promise<void> {
  if (current === target) return
  await refuseIgnoredIncomingCollisions(git, repository, current, target)
  const index = await required(git, repository, ["rev-parse", "--git-path", "index"], "locate-index")
  const sourceIndex = isAbsolute(index) ? index : resolve(repository, index)
  const scratch = mkdtempSync(join(tmpdir(), "git-super-index-"))
  const temporaryIndex = join(scratch, "index")
  try {
    copyFileSync(sourceIndex, temporaryIndex)
    const transition = await run(
      git,
      repository,
      ["-c", "submodule.recurse=false", "read-tree", "-n", "-m", "-u", current, target],
      { GIT_INDEX_FILE: temporaryIndex },
    )
    if (transition.code !== 0) throw operationError(repository, "preflight-tree-transition", ["read-tree"], transition)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

function nulPaths(output: string): string[] {
  return output.split("\0").filter((path) => path !== "")
}

function pathsCollide(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

async function refuseIgnoredIncomingCollisions(
  git: GitProcess,
  repository: string,
  current: string,
  target: string,
): Promise<void> {
  const changed = await run(git, repository, [
    "diff",
    "--name-only",
    "--diff-filter=ACMRTUXB",
    "-z",
    current,
    target,
    "--",
    ".",
  ])
  if (changed.code !== 0) {
    throw operationError(repository, "preflight-ignored-paths", ["diff", current, target], changed)
  }
  const incoming = nulPaths(changed.stdout)
  if (incoming.length === 0) return
  const ignored = new Set<string>()
  for (let offset = 0; offset < incoming.length; offset += 128) {
    const batch = incoming.slice(offset, offset + 128)
    const listed = await run(git, repository, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "--no-empty-directory",
      "-z",
      "--",
      ...batch,
    ])
    if (listed.code !== 0) {
      throw operationError(repository, "preflight-ignored-paths", ["ls-files", "--ignored"], listed)
    }
    for (const path of nulPaths(listed.stdout)) ignored.add(path.replace(/\/+$/u, ""))
  }
  const collisions = [...ignored].flatMap((ignoredPath) =>
    incoming
      .filter((incomingPath) => pathsCollide(ignoredPath, incomingPath))
      .map((incomingPath) => ({
        ignoredPath,
        incomingPath,
      })),
  )
  if (collisions.length === 0) return
  const paths = [...new Set(collisions.flatMap(({ ignoredPath, incomingPath }) => [ignoredPath, incomingPath]))].sort()
  const message = `Ignored operator bytes collide with incoming tracked paths: ${collisions
    .map(({ ignoredPath, incomingPath }) => `${ignoredPath} <- ${incomingPath}`)
    .join(", ")}.`
  throw Object.assign(new Error(message), {
    resultDetail: detail("ignored-path-collision", "preflight-tree-transition", message, {
      paths,
      objectIds: [current, target],
      remedy: "Move or preserve the ignored bytes explicitly, then rerun git super pull.",
    }),
  })
}

async function lockDirectory(git: GitProcess, root: string): Promise<string> {
  const common = await required(git, root, ["rev-parse", "--git-common-dir"], "locate-mutation-lock")
  return join(isAbsolute(common) ? common : resolve(root, common), "yrd-worktree-mutations")
}

function repositoryResult(
  repository: PullRepositoryPlan,
  state: "updated" | "unchanged" | "failed" | "not-run",
  failure?: GitResultDetail,
): GitSuperRepositoryResult {
  return {
    repository: repository.repository,
    state,
    ...(failure === undefined ? {} : { detail: failure }),
    refs: [
      {
        source: repository.target,
        destination: "HEAD",
        state,
        ...(failure === undefined ? {} : { detail: failure }),
      },
    ],
  }
}

/** Fetch, freeze, preflight, recheck under the shared mutation lock, then fast-forward. */
export async function superPull(options: SuperPullOptions): Promise<GitSuperResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    const failure = detail("invalid-timeout", "validate", "Git command timeout must be a positive finite number.")
    return gitSuperResult([{ repository: resolve(options.repo), state: "failed", detail: failure, refs: [] }], failure)
  }
  const process = options.git ?? createLocalGitProcess()
  const git: GitProcess = {
    run: (request) => process.run({ ...request, timeoutMs: request.timeoutMs ?? timeoutMs }),
  }
  let plan: PullPlan
  try {
    plan = await planPull(git, options)
  } catch (error) {
    const failure = resultError(error, "plan")
    return gitSuperResult([{ repository: resolve(options.repo), state: "failed", detail: failure, refs: [] }], failure)
  }
  const changed = plan.repositories.some((repository) => repository.current !== repository.target)
  if (!changed || options.dryRun) {
    return gitSuperResult(
      plan.repositories.map((repository) =>
        repositoryResult(repository, repository.current === repository.target ? "unchanged" : "updated"),
      ),
    )
  }
  const exclusive = options.exclusive ?? createExclusive(await lockDirectory(git, plan.root))
  try {
    return await exclusive.run(
      async () => {
        if (plan.remoteRef !== undefined && plan.observedRemoteTarget !== undefined) {
          const observed = await observeRemoteTarget(
            git,
            plan.root,
            plan.repository,
            plan.remoteRef,
            "recheck-root-target",
          )
          if (observed !== plan.observedRemoteTarget) {
            throw Object.assign(new Error(`requested remote target changed after planning`), {
              resultDetail: detail(
                "target-changed",
                "recheck-root-target",
                `${plan.remoteRef} changed after planning.`,
                {
                  objectIds: [plan.observedRemoteTarget, observed],
                  remedy: "Rerun git super pull so it can freeze and preflight the new target.",
                },
              ),
            })
          }
        }
        for (const repository of plan.repositories) {
          const current = await required(
            git,
            repository.repository,
            ["rev-parse", "HEAD^{commit}"],
            "recheck-repository-current",
          )
          if (current !== repository.current) {
            throw Object.assign(
              new Error(`repository HEAD changed after planning: expected ${repository.current}, found ${current}`),
              {
                resultDetail: detail(
                  "repository-changed",
                  "recheck-repository-current",
                  `${repository.path} HEAD changed after planning.`,
                  {
                    paths: [repository.path],
                    objectIds: [repository.current, current],
                    remedy: "Rerun git super pull so it can plan against the new repository state.",
                  },
                ),
              },
            )
          }
        }
        await proveRepositoryTransitions(git, plan.repositories)
        const results: GitSuperRepositoryResult[] = []
        for (const [index, repository] of plan.repositories.entries()) {
          if (repository.current === repository.target) {
            results.push(repositoryResult(repository, "unchanged"))
            continue
          }
          const args =
            index === 0
              ? ["-c", "submodule.recurse=false", "merge", "--ff-only", "--no-edit", repository.target]
              : ["-c", "submodule.recurse=false", "checkout", "--detach", repository.target]
          const applied = await run(git, repository.repository, args)
          if (applied.code !== 0) {
            const failure = operationError(
              repository.repository,
              index === 0 ? "apply-root" : "apply-submodule",
              args,
              applied,
            ).resultDetail
            results.push(repositoryResult(repository, "failed", failure))
            for (const remaining of plan.repositories.slice(index + 1)) {
              results.push(repositoryResult(remaining, "not-run", failure))
            }
            return gitSuperResult(results, failure)
          }
          results.push(repositoryResult(repository, "updated"))
        }
        return gitSuperResult(results)
      },
      { holder: "git super pull --ff-only" },
    )
  } catch (error) {
    const failure = resultError(error, "apply")
    const root = plan.repositories[0]
    if (root === undefined) throw new Error("git-super: pull plan contained no root repository")
    return gitSuperResult(
      [
        repositoryResult(root, "failed", failure),
        ...plan.repositories.slice(1).map((repository) => repositoryResult(repository, "not-run", failure)),
      ],
      failure,
    )
  }
}
