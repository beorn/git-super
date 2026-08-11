# git-super

Git commands that treat a superproject and its submodule interiors as one product.

Ordinary Git plumbing stops at a gitlink. `git diff --name-only A..B` reports `vendor/tool`; it does not report `vendor/tool/src/index.ts`. `git merge-base --is-ancestor <sha> <ref>` returns a false negative when the SHA belongs to a submodule and the ref is a superproject commit. `git-super` asks each question in the repository that owns the answer, prefixes inner paths, and names every repository it consulted.

## Why it exists

This defect class caused five already-landed submodule commits to be classified as not-ancestor, a moving-base delivery gauntlet from PR1986 through PR1991, the 22648 checkout timeout, and three independent changed-file guards that stayed green while missing every submodule-internal change. Git has display flags for submodule diffs, but no native flag that turns gitlinks into a composable file set.

The answer belongs at the Git invocation layer: callers change `git diff` to `git super diff`, whether they are TypeScript programs, shell scripts, CI jobs, or humans.

## Commands

```bash
git super diff --name-only <range>
git super status --porcelain
git super merge-base --is-ancestor <sha> <superproject-ref>
```

`diff` accepts `--diff-filter`, `--cached`, and `-z`. `status` includes tracked and untracked changes in checked-out submodules. `merge-base --is-ancestor` discovers which repository owns the first commit and compares it with that repository's pin in the selected superproject ref.

Normal path or porcelain output stays on stdout. A Silvery-rendered consulted-repositories report goes to stderr, so existing pipelines remain composable. `--json` emits the result and consulted repositories together on stdout.

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

Missing checkouts, missing commit objects, added or removed gitlinks without a resolvable commit range, and ambiguous commit ownership all fail loudly. The tool never turns an unresolved repository boundary into an empty success.

## Private metadata projections

`git-super/projection` lets a sandbox write an existing checkout without mounting its linked-worktree common directory. Prepare the projection only after recursive submodules are materialized and the caller holds exclusive writer custody:

```ts
import {
  preparePrivateGitMetadataProjection,
  preservePrivateGitMetadataProjection,
  retirePrivateGitMetadataProjection,
} from "git-super/projection"

const projection = await preparePrivateGitMetadataProjection({
  worktree: "/work/product",
  storageRoot: "/state/run-42/private-git",
})

const volumes = projection.mounts.map(({ source, target, readOnly }) => `${source}:${target}:${readOnly ? "ro" : "rw"}`)
```

The mount plan makes each generated Git directory writable, mounts only the host object directory read-only, and overlays each checkout's `.git` file read-only. Hooks and shared config do not cross the boundary. After the writer stops, preserve private refs and unreferenced commits into a unique source-repository namespace, then retire the projection. Retirement also accepts a projection whose refs, unreferenced commits, HEAD, and index are unchanged since preparation; it refuses changed or stale evidence and refuses to label a dirty private index preserved.

## Try the repository before npm publication

The package name is reserved but this initial source release is not yet published. Clone it, install its public dependencies, and put its repo-local executable on `PATH` for the current command:

```bash
git clone https://github.com/beorn/git-super.git
cd git-super
bun install
PATH="$PWD/bin:$PATH" git super -h
```

No global installation is required. A clean clone has no dependency on the repository that incubated the resolver:

```bash
bun install --frozen-lockfile
bun run test
bun run typecheck
```

## Architecture

- `src/diff.ts`, `src/status.ts`, and `src/merge-base.ts` are pure read-plumbing services over an explicit Git process adapter.
- `src/worktree.ts` is the injected write-plumbing service: add, lock, unlock, inspect, exact removal, recovery, and hook quarantine. Its repository lock deliberately retains the cutover identity `.git/.../yrd-worktree-mutations/writer.lock`, so old and new callers exclude one another.
- `src/submodules.ts` is the single recursive materializer for Yrd and host adapters. It proves exact gitlinks before borrowing local objects, reports remote fallbacks, supports a top-level path allowlist, and recurses through nested gitlinks.
- `src/projection.ts` composes an existing checkout and its initialized recursive submodules into private writable Git directories. It borrows only host object directories, emits a backend-neutral mount plan, quarantines hooks and shared config, and refuses retirement until every private ref and unreferenced commit has preservation evidence; a dirty private index must be resolved first.
- `src/commands.ts` exposes the platform-neutral `CommandNode` tree from the published `@silvery/command` package and every CLI request passes through `resolveInvocation()`.
- `src/report.tsx` renders the fail-loud repository witness with canonical Silvery components and Sterling semantic tokens.
- `src/cli.ts` adapts Commander parsing, stdout-compatible data, stable JSON, and the Silvery report around the command tree.

The package depends only on published packages. It contains no delivery daemon, fleet policy, task tracker, or host-repository imports.

Library consumers import `git-super/worktree` for injected worktree mechanics, `git-super/submodules` for recursive materialization, and `git-super/projection` for private metadata mount plans. Projection callers must hold exclusive writer custody of the checkout from preparation through preservation; git-super supplies the mechanism, while workspace ownership and sandbox lifecycle remain caller policy. Slot naming, leases, branch shapes, queue admission, and lifecycle remain policy owned by the caller.
