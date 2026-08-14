import { spawnSync } from "node:child_process"
import { existsSync, realpathSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { cleanGitRepositoryEnvironment } from "./git.ts"
import { createLocalGitProcess, type GitProcess } from "./process.ts"

export const SUBMODULE_ALTERNATE_LOCATION = "superproject"
export const SUBMODULE_ALTERNATE_ERROR_STRATEGY = "info"
const MAX_CONCURRENT_SUBMODULE_UPDATES = 20

export type SubmoduleGitResult = Readonly<{ code: number; stdout: string; stderr: string }>

export type SubmoduleGit = Readonly<{
  run(repo: string, args: readonly string[], allowFailure?: boolean): Promise<SubmoduleGitResult>
  mutateConfig?(repo: string, args: readonly string[]): Promise<SubmoduleGitResult>
}>

export type SubmoduleMaterializationResult = SubmoduleGitResult &
  Readonly<{ borrowed: number; remoteFallbacks: number }>

export type SubmoduleMaterializationOptions = Readonly<{
  worktree: string
  referenceWorktree?: string
  force?: boolean
  /** Restrict only the top-level pass; nested submodules still recurse. */
  paths?: readonly string[]
  log?: (message: string) => void
}>

export type HostSubmoduleMaterializationResult = Readonly<{
  exitCode: number
  stdout: string
  stderr: string
  borrowed: number
  remoteFallbacks: number
}>

export type HostSubmoduleMaterializationOptions = Omit<SubmoduleMaterializationOptions, "force"> &
  Readonly<{ env?: NodeJS.ProcessEnv }>

const success = (): SubmoduleGitResult => ({ code: 0, stdout: "", stderr: "" })

export async function configureSubmoduleAlternatePolicy(git: SubmoduleGit, repo: string): Promise<SubmoduleGitResult> {
  for (const [key, value] of [
    ["submodule.alternateLocation", SUBMODULE_ALTERNATE_LOCATION],
    ["submodule.alternateErrorStrategy", SUBMODULE_ALTERNATE_ERROR_STRATEGY],
  ] as const) {
    const args = ["config", "--local", key, value]
    const configured =
      git.mutateConfig === undefined ? await git.run(repo, args, true) : await git.mutateConfig(repo, args)
    if (configured.code !== 0) return configured
  }
  return success()
}

type Submodule = Readonly<{ name: string; path: string }>

async function submodules(git: SubmoduleGit, repo: string): Promise<Submodule[] | SubmoduleGitResult> {
  const tracked = await git.run(repo, ["cat-file", "-e", "HEAD:.gitmodules"], true)
  if (tracked.code !== 0) return []
  const configured = await git.run(
    repo,
    ["config", "--blob", "HEAD:.gitmodules", "--get-regexp", "^submodule\\..*\\.path$"],
    true,
  )
  if (configured.code === 1 && configured.stdout === "" && configured.stderr === "") return []
  if (configured.code !== 0) return configured
  return configured.stdout
    .split(/\r?\n/u)
    .filter((row) => row !== "")
    .map((row): Submodule | undefined => {
      const match = /^(submodule\.(.+)\.path)\s+(.+)$/u.exec(row)
      return match?.[2] === undefined || match[3] === undefined ? undefined : { name: match[2], path: match[3] }
    })
    .filter((submodule): submodule is Submodule => submodule !== undefined)
}

async function requiredGitlink(git: SubmoduleGit, repo: string, path: string): Promise<string | undefined> {
  const tree = await git.run(repo, ["ls-tree", "HEAD", "--", path], true)
  if (tree.code !== 0) return undefined
  return /^160000 commit ([0-9a-f]+)\t/mu.exec(tree.stdout)?.[1]
}

async function referenceContains(git: SubmoduleGit, reference: string, sha: string): Promise<boolean> {
  if (!existsSync(reference)) return false
  return (await git.run(reference, ["cat-file", "-e", `${sha}^{commit}`], true)).code === 0
}

/**
 * Materialize isolated submodule checkouts while borrowing object history from
 * the matching checkout in the source repository. Git's documented
 * superproject alternate policy remains the fail-soft fallback for reference-
 * cloned roots; explicit per-path references close the linked-worktree gap.
 */
export async function materializeSubmodules(
  git: SubmoduleGit,
  options: SubmoduleMaterializationOptions,
): Promise<SubmoduleMaterializationResult> {
  const log = options.log ?? (() => {})
  const referenceRoot =
    options.referenceWorktree !== undefined && resolve(options.referenceWorktree) !== resolve(options.worktree)
      ? options.referenceWorktree
      : undefined
  let borrowed = 0
  let remoteFallbacks = 0

  const walk = async (
    worktree: string,
    reference: string | undefined,
    selectedPaths?: ReadonlySet<string>,
  ): Promise<SubmoduleGitResult> => {
    const policy = await configureSubmoduleAlternatePolicy(git, worktree)
    if (policy.code !== 0) return policy

    const entries = await submodules(git, worktree)
    if (!Array.isArray(entries)) return entries
    const resolved: Array<
      Readonly<{
        canBorrow: boolean
        name: string
        path: string
        referenceSubmodule: string | undefined
        required: string
      }>
    > = []
    for (const { name, path } of entries) {
      if (selectedPaths !== undefined && !selectedPaths.has(path)) continue
      const required = await requiredGitlink(git, worktree, path)
      if (required === undefined) {
        return { code: 1, stdout: "", stderr: `could not resolve gitlink '${path}' in ${worktree}` }
      }
      const referenceSubmodule = reference === undefined ? undefined : join(reference, path)
      const canBorrow = referenceSubmodule !== undefined && (await referenceContains(git, referenceSubmodule, required))
      resolved.push({ canBorrow, name, path, referenceSubmodule, required })
    }
    if (resolved.length > 0) {
      const initArgs = ["submodule", "init", "--", ...resolved.map(({ path }) => path)]
      const initialized =
        git.mutateConfig === undefined
          ? await git.run(worktree, initArgs, true)
          : await git.mutateConfig(worktree, initArgs)
      if (initialized.code !== 0) return initialized
    }
    const prepared: Array<Readonly<{ args: readonly string[]; nestedReference: string | undefined; path: string }>> = []
    for (const { canBorrow, name, path, referenceSubmodule, required } of resolved) {
      const configuredUrl = await git.run(worktree, ["config", "--get", `submodule.${name}.url`], true)
      if (configuredUrl.code !== 0 || configuredUrl.stdout.trim() === "") {
        return {
          code: configuredUrl.code === 0 ? 1 : configuredUrl.code,
          stdout: configuredUrl.stdout,
          stderr: configuredUrl.stderr || `could not resolve configured URL for submodule '${name}' in ${worktree}`,
        }
      }
      const borrowFrom = canBorrow && referenceSubmodule !== undefined ? referenceSubmodule : undefined
      const args = [
        "-c",
        `submodule.alternateLocation=${SUBMODULE_ALTERNATE_LOCATION}`,
        "-c",
        `submodule.alternateErrorStrategy=${SUBMODULE_ALTERNATE_ERROR_STRATEGY}`,
        ...(borrowFrom === undefined
          ? []
          : [
              "-c",
              "protocol.file.allow=always",
              "-c",
              `url.${pathToFileURL(borrowFrom).href}.insteadOf=${configuredUrl.stdout.trim()}`,
            ]),
        "submodule",
        "update",
        "--init",
        ...(options.force ? ["--force"] : []),
        ...(borrowFrom === undefined ? [] : ["--reference", borrowFrom]),
        "--",
        path,
      ]
      if (borrowFrom !== undefined) {
        borrowed += 1
      } else if (referenceSubmodule !== undefined) {
        remoteFallbacks += 1
        log(`[submodules] ${path}: local store lacks ${required.slice(0, 12)}; using the configured remote fallback`)
      }
      prepared.push({ args, nestedReference: borrowFrom, path })
    }
    for (let start = 0; start < prepared.length; start += MAX_CONCURRENT_SUBMODULE_UPDATES) {
      const results = await Promise.all(
        prepared.slice(start, start + MAX_CONCURRENT_SUBMODULE_UPDATES).map(async ({ args, nestedReference, path }) => {
          const updated = await git.run(worktree, args, true)
          return updated.code === 0 ? walk(join(worktree, path), nestedReference) : updated
        }),
      )
      const failed = results.find((result) => result.code !== 0)
      if (failed !== undefined) return failed
    }
    return success()
  }

  const selectedPaths = options.paths === undefined ? undefined : new Set(options.paths)
  const result = await walk(options.worktree, referenceRoot, selectedPaths)
  return { ...result, borrowed, remoteFallbacks }
}

function adaptGitProcess(process: GitProcess): SubmoduleGit {
  const run: SubmoduleGit["run"] = async (repo, args) => {
    const result = await process.run({ repo, args })
    return { code: result.code, stdout: result.stdout, stderr: result.stderr }
  }
  const mutateConfig: NonNullable<SubmoduleGit["mutateConfig"]> = async (repo, args) => {
    let result = await run(repo, args, true)
    for (
      let attempt = 1;
      result.code !== 0 && result.stderr.includes("could not lock config file") && attempt < 20;
      attempt += 1
    ) {
      await Bun.sleep(attempt * 5)
      result = await run(repo, args, true)
    }
    return result
  }
  return { run, mutateConfig }
}

/** Canonical GitProcess entry; the legacy SubmoduleGit overload is a compatibility boundary for Gate D. */
export function materializeSubmodulesWithProcess(
  process: GitProcess,
  options: SubmoduleMaterializationOptions,
): Promise<SubmoduleMaterializationResult> {
  return materializeSubmodules(adaptGitProcess(process), options)
}

function hostGit(environment: NodeJS.ProcessEnv): SubmoduleGit {
  return adaptGitProcess(createLocalGitProcess(environment))
}

function canonical(pathname: string): string {
  return existsSync(pathname) ? realpathSync(pathname) : resolve(pathname)
}

function parseWorktrees(output: string): Array<Readonly<{ path: string; branch?: string }>> {
  const entries: Array<{ path: string; branch?: string }> = []
  let current: { path: string; branch?: string } | undefined
  for (const line of output.split(/\r?\n/u)) {
    if (line.startsWith("worktree ")) {
      if (current !== undefined) entries.push(current)
      current = { path: line.slice("worktree ".length) }
    } else if (current !== undefined && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length)
    } else if (line === "" && current !== undefined) {
      entries.push(current)
      current = undefined
    }
  }
  if (current !== undefined) entries.push(current)
  return entries
}

async function mainWorktree(git: SubmoduleGit, repo: string): Promise<string | undefined> {
  const listed = await git.run(repo, ["worktree", "list", "--porcelain"], true)
  if (listed.code !== 0) return undefined
  const entries = parseWorktrees(listed.stdout)
  return entries.find((entry) => entry.branch === "refs/heads/main")?.path ?? entries[0]?.path
}

/** Host adapter for callers that need git-super to supply the Git process. */
export async function materializeSubmodulesFromLocalWorktreeParallel(
  options: HostSubmoduleMaterializationOptions,
): Promise<HostSubmoduleMaterializationResult> {
  const environment = cleanGitRepositoryEnvironment(options.env ?? process.env)
  const git = hostGit(environment)
  const discovered =
    options.referenceWorktree === undefined ? await mainWorktree(git, options.worktree) : options.referenceWorktree
  const referenceWorktree =
    discovered !== undefined && canonical(discovered) !== canonical(options.worktree) ? discovered : undefined
  const result = await materializeSubmodules(git, {
    worktree: options.worktree,
    ...(referenceWorktree === undefined ? {} : { referenceWorktree }),
    ...(options.paths === undefined ? {} : { paths: options.paths }),
    ...(options.log === undefined ? {} : { log: options.log }),
  })
  return { ...result, exitCode: result.code }
}

/**
 * Synchronous compatibility adapter for the branch-creation API. The child
 * executes the same async materializer above; no second Git traversal exists.
 */
export function materializeSubmodulesFromLocalWorktree(
  options: HostSubmoduleMaterializationOptions,
): HostSubmoduleMaterializationResult {
  const child = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./submodule-runner.ts", import.meta.url)),
      JSON.stringify({
        worktree: options.worktree,
        referenceWorktree: options.referenceWorktree,
        paths: options.paths,
      }),
    ],
    { encoding: "utf8", env: cleanGitRepositoryEnvironment(options.env ?? process.env) },
  )
  if (child.status !== 0) {
    return {
      exitCode: child.status ?? 1,
      stdout: child.stdout ?? "",
      stderr: child.stderr ?? child.error?.message ?? "git-super submodule runner failed",
      borrowed: 0,
      remoteFallbacks: 0,
    }
  }
  try {
    const payload = JSON.parse(child.stdout ?? "") as HostSubmoduleMaterializationResult & {
      messages?: readonly string[]
    }
    for (const message of payload.messages ?? []) options.log?.(message)
    return payload
  } catch (error) {
    return {
      exitCode: 1,
      stdout: child.stdout ?? "",
      stderr: `git-super submodule runner emitted invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      borrowed: 0,
      remoteFallbacks: 0,
    }
  }
}
