# git-super

Git commands that treat a superproject and its submodule interiors as one product.

Ordinary Git plumbing stops at a gitlink. `git diff --name-only A..B` reports `vendor/tool`; it does not report `vendor/tool/src/index.ts`. `git merge-base --is-ancestor <sha> <ref>` returns a false negative when the SHA belongs to a submodule and the ref is a superproject commit. `git-super` asks each question in the repository that owns the answer, prefixes inner paths, and names every repository it consulted.

## Why it exists

**The dangerous failure is not an error — it is a check that passes because it never looked.**

A guard that lists changed files and decides whether to run tests, require a review, or block a release will happily report "nothing changed here" for a commit that rewrote a submodule entirely. It sees one path, `vendor/tool`, and no rule matches it. Nothing errors. The build is green. This is the whole class: **a gitlink is a boundary that plumbing silently treats as a leaf.**

The same boundary produces false negatives elsewhere. Ancestry questions answered against the wrong repository report already-merged commits as unmerged. Automation that retries a rebase against a moving target cannot tell which repository moved. Recursive checkouts fetch objects they already have, or hang fetching objects nobody recorded.

Git has display flags for submodule diffs, but no native flag that turns gitlinks into a composable file set. The answer belongs at the Git invocation layer: callers change `git diff` to `git super diff`, whether they are TypeScript programs, shell scripts, CI jobs, or humans.

## Commands

```bash
git super diff --name-only <range>
git super status --porcelain
git super merge-base --is-ancestor <sha> <superproject-ref>
git super pull --ff-only [<repository> [<refspec>...]]
git super push [--recurse-submodules=check|on-demand|only|no] [<remote> [<refspec>...]]
```

`diff` accepts `--diff-filter`, `--cached`, and `-z`. `status` includes tracked and untracked changes in checked-out submodules. `merge-base --is-ancestor` discovers which repository owns the first commit and compares it with that repository's pin in the selected superproject ref.

Normal path or porcelain output stays on stdout. A rendered report of the repositories consulted goes to stderr, so existing pipelines stay composable. `--json` puts the result and the consulted repositories together on stdout.

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

Missing checkouts, missing commit objects, added or removed gitlinks without a resolvable commit range, and ambiguous commit ownership all fail loudly. **The tool never turns an unresolved repository boundary into an empty success** — that is the failure it exists to prevent, so it may not commit it itself.

### Safe fast-forward pull

`pull --ff-only` fetches and freezes one exact root target. It then works out the full graph of initialized submodules without checking anything out, fetches only the recorded child commits it is missing, and tests every working-tree change before the first write. Applying the change rechecks the remote ref and every repository HEAD under a shared lock, fast-forwards the root, then checks out changed submodules at their exact recorded commits.

With no repository or refspec, pull uses the current branch's configured upstream. With no refspec, a named repository supplies that same upstream branch. A branch with no upstream fails and says so, rather than guessing `origin/main`.

Unrelated staged, tracked, untracked, and ignored files survive. A path the incoming graph would overwrite fails before the root moves. Divergence, an unpublished detached child commit, a remote target that changes mid-operation, lock contention, and unavailable objects all fail without merging, rebasing, stashing, forcing, or resolving conflicts. If native Git fails after an earlier repository already changed, the result says `partial` and every later repository is `not-run`.

`--dry-run` fetches, freezes, and checks without changing a checkout, index, or local branch. It is evidence about the current plan, not a promise that hooks, credentials, remote refs, or filesystems will hold still afterwards.

`--json` emits one stable `GitSuperResult` on success and on operational failure alike. Success exits `0`; failed, partial, or unknown results exit nonzero.

### Recursive push

`push` resolves every selected source to an exact object ID, freezes each destination's advertised old value, and rechecks it under the shared lock. With no refspecs it asks Git for the configured default push selection using a non-writing dry run, then applies exactly those rows. General force refspecs and implicit fetch-racy leases are refused; `--force-with-lease=<full-ref>:<expected>` is explicit, and an empty expected value means create-only.

- `check` requires every recorded child commit to be reachable from at least one configured remote, then pushes root refs.
- `on-demand` pushes missing nested commits leaf-first and root-last.
- `only` publishes the nested commits and leaves root refs untouched.
- `no` pushes only the selected root refs.

`--atomic` is passed separately to each single-repository push. **It never makes several repositories atomic.** A child may stay published when a later root hook or remote rejects; the result then reports `partial: true`. Hooks run unless `--no-verify` is explicit. Signed-push mode and push options pass through unchanged.

Hooks, credential helpers, and remote helpers stay native Git behavior. A timeout, a rejected hook, an unreachable remote, an unreadable response, or a post-write check that disagrees is never turned into an empty or successful result. Selecting no refs at all is an input error with an explanation, not a silent success. Push is covered by `tests/push.test.ts`.

## Try it

The package name is reserved; this first source release is not yet on npm. Clone it, install its public dependencies, and put its executable on `PATH` for one command:

```bash
git clone https://github.com/beorn/git-super.git
cd git-super
bun install
PATH="$PWD/bin:$PATH" git super -h
```

No global installation is required, and a clean clone stands alone:

```bash
bun install --frozen-lockfile
bun run test
bun run typecheck
```

## Architecture

- `src/diff.ts`, `src/status.ts`, and `src/merge-base.ts` are pure read-plumbing services over an explicit Git process adapter.
- `src/worktree.ts` is the injected write-plumbing service: add, lock, unlock, inspect, exact removal, recovery, and hook quarantine. Its lock lives at `<common-dir>/yrd-worktree-mutations/writer.lock`. That path is a compatibility name kept deliberately: an earlier tool used it, and sharing the name is what makes old and new callers exclude one another instead of writing at the same time.
- `src/submodules.ts` is the single recursive materializer. It proves exact gitlinks before borrowing local objects, reports remote fallbacks, supports a top-level path allowlist, and recurses through nested gitlinks.
- `src/submodule-origin.ts` resolves absolute, URL, scp-like, and relative `.gitmodules` origins without imposing any product policy.
- `src/commit-graph.ts` is the strict, read-only parser for gitlinks recorded in an exact commit. Pull and push share it rather than reading `.gitmodules` independently.
- `src/objects.ts` is the exact-commit presence and fetch primitive shared by graph consumers.
- `src/process.ts` is the public injected Git process capability. `src/result.ts` owns the shared repository/ref result vocabulary and how results aggregate.
- `src/pull.ts` owns the fetch, freeze, check, recheck, and apply fast-forward operation.
- `src/push.ts` plans exact ref updates, proves recursive commit availability, and applies explicit per-ref leases child-first and root-last. It exposes transport mechanics and no submission, promotion, or retry policy.
- `src/commands.ts` exposes a platform-neutral command tree from the published `@silvery/command` package; every CLI request passes through `resolveInvocation()`.
- `src/report.tsx` renders the fail-loud repository witness.
- `src/cli.ts` adapts Commander parsing, stdout-compatible data, stable JSON, and the report around the command tree.

The package depends only on published packages: `@bearly/flock`, `@silvery/command`, `@silvery/commander`, `react`, and `silvery`. It contains no scheduler, no delivery daemon, no task tracker, and no imports from any host repository.

Library consumers may import the root `git-super` surface, or `git-super/commit-graph` for frozen submodule descriptors, `git-super/objects` for exact-object loading, `git-super/submodule-origin` for remote resolution, `git-super/worktree` for injected worktree mechanics, and `git-super/submodules` for recursive materialization.

**What this package deliberately does not decide:** worktree naming, leases, branch shapes, queue admission, retry policy, and lifecycle. Those are policy, they belong to the caller, and keeping them out is what lets one mechanics layer serve very different tools.
