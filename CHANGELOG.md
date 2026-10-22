# Changelog

## 0.9.0 — 2026-10-22

- Breaking change: remove `git super branch retire` and the root `superBranchRetire` (`SuperBranchRetireOptions`, `SuperBranchRetireResult`) export from `git-super`; `--repo <path> branch …` is no longer special-cased and fails with `unknown command 'branch'` while `git super -C <path> branch …` continues to delegate to native Git.
- Add `describeModuleStores`, which names every module store a worktree removal archives or releases. Removal now archives a slot's module stores one at a time before removing the slot: it never replaces an archive, reads each store's value from its remote, releases a store only when every commit is on a remote, and counts remote tags as durable. A remote that rejects the archive push stops the removal and keeps the slot.
- `prune` recovers each prunable worktree registration instead of running a raw `git worktree prune`. The parent store owns a component's gitlink move, and a clean component store proven on its target is admitted without a preserved ref.
- `pull` reads only the exact remote ref, never a tail match.

## 0.8.0 — 2026-10-21

- Add `git-super/remote` helpers for repository identity, URL spelling and clone-directory naming across supported network transports. Hosted push ownership retains its existing namespace checks.
- Let native Git delegation accept an explicit environment; export repository-environment cleanup while preserving credentials and user Git configuration.
- Strengthen worktree removal with complete commit-custody checks under removal leases, bounded streams, and protection for surviving alternate-object dependencies. Read canonical legacy archive custody and recognize archive ancestry during push.
- Keep frozen task publication within requested destinations and preserve main as the first parent of two-sided component merges.
- Improve status for absent checkouts with retained module repositories, label diff pins already at the target, retain native Git lookup errors, and provide exact repository/retry guidance. Delegate ordinary branch forms under `--repo` and refresh contended-lock holder progress.

## 0.7.0 — 2026-10-17

- Export `shellQuote` through `git-super/shell-command`, including its published JavaScript and types. It quotes one argument for a POSIX shell; SSH retry commands and pull hook wrappers now reuse that implementation.
- Add archive-backed local branch retirement with `git super branch retire <branch> --tip <commit>`. Retirement requires the exact tip in archive custody and preserves advanced or held branches.
- Compact retained child Git metadata after native worktree removal, preserving ref values and local reflogs. Expose retained-copy verification and compaction, unregister destroyed nested linked checkouts, and report partial cleanup and retained-copy failures explicitly.
- Improve recursive push results with explicit lease checks, porcelain outcomes and remote readback for ambiguous results. Component publication preserves the published main first-parent chain, and observed descendants can prove ancestor custody without another remote read.
- Add `diff --component-base <ref>`, cross-gitlink `readCommitPath`, and exact-tip worktree detachment without changing checkout files.
- API change: `superIsAncestor` returns synchronously and throws directly. Callers using promise-specific `.then` or `.catch` should use the returned result and ordinary `try`/`catch`.
- API change: `readPrivateSubmodulePaths` is replaced by `readPrivateSubmodules`, which returns named `{ name, path }` records. Callers needing only paths should select each record's `path`.
- Development: use Vitest 5 for standalone tests, matching workspace validation.

## 0.6.0 — 2026-10-10

- Export `POOL_ROOT_CONFIG_KEY` and `WorktreeHomeOptions` from the package root. `worktreeHomeRoot` now reads the repository's `worktree.poolRoot` declaration, resolves relative paths against its main worktree and preserves the environment/default fallback. This makes the published API usable by Bearly's worktree helpers.
- Add checkout metadata inspection, durable private Git projections and read-only retention verification. Retirement preserves borrowed objects, requires projection-bound stop evidence and bounds Git children and retained metadata.
- Preserve declared private-submodule exclusions and frozen merge exclusions through merge, push and materialization. Preview merges can disable retained pins with `--no-retain-pins`.
- Improve recursive Git diagnostics and recovery: resolve abbreviated component commits without losing ambiguity, retain missing-store and failed-probe causes, wait through bounded index-lock contention, and recover worktree removal after its old object directory disappears.
- Release verification checks exact workspace exclusions and outgoing pnpm artifact sizes.

- `inspectRemoval` no longer unlinks retained-borrower registry entries. Inspection remains a snapshot; `remove` still drops gone or independent registrations under its mutation lock (#28218).

## 0.5.0 — 2026-10-02

- Export `readPrivateSubmodulePaths` from `git-super/commit-graph` to read sorted private-submodule declarations from a frozen commit without joining gitlinks. A private declaration without a path and invalid private values refuse explicitly.
- Missing nested stores beneath prepared parents produce `nested-store-missing` with full paths, exact pins, and executable checkout-free prepare and fetch commands using frozen declared URLs. Merge planning collects absent stores at the first failing depth before moving the root; deeper levels are repaired in later rounds. Invalid stores retain their failure causes.
- Primary submodule checkouts are recognized as self by their absolute Git directory after binding the requested checkout. Failed identity reads and probes that ascend into enclosing repositories refuse explicitly.

## 0.4.0 — 2026-10-01

- Recursive comparisons report removed components and continue through readable repositories. Missing component objects are aggregated with repository/object IDs and frozen-descriptor fetch remedies before CLI exit `2`. Results expose skipped and unreadable boundaries through `notCompared`.
- Explicit submodule exclusions flow through comparison, status, ancestry, pull and worktree removal. Materialization uses frozen HEAD or captured stage-0 evidence, classifies exclusions before child probes, and preserves process failure details. Private stores outside removal custody remain untouched; stores inside deletion paths refuse before content inspection.

- `GitWorktreeStore.inspectRemoval(path, { excludedSubmodules? })` provides read-only caller admission with named skipped custody, consulted repositories and uninitialized included components. This inspection is a snapshot, not permission: `remove` rechecks admission under its mutation lock. Both use the same excluded-custody and borrower checks; included uninitialized components remain observations rather than a new removal mode.

- New `git-super/status` subpath exports the recursive inventory (`superStatus`) so consumers such as bearly's worktree tool can import it without the CLI.
- Merge initializes newly added gitlinks at their staged pins after raises and before settling existing checkouts or running commit hooks. Pull additions now use the same recursive materializer and durable local borrowing, including prepared nested stores. Both callers resolve the primary reference, report borrowing and unreferenced paths, and preserve command timeouts; pull retains detached apply process groups. Initialization failures preserve the staged root merge and name the path and pins; nested additions in existing changed parents refuse explicitly before the root moves.

- `diff` expands a gitlink the range adds as every file in its tree, each counted as added, instead of refusing the range. The added repository's consulted range, stat range and root pointer move start at git's empty tree (`4b825dc642cb6eb9a060e54bf8d69288fbee4904`), not a commit, so a consumer running `log` or `merge-base` on `from` must check it is a commit first. `--patch` prints the whole added tree. A gitlink nested inside an added gitlink expands too.
- `status` expands staged nested-gitlink additions. An unstaged pin move reports the modified gitlink; genuinely dirty child files remain listed under their owning repository paths (#27069).
- A file replaced by a gitlink, a gitlink replaced by a file, and an added gitlink whose checkout is not initialized each still refuse, with a message naming which case it is.

- Merges and worktree adds now wait up to five minutes for the shared writer lock and report its holder. A merge timeout gives the exact command to retry.
- Push planning batches advertised object checks and frozen merge trailers, and `GIT_SUPER_PROGRESS=1` reports push phase/count through the first write.

## 0.3.0

- Keep `danglingRefs` and its public type as compatibility projections over
  Gitomic's single missing-object scanner and classifier.
