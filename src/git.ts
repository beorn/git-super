import { spawnSync } from "node:child_process"

const REPOSITORY_SCOPED_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX",
] as const

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env }
  for (const name of REPOSITORY_SCOPED_ENV) delete environment[name]
  return environment
}

export class GitError extends Error {
  readonly args: readonly string[]
  readonly cwd: string
  readonly exitCode: number
  readonly stderr: string

  constructor(cwd: string, args: readonly string[], exitCode: number, stderr: string) {
    super(`git ${args.join(" ")} failed in ${cwd} (exit ${exitCode})${stderr ? `\n${stderr}` : ""}`)
    this.name = "GitError"
    this.args = args
    this.cwd = cwd
    this.exitCode = exitCode
    this.stderr = stderr
  }
}

export type GitResult = Readonly<{
  exitCode: number
  stdout: string
  stderr: string
}>

export function tryGit(cwd: string, args: readonly string[]): GitResult {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: gitEnvironment(),
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
  if (result.exitCode !== 0) throw new GitError(cwd, args, result.exitCode, result.stderr)
  return result.stdout
}

export function repositoryRoot(path: string): string {
  return runGit(path, ["rev-parse", "--show-toplevel"]).trim()
}
