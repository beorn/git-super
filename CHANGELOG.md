# Changelog

## 0.4.0 — 2026-10-01

- New `git-super/status` subpath exports the recursive inventory (`superStatus`) so consumers such as bearly's worktree tool can import it without the CLI.
- Merge initializes newly added gitlinks at their staged pins after raises and before settling existing checkouts or running commit hooks. Pull additions now use the same recursive materializer and durable local borrowing, including prepared nested stores. Both callers resolve the primary reference, report borrowing and unreferenced paths, and preserve command timeouts; pull retains detached apply process groups. Initialization failures preserve the staged root merge and name the path and pins; nested additions in existing changed parents refuse explicitly before the root moves.

- `diff` expands a gitlink the range adds as every file in its tree, each counted as added, instead of refusing the range. The added repository's consulted range, stat range and root pointer move start at git's empty tree (`4b825dc642cb6eb9a060e54bf8d69288fbee4904`), not a commit, so a consumer running `log` or `merge-base` on `from` must check it is a commit first. `--patch` prints the whole added tree. A gitlink nested inside an added gitlink expands too.
- `status` inherits this: an unstaged pin move whose range adds a nested gitlink lists that gitlink's files.
- A removed gitlink, a file replaced by a gitlink, a gitlink replaced by a file, and an added gitlink whose checkout is not initialized each still refuse, now with a message naming which case it is.
- Merges and worktree adds now wait up to five minutes for the shared writer lock and report its holder. A merge timeout gives the exact command to retry.
- Push planning batches advertised object checks and frozen merge trailers, and `GIT_SUPER_PROGRESS=1` reports push phase/count through the first write.

## 0.3.0

- Keep `danglingRefs` and its public type as compatibility projections over
  Gitomic's single missing-object scanner and classifier.
