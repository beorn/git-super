# git-super

Git commands that treat a superproject and its submodule interiors as one product.

Ordinary Git plumbing stops at a gitlink. `git diff --name-only A..B` reports `vendor/tool`; it does not report `vendor/tool/src/index.ts`. `git merge-base --is-ancestor <sha> <ref>` returns a false negative when the SHA belongs to a submodule and the ref is a superproject commit. `git-super` asks each question in the repository that owns the answer, prefixes inner paths, and names every repository it consulted.

## Why it exists

This defect class caused five already-landed submodule commits to be classified as not-ancestor, a moving-base delivery gauntlet from PR1986 through PR1991, the 22648 checkout timeout, and three independent changed-file guards that stayed green while missing every submodule-internal change. Git has display flags for submodule diffs, but no native flag that turns gitlinks into a composable file set.

The answer belongs at the Git invocation layer: callers change `git diff` to `git super diff`, whether they are TypeScript programs, shell scripts, CI jobs, or humans.

## Commands

```bash
git super diff --name-only <range>
git super status --porcelain
git super merge-base --is-ancestor <sha> <superproject-ref>
git super pull --ff-only [<repository> [<refspec>...]]
git super push [--recurse-submodules=check|on-demand|only|no] [<remote> [<refspec>...]]
```

`diff` accepts `--diff-filter`, `--cached`, and `-z`. `status` includes tracked and untracked changes in checked-out submodules. `merge-base --is-ancestor` discovers which repository owns the first commit and compares it with that repository's pin in the selected superproject ref.

Normal path or porcelain output stays on stdout. A Silvery-rendered consulted-repositories report goes to stderr, so existing pipelines remain composable. `--json` emits the result and consulted repositories together on stdout.

```json
{
  "consultedRepositories": [
    { "path": ".", "root": "/work/product" },
    {
      "from": "0123456789abcdef0123456789abcdef01234567",
      "path": "vendor/tool",
      "root": "/work/product/vendor/tool",
      "to": "89abcdef0123456789abcdef0123456789abcdef"
    }
  ],
  "deletedPaths": [],
  "paths": ["vendor/tool/src/index.ts"]
}
```

Missing checkouts, missing commit objects, added or removed gitlinks without a resolvable commit range, and ambiguous commit ownership all fail loudly. The tool never turns an unresolved repository boundary into an empty success.

### Safe fast-forward pull

`pull --ff-only` fetches and freezes one exact root target, discovers its complete initialized submodule graph without checking it out, fetches only missing recorded child commits, and preflights every working-tree transition before the first write. Apply rechecks the requested remote ref and every repository HEAD under the shared mutation lock, fast-forwards the root, then checks out changed submodules at the exact recorded commits.

Unrelated staged, tracked, untracked, and ignored files survive. A path that the incoming graph would overwrite fails before moving the root. Divergence, an unpublished detached child commit, a changing remote target, lock contention, and unavailable recorded objects also fail without merging, rebasing, stashing, forcing, or resolving conflicts. If native Git fails after an earlier repository changed, the result is explicitly partial and every later repository is `not-run`.

Use `--dry-run` to fetch, freeze, and preflight without changing a checkout, index, or local branch. It is evidence about the current plan, not a promise that later hooks, credentials, remote refs, or filesystems will remain unchanged.

`--json` emits one stable `GitSuperResult` on both success and operational failure. Success exits `0`; failed, partial, or unknown results exit nonzero.

### Push tool-surface audit

| Field                  | Answer                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------- |
| Surface                | `git super push`; `superPush`; `pushRefUpdates`                                         |
| Kind                   | Vendor CLI and public library                                                           |
| Read/write             | Remote-ref writes after a read-only frozen plan                                         |
| Required resources     | Git repository and objects, selected remotes, network transport, credentials, and hooks |
| Missing-resource class | Invalid user input or unavailable external state                                        |
| Failure behavior       | Nonzero stable `GitSuperResult` naming the repository, ref, phase, and safe remedy      |
| Default/empty returns  | No empty success; no selected ref updates is a teaching input error                     |
| Regression test        | `tests/push.test.ts`                                                                    |

Hooks, credential helpers, and remote helpers remain native Git behavior. A timeout, rejected hook, inaccessible remote, unreadable response, or post-write observation mismatch is never converted into an empty or successful result.

### Recursive push

`push` resolves every selected source to an exact object ID, freezes each destination's advertised old value, and rechecks it under the shared mutation lock. With no refspecs it asks Git for the configured default push selection using a non-writing porcelain dry run, then applies those exact rows. General force refspecs and implicit fetch-racy leases are refused; `--force-with-lease=<full-ref>:<expected>` is explicit, and an empty expected value means create-only.

- `check` requires every recorded child commit to be reachable from at least one configured remote, then pushes root refs.
- `on-demand` pushes missing nested commits leaf-first and root-last.
- `only` publishes the nested commits and leaves root refs untouched.
- `no` pushes only the selected root refs.

`--atomic` is passed separately to each one-repository push. It never makes several repositories atomic: a child may remain published when a later root hook or remote rejects, and the result then reports `partial: true`. Hooks run unless `--no-verify` is explicit; signed-push mode and push options are passed through unchanged.

## Try the repository before npm publication

The package name is reserved but this initial source release is not yet published. Clone it, install its public dependencies, and put its repo-local executable on `PATH` for the current command:

```bash
git clone https://github.com/beorn/git-super.git
cd git-super
bun install
PATH="$PWD/bin:$PATH" git super -h
```

No global installation is required. A clean clone has no dependency on the repository that incubated the resolver:

```bash
bun install --frozen-lockfile
bun run test
bun run typecheck
```

## Architecture

- `src/diff.ts`, `src/status.ts`, and `src/merge-base.ts` are pure read-plumbing services over an explicit Git process adapter.
- `src/worktree.ts` is the injected write-plumbing service: add, lock, unlock, inspect, exact removal, recovery, and hook quarantine. Its repository lock deliberately retains the cutover identity `.git/.../yrd-worktree-mutations/writer.lock`, so old and new callers exclude one another.
- `src/submodules.ts` is the single recursive materializer for Yrd and host adapters. It proves exact gitlinks before borrowing local objects, reports remote fallbacks, supports a top-level path allowlist, and recurses through nested gitlinks.
- `src/commit-graph.ts` is the strict, read-only parser for gitlinks recorded in an exact commit. Pull and push share it rather than interpreting `.gitmodules` independently.
- `src/process.ts` is the public injected Git process capability for graph operations. `src/result.ts` owns their shared repository/ref result vocabulary and aggregation law.
- `src/pull.ts` owns the fetch/freeze/preflight/recheck/apply fast-forward operation. It imports no scheduler, delivery, or fleet policy.
- `src/push.ts` plans exact ref updates, proves recursive commit availability, and applies explicit per-ref leases child-first and root-last. It exposes transport mechanics but no submission, promotion, or retry policy.
- `src/commands.ts` exposes the platform-neutral `CommandNode` tree from the published `@silvery/command` package and every CLI request passes through `resolveInvocation()`.
- `src/report.tsx` renders the fail-loud repository witness with canonical Silvery components and Sterling semantic tokens.
- `src/cli.ts` adapts Commander parsing, stdout-compatible data, stable JSON, and the Silvery report around the command tree.

The package depends only on published packages. It contains no delivery daemon, fleet policy, task tracker, or host-repository imports.

Library consumers may import the root `git-super` operation surface, `git-super/worktree` for injected worktree mechanics, or `git-super/submodules` for recursive materialization. Slot naming, leases, branch shapes, queue admission, retry policy, and lifecycle remain owned by callers.
