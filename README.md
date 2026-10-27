# git-super

git-super is Git for repositories with submodules. Plain Git stops at a submodule; git-super looks inside it.

```console
$ git diff --name-only main..feature
vendor/tool
$ git super --repo . diff --name-only main..feature
vendor/tool/src/index.ts
Consulted repositories

✓  .
✓  vendor/tool  d97257d3a839 → b0678f76c4dd
```

- **Files, not submodule paths.** `diff` and `status` list the changed files inside each submodule, nested submodules included.
- **Each question goes to the right repository.** `merge-base` first finds which repository owns a commit, then checks it there.
- **Submodules move with the root.** `pull`, `push`, `merge` and `worktree add` handle each submodule at the commit the root records for it.
- **Nothing left out quietly.** stderr lists every repository read. A repository it could not read is reported, not skipped.

## Install

- Install [Bun](https://bun.sh) 1.3.14 or newer. The `git-super` command runs on Bun, even when installed with npm.
- Run `npm install -g git-super`, then `git super --help`. Git runs any `git-<name>` program on your `PATH` as `git <name>`.
- The JavaScript library also runs on Node 24+.

## Usage

- **Pass `--repo <path>`,** the path of the top-level repository, to get submodule-aware results.
- **Without `--repo`,** git-super runs plain Git when the index, `HEAD` and every commit you name hold no submodules. Otherwise it stops with exit code 2 and tells you to add `--repo`.
- **Commands git-super does not have,** such as `git super log`, run plain Git. Leave `--repo` off for those.
- **Submodules must be initialized.** git-super reports or refuses one that is not. `pull`, `merge` and `worktree add` initialize submodules that a commit newly adds.
- **Output:** results go to stdout in Git's format. The "Consulted repositories" list goes to stderr. `--json` prints one JSON result on stdout instead.
- **Exit codes:** 0 on success, nonzero on failure. When some repositories were handled and others were not, the JSON result says which.
- **`status` is the one exception:** it exits 0 once it has read the root, and names each submodule it could not read (in JSON, under `submoduleProblems`).

## Commands

Every example runs from the top-level repository.

- **`diff`**: changed files, including files inside submodules. Also takes `--stat` and `--patch`.
  `git super --repo . diff --name-only main..feature`
- **`status`**: status of the root and every checked-out submodule.
  `git super --repo . status --porcelain`
- **`merge-base`**: is this commit, from the root or any submodule, part of `main`? Exit 0 means yes, 1 means no.
  `git super --repo . merge-base --is-ancestor <commit> main`
- **`pull`**: fast-forward the root, then check out each submodule at the commit the root records. Refuses if the branches diverged.
  `git super --repo . pull --ff-only`
- **`push`**: push the submodule commits their remotes lack, then push the root.
  `git super --repo . push --recurse-submodules=on-demand origin main`
- **`merge`**: merge a branch into one root commit. A submodule whose recorded commit is behind the submodule's own branch (usually its `main`) moves forward to that branch.
  `git super --repo . merge feature`
- **`worktree add`**: a new worktree with every submodule checked out. Plain `git worktree add` leaves them empty.
  `git super --repo . worktree add ../review main`
- **`worktree remove`**: copy the worktree's submodule Git data to a backup directory, then remove the worktree.
  `git super --repo . worktree remove ../review --retain ~/git-backups`

Lower-level commands, each run as `git super <command>`:

- **`gitlink write <path> <commit>`**: set the commit the index records for one submodule, without touching its checkout.
- **`submodule prepare <commit> --remote <remote>`**: create submodule Git directories without checking anything out.
- **`worktree retention verify|compact|enroll`**: check or shrink retained copies, or register their dependencies. [Retention options](docs/commands.md#retention-commands).
- **`observe --protocol=1`**: for merge queues: reads a saved root state as JSON on stdin and reports submodule branch commits that state does not explain. See [docs/commands.md](docs/commands.md#observe).

`git super <command> --help` lists every flag.

## Documentation

- [docs/commands.md](docs/commands.md): global options and every command in detail, with JSON fields and failure cases
- [docs/merge.md](docs/merge.md): how merge updates submodule commits, and how push publishes them in order
- [docs/library.md](docs/library.md): the TypeScript API, runtime support and source layout
- [CHANGELOG.md](CHANGELOG.md)

## Development

```bash
git clone https://github.com/beorn/git-super.git
cd git-super
bun install --frozen-lockfile
bun run test
bun run typecheck
PATH="$PWD/bin:$PATH" git super --help   # run from the clone without installing
```

See [CONTRIBUTING.md](CONTRIBUTING.md). MIT license.
