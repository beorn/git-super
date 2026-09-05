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
git super merge <commit> [-m <message>] [--no-verify]
git super gitlink write <path> <commit>
git super pull --ff-only [<repository> [<refspec>...]]
git super push [--recurse-submodules=check|on-demand|only|no] [<remote> [<refspec>...]]
git super worktree add <path> <commit> [--reference <path>]
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

### Merge and settle gitlinks

`merge <commit>` computes the prospective merge tree before writing. A gitlink value authored by that merge must be carried by its component's freshly fetched `origin/main`; otherwise the command exits `1` with `gitlink-off-main` and leaves HEAD, the index, and the worktree unchanged. A pre-existing off-main pin is not attributed to the incoming change, so it is left untouched and reported as `left-off-main` with both object IDs.

Git first applies the no-ff merge without committing it, then raises every merged-index pin proven ancestral to and behind component main. Before the concluding commit and its hooks run, each affected component checkout is detached at its staged index pin. Hooks therefore observe one coherent product: the root index pin and the component checkout agree. Each raise is printed on stderr as `<path> <old7> -> <new7> (component main)`, and every raise or retained off-main anomaly is added to the merge commit's existing trailer block as a `Settled:` trailer. Equal pins remain unchanged; divergent pins are never overwritten.

Human output puts the resulting merge commit on stdout and settlement evidence on stderr. `--json` emits one byte-clean `SuperMergeResult` with the same commit and gitlink rows. Its additive `checkouts` rows record, for every checkout the operation touches, the pin in root `HEAD` (`recorded`), the staged gitlink (`index`), the exact pre-operation checkout (`preCheckout`), the observed checkout, and whether it is `settled`, `settle-failed`, `restored`, `restore-failed`, or `not-run`.

A failure before the root merge exits `1` and writes nothing. A failure after Git applies the uncommitted merge exits `2` with `partial: true`, completed and `not-run` gitlink rows, and checkout recovery evidence. If the concluding commit is rejected, Git Super keeps the root merge and staged index intact while restoring each component to the pin recorded by pre-merge root `HEAD`. If any restoration cannot be proved, it leaves the partial state untouched, marks the affected row `restore-failed`, and prints full `recorded`, `staged-index`, `checkout`, and `pre-checkout` object IDs; do not retry until those rows are restored and re-observed. A repository with no submodules or nothing to raise still returns the real merge commit plus an empty gitlink-row set. `--no-verify` is an explicit emergency bypass, not the normal settlement path.

### Exact gitlink write

`gitlink write <path> <commit>` updates one existing mode-`160000` index entry to an exact commit without moving the submodule checkout. It is mechanics only: the caller decides which pin should be written. The command serializes through the shared mutation lock and observes the resulting stage-zero entry before reporting success; an unreadable or mismatched post-write observation reports `unknown` and exits nonzero. A lock-release failure after an accepted write reports `failed` and `partial`; if observation also failed, the repository remains `unknown` instead of being overclaimed as updated.

The path must already be a gitlink, and the exact commit object must exist in either its initialized checkout or its configured repository under the superproject's common Git directory. A missing path, repository, or commit fails with a diagnostic naming the repository, path, object ID, and remedy. The operation never adds a path, fetches a commit, checks out a submodule, or chooses whether a pin should advance. `--json` emits the same `GitSuperResult` returned by the `writeGitlink` library export.

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

`--plan <path|->` skips refspec and submodule-policy planning and applies one frozen JSON document:

```json
{
  "updates": [
    {
      "repository": "child",
      "remote": "origin",
      "source": "<full-oid>",
      "destination": "main",
      "expectedDestination": { "state": "oid", "oid": "<full-oid>" }
    }
  ]
}
```

`repository` is `.` for the root or one exact root-relative direct gitlink path recorded by root `HEAD`. Sources and `oid` expectations are full object IDs; a bare destination such as `main` becomes `refs/heads/main`, and a missing destination uses `{"state":"missing"}`. Positional remotes/refspecs, `--recurse-submodules`, and `--force-with-lease` conflict with `--plan`; transport flags still apply to every repository group.

`--atomic` is passed separately to each single-repository push. **It never makes several repositories atomic.** A child may stay published when a later root hook or remote rejects; the result then reports `partial: true`. Hooks run unless `--no-verify` is explicit. Signed-push mode and push options pass through unchanged.

Rerunning the same frozen plan is idempotent: a destination already equal to its source is `unchanged`, even when its original expectation names the pre-push object. A different destination is `destination-changed`, and every later repository is `not-run`; Git Super never rolls an earlier successful group back.

Hooks, credential helpers, and remote helpers stay native Git behavior. A timeout, a rejected hook, an unreachable remote, an unreadable response, or a post-write check that disagrees is never turned into an empty or successful result. Selecting no refs at all is an input error with an explanation, not a silent success. Push is covered by `tests/push.test.ts`.

### Worktree with submodules

`worktree add <path> <commit>` creates a detached worktree and materializes every gitlink at the pins that commit records. It is one program for the whole operation, because `git worktree add` alone leaves every submodule an empty directory and the recursive checkout that fills them is where callers reimplement borrowing, fallback limits, and rollback slightly differently each time.

Gitlinks borrow their objects from `--reference` when it is given and from the repository the command stands in otherwise. A pin the reference's stores lack is fetched from the submodule's own remote rather than refused: this is the one caller for which an unbounded fallback is correct, since a commit whose submodules the reference has never seen is exactly what it exists to check out.

**Either the worktree stands complete or it does not stand.** Any failure after `git worktree add` already succeeded removes the worktree again and exits nonzero with the reason, so a half-materialized tree is never left behind. When the removal itself fails the result is `unknown` rather than `failed`, names the surviving path, and gives the exact command that clears it — that is a different situation from a clean rollback and must not read like one.

A commit that records no `.gitmodules` is not an error. The command is then exactly `git worktree add`, and the report line says so.

The report line goes to stderr and names the path, the resolved commit, the ref that was asked for when it differs, and the split:

```
worktree add /work/candidate at 0123456789abcdef0123456789abcdef01234567 (main): 3 gitlinks (2 borrowed, 1 fetched, 0 absent)
```

`borrowed + fetched + absent` always equals the number of gitlinks considered. **Borrowed** were already present in the reference's stores; **fetched** had to come over the network, whether into the reference or straight from the submodule's remote; **absent** had no reference store offered for them at all. Counting a pin that only became borrowable after a fetch as borrowed would report `0 fetched` for a run that went to the network for every single pin, so it does not.

`--json` emits one stable `GitSuperResult` carrying the path, the requested and resolved commits, and those counts. Success exits `0` and every failure exits nonzero; `git super worktree` with an unknown subcommand exits `2` with usage.

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
- `src/gitlink.ts` is the update-only index-pin writer. It validates the existing gitlink and target commit, writes under the shared mutation lock, and never checks out or chooses a target.
- `src/merge.ts` preflights one no-ff merge, fetches component main refs, refuses incoming off-main pins, and settles proven-behind pins while preserving partial-write evidence.
- `src/process.ts` is the public injected Git process capability. `src/result.ts` owns the shared repository/ref result vocabulary and how results aggregate.
- `src/pull.ts` owns the fetch, freeze, check, recheck, and apply fast-forward operation.
- `src/worktree-add.ts` composes the two write services: one detached `git worktree add` plus one recursive
  materialization, joined by the rollback that keeps them a single outcome.
- `src/push.ts` plans exact ref updates, proves recursive commit availability, and applies explicit per-ref leases child-first and root-last. It exposes transport mechanics and no submission, promotion, or retry policy.
- `src/commands.ts` exposes a platform-neutral command tree from the published `@silvery/command` package; every CLI request passes through `resolveInvocation()`.
- `src/report.tsx` renders the fail-loud repository witness.
- `src/cli.ts` adapts Commander parsing, stdout-compatible data, stable JSON, and the report around the command tree.

The package depends only on published packages: `@bearly/flock`, `@silvery/command`, `@silvery/commander`, `react`, and `silvery`. It contains no scheduler, no delivery daemon, no task tracker, and no imports from any host repository.

Library consumers may import the root `git-super` surface, or `git-super/gitlink` for exact index-pin writes, `git-super/commit-graph` for frozen submodule descriptors, `git-super/objects` for exact-object loading, `git-super/submodule-origin` for remote resolution, `git-super/worktree` for injected worktree mechanics, and `git-super/submodules` for recursive materialization.

**What this package deliberately does not decide:** worktree naming, leases, branch shapes, queue admission, retry policy, and lifecycle. Those are policy, they belong to the caller, and keeping them out is what lets one mechanics layer serve very different tools.
