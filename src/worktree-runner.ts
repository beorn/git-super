import { createLocalGitWorktreeStore, type LocalGitWorktreeMutation } from "./worktree.ts"

const encoded = process.argv[2]
if (encoded === undefined) throw new Error("usage: bun worktree-runner.ts <json-request>")

try {
  const request = JSON.parse(encoded) as LocalGitWorktreeMutation
  const store = createLocalGitWorktreeStore({ repo: request.repo })
  if (request.kind === "add-detached") {
    await store.add({
      kind: "detached",
      path: request.path,
      ref: request.ref,
      ...(request.operation === undefined ? {} : { operation: request.operation }),
    })
  } else {
    await store.remove(request.path, {
      ...(request.operation === undefined ? {} : { operation: request.operation }),
      ...(request.unlock === true ? { unlock: true } : {}),
    })
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
