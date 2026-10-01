import {
  createSubmoduleLogger,
  materializeSubmodulesFromLocalWorktreeParallel,
  type HostSubmoduleMaterializationOptions,
} from "./submodules.ts"

const encoded = process.argv[2]
if (encoded === undefined) {
  throw new Error(
    "usage: bun submodule-runner.ts <worktree> [reference-worktree] [path ...]\n" +
      "       bun submodule-runner.ts <worktree> -- <path ...>   (the reference discovered as with no argument)",
  )
}
const jsonMode = encoded.startsWith("{")
// `--` in the reference position names paths and leaves the reference to discovery. Without it a caller that
// syncs some paths had to name a reference, and naming the worktree itself means NO reference: every path then
// materialized from the network (hh 26874, @cto 2f497476 A).
const pathsOnly = process.argv[3] === "--"
const options = jsonMode
  ? (JSON.parse(encoded) as HostSubmoduleMaterializationOptions)
  : pathsOnly
    ? { worktree: encoded, ...(process.argv.length <= 4 ? {} : { paths: process.argv.slice(4) }) }
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
    // OF WHAT. This line used to read "materialized with 17 borrowed; 0 warmed;
    // 0 remote fallback(s)" — three counts and no total, which is precisely the
    // shape that let sixteen remote fallbacks look like a number instead of a
    // ratio on 2026-08-21. `unreferenced` appears only when non-zero, because a
    // plain clone reporting "0 with no reference store" every run is noise, but
    // a borrow-expecting caller seeing a non-zero one is the whole signal.
    const { considered, borrowed, warmed, remoteFallbacks, unreferenced } = result
    console.error(
      `[submodules] ${borrowed} of ${considered} gitlink(s) borrowed locally; ` +
        `${warmed} reference store(s) warmed; ${remoteFallbacks} remote fallback(s)` +
        (unreferenced > 0 ? `; ${unreferenced} with NO reference store supplied` : ""),
    )
  }
}
process.exitCode = result.exitCode
