import { spawnSync } from "node:child_process"
import { existsSync, realpathSync } from "node:fs"
import { appendFile, mkdir, readFile } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createLogger, type ConditionalLogger, type LogLevel } from "loggily"
import { cleanGitRepositoryEnvironment } from "./git.ts"
import { createLocalGitProcess, type GitProcess } from "./process.ts"

export const SUBMODULE_ALTERNATE_LOCATION = "superproject"
export const SUBMODULE_ALTERNATE_ERROR_STRATEGY = "info"
const MAX_CONCURRENT_SUBMODULE_UPDATES = 20

export type SubmoduleGitResult = Readonly<{ code: number; stdout: string; stderr: string }>

export type SubmoduleGit = Readonly<{
  run(repo: string, args: readonly string[], allowFailure?: boolean): Promise<SubmoduleGitResult>
  mutateConfig?(repo: string, args: readonly string[]): Promise<SubmoduleGitResult>
}>

/**
 * `considered` is the denominator and is not optional to read: `remoteFallbacks:
 * 0` means nothing without it, since zero of zero and zero of sixteen are the
 * same number. `borrowed + remoteFallbacks + unreferenced === considered` is an
 * exact partition; `warmed` is a SUBSET of `borrowed` and is outside it.
 */
export type SubmoduleMaterializationResult = SubmoduleGitResult &
  Readonly<{
    considered: number
    borrowed: number
    remoteFallbacks: number
    unreferenced: number
    warmed: number
  }>

export type SubmoduleMaterializationOptions = Readonly<{
  worktree: string
  referenceWorktree?: string
  force?: boolean
  /** Restrict only the top-level pass; nested submodules still recurse. */
  paths?: readonly string[]
  /**
   * Structured logger. Spans here are the only way to learn where
   * materialization time goes: the whole operation used to report one exit code
   * and three counters, so a run that spent four minutes fetching sixteen
   * submodules over the network was indistinguishable from one that borrowed
   * all sixteen off local disk. `materialize` carries the totals, its laps
   * split the phases, and `warm`/`update` carry one record per submodule with
   * `source` naming local versus network.
   *
   * Optional throughout: `log?.span?.()` and `log?.debug?.()` are absent under
   * a plain logger and gated off entirely below the configured level, so an
   * uninstrumented caller pays nothing.
   */
  log?: ConditionalLogger
  /**
   * How many submodules may open their own network connection after a warm-up
   * attempt has already failed. Defaults to 0: with a healthy reference store
   * every gitlink borrows locally, so an unrepairable fallback is an incident
   * and not a tolerance. On 2026-08-21 sixteen of them per bay, several bays at
   * once, made GitHub refuse SSH from the host and stopped the whole fleet.
   */
  maxRemoteFallbacks?: number
}>

export type HostSubmoduleMaterializationResult = Readonly<{
  exitCode: number
  stdout: string
  stderr: string
  considered: number
  borrowed: number
  remoteFallbacks: number
  unreferenced: number
  warmed: number
}>

export type HostSubmoduleMaterializationOptions = Omit<SubmoduleMaterializationOptions, "force"> &
  Readonly<{ env?: NodeJS.ProcessEnv }>

const success = (): SubmoduleGitResult => ({ code: 0, stdout: "", stderr: "" })

/**
 * One gitlink after the LOCAL probes have run and before any network call.
 * `canBorrow` here is provisional: phase B may flip it true after a warm-up.
 */
type Probe = Readonly<{
  canBorrow: boolean
  /**
   * Set only on a miss whose path the reference's HEAD no longer carries.
   * Resolved in phase A because it is a local read and phase B must not attempt
   * a warm-up for it — a fetch aimed at a removed submodule is the network call
   * this whole classification exists to skip.
   */
  detached: Detachment | undefined
  name: string
  path: string
  referenceSubmodule: string | undefined
  required: string
}>

/**
 * A logger that renders to one line-writing sink — for the callers whose output
 * really is a stream of lines (a console, a captured array, a slot report).
 *
 * It exists so those callers do not each hand-roll a loggily pipeline and drift
 * apart on level and span gating. Spans follow the same env gate yrd applies to
 * `-vv` (`yrd-cli/src/observability.ts`), so `TRACE=1` turns on per-phase timing
 * everywhere materialization runs rather than in whichever tool remembered to
 * wire it. Default `info` keeps an ordinary run to the remote-fallback warning.
 *
 * Callers that already HAVE a logger must pass it directly — usually through
 * `child("submodules")` — and not route it through here; that would flatten the
 * structure this whole change exists to preserve.
 */
export function createSubmoduleLogger(write: (line: string) => void): ConditionalLogger {
  const level = (process.env["LOG_LEVEL"] as LogLevel | undefined) ?? "info"
  const spans = process.env["TRACE"] !== undefined || level === "debug" || level === "trace"
  return createLogger("git-super", [
    { level, spans },
    { write: (text: string) => write(String(text).replace(/\n$/u, "")), objectMode: false },
  ])
}

export async function configureSubmoduleAlternatePolicy(git: SubmoduleGit, repo: string): Promise<SubmoduleGitResult> {
  for (const [key, value] of [
    ["submodule.alternateLocation", SUBMODULE_ALTERNATE_LOCATION],
    ["submodule.alternateErrorStrategy", SUBMODULE_ALTERNATE_ERROR_STRATEGY],
  ] as const) {
    const args = ["config", "--local", key, value]
    const configured =
      git.mutateConfig === undefined ? await git.run(repo, args, true) : await git.mutateConfig(repo, args)
    if (configured.code !== 0) return configured
  }
  return success()
}

type Submodule = Readonly<{ name: string; path: string }>

async function submodules(git: SubmoduleGit, repo: string): Promise<Submodule[] | SubmoduleGitResult> {
  const tracked = await git.run(repo, ["cat-file", "-e", "HEAD:.gitmodules"], true)
  if (tracked.code !== 0) return []
  const configured = await git.run(
    repo,
    ["config", "--blob", "HEAD:.gitmodules", "--get-regexp", "^submodule\\..*\\.path$"],
    true,
  )
  if (configured.code === 1 && configured.stdout === "" && configured.stderr === "") return []
  if (configured.code !== 0) return configured
  return configured.stdout
    .split(/\r?\n/u)
    .filter((row) => row !== "")
    .map((row): Submodule | undefined => {
      const match = /^(submodule\.(.+)\.path)\s+(.+)$/u.exec(row)
      return match?.[2] === undefined || match[3] === undefined ? undefined : { name: match[2], path: match[3] }
    })
    .filter((submodule): submodule is Submodule => submodule !== undefined)
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * Report local config that the target tree deliberately does not declare.
 *
 * This is a diagnostic comparison, never an enumeration source: only the
 * entries parsed from `HEAD:.gitmodules` above reach init/update. A removed
 * gitlink can therefore leave any number of keys in one local subsection
 * without resurrecting the path or blocking worktree creation. The subsection
 * is reported once with the exact optional cleanup command.
 */
async function reportStaleLocalSubmoduleConfig(
  git: SubmoduleGit,
  repo: string,
  declared: readonly Submodule[],
  log?: ConditionalLogger,
): Promise<SubmoduleGitResult> {
  const configured = await git.run(
    repo,
    ["config", "--local", "--name-only", "--get-regexp", "^submodule\\..*\\."],
    true,
  )
  if (configured.code === 1 && configured.stdout === "" && configured.stderr === "") return success()
  if (configured.code !== 0) return configured
  const declaredNames = new Set(declared.map(({ name }) => name))
  const staleNames = new Set<string>()
  for (const key of configured.stdout.split(/\r?\n/u)) {
    const name = /^submodule\.(.+)\.[^.]+$/u.exec(key)?.[1]
    if (name !== undefined && !declaredNames.has(name)) staleNames.add(name)
  }
  for (const name of [...staleNames].sort()) {
    const section = `submodule.${name}`
    const cleanup = `git -C ${shellQuote(repo)} config --local --remove-section ${shellQuote(section)}`
    log?.warn?.(`target tree ignores stale local submodule config; optional cleanup: ${cleanup}`, {
      section,
    })
  }
  return success()
}

const GITLINK_ROW = /^160000 commit ([0-9a-f]+)\t/mu

async function requiredGitlink(git: SubmoduleGit, repo: string, path: string): Promise<string | undefined> {
  const tree = await git.run(repo, ["ls-tree", "HEAD", "--", path], true)
  if (tree.code !== 0) return undefined
  return GITLINK_ROW.exec(tree.stdout)?.[1]
}

/**
 * A gitlink the REFERENCE no longer carries at all: its HEAD tree has no entry
 * at this path, so the store the candidate needs was not left cold — it was
 * removed, deliberately, by the commit named here.
 */
type Detachment = Readonly<{ removedBy: string | undefined }>

/**
 * Decide whether a miss is a cold store or a removed submodule, BEFORE any
 * network call. The two look identical at the point of failure and have
 * opposite remedies: a cold store is repaired with one fetch, while a removed
 * one can only be re-authored — no fetch will ever produce a store the
 * repository dropped, and provisioning one reconstitutes layout the repo
 * deliberately shed.
 *
 * Found 2026-08-24 on hh's `hh-web` detachment (`d9558f2038`). Every branch
 * whose tree predates it still carries `hh-web` as a gitlink, so materializing
 * one demanded an object unreachable by design — and the refusal named the
 * missing reference store, inviting exactly the provisioning it must not get.
 * Branch owners were told to submit or recut; both fail at this call.
 *
 * THE FAILED READ IS NOT EVIDENCE. An `ls-tree` that errored says nothing about
 * whether the submodule was removed, and calling an unreadable reference a
 * removal would send a recoverable cold store down the unrecoverable path. Only
 * a SUCCESSFUL read with no gitlink row proves the removal, and only then is the
 * removing commit looked up.
 */
async function detachedFromReference(
  git: SubmoduleGit,
  reference: string,
  path: string,
): Promise<Detachment | undefined> {
  const tree = await git.run(reference, ["ls-tree", "HEAD", "--", path], true)
  if (tree.code !== 0 || GITLINK_ROW.test(tree.stdout)) return undefined
  // Derived, never hardcoded: the same probe names whichever commit detached
  // whichever submodule, so a future layout change is covered on the day it
  // lands rather than the day someone edits this file.
  const removal = await git.run(reference, ["log", "-1", "--format=%h %s", "--diff-filter=D", "HEAD", "--", path], true)
  const removedBy = removal.code === 0 ? removal.stdout.trim() : ""
  return { removedBy: removedBy === "" ? undefined : removedBy }
}

async function referenceContains(git: SubmoduleGit, reference: string, sha: string): Promise<boolean> {
  if (!existsSync(reference)) return false
  return (await git.run(reference, ["cat-file", "-e", `${sha}^{commit}`], true)).code === 0
}

/**
 * `cat-file -e <sha>^{commit}` proves the commit object is present. It does NOT
 * prove the commit's closure is local: in a partial clone the check passes and
 * the borrow then lazily fetches trees and blobs from the promisor remote, so
 * the network work reappears one layer down and `remoteFallbacks` never counts
 * it. Refuse to treat presence as warmth when a promisor is configured, rather
 * than reporting a borrow we cannot honour.
 */
async function promisorRemote(git: SubmoduleGit, repo: string): Promise<string | undefined> {
  if (!existsSync(repo)) return undefined
  const configured = await git.run(
    repo,
    ["config", "--get-regexp", "^(extensions\\.partialclone|remote\\..*\\.(promisor|partialclonefilter))$"],
    true,
  )
  if (configured.code !== 0) return undefined
  const first = configured.stdout.split(/\r?\n/u).find((row) => row.trim() !== "")
  return first === undefined ? undefined : first.trim()
}

/**
 * Repair one cold reference store with a single connection, so the borrow can
 * proceed locally. Without this a miss costs one network connection PER
 * SUBMODULE and leaves every later bay just as cold; with it, one fetch warms
 * the store for the whole fleet. Same operation `ensureCommitObject` already
 * performs for the superproject, aimed at the reference instead.
 *
 * KNOWN NARROWING: this fetches from the REFERENCE's `origin`, while the old
 * fallback used the CANDIDATE's configured submodule URL. Where those differ
 * and only the candidate's URL carries the commit, a materialization that used
 * to succeed now refuses. That is deliberate — a candidate reaching a remote
 * its reference cannot is the fan-out shape this exists to stop — but it is a
 * behaviour change, so the refusal prints both the commit and the reference it
 * consulted rather than leaving the caller to guess which remote was short.
 */
async function warmReference(git: SubmoduleGit, reference: string, sha: string): Promise<SubmoduleGitResult> {
  if (!existsSync(reference)) {
    return { code: 1, stdout: "", stderr: `reference store ${reference} does not exist` }
  }
  return git.run(
    reference,
    ["fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "origin", sha],
    true,
  )
}

/**
 * Guarantee the durable module store line in a materialized submodule's
 * `objects/info/alternates`.
 *
 * A borrow-cloned store holds almost no objects of its own; every read runs
 * through this file. When its only line points into another linked worktree's
 * `worktrees/<wt>/modules` store, recycling that worktree kills the store —
 * measured 2026-08-25 across the fleet estate: 610 stores chained to another
 * worktree, 62 already unreadable. The durable line makes deletion of the
 * borrow survivable, and because this runs after EVERY update — warm no-ops
 * included — it also heals stores emitted before the anchor existed.
 *
 * Never rewrites or reorders existing lines: a borrow stays as the optional,
 * additive first line. Skips only a store that already IS the durable one.
 * A durable store that does not exist yet is announced and still anchored —
 * a dangling alternates line is harmless to git, and it becomes load-bearing
 * the moment the primary checkout materializes that submodule.
 */
async function anchorDurableAlternates(
  git: SubmoduleGit,
  checkout: string,
  durableGitDir: string,
  log?: ConditionalLogger,
): Promise<SubmoduleGitResult> {
  const objects = await git.run(checkout, ["rev-parse", "--path-format=absolute", "--git-path", "objects"], true)
  const ownObjects = objects.stdout.trim()
  if (objects.code !== 0 || ownObjects === "") {
    return {
      code: objects.code === 0 ? 1 : objects.code,
      stdout: objects.stdout,
      stderr:
        `git-super: cannot resolve the object store for materialized submodule '${checkout}'; ` +
        `refusing to leave it without a durable alternates anchor.\n${objects.stderr}`,
    }
  }
  const durableObjects = join(durableGitDir, "objects")
  if (canonical(ownObjects) === canonical(durableObjects)) return success()
  const alternatesFile = join(ownObjects, "info", "alternates")
  let content = ""
  try {
    content = await readFile(alternatesFile, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return {
        code: 1,
        stdout: "",
        stderr: `git-super: cannot read '${alternatesFile}' to anchor the durable module store: ${String(error)}`,
      }
    }
  }
  const target = canonical(durableObjects)
  const anchored = content.split(/\r?\n/u).some((line) => {
    const entry = line.trim()
    if (entry === "" || entry.startsWith("#")) return false
    return canonical(isAbsolute(entry) ? entry : resolve(ownObjects, entry)) === target
  })
  if (anchored) return success()
  if (!existsSync(durableObjects)) {
    log?.warn?.("durable module store does not exist yet; anchoring its line for when it does", {
      checkout,
      durableObjects,
    })
  }
  try {
    await mkdir(join(ownObjects, "info"), { recursive: true })
    await appendFile(alternatesFile, `${content === "" || content.endsWith("\n") ? "" : "\n"}${target}\n`, "utf8")
  } catch (error) {
    return {
      code: 1,
      stdout: "",
      stderr: `git-super: cannot append the durable module store line to '${alternatesFile}': ${String(error)}`,
    }
  }
  log?.debug?.("anchored the durable module store line", { checkout, durable: target })
  return success()
}

/**
 * Materialize isolated submodule checkouts while borrowing object history from
 * the matching checkout in the source repository. Git's documented
 * superproject alternate policy remains the fail-soft fallback for reference-
 * cloned roots; explicit per-path references close the linked-worktree gap.
 *
 * TWO guarantees anchor every store this function touches to the durable
 * module store (`<superproject common dir>/modules/<name>/objects`), because
 * either alone leaves a hole that killed 62 stores on 2026-08-25:
 *
 * 1. Borrows are REDIRECTED to the primary worktree (`primaryWorktree` above),
 *    so a fresh clone's alternates line lands on the durable store instead of
 *    a disposable linked worktree's `worktrees/<wt>/modules` store.
 * 2. After EVERY successful update — fresh clone or warm no-op — the durable
 *    line is appended to the store's `objects/info/alternates` unless already
 *    present (`anchorDurableAlternates` below). Redirection alone cannot do
 *    this: a warm `submodule update` never rewrites alternates, so a store
 *    that was emitted before the redirect existed would stay chained to its
 *    disposable borrow forever. Any pre-existing borrow line is kept — it is
 *    a performance borrow, additive and optional, never the store of record.
 */
export async function materializeSubmodules(
  git: SubmoduleGit,
  options: SubmoduleMaterializationOptions,
): Promise<SubmoduleMaterializationResult> {
  const log = options.log
  const requestedReference =
    options.referenceWorktree !== undefined && resolve(options.referenceWorktree) !== resolve(options.worktree)
      ? options.referenceWorktree
      : undefined
  let referenceRoot: string | undefined
  if (requestedReference !== undefined) {
    const primary = await primaryWorktree(git, requestedReference)
    if (typeof primary !== "string") {
      return { ...primary, considered: 0, borrowed: 0, remoteFallbacks: 0, unreferenced: 0, warmed: 0 }
    }
    if (canonical(primary) !== canonical(options.worktree)) referenceRoot = primary
  }
  let borrowed = 0
  let remoteFallbacks = 0
  let warmed = 0
  /** Gitlinks materialized straight from the network because NO reference store
   * was supplied for them. Legitimate for a plain clone; a silent bug when the
   * caller meant to pass `referenceWorktree`. Counted so the two are separable. */
  let unreferenced = 0
  /**
   * Every gitlink this run resolved, at every depth — the DENOMINATOR the other
   * counters are fractions of, and the number none of them can be read without.
   *
   * The partition is EXACT and total: `borrowed + remoteFallbacks + unreferenced
   * === considered`. `warmed` is deliberately NOT part of it — it counts a
   * subset of `borrowed`, the ones that only became borrowable after a fetch, so
   * adding it would double-count. An earlier revision shipped `considered` on
   * the span only; a caller reading the result got counts with no total, which
   * is the same defect one layer out.
   */
  let considered = 0
  const maxRemoteFallbacks = options.maxRemoteFallbacks ?? 0
  /**
   * `reference` is non-optional on purpose: every push site below sits inside
   * `referenceSubmodule !== undefined`, so a `string | undefined` here invited a
   * `?? "(none supplied)"` fallback that could never render — and that dead
   * string was reported as real coverage. The type now proves what the prose
   * used to assert.
   */
  const misses: Array<
    Readonly<{ detached: Detachment | undefined; path: string; reference: string; required: string; why: string }>
  > = []

  /**
   * The git dir under which this superproject's submodules have their durable
   * stores (`<here>/modules/<name>`). Resolved LAZILY — only a successful
   * update needs it — and cached, because it is one `rev-parse` per whole run.
   * For a linked worktree the common dir crosses to the primary repository,
   * which is exactly what makes the anchored line survive worktree recycling.
   */
  let durableRoot: Promise<string | SubmoduleGitResult> | undefined
  const resolveDurableRoot = (): Promise<string | SubmoduleGitResult> =>
    (durableRoot ??= (async () => {
      const common = await git.run(options.worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"], true)
      const dir = common.stdout.trim()
      if (common.code !== 0 || dir === "") {
        return {
          code: common.code === 0 ? 1 : common.code,
          stdout: common.stdout,
          stderr:
            `git-super: cannot resolve the common git dir for '${options.worktree}'; refusing to materialize ` +
            `a submodule store without a durable alternates anchor — an un-anchored store dies with whichever ` +
            `worktree it borrowed from.\n${common.stderr}`,
        }
      }
      return dir
    })())

  const walk = async (
    worktree: string,
    reference: string | undefined,
    durableLevel: () => Promise<string | SubmoduleGitResult>,
    selectedPaths?: ReadonlySet<string>,
    depth = 0,
  ): Promise<SubmoduleGitResult> => {
    const policy = await configureSubmoduleAlternatePolicy(git, worktree)
    if (policy.code !== 0) return policy

    const entries = await submodules(git, worktree)
    if (!Array.isArray(entries)) return entries
    if (depth === 0) {
      const staleConfig = await reportStaleLocalSubmoduleConfig(git, worktree, entries, log)
      if (staleConfig.code !== 0) return staleConfig
    }
    // A LEVEL WITH NO SUBMODULES HAS NOTHING TO TIME, and emitting a span for it
    // buries the ones that carry signal. Measured 2026-08-22 on a full 17-gitlink
    // run: 17 of 18 `walk` spans were leaves, every lap zero except `enumerate`.
    // Everything below is a no-op by construction when `entries` is empty — the
    // resolve loop does not run, `resolved` and `prepared` stay empty, the
    // refusal cannot fire at 0 > 0, and both update loops are empty — so this
    // early return is behaviourally identical to falling through.
    //
    // The enumeration cost is NOT lost, only re-attributed: a leaf's enumerate
    // happens inside its parent's `local` lap and is counted there. Depth 0
    // always has submodules, so the one enumerate measurement worth reading
    // (24ms of 402ms on the measured run) still lands on the depth-0 span.
    if (entries.length === 0) return success()
    // Laps rather than nested spans: the phases below are sequential and always
    // run in the same order, so one record with five deltas reads better than
    // five span lines per level of recursion. `gitlinks` is on the span so a
    // reader sees the width this level worked at, not only its duration.
    //
    // THERE IS NO `enumerate` LAP ANY MORE, deliberately. The span now starts
    // AFTER the policy write and the `.gitmodules` read, so a lap named for that
    // work would measure the microseconds since the span opened and report ~0ms
    // for something that measured 24ms of a 402ms run. A lap that names one thing
    // and times another is worse than an absent one. The laps below now sum to
    // this span's duration, and the excluded policy+enumerate cost is visible as
    // the gap between the `materialize` span and the depth-0 `walk` span.
    using span = log?.span?.("walk", { worktree, depth, gitlinks: entries.length })
    const resolved: Array<Probe> = []
    // PHASE A — LOCAL PROBES, BATCHED. `ls-tree` and `cat-file -e` are read-only
    // and touch different repositories, so they parallelize at the same bound the
    // update pass already uses. This was 89ms of a 402ms run done one submodule at
    // a time, feeding a stage that was already 20-wide.
    //
    // NOTHING IN THIS PHASE TOUCHES THE NETWORK. That is the invariant, not an
    // observation: the moment a network call is added here it fans out N-wide,
    // which is exactly the shape that made GitHub refuse SSH from this host on
    // 2026-08-21. Warm-ups live in phase B below and stay serialized.
    const selected = entries.filter(({ path }) => selectedPaths === undefined || selectedPaths.has(path))
    const probes: Array<Probe | SubmoduleGitResult> = []
    for (let start = 0; start < selected.length; start += MAX_CONCURRENT_SUBMODULE_UPDATES) {
      probes.push(
        ...(await Promise.all(
          selected
            .slice(start, start + MAX_CONCURRENT_SUBMODULE_UPDATES)
            .map(async ({ name, path }): Promise<Probe | SubmoduleGitResult> => {
              const required = await requiredGitlink(git, worktree, path)
              if (required === undefined) {
                return { code: 1, stdout: "", stderr: `could not resolve gitlink '${path}' in ${worktree}` }
              }
              const referenceSubmodule = reference === undefined ? undefined : join(reference, path)
              const canBorrow =
                referenceSubmodule !== undefined && (await referenceContains(git, referenceSubmodule, required))
              const detached =
                canBorrow || reference === undefined ? undefined : await detachedFromReference(git, reference, path)
              return { canBorrow, detached, name, path, referenceSubmodule, required }
            }),
        )),
      )
    }
    const unresolved = probes.find((probe): probe is SubmoduleGitResult => "code" in probe)
    if (unresolved !== undefined) return unresolved
    span?.lap("probe")

    // PHASE B — THE NETWORK, STRICTLY ONE AT A TIME. Only a miss reaches this
    // loop, so on a healthy reference store it does nothing at all.
    for (const { canBorrow: borrowable, detached, name, path, referenceSubmodule, required } of probes as Probe[]) {
      let canBorrow = borrowable
      if (!canBorrow && referenceSubmodule !== undefined) {
        // One connection into the reference repairs it for every later bay;
        // sixteen connections out of sixteen candidates repair nothing.
        const promisor = detached !== undefined ? undefined : await promisorRemote(git, referenceSubmodule)
        if (detached !== undefined) {
          // NO WARM-UP. The reference dropped this submodule, so the fetch below
          // would ask a store that does not exist for an object nothing will
          // ever put there. Skipping it is the pre-flight: the refusal lands
          // before the network rather than after a failure that reads retryable.
          misses.push({
            detached,
            path,
            reference: referenceSubmodule,
            required,
            why:
              `the reference no longer carries this submodule` +
              (detached.removedBy === undefined ? "" : `; removed by ${detached.removedBy}`),
          })
        } else if (promisor !== undefined) {
          misses.push({
            detached: undefined,
            path,
            reference: referenceSubmodule,
            required,
            why: `reference is a partial clone (${promisor}); object presence there cannot prove the borrow is local`,
          })
        } else {
          // The one network call on the healthy path. Its own span, because
          // "materialization was slow" and "the reference store was cold" are
          // different problems with different owners, and only the split tells
          // you which one you have.
          using warmSpan = log?.span?.("warm", { path, required, reference: referenceSubmodule })
          log?.debug?.("warming the reference with one fetch", { path, required })
          const warm = await warmReference(git, referenceSubmodule, required)
          canBorrow = warm.code === 0 && (await referenceContains(git, referenceSubmodule, required))
          if (warmSpan !== undefined) {
            Object.assign(warmSpan.spanData, { outcome: canBorrow ? "warmed" : "failed" })
          }
          if (canBorrow) {
            warmed += 1
          } else {
            misses.push({
              detached: undefined,
              path,
              reference: referenceSubmodule,
              required,
              why:
                warm.code === 0
                  ? "warm-up fetch succeeded but the reference still lacks the commit"
                  : `warm-up fetch failed: ${warm.stderr.trim() || `exit ${warm.code}`}`,
            })
          }
        }
      }
      resolved.push({ canBorrow, detached, name, path, referenceSubmodule, required })
      considered += 1
    }
    span?.lap("resolve")
    if (resolved.length > 0) {
      const initArgs = ["submodule", "init", "--", ...resolved.map(({ path }) => path)]
      const initialized =
        git.mutateConfig === undefined
          ? await git.run(worktree, initArgs, true)
          : await git.mutateConfig(worktree, initArgs)
      if (initialized.code !== 0) return initialized
    }
    span?.lap("init")
    // `config --get` is another read-only local call, and it was the other
    // sequential stretch: 29ms of the same 402ms run, one spawn per submodule.
    // Batched at the same bound, and still no network — the URL is read from
    // local config, never contacted.
    const configuredUrls: SubmoduleGitResult[] = []
    for (let start = 0; start < resolved.length; start += MAX_CONCURRENT_SUBMODULE_UPDATES) {
      configuredUrls.push(
        ...(await Promise.all(
          resolved
            .slice(start, start + MAX_CONCURRENT_SUBMODULE_UPDATES)
            .map(({ name }) => git.run(worktree, ["config", "--get", `submodule.${name}.url`], true)),
        )),
      )
    }
    const prepared: Array<
      Readonly<{ args: readonly string[]; name: string; nestedReference: string | undefined; path: string }>
    > = []
    for (const [index, { canBorrow, name, path, referenceSubmodule, required }] of resolved.entries()) {
      const configuredUrl = configuredUrls[index]
      if (configuredUrl === undefined || configuredUrl.code !== 0 || configuredUrl.stdout.trim() === "") {
        return {
          code: configuredUrl === undefined || configuredUrl.code === 0 ? 1 : configuredUrl.code,
          stdout: configuredUrl?.stdout ?? "",
          stderr: configuredUrl?.stderr || `could not resolve configured URL for submodule '${name}' in ${worktree}`,
        }
      }
      const borrowFrom = canBorrow && referenceSubmodule !== undefined ? referenceSubmodule : undefined
      const args = [
        "-c",
        `submodule.alternateLocation=${SUBMODULE_ALTERNATE_LOCATION}`,
        "-c",
        `submodule.alternateErrorStrategy=${SUBMODULE_ALTERNATE_ERROR_STRATEGY}`,
        ...(borrowFrom === undefined
          ? []
          : [
              "-c",
              "protocol.file.allow=always",
              "-c",
              `url.${pathToFileURL(borrowFrom).href}.insteadOf=${configuredUrl.stdout.trim()}`,
            ]),
        "submodule",
        "update",
        "--init",
        ...(options.force ? ["--force"] : []),
        ...(borrowFrom === undefined ? [] : ["--reference", borrowFrom]),
        "--",
        path,
      ]
      if (borrowFrom !== undefined) {
        borrowed += 1
      } else if (referenceSubmodule !== undefined) {
        remoteFallbacks += 1
        log?.warn?.("local store lacks the pin; using the configured remote fallback", { path, required })
      } else {
        // NO REFERENCE STORE AT ALL — counted, because the alternative is the
        // hole this whole change exists to close. This submodule goes to the
        // network and increments neither of the counters above, so before this
        // it was invisible: a plain clone and a caller who MEANT to pass
        // referenceWorktree and forgot produced byte-identical output. That is
        // one of the three causes 2026-08-21 could not tell apart, and it was
        // the one the fail-loud did not reach.
        unreferenced += 1
      }
      prepared.push({ args, name, nestedReference: borrowFrom, path })
    }
    span?.lap("prepare")
    // A borrow clones from a local path and may fan out; a remote fallback
    // opens a network connection per submodule and must not. On 2026-08-21
    // several seats materializing 16 submodules each, 20-wide, with every
    // update falling back, made GitHub refuse SSH from the host outright
    // (port 22 refused, 443 reset at key exchange) and stopped every fetch,
    // push, submit and landing fleet-wide. Local first, wide; then remote,
    // one at a time.
    const local = prepared.filter(({ nestedReference }) => nestedReference !== undefined)
    const viaRemote = prepared.filter(({ nestedReference }) => nestedReference === undefined)
    // NO SILENT ERRORS. Until now this counter was incremented, printed, and
    // read by nobody: the exact signal that would have caught 2026-08-21 went
    // into a log with no consumer, and the fleet spent a night inferring a
    // quantity it was already measuring. Refuse, and say which pin is missing
    // and what would repair it — a bare count is what made this invisible.
    // Only when a reference store EXISTS is a fallback a failure. With no
    // reference the caller has no local source and the network is the only
    // option — that is a plain clone doing its job, not the 16-wide fan-out.
    // THE THIRD CAUSE, and the one this file could not previously express.
    // With no reference store the refusal below never fires, so a caller who
    // forgot `referenceWorktree` got a silent network materialization that was
    // byte-identical to a legitimate plain clone. Not an error — a plain clone
    // is doing its job — but it must be SAYABLE, so it is said once per level,
    // with the count and the option that would have changed it. `warn` rather
    // than `debug` because the expensive direction of error is the quiet one.
    if (reference === undefined && viaRemote.length > 0) {
      log?.warn?.("no reference store supplied; materializing from the network", {
        worktree,
        depth,
        fromNetwork: viaRemote.length,
        ofGitlinks: prepared.length,
        pass: "referenceWorktree to borrow locally instead",
      })
    }
    if (reference !== undefined && viaRemote.length > maxRemoteFallbacks) {
      const detail = misses
        // `reference` is always defined here — every misses.push sits inside
        // `referenceSubmodule !== undefined`. It used to render
        // `reference ?? "(none supplied)"`, which was unreachable, and I
        // reported that dead string to @chief as the diagnostic covering the
        // no-reference case. It never covered anything. The real coverage for
        // that case is the refusal below, which needs no reference to fire.
        .map(
          ({ path, reference, required, why }) =>
            `  ${path} needs ${required}\n    reference: ${reference}\n    why: ${why}`,
        )
        .join("\n")
      // TWO CLASSES, TWO REMEDIES, AND ONLY THE APPLICABLE ONE PRINTS. A cold
      // store is repaired by a fetch; a removed submodule is not repairable at
      // all, and printing the fetch beside it is what sent branch owners to
      // provision a store the repository had deliberately dropped.
      const removed = misses.filter(({ detached }) => detached !== undefined)
      const repairable = misses.filter(({ detached }) => detached === undefined)
      const detachmentRemedy =
        removed.length === 0
          ? ""
          : `\nThis tree PREDATES a submodule removal, so no fetch can repair it:\n` +
            removed
              .map(
                ({ detached, path }) =>
                  `  ${path} was removed from ${reference}` +
                  (detached?.removedBy === undefined ? "" : ` by ${detached.removedBy}`),
              )
              .join("\n") +
            `\nDo NOT provision a reference store for it — that reconstitutes layout the repository dropped.\n` +
            `A rebase does not help either; it still materializes this tree.\n` +
            `Re-author the change onto a branch cut from current ${reference} HEAD, and close the original ` +
            `as superseded once the replacement is on the landing branch by content.\n`
      const repairRemedy =
        repairable.length === 0
          ? ""
          : `Repair the reference store, then retry:\n` +
            repairable
              .map(({ reference, required }) => `  git -C ${reference} fetch --no-tags origin ${required}`)
              .join("\n") +
            `\nRaise --max-remote-fallbacks only with a reason; one connection per submodule across several ` +
            `candidates is what made GitHub refuse SSH from this host on 2026-08-21.\n`
      return {
        code: 1,
        stdout: "",
        stderr:
          `git-super: ${viaRemote.length} submodule(s) would open their own network connection after warm-up ` +
          `(limit ${maxRemoteFallbacks}); refusing.\n${detail}\n${detachmentRemedy}${repairRemedy}`,
      }
    }
    const update = async ({
      args,
      name,
      nestedReference,
      path,
    }: Readonly<{ args: readonly string[]; name: string; nestedReference: string | undefined; path: string }>) => {
      const source = nestedReference === undefined ? "remote" : "local"
      // The span closes over the `git.run` ALONE. Letting it wrap the recursive
      // walk below would bill every nested submodule to its parent, so the one
      // submodule at the root of a deep tree would appear to be the slow one
      // and the actually-slow leaf would never show up in the ranking.
      const updated = await (async () => {
        using updateSpan = log?.span?.("update", { path, source })
        const result = await git.run(worktree, args, true)
        if (updateSpan !== undefined) {
          Object.assign(updateSpan.spanData, { outcome: result.code === 0 ? "ok" : "failed" })
        }
        return result
      })()
      if (updated.code !== 0) return updated
      const level = await durableLevel()
      if (typeof level !== "string") return level
      const durableGitDir = join(level, "modules", name)
      const anchored = await anchorDurableAlternates(git, join(worktree, path), durableGitDir, log)
      if (anchored.code !== 0) return anchored
      return walk(join(worktree, path), nestedReference, async () => durableGitDir, undefined, depth + 1)
    }
    for (let start = 0; start < local.length; start += MAX_CONCURRENT_SUBMODULE_UPDATES) {
      const results = await Promise.all(local.slice(start, start + MAX_CONCURRENT_SUBMODULE_UPDATES).map(update))
      const failed = results.find((result) => result.code !== 0)
      if (failed !== undefined) return failed
    }
    span?.lap("local")
    for (const entry of viaRemote) {
      const result = await update(entry)
      if (result.code !== 0) return result
    }
    span?.lap("remote")
    return success()
  }

  const selectedPaths = options.paths === undefined ? undefined : new Set(options.paths)
  using span = log?.span?.("materialize", { worktree: options.worktree, reference: referenceRoot })
  const result = await walk(options.worktree, referenceRoot, resolveDurableRoot, selectedPaths)
  // ONE record carrying the totals AND what they are totals of. The counters
  // existed before this and were printed into a log with no reader; a reader
  // that gets `remoteFallbacks: 16` still cannot tell a broken reference store
  // from a repository that simply has sixteen submodules. Shipping the
  // denominator alongside the count is the whole difference.
  if (span !== undefined) {
    Object.assign(span.spanData, {
      considered,
      borrowed,
      warmed,
      remoteFallbacks,
      unreferenced,
      outcome: result.code === 0 ? "ok" : "failed",
    })
  }
  return { ...result, considered, borrowed, remoteFallbacks, unreferenced, warmed }
}

function adaptGitProcess(process: GitProcess): SubmoduleGit {
  const run: SubmoduleGit["run"] = async (repo, args) => {
    const result = await process.run({ repo, args })
    return { code: result.code, stdout: result.stdout, stderr: result.stderr }
  }
  const mutateConfig: NonNullable<SubmoduleGit["mutateConfig"]> = async (repo, args) => {
    let result = await run(repo, args, true)
    for (
      let attempt = 1;
      result.code !== 0 && result.stderr.includes("could not lock config file") && attempt < 20;
      attempt += 1
    ) {
      await Bun.sleep(attempt * 5)
      result = await run(repo, args, true)
    }
    return result
  }
  return { run, mutateConfig }
}

/** Canonical GitProcess entry; the legacy SubmoduleGit overload is a compatibility boundary for Gate D. */
export function materializeSubmodulesWithProcess(
  process: GitProcess,
  options: SubmoduleMaterializationOptions,
): Promise<SubmoduleMaterializationResult> {
  return materializeSubmodules(adaptGitProcess(process), options)
}

function hostGit(environment: NodeJS.ProcessEnv): SubmoduleGit {
  return adaptGitProcess(createLocalGitProcess(environment))
}

function canonical(pathname: string): string {
  return existsSync(pathname) ? realpathSync(pathname) : resolve(pathname)
}

function parseWorktrees(output: string): Array<Readonly<{ path: string; branch?: string }>> {
  const entries: Array<{ path: string; branch?: string }> = []
  let current: { path: string; branch?: string } | undefined
  for (const line of output.split(/\r?\n/u)) {
    if (line.startsWith("worktree ")) {
      if (current !== undefined) entries.push(current)
      current = { path: line.slice("worktree ".length) }
    } else if (current !== undefined && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length)
    } else if (line === "" && current !== undefined) {
      entries.push(current)
      current = undefined
    }
  }
  if (current !== undefined) entries.push(current)
  return entries
}

async function primaryWorktree(git: SubmoduleGit, repo: string): Promise<string | SubmoduleGitResult> {
  const listed = await git.run(repo, ["worktree", "list", "--porcelain"], true)
  if (listed.code !== 0) {
    return {
      code: listed.code,
      stdout: listed.stdout,
      stderr:
        `git-super: cannot prove the primary worktree for reference '${repo}'; refusing to create ` +
        `submodule alternates from a potentially disposable linked worktree.\n${listed.stderr}`,
    }
  }
  const primary = parseWorktrees(listed.stdout)[0]?.path
  if (primary === undefined || !existsSync(primary)) {
    return {
      code: 1,
      stdout: listed.stdout,
      stderr:
        `git-super: cannot prove the primary worktree for reference '${repo}'; ` +
        `git worktree list did not return an existing primary path.`,
    }
  }
  return canonical(primary)
}

/** Host adapter for callers that need git-super to supply the Git process. */
export async function materializeSubmodulesFromLocalWorktreeParallel(
  options: HostSubmoduleMaterializationOptions,
): Promise<HostSubmoduleMaterializationResult> {
  const environment = cleanGitRepositoryEnvironment(options.env ?? process.env)
  const git = hostGit(environment)
  const discovered =
    options.referenceWorktree === undefined ? await primaryWorktree(git, options.worktree) : options.referenceWorktree
  if (typeof discovered !== "string") {
    return {
      ...discovered,
      exitCode: discovered.code,
      considered: 0,
      borrowed: 0,
      remoteFallbacks: 0,
      unreferenced: 0,
      warmed: 0,
    }
  }
  const referenceWorktree =
    discovered !== undefined && canonical(discovered) !== canonical(options.worktree) ? discovered : undefined
  const result = await materializeSubmodules(git, {
    worktree: options.worktree,
    ...(referenceWorktree === undefined ? {} : { referenceWorktree }),
    ...(options.paths === undefined ? {} : { paths: options.paths }),
    ...(options.log === undefined ? {} : { log: options.log }),
    // Forwarded, not defaulted. This adapter accepted `maxRemoteFallbacks` in
    // its type and dropped it on the floor, so a caller that raised the bound
    // got the zero default and a refusal it had explicitly opted out of — the
    // option was documented, type-checked, and inert.
    ...(options.maxRemoteFallbacks === undefined ? {} : { maxRemoteFallbacks: options.maxRemoteFallbacks }),
  })
  return { ...result, exitCode: result.code }
}

/**
 * Synchronous compatibility adapter for the branch-creation API. The child
 * executes the same async materializer above; no second Git traversal exists.
 */
export function materializeSubmodulesFromLocalWorktree(
  options: HostSubmoduleMaterializationOptions,
): HostSubmoduleMaterializationResult {
  const child = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./submodule-runner.ts", import.meta.url)),
      JSON.stringify({
        worktree: options.worktree,
        referenceWorktree: options.referenceWorktree,
        paths: options.paths,
      }),
    ],
    { encoding: "utf8", env: cleanGitRepositoryEnvironment(options.env ?? process.env) },
  )
  if (child.status !== 0) {
    return {
      exitCode: child.status ?? 1,
      stdout: child.stdout ?? "",
      stderr: child.stderr ?? child.error?.message ?? "git-super submodule runner failed",
      // The run failed before reporting, so these counts are unknown rather
      // than zero. Read them only alongside a zero exitCode. `considered: 0` is
      // the honest reading of that: nothing was successfully considered, so
      // every fraction over it is undefined rather than zero.
      considered: 0,
      borrowed: 0,
      remoteFallbacks: 0,
      unreferenced: 0,
      warmed: 0,
    }
  }
  try {
    const payload = JSON.parse(child.stdout ?? "") as HostSubmoduleMaterializationResult & {
      messages?: readonly string[]
    }
    // Structure does not survive the process boundary: the child ran the spans
    // in its own logger and only its rendered lines come back. Replayed at info
    // so they are not lost, but a caller wanting per-phase timing must use the
    // async entry point, which keeps the live logger. Deliberately not an event
    // serialization bridge — this path has one caller (tools/task-branch.ts)
    // and it passes no logger at all.
    for (const message of payload.messages ?? []) options.log?.info?.(message)
    return payload
  } catch (error) {
    return {
      exitCode: 1,
      stdout: child.stdout ?? "",
      stderr: `git-super submodule runner emitted invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      // Unknown, not zero — see above.
      considered: 0,
      borrowed: 0,
      remoteFallbacks: 0,
      unreferenced: 0,
      warmed: 0,
    }
  }
}
