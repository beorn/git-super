# Merge and ordered publication

```bash
git super --repo /work/product merge <commit> [-m <message>] [--no-verify]
git super --repo /work/product merge <commit> --preserve-conflicts
git super --repo /work/product merge <commit> --continue --expected-head <oid> --expected-branch <full-ref>
```

`merge` merges one commit into the current branch, moves submodule commits that are behind their branch forward, checks the submodules out at the new commits, and commits once.

## Which submodules take part

A submodule takes part when its remote has the same host and namespace as the root's remote. Other hosted submodules stay `as-written` and are never published. Identities are read before Git's URL rewrites. A local path or `file://` URL cannot establish this relation.

The submodule's branch comes from the first of these that is set:

1. `submodule.<name>.branch` in local Git config
2. the same key in the merged commit's `.gitmodules`
3. the remote's default branch

A value of `.` means the superproject's current branch, and is refused when HEAD is detached.

Each submodule commit is compared with its fetched branch:

| Recorded commit vs. submodule branch | Result                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------- |
| Equal                                | Keep it.                                                                                    |
| Behind                               | Move the root's recorded commit forward to the branch tip.                                  |
| Ahead                                | Keep it, and record it for publication to the branch.                                       |
| Diverged                             | Refuse an incoming change. An untouched divergence is kept and reported as `left-off-main`. |

### --no-fetch

`--no-fetch` skips the fetch only for unchanged Equal commits whose store recorded a successful refresh of the current origin URL and branch commit in the last ten minutes. Everything else is fetched fresh.

- **The cache:** each successful fetch appends a reflog entry, even when the ref did not change. Losing the store or its entry only means the next merge fetches; results never depend on it.
- **Other origins:** a configured origin that differs from the declared URL is named and refreshed from the declared URL.
- **Errors:** an unreadable entry or a failed write gives a named error and no retry.

`--unbounded-local-main` (with `--no-fetch`) reads unchanged Equal branches locally with no age limit. `--no-retain-pins` is for previews: it writes no `refs/git-super/pins` refs and pushes nothing.

## How a merge runs

**A new merge:**

1. Compute the merge tree before changing anything.
2. Apply a no-ff merge without committing.
3. Write the proven forward moves.
4. Initialize newly added submodules at their staged commits, reusing local stores.
5. Check out affected submodules at their staged commits, including nested submodules at the commits their parents record. Native checkout refuses to overwrite changes or to fetch missing nested objects.
6. Commit, running hooks.

**A continuation** (`--continue`) starts from the resolved native index and writes only its own proven forward moves.

Forward moves and kept differences are listed in `Settled:` trailers. The merge also records what [push](#ordered-publication) needs, in a `Git-Super-Push:` trailer.

After the commit, git-super checks the parents, submodule commits and `.gitmodules` against what it planned. Hooks may reformat ordinary files. If anything else differs after HEAD moved, the result is a partial failure naming the commit; the commit is kept and no receipt is written.

An uninitialized new nested submodule inside an existing changed parent is refused before the root merge, with its path and required commit in an `initializations` entry.

## Conflicts

`--preserve-conflicts` leaves ordinary file conflicts in Git's index and working files. The result has `state: "failed"`, `partial: true`, exit 2, and a `pending` block with `branch`, `head`, `target` and `unmergedPaths`. The message prints the exact `--continue` command and `git merge --abort`.

```console
$ git super --repo . merge feature --preserve-conflicts
$ git add path/to/resolved-file
$ git super --repo . merge feature --continue --expected-head <oid> --expected-branch refs/heads/<branch>
```

`--continue` needs:

- the branch, HEAD and target from the printed command
- exactly one `MERGE_HEAD`, and no unmerged entries
- clean submodule checkouts at the commits recorded before the merge

It re-checks the required submodule commits and keeps your staged resolution, including a resolved `.gitmodules`.

These are refused with exit 1 and `partial: false`, leaving the pending merge as it was:

- a submodule commit lowered by `git add -A`, with both commits and the restage command named
- an extra submodule
- moved or dirty submodule work
- a wrong branch, HEAD or target

Also refused:

- mixed file and submodule conflicts, unchanged, naming the submodule paths
- using `--preserve-conflicts` together with `--continue`
- a rebase or cherry-pick in progress, before the merge starts

## Results

Human output prints the merge commit on stdout and the details on stderr. `--json` prints one `SuperMergeResult` with:

- **gitlink entries:** one per submodule commit the merge considered.
- **`checkouts`:** per affected direct submodule, its commit in root `HEAD` (`recorded`), the staged commit (`index`), the commit before the merge (`preCheckout`), the observed checkout, and a status: `settled`, `settle-failed`, `restored`, `restore-failed` or `not-run`.
- **`initializations`:** per new submodule, the staged commit, the observed checkout, and `initialized`, `initialization-failed`, `not-run` or `initialization-required`.
- **`steps`:** `{ "name", "ms" }` per phase, in order. Phases do not overlap and cover the whole run, so the times add up to the total.

| Step         | Covers                                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| `preflight`  | finding the root, taking the worktree lock (including waiting), the clean check, resolving HEAD and target |
| `merge-tree` | the merge tree, and combining any diverged submodule commits it conflicts on                               |
| `plan`       | comparing each submodule with its branch: fetches and nested descent                                       |
| `capture`    | the `Settled:` trailers and the recorded push plan                                                         |
| `checkouts`  | preparing affected submodule checkouts and proving the worktree clean                                      |
| `merge`      | the native no-ff merge and the forward moves                                                               |
| `initialize` | checking out new submodules at their staged commits                                                        |
| `settle`     | checking out affected submodules at their staged commits                                                   |
| `commit`     | the commit, its hooks, and the receipt                                                                     |

A merge that stops early ends `steps` on the phase that stopped it. New phases are added to this list. Consumers should keep unknown step names as given.

**Receipt.** When git-super moves recorded submodule commits forward, it writes `refs/git-super/receipts/<merge>`. Its only parent is that merge, and its `receipt.json` lists only the forward moves made by this run. Callers can copy it into their own record, then delete the ref with an exact old-value lease.

A repository with no submodules, or nothing to move forward, still returns the real merge commit with no entries.

## Failures

- **Before the root merge:** exit 1. Root HEAD, index and files are unchanged. Fetching and store preparation may already have happened.
- **After Git applied the uncommitted merge:** exit 2, `partial: true`, completed and `not-run` entries, and checkout recovery details.
- **Commit rejected:** the root merge and staged index are kept. Each submodule is restored to the commit recorded before the merge.
- **Restore not proven:** the state is left as is, the entry is marked `restore-failed`, and the full `recorded`, `staged-index`, `checkout` and `pre-checkout` IDs are printed. Restore those submodules and check again before retrying.
- **Initialization failed:** the root merge stays staged and existing checkouts do not move. Every directory and store is kept.

`--no-verify` skips hooks. Use it only in an emergency.

## Ordered publication

The `Git-Super-Push:` trailer stores each submodule's resolved remote, destination branch, source commit and expected old value. `git super push` of that exact merge uses these recorded values even if local branch or remote config changed since. It:

- validates destinations before writing
- pushes submodules before root refs
- treats an identical completed update as done on retry
- refuses a third, different destination value

**Records with empty trees.** A record commit can keep the merge reachable through its history while its own tree is empty. Before such a record is pushed, git-super:

1. finds newly reachable recorded merges
2. stores each owned submodule source at `refs/git-super/pins/<oid>`
3. checks each source can be fetched through that ref

This does not move submodule branches. Later pushes do not replay intents that were already published.

**Retrying from a fresh clone.** A fresh clone can fetch the record and retry publishing its exact merge from the stored sources. It needs no original checkout, no new merge, and no submodule worktree. Pin refs are never cleaned up automatically. External submodules get no pin refs. Pushing a record is refused when an external source cannot be kept without writing to the external repository.

**First publication of an existing project.** A new local submodule store may have neither the commit nor its `refs/git-super/pins/` ref. git-super then:

1. reads that exact ref first
2. if it is absent, fetches branch and tag tips from the submodule's recorded remote
3. proves one of them contains the commit
4. creates the ref with an absent-value lease

An identical concurrent write succeeds. A conflicting ref, an unreachable commit or a failed read refuses. This finishes before any branch or root ref moves, and the pin stays if a later push fails. Unchanged submodules do no remote work.

**What this does not do.** This gives ordered publication and retry, not rollback across repositories. A merge queue that uses it must record its checked state durably before merging and keep its root leases for recovery. [Yrd](https://github.com/beorn/yrd#readme) is one such queue.
