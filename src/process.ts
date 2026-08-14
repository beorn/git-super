import { cleanGitRepositoryEnvironment } from "./git.ts"

export type GitProcessRequest = Readonly<{
  repo: string
  args: readonly string[]
  env?: NodeJS.ProcessEnv
  stdin?: string
  signal?: AbortSignal
  timeoutMs?: number
}>

export type GitProcessResult = Readonly<{
  code: number
  stdout: string
  stderr: string
  failure?: string
  signal?: string | null
  timedOut?: boolean
  stalled?: boolean
}>

/** The one injectable Git process capability used by graph operations. */
export type GitProcess = Readonly<{
  run(request: GitProcessRequest): Promise<GitProcessResult>
}>

export function createLocalGitProcess(environment: NodeJS.ProcessEnv = process.env): GitProcess {
  const baseEnvironment = cleanGitRepositoryEnvironment(environment)
  return {
    async run(request) {
      let timedOut = false
      let child: ReturnType<typeof Bun.spawn>
      try {
        child = Bun.spawn(["git", "-C", request.repo, ...request.args], {
          env: { ...baseEnvironment, ...request.env },
          stdin: request.stdin === undefined ? "ignore" : new Blob([request.stdin]),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
          stdout: "pipe",
          stderr: "pipe",
        })
      } catch (error) {
        const failure = error instanceof Error ? error.message : String(error)
        return { code: 1, stdout: "", stderr: failure, failure }
      }
      const timer =
        request.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true
              child.kill()
            }, request.timeoutMs)
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout as ReadableStream<Uint8Array>).text(),
        new Response(child.stderr as ReadableStream<Uint8Array>).text(),
      ])
      if (timer !== undefined) clearTimeout(timer)
      return {
        code,
        stdout,
        stderr: stderr.trim(),
        ...(timedOut ? { timedOut: true } : {}),
      }
    },
  }
}
