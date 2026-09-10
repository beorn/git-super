import { lstat, mkdir } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { readCommitSubmodules } from "./commit-graph.ts"
import { createExclusive, type Exclusive } from "./exclusive.ts"
import { createLocalGitProcess, type GitProcess, type GitProcessResult } from "./process.ts"
import { gitSuperResult, type GitResultDetail, type GitSuperRepositoryResult, type GitSuperResult } from "./result.ts"
import { resolveSubmoduleOrigin } from "./submodule-origin.ts"

const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu
const REMOTE_URL = /^(?:[a-z][a-z\d+.-]*:|(?:[^/@:\s]+@)?[^/:\s]+:.+)/iu

export type PreparedSubmodule = Readonly<{
  name: string
  path: string
  gitlink: string
  url: string
  gitdir: string
}>

export type SuperSubmodulePrepareResult = GitSuperResult &
  Readonly<{
    submodules: readonly PreparedSubmodule[]
  }>

export type SuperSubmodulePrepareOptions = Readonly<{
  repo: string
  commit: string
  remote: string
  git?: GitProcess
  exclusive?: Exclusive
}>

type DetailedError = Error & Readonly<{ resultDetail?: GitResultDetail }>
type InitializedStoreError = DetailedError & { initializedStore?: true }

type FrozenSubmodule = Readonly<{
  name: string
  path: string
  gitlink: string
  url: string
}>

/** Prepare durable checkout-free stores for direct gitlinks from one frozen root commit. */
export async function superSubmodulePrepare(
  options: SuperSubmodulePrepareOptions,
): Promise<SuperSubmodulePrepareResult> {
  return prepareSubmodules(options, "commit")
}

/** Internal merge path: the caller holds this repository's mutation lock. */
export async function prepareSubmoduleTreeUnderLock(
  options: SuperSubmodulePrepareOptions,
  paths: ReadonlySet<string>,
): Promise<SuperSubmodulePrepareResult> {
  return prepareSubmodules({ ...options, exclusive: { run: (operation) => operation() } }, "tree", paths)
}

async function prepareSubmodules(
  options: SuperSubmodulePrepareOptions,
  objectType: "commit" | "tree",
  paths?: ReadonlySet<string>,
): Promise<SuperSubmodulePrepareResult> {
  const repository = resolve(options.repo)
  const git = options.git ?? createLocalGitProcess()
  const frozenGit: GitProcess = {
    run(request) {
      return git.run({ ...request, env: { ...request.env, GIT_NO_LAZY_FETCH: "1" } })
    },
  }
  const repositories: GitSuperRepositoryResult[] = [{ repository, state: "unchanged", refs: [] }]
  let submodules: PreparedSubmodule[] = []
  try {
    if (!OBJECT_ID.test(options.commit)) {
      fail(
        detail("invalid-root-commit", "validate-root-commit", `Root commit ${options.commit} is not a full object ID.`),
      )
    }
    await requireObject(frozenGit, repository, options.commit, objectType)
    const selectedOrigin = await rootRemote(git, repository, options.remote)
    const frozen = (await frozenSubmodules(frozenGit, repository, options.commit, selectedOrigin)).filter(
      (submodule) => paths === undefined || paths.has(submodule.path),
    )
    if (frozen.length === 0) return result(repositories, [])
    const common = await commonDirectory(git, repository)
    submodules = frozen.map((submodule) => ({ ...submodule, gitdir: safeStorePath(common, submodule.name) }))
    const exclusive = options.exclusive ?? createExclusive(join(common, "yrd-worktree-mutations"))
    await exclusive.run(
      async () => {
        const lockedOrigin = await rootRemote(git, repository, options.remote)
        const locked = (await frozenSubmodules(frozenGit, repository, options.commit, lockedOrigin)).filter(
          (submodule) => paths === undefined || paths.has(submodule.path),
        )
        if (lockedOrigin !== selectedOrigin || !sameFrozen(frozen, locked)) {
          fail(
            detail(
              "frozen-root-input-changed",
              "revalidate-frozen-root",
              `Root commit ${options.commit} or selected remote ${options.remote} changed while submodule preparation waited for the mutation lock.`,
              { objectIds: [options.commit] },
            ),
          )
        }
        for (const submodule of submodules) {
          try {
            const state = await prepareStore(git, common, submodule)
            repositories.push({ repository: submodule.gitdir, state, refs: [] })
          } catch (error) {
            repositories.push({
              repository: submodule.gitdir,
              state: (error as InitializedStoreError).initializedStore === true ? "updated" : "failed",
              detail: failureDetail(error, "prepare-submodule-store"),
              refs: [],
            })
            throw error
          }
        }
      },
      { holder: "git super submodule prepare" },
    )
    return result(repositories, submodules)
  } catch (error) {
    const failure = failureDetail(error, "prepare-submodules")
    repositories[0] = { repository, state: "failed", detail: failure, refs: [] }
    return result(repositories, submodules, failure)
  }
}

function detail(code: string, phase: string, message: string, extra: Partial<GitResultDetail> = {}): GitResultDetail {
  return { code, phase, message, ...extra }
}

function fail(detailValue: GitResultDetail): never {
  throw Object.assign(new Error(detailValue.message), { resultDetail: detailValue }) as DetailedError
}

function failureDetail(error: unknown, phase: string): GitResultDetail {
  if (typeof error === "object" && error !== null && "resultDetail" in error) {
    const value = (error as DetailedError).resultDetail
    if (value !== undefined) return value
  }
  return detail("submodule-prepare-failed", phase, error instanceof Error ? error.message : String(error), {
    remedy: "Resolve the named repository or submodule store condition, then rerun the same prepare command.",
  })
}

function operationError(
  repository: string,
  args: readonly string[],
  phase: string,
  result: GitProcessResult,
): DetailedError {
  const cause = result.failure ?? result.stderr
  const message = result.timedOut
    ? `git ${args.join(" ")} timed out in ${repository}${cause ? `\n${cause}` : ""}`
    : `git ${args.join(" ")} failed in ${repository} (exit ${result.code})${cause ? `\n${cause}` : ""}`
  return Object.assign(new Error(message), {
    resultDetail: detail(result.timedOut ? "git-timeout" : "git-failed", phase, message),
  })
}

async function required(git: GitProcess, repository: string, args: readonly string[], phase: string): Promise<string> {
  const result = await git.run({ repo: repository, args })
  if (result.code !== 0 || result.timedOut === true || result.failure !== undefined) {
    throw operationError(repository, args, phase, result)
  }
  return result.stdout.trim()
}

async function requireObject(
  git: GitProcess,
  repository: string,
  commit: string,
  objectType: "commit" | "tree",
): Promise<void> {
  const type = await required(git, repository, ["cat-file", "-t", commit], "validate-root-commit")
  if (type !== objectType) {
    fail(
      detail(
        "invalid-root-commit",
        "validate-root-commit",
        `Root object ${commit} is a ${type}, not a ${objectType} object.`,
        { objectIds: [commit] },
      ),
    )
  }
}

function explicitRemoteUrl(value: string): boolean {
  return isAbsolute(value) || value.startsWith("./") || value.startsWith("../") || REMOTE_URL.test(value)
}

async function rootRemote(git: GitProcess, repository: string, selected: string): Promise<string> {
  if (selected.trim() === "") {
    fail(detail("missing-root-remote", "resolve-root-remote", "Root remote is required for submodule preparation."))
  }
  if (explicitRemoteUrl(selected)) return selected
  const args = ["remote", "get-url", selected]
  const configured = await git.run({ repo: repository, args })
  if (configured.code === 0 && configured.timedOut !== true && configured.failure === undefined) {
    const url = configured.stdout.trim()
    if (url === "") {
      fail(
        detail("invalid-root-remote", "resolve-root-remote", `Root remote ${selected} has an empty URL.`, {
          paths: [selected],
        }),
      )
    }
    return url
  }
  if (configured.timedOut === true || configured.failure !== undefined) {
    throw operationError(repository, args, "resolve-root-remote", configured)
  }
  fail(
    detail(
      "root-remote-unresolved",
      "resolve-root-remote",
      `Root remote ${selected} is not configured in ${repository}.`,
      { remedy: "Pass a configured root remote name or an explicit remote URL." },
    ),
  )
}

async function frozenSubmodules(
  git: GitProcess,
  repository: string,
  commit: string,
  rootOrigin: string,
): Promise<FrozenSubmodule[]> {
  return (await readCommitSubmodules(git, repository, commit)).map((submodule) => {
    if (submodule.url === undefined || submodule.url.trim() === "") {
      fail(
        detail(
          "missing-submodule-url",
          "resolve-submodule-origin",
          `Gitlink ${submodule.path} at ${commit} has no usable frozen submodule URL.`,
          { paths: [submodule.path], objectIds: [commit] },
        ),
      )
    }
    return {
      name: submodule.name,
      path: submodule.path,
      gitlink: submodule.target,
      url: resolveSubmoduleOrigin(repository, rootOrigin, submodule.url),
    }
  })
}

function sameFrozen(left: readonly FrozenSubmodule[], right: readonly FrozenSubmodule[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function commonDirectory(git: GitProcess, repository: string): Promise<string> {
  const common = await required(
    git,
    repository,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    "locate-module-store",
  )
  if (common === "" || !isAbsolute(common)) {
    fail(
      detail(
        "invalid-common-directory",
        "locate-module-store",
        `Git returned an invalid common directory for ${repository}.`,
      ),
    )
  }
  return resolve(common)
}

function safeStorePath(common: string, name: string): string {
  const parts = name.split("/")
  if (
    name === "" ||
    name.includes("\\") ||
    isAbsolute(name) ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    fail(
      detail(
        "unsafe-submodule-store",
        "validate-store-path",
        `Submodule name ${JSON.stringify(name)} is unsafe for the module store.`,
      ),
    )
  }
  const modules = resolve(common, "modules")
  const store = resolve(modules, name)
  const inside = relative(modules, store)
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    fail(
      detail(
        "unsafe-submodule-store",
        "validate-store-path",
        `Submodule name ${JSON.stringify(name)} escapes the module store.`,
      ),
    )
  }
  return store
}

async function requirePhysicalDirectories(common: string, store: string): Promise<void> {
  const relativeStore = relative(common, store)
  let current = common
  for (const segment of relativeStore.split(sep)) {
    current = join(current, segment)
    try {
      const stat = await lstat(current)
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        fail(
          detail(
            "unsafe-submodule-store",
            "validate-store-path",
            `Submodule store path ${current} is not a real directory.`,
          ),
        )
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
  }
}

async function validateStore(git: GitProcess, store: string): Promise<void> {
  const gitDir = await required(
    git,
    store,
    ["rev-parse", "--path-format=absolute", "--git-dir"],
    "validate-submodule-store",
  )
  if (resolve(gitDir) !== store) {
    fail(
      detail(
        "invalid-submodule-store",
        "validate-submodule-store",
        `Submodule store ${store} is not an independently bound Git directory.`,
      ),
    )
  }
  const commonDir = await required(
    git,
    store,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    "validate-submodule-store",
  )
  if (resolve(commonDir) !== store) {
    fail(
      detail(
        "invalid-submodule-store",
        "validate-submodule-store",
        `Submodule store ${store} shares refs or objects through ${commonDir} instead of owning an independent common directory.`,
      ),
    )
  }
  if ((await required(git, store, ["config", "--get", "core.bare"], "validate-submodule-store")) !== "false") {
    fail(
      detail(
        "invalid-submodule-store",
        "validate-submodule-store",
        `Submodule store ${store} must set core.bare=false for later ordinary materialization.`,
      ),
    )
  }
  const originArgs = ["remote", "get-url", "origin"]
  const origin = await git.run({ repo: store, args: originArgs })
  if (origin.timedOut === true || origin.failure !== undefined) {
    throw operationError(store, originArgs, "validate-submodule-store", origin)
  }
  if (origin.code !== 0 || origin.stdout.trim() === "") {
    fail(
      detail(
        "invalid-submodule-store",
        "validate-submodule-store",
        `Submodule store ${store} has no usable initial origin for later ordinary materialization.`,
      ),
    )
  }
}

async function prepareStore(
  git: GitProcess,
  common: string,
  submodule: PreparedSubmodule,
): Promise<"updated" | "unchanged"> {
  await requirePhysicalDirectories(common, submodule.gitdir)
  try {
    await lstat(submodule.gitdir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    await mkdir(dirname(submodule.gitdir), { recursive: true })
    await requirePhysicalDirectories(common, submodule.gitdir)
    try {
      await required(git, common, ["init", "--bare", submodule.gitdir], "initialize-submodule-store")
      await required(git, submodule.gitdir, ["config", "core.bare", "false"], "initialize-submodule-store")
      await required(git, submodule.gitdir, ["remote", "add", "origin", submodule.url], "initialize-submodule-store")
      await validateStore(git, submodule.gitdir)
    } catch (error) {
      let initializedStore = true
      try {
        await lstat(submodule.gitdir)
      } catch (observation) {
        if ((observation as NodeJS.ErrnoException).code === "ENOENT") initializedStore = false
      }
      const initializedError = error instanceof Error ? error : new Error(String(error))
      if (initializedStore) Object.assign(initializedError, { initializedStore: true })
      throw initializedError as InitializedStoreError
    }
    return "updated"
  }
  await validateStore(git, submodule.gitdir)
  return "unchanged"
}

function result(
  repositories: readonly GitSuperRepositoryResult[],
  submodules: readonly PreparedSubmodule[],
  failure?: GitResultDetail,
): SuperSubmodulePrepareResult {
  return { ...gitSuperResult(repositories, failure), submodules }
}
