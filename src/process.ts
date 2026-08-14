import { spawnSync } from "node:child_process"
import { cleanGitRepositoryEnvironment } from "./git.ts"

export type GitProcessRequest = Readonly<{
  repository: string
  args: readonly string[]
  environment?: NodeJS.ProcessEnv
  stdin?: string
  timeoutMs?: number
}>

export type GitProcessResult = Readonly<{
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
  signal?: NodeJS.Signals
}>

/** The one injectable Git process capability used by graph operations. */
export type GitProcess = Readonly<{
  run(request: GitProcessRequest): Promise<GitProcessResult>
}>

export function createLocalGitProcess(environment: NodeJS.ProcessEnv = process.env): GitProcess {
  const baseEnvironment = cleanGitRepositoryEnvironment(environment)
  return {
    async run(request) {
      const result = spawnSync("git", ["-C", request.repository, ...request.args], {
        encoding: "utf8",
        env: { ...baseEnvironment, ...request.environment },
        input: request.stdin,
        maxBuffer: 64 * 1024 * 1024,
        timeout: request.timeoutMs,
      })
      if (result.error !== undefined && (result.error as NodeJS.ErrnoException).code !== "ETIMEDOUT") {
        throw new Error(`failed to run git in ${request.repository}: ${result.error.message}`)
      }
      return {
        exitCode: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr?.trim() ?? result.error?.message ?? "",
        timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
        ...(result.signal === null ? {} : { signal: result.signal }),
      }
    },
  }
}
