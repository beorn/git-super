import { spawnSync } from "node:child_process"

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

export function tryGit(cwd: string, args: readonly string[], indexFile?: string): GitResult {
  const env = cleanGitRepositoryEnvironment()
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
