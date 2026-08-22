import {
  createSubmoduleLogger,
  materializeSubmodulesFromLocalWorktreeParallel,
  type HostSubmoduleMaterializationOptions,
} from "./submodules.ts"

const encoded = process.argv[2]
if (encoded === undefined) {
  throw new Error("usage: bun submodule-runner.ts <worktree> [reference-worktree] [path ...]")
}
const jsonMode = encoded.startsWith("{")
const options = jsonMode
  ? (JSON.parse(encoded) as HostSubmoduleMaterializationOptions)
  : {
      worktree: encoded,
      ...(process.argv[3] === undefined ? {} : { referenceWorktree: process.argv[3] }),
      ...(process.argv.length <= 4 ? {} : { paths: process.argv.slice(4) }),
    }
// Collected rather than written straight through: JSON mode returns the lines
// in its payload and human mode prints them, so the sink cannot be stdout here.
const messages: string[] = []
const log = createSubmoduleLogger((line) => void messages.push(line))
const result = await materializeSubmodulesFromLocalWorktreeParallel({ ...options, log })
log.end()
if (jsonMode) {
  process.stdout.write(JSON.stringify({ ...result, messages }))
} else {
  for (const message of messages) console.error(message)
  if (result.exitCode !== 0) console.error((result.stderr || result.stdout).trim())
  else {
    console.error(
      `[submodules] materialized with ${result.borrowed} local store(s) borrowed; ${result.warmed} reference store(s) warmed; ${result.remoteFallbacks} remote fallback(s)`,
    )
  }
}
process.exitCode = result.exitCode
