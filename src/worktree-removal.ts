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
import { readCommitSubmodules, type SelectedCommitSubmodules } from "./commit-graph.ts"
import { validateExcludedSubmodules } from "./git.ts"
import type { GitProcess } from "./process.ts"
import type { NotCompared } from "./diff.ts"
import type { Git, WorktreeInspection } from "./worktree.ts"
import type { PrivateGitProjection } from "./private-git-projection.ts"
import { alternatesLineage } from "./alternates.ts"
import { removalBorrowers, type RemovalBorrower } from "./worktree-administration.ts"

export type WorktreeRemovalProof = Readonly<{
  path: string
  head: string
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
    for (const entry of borrowerEntries(modules, includedStores)) {
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
function* borrowerEntries(root: string, excludedStores: RemovalBorrower["excludedStores"]): Generator<Dirent> {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (excludedStores?.some((excluded) => within(excluded.store, path))) continue
    yield entry
    if (entry.isDirectory()) yield* borrowerEntries(path, excludedStores)
  }
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
  guardRetainedBorrowers(commonDir, lenderGitDir)
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
        for (const entry of borrowerEntries(includedStore, candidate.excludedStores)) {
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

/** Removal never treats an unreadable included repository as an absent population member. */
export function inspectRemovalStatus(path: string, excludedSubmodules: readonly string[] = []): SuperStatusResult {
  const status = superStatus({ repo: path, excludedSubmodules })
  if (status.submoduleProblems.length > 0) {
    throw new Error(
      `worktree ${path} has unknown submodule state: ${status.submoduleProblems.map((problem) => `${problem.path}: ${problem.reason}${problem.gitDir === undefined ? "" : ` (gitdir ${problem.gitDir})`}`).join("; ")}; preserve and resolve it before removal`,
    )
  }
  return status
}

/** The existing status walker owns repository discovery; every native status is exact, including gitlink changes. */
async function cleanSnapshot(
  git: Git,
  path: string,
  inspect: (repository: string, path: string) => Promise<WorktreeInspection>,
  excludedSubmodules: readonly string[] = [],
): Promise<readonly Readonly<{ path: string; head: string }>[]> {
  const status = inspectRemovalStatus(path, excludedSubmodules)
  if (status.records.length > 0) {
    throw new Error(`worktree ${path} is dirty: ${status.records.join("; ")}; preserve its changes before removal`)
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
    if (checked.records.length > 0) {
      throw new Error(
        `worktree ${entry.root} is dirty: ${checked.records.join("; ")}; preserve its changes before removal`,
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
        throw new Error(`Git lock ${path} prevents worktree removal; resolve its holder`)
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
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name)
    const key = relative(root, path)
    const metadata = within(custody.gitDir, path)
    if (
      (!workingTree || metadata) &&
      entry.name.endsWith(".lock") &&
      !isWriterLeasePath(path, workingTree ? custody.gitDir : root, workingTree || root === custody.gitDir)
    ) {
      throw new Error(`Git lock ${path} prevents worktree removal; resolve its holder`)
    }
    if (entry.isDirectory()) continue
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
function guardRetainedBorrowers(common: string, lenderGitDir: string): void {
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
): Promise<WorktreeRemovalProof> {
  const path = realpathSync(requested)
  if (privateProjection === undefined) {
    const registered = await inspect(repo, path)
    if (!registered.registered) {
      throw new Error(`worktree ${path} is not registered in ${repo}; inspect git worktree list`)
    }
    if (registered.locked !== undefined) {
      throw new Error(`worktree ${path} is locked: ${registered.locked}; resolve its holder before removal`)
    }
  }
  const gitDir =
    privateProjection === undefined
      ? realpathSync(await git.text(path, ["rev-parse", "--absolute-git-dir"]))
      : join(path, ".git")
  const common =
    privateProjection === undefined
      ? realpathSync(await git.text(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))
      : gitDir
  if (gitDir === common && privateProjection === undefined) {
    throw new Error(`worktree ${path} is the primary worktree; only a linked worktree can be removed`)
  }
  const modules = join(gitDir, "modules")
  const custody = { common, checkout: path, gitDir, modules }
  // Diagnose metadata links before Git discovery can hide their source and target in an object lookup failure.
  manifest(gitDir, custody, false)
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
  let before = privateProjection === undefined ? await cleanSnapshot(git, path, inspect, excludedSubmodules) : undefined
  // Check metadata locks before copying. The modules subtree includes every store,
  // even one left by an earlier gitlink that the current tree no longer records.
  const metadata = manifest(gitDir, custody)
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
  const after = await cleanSnapshot(git, inspectedPath, inspect, excludedSubmodules)
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
  if (before === undefined) throw new Error(`private snapshot missing for ${path}; worktree preserved`)
  const proof: WorktreeRemovalProof = {
    path,
    head: await git.commit(inspectedPath, "HEAD"),
    repositories: before.map((entry) => join(path, relative(inspectedPath, entry.path))),
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
