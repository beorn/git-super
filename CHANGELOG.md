# Changelog

## Unreleased

- `GitProcessRequest.detached` and `.backstopMs`; `GitProcessResult.backstop`; `APPLY_GROUPS_ENV`.
- `GitSuperResult.deferredSignal`; `SuperPullOptions.warn`.
- `pull` exits 128+signal after a deferred signal, including when the apply failed; the JSON result still says which.
- A `post-merge-hook` phase, and a `post-merge-hook-failed` detail on a pull that exits 0.

## 0.3.0

- Keep `danglingRefs` and its public type as compatibility projections over
  Gitomic's single missing-object scanner and classifier.
