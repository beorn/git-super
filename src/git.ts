import { spawnSync } from "node:child_process"
import { AsyncLocalStorage } from "node:async_hooks"
import { parseIndexEntries } from "./index-entries.ts"

export type IndexGitlink = Readonly<{ path: string; indexPin: string | undefined }>

/** Parent index metadata only; shared by status and comparisons. */
export function indexGitlinks(root: string, indexFile?: string): IndexGitlink[] {
  return parseIndexEntries(
    runGit(root, ["ls-files", "--stage", "-z"], indexFile),
    (field) =>
      new Error(`git super: malformed native index entry ${JSON.stringify(field)}; reread ls-files --stage -z`),
  )
    .filter((entry) => entry.mode === "160000")
    .map((entry) => ({ path: entry.path, indexPin: entry.stage === 0 ? entry.oid : undefined }))
    .sort((left, right) => left.path.localeCompare(right.path))
}

export function validateExcludedSubmodules(paths: readonly string[] = []): void {
  for (const path of paths) {
    if (
      path.includes("\\") ||
      path.includes("\0") ||
      /[\u0000-\u001f\u007f]/u.test(path) ||
      path.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new Error(
        `git super: excluded submodule must be a literal normalized root-relative path: ${JSON.stringify(path)}`,
      )
    }
  }
}

export function isSubmoduleExcluded(path: string, exclusions: readonly string[] = []): boolean {
  return exclusions.some((excluded) => path === excluded || path.startsWith(`${excluded}/`))
}

export function cleanGitEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(environment).filter(([key, value]) => value !== undefined && !key.startsWith("GIT_")),
    ),
    KM_NO_AUTO_SUBMODULE_UPDATE: "1",
  }
}

export function cleanGitRepositoryEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...environment, KM_NO_AUTO_SUBMODULE_UPDATE: "1" }
  for (const key of Object.keys(clean)) {
    if (
      /^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|PREFIX)$/u.test(key)
    ) {
      delete clean[key]
    }
  }
  return clean
}

export type GitError = Error &
  Readonly<{
    args: readonly string[]
    cwd: string
    exitCode: number
    stderr: string
  }>

export function gitError(cwd: string, args: readonly string[], exitCode: number, stderr: string): GitError {
  return Object.assign(
    new Error(`git ${args.join(" ")} failed in ${cwd} (exit ${exitCode})${stderr ? `\n${stderr}` : ""}`),
    { name: "GitError", args, cwd, exitCode, stderr },
  )
}

export type GitResult = Readonly<{
  exitCode: number
  stdout: string
  stderr: string
}>

const executionEnvironment = new AsyncLocalStorage<NodeJS.ProcessEnv>()

/** Internal custody scope: synchronous status shares the controlled private environment. */
export function withGitEnvironment<T>(environment: NodeJS.ProcessEnv, run: () => T): T {
  return executionEnvironment.run(environment, run)
}

export function tryGit(cwd: string, args: readonly string[], indexFile?: string): GitResult {
  const env = cleanGitRepositoryEnvironment(executionEnvironment.getStore() ?? process.env)
  if (indexFile !== undefined) env.GIT_INDEX_FILE = indexFile
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) throw new Error(`failed to run git in ${cwd}: ${result.error.message}`)
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr?.trim() ?? "",
  }
}

export function runGit(cwd: string, args: readonly string[], indexFile?: string): string {
  const result = tryGit(cwd, args, indexFile)
  if (result.exitCode !== 0) throw gitError(cwd, args, result.exitCode, result.stderr)
  return result.stdout
}

export function repositoryRoot(path: string): string {
  return runGit(path, ["rev-parse", "--show-toplevel"]).trim()
}

/** Classify successful Git discovery answers, shared by synchronous and asynchronous callers.
 * Ask Git whether discovery walked up; physical and lexical paths differ under symlinked parents.
 */
export function probeRepository(
  discovered: string,
  prefix: string,
): Readonly<{ kind: "repository"; root: string } | { kind: "absent"; discovered: string }> {
  return prefix.trim() === "" ? { kind: "repository", root: discovered } : { kind: "absent", discovered }
}
