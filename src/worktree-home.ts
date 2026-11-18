/**
 * The worktree home resolver, in its own module so a resident that needs only the home loads only this file
 * (@i/16-work-lifecycle/31193-item-events-p5-convert-old-shapes/33861; @cto 33861-worktree-home-subpath-go):
 * the package barrel reaches every git-super module, and a supervisor measuring that closure restarted km-daemon
 * on git-super changes it never runs. Node built-ins only. worktree-add.ts re-exports everything here unchanged.
 */
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"

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
