# Command reference

Every example uses `--repo /work/product` for the superproject. Run `git super <command> --help` for the full flag list.

Merge, and how push publishes submodule commits in order, are covered in [merge.md](merge.md).

## Global options

| Option                               | Meaning                                                                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--repo <path>`                      | The superproject. Required for submodule-aware results. With it, only the commands on this page are accepted; without it, other commands run plain Git. |
| `--json`                             | Print one JSON result on stdout. Without it, stdout has Git-style output and stderr lists the repositories read.                                        |
| `--object-directory <abs>`           | Use this object directory. Needs an explicit absolute `--repo`.                                                                                         |
| `--alternate-object-directory <abs>` | Add an alternate object directory. Repeat it to add more, in search order. Needs `--object-directory`.                                                  |

Object directory paths must be unique, absolute, existing, readable directories. They must not contain the platform path-list separator (`:` on Unix, `;` on Windows) or line breaks.

```bash
git super --repo /work/product \
  --object-directory /work/product/.git/objects \
  --alternate-object-directory /stores/public-a/objects \
  --alternate-object-directory /stores/public-b/objects \
  status --porcelain
```

Without these flags, git-super clears any object routing inherited from the environment. The flags do not override the object store a retained submodule declares.

### Excluding submodules

`diff`, `status`, `merge-base`, `pull`, `merge`, `worktree add` and `worktree remove` accept `--exclude-submodule <path>`, repeatable. The path is literal and relative to the superproject root, and its nested submodules are excluded too. JSON results list excluded paths in `notCompared`; human output names each skip on stderr. An excluded submodule is skipped. It is not reported as clean.

Per command:

- `pull` accepts only excluded checkouts that are empty and uninitialized, or absent additions. Anything else is refused.
- `worktree remove` also requires the parent's identity and a surviving store. A store inside either deletion path is refused; external stores are left alone.
- `merge` accepts only an empty root-level submodule whose recorded commit is the same in HEAD, the target and their merge base.

### Failures

These fail with an error and never produce an empty result:

- missing or unreadable checkouts
- missing commit objects
- a commit that more than one repository could own

Removed submodules are listed as skipped. `pull`, `push` and `merge` refuse included submodules that were already recorded but were never initialized. `pull` and `merge` initialize newly added submodules at their exact recorded commits.

## diff

```bash
git super --repo /work/product diff --name-only <range>
git super --repo /work/product diff --stat <range>
git super --repo /work/product diff --patch <range>
```

Accepts `--diff-filter`, `--cached`, `-z` and `--component-base <ref>`. Each moved submodule is expanded into the files it changed. `--stat` and `--patch` include each moved submodule's own diff.

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
  "notCompared": [],
  "paths": ["vendor/tool/src/index.ts"]
}
```

**Check `notCompared` before treating a diff as complete.**

- A removed submodule appears with `reason: "removed"`. It is not opened, and the other repositories are still compared.
- Missing submodule objects appear with `reason: "unreadable"`, with the repository, object IDs and the fetch command that fixes it. The CLI prints every such entry, then exits 2. The paths it could read stay in the partial result.

`--component-base <ref>` measures each moved submodule from the commit `<ref>` records for it, rather than from the old commit in the range. Use it to see only the changes a branch made.

### Already in the target

For one committed `A...B` comparison, a submodule entry may carry `targetComparison`:

- `{ kind: "at-target", target: "A", commit: "<root commit>" }`: the branch records the same submodule commit as `A`. Human output says `already in A`; path, NUL and native diff output are unchanged. This means "equal". It says nothing about who made the change.
- `{ kind: "unavailable", target: "A", commit: "<root commit>", error: "<cause>" }`: the extra read failed. The cause goes to stderr and into the JSON. Output and exit code are unchanged.

Only exact equality is labelled. A commit behind, ahead of or diverged from the target gets no label. Working-tree, `--cached`, two-dot and other forms get no label. Nested submodules compare against the commit their parent records in the target.

## status

```bash
git super --repo /work/product status --porcelain
git super --repo /work/product --json status --index-file /absolute/path/to/index
```

Shows tracked, untracked and staged changes in the root and in every checked-out submodule, with paths prefixed by the submodule path.

- `--index-file <absolute path>` is for Git hooks: it reads the index Git is about to commit. It applies to the root repository only; submodules use their own indexes. A relative or missing path is refused. JSON names the file in the root entry of `consultedRepositories`.
- `--removal` returns a removal verdict: exit 0 clean, 1 dirty (records as JSON), 2 a submodule's state is unknown.

`status --json` always includes two arrays:

- `submoduleProblems`: submodules that could not be read, each with `path`, `reason`, and `gitDir` when known. Status can exit 0 with problems listed: the root read worked, but those submodules stay unknown. A non-empty list blocks `worktree remove` even when `records` is empty. Human output names the problems on stderr.
- `uninitializedSubmodules`: existing empty submodule directories, also printed on stderr as `path: not checked out`. They are not reported as dirty. A non-empty directory that is not checked out is refused with its path, so ignored files in it cannot be lost.

## merge-base

```bash
git super --repo /work/product merge-base --is-ancestor <commit> <superproject-ref>
```

Finds which repository owns `<commit>`, then checks it against that repository's commit as recorded in `<superproject-ref>`. Exit 0 means yes and 1 means no. A failure to select or measure exits 2.

## pull

```bash
git super --repo /work/product pull --ff-only [<repository> [<refspec>...]]
git super --repo /work/product pull --ff-only --dry-run
```

`--ff-only` is required. Steps:

1. Fetch and fix one exact root target.
2. Work out every initialized submodule's target commit without checking anything out, and fetch only missing commits.
3. Check every working-tree change before the first write.
4. Under a shared lock, recheck the remote ref and every repository's HEAD.
5. Fast-forward the root, then check out each changed submodule at its exact recorded commit. New submodules are initialized from the updated parent, reusing local stores where available.

With no arguments, pull uses the current branch's upstream. With a repository and no refspec, that repository supplies the same upstream branch. A branch with no upstream is an error; pull does not fall back to `origin/main`. If the root already has the target, pull keeps the root and its submodule commits as they are and says so.

- **Kept:** unrelated staged, tracked, untracked and ignored files.
- **Refused before the root moves:** a path the incoming change would overwrite.
- **Refused without merging, rebasing, stashing or forcing:** divergence, an unpublished detached submodule commit, a remote that changes during the pull, lock contention, missing objects.
- **Partial:** if Git fails after one repository has already changed, the result says `partial`, and later repositories say `not-run`.

`--dry-run` fetches and checks but changes no checkout, index or branch. Its result describes the plan at that moment only.

`--json` prints one `GitSuperResult` on success and on failure. Exit 0 is success; failed, partial and unknown results exit nonzero. Set `GIT_SUPER_PROGRESS=1` to print each phase to stderr as it starts.

## push

```bash
git super --repo /work/product push [--recurse-submodules=check|on-demand|only|no] [<remote> [<refspec>...]]
```

| Mode              | Behavior                                                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `check` (default) | Each submodule commit newly referenced by the pushed root history must already be on one of that submodule's remotes. Then push the root refs.                                                   |
| `on-demand`       | Push missing submodule commits first, deepest first, then the root. They go to `refs/git-super/pins/<sha>`, or to the submodule's branch from `.gitmodules` when the root destination is `main`. |
| `only`            | Push the submodule commits and leave root refs alone.                                                                                                                                            |
| `no`              | Push only the selected root refs.                                                                                                                                                                |

Every source resolves to an exact object ID. Each destination's current remote value is read first and checked again under a shared lock.

- **Lease as recheck:** if every update for a repository carries an explicit lease, and the push is `--atomic` or updates one ref, the remote's own lease check replaces the recheck. A moved destination is reported as `destination-changed`.
- **Outcomes:** a clean push takes each ref's result from Git's `--porcelain` output. A failed push, or porcelain output that is missing, duplicated or unreadable, makes git-super read the remote instead.
- **Default refs:** with no refspecs, git-super asks Git for the configured default refs with a dry run, then pushes exactly those.

What `check` covers:

- It walks every parent of the newly published root commits, including submodule commits that a later commit removed again.
- Nested submodules use the previous parent commit as their starting point.
- An unchanged submodule is not checked.
- A submodule commit that a merge inherits from either parent is not new and is not checked.
- A commit seen on the named remote during this push also proves its ancestors are there.

Rules:

- `+` force refspecs and pattern refspecs are refused.
- `--force-with-lease=<full-ref>:<expected>` sets an explicit lease. An empty `<expected>` means the ref must not exist yet. Leases that would need a fetch first are refused.
- `:<destination>` deletes a ref only with an exact `--force-with-lease=<destination>:<expected-old-oid>`. An already deleted ref counts as done. Deletes and updates can share one atomic root push; each keeps its lease.
- `--atomic` applies within each single repository. **It never makes several repositories atomic.** A submodule can stay pushed when a later root push is rejected; the result then says `partial: true`.
- Hooks run unless you pass `--no-verify`. `--signed` and `-o/--push-option` pass through to Git.
- Hooks, credential helpers and remote helpers behave as in Git.
- A timeout, rejected hook, unreachable remote, unreadable response or a disagreeing post-push check is always an error.
- Selecting no refs is an input error.

## worktree add

```bash
git super --repo /work/product worktree add <path> <commit> [--reference <path>]
```

Creates a detached worktree at `<commit>` and checks out every submodule at the commit it records. Plain `git worktree add` leaves submodules as empty directories.

Submodules borrow objects from `--reference` if given, otherwise from the repository you run in. A commit the reference lacks is fetched from the submodule's own remote.

If anything fails after the worktree is created, git-super removes it again and exits nonzero with the reason. If that removal also fails, the result is `unknown`, names the path left behind, and prints the command that removes it. A commit with no `.gitmodules` works exactly like `git worktree add`, and the report says so.

The report goes to stderr:

```
worktree add /work/candidate at 0123456789abcdef0123456789abcdef01234567 (main): 3 gitlinks (2 borrowed, 1 fetched, 0 absent)
```

`borrowed + fetched + absent` equals the number of submodules:

- **borrowed:** already present in the reference
- **fetched:** downloaded, either into the reference or straight from the submodule's remote. A commit that was fetched and then borrowed counts as fetched.
- **absent:** no reference store was offered for it

`--json` prints one `GitSuperResult` with the path, requested and resolved commits, and those counts. Exit 0 is success; any failure exits nonzero. An unknown `worktree` subcommand exits 2 with usage.

## worktree remove

```bash
git super --repo /work/product --json worktree remove <path> --retain <directory>
```

Removes one registered, clean, unlocked linked worktree. Steps:

1. Check the root and every checked-out submodule with `status`. Dirty, locked, unreadable or unretained work is refused.
2. Copy the worktree's submodule Git data to `<directory>`, outside both deletion paths. Compare file manifests (SHA-256 bytes and objects-link identity) to prove the copy.
3. Print the proof on stderr, then run `git worktree remove --force`. The `--force` only overrides Git's refusal to remove worktrees with submodules; the checks above have already passed.
4. Compact each copied submodule Git directory: `git pack-refs --all`, drop `logs/refs/remotes/`, keep every local reflog, and rewrite the proof so `worktree retention verify` still matches. Ref values are compared before and after. If compaction fails, the removal still succeeds: refs stay intact, the proof is not rewritten (so a later verify refuses), the copy is kept, and the JSON says `compaction: { status, child, step }`.
5. Unregister nested linked checkouts that belonged to surviving submodule stores. Branch refs and the copy are not changed.

Copies are never deleted automatically. Keep them at least until the proof's `retainUntil` date. Use a durable directory.

If unregistering a nested checkout fails, the command exits nonzero and names the state: the root is removed, and the nested registration is kept, already removed, or unreadable. Surviving paths are untouched. Library callers can retry with `store.recoverDestroyed(path)` from the surviving submodule repository.

Object links and borrowers:

- **Symlinked objects directory:** allowed only when its target already exists inside the selected Git common directory and outside both deletion paths. Other metadata links, missing targets, and targets elsewhere are refused with their paths.
- **External object stores:** never copied or changed. The copy keeps an absolute link and records the dependency in `manifest.json` under `externalObjectStores`, so the copy is not self-contained.
- **Borrower registry:** each copy that borrows objects is registered under `<git-common-dir>/git-super-retained-borrowers` before removal. Later removals refuse while a registered copy still links into their deletion paths. An entry is dropped (and named) when the copy is gone, has no object links, or depends only on stores under `<git-common-dir>/modules`. Unreadable or unresolved entries refuse; editing `manifest.json` does not prove a copy is independent.
- **Live borrowers:** a live submodule whose objects link into the worktree being removed blocks the removal, naming the checkout, module and target. git-super does not rewrite those links.

Other options:

- `--no-rehome` keeps a store that other stores borrow from, instead of moving their objects.
- `--preserved <ref>` lets a dirty store be removed only if `<ref>` resolves to a commit in that store.

`worktree retention verify <entry> --root <dir>` and `worktree retention compact --root <dir>` check and compact existing copies. `worktree private-store verify <store>` checks a private submodule store. Both are read-only checks, and their results do not authorize removal.

## gitlink write

```bash
git super --repo /work/product gitlink write <path> <commit>
```

Sets one existing submodule's commit in the index. It does not move the checkout, fetch, add a path, or decide whether the commit should change.

The path must already be a submodule. The commit must exist in its checkout or in its repository under the superproject's Git directory. A missing path, repository or commit is an error naming the repository, path, object ID and fix.

The write takes the shared lock and reads the entry back before reporting success:

- **Unknown:** the readback fails or does not match. The command exits nonzero.
- **Failed and partial:** the lock cannot be released after the write.

`--json` prints the same `GitSuperResult` as the `writeGitlink` library function.

## submodule prepare

```bash
git super --repo /work/product --json submodule prepare <root-commit> --remote <remote-name-or-url>
```

Creates a Git directory for each direct submodule of `<root-commit>`, without cloning, fetching or checking out. Both arguments are required. Submodules come from that commit's tree and `.gitmodules`, never from the checkout. `--remote` resolves relative submodule URLs.

It needs:

- a readable root and commit
- a remote name or URL
- a writable Git directory

Each store is created at the usual `modules/<name>` location under the shared lock. Stores that already exist keep their configuration. JSON lists `submodules`, each with `name`, `path`, `gitlink`, resolved `url` and absolute `gitdir`. New stores are `updated`, existing ones `unchanged`. A commit with no submodules returns `submodules: []`.

Errors:

- an unresolved root, a malformed `.gitmodules`, an unsafe location, or a broken existing store
- a later failure keeps the stores already made and reports them as partial

The stores work with a later `git submodule update`.

Prepare covers one level. For the next level, run it again with the returned `gitdir` as `--repo`, its `gitlink` as the commit, and its `url` as `--remote`. The parent commit must already be in that store. Fetch the exact child commits into the new stores before checking out.

When merge finds missing nested stores, it stops before changing the root and reports `nested-store-missing`. The report names each missing store at the first missing level, with paths and exact commits, and prints the `submodule prepare` and fetch commands to run. Run them and retry; a deeper missing level shows up in the next round. If the parent's remote cannot be confirmed, the error says so instead of guessing commands.

## branch retire

```bash
git super --repo /work/product branch retire <branch> --tip <commit> --actor <name>
git super --repo /work/product branch retire <branch> --tip <commit> --archive <ref> --dry-run
```

Deletes `refs/heads/<branch>` only while an archive ref reads back the branch's exact tip. It refuses a branch that is unarchived, checked out, missing, or has a different tip; a branch that moved past `--tip` is kept.

The archive ref defaults to `refs/archive/<date>/<actor>/<branch>`; `--date` defaults to today (UTC). `--actor` is required when `--archive` is not given. `--dry-run` lists what would be retired. `git super --repo <path> branch <other>` runs plain `git branch`.

## observe

```bash
git-super super observe --protocol=1 < captured-root.json
```

`git super observe --protocol=1` also works. It reads one UTF-8 JSON document from stdin, in the root repository, and reports which current submodule tips are not explained by a captured root state.

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
      "mergeOid": "<checked merge OID>",
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

Input:

- The caller lists every advertised ref under each prefix, including refs it does not recognize.
- Each checked record must match that list.
- With empty lists, it still examines current direct-submodule tips.
- Submodules hosted outside the root's namespace are skipped. A local path cannot establish that namespace.

A tip counts as explained only by the captured root's commit for it, or by the published source of a current checked merge. The expected old value does not count.

Each read is attempted once. After all submodule reads, the root's advertised refs must still match the captured target and refs. Only then does stdout get `{version:1,outcome,message,notices:[{id,text}]}`. Notice IDs are stable strings, and the text is complete wording for people.

| Exit | Outcome                                    |
| ---- | ------------------------------------------ |
| 0    | `observed`, including an empty observation |
| 2    | `invalid`                                  |
| 3    | `changed-during-read`                      |
| 4    | `unavailable-transport`                    |

Any outcome other than `observed` carries no notices. These exit codes apply to this protocol only.

It may prepare and fetch into the existing submodule stores. It writes no caller refs, `FETCH_HEAD`, worktrees or remote refs. The caller owns timing, deadlines, evidence retention and notice delivery.
