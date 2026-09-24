# Changelog

## 0.4.0 — 2026-09-23

- A merge now waits up to five minutes for the shared writer lock. A timeout identifies its holder and gives the exact merge command to retry.

## 0.3.0

- Keep `danglingRefs` and its public type as compatibility projections over
  Gitomic's single missing-object scanner and classifier.
