import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import type { ConditionalLogger } from "loggily"
import type { NotCompared } from "./diff.ts"
import { validateExcludedSubmodules } from "./git.ts"
import { gitSuperResult, type GitResultDetail, type GitSuperResult } from "./result.ts"
import { materializeSubmodulesFromLocalWorktreeParallel } from "./submodules.ts"
import { createLocalGitWorktreeStore, type GitWorktreeStore } from "./worktree.ts"

/**
 * Owner attribution for a worktree registration (@i/4-supervision/24306).
 *
 * Git derives a worktree registration name from the basename of the path it is
 * added at, and there is no flag to set it independently. MEASURED on git 2.53,
 * because the whole mechanism hinges on it:
 *
 *   - `git worktree list --porcelain` emits worktree/HEAD/branch and does NOT
 *     print the registration name, so the field a reconciler reads is the PATH;
 *   - two paths sharing a basename COLLIDE, and git dedupes with a numeric
 *     suffix (same, same1) — so a registration name is not unique by
 *     construction and cannot be trusted to identify anything on its own.
 *
 * That second point is why this belongs here rather than in a caller: the
 * collision is a REGISTRATION concern, and this module is where a worktree gets
 * registered, so it is the only layer that can refuse an ambiguous name at
 * composition time instead of discovering a dedupe afterwards.
 *
 * Measured on the live estate 2026-09-08: 866 registered worktrees against a
 * ceiling of 5, across fifteen parent directories, and not one path said who
 * owned it — so a reconciler needed a lookup table beside git own registry, and
 * a second source of truth is the drift 24306 exists to remove.
 *
 * The separator is the whole parsing contract, so an owner id may not contain
 * it. A name without exactly one separator is UNATTRIBUTABLE rather than owned
 * by an accidental prefix: every worktree registered before this must read that
 * way, because a false attribution is worse than none for a reconciler that will
 * act on the answer.
 */
const OWNER_SEPARATOR = "~"

export function registrationNameForOwner(ownerId: string, label: string): string {
  assertRegistrationComponent(ownerId, "owner id")
  assertRegistrationComponent(label, "label")
  return `${label}${OWNER_SEPARATOR}${ownerId}`
}

export function ownerFromRegistrationName(name: string): string | undefined {
  const parts = name.split(OWNER_SEPARATOR)
  if (parts.length !== 2) return undefined
  const [label, ownerId] = parts
  if (label === undefined || ownerId === undefined) return undefined
  if (label.length === 0 || ownerId.length === 0) return undefined
  return ownerId
}

function assertRegistrationComponent(value: string, what: string): void {
  if (value.length === 0) {
    throw new Error(`worktree registration ${what} may not be empty`)
  }
  if (value.includes(OWNER_SEPARATOR)) {
    throw new Error(
      `worktree registration ${what} may not contain ${OWNER_SEPARATOR}: it is the owner separator, and an id carrying it could register a name that reads as another owner (${value})`,
    )
  }
  if (value.includes("/") || value.includes("\\") || value.includes("\u0000")) {
    throw new Error(`worktree registration ${what} must be one path segment (${value})`)
  }
}

/**
 * The one worktree home (@i/4-supervision/24306).
 *
 * Creation is already one primitive (`superWorktreeAdd`); what multiplied is
 * the HOME, because each caller hardcoded its own. This is the one reader
 * those callers pass a path from. The default is flat: one directory per
 * worktree, no per-owner or per-kind subfolder.
 *
 * ONE DECLARATION, ONE READER (@i/26-environments/worktree-create-and-in,
 * P1 pool-path; @cto ebf2cc43). Before this, bearly, git-super, km-cli and
 * km-fs-mount each read the key — or a hardcoded home — themselves, so two
 * processes on the same repo could disagree about where a slot lives. The
 * precedence is now one chain, and every one of them delegates here:
 *
 *   repo `worktree.poolRoot`  >  `HH_WORKTREE_HOME`  >  `DEFAULT_WORKTREE_HOME`
 *
 * The declaration is read from the repo's COMMON config, never a linked
 * worktree's per-worktree config: with `extensions.worktreeConfig` on, a
 * `--worktree` value would shadow it per checkout and the split returns. A
 * relative declaration resolves against the MAIN worktree root, never the cwd
 * or a linked worktree's root; an absolute value is used as-is. Where the
 * common dir is NOT `<root>/.git` — a submodule
 * (`<super>/.git/modules/<name>`) or a bare repo — a relative value is refused
 * rather than resolved into `.git/modules/…`. A set-but-empty value is a loud
 * error, never a silent fall to another tier.
 *
 * A path with no `.git` entry has no config surface — that is the defined
 * "no declaration" answer, so it falls to the next tier, exactly as bearly
 * documented. The env tier refuses a relative value: a home that depends on
 * cwd is a different directory from every seat, which is the defect this
 * function exists to remove. Tests pass an env object; they do not mutate
 * process.env.
 */
export const DEFAULT_WORKTREE_HOME = "/hh/var/wt"
export const WORKTREE_HOME_ENV = "HH_WORKTREE_HOME"
/** Git config key that declares a repo's worktree pool root. */
export const POOL_ROOT_CONFIG_KEY = "worktree.poolRoot"

export type WorktreeHomeOptions = Readonly<{
  /** The repository whose declaration decides the home. Required: a home reached without one is the split this function removes. */
  repo: string
  env?: NodeJS.ProcessEnv
}>

export function worktreeHomeRoot(options: WorktreeHomeOptions): string {
  const repo = options.repo
  if (typeof repo !== "string" || repo.length === 0) {
    throw new Error(
      "worktreeHomeRoot requires the repo it resolves a home for: a home reached without one is the multi-home split this function exists to remove",
    )
  }

  const declared = declaredPoolRoot(repo)
  if (declared !== undefined) {
    const value = declared.trim().replace(/\/+$/, "")
    if (value === "") {
      throw new Error(
        `${POOL_ROOT_CONFIG_KEY} is set but empty — set a pool path (e.g. .worktrees) or unset it: ` +
          `git -C ${repo} config --unset ${POOL_ROOT_CONFIG_KEY}`,
      )
    }
    if (isAbsolute(value)) return value
    const commonDir = gitCommonDir(repo)
    if (basename(commonDir) !== ".git") {
      throw new Error(
        `${POOL_ROOT_CONFIG_KEY} is relative ('${value}') but ${repo}'s common git dir is ${commonDir}, ` +
          `not <root>/.git (a submodule or bare repo): it would resolve inside .git/modules/… — ` +
          `set an absolute ${POOL_ROOT_CONFIG_KEY} there`,
      )
    }
    return join(dirname(commonDir), value)
  }

  const env = options.env ?? process.env
  const override = env[WORKTREE_HOME_ENV]
  if (override !== undefined && override.length > 0) {
    if (!isAbsolute(override)) {
      throw new Error(
        `${WORKTREE_HOME_ENV} must be an absolute path (got '${override}'): a relative home is a different directory from every cwd, which is the three-homes defect this function exists to remove`,
      )
    }
    return override
  }

  return DEFAULT_WORKTREE_HOME
}

interface GitProbe {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

function gitProbe(repo: string, args: readonly string[]): GitProbe {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" })
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

/**
 * `worktree.poolRoot` from the repo's COMMON config alone. `--file
 * <git-common-dir>/config` is deliberate: a plain `config --get` would also
 * read a linked worktree's `config.worktree`, which shadows the declaration
 * per checkout when `extensions.worktreeConfig` is on.
 *
 * A path with no `.git` entry has no config surface: `undefined` — the defined
 * "no declaration" answer, not an error. For a real repo, exit 1 with no stderr
 * is "unset" (normal); any other failure throws, so a broken git invocation can
 * never silently fall to another tier.
 */
function declaredPoolRoot(repo: string): string | undefined {
  if (!existsSync(join(repo, ".git"))) return undefined
  const result = gitProbe(repo, ["config", "--file", join(gitCommonDir(repo), "config"), "--get", POOL_ROOT_CONFIG_KEY])
  if (result.status === 0) return result.stdout
  if (result.status === 1 && result.stderr.trim() === "") return undefined
  throw new Error(
    `git config --get ${POOL_ROOT_CONFIG_KEY} failed in ${repo}: ${result.stderr.trim() || `exit ${result.status}`}`,
  )
}

/** The repo's git-common-dir, absolute. */
function gitCommonDir(repo: string): string {
  const result = gitProbe(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  const commonDir = result.stdout.trim()
  if (result.status !== 0 || commonDir === "") {
    throw new Error(
      `git rev-parse --git-common-dir failed in ${repo}: ${result.stderr.trim() || `exit ${result.status}`}`,
    )
  }
  return resolve(repo, commonDir)
}

/**
 * How many gitlinks may open their own connection to their configured remote.
 *
 * Unbounded HERE and nowhere else. The materializer defaults to zero because
 * its usual caller has a healthy reference store and a fallback is an incident;
 * this command's whole contract is the opposite — a pin the reference lacks is
 * expected, and refusing it would leave the caller with no way to create a
 * worktree for a commit whose submodules the reference has never seen.
 *
 * UNBOUNDED PINS, NOT UNBOUNDED CLONES. A reference that holds no object store
 * for a gitlink at all is refused by the materializer regardless of this value,
 * and deliberately so: this budget was written for a store that exists and is
 * one pin behind, and on 2026-09-09 it silently also licensed a `--no-checkout`
 * queue reference with no `modules/` to clone all fifteen of its submodules
 * from GitHub on every compose.
 */
const UNBOUNDED_REMOTE_FALLBACKS = Number.POSITIVE_INFINITY

/**
 * The three-way split the report line prints. The partition is EXACT: every
 * gitlink this run resolved lands in exactly one bucket, and
 * `borrowed + fetched + absent === considered`.
 *
 * It is a projection of the materializer's five counters, not a second
 * measurement:
 *
 * - `borrowed` = `borrowed - warmed` — already present in the reference's store.
 * - `fetched` = `remoteFallbacks + warmed` — had to come over the network.
 * - `absent` = `unreferenced` — NO reference was in play for it, so the network
 *   was the only source. Not the same thing as a reference that has no store
 *   for the gitlink: that is refused outright and reaches no count at all.
 *
 * `warmed` is a SUBSET of the materializer's `borrowed`: the pins that only
 * became borrowable after one fetch into the reference. Reporting those as
 * "borrowed" would print "0 fetched" for a run that went to the network for
 * every single pin, which is precisely the quiet reading this split exists to
 * prevent.
 */
export type WorktreeGitlinkCounts = Readonly<{
  considered: number
  borrowed: number
  fetched: number
  absent: number
  /**
   * WHICH gitlinks each non-borrowed count is about.
   *
   * A consumer that reads `fetched: 3` on a fifteen-gitlink compose knows its
   * reference is degraded and cannot say which three stores to look at, so the
   * only way to act on the number is to re-derive it. `fetchedPaths.length ===
   * fetched` and `absentPaths.length === absent`; both are empty on the healthy
   * path, which is the ordinary case and costs nothing to carry.
   */
  fetchedPaths: readonly string[]
  absentPaths: readonly string[]
}>

export type SuperWorktreeAddOptions = Readonly<{
  repo: string
  path: string
  commit: string
  /** Whose object stores the gitlinks borrow from; defaults to `repo`. */
  reference?: string
  /**
   * Literal root-relative submodule paths left empty and uninitialized, with
   * no init, module store or gitfile, and no reference store opened for them.
   * Each one is reported as an `excluded` observation in `notCompared`.
   */
  excludedSubmodules?: readonly string[]
  env?: NodeJS.ProcessEnv
  log?: ConditionalLogger
  report?: (line: string) => void
}>

export type SuperWorktreeAddResult = GitSuperResult &
  Readonly<{
    path: string
    /** The commit as the caller wrote it, before Git resolved it. */
    requested: string
    /** The resolved object ID; absent only when the worktree never came up. */
    commit?: string
    /** Whether the commit records a `.gitmodules` at all. */
    gitmodules?: boolean
    gitlinks?: WorktreeGitlinkCounts
    /** One observation per excluded submodule; empty when the caller excluded nothing. */
    notCompared?: readonly NotCompared[]
  }>

const NO_GITLINKS: WorktreeGitlinkCounts = {
  considered: 0,
  borrowed: 0,
  fetched: 0,
  absent: 0,
  fetchedPaths: [],
  absentPaths: [],
}

function detail(code: string, phase: string, message: string, remedy?: string): GitResultDetail {
  return { code, phase, message, ...(remedy === undefined ? {} : { remedy }) }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function at(path: string, requested: string, commit: string | undefined): string {
  const resolved = commit === undefined ? requested : commit
  const original = commit === undefined || commit === requested ? "" : ` (${requested})`
  return `worktree add ${path} at ${resolved}${original}`
}

function counts(gitlinks: WorktreeGitlinkCounts): string {
  return (
    `${String(gitlinks.considered)} gitlink${gitlinks.considered === 1 ? "" : "s"} ` +
    `(${String(gitlinks.borrowed)} borrowed, ${String(gitlinks.fetched)} fetched, ${String(gitlinks.absent)} absent)`
  )
}

/**
 * Undo the worktree, and say which of the two states we are in.
 *
 * A rollback that fails is NOT the same failure as the one that triggered it:
 * the first leaves nothing behind, the second leaves a half-materialized tree
 * standing. Collapsing them into one "failed" is how a caller retries into an
 * existing path and gets a second, unrelated error.
 */
async function rollback(store: GitWorktreeStore, path: string): Promise<string | undefined> {
  try {
    await store.remove(path, { operation: `git super worktree add rollback ${path}` })
    return undefined
  } catch (error) {
    return message(error)
  }
}

/**
 * Create a detached worktree and materialize every gitlink the commit records.
 *
 * Mechanics only: it chooses no path, no naming, no lease, and no lifetime. The
 * one policy it does hold is atomicity — either the worktree stands with all of
 * its submodules materialized, or it does not stand at all.
 */
export async function superWorktreeAdd(options: SuperWorktreeAddOptions): Promise<SuperWorktreeAddResult> {
  const repo = resolve(options.repo)
  const path = resolve(options.path)
  const reference = options.reference === undefined ? repo : resolve(options.reference)
  const env = options.env
  const store = createLocalGitWorktreeStore({
    repo,
    ...(env === undefined ? {} : { env }),
    ...(options.report === undefined ? {} : { report: options.report }),
  })

  const failed = (
    state: "failed" | "unknown",
    failure: GitResultDetail,
    commit?: string,
    gitmodules?: boolean,
  ): SuperWorktreeAddResult => ({
    ...gitSuperResult([{ repository: repo, state, detail: failure, refs: [] }], failure),
    path,
    requested: options.commit,
    ...(commit === undefined ? {} : { commit }),
    ...(gitmodules === undefined ? {} : { gitmodules }),
  })

  const excludedSubmodules = options.excludedSubmodules ?? []
  try {
    validateExcludedSubmodules(excludedSubmodules)
  } catch (error) {
    return failed(
      "failed",
      detail(
        "invalid-excluded-submodule",
        "parameters",
        `${at(path, options.commit, undefined)} refused before the worktree existed.\n${message(error)}`,
        "Name each excluded submodule as a literal normalized root-relative path, then rerun.",
      ),
    )
  }

  try {
    await store.add({ kind: "detached", path, ref: options.commit, operation: `git super worktree add ${path}` })
  } catch (error) {
    return failed(
      "failed",
      detail(
        "worktree-add-failed",
        "add",
        `${at(path, options.commit, undefined)} failed before the worktree existed.\n${message(error)}`,
        "Resolve the reported Git condition, then rerun the same git super worktree add command.",
      ),
    )
  }

  let commit: string | undefined
  let gitmodules: boolean | undefined
  try {
    commit = await store.git.text(path, ["rev-parse", "HEAD"])
    // `optionalText` and NOT `run(..., allowFailure)`: an absent `.gitmodules`
    // is a real answer, but a stalled or timed-out repository is not, and
    // `allowFailure` returns both as one non-zero code. That collapse would
    // report "plain worktree add" for a superproject whose submodules were
    // never even enumerated — a passing exit for a check that never looked.
    gitmodules = (await store.git.optionalText(path, ["cat-file", "-e", "HEAD:.gitmodules"])) !== undefined
    if (!gitmodules) {
      const report = `${at(path, options.commit, commit)}: no .gitmodules at this commit; plain worktree add`
      return {
        ...gitSuperResult(
          [{ repository: repo, state: "updated", refs: [] }],
          detail("worktree-added", "report", report),
        ),
        path,
        requested: options.commit,
        commit,
        gitmodules,
        gitlinks: NO_GITLINKS,
        notCompared: [],
      }
    }
    const materialized = await materializeSubmodulesFromLocalWorktreeParallel({
      worktree: path,
      ...(options.reference === undefined ? {} : { referenceWorktree: reference }),
      maxRemoteFallbacks: UNBOUNDED_REMOTE_FALLBACKS,
      ...(excludedSubmodules.length === 0 ? {} : { excludedSubmodules }),
      ...(env === undefined ? {} : { env }),
      ...(options.log === undefined ? {} : { log: options.log }),
    })
    if (materialized.exitCode !== 0) {
      throw new Error(
        materialized.stderr.trim() ||
          materialized.stdout.trim() ||
          `git-super: submodule materialization exited ${String(materialized.exitCode)}`,
      )
    }
    const gitlinks: WorktreeGitlinkCounts = {
      considered: materialized.considered,
      borrowed: materialized.borrowed - materialized.warmed,
      fetched: materialized.remoteFallbacks + materialized.warmed,
      absent: materialized.unreferenced,
      fetchedPaths: materialized.remotePaths,
      absentPaths: materialized.unreferencedPaths,
    }
    const excluded = materialized.notCompared.filter((observation) => observation.reason === "excluded")
    const report =
      `${at(path, options.commit, commit)}: ${counts(gitlinks)}` +
      (excluded.length === 0
        ? ""
        : `; ${String(excluded.length)} excluded, left empty and uninitialized (${excluded.map((entry) => entry.path).join(", ")})`)
    return {
      ...gitSuperResult([{ repository: repo, state: "updated", refs: [] }], detail("worktree-added", "report", report)),
      path,
      requested: options.commit,
      commit,
      gitmodules,
      gitlinks,
      notCompared: materialized.notCompared,
    }
  } catch (error) {
    const reason = message(error)
    const undone = await rollback(store, path)
    if (undone === undefined) {
      return failed(
        "failed",
        detail(
          "worktree-materialize-failed",
          "materialize",
          `${at(path, options.commit, commit)} failed; the worktree was removed.\n${reason}`,
          "Repair the reported submodule condition, then rerun the same git super worktree add command.",
        ),
        commit,
        gitmodules,
      )
    }
    return failed(
      "unknown",
      detail(
        "worktree-rollback-failed",
        "rollback",
        `${at(path, options.commit, commit)} failed AND the worktree could not be removed; ` +
          `'${path}' is left half-materialized.\n${reason}\nrollback: ${undone}`,
        `Inspect '${path}', remove it with 'git -C ${repo} worktree remove --force ${path}', then rerun.`,
      ),
      commit,
      gitmodules,
    )
  }
}
