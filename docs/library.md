# Library

```ts
import { superPull } from "git-super"
import { superStatus } from "git-super/status"
```

## Runtime support

|                 | Bun 1.3.14+ | Node 24+                                 |
| --------------- | ----------- | ---------------------------------------- |
| `git-super` CLI | yes         | no: prints the Bun requirement and exits |
| Library         | yes         | yes, from the built npm package          |

The CLI hands commands that need no submodule handling to Git through `process.execve`, which keeps the process ID, streams and signals.

Node needs the built npm package and a built Node-compatible `@bearly/flock`. Installing the TypeScript source into `node_modules` does not work under Node.

- **Linux:** Node library operations are tested.
- **macOS:** Node transport and graph operations are not yet measured.
- **Locking:** the built flock package passes Node 24 acquire, contention, release and reacquire checks on Linux and macOS ([CI run](https://github.com/beorn/git-super/actions/runs/36963859423)).

## Entry points

| Import                                                      | Provides                                                                                                                                |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `git-super`                                                 | process, gitlink, pull, push and result APIs, retention checks, private Git projections, `superSubmodulePrepare`, worktree home helpers |
| `git-super/status`                                          | recursive repository inventory and status (`superStatus`)                                                                               |
| `git-super/worktree`                                        | worktree mechanics: add, lock, unlock, inspect, exact removal, recovery                                                                 |
| `git-super/submodules`                                      | recursive submodule checkout (`materializeSubmodulesWithProcess`)                                                                       |
| `git-super/gitlink`                                         | exact index commit writes (`writeGitlink`)                                                                                              |
| `git-super/commit-graph`                                    | submodule entries recorded in an exact commit                                                                                           |
| `git-super/objects`                                         | exact commit presence checks and fetches                                                                                                |
| `git-super/submodule-origin`                                | resolving `.gitmodules` URLs: absolute, URL, scp-like, relative                                                                         |
| `git-super/process`                                         | the injectable Git process                                                                                                              |
| `git-super/pull`, `git-super/push`, `git-super/push-intent` | pull, push, and the recorded push plan                                                                                                  |
| `git-super/result`                                          | the shared result types                                                                                                                 |
| `git-super/composition`                                     | every path a side changed, deletions included                                                                                           |
| `git-super/local-main`                                      | local-only check of a submodule's main branch                                                                                           |
| `git-super/archive-ref`                                     | archive refs and exact-name branch retirement                                                                                           |
| `git-super/shell-command`                                   | `shellQuote`: quote one POSIX shell argument                                                                                            |
| `git-super/exclusive`, `git-super/gitlink-carrier`          | the mutation lock, and carrier commits for submodule commits                                                                            |

## Options worth knowing

**Inspect before removing.** `inspectRemoval(path, { excludedSubmodules? })`, on the store `createGitWorktreeStore` returns, checks excluded checkouts and stores without taking locks, copying or moving anything. It returns `notCompared`, `consultedRepositories` and `uninitializedSubmodules`. It is a snapshot, not permission: `remove` checks again under its lock. An included submodule whose directory is absent or empty AND whose module repository no longer exists holds nothing and does not block removal. A directory that exists with contents, or a checkout whose module repository survives at `<git-dir>/modules/<name>`, is a `submoduleProblems` entry naming its owner's re-attach command, and blocks removal.

**`materializeSubmodulesWithProcess(process, options, processOptions)`:**

- **`source`:** `"head"` (default) reads top-level `.gitmodules` and commits from HEAD. Merge passes `"index"` to read them from the staged merge; a named path with no staged submodule entry is refused. Nested levels always read their checked-out parent's HEAD.
- **`excludedSubmodules`:** classified from the parent's recorded state before any submodule is read. Declared-absent, empty or missing checkouts are reported as skipped. Conflicting declarations, files, symlinks and unsafe parent paths are refused.
- **`resolveReferenceWorktree: true`:** finds the primary worktree, so linked worktrees borrow its prepared stores (with `--reference` and `--no-fetch`). Merge and pull turn it on.
  - A reference that removed a path on purpose is refused.
  - When run in the primary worktree, a missing commit uses normal submodule initialization. These paths are counted as `unreferenced`.
  - Failed identity reads, or a check that climbs into an enclosing repository, are refused by name.
- **`timeoutMs` and `detached`** (third argument): bound each Git command, and put each command in its own process group.

**Retries.** The default local process retries stalled `fetch` and `ls-remote` reads, up to three attempts. An exact SSH `Permission denied (publickey).` on one of those reads gets one announced retry after three seconds. The retry keeps Git's SSH command (`GIT_SSH_COMMAND`, `core.sshCommand`, `GIT_SSH`, then `ssh`) and adds `-v`, so stderr shows which key was offered. Other failures and all writes are never retried.

**Lock path.** The worktree mutation lock is `<common-dir>/yrd-worktree-mutations/writer.lock`. Any tool that locks the same file is excluded while git-super writes.

## Source layout

| File                                                | Role                                                                  |
| --------------------------------------------------- | --------------------------------------------------------------------- |
| `src/diff.ts`, `src/status.ts`, `src/merge-base.ts` | read commands                                                         |
| `src/worktree.ts`                                   | worktree write mechanics                                              |
| `src/worktree-add.ts`                               | `git worktree add` plus submodule checkout, with rollback             |
| `src/submodules.ts`                                 | the one recursive submodule checkout                                  |
| `src/commit-graph.ts`                               | reads submodule entries from an exact commit; shared by pull and push |
| `src/gitlink.ts`                                    | index-only submodule commit writer                                    |
| `src/merge.ts`                                      | merge, moving submodule commits forward                               |
| `src/pull.ts`, `src/push.ts`                        | pull and push                                                         |
| `src/process.ts`, `src/result.ts`                   | Git process and shared results                                        |
| `src/commands.ts`, `src/cli.ts`, `src/report.tsx`   | command tree, CLI parsing, and the stderr report                      |

Runtime dependencies are published npm packages only. There is no scheduler, daemon or task tracker inside.

## What the library leaves to the caller

Worktree naming, leases, branch shapes, queue admission, retry policy across queue rounds, and lifecycle are the caller's decisions. A caller's own retry does not replace the Git read retries above. Both announce their retry, and a second refusal from a Git read is still a failure.
