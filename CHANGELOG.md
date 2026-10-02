# Changelog

## Unreleased

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
