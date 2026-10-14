import { createHash, randomUUID } from "node:crypto"
import {
  cpSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
} from "node:fs"
import { tryAcquireFlock, type FlockHandle } from "@bearly/flock"
import { fileLockHolders, formatLockHolders } from "@bearly/flock/holders"
import { spawnSync } from "node:child_process"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { classifyExcludedPath, inspectExcludedCheckout, superStatus, type SuperStatusResult } from "./status.ts"
import { readCommitSubmodules, readPrivateSubmodules, type SelectedCommitSubmodules } from "./commit-graph.ts"
import type { PrivateGitProjection } from "./private-git-projection.ts"
import { alternatesLineage } from "./alternates.ts"
import { validateExcludedSubmodules, withGitTimeout } from "./git.ts"
import type { GitProcess } from "./process.ts"
import type { ConsultedRepository, NotCompared } from "./diff.ts"
import type { Git, WorktreeInspection } from "./worktree.ts"
import { removalBorrowers, type RemovalBorrower } from "./worktree-administration.ts"

/** What a removal guard needs to know about the store it is about to destroy (28661). */
export type PrivateStoreCustody = Readonly<{
  /** Absolute Git dir of the worktree being removed; the store it may destroy lives at `<adminDir>/modules/<name>`. */
  adminDir: string
  /** The superproject whose commits carry the `.gitmodules` declarations. */
  repository: string
  /** The target worktree's own HEAD commit. */
  head: string
  /** Paths the caller has ALREADY taken custody of. A declared-private path here is the caller's proof, not an exemption. */
  excludedSubmodules?: readonly string[]
}>

/** One refused store, named so a caller can be told exactly which bytes were about to go. */
export type PrivateStoreRefusal = Readonly<{ name: string; path: string; head: string; store: string }>

/**
 * The refusal as a CLASS, so a caller can tell "these bytes must not be deleted" from "git failed" without
 * matching message text. A queue that has to discard a tree skips it, names it once and continues on a refusal;
 * anything else still stops the round. Same message, same named stores — only the type is new (@cto C4).
 */
export class PrivateStoreRefusalError extends Error {
  constructor(
    message: string,
    /**
     * The refused stores, structured. A caller that must NAME the route (yrd's env close, 27120) reads the
     * guard's own answer from here rather than re-deriving `modules/<name>` or parsing this message.
     */
    readonly refusals: readonly PrivateStoreRefusal[] = [],
  ) {
    super(message)
    this.name = "PrivateStoreRefusalError"
  }
}

/**
 * The commits whose declaration decides whether a store inside `adminDir` is private: the target's own HEAD,
 * plus the repository's current `main` when it differs (chief custody ruling (b), 2026-10-11 — a store is
 * private for what it holds, not for how old the target's HEAD is). ONE function owns this key, so the ruling
 * can change without a second copy of it appearing beside the guard.
 */
async function privateDeclarationHeads(process: GitProcess, repository: string, head: string): Promise<string[]> {
  // `for-each-ref` exits 0 with EMPTY output when the ref is absent, so "no main here" is an answer this guard
  // can read without ever collapsing a broken transport into it. (`rev-parse --verify --quiet` exits 1, which a
  // seam may surface as either a code or a throw, and one of those two would have had to be guessed at.)
  const result = await process.run({
    repo: repository,
    args: ["for-each-ref", "--format=%(objectname)", "refs/heads/main"],
  })
  if (result.code !== 0) {
    throw new Error(
      `cannot read refs/heads/main in ${repository} before judging a private store: ${result.stderr.trim() || `exit ${result.code}`}`,
    )
  }
  const main = result.stdout.trim()
  const heads = [head]
  if (main !== "" && main !== head) heads.push(main)
  return heads
}

/**
 * Every declared-private store that EXISTS under one admin dir's `modules` tree, each with the section name
 * whose directory holds it. ONE reader (`readPrivateSubmodules`) keyed by the ONE declaration-head function, so
 * the refusal guard and the retention copy can never disagree about which directories are private.
 *
 * `excluded` is the CALLER's custody proof and is honoured only where the caller asked for it (the guard).
 * Retention passes none: a private store is NEVER copied into retained-modules, however its custody was proved
 * (@cto 2026-10-11; chief ruling c8a3b06d).
 */
async function privateStoresIn(
  process: GitProcess,
  repository: string,
  head: string,
  adminDir: string,
  excluded: ReadonlySet<string>,
): Promise<PrivateStoreRefusal[]> {
  const modules = join(adminDir, "modules")
  if (!present(modules)) return []
  const refusals: PrivateStoreRefusal[] = []
  for (const at of await privateDeclarationHeads(process, repository, head)) {
    for (const declared of await readPrivateSubmodules(process, repository, at)) {
      if (excluded.has(declared.path)) continue
      const store = join(modules, declared.name)
      if (!present(store)) continue
      if (refusals.some((entry) => entry.store === store)) continue
      refusals.push({ name: declared.name, path: declared.path, head: at, store })
    }
  }
  return refusals
}

/**
 * Refuse a removal whose target admin dir holds the Git store of a submodule a removal-visible declaration
 * calls private — unless the caller declared that path excluded.
 *
 * 28661. `assertExcludedRemovalCustody` returned early on an EMPTY exclusion list, so every caller naming no
 * exclusion took Git's plain removal and destroyed `<admin dir>/modules/<name>` without ever proving the
 * bytes inside it: bay cleanup, a reaper, a cleanup sweep, a hand run. The DECLARATION decides, never the
 * caller's list. A caller may ADD an exclusion — that is how custody is proved, and R2 then judges the store —
 * but it can never turn this refusal off by naming nothing.
 *
 * The guard reads declarations and EXISTENCE only: it never reads, copies, hashes or renames a byte inside the
 * store (27058; chief ruling c8a3b06d).
 */
export async function assertNoPrivateStore(process: GitProcess, custody: PrivateStoreCustody): Promise<void> {
  const refusals = await privateStoresIn(
    process,
    custody.repository,
    custody.head,
    custody.adminDir,
    new Set(custody.excludedSubmodules ?? []),
  )
  if (refusals.length === 0) return
  throw new PrivateStoreRefusalError(
    `git-super: worktree removal would destroy a private submodule store: ${refusals
      .map((entry) => `${entry.path} (section ${entry.name}) store ${entry.store}, declared private at ${entry.head}`)
      .join("; ")}; worktree preserved; take custody of each store first (the operator empties the checkout, runs ` +
      `'git super worktree private-store verify <store> --checkout <checkout>', then removes the store), then ` +
      `retry — or pass --exclude-submodule for a path whose custody you have already proved`,
    refusals,
  )
}

export type WorktreeRemovalProof = Readonly<{
  path: string
  head: string
  checkout?: "absent"
  repositories: readonly string[]
  modules: string
  retained: string | null
  manifest: string
  createdAt: string
  retainUntil: string
  rehomedBorrowers?: readonly string[]
  writerLocks: readonly WriterLockProof[]
  createdWriterLocks: readonly WriterLockProof[]
  notCompared: readonly NotCompared[]
}>

export type WriterLockProof = Readonly<{ path: string; body: string; lease: "free" }>

export type RemovalWriterLeases = Readonly<{
  proof: readonly WriterLockProof[]
  created: readonly WriterLockProof[]
  refusal: (error: unknown) => unknown
  release: () => void
}>

export type WorktreeRetention = Readonly<{
  root: string
  report: (proof: WorktreeRemovalProof) => void
}>

function within(parent: string, path: string): boolean {
  const part = relative(parent, path)
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part))
}

function toCanonical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/** Parent metadata must establish excluded custody before leases inspect any store. */
type RemovalParent = Readonly<{ adminDir: string; name: string; head: string; metadata: SelectedCommitSubmodules }>
type ExcludedRemovalCustody = Readonly<{
  notCompared: readonly NotCompared[]
  declaredPaths: readonly string[]
  borrowers: readonly RemovalParent[]
}>

export async function assertExcludedRemovalCustody(
  git: Git,
  process: GitProcess,
  requested: string,
  gitDir: string,
  commonDir: string,
  excludedSubmodules: readonly string[] = [],
): Promise<ExcludedRemovalCustody> {
  validateExcludedSubmodules(excludedSubmodules)
  if (excludedSubmodules.length === 0) return { notCompared: [], declaredPaths: [], borrowers: [] }
  const checkout = realpathSync(requested)
  const parents: RemovalParent[] = []
  for (const candidate of [{ adminDir: gitDir, name: "target" }, ...removalBorrowers(commonDir, gitDir)]) {
    const parentProcess: GitProcess = {
      run: (request) =>
        process.run({ ...request, repo: checkout, args: ["--git-dir", candidate.adminDir, ...request.args] }),
    }
    const head = await git.text(checkout, ["--git-dir", candidate.adminDir, "rev-parse", "--verify", "HEAD"])
    const metadata = await readCommitSubmodules(parentProcess, checkout, head, { excludedSubmodules })
    parents.push({ ...candidate, head, metadata })
  }
  const notCompared: NotCompared[] = []
  const declaredPaths: string[] = []
  for (const path of new Set(excludedSubmodules)) {
    const { state, checkout: disk, unsafeAncestor } = inspectExcludedCheckout(checkout, path)
    const evidence = parents.map((parent) => {
      const selected = parent.metadata.selectedPaths.find((entry) => entry.path === path)
      if (selected === undefined) {
        throw new Error(`missing selected parent evidence for excluded ${path} at ${parent.head}`)
      }
      return { ...selected, repository: parent.adminDir, head: parent.head }
    })
    const exclusion = classifyExcludedPath(path, evidence, disk)
    const declared = exclusion.classification === "declared"
    const absent = exclusion.classification === "absent"
    if (!declared) {
      notCompared.push({
        path,
        reason: absent ? "excluded" : "inconsistent",
        message: absent
          ? `excluded ${path}: absent at HEAD and on disk, nothing to protect`
          : `excluded ${path}: inconsistent parent identity; ${evidence.map((entry) => `${entry.repository} HEAD ${entry.head}: tree ${entry.treeEntry?.mode ?? "absent"}, declarations ${entry.declarations.map(({ name }) => name).join(",") || "none"}`).join("; ")}; checkout ${disk}; preserve and resolve the disagreement before removal`,
        exclusion,
      })
      continue
    }
    if (unsafeAncestor !== undefined) {
      throw new Error(
        `excluded submodule ${path} has unsafe checkout ancestor ${unsafeAncestor}; worktree preserved; resolve that ancestor before retrying removal`,
      )
    }
    const declaration = evidence[0]?.declarations[0]
    if (declaration === undefined) throw new Error(`missing declared exclusion identity for ${path}`)
    validateExcludedSubmodules([declaration.name])
    if (state !== "absent" && state !== "empty") {
      throw new Error(
        `excluded submodule ${path} checkout is ${state}; worktree preserved; preserve its content and resolve its checkout before retrying removal`,
      )
    }
    const store = await git.text(checkout, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      `modules/${declaration.name}`,
    ])
    if (store === "" || !isAbsolute(store)) {
      throw new Error(
        `excluded submodule ${path} has an invalid parent-resolved store path ${JSON.stringify(store)}; inspect its declaration in parent ${checkout} before retrying removal`,
      )
    }
    if ((within(checkout, store) || within(gitDir, store)) && present(store)) {
      throw new Error(
        `excluded submodule ${path} (section ${declaration.name}) store ${store} is inside deletion custody ${checkout} or ${gitDir}; worktree preserved before store inspection; preserve the store outside both deletion paths before retrying removal`,
      )
    }
    notCompared.push({
      path,
      reason: "excluded",
      message: `excluded checkout is ${state}; not checked out, nothing to preserve in the checkout; Git store custody is reported separately`,
      exclusion,
    })
    declaredPaths.push(path)
  }
  const absentPaths = notCompared
    .filter((entry) => entry.exclusion?.classification === "absent")
    .map((entry) => entry.path)
  const modules = join(gitDir, "modules")
  if (absentPaths.length > 0 && present(modules)) {
    const target = parents.find((parent) => parent.name === "target")
    if (target === undefined) throw new Error(`missing target parent identity for ${checkout}`)
    const includedStores: Array<{ path: string; store: string }> = []
    for (const declaration of target.metadata.submodules) {
      validateExcludedSubmodules([declaration.name])
      const store = await git.text(checkout, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        `modules/${declaration.name}`,
      ])
      if (!isAbsolute(store) || !within(modules, store)) {
        throw new Error(`included submodule ${declaration.path} has invalid parent-resolved store identity ${store}`)
      }
      includedStores.push({ path: declaration.path, store })
    }
    const refuse = (store: string): never => {
      throw new Error(
        `excluded ${absentPaths.join(", ")}: target-owned store ${store} has no included parent identity; worktree preserved before store inspection; preserve the store outside ${checkout} and ${gitDir} before retrying removal`,
      )
    }
    const moduleState = lstatSync(modules)
    if (!moduleState.isDirectory() || moduleState.isSymbolicLink()) refuse(modules)
    for (const entry of borrowerEntries(modules, includedStores, "custody")) {
      const store = join(entry.parentPath, entry.name)
      // Only namespace ancestors of known included stores may be descended into.
      // The existing walker prunes each known store and yields unknown entries before descent.
      if (!entry.isDirectory() || !includedStores.some((included) => within(store, included.store))) refuse(store)
    }
  }
  return { notCompared, declaredPaths, borrowers: parents.filter((entry) => entry.name !== "target") }
}

/**
 * Any live worktree in the superproject whose submodule alternates point into `lenderModules`
 * is dissociated using git repack -a -d while alternates still resolve, and its alternates are updated
 * before `lenderModules` is destroyed, preventing dangling alternates and silent object loss (hh 25908).
 *
 * If dissociation fails, throws before removing anything, naming the borrowers.
 */
export interface RehomeBorrowersOptions {
  readonly repackTimeoutMs?: number
  readonly spawn?: typeof spawnSync
}

/** Protected roots are pruned before entry, including symlinks. */
function* borrowerEntries(
  root: string,
  excludedStores: RemovalBorrower["excludedStores"],
  purpose: "custody" | "dependencies",
): Generator<Dirent> {
  const dependencyStore = purpose === "dependencies" && isGitDirectory(root, root, false)
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (excludedStores?.some((excluded) => within(excluded.store, path))) continue
    // Only a recognized Git store gives these names their metadata meaning.
    // Namespace directories named refs/logs/hooks may contain real submodules.
    if (dependencyStore && entry.isDirectory() && ["refs", "logs", "hooks"].includes(entry.name)) continue
    yield entry
    if (!entry.isDirectory()) continue
    // A directory directly inside a Git objects directory is `info` (the only one that can hold an
    // `alternates` line), a pack directory, or a loose-object fan-out directory. This walk's own
    // `git repack -a -d` runs prune-packed over the same store and removes a loose object's emptied
    // fan-out directory while the generator is still enumerating the parent listing, so descending
    // into one scandirs a directory that has just vanished and aborts a removal the borrower can
    // already read through (hh 28572). Only `info` can carry a borrower marker, so the walk never
    // enters the others.
    if (basename(root) === "objects" && entry.name !== "info") continue
    yield* borrowerEntries(path, excludedStores, purpose)
  }
}

/** A compact age for a lock barrier: "12s", "5m08s", "3h04m", "2d11h". */
function formatLockAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`
  return `${Math.floor(hours / 24)}d${String(hours % 24).padStart(2, "0")}h`
}

/**
 * How old a `.lock` barrier is and whether the kernel reports any process still holding it. A lock
 * file left behind by a finished or killed writer has no holder at all, and a refusal that only says
 * "resolve its holder" sends its reader looking for one that does not exist (hh 28572).
 */
function describeLockBarrier(path: string, now = Date.now()): string {
  let age = "age unknown"
  try {
    const { mtimeMs } = statSync(path)
    age = `age ${formatLockAge(now - mtimeMs)} (mtime ${new Date(mtimeMs).toISOString()})`
  } catch {
    // silent-fallback-allow: this only enriches a refusal the caller is already raising for a `.lock`
    // entry it just listed. A file that vanished between that listing and this read has no age to
    // report, and the refusal still names its path; rethrowing would replace the real barrier report
    // with a worse stat error, and this text decides no removal.
  }
  const holders = fileLockHolders([path], { self: process.pid })
  if (holders.kind === "unknown") return `${age}; lock holders unreadable (${holders.reason})`
  const file = holders.files[0]
  if (file === undefined) return `${age}; lock holder unknown`
  if ("absent" in file) return `${age}; no lock holder (file absent)`
  if ("unreadable" in file) return `${age}; lock holders unreadable (${file.unreadable})`
  return file.locks.length === 0 ? `${age}; no lock holder (${file.id})` : `${age}; ${formatLockHolders(holders)}`
}

/** Resolve each public parent independently; current-worktree names cannot stand for another HEAD. */
export async function prepareRemovalBorrowers(
  git: Git,
  checkout: string,
  commonDir: string,
  lenderGitDir: string,
  custody: ExcludedRemovalCustody,
  excludedSubmodules: readonly string[] = [],
): Promise<
  Readonly<{ run: () => readonly string[]; inspect: () => readonly string[]; notCompared: readonly NotCompared[] }>
> {
  const lenderModules = join(lenderGitDir, "modules")
  if (excludedSubmodules.length === 0) {
    return {
      run: () => rehomeBorrowers(commonDir, lenderGitDir, lenderModules),
      inspect: () =>
        rehomeBorrowerCandidates(
          commonDir,
          lenderGitDir,
          lenderModules,
          removalBorrowers(commonDir, lenderGitDir),
          undefined,
          "inspect",
        ),
      notCompared: [],
    }
  }
  if (custody.declaredPaths.length > 0 && present(join(commonDir, "git-super-retained-borrowers"))) {
    throw new Error(
      `worktree ${checkout} has retained borrower registrations with unresolved excluded-store identities for ${excludedSubmodules.map((path) => JSON.stringify(path)).join(", ")}; resolve their custody before removal`,
    )
  }
  const candidates: RemovalBorrower[] = []
  const notCompared: NotCompared[] = []
  for (const candidate of custody.borrowers) {
    const excludedStores: { path: string; store: string }[] = []
    for (const path of custody.declaredPaths) {
      const declaration = candidate.metadata.selectedPaths.find((entry) => entry.path === path)?.declarations[0]
      if (declaration === undefined) {
        throw new Error(
          `borrower ${candidate.name} at ${candidate.adminDir} has no parent metadata identity for excluded submodule ${path} at ${candidate.head}; resolve that identity before removal`,
        )
      }
      validateExcludedSubmodules([declaration.name])
      const store = await git.text(checkout, [
        "--git-dir",
        candidate.adminDir,
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        `modules/${declaration.name}`,
      ])
      if (!isAbsolute(store) || !within(join(candidate.adminDir, "modules"), store)) {
        throw new Error(
          `borrower ${candidate.name} excluded submodule ${path} has invalid parent-resolved store ${JSON.stringify(store)}; resolve its metadata before removal`,
        )
      }
      if (present(lenderModules) && present(store)) {
        throw new Error(
          `excluded borrower ${candidate.name} submodule ${path} store ${store} cannot be proved independent of deletion custody ${lenderModules} without inspecting it; preserve or resolve that custody before removal`,
        )
      }
      excludedStores.push({ path, store })
      notCompared.push({
        path,
        reason: "excluded",
        message: present(store)
          ? `excluded borrower ${candidate.name} Git store ${store} preserved untouched outside deletion custody`
          : `excluded borrower ${candidate.name} parent-resolved Git store ${store} is absent; no store content inspected`,
      })
    }
    const includedStores: string[] = []
    for (const declaration of candidate.metadata.submodules) {
      validateExcludedSubmodules([declaration.name])
      const store = await git.text(checkout, [
        "--git-dir",
        candidate.adminDir,
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        `modules/${declaration.name}`,
      ])
      if (!isAbsolute(store) || !within(join(candidate.adminDir, "modules"), store)) {
        throw new Error(`borrower ${candidate.name} has invalid included store identity ${store}`)
      }
      includedStores.push(store)
    }
    candidates.push({ ...candidate, excludedStores, includedStores })
  }
  return {
    run: () => rehomeBorrowerCandidates(commonDir, lenderGitDir, lenderModules, candidates),
    inspect: () => rehomeBorrowerCandidates(commonDir, lenderGitDir, lenderModules, candidates, undefined, "inspect"),
    notCompared,
  }
}

export function rehomeBorrowers(
  commonDir: string,
  lenderGitDir: string,
  lenderModules: string,
  options?: RehomeBorrowersOptions,
): readonly string[] {
  return rehomeBorrowerCandidates(
    commonDir,
    lenderGitDir,
    lenderModules,
    removalBorrowers(commonDir, lenderGitDir),
    options,
  )
}

function rehomeBorrowerCandidates(
  commonDir: string,
  lenderGitDir: string,
  lenderModules: string,
  candidates: readonly RemovalBorrower[],
  options?: RehomeBorrowersOptions,
  policy: "inspect" | "rehome" = "rehome",
): readonly string[] {
  guardRetainedBorrowers(commonDir, lenderGitDir, policy)
  const hasLenderModules = present(lenderModules)
  const canonicalCommon = realpathSync(commonDir)

  const rehomedBorrowers = new Set<string>()

  for (const candidate of candidates) {
    const candidateModules = join(candidate.adminDir, "modules")
    if (!existsSync(candidateModules)) continue

    let borrowerIdentity = candidate.name
    try {
      const gitdirFile = join(candidate.adminDir, "gitdir")
      if (existsSync(gitdirFile)) {
        const text = readFileSync(gitdirFile, "utf8").trim()
        borrowerIdentity = dirname(text.replace(/^gitdir:\s*/u, ""))
      }
    } catch {
      // silent-fallback-allow: this only labels the borrower. An unreadable gitdir pointer leaves borrowerIdentity at
      // the candidate name, which names the re-homed borrower in the report and decides no removal (26031, @cto 4cec3231)
    }

    try {
      for (const includedStore of candidate.includedStores ?? [candidateModules]) {
        if (!existsSync(includedStore)) continue
        for (const entry of borrowerEntries(includedStore, candidate.excludedStores, "dependencies")) {
          if (entry.isSymbolicLink() && entry.name === "objects") {
            const objects = join(entry.parentPath, entry.name)
            let target: string
            try {
              target = realpathSync(objects)
              if (!statSync(target).isDirectory()) throw new Error("target is not a directory")
            } catch (error) {
              throw new Error(
                `borrower ${borrowerIdentity} has an unresolved objects link ${objects}; resolve it before removing ${lenderGitDir}`,
                { cause: error },
              )
            }
            if (!within(canonicalCommon, target)) {
              throw new Error(
                `borrower ${borrowerIdentity} objects link ${objects} targets ${target} outside common-store custody ${canonicalCommon}; resolve it before removing ${lenderGitDir}`,
              )
            }
            if (within(realpathSync(lenderGitDir), target)) {
              if (policy === "inspect") {
                rehomedBorrowers.add(borrowerIdentity)
                continue
              }
              throw new Error(
                `borrower ${borrowerIdentity} submodule ${relative(candidateModules, entry.parentPath)} still links objects ${objects} to ${target}; preserve its objects before removing ${lenderGitDir}`,
              )
            }
            continue
          }
          if (!hasLenderModules || !entry.isFile() || entry.name !== "alternates") continue
          const alternatesPath = join(entry.parentPath, entry.name)
          const objectsDir = dirname(entry.parentPath)
          const content = readFileSync(alternatesPath, "utf8")
          const lines = content
            .split(/\r?\n/u)
            .map((l) => l.trim())
            .filter((l) => l !== "" && !l.startsWith("#"))

          const hasLender = lines.some((line) => {
            const abs = isAbsolute(line) ? line : resolve(objectsDir, line)
            return within(lenderModules, toCanonical(abs))
          })
          if (!hasLender) continue

          rehomedBorrowers.add(borrowerIdentity)
          if (policy === "inspect") continue

          const subGitDir = dirname(objectsDir)
          const subRel = relative(candidateModules, subGitDir)
          const timeoutMs = options?.repackTimeoutMs ?? 120_000
          const runSpawn = options?.spawn ?? spawnSync
          const repacked = runSpawn("git", ["--git-dir", subGitDir, "repack", "-a", "-d"], {
            encoding: "utf8",
            timeout: timeoutMs,
          })
          if (repacked.error || repacked.status !== 0) {
            const timeoutDetail =
              (repacked.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT"
                ? `timed out after ${timeoutMs / 1000}s bound`
                : undefined
            const detail =
              timeoutDetail ??
              (repacked.error?.message || repacked.stderr || repacked.stdout || `exit ${String(repacked.status)}`)
            throw new Error(
              `git repack -a -d failed for submodule ${subRel} in borrower ${borrowerIdentity}: ${detail}`,
            )
          }

          const updated = lines.filter((line) => {
            const abs = isAbsolute(line) ? line : resolve(objectsDir, line)
            return !within(lenderModules, toCanonical(abs))
          })

          const staged = `${alternatesPath}.rehome-${process.pid}`
          writeFileSync(staged, updated.length > 0 ? `${updated.join("\n")}\n` : "", "utf8")
          renameSync(staged, alternatesPath)
        }
      }
    } catch (error) {
      throw new Error(
        `worktree ${lenderGitDir} could not be removed: borrower ${borrowerIdentity} borrows submodule objects from it and could not be re-homed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
  }

  return [...rehomedBorrowers]
}

/**
 * Per-invocation bound for removal safety. A single `git` call that has not answered in 30 s is a hang, and
 * the async reaper runner bounded each status child at 30 s before the predicate was shared (28033). Callers
 * may pass a different bound; `undefined` leaves the walk unbounded.
 */
export const DEFAULT_REMOVAL_STATUS_TIMEOUT_MS = 30_000

/** Removal never treats an unreadable included repository as an absent population member. */
export function inspectRemovalStatus(
  path: string,
  excludedSubmodules: readonly string[] = [],
  timeoutMs: number | undefined = DEFAULT_REMOVAL_STATUS_TIMEOUT_MS,
): SuperStatusResult {
  const status = withGitTimeout(timeoutMs, () => superStatus({ repo: path, excludedSubmodules }))
  if (status.submoduleProblems.length > 0) {
    throw new Error(
      `worktree ${path} has unknown submodule state: ${status.submoduleProblems.map((problem) => `${problem.path}: ${problem.reason}${problem.gitDir === undefined ? "" : ` (gitdir ${problem.gitDir})`}`).join("; ")}; preserve and resolve it before removal`,
    )
  }
  return status
}

/** The consulted store that owns a status record: the deepest consulted prefix that contains it (29073). */
function storeOwningRecord(record: string, consulted: readonly ConsultedRepository[]): ConsultedRepository | undefined {
  const recordPath = record.slice(3)
  let owner = consulted.find((candidate) => candidate.path === ".")
  for (const candidate of consulted) {
    if (candidate.path === ".") continue
    if (recordPath !== candidate.path && !recordPath.startsWith(`${candidate.path}/`)) continue
    if (owner === undefined || candidate.path.length > owner.path.length) owner = candidate
  }
  return owner
}

/**
 * Admit one store's dirt ONLY against a preserved ref that resolves to a commit in that SAME store;
 * otherwise refuse exactly as before (29073, @cto ruling 2026-10-13). The dirt gate exists to say
 * "preserve before removal", so the acknowledgement is proof the preservation happened, never a
 * bypass and never a rewrite. Existence and store are verified here; byte equality between the ref
 * and the dirt is the caller's (yrd's) claim, because this gate builds no snapshot tree of a dirty
 * store. A ref in the wrong store, or a missing ref, admits nothing.
 */
async function admitDirtyStore(
  git: Git,
  store: string,
  records: readonly string[],
  preserved: readonly string[],
): Promise<void> {
  if (records.length === 0) return
  for (const ref of preserved) {
    const resolved = await git.optionalText(store, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])
    if (resolved !== undefined && resolved !== "") return
  }
  throw new Error(
    `worktree ${store} is dirty: ${records.join("; ")}; preserve its changes before removal, or admit them with ` +
      `--preserved <ref> naming a ref that resolves to a commit in this store`,
  )
}

/** The existing status walker owns repository discovery; every native status is exact, including gitlink changes. */
async function cleanSnapshot(
  git: Git,
  path: string,
  inspect: (repository: string, path: string) => Promise<WorktreeInspection>,
  excludedSubmodules: readonly string[] = [],
  preserved: readonly string[] = [],
): Promise<readonly Readonly<{ path: string; head: string }>[]> {
  const status = inspectRemovalStatus(path, excludedSubmodules)
  // 29073: attribute every dirty record to the consulted store that owns it (the deepest consulted
  // prefix that contains it), then admit that store's dirt only with a preserved ref that resolves
  // to a commit in THAT store. The root's own records are admitted against the root store, each
  // component's against its own; a ref in the wrong store, or a missing ref, admits nothing.
  const dirtyByStore = new Map<string, { store: string; records: string[] }>()
  for (const record of status.records) {
    const store = storeOwningRecord(record, status.consultedRepositories)?.root ?? path
    const group = dirtyByStore.get(store) ?? { store, records: [] }
    group.records.push(record)
    dirtyByStore.set(store, group)
  }
  for (const group of dirtyByStore.values()) {
    await admitDirtyStore(git, group.store, group.records, preserved)
  }
  const snapshot: { path: string; head: string }[] = []
  for (const entry of status.consultedRepositories) {
    let state = await inspect(entry.root, entry.root)
    if (!state.registered) {
      // Git lists a primary clone with a separate gitdir at the gitdir path,
      // even though rev-parse --show-toplevel reports its actual checkout.
      const directory = realpathSync(await git.text(entry.root, ["rev-parse", "--absolute-git-dir"]))
      const common = realpathSync(
        await git.text(entry.root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      )
      if (directory === common) state = await inspect(entry.root, common)
    }
    if (!state.registered) {
      throw new Error(`worktree ${entry.root} is absent from its Git registration; inspect git worktree list`)
    }
    if (state.locked !== undefined) {
      throw new Error(`worktree ${entry.root} is locked: ${state.locked}; resolve its holder before removal`)
    }
    const prefix = relative(path, entry.root).split(sep).join("/")
    const localExclusions =
      prefix === ""
        ? excludedSubmodules
        : excludedSubmodules
            .filter((excluded) => excluded.startsWith(`${prefix}/`))
            .map((excluded) => excluded.slice(prefix.length + 1))
    const checked = superStatus({ repo: entry.root, excludedSubmodules: localExclusions })
    if (checked.submoduleProblems.length > 0) {
      throw new Error(
        `worktree ${entry.root} has unknown submodule state: ${checked.submoduleProblems.map((problem) => `${problem.path}: ${problem.reason}`).join("; ")}; preserve and resolve it before removal`,
      )
    }
    const head = await git.commit(entry.root, "HEAD")
    snapshot.push({ path: entry.root, head })
  }
  return snapshot
}

export type ExternalObjectStore = Readonly<{ path: string; declaration: string; target: string }>
export type ManifestEntry = Readonly<
  | { kind: "file"; sha256: string }
  | { kind: "objects-link"; declaration: string; target: string }
  | { kind: "symlink"; declaration: string }
>
export type StoreManifest = Readonly<{
  entries: Readonly<Record<string, ManifestEntry>>
  files: Readonly<Record<string, string>>
  externalObjectStores: readonly ExternalObjectStore[]
}>
export type StoreCustody = Readonly<{ common: string; checkout: string; gitDir: string; modules: string }>

function isGitDirectory(owner: string, root: string, rootIsGitDir: boolean): boolean {
  if (!within(root, owner)) return false
  // Retained metadata roots lack the donor's Git-directory context flag.
  if (owner === root && rootIsGitDir) return true
  return (
    present(join(owner, "HEAD")) &&
    lstatSync(join(owner, "HEAD")).isFile() &&
    present(join(owner, "config")) &&
    lstatSync(join(owner, "config")).isFile() &&
    present(join(owner, "objects"))
  )
}

/** Only git-super's writer lock directly inside a Git directory is a lease; Git's other .lock files remain barriers. */
function isWriterLeasePath(path: string, root: string, rootIsGitDir: boolean): boolean {
  return (
    basename(path) === "writer.lock" &&
    basename(dirname(path)) === "yrd-worktree-mutations" &&
    isGitDirectory(dirname(dirname(path)), root, rootIsGitDir)
  )
}

/** Take every in-custody Git directory's writer lease before retention; callers hold them through native removal. */
export function acquireRemovalWriterLeases(gitDir: string, onAcquired?: (path: string) => void): RemovalWriterLeases {
  const handles: FlockHandle[] = []
  const proof: WriterLockProof[] = []
  const created: WriterLockProof[] = []
  const createdPaths: string[] = []
  const refusal = (error: unknown): unknown =>
    createdPaths.length === 0
      ? error
      : new Error(
          `${error instanceof Error ? error.message : String(error)}; writer lock paths created by this removal (kept): ${createdPaths.join(", ")}`,
          { cause: error },
        )
  const release = () => {
    const failures: unknown[] = []
    for (const handle of handles.reverse()) {
      try {
        handle.release()
      } catch (error) {
        failures.push(error)
      }
    }
    handles.length = 0
    if (failures.length > 0) throw new AggregateError(failures, `could not release writer leases under ${gitDir}`)
  }
  try {
    const entries = readdirSync(gitDir, { recursive: true, withFileTypes: true })
    for (const entry of entries) {
      if (!entry.name.endsWith(".lock")) continue
      const path = join(entry.parentPath, entry.name)
      if (!entry.isFile() || !isWriterLeasePath(path, gitDir, true)) {
        throw new Error(`Git lock ${path} prevents worktree removal; resolve its holder (${describeLockBarrier(path)})`)
      }
    }
    const directories = [
      gitDir,
      ...entries.filter((entry) => entry.isDirectory()).map((entry) => join(entry.parentPath, entry.name)),
    ]
    const paths = directories
      .filter((directory) => isGitDirectory(directory, gitDir, true))
      .map((directory) => join(directory, "yrd-worktree-mutations", "writer.lock"))
    const existing = paths.filter((path) => present(path)).sort()
    const absent = paths.filter((path) => !present(path)).sort()
    // Refuse held existing leases before creating any missing path. Missing paths are then
    // acquired too, so a writer that starts during retention cannot create and take one.
    for (const path of [...existing, ...absent]) {
      const before = present(path) ? lstatSync(path) : null
      const handle = tryAcquireFlock(path)
      if (handle === null) {
        const note = readFileSync(path, "utf8")
        const holder =
          process.platform === "linux"
            ? formatLockHolders(fileLockHolders([path], { self: process.pid }))
            : "kernel holder lookup unavailable on this platform"
        throw new Error(`writer lease ${path} is held; ${holder}; body note (not authority): ${note}`)
      }
      handles.push(handle)
      if (before === null) createdPaths.push(path)
      onAcquired?.(path)
      const opened = fstatSync(handle.fd)
      const named = lstatSync(path)
      if (
        !named.isFile() ||
        (before !== null && (before.dev !== opened.dev || before.ino !== opened.ino)) ||
        named.dev !== opened.dev ||
        named.ino !== opened.ino
      ) {
        throw new Error(`writer lease ${path} changed identity during acquisition; worktree preserved`)
      }
      const entry: WriterLockProof = { path, body: readFileSync(handle.fd, "utf8"), lease: "free" }
      if (before === null) created.push(entry)
      else proof.push(entry)
    }
    return { proof, created, refusal, release }
  } catch (error) {
    try {
      release()
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        `writer lease acquisition and release both failed under ${gitDir}`,
      )
    }
    throw refusal(error)
  }
}

/** Inspect link identities without walking their objects; only common-store objects directories may be borrowed. */
export function metadataFileDigest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

export function manifest(root: string, custody: StoreCustody, hashFiles = true, workingTree = false): StoreManifest {
  const entries: Record<string, ManifestEntry> = {}
  const files: Record<string, string> = {}
  const externalObjectStores: ExternalObjectStore[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const key = relative(root, path)
      const metadata = within(custody.gitDir, path)
      if (
        (!workingTree || metadata) &&
        entry.name.endsWith(".lock") &&
        !isWriterLeasePath(path, workingTree ? custody.gitDir : root, workingTree || root === custody.gitDir)
      ) {
        throw new Error(`Git lock ${path} prevents worktree removal; resolve its holder (${describeLockBarrier(path)})`)
      }
      if (entry.isDirectory()) {
        visit(path)
        continue
      }
      if (entry.isSymbolicLink()) {
        if (workingTree && !metadata) {
          entries[key] = { kind: "symlink", declaration: readlinkSync(path) }
          continue
        }
        const modulePath = relative(custody.modules, path)
        if (!within(custody.modules, path) || entry.name !== "objects" || !modulePath.includes(sep)) {
          throw new Error(
            `Git metadata link ${path} is not a submodule objects directory; preserve and resolve it before removal`,
          )
        }
        const declaration = readlinkSync(path)
        let target: string
        try {
          target = realpathSync(path)
          if (!statSync(target).isDirectory()) throw new Error("target is not a directory")
        } catch (error) {
          throw new Error(`Git objects link ${path} has an unavailable target ${declaration}; worktree preserved`, {
            cause: error,
          })
        }
        if (!within(custody.common, target) || within(custody.checkout, target) || within(custody.gitDir, target)) {
          throw new Error(
            `Git objects link ${path} targets ${target} outside common-store custody or inside removal paths ${custody.checkout} or ${custody.gitDir}; preserve its objects before removal`,
          )
        }
        entries[key] = { kind: "objects-link", declaration, target }
        externalObjectStores.push({ path: key, declaration, target })
        continue
      }
      if (!entry.isFile()) {
        throw new Error(`Git store ${path} is not a regular file; preserve and resolve it before removal`)
      }
      if (!hashFiles) continue
      const sha256 = metadataFileDigest(path)
      files[key] = sha256
      entries[key] = { kind: "file", sha256 }
    }
  }
  visit(root)
  return {
    entries: Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))),
    files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
    externalObjectStores: externalObjectStores.sort((a, b) => a.path.localeCompare(b.path)),
  }
}

function present(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

/** A pointer per manifest avoids shared aggregate updates; publication occurs under the common writer lock. */
function registerRetainedBorrower(common: string, retained: string, manifestPath: string): void {
  const registry = join(common, "git-super-retained-borrowers")
  try {
    mkdirSync(registry, { recursive: true })
    if (!lstatSync(registry).isDirectory()) {
      throw new Error(`retained borrower registry ${registry} is not an owned directory; worktree preserved`)
    }
    const name = createHash("sha256").update(manifestPath).digest("hex")
    const staged = join(registry, `${name}.${randomUUID()}.tmp`)
    writeFileSync(staged, `${JSON.stringify({ retained, manifest: manifestPath })}\n`, { flag: "wx" })
    renameSync(staged, join(registry, `${name}.json`))
  } catch (error) {
    throw new Error(
      `retained borrower ${retained} could not be registered in ${registry}; worktree preserved (${error instanceof Error ? error.message : String(error)})`,
      { cause: error },
    )
  }
}

/** Retained copies are borrowers too: verify their actual links before allowing an owner store to disappear. */
function guardRetainedBorrowers(common: string, lenderGitDir: string, policy: "inspect" | "rehome" = "rehome"): void {
  const registry = join(common, "git-super-retained-borrowers")
  if (!present(registry)) return
  if (!lstatSync(registry).isDirectory()) {
    throw new Error(`retained borrower registry ${registry} is not an owned directory; worktree preserved`)
  }
  const registrations = readdirSync(registry)
    .filter((name) => name.endsWith(".json"))
    .sort()
  if (registrations.length === 0) return
  const pointer = join(lenderGitDir, "gitdir")
  let checkout: string
  try {
    const declaration = readFileSync(pointer, "utf8")
      .trim()
      .replace(/^gitdir:\s*/u, "")
    if (declaration === "") throw new Error("empty gitdir pointer")
    checkout = realpathSync(dirname(resolve(lenderGitDir, declaration)))
  } catch (error) {
    throw new Error(
      `worktree ${lenderGitDir} cannot be removed: cannot resolve checkout from ${pointer} while retained borrowers exist`,
      { cause: error },
    )
  }
  for (const name of registrations) {
    const registration = join(registry, name)
    let retained = registration
    try {
      const record = JSON.parse(readFileSync(registration, "utf8")) as { retained?: unknown; manifest?: unknown }
      if (
        typeof record.retained !== "string" ||
        !isAbsolute(record.retained) ||
        typeof record.manifest !== "string" ||
        !isAbsolute(record.manifest)
      ) {
        throw new Error("invalid retained borrower pointer")
      }
      retained = record.retained
      if (!present(retained)) {
        if (policy === "inspect") continue
        unlinkSync(registration)
        process.stderr.write(`retained borrower ${retained} is gone; dropped registry entry ${registration}\n`)
        continue
      }
      if (!lstatSync(retained).isDirectory()) throw new Error("retained copy is not an owned directory")
      const proof = JSON.parse(readFileSync(record.manifest, "utf8")) as {
        retained?: unknown
        externalObjectStores?: unknown
      }
      if (proof.retained !== retained || !Array.isArray(proof.externalObjectStores)) {
        throw new Error("invalid retained dependency manifest")
      }
      for (const dependency of proof.externalObjectStores as Array<{ path?: unknown; target?: unknown }>) {
        if (
          typeof dependency.path !== "string" ||
          typeof dependency.target !== "string" ||
          !isAbsolute(dependency.target)
        ) {
          throw new Error("invalid retained objects dependency")
        }
        const link = resolve(retained, dependency.path)
        if (!within(retained, link) || basename(link) !== "objects") {
          throw new Error(`invalid retained objects path ${link}`)
        }
      }
      // The manifest declaration cannot hide an actual link or authorise deletion of its current target.
      const actual = manifest(retained, { common, checkout, gitDir: lenderGitDir, modules: retained }, false)
      const linkedStores = join(realpathSync(common), "worktrees")
      const primaryStores = join(realpathSync(common), "modules")
      let linkedDependency = false
      for (const dependency of actual.externalObjectStores) {
        if (within(linkedStores, dependency.target)) {
          linkedDependency = true
        } else if (!within(primaryStores, dependency.target)) {
          throw new Error(
            `retained objects link ${join(retained, dependency.path)} targets ${dependency.target} with unknown removal custody in ${common}; preserve and resolve it before removal`,
          )
        }
      }
      if (!linkedDependency) {
        if (policy === "inspect") continue
        unlinkSync(registration)
        process.stderr.write(
          `retained borrower ${retained} has no objects links into removable linked stores; dropped registry entry ${registration}\n`,
        )
      }
    } catch (error) {
      throw new Error(
        `worktree ${lenderGitDir} cannot be removed: retained copy ${retained} could not be proved independent (${error instanceof Error ? error.message : String(error)})`,
        { cause: error },
      )
    }
  }
}

/** Runs inside the worktree store's existing mutation lock, immediately before its one native remove. */
export async function retainWorktreeModules(
  git: Git,
  repo: string,
  requested: string,
  retention: WorktreeRetention,
  inspect: (repository: string, path: string) => Promise<WorktreeInspection>,
  writerLocks: readonly WriterLockProof[],
  createdWriterLocks: readonly WriterLockProof[],
  rehome?: () => readonly string[],
  excludedSubmodules: readonly string[] = [],
  notCompared: readonly NotCompared[] = [],
  privateProjection?: PrivateGitProjection,
  onRetainedPath?: (path: string) => void,
  retirePrivate?: () => void,
  preserved: readonly string[] = [],
  destroyed?: Readonly<{ gitDir: string; common: string; head: string }>,
): Promise<WorktreeRemovalProof> {
  const path = destroyed === undefined ? realpathSync(requested) : resolve(requested)
  if (privateProjection === undefined && destroyed === undefined) {
    const registered = await inspect(repo, path)
    if (!registered.registered) {
      throw new Error(`worktree ${path} is not registered in ${repo}; inspect git worktree list`)
    }
    if (registered.locked !== undefined) {
      throw new Error(`worktree ${path} is locked: ${registered.locked}; resolve its holder before removal`)
    }
  }
  const gitDir =
    destroyed !== undefined
      ? destroyed.gitDir
      : privateProjection === undefined
        ? realpathSync(await git.text(path, ["rev-parse", "--absolute-git-dir"]))
        : join(path, ".git")
  const common =
    destroyed !== undefined
      ? destroyed.common
      : privateProjection === undefined
        ? realpathSync(await git.text(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))
        : gitDir
  if (gitDir === common && privateProjection === undefined) {
    throw new Error(`worktree ${path} is the primary worktree; only a linked worktree can be removed`)
  }
  return retainResolvedWorktreeModules({
    git,
    path,
    gitDir,
    common,
    retention,
    inspect,
    writerLocks,
    createdWriterLocks,
    rehome,
    excludedSubmodules,
    notCompared,
    privateProjection,
    onRetainedPath,
    retirePrivate,
    preserved,
    destroyedHead: destroyed?.head,
  })
}

/** The single copy/verify/rehome stage for an extant or a destroyed checkout. */
async function retainResolvedWorktreeModules(context: {
  git: Git
  path: string
  gitDir: string
  common: string
  retention: WorktreeRetention
  inspect: (repository: string, path: string) => Promise<WorktreeInspection>
  writerLocks: readonly WriterLockProof[]
  createdWriterLocks: readonly WriterLockProof[]
  rehome: (() => readonly string[]) | undefined
  excludedSubmodules: readonly string[]
  notCompared: readonly NotCompared[]
  privateProjection: PrivateGitProjection | undefined
  onRetainedPath: ((path: string) => void) | undefined
  retirePrivate: (() => void) | undefined
  preserved: readonly string[]
  destroyedHead: string | undefined
}): Promise<WorktreeRemovalProof> {
  const {
    git,
    path,
    gitDir,
    common,
    retention,
    inspect,
    writerLocks,
    createdWriterLocks,
    rehome,
    excludedSubmodules,
    notCompared,
    privateProjection,
    onRetainedPath,
    retirePrivate,
    preserved,
    destroyedHead,
  } = context
  const modules = join(gitDir, "modules")
  const custody = { common, checkout: path, gitDir, modules }
  // Diagnose metadata links before Git discovery can hide their source and target in an object lookup failure.
  manifest(gitDir, custody, false, false)
  if (privateProjection !== undefined) {
    if (privateProjection.checkout !== path || gitDir !== join(path, ".git")) {
      throw new Error(`private projection metadata does not match ${path}`)
    }
    const allowedObjects = new Set(
      privateProjection.mounts.filter((mount) => mount.mode === "ro").map((mount) => mount.source),
    )
    for (const repository of privateProjection.repositories) {
      if (
        !within(gitDir, repository.gitDirectory) ||
        realpathSync(repository.gitDirectory) !== repository.gitDirectory
      ) {
        throw new Error(`private repository metadata escapes custody: ${repository.gitDirectory}`)
      }
      const objects = join(repository.gitDirectory, "objects")
      await alternatesLineage([objects], "", { allowedObjects: new Set([...allowedObjects, objects]) })
    }
  }
  let before =
    privateProjection === undefined && destroyedHead === undefined
      ? await cleanSnapshot(git, path, inspect, excludedSubmodules, preserved)
      : undefined
  // Check metadata locks before copying. The modules subtree includes every store,
  // even one left by an earlier gitlink that the current tree no longer records.
  const metadata = manifest(gitDir, custody, true, false)
  const requestedRoot = resolve(retention.root)
  // Resolve existing ancestors before creating anything, so a symlink cannot put
  // the only retained copy back inside either native deletion path.
  let ancestor = requestedRoot
  while (!existsSync(ancestor)) {
    const next = resolve(ancestor, "..")
    if (next === ancestor) throw new Error(`retention directory ${requestedRoot} has no existing parent`)
    ancestor = next
  }
  const canonical = resolve(realpathSync(ancestor), relative(ancestor, requestedRoot))
  if (within(path, canonical) || within(gitDir, canonical)) {
    throw new Error(
      `retention directory ${canonical} is inside worktree removal paths ${path} or ${gitDir}; choose an external durable directory`,
    )
  }
  for (const dependency of metadata.externalObjectStores) {
    if (within(dependency.target, canonical)) {
      throw new Error(
        `retention directory ${canonical} is inside external objects target ${dependency.target}; choose a directory that does not modify borrowed objects`,
      )
    }
  }
  mkdirSync(canonical, { recursive: true })
  onRetainedPath?.(canonical)
  const retainedRoot = mkdtempSync(join(canonical, `${basename(gitDir)}-`))
  onRetainedPath?.(retainedRoot)
  const copiedSource = privateProjection === undefined ? modules : path
  const copiedCheckout = privateProjection === undefined ? path : join(retainedRoot, "checkout")
  const copiedTree = privateProjection === undefined ? join(retainedRoot, "modules") : copiedCheckout
  const retained = existsSync(copiedSource)
    ? privateProjection === undefined
      ? copiedTree
      : join(copiedTree, ".git")
    : null
  const copiedCustody =
    privateProjection === undefined
      ? { ...custody, modules: retained ?? modules }
      : {
          common: join(copiedTree, ".git"),
          checkout: copiedCheckout,
          gitDir: join(copiedTree, ".git"),
          modules: join(copiedTree, ".git/modules"),
        }
  let expectedCopy: Readonly<Record<string, ManifestEntry>> = {}
  let retainedManifest: StoreManifest = { entries: {}, files: {}, externalObjectStores: [] }
  if (retained !== null) {
    retainedManifest = manifest(copiedSource, custody, true, privateProjection !== undefined)
    cpSync(copiedSource, copiedTree, {
      recursive: true,
      errorOnExist: true,
      force: false,
      dereference: false,
      verbatimSymlinks: true,
    })
    onRetainedPath?.(copiedTree)
    onRetainedPath?.(retained)
    for (const dependency of retainedManifest.externalObjectStores) {
      const link = join(copiedTree, dependency.path)
      unlinkSync(link)
      symlinkSync(dependency.target, link, "dir")
    }
    expectedCopy = Object.fromEntries(
      Object.entries(retainedManifest.entries).map(([key, entry]) => [
        key,
        entry.kind === "objects-link" ? { ...entry, declaration: entry.target } : entry,
      ]),
    )
    if (
      JSON.stringify(manifest(copiedTree, copiedCustody, true, privateProjection !== undefined).entries) !==
        JSON.stringify(expectedCopy) ||
      JSON.stringify(manifest(copiedSource, custody, true, privateProjection !== undefined).entries) !==
        JSON.stringify(retainedManifest.entries)
    ) {
      throw new Error(
        `Git store ${modules} changed during retention at ${retained}; worktree preserved, retry after its writer stops`,
      )
    }
  }
  if (privateProjection !== undefined && retained !== null) {
    const allowedObjects = new Set(
      privateProjection.mounts.filter((mount) => mount.mode === "ro").map((mount) => mount.source),
    )
    const knownMetadata = new Set(privateProjection.repositories.map((repository) => repository.gitDirectory))
    for (const key of Object.keys(retainedManifest.entries)) {
      const original = join(path, key)
      if (within(gitDir, original)) {
        if (
          (basename(original) === "config" && !knownMetadata.has(dirname(original))) ||
          ["config.worktree", "commondir", "gitdir"].includes(basename(original)) ||
          key.split(sep).includes("hooks")
        ) {
          throw new Error(`unknown private Git metadata ${original}; preserve before custody`)
        }
      } else if (
        basename(original) === ".git" &&
        !privateProjection.repositories.some((repository) => original === join(repository.checkout, ".git"))
      ) {
        throw new Error(`unknown child metadata ${original}; preserve before custody`)
      }
    }
    for (const repository of privateProjection.repositories) {
      const copied = join(retained, relative(gitDir, repository.gitDirectory))
      const configuration = join(copied, "config")
      if (!lstatSync(configuration).isFile() || metadataFileDigest(configuration) !== repository.configurationSha256) {
        throw new Error(`private Git configuration changed or is unknown: ${configuration}; preserve before custody`)
      }
      const objects = join(copied, "objects")
      await alternatesLineage([objects], "", { allowedObjects: new Set([...allowedObjects, objects]) })
      if (repository.path !== "") {
        const pointer = join(copiedCheckout, repository.path, ".git")
        if (!lstatSync(pointer).isFile() || readFileSync(pointer, "utf8") !== `gitdir: ${repository.gitDirectory}\n`) {
          throw new Error(`copied child pointer changed or is unknown: ${pointer}; preserve before custody`)
        }
      }
    }
    for (const repository of privateProjection.repositories) {
      if (repository.path === "") continue
      const copied = join(retained, relative(gitDir, repository.gitDirectory))
      const pointer = join(copiedCheckout, repository.path, ".git")
      writeFileSync(pointer, `gitdir: ${copied}\n`)
      expectedCopy = {
        ...expectedCopy,
        [relative(copiedCheckout, pointer)]: { kind: "file", sha256: metadataFileDigest(pointer) },
      }
    }
    before = await cleanSnapshot(git, copiedCheckout, inspect, excludedSubmodules)
    for (const repository of privateProjection.repositories) {
      const copied = join(retained, relative(gitDir, repository.gitDirectory))
      // Full integrity includes borrowed stores: the public root takes 62s and a large child 207–239s.
      // Keep a finite five-minute bound for this full scan rather than the interactive deadline.
      await git.run(copiedCheckout, ["--git-dir", copied, "fsck", "--full", "--no-reflogs"], false, 300_000)
    }
  }
  const rehomedBorrowers =
    privateProjection === undefined ? (rehome === undefined ? rehomeBorrowers(common, gitDir, modules) : rehome()) : []
  const inspectedPath = copiedCheckout
  const after =
    destroyedHead === undefined
      ? await cleanSnapshot(
          git,
          inspectedPath,
          inspect,
          excludedSubmodules,
          privateProjection === undefined ? preserved : [],
        )
      : undefined
  const verifyPrivateManifest = (): void => {
    if (
      privateProjection !== undefined &&
      (JSON.stringify(manifest(path, custody, true, true).entries) !== JSON.stringify(retainedManifest.entries) ||
        JSON.stringify(manifest(copiedCheckout, copiedCustody, true, true).entries) !== JSON.stringify(expectedCopy))
    ) {
      throw new Error(`worktree ${path} changed during retention; preserved, retry after its writer stops`)
    }
  }
  verifyPrivateManifest()
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    throw new Error(`worktree ${path} changed during retention; preserved, retry after its writer stops`)
  }
  if (before === undefined && destroyedHead === undefined) {
    throw new Error(`private snapshot missing for ${path}; worktree preserved`)
  }
  const proof: WorktreeRemovalProof = {
    path,
    head: destroyedHead ?? (await git.commit(inspectedPath, "HEAD")),
    ...(destroyedHead === undefined ? {} : { checkout: "absent" as const }),
    repositories: before === undefined ? [] : before.map((entry) => join(path, relative(inspectedPath, entry.path))),
    modules,
    retained,
    manifest: join(retainedRoot, "manifest.json"),
    createdAt: new Date().toISOString(),
    retainUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    ...(rehomedBorrowers.length === 0 ? {} : { rehomedBorrowers }),
    writerLocks,
    createdWriterLocks,
    notCompared,
  }
  writeFileSync(
    proof.manifest,
    `${JSON.stringify({ ...proof, files: retainedManifest.files, entries: retainedManifest.entries, externalObjectStores: retainedManifest.externalObjectStores }, null, 2)}\n`,
    { flag: "wx" },
  )
  if (retained !== null && retainedManifest.externalObjectStores.length > 0) {
    registerRetainedBorrower(common, retained, proof.manifest)
  }
  if (retained !== null && privateProjection !== undefined) {
    for (const mount of privateProjection.mounts.filter((mount) => mount.mode === "ro")) {
      registerRetainedBorrower(dirname(mount.source), retained, proof.manifest)
    }
  }
  retention.report(proof)
  if (retirePrivate !== undefined) {
    if (privateProjection === undefined) throw new Error("private retirement requires its projection record")
    verifyPrivateManifest()
    retirePrivate()
  }
  return proof
}
