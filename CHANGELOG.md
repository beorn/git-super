# Changelog

## 0.4.0 — 2026-09-23

- Merges and worktree adds now wait up to five minutes for the shared writer lock and report its holder. A merge timeout gives the exact command to retry.

## 0.3.0

- Keep `danglingRefs` and its public type as compatibility projections over
  Gitomic's single missing-object scanner and classifier.
