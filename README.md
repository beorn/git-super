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
git super --repo /work/product diff --name-only <range>
git super --repo /work/product diff --stat <range>
git super --repo /work/product diff --patch <range>
git super --repo /work/product status --porcelain
git super --repo /work/product merge-base --is-ancestor <sha> <superproject-ref>
git super --repo /work/product merge <commit> [-m <message>] [--no-verify]
git super --repo /work/product gitlink write <path> <commit>
git super --repo /work/product submodule prepare <exact-root-commit> --remote <root-remote-name-or-url> --json
git super --repo /work/product pull --ff-only [<repository> [<refspec>...]]
git super --repo /work/product push [--recurse-submodules=check|on-demand|only|no] [<remote> [<refspec>...]]
git super --repo /work/product worktree add <path> <commit> [--reference <path>]
git super --repo /work/product --json worktree remove <path> --retain <directory>
```

Use `--repo` to name the superproject explicitly for enriched operations. `diff` accepts `--diff-filter`, `--cached`, and `-z`. `status` includes tracked and untracked changes in checked-out submodules. `merge-base --is-ancestor` discovers which repository owns the first commit and compares it with that repository's pin in the selected superproject ref.

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

`merge <commit>` computes the prospective merge tree before applying it. Components with the same logical remote host and namespace as the root participate in branch forwarding; other hosted components remain `as-written` and receive no publication. Logical identities are read before Git's transport URL rewrites. A local path or file URL cannot establish this ownership relation.

The component branch comes from `submodule.<name>.branch` in local Git config, then the frozen `.gitmodules`, then the remote's symbolic HEAD. A value of `.` uses the current superproject branch and refuses when that HEAD is detached. Each participating pin is compared with the fetched branch:

| Authored pin relative to the component branch | Result                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------- |
| Equal                                         | Keep the pin.                                                                   |
| Behind                                        | Raise the root gitlink to the fetched branch tip.                               |
| Ahead                                         | Keep the authored pin and freeze its branch publication.                        |
| Diverged                                      | Refuse an incoming change; preserve an untouched divergence as `left-off-main`. |

Git applies a no-ff merge without committing it, then writes the proved raises. Existing affected component checkouts settle at their staged pins before the concluding commit and hooks. Newly introduced components use persistent stores for object and branch inspection and remain unmaterialized until a later submodule update or worktree preparation. Raises and retained anomalies appear in `Settled:` trailers; the merge also freezes recursive publication inputs for [ordered pushing](#landing-across-repositories).

When Git Super raises root gitlinks, it writes a temporary receipt at `refs/git-super/receipts/<merge>`. The receipt's sole parent is that exact merge, and its `receipt.json` contains only the automatic root-entry changes. Callers can copy the exact payload into a durable record before deleting the temporary ref under its exact old-value lease.

Human output puts the resulting merge commit on stdout and settlement evidence on stderr. `--json` emits one byte-clean `SuperMergeResult` with the same commit and gitlink rows. Its additive `checkouts` rows record, for every checkout the operation touches, the pin in root `HEAD` (`recorded`), the staged gitlink (`index`), the exact pre-operation checkout (`preCheckout`), the observed checkout, and whether it is `settled`, `settle-failed`, `restored`, `restore-failed`, or `not-run`.

A failure before the root merge exits `1` and leaves root HEAD, index and working files unchanged; object fetching and component-store preparation may already have occurred. A failure after Git applies the uncommitted merge exits `2` with `partial: true`, completed and `not-run` gitlink rows, and checkout recovery evidence. If the concluding commit is rejected, Git Super keeps the root merge and staged index intact while restoring each component to the pin recorded by pre-merge root `HEAD`. If any restoration cannot be proved, it leaves the partial state untouched, marks the affected row `restore-failed`, and prints full `recorded`, `staged-index`, `checkout`, and `pre-checkout` object IDs; do not retry until those rows are restored and re-observed. A repository with no submodules or nothing to raise still returns the real merge commit plus an empty gitlink-row set. `--no-verify` is an explicit emergency bypass, not the normal settlement path.

### Exact gitlink write

`gitlink write <path> <commit>` updates one existing mode-`160000` index entry to an exact commit without moving the submodule checkout. It is mechanics only: the caller decides which pin should be written. The command serializes through the shared mutation lock and observes the resulting stage-zero entry before reporting success; an unreadable or mismatched post-write observation reports `unknown` and exits nonzero. A lock-release failure after an accepted write reports `failed` and `partial`; if observation also failed, the repository remains `unknown` instead of being overclaimed as updated.

The path must already be a gitlink, and the exact commit object must exist in either its initialized checkout or its configured repository under the superproject's common Git directory. A missing path, repository, or commit fails with a diagnostic naming the repository, path, object ID, and remedy. The operation never adds a path, fetches a commit, checks out a submodule, or chooses whether a pin should advance. `--json` emits the same `GitSuperResult` returned by the `writeGitlink` library export.

### Prepare persistent component stores

`submodule prepare <exact-root-commit> --remote <root-remote-name-or-url> --json` reads direct gitlinks and `.gitmodules` only from the named root commit. Both inputs are required: it never chooses checkout `HEAD` or treats a stored component origin as authority. The selected root remote resolves relative frozen URLs; JSON returns the normal `GitSuperResult` envelope plus `components`, each with `name`, `path`, `gitlink`, resolved `url`, and absolute `gitdir`.

First use needs a readable root and exact commit, a configured remote name or explicit URL, and a writable root common Git directory. Under the shared mutation lock it creates one checkout-free repository at that common directory's existing `modules/<name>` location, configures it non-bare with an initial frozen URL origin, and validates it again. It performs no clone, fetch, checkout, root ref, or index write. Warm calls preserve existing store configuration and origin while returning the frozen descriptor URL. A valid root with no direct gitlinks succeeds with `components: []`.

An unresolved root, malformed frozen descriptor, unsafe store location, or partial/invalid existing store returns a nonzero structured detail; it is never an empty result or implicit reinitialization. Cold local stores are reported as `updated`, warm stores as `unchanged`, and a later failure keeps already prepared rows as partial evidence rather than deleting them. The returned stores are compatible with a later ordinary `git submodule update`; observation code remains responsible for any network read and exact-object fetch.

### Observe component tips

`git-super super observe --protocol=1` (or `git super observe --protocol=1`) reads one UTF-8 JSON document from stdin in the owning root repository:

```json
{
  "version": 1,
  "root": {
    "remote": "https://example.org/team/product.git",
    "targetRef": "refs/heads/main",
    "targetOid": "<full root OID>"
  },
  "checked": [
    {
      "mergeOid": "<actual checked merge OID>",
      "recordRef": "refs/changes/main/example",
      "recordOid": "<captured record OID>"
    }
  ],
  "fence": {
    "prefixes": ["refs/changes/main/"],
    "refs": [{ "ref": "refs/changes/main/example", "oid": "<captured record OID>" }]
  }
}
```

The caller supplies every advertised ref under its literal prefixes, including refs it does not otherwise recognize. Each checked record must match that same reading. Empty checked/history lists still examine current direct-component tips. GitSuper reads frozen descriptors and merge intents, uses the existing native branch resolver, and excludes children outside the root's hosted namespace. Local paths cannot establish ownership. A current tip is explained only by the captured root pin or the exact published source of a current checked merge; its expected old value is not authority.

Each read gets one attempt. After all child reads, a complete root advertisement must still match the captured target and selected refs. Only then does stdout receive `{version:1,outcome,message,notices:[{id,text}]}`. IDs are stable opaque strings; text is complete human wording. Exit 0 means `observed`, including an explicitly described empty observation; 3 means `changed-during-read`; 4 means `unavailable-transport`; 2 means `invalid`. Every non-observed result has no notices. These exits belong to this protocol only.

The operation may prepare and fetch into the existing isolated component object stores. It writes no caller refs, `FETCH_HEAD`, worktrees, queue records or remote refs. Missing objects, invalid descriptors and malformed witnesses remain explicit failures. The caller owns observation cadence, process deadline, raw evidence retention and notice delivery; this command adds no service or verdict cache.

### Safe fast-forward pull

`pull --ff-only` fetches and freezes one exact root target. It then works out the full graph of initialized submodules without checking anything out, fetches only the recorded child commits it is missing, and tests every working-tree change before the first write. Applying the change rechecks the remote ref and every repository HEAD under a shared lock, fast-forwards the root, then checks out changed submodules at their exact recorded commits.

If the root already contains the target, pull keeps the current root tree and its component pins and reports why it is already up to date.

With no repository or refspec, pull uses the current branch's configured upstream. With no refspec, a named repository supplies that same upstream branch. A branch with no upstream fails and says so, rather than guessing `origin/main`.

Unrelated staged, tracked, untracked, and ignored files survive. A path the incoming graph would overwrite fails before the root moves. Divergence, an unpublished detached child commit, a remote target that changes mid-operation, lock contention, and unavailable objects all fail without merging, rebasing, stashing, forcing, or resolving conflicts. If native Git fails after an earlier repository already changed, the result says `partial` and every later repository is `not-run`.

`--dry-run` fetches, freezes, and checks without changing a checkout, index, or local branch. It is evidence about the current plan, not a promise that hooks, credentials, remote refs, or filesystems will hold still afterwards.

`--json` emits one stable `GitSuperResult` on success and on operational failure alike. Success exits `0`; failed, partial, or unknown results exit nonzero.

### Recursive push

`push` resolves every nonempty selected source to an exact object ID, freezes each destination's advertised old value, and rechecks it under the shared lock. With no refspecs it asks Git for the configured default push selection using a non-writing dry run, then applies exactly those rows. General force refspecs and implicit fetch-racy leases are refused; `--force-with-lease=<full-ref>:<expected>` is explicit, and an empty expected value means create-only.

- `check` requires every recorded child commit to be reachable from at least one configured remote, then pushes root refs.
- `on-demand` pushes missing nested commits leaf-first and root-last.
- `only` publishes the nested commits and leaves root refs untouched.
- `no` pushes only the selected root refs.

An explicit `:<destination>` refspec deletes that ref only with an exact `--force-with-lease=<destination>:<expected-old-oid>` (or a library `expectedDestination`). A missing lease refuses. An already absent destination is an unchanged retry. Deletions can share one atomic root group with ordinary updates; every ref keeps its lease.

`--atomic` is passed separately to each single-repository push. **It never makes several repositories atomic.** A child may stay published when a later root hook or remote rejects; the result then reports `partial: true`. Hooks run unless `--no-verify` is explicit. Signed-push mode and push options pass through unchanged.

Hooks, credential helpers, and remote helpers stay native Git behavior. A timeout, a rejected hook, an unreachable remote, an unreadable response, or a post-write check that disagrees is never turned into an empty or successful result. Selecting no refs at all is an input error with an explanation, not a silent success. Push is covered by `tests/push.test.ts`.

### Landing across repositories

Gerrit's cross-repository topics and Aviator's ChangeSets each group several repositories' changes into one submission gesture, but neither documents an atomic guarantee once repositories start merging independently. Gerrit: a same-repository topic submits atomically, while a multi-repository topic can fail into a partial submission ([cross-repository-changes](https://gerrit-review.googlesource.com/Documentation/cross-repository-changes.html)); Gerrit documents compensating revert commits, reviewed and submitted normally, but it does not guarantee automatic rollback of a partial multi-repository submission. Aviator: a ChangeSet is validated as a whole and fails before merging if any check fails, but partial-merge behavior once some repositories in a set have already merged isn't documented ([ChangeSets](https://docs.aviator.co/mergequeue/concepts/changesets)). git-super does not claim an automatic cross-repository rollback guarantee either; see [Yrd's own README](https://github.com/beorn/yrd#readme) for submission policy, which this section does not repeat.

The merge stores resolved child remotes, destination branches, source commits and expected old values in its `Git-Super-Push:` trailer. An ordinary recursive push of that exact merge uses these frozen values even if local branch or remote configuration has changed. It validates destinations before publication, advances children before root refs, and accepts an identical completed update on retry. A third destination value refuses further writes.

A record can retain the merge through commit ancestry while keeping its own tree empty. Before publishing such a record, Git Super finds newly reachable frozen merges, retains owned child sources at `refs/git-super/pins/<oid>`, and verifies that each source can be fetched through its retained ref. This does not advance child branches. Later record pushes do not replay already published historical intents.

A fresh clone can fetch the record and retry publication of its exact merge using the retained child sources, without the author's checkout, a replacement merge, or a materialized child worktree. Retention refs are not automatically reclaimed. External components receive no retention writes; indirect record publication refuses when it cannot establish durable external sources without writing external refs.

These mechanisms provide ordered publication and retry, not cross-repository rollback. A queue must publish its checked record durably before beginning the landing and retain its root leases for recovery. [Yrd](https://github.com/beorn/yrd#readme) owns queue activation and restart orchestration; the Git Super mechanisms alone do not enable that integration.

### Worktree with submodules

`worktree add <path> <commit>` creates a detached worktree and materializes every gitlink at the pins that commit records. It is one program for the whole operation, because `git worktree add` alone leaves every submodule an empty directory and the recursive checkout that fills them is where callers reimplement borrowing, fallback limits, and rollback slightly differently each time.

Gitlinks borrow their objects from `--reference` when it is given and from the repository the command stands in otherwise. A pin the reference's stores lack is fetched from the submodule's own remote rather than refused: this is the one caller for which an unbounded fallback is correct, since a commit whose submodules the reference has never seen is exactly what it exists to check out.

**Either the worktree stands complete or it does not stand.** Any failure after `git worktree add` already succeeded removes the worktree again and exits nonzero with the reason, so a half-materialized tree is never left behind. When the removal itself fails the result is `unknown` rather than `failed`, names the surviving path, and gives the exact command that clears it — that is a different situation from a clean rollback and must not read like one.

`git super --json worktree remove <path> --retain <directory>` removes one registered, clean, unlocked linked worktree. It checks the root and every populated submodule through the existing recursive status operation. Before Git removes anything, it copies the complete per-worktree module stores (including objects, refs, and reflogs) outside both deletion paths, compares them with `diff -r`, and writes a SHA256 manifest of every file. The proof is printed on stderr before one native `git worktree remove --force`; the force only bypasses Git's blanket refusal of populated submodules after the stronger checks have passed. Dirty, locked, unreadable, or unretained work refuses. The JSON result names the proof. Choose a durable retention directory; copies are never deleted automatically and must be kept at least until the proof's `retainUntil` date and any longer retention your repository requires.

A commit that records no `.gitmodules` is not an error. The command is then exactly `git worktree add`, and the report line says so.

The report line goes to stderr and names the path, the resolved commit, the ref that was asked for when it differs, and the split:

```
worktree add /work/candidate at 0123456789abcdef0123456789abcdef01234567 (main): 3 gitlinks (2 borrowed, 1 fetched, 0 absent)
```

`borrowed + fetched + absent` always equals the number of gitlinks considered. **Borrowed** were already present in the reference's stores; **fetched** had to come over the network, whether into the reference or straight from the submodule's remote; **absent** had no reference store offered for them at all. Counting a pin that only became borrowable after a fetch as borrowed would report `0 fetched` for a run that went to the network for every single pin, so it does not.

`--json` emits one stable `GitSuperResult` carrying the path, the requested and resolved commits, and those counts. Success exits `0` and every failure exits nonzero; `git super worktree` with an unknown subcommand exits `2` with usage.

## Try it

Requires Bun 1.3.14 or newer. Native Git delegation uses `process.execve` to preserve the process ID, streams, and signals.

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
