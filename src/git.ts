import { spawnSync } from "node:child_process"

export function cleanGitEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(environment).filter(([key, value]) => value !== undefined && !key.startsWith("GIT_")),
    ),
    KM_NO_AUTO_SUBMODULE_UPDATE: "1",
  }
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

export function tryGit(cwd: string, args: readonly string[]): GitResult {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: cleanGitEnvironment(),
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) throw new Error(`failed to run git in ${cwd}: ${result.error.message}`)
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr?.trim() ?? "",
  }
}

export function runGit(cwd: string, args: readonly string[]): string {
  const result = tryGit(cwd, args)
  if (result.exitCode !== 0) throw gitError(cwd, args, result.exitCode, result.stderr)
  return result.stdout
}

export function repositoryRoot(path: string): string {
  return runGit(path, ["rev-parse", "--show-toplevel"]).trim()
}
