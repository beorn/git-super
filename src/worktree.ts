import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"
import { appendFile, lstat, readFile, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import { createExclusive, DEFAULT_MUTATION_LOCK_WAIT_MS } from "./exclusive.ts"
import {
  acquireRemovalWriterLeases,
  assertExcludedRemovalCustody,
  inspectRemovalStatusWithGit,
  prepareRemovalBorrowers,
  rehomeBorrowers,
  retainWorktreeModules,
  type ComponentCustodyProof,
  type WorktreeRemovalProof,
  type WorktreeRetention,
} from "./worktree-removal.ts"
export { inspectRemovalStatus } from "./worktree-removal.ts"
import { compactRetainedModules, type CompactionResult } from "./retention-compact.ts"
import { cleanGitEnvironment, cleanGitRepositoryEnvironment, probeRepository } from "./git.ts"
import { createLocalGitProcess, type GitProcess, type GitProcessResult } from "./process.ts"
import {
  readReflogEntries,
  scanContents,
  type ComponentGitSource,
  type GitRun,
  type GitRunOptions,
  type GitRunResult,
  type GitStreamFactory,
} from "./retention-contents.ts"
import { isPolicyRef, scanCustody, type CustodyTarget, type WitnessIdentity } from "./retention-custody.ts"
import { alternateEntries, alternatesLineage } from "./alternates.ts"
import { createProgressReporter } from "./progress.ts"
import { shellQuote } from "./shell-command.ts"
import { materializeSubmodulesWithProcess } from "./submodules.ts"
import type { SuperStatusResult } from "./status.ts"
import { statusWithGit } from "./status-traversal.ts"
import { removalBorrowers } from "./worktree-administration.ts"
import {
  describeModuleStores,
  inspectDestroyedModuleStores,
  inspectModuleStores,
  type ModuleStore,
} from "./module-store-custody.ts"

export type GitResult = Readonly<{ code: number; stdout: string; stderr: string }>
export type Git = ReturnType<typeof createGit>

export type ComponentCustodyPolicy = Readonly<{ primaryRoot: string; targetBranch: string }>
export type ComponentCustodyRefusal = Readonly<{
  status: "blocked" | "unknown"
  component: string
  source: string
  detail: string
  oid?: string
  /** Present only when status === "blocked" and pre-proof and post-proof freshness reads agreed. */
  fingerprint?: string
}>
export type ComponentCustodyFreshness =
  | Readonly<{ status: "ok"; fingerprint: string }>
  | Readonly<{ status: "unknown"; source: string; detail: string }>

export const CUSTODY_FRESHNESS_SCHEMA_VERSION = 2

export type CustodyFreshnessInputId =
  | "schemaVersion"
  | "policy.targetBranch"
  | "census.fingerprint"
  | "witness.scope"
  | "witness.objectFormat"
  | "witness.shallow"
  | "witness.alternatesContent"
  | "witness.refs"
  | "component.head"
  | "component.refs"
  | "component.reflogs"
  | "component.pseudoRefs"
  | "component.indexStat"
  | "component.alternatesContent"
  | "component.privateObjectStore"

export const CUSTODY_FRESHNESS_INPUT_SPEC: readonly Readonly<{
  input: CustodyFreshnessInputId
  reason: string
}>[] = Object.freeze([
  {
    input: "schemaVersion",
    reason:
      "bumping the freshness schema version deterministically invalidates every stored custody refusal fingerprint",
  },
  {
    input: "policy.targetBranch",
    reason:
      "the target branch selects which surviving primary branch and remote-tracking ref can witness component commits",
  },
  {
    input: "census.fingerprint",
    reason:
      "the component population, Git-store identities, alternates closure, witness stores, and external owners define the proof boundary",
  },
  {
    input: "witness.scope",
    reason:
      "a blocked refusal on component C scopes witnessStores to C's primary witness store W(C) from census.witnessStoreByComponent (while a '.' refusal retains the full witness set); a later W(C') change for C' != C can only add a refusal (making the named component stale, never the blocked outcome)",
  },
  {
    input: "witness.objectFormat",
    reason: "Gate 5 requires each witness store to match the candidate component object format",
  },
  {
    input: "witness.shallow",
    reason: "Gate 5 refuses a shallow witness repository because its reachable graph is incomplete",
  },
  {
    input: "witness.alternatesContent",
    reason:
      "changes to a witness store's objects/info/alternates change its transitive object closure and removal-set disjointness",
  },
  {
    input: "witness.refs",
    reason:
      "changes to refs/heads/<targetBranch>, refs/remotes/origin/<targetBranch>, or primary pin refs in a witness store can publish or unpublish a blocked commit",
  },
  {
    input: "component.head",
    reason: "HEAD is a Gate 4 root OID whose commit must be witnessed in the surviving primary store",
  },
  {
    input: "component.refs",
    reason: "every ref in a candidate component is a Gate 4 root OID",
  },
  {
    input: "component.reflogs",
    reason: "every reflog oldOid/newOid in a candidate component is a Gate 4 root OID",
  },
  {
    input: "component.pseudoRefs",
    reason:
      "FETCH_HEAD, ORIG_HEAD, MERGE_HEAD, CHERRY_PICK_HEAD, REBASE_HEAD, BISECT_HEAD, and BISECT_LOG in a candidate component are Gate 4 root OIDs",
  },
  {
    input: "component.indexStat",
    reason: "the candidate component index holds Gate 4 stage root OIDs",
  },
  {
    input: "component.alternatesContent",
    reason: "a candidate component's objects/info/alternates changes its effective commit inventory",
  },
  {
    input: "component.privateObjectStore",
    reason:
      "packs and loose objects in a private component-owned object store (excluded when shared with other worktrees) can introduce or remove dangling commits",
  },
])

export type CustodyFreshnessMaterial = Readonly<{
  schemaVersion: number
  targetBranch: string
  censusFingerprint: string
  witnessStores: readonly Readonly<{
    store: string
    objectFormat: string
    shallow: string
    alternatesContent: string | null
    refs: readonly string[]
  }>[]
  components: readonly Readonly<{
    component: string
    gitDir: string
    objectDirectory: string
    head: string | null
    refs: readonly string[]
    reflogs: readonly Readonly<{ path: string; sha256: string }>[]
    pseudoRefs: readonly Readonly<{ name: string; oids: readonly string[] }>[]
    indexStat: string
    alternatesContent: string | null
    privateObjectStore: Readonly<{
      packs: readonly string[]
      looseObjects: readonly string[]
    }> | null
  }>[]
}>

export function hashCustodyFreshnessMaterial(material: CustodyFreshnessMaterial): string {
  return createHash("sha256").update(JSON.stringify(material)).digest("hex")
}

/**
 * Scope a collected CustodyFreshnessMaterial to the witness store W(C) of the blocked component C (#31206, @cto 27873fd8).
 *
 * Soundness: the custody loop runs scanCustody(path, [component], [W(component)]) per component and breaks at the
 * first failure. A blocked refusal on C is therefore a function of censusFingerprint, every candidate component's
 * own material (head, refs, reflogs, pseudoRefs, indexStat, alternatesContent, privateObjectStore), and W(C)'s refs;
 * W(C') for C' != C enters only other components' scans, so with those inputs unchanged the full proof cannot pass.
 * Two consequences: (1) a later W(C') change for C' != C can only add a refusal (the named component may then be
 * stale, the blocked outcome is not), and (2) a "." refusal (recensus, root-reference integrity, inventory) keeps
 * the full witness set.
 */
export function scopeCustodyFreshnessMaterial(
  material: CustodyFreshnessMaterial,
  witnessStoreByComponent: readonly Readonly<{ component: string; store: string }>[],
  component?: string,
):
  | Readonly<{ status: "ok"; material: CustodyFreshnessMaterial; fingerprint: string }>
  | Readonly<{ status: "unknown"; source: string; detail: string }> {
  if (component === undefined || component === ".") {
    return {
      status: "ok",
      material,
      fingerprint: hashCustodyFreshnessMaterial(material),
    }
  }
  const store = witnessStoreByComponent.find((entry) => entry.component === component)?.store
  const witnessEntry = store === undefined ? undefined : material.witnessStores.find((entry) => entry.store === store)
  if (store === undefined || witnessEntry === undefined) {
    return {
      status: "unknown",
      source: "persistent primary object store",
      detail: `no exact primary witness store was resolved for component ${component}`,
    }
  }
  const scopedMaterial: CustodyFreshnessMaterial = {
    ...material,
    witnessStores: [witnessEntry],
  }
  return {
    status: "ok",
    material: scopedMaterial,
    fingerprint: hashCustodyFreshnessMaterial(scopedMaterial),
  }
}
const COMPONENT_QUERY_MAX_BYTES = 64 * 1024 * 1024
const COMPONENT_QUERY_MAX_LINES = 1_000_000
// A hard aggregate stream byte bound keeps a huge object graph from consuming unbounded disk.
const COMPONENT_STREAM_MAX_BYTES = 512 * 1024 * 1024
const COMPONENT_STREAM_MAX_LINES = 20_000_000

function incompleteSelectedRun(message: string, timedOut = false): GitRunResult {
  return { code: 1, stdout: "", stderr: message, ...(timedOut ? { timedOut: true } : {}) }
}

/** A fail-closed, selected GitProcess adapter for Gate 4/5; every answer is bounded. */
function selectedCustodyAdapters(
  gitProcess: GitProcess,
  repo: string,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
  deadline: number,
): Readonly<{ run: GitRun; stream: GitStreamFactory }> {
  const baseEnv = {
    ...cleanGitRepositoryEnvironment(environment),
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
  }
  const remaining = (): number => deadline - Date.now()
  const stream: GitStreamFactory = (args, streamOptions = {}) => {
    const left = remaining()
    if (left <= 0) throw new Error("component custody proof deadline is exhausted")
    if (gitProcess.stream === undefined) {
      throw new Error("selected Git process does not support bounded output streaming")
    }
    const selectedSignal = streamOptions.signal ?? signal
    return gitProcess.stream({
      repo,
      args,
      env: {
        ...baseEnv,
        ...streamOptions.env,
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_NO_LAZY_FETCH: "1",
        GIT_OPTIONAL_LOCKS: "0",
      },
      ...(selectedSignal === undefined ? {} : { signal: selectedSignal }),
      timeoutMs: Math.min(streamOptions.timeoutMs ?? Number.POSITIVE_INFINITY, left),
      maxBytes: Math.min(streamOptions.maxBytes ?? COMPONENT_STREAM_MAX_BYTES, COMPONENT_STREAM_MAX_BYTES),
      maxLines: Math.min(streamOptions.maxLines ?? COMPONENT_STREAM_MAX_LINES, COMPONENT_STREAM_MAX_LINES),
      ...(streamOptions.framing === undefined ? {} : { framing: streamOptions.framing }),
      ...(streamOptions.onQueueHighWater === undefined ? {} : { onQueueHighWater: streamOptions.onQueueHighWater }),
    })
  }
  const run: GitRun = async (args, options: GitRunOptions = {}) => {
    const left = remaining()
    if (left <= 0) return incompleteSelectedRun("component custody proof deadline is exhausted", true)
    if (gitProcess.stream === undefined) {
      return incompleteSelectedRun("selected Git process does not support bounded output streaming")
    }
    // Only existing NUL-producing query verbs opt in. Stop at the path separator:
    // a filename named -z or --null must never select a different protocol.
    let commandIndex = 0
    while (commandIndex < args.length) {
      const argument = args[commandIndex]
      if (argument === undefined || !argument.startsWith("-")) break
      commandIndex += ["-C", "-c", "--git-dir", "--work-tree"].includes(argument) ? 2 : 1
    }
    const pathSeparator = args.indexOf("--", commandIndex)
    const queryOptions = args.slice(commandIndex + 1, pathSeparator === -1 ? undefined : pathSeparator)
    const nul =
      ["ls-files", "ls-tree", "config", "worktree", "status", "diff"].includes(args[commandIndex] ?? "") &&
      queryOptions.some((arg) => arg === "-z" || arg === "--null")
    let bounded
    try {
      bounded = stream(args, {
        ...(nul ? { framing: "nul" } : {}),
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        maxBytes: COMPONENT_QUERY_MAX_BYTES,
        maxLines: COMPONENT_QUERY_MAX_LINES,
      })
    } catch (error) {
      return incompleteSelectedRun(
        `selected bounded Git query could not start: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    const lines: string[] = []
    let bytes = 0
    let outputExceeded = false
    let streamFailure: string | undefined
    try {
      for await (const line of bounded.lines) {
        bytes += Buffer.byteLength(line, "utf8") + (nul ? 0 : 1)
        if (bytes > COMPONENT_QUERY_MAX_BYTES || lines.length >= COMPONENT_QUERY_MAX_LINES) {
          outputExceeded = true
          continue
        }
        lines.push(line)
      }
    } catch (error) {
      streamFailure = `selected bounded Git query stream failed: ${String(error)}`
    }
    const outcome = await bounded.outcome
    if (streamFailure !== undefined) return incompleteSelectedRun(streamFailure)
    if (Date.now() >= deadline) return incompleteSelectedRun("component custody proof deadline is exhausted", true)
    if (outcome.timedOut || outcome.capped || outputExceeded) {
      return incompleteSelectedRun(
        outcome.timedOut
          ? `selected Git query timed out: ${outcome.stderr}`
          : `selected Git query exceeded its output cap: repository=${JSON.stringify(repo)} argv=${JSON.stringify(["git", "-C", repo, ...args])}: ${outcome.stderr}`,
        outcome.timedOut,
      )
    }
    if (outcome.code === 0 && outcome.stderr !== "") {
      return incompleteSelectedRun(`selected Git query wrote stderr: ${outcome.stderr}`)
    }
    return {
      code: outcome.code ?? 1,
      stdout: lines.join(nul ? "" : "\n"),
      stderr: outcome.stderr,
    }
  }
  return { run, stream }
}

type ComponentIdentity = Readonly<{
  component: string
  gitDir: string
  commonDir: string
  objectDirectory: string
  workTree: string
}>

type ComponentCensus = Readonly<{
  sources: readonly ComponentGitSource[]
  identities: readonly ComponentIdentity[]
  witnessStores: readonly string[]
  witnessStoreByComponent: readonly Readonly<{ component: string; store: string }>[]
  alternateStores: readonly string[]
  externalOwners: readonly string[]
  removal: readonly string[]
  fingerprint: string
}>

function custodyIdentityError(message: string): Error {
  return new Error(`component custody census unknown: ${message}`)
}

async function buildComponentCensus(
  input: Readonly<{
    git: Git
    adapters: Readonly<{ run: GitRun; stream: GitStreamFactory }>
    repo: string
    worktree: string
    rootGitDir: string
    excludedSubmodules: readonly string[]
    policy: ComponentCustodyPolicy
    deadline: number
  }>,
): Promise<ComponentCensus> {
  const remaining = (): number => {
    const left = input.deadline - Date.now()
    if (left <= 0) throw custodyIdentityError("shared proof deadline is exhausted")
    return left
  }
  const query = async (cwd: string, args: readonly string[]): Promise<string> => {
    const result = await input.adapters.run(["-C", cwd, ...args])
    if (result.code !== 0) {
      throw custodyIdentityError(`${cwd}: ${result.stderr.trim() || `git ${args.join(" ")} failed`}`)
    }
    remaining()
    return result.stdout.trim()
  }
  const boundedGit: Pick<Git, "run"> = {
    run: async (cwd, args, allowFailure = false, _timeoutMs, options) => {
      const result = await input.adapters.run(["-C", cwd, ...args], {
        timeoutMs: remaining(),
        ...(options?.env === undefined ? {} : { env: options.env }),
      })
      if (
        result.timedOut === true ||
        result.stderr.startsWith("selected ") ||
        result.stderr.startsWith("component custody proof deadline")
      ) {
        throw custodyIdentityError(`${cwd}: ${result.stderr || "selected Git query did not complete"}`)
      }
      if (!allowFailure && result.code !== 0) {
        throw custodyIdentityError(`${cwd}: ${result.stderr.trim() || `git ${args.join(" ")} exited ${result.code}`}`)
      }
      return result
    },
  }
  const canonical = (value: string, label: string): string => {
    try {
      return realpathSync(value)
    } catch (error) {
      throw custodyIdentityError(
        `${label} ${value} is missing or redirected: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  const removal = [canonical(input.worktree, "removal checkout"), canonical(input.rootGitDir, "removal Git directory")]
  const withinRemoval = (path: string): boolean =>
    removal.some((root) => {
      const part = relative(root, path)
      return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part))
    })
  const branch = await input.adapters.run(["check-ref-format", "--branch", input.policy.targetBranch])
  if (branch.code !== 0) {
    throw custodyIdentityError(`target branch ${JSON.stringify(input.policy.targetBranch)} is invalid`)
  }
  const status = await statusWithGit(
    { repo: input.worktree, excludedSubmodules: input.excludedSubmodules },
    boundedGit,
    remaining(),
  )
  if (status.uninitializedSubmodules.length > 0 || status.submoduleProblems.length > 0) {
    throw custodyIdentityError(
      [
        ...status.uninitializedSubmodules.map((component) => `${component}: submodule checkout is uninitialized`),
        ...status.submoduleProblems.map((entry) => `${entry.path}: ${entry.kind}: ${entry.reason}`),
      ].join("; "),
    )
  }
  const unaccounted = status.notCompared
  if (unaccounted.length > 0) {
    throw custodyIdentityError(unaccounted.map((entry) => `${entry.path}: ${entry.message}`).join("; "))
  }
  const primaryStatus = await statusWithGit(
    { repo: input.policy.primaryRoot, excludedSubmodules: input.excludedSubmodules },
    boundedGit,
    remaining(),
  )
  if (primaryStatus.uninitializedSubmodules.length > 0 || primaryStatus.submoduleProblems.length > 0) {
    throw custodyIdentityError(
      `persistent primary: ${[
        ...primaryStatus.uninitializedSubmodules.map(
          (component) => `${component}: submodule checkout is uninitialized`,
        ),
        ...primaryStatus.submoduleProblems.map((entry) => `${entry.path}: ${entry.kind}: ${entry.reason}`),
      ].join("; ")}`,
    )
  }
  const primaryUnaccounted = primaryStatus.notCompared
  if (primaryUnaccounted.length > 0) {
    throw custodyIdentityError(
      `persistent primary: ${primaryUnaccounted.map((entry) => `${entry.path}: ${entry.message}`).join("; ")}`,
    )
  }
  const primaryRepositories = new Map<string, string>([
    [".", canonical(input.policy.primaryRoot, "persistent primary root")],
  ])
  for (const entry of primaryStatus.consultedRepositories) {
    if (entry.path !== ".") {
      primaryRepositories.set(entry.path, canonical(entry.root, `primary component ${entry.path}`))
    }
  }
  const repositories = [
    { component: ".", root: canonical(input.worktree, "removal checkout") },
    ...status.consultedRepositories
      .filter((entry) => entry.path !== ".")
      .map((entry) => ({ component: entry.path, root: canonical(entry.root, `component ${entry.path}`) })),
  ]
  const identities: ComponentIdentity[] = []
  const sources: ComponentGitSource[] = []
  const objectOwners = new Map<string, string>()
  const witnessStores = new Set<string>()
  const witnessStoreByComponent: { component: string; store: string }[] = []
  const externalOwners = new Set<string>()
  const registerObjectOwner = (objectDirectory: string, commonDir: string, component: string): void => {
    const prior = objectOwners.get(objectDirectory)
    if (prior !== undefined && prior !== commonDir) {
      throw custodyIdentityError(
        `${component}: object directory ${objectDirectory} has ambiguous Git owners ${prior} and ${commonDir}`,
      )
    }
    objectOwners.set(objectDirectory, commonDir)
  }
  for (const repository of repositories) {
    remaining()
    const workTree = canonical(
      await query(repository.root, ["rev-parse", "--show-toplevel"]),
      `${repository.component} worktree`,
    )
    if (workTree !== repository.root) {
      throw custodyIdentityError(`${repository.component}: declared root ${repository.root} resolves to ${workTree}`)
    }
    const gitDir = canonical(
      await query(workTree, ["rev-parse", "--absolute-git-dir"]),
      `${repository.component} gitdir`,
    )
    const commonDir = canonical(
      await query(workTree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      `${repository.component} common-dir`,
    )
    const objectDirectory = canonical(
      await query(workTree, ["rev-parse", "--path-format=absolute", "--git-path", "objects"]),
      `${repository.component} object directory`,
    )
    if (!statSync(objectDirectory).isDirectory()) {
      throw custodyIdentityError(`${repository.component}: Git object directory ${objectDirectory} is not a directory`)
    }
    registerObjectOwner(objectDirectory, commonDir, repository.component)
    if (!withinRemoval(commonDir)) externalOwners.add(commonDir)
    const source: ComponentGitSource = { component: repository.component, gitDir, workTree }
    sources.push(source)
    identities.push({ ...source, commonDir, objectDirectory })

    const registrations = parseRegisteredWorktrees(await query(commonDir, ["worktree", "list", "--porcelain", "-z"]))
    if (registrations.length === 0) {
      throw custodyIdentityError(`${repository.component}: ${commonDir} has no native worktree registration`)
    }
    if (
      !registrations.some((entry) => {
        const registeredPath = canonical(entry.path, `${repository.component} source registration`)
        return (
          registeredPath === workTree ||
          (repository.component !== "." && gitDir === commonDir && registeredPath === commonDir)
        )
      })
    ) {
      throw custodyIdentityError(
        `${repository.component}: source ${workTree} has no exact native registration in ${commonDir}`,
      )
    }
    const selectedPrimary = primaryRepositories.get(repository.component)
    if (selectedPrimary === undefined) {
      throw custodyIdentityError(`${repository.component}: primary registration is missing`)
    }
    const primaryPath = resolve(selectedPrimary)
    if (withinRemoval(primaryPath)) {
      throw custodyIdentityError(`${repository.component}: primary ${primaryPath} is in the removal set`)
    }
    const primaryGitDir = canonical(
      await query(primaryPath, ["rev-parse", "--absolute-git-dir"]),
      `${repository.component} primary gitdir`,
    )
    const primaryCommon = canonical(
      await query(primaryPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      `${repository.component} primary common-dir`,
    )
    const primaryObjects = canonical(
      await query(primaryPath, ["rev-parse", "--path-format=absolute", "--git-path", "objects"]),
      `${repository.component} primary object directory`,
    )
    if (!statSync(primaryObjects).isDirectory()) {
      throw custodyIdentityError(
        `${repository.component}: persistent primary object directory ${primaryObjects} is not a directory`,
      )
    }
    const primaryRegistrations = parseRegisteredWorktrees(
      await query(primaryCommon, ["worktree", "list", "--porcelain", "-z"]),
    )
    const canonicalPrimaryRegistrations = primaryRegistrations.map((entry) =>
      canonical(entry.path, `${repository.component} primary registration`),
    )
    const primaryRegistrationIdentity =
      repository.component !== "." && primaryGitDir === primaryCommon ? primaryCommon : primaryPath
    if (canonicalPrimaryRegistrations[0] !== primaryRegistrationIdentity) {
      throw custodyIdentityError(
        `${repository.component}: persistent primary ${primaryPath} is not the first native registration in ${primaryCommon}`,
      )
    }
    if (repository.component === "." && (primaryCommon !== commonDir || primaryObjects !== objectDirectory)) {
      throw custodyIdentityError(
        `root persistent primary ${primaryPath} has Git identity ${primaryCommon}/${primaryObjects}, expected source root identity ${commonDir}/${objectDirectory}`,
      )
    }
    if (repository.component === "." && (withinRemoval(commonDir) || withinRemoval(objectDirectory))) {
      throw custodyIdentityError(
        `root persistent primary ${primaryPath} shares Git stores with the removal set: ${commonDir}/${objectDirectory}`,
      )
    }
    registerObjectOwner(primaryObjects, primaryCommon, `${repository.component} primary ${primaryGitDir}`)
    witnessStores.add(primaryObjects)
    witnessStoreByComponent.push({ component: repository.component, store: primaryObjects })
    if (!withinRemoval(primaryCommon)) externalOwners.add(primaryCommon)
  }
  const alternateStores = new Set<string>()
  const queue = [...new Set([...identities.map((entry) => entry.objectDirectory), ...witnessStores])]
  for (let index = 0; index < queue.length; index += 1) {
    remaining()
    const store = queue[index]
    if (store === undefined) continue
    const alternateFile = join(store, "info", "alternates")
    if (!existsSync(alternateFile)) continue
    const metadata = lstatSync(alternateFile)
    if (!metadata.isFile() || realpathSync(alternateFile) !== alternateFile) {
      throw custodyIdentityError(`alternate declaration ${alternateFile} is redirected or not a file`)
    }
    for (const target of alternateEntries(readFileSync(alternateFile, "utf8"), store)) {
      if (!existsSync(target) || !statSync(target).isDirectory()) {
        throw custodyIdentityError(`${store}: alternate object store ${target} is missing or not a directory`)
      }
      const canonicalTarget = realpathSync(target)
      const owner = objectOwners.get(canonicalTarget)
      if (owner === undefined) {
        throw custodyIdentityError(`${store}: alternate ${canonicalTarget} has no exact consulted Git owner`)
      }
      if (!alternateStores.has(canonicalTarget)) {
        alternateStores.add(canonicalTarget)
        queue.push(canonicalTarget)
      }
      if (!withinRemoval(owner)) externalOwners.add(owner)
    }
  }
  // The shared traversal is also the canonical cycle/dedup check used by retention.
  await alternatesLineage([...identities.map((entry) => entry.objectDirectory), ...witnessStores], "")
  // Excluding root commits from the component ledger does not exempt the
  // surviving root store from depending on a store that removal destroys.
  const rootObjects = identities[0]?.objectDirectory
  if (rootObjects === undefined) {
    throw custodyIdentityError("root persistent primary object store is missing from the census")
  }
  const rootAlternates = await alternatesLineage([rootObjects], rootObjects, {
    allowedObjects: new Set(objectOwners.keys()),
  })
  for (const store of rootAlternates) {
    if (withinRemoval(store)) {
      throw custodyIdentityError(`root persistent primary alternate ${store} is inside the removal set`)
    }
  }
  const fingerprintValue = JSON.stringify({
    sources: identities.map(({ component, gitDir, commonDir, objectDirectory, workTree }) => ({
      component,
      gitDir,
      commonDir,
      objectDirectory,
      workTree,
    })),
    witnesses: [...witnessStores].sort(),
    witnessStoreByComponent: [...witnessStoreByComponent].sort((left, right) =>
      left.component.localeCompare(right.component),
    ),
    alternates: [...alternateStores].sort(),
    externalOwners: [...externalOwners].sort(),
  })
  return {
    sources,
    identities,
    witnessStores: [...witnessStores].sort(),
    witnessStoreByComponent: [...witnessStoreByComponent].sort((left, right) =>
      left.component.localeCompare(right.component),
    ),
    alternateStores: [...alternateStores].sort(),
    externalOwners: [...externalOwners].sort(),
    removal,
    fingerprint: createHash("sha256").update(fingerprintValue).digest("hex"),
  }
}

const FRESHNESS_PSEUDO_REFS = [
  "FETCH_HEAD",
  "ORIG_HEAD",
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REBASE_HEAD",
  "BISECT_HEAD",
  "BISECT_LOG",
] as const
const FRESHNESS_HEX40 = /^[0-9a-f]{40}$/u

function isFreshnessWitnessRef(ref: string, tip: string, targetBranch: string): boolean {
  if (ref === `refs/remotes/origin/${targetBranch}`) return true
  return isPolicyRef(ref, tip, targetBranch)
}

function collectReflogFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) collectReflogFiles(path, found)
    else if (entry.isFile()) found.push(path)
  }
  return found
}

type ComputedCustodyFreshness =
  | Readonly<{ status: "ok"; fingerprint: string; material: CustodyFreshnessMaterial }>
  | Readonly<{ status: "unknown"; source: string; detail: string }>

async function computeCustodyFreshness(
  input: Readonly<{
    adapters: Readonly<{ run: GitRun; stream: GitStreamFactory }>
    census: ComponentCensus
    policy: ComponentCustodyPolicy
    deadline: number
  }>,
): Promise<ComputedCustodyFreshness> {
  let currentSource = "component custody freshness"
  const fail: (source: string, message: string) => never = (source, message) => {
    currentSource = source
    throw new Error(message)
  }
  const remaining = (): number => {
    const left = input.deadline - Date.now()
    if (left <= 0) fail(currentSource, "shared proof deadline is exhausted")
    return left
  }
  const runGit = async (args: readonly string[], source: string, allowFailure = false): Promise<GitRunResult> => {
    currentSource = source
    const result = await input.adapters.run(["--no-optional-locks", "--no-replace-objects", ...args], {
      timeoutMs: remaining(),
    })
    if (
      result.timedOut === true ||
      result.stderr.startsWith("selected ") ||
      result.stderr.startsWith("component custody proof deadline")
    ) {
      fail(source, result.stderr.trim() || "selected Git query did not complete")
    }
    if (result.code === 0 && result.stderr.trim() !== "") {
      fail(source, `exited 0 with unexpected stderr: ${result.stderr.trim()}`)
    }
    if (!allowFailure && result.code !== 0) {
      fail(source, result.stderr.trim() || `git ${args.join(" ")} exited ${result.code}`)
    }
    remaining()
    return result
  }
  const readAlternatesFile = (objectDir: string, source: string): string | null => {
    currentSource = source
    const file = join(objectDir, "info", "alternates")
    if (!existsSync(file)) return null
    const metadata = lstatSync(file)
    if (!metadata.isFile() || realpathSync(file) !== file) {
      fail(source, `alternate declaration ${file} is redirected or not a file`)
    }
    return readFileSync(file, "utf8")
  }
  const withinRemoval = (path: string): boolean =>
    input.census.removal.some((root) => {
      const part = relative(root, path)
      return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part))
    })

  try {
    const witnessStores: CustodyFreshnessMaterial["witnessStores"][number][] = []
    for (const store of [...input.census.witnessStores].sort()) {
      remaining()
      const witnessGitDir = dirname(store)
      const formatResult = await runGit(
        [`--git-dir=${witnessGitDir}`, "rev-parse", "--show-object-format"],
        `witness object format ${witnessGitDir}`,
      )
      const objectFormat = formatResult.stdout.trim()
      if (objectFormat !== "sha1" && objectFormat !== "sha256") {
        fail(`witness object format ${witnessGitDir}`, `unsupported object format '${objectFormat}'`)
      }
      const shallowResult = await runGit(
        [`--git-dir=${witnessGitDir}`, "rev-parse", "--is-shallow-repository"],
        `witness shallow state ${witnessGitDir}`,
      )
      const shallow = shallowResult.stdout.trim()
      if (shallow !== "true" && shallow !== "false") {
        fail(`witness shallow state ${witnessGitDir}`, `unexpected shallow answer '${shallow}'`)
      }
      const alternatesContent = readAlternatesFile(store, `witness alternates ${store}`)
      const refsResult = await runGit(
        [`--git-dir=${witnessGitDir}`, "for-each-ref", "--format=%(refname)%09%(objectname)%09%(objecttype)"],
        `witness refs ${witnessGitDir}`,
      )
      const refs: string[] = []
      for (const row of refsResult.stdout.split("\n")) {
        if (row === "") continue
        const fields = row.split("\t")
        const [ref, tip, objectType] = fields
        if (
          fields.length !== 3 ||
          ref === undefined ||
          tip === undefined ||
          objectType === undefined ||
          !FRESHNESS_HEX40.test(tip) ||
          !["commit", "tag", "tree", "blob"].includes(objectType)
        ) {
          fail(`witness refs ${witnessGitDir}`, `malformed for-each-ref row: ${row.slice(0, 120)}`)
        }
        if (isFreshnessWitnessRef(ref, tip, input.policy.targetBranch)) {
          refs.push(`${ref}\t${tip}\t${objectType}`)
        }
      }
      refs.sort()
      witnessStores.push({
        store,
        objectFormat,
        shallow,
        alternatesContent,
        refs,
      })
    }

    const components: CustodyFreshnessMaterial["components"][number][] = []
    const candidateIdentities = input.census.identities
      .filter((entry) => entry.component !== ".")
      .sort((left, right) => left.component.localeCompare(right.component))
    for (const identity of candidateIdentities) {
      remaining()
      const headSource = `component HEAD ${identity.component}`
      const headResult = await runGit([`--git-dir=${identity.gitDir}`, "rev-parse", "HEAD"], headSource, true)
      let head: string | null = null
      if (headResult.code === 0) {
        const oid = headResult.stdout.trim()
        if (!FRESHNESS_HEX40.test(oid)) fail(headSource, `invalid HEAD OID '${oid}'`)
        head = oid
      } else if (!/unknown revision|Needed a single revision|ambiguous argument/u.test(headResult.stderr)) {
        fail(headSource, headResult.stderr.trim() || "rev-parse HEAD failed")
      }

      const refsSource = `component refs ${identity.component}`
      const refsResult = await runGit(
        [`--git-dir=${identity.gitDir}`, "for-each-ref", "--format=%(refname)%09%(objectname)%09%(symref)"],
        refsSource,
      )
      const refs: string[] = []
      for (const row of refsResult.stdout.split("\n")) {
        if (row === "") continue
        const [ref, tip] = row.split("\t")
        if (ref === undefined || tip === undefined || !FRESHNESS_HEX40.test(tip)) {
          fail(refsSource, `malformed for-each-ref row: ${row.slice(0, 120)}`)
        }
        refs.push(row)
      }
      refs.sort()

      const reflogsSource = `component reflogs ${identity.component}`
      currentSource = reflogsSource
      const logsDir = join(identity.gitDir, "logs")
      const reflogs: { path: string; sha256: string }[] = []
      if (existsSync(logsDir)) {
        const files = collectReflogFiles(logsDir).sort()
        for (const file of files) {
          remaining()
          for (const _entry of readReflogEntries(file)) {
            // Validates every record via the shared reflog decoder.
          }
          const content = readFileSync(file, "utf8")
          reflogs.push({
            path: relative(identity.gitDir, file).split(sep).join("/"),
            sha256: createHash("sha256").update(content).digest("hex"),
          })
        }
      }

      const pseudoSource = `component pseudo-refs ${identity.component}`
      currentSource = pseudoSource
      const pseudoRefs: { name: string; oids: readonly string[] }[] = []
      for (const name of FRESHNESS_PSEUDO_REFS) {
        const path = join(identity.gitDir, name)
        if (!existsSync(path)) continue
        const metadata = lstatSync(path)
        if (!metadata.isFile()) fail(pseudoSource, `pseudo-ref ${path} is not a regular file`)
        const content = readFileSync(path, "utf8")
        const found = (content.match(/[0-9a-f]{40}/gu) ?? []).filter((oid) => FRESHNESS_HEX40.test(oid))
        if (found.length === 0 && content.trim() !== "") {
          fail(pseudoSource, `pseudo-ref ${path} holds no object id`)
        }
        pseudoRefs.push({ name, oids: found })
      }

      const indexSource = `component index ${identity.component}`
      currentSource = indexSource
      const indexPath = join(identity.gitDir, "index")
      let indexStat = "absent"
      if (existsSync(indexPath)) {
        const stat = statSync(indexPath, { bigint: true })
        indexStat = `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}`
      }

      const alternatesContent = readAlternatesFile(
        identity.objectDirectory,
        `component alternates ${identity.component}`,
      )

      const privateStore =
        withinRemoval(identity.objectDirectory) &&
        identity.commonDir === identity.gitDir &&
        !input.census.witnessStores.includes(identity.objectDirectory) &&
        !input.census.externalOwners.includes(identity.commonDir)
      let privateObjectStore: { packs: readonly string[]; looseObjects: readonly string[] } | null = null
      if (privateStore) {
        const storeSource = `component private object store ${identity.component}`
        currentSource = storeSource
        const packs: string[] = []
        const packDir = join(identity.objectDirectory, "pack")
        if (existsSync(packDir)) {
          for (const entry of readdirSync(packDir, { withFileTypes: true })) {
            if (!entry.isFile()) continue
            const stat = statSync(join(packDir, entry.name))
            packs.push(`${entry.name}:${stat.size}`)
          }
          packs.sort()
        }
        const looseObjects: string[] = []
        for (const entry of readdirSync(identity.objectDirectory, { withFileTypes: true })) {
          if (!entry.isDirectory() || !/^[0-9a-f]{2}$/u.test(entry.name)) continue
          remaining()
          const fanoutDir = join(identity.objectDirectory, entry.name)
          for (const obj of readdirSync(fanoutDir, { withFileTypes: true })) {
            if (!obj.isFile()) continue
            looseObjects.push(`${entry.name}/${obj.name}`)
          }
        }
        looseObjects.sort()
        privateObjectStore = { packs, looseObjects }
      }

      components.push({
        component: identity.component,
        gitDir: identity.gitDir,
        objectDirectory: identity.objectDirectory,
        head,
        refs,
        reflogs,
        pseudoRefs,
        indexStat,
        alternatesContent,
        privateObjectStore,
      })
    }

    const material: CustodyFreshnessMaterial = {
      schemaVersion: CUSTODY_FRESHNESS_SCHEMA_VERSION,
      targetBranch: input.policy.targetBranch,
      censusFingerprint: input.census.fingerprint,
      witnessStores,
      components,
    }
    return { status: "ok", fingerprint: hashCustodyFreshnessMaterial(material), material }
  } catch (error) {
    return {
      status: "unknown",
      source: currentSource,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

export type GitWorktreeStoreOptions = Readonly<{
  repo: string
  /**
   * The ONE injected Git capability. Required, and that is the point: while
   * three capability fields coexisted, "none supplied" and "two supplied" were
   * both representable and both had to be rejected at run time. One required
   * field makes each unrepresentable instead of merely detected.
   */
  gitProcess: GitProcess
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  timeouts?: Partial<GitWorktreeTimeouts>
  /**
   * Reports writer-lock contention, and the module stores a removal archives or releases, without writing to
   * stderr from the library. One exception (30580): with no sink, a module-store ARCHIVE line goes to stderr,
   * because it is how a human finds work moved to `refs/archive/...`. A value-less release is ordinary
   * deletion and reaches only a caller that passes this sink.
   */
  report?: (line: string) => void
}>

export type GitWorktreeTimeouts = Readonly<{
  operation: number
  cleanup: number
  mutationLock: number
}>

export type WorktreeHookPolicy = "inherit" | "quarantine"

export type WorktreeInspection = Readonly<{
  registered: boolean
  head?: string
  detached?: boolean
  locked?: string
}>

export type RegisteredWorktree = Readonly<{
  path: string
  head?: string
  /** Full local ref when this worktree has a branch checked out. */
  branch?: string
  detached: boolean
  locked?: string
}>

/** A rebase or bisect owns a branch even when Git's worktree porcelain says detached.
 * Shared with branch-triage; the operation's own state is the authority.
 */
export function worktreeOperationBranch(worktreePath: string): Readonly<{ branch: string; operation: string }> | null {
  const dotGit = join(worktreePath, ".git")
  if (!existsSync(dotGit)) return null
  let gitDir = dotGit
  if (!statSync(dotGit).isDirectory()) {
    const declaration = /^gitdir:\s*(.+)$/mu.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim()
    if (declaration === undefined || declaration === "") {
      throw new Error(`cannot read worktree operation at ${worktreePath}: ${dotGit} has no gitdir declaration`)
    }
    gitDir = isAbsolute(declaration) ? declaration : resolve(worktreePath, declaration)
  }
  for (const source of [
    { file: "rebase-merge/head-name", operation: "rebase-merge" },
    { file: "rebase-apply/head-name", operation: "rebase-apply" },
    { file: "BISECT_START", operation: "bisect" },
  ]) {
    const path = join(gitDir, source.file)
    if (!existsSync(path)) continue
    const branch = readFileSync(path, "utf8")
      .trim()
      .replace(/^refs\/heads\//u, "")
    if (branch === "") throw new Error(`cannot identify the branch held by ${source.operation}: ${path} is empty`)
    return { branch, operation: source.operation }
  }
  return null
}

export type WorktreeAdd = Readonly<{ hooks?: WorktreeHookPolicy; lockReason?: string; operation?: string }> &
  (
    | Readonly<{ kind: "branch"; path: string; branch: string }>
    | Readonly<{ kind: "new-branch"; path: string; branch: string; ref: string }>
    | Readonly<{ kind: "reset-branch"; path: string; branch: string; ref: string }>
    | Readonly<{ kind: "ref"; path: string; ref: string }>
    | Readonly<{ kind: "detached"; path: string; ref: string }>
  )

const GIT_TIMEOUT_MS = 30_000
/** Worktree removal is correctness-critical and can exceed an interactive timeout under host load. */
const GIT_CLEANUP_TIMEOUT_MS = 120_000

export type LocalGitWorktreeStoreOptions = Omit<GitWorktreeStoreOptions, "gitProcess">

export type LocalGitWorktreeMutation =
  | Readonly<{ kind: "add-detached"; repo: string; path: string; ref: string; operation?: string }>
  | Readonly<{ kind: "remove"; repo: string; path: string; operation?: string; unlock?: boolean }>

export type LocalGitWorktreeMutationResult = Readonly<{ exitCode: number; stdout: string; stderr: string }>

/** Standard local-process adapter; hosts add policy, never another Git mutation runner. */
export function createLocalGitWorktreeStore(options: LocalGitWorktreeStoreOptions): GitWorktreeStore {
  return createGitWorktreeStore({
    ...options,
    gitProcess: createLocalGitProcess(options.env),
  })
}

/** Synchronous host seam for callers whose public transaction is intentionally synchronous. */
export function runLocalGitWorktreeMutationSync(request: LocalGitWorktreeMutation): LocalGitWorktreeMutationResult {
  const child = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./worktree-runner.ts", import.meta.url)), JSON.stringify(request)],
    { encoding: "utf8", env: cleanGitEnvironment(process.env) },
  )
  return {
    exitCode: child.status ?? 1,
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? child.error?.message ?? "git-super worktree runner failed",
  }
}

/**
 * The one Git VIEW: ergonomics over the one transport, and the only place
 * allowed to hold them. Exported so no caller has to hand-roll a rival — six
 * independently-declared git surfaces is how this codebase learned that a
 * private convenience wrapper is just a transport with a smaller blast radius.
 */
export function createGit(
  process: GitProcess,
  environment: NodeJS.ProcessEnv,
  operationTimeoutMs: number,
  signal?: AbortSignal,
) {
  const env = cleanGitEnvironment(environment)
  /**
   * Why the call did not SETTLE, or undefined when git actually answered.
   *
   * "git exited non-zero" is an answer. "git never finished" is not, and the
   * two must never collapse into one another — that collapse is what turns a
   * stalled repository into a clean-looking result.
   *
   * A timeout NAMES ITS BOUND, and a generic transport `failure` string must
   * not mask it: "timed out" without the limit that produced it sends the
   * reader hunting for a hang that was in fact a configured ceiling, and seven
   * suites across four packages assert the `timed out after <n>ms` shape.
   */
  const unsettledReason = (result: GitProcessResult, timeoutMs: number): string | undefined => {
    if (result.stalled === true) return "stalled"
    if (result.timedOut === true) return `timed out after ${String(timeoutMs)}ms`
    return result.failure ?? result.signal ?? undefined
  }

  const run = async (
    repo: string,
    args: readonly string[],
    allowFailure = false,
    timeoutMs = operationTimeoutMs,
    options?: Readonly<{ env?: NodeJS.ProcessEnv; stdin?: string }>,
  ): Promise<GitResult> => {
    const result = await process.run({
      repo,
      args,
      env: options?.env === undefined ? env : { ...env, ...options.env },
      ...(signal === undefined ? {} : { signal }),
      ...(options?.stdin === undefined ? {} : { stdin: options.stdin }),
      timeoutMs,
    })
    const unsettled = unsettledReason(result, timeoutMs)
    if (unsettled !== undefined) {
      const message = `git ${args.join(" ")} ${unsettled} in ${repo}`
      // A failed transport is never an exit-code answer, even for optional reads.
      throw new Error(message)
    }
    if (!allowFailure && result.code !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} exited ${result.code}`)
    }
    return { code: result.code, stdout: result.stdout, stderr: result.stderr }
  }
  const mutateConfig = async (repo: string, args: readonly string[]): Promise<GitResult> => {
    let result: GitResult | undefined
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      result = await run(repo, args, true)
      if (result.code === 0 || !result.stderr.includes("could not lock config file")) return result
      await delay(attempt * 5)
    }
    if (result === undefined) throw new Error("git-super: Git config retry did not run")
    return result
  }
  const commit = async (repo: string, ref: string): Promise<string> =>
    text(repo, ["rev-parse", "--verify", `${ref}^{commit}`])

  /**
   * Read a VALUE out of git: trimmed stdout, throwing when git says no.
   *
   * The trim belongs to the CALL, not to a whole Git surface. Hoisting it to
   * the surface is what produced two "identical" `{code, stdout, stderr}`
   * transports that silently disagreed — one of them feeding a sha straight
   * into `reset --hard`, where a trailing newline breaks the reset. Ask for
   * `text` when you want a sha or a config value; ask for `run` when you want
   * a payload (a diff, a porcelain status) that must survive verbatim.
   */
  const text = async (repo: string, args: readonly string[], timeoutMs?: number): Promise<string> =>
    (await run(repo, args, false, timeoutMs)).stdout.trim()

  /**
   * Same, but a non-zero exit yields undefined instead of throwing — for the
   * questions where "cannot answer" is a real answer rather than a fault (an
   * unreadable submodule object, a ref that is simply absent).
   */
  const optionalText = async (
    repo: string,
    args: readonly string[],
    timeoutMs = operationTimeoutMs,
  ): Promise<string | undefined> => {
    const result = await process.run({ repo, args, env, ...(signal === undefined ? {} : { signal }), timeoutMs })
    // A TIMEOUT IS NOT AN ANSWER, so it stays fatal here. Mapping every
    // non-zero outcome to undefined would conflate "no such ref" with "the
    // repository is unreachable" and with "git never finished asking",
    // quietly downgrading a stalled repository into a clean-looking sweep.
    const unsettled = unsettledReason(result, timeoutMs)
    if (unsettled !== undefined) throw new Error(`git ${args.join(" ")} ${unsettled} in ${repo}`)
    return result.code === 0 ? result.stdout.trim() : undefined
  }

  return Object.freeze({ run, mutateConfig, commit, text, optionalText })
}

async function localConfig(git: Git, repo: string, key: string): Promise<string | undefined> {
  const configured = await git.run(repo, ["config", "--local", "--get", key], true)
  if (configured.code === 1) return undefined
  if (configured.code !== 0) throw new Error(configured.stderr.trim() || `could not inspect shared ${key} config`)
  return configured.stdout.trim()
}

async function localBool(git: Git, repo: string, key: string): Promise<boolean | undefined> {
  const configured = await git.run(repo, ["config", "--local", "--get", "--type=bool", key], true)
  if (configured.code === 1) return undefined
  if (configured.code !== 0) throw new Error(configured.stderr.trim() || `could not inspect shared ${key} config`)
  return configured.stdout.trim() === "true"
}

async function removeLegacySharedPushDefault(git: Git, repo: string): Promise<void> {
  const configured = await localConfig(git, repo, "remote.pushDefault")
  if (configured !== "bay") return
  const removed = await git.mutateConfig(repo, ["config", "--local", "--unset-all", "remote.pushDefault"])
  if (removed.code === 0) return
  if ((await localConfig(git, repo, "remote.pushDefault")) !== "bay") return
  throw new Error(
    removed.stderr.trim() ||
      "could not remove legacy shared remote.pushDefault=bay; run 'git config --local --unset-all remote.pushDefault'",
  )
}

async function relocateSharedWorktree(git: Git, repo: string, worktree: string): Promise<void> {
  if (worktree === "") throw new Error("Git core.worktree is empty")
  const moved = await git.mutateConfig(repo, ["config", "--worktree", "core.worktree", worktree])
  if (moved.code !== 0) throw new Error(moved.stderr || "could not set primary worktree config")
  const removed = await git.mutateConfig(repo, ["config", "--local", "--unset-all", "core.worktree"])
  if (removed.code === 0) return
  if ((await localConfig(git, repo, "core.worktree")) !== undefined) {
    throw new Error(removed.stderr || "could not remove shared core.worktree config")
  }
}

async function relocateSharedBare(git: Git, repo: string): Promise<void> {
  // With extensions.worktreeConfig enabled, a shared core.bare=true poisons every linked worktree.
  // Scope the known non-bare primary worktree explicitly, then remove the inherited shared value.
  if ((await localBool(git, repo, "core.bare")) !== true) return
  const scoped = await git.mutateConfig(repo, ["config", "--worktree", "core.bare", "false"])
  if (scoped.code !== 0) throw new Error(scoped.stderr || "could not scope core.bare to the main worktree")
  const removed = await git.mutateConfig(repo, ["config", "--local", "--unset-all", "core.bare"])
  if (removed.code === 0) return
  if ((await localBool(git, repo, "core.bare")) !== undefined) {
    throw new Error(removed.stderr || "could not remove shared core.bare config")
  }
}

async function prepareWorktreeConfig(git: Git, repo: string, required: boolean): Promise<void> {
  const worktree = await localConfig(git, repo, "core.worktree")
  if (worktree === undefined && !required) return
  const enabled = await git.mutateConfig(repo, ["config", "extensions.worktreeConfig", "true"])
  if (enabled.code !== 0) throw new Error(enabled.stderr || "could not enable worktree config")
  await relocateSharedBare(git, repo)
  if (worktree !== undefined) await relocateSharedWorktree(git, repo, worktree)
}

async function healPoisonedWorktreeConfig(git: Git, repo: string): Promise<void> {
  if (!(await poisonedWorktreeConfigNeedsHealing(git, repo))) return
  await relocateSharedBare(git, repo)
}

async function poisonedWorktreeConfigNeedsHealing(git: Git, repo: string): Promise<boolean> {
  if ((await localBool(git, repo, "extensions.worktreeConfig")) !== true) return false
  return (await localBool(git, repo, "core.bare")) === true
}

async function ignoreInRepositoryRoot(git: Git, repo: string, root: string): Promise<void> {
  const local = relative(repo, root)
  if (local === "" || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) return
  const normalized = local.split(sep).join("/")
  if (/\r|\n/u.test(normalized)) throw new Error("configured worktree root contains a newline")
  const ignored = await git.run(repo, ["check-ignore", "--quiet", "--no-index", "--", normalized], true)
  if (ignored.code === 0) return
  if (ignored.code !== 1) throw new Error(ignored.stderr || `git check-ignore exited ${ignored.code}`)
  const exclude = (
    await git.run(repo, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"])
  ).stdout.trim()
  if (exclude === "") throw new Error("git rev-parse returned an empty exclude path")
  const escaped = normalized.replace(/([\\[\]*?!#])/gu, "\\$1")
  await appendFile(exclude, `\n/${escaped}/\n`, { encoding: "utf8", mode: 0o600 })
}

export function createGitWorktreeStore(options: GitWorktreeStoreOptions) {
  const repo = resolve(options.repo)
  const timeouts: GitWorktreeTimeouts = {
    operation: options.timeouts?.operation ?? GIT_TIMEOUT_MS,
    cleanup: options.timeouts?.cleanup ?? GIT_CLEANUP_TIMEOUT_MS,
    mutationLock: options.timeouts?.mutationLock ?? DEFAULT_MUTATION_LOCK_WAIT_MS,
  }
  // Still checked at run time: TypeScript cannot speak for a JavaScript caller,
  // and a missing capability must fail here rather than as a null dereference
  // several frames deeper.
  if (options.gitProcess === undefined) {
    throw new Error("git-super: Git worktree capability requires one injected GitProcess")
  }
  const git = createGit(options.gitProcess, options.env ?? process.env, timeouts.operation, options.signal)
  const configuredProcess = (hooks?: WorktreeHookPolicy): GitProcess => ({
    async run(request) {
      const result = await git.run(request.repo, withHookPolicy(request.args, hooks), true, request.timeoutMs, {
        ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
        ...(request.env === undefined ? {} : { env: request.env }),
      })
      return { code: result.code, stdout: result.stdout, stderr: result.stderr }
    },
  })
  const assertRemovalRoot = async (path: string) => {
    const discovered = await git.text(path, ["rev-parse", "--show-toplevel"])
    const prefix = await git.text(path, ["rev-parse", "--show-prefix"])
    const identity = probeRepository(discovered, prefix)
    if (identity.kind === "absent") {
      throw new Error(
        `${path} is not a worktree root; its git dir resolves to the parent repository ${identity.discovered}`,
      )
    }
  }
  // The existing value population is checked before custody rehome or destruction. A positive count keeps
  // the whole store for its owner's value call; ADR 0018 forbids the old automatic archive-then-delete cure.
  // Both removal and destroyed recovery use this boundary; prune delegates to destroyed recovery.
  const preserveModuleStoreValueBeforeDelete = (stores: readonly ModuleStore[]) => {
    const value = stores.find((store) => store.valueCommits > 0)
    if (value !== undefined) {
      throw new Error(
        `${describeModuleStores([value]).join("")}; worktree preserved. Owner value call: land, keep one real branch, or recorded delete.`,
      )
    }
    for (const store of stores) {
      const line = `${describeModuleStores([store]).join("")}\n`
      if (options.report !== undefined) options.report(line)
    }
  }
  const prepareRemoval = async (path: string, excludedSubmodules?: readonly string[], retained = false) => {
    await assertRemovalRoot(path)
    const gitDir = realpathSync(await git.text(path, ["rev-parse", "--absolute-git-dir"]))
    const common = realpathSync(await git.text(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))
    const custody = await assertExcludedRemovalCustody(
      git,
      configuredProcess(),
      path,
      gitDir,
      common,
      excludedSubmodules,
    )
    if (custody.notCompared.some((entry) => entry.reason !== "excluded")) {
      return { gitDir, rehome: undefined, notCompared: custody.notCompared, stores: [] }
    }
    // Every destructive removal walks the slot's own `modules/` inventory, whether or not any submodule is
    // excluded: a store no HEAD declaration names is destroyed with the slot, so positive value preserves it.
    // A retained removal copies the whole store population, so nothing is destroyed by it.
    const stores = retained
      ? []
      : inspectModuleStores(path, gitDir, custody.excludedStores, custody.unclaimedExclusions).stores
    const rehome = await prepareRemovalBorrowers(git, path, common, gitDir, custody, excludedSubmodules)
    return {
      gitDir,
      rehome,
      notCompared: [...custody.notCompared, ...rehome.notCompared],
      stores,
    }
  }
  // Reuse removal's consulted population: native children can belong to independent
  // stores even though their checkouts die with the root directory.
  const captureLinkedChildren = async (path: string, rootGitDir: string, excluded: readonly string[]) => {
    const within = (parent: string, child: string) => {
      const local = relative(parent, child)
      return local === "" || (local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local))
    }
    const children: Array<{
      path: string
      common: string
      admin: string
      pointer: string
      primary: string
      branch?: string
      tip?: string
    }> = []
    for (const entry of (await statusWithGit({ repo: path, excludedSubmodules: excluded }, git, timeouts.operation))
      .consultedRepositories) {
      if (entry.path === ".") continue
      const child = realpathSync(entry.root)
      if (!within(path, child) || child === path) continue
      const admin = realpathSync(await git.text(child, ["rev-parse", "--absolute-git-dir"]))
      const common = realpathSync(await git.text(child, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))
      if (admin === common || within(path, common) || within(rootGitDir, common)) continue
      const rows = await listWorktrees(git, common)
      const registered = rows.find((row) => row.path === child)
      const primaryRow = rows[0]
      if (registered === undefined || primaryRow === undefined) {
        throw new Error(`linked child ${child} has no exact native registration in ${common}`)
      }
      // A bare store appears as its own worktree-list row. It is a valid
      // independent primary for recovery, but has no worktree top-level.
      const primary =
        primaryRow.path === common
          ? common
          : realpathSync(await git.text(primaryRow.path, ["rev-parse", "--show-toplevel"]))
      if (within(path, primary) || within(rootGitDir, primary)) continue
      if (realpathSync(await git.text(primary, ["rev-parse", "--absolute-git-dir"])) !== common) {
        throw new Error(`linked child ${child} has no independent primary for ${common}`)
      }
      const pointer = resolve(admin, (await readFile(join(admin, "gitdir"), "utf8")).trim())
      if (pointer !== join(child, ".git")) {
        throw new Error(`linked child ${child} has mismatched administration backpointer ${pointer}`)
      }
      children.push({
        path: child,
        common,
        admin,
        pointer,
        primary,
        ...(registered.branch === undefined ? {} : { branch: registered.branch }),
        ...(registered.head === undefined ? {} : { tip: registered.head }),
      })
    }
    return children.sort((a, b) => b.path.length - a.path.length)
  }
  const runWithMutationLock = async <Result>(
    dir: string,
    holder: string,
    operation: () => Promise<Result>,
  ): Promise<Result> => {
    const progress = createProgressReporter(
      options.report,
      (owner) => `git-super worktree: waiting for writer lock held by ${owner}\n`,
    )
    try {
      return await createExclusive(dir, {
        timeoutMs: timeouts.mutationLock,
        onContended: progress.phase,
      }).run(
        () => {
          progress.cancel()
          return operation()
        },
        { holder },
      )
    } finally {
      progress.cancel()
    }
  }
  let mutations: Promise<string> | undefined
  const mutationLock = (): Promise<string> => {
    mutations ??= (async () => {
      const needsConfigHealing = await poisonedWorktreeConfigNeedsHealing(git, repo)
      const commonDir = (await git.run(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim()
      if (commonDir === "") throw new Error("git rev-parse returned an empty common directory")
      const dir = join(commonDir, "yrd-worktree-mutations")
      if (needsConfigHealing) {
        await runWithMutationLock(dir, "worktree configuration repair", () => healPoisonedWorktreeConfig(git, repo))
      }
      return dir
    })()
    return mutations
  }
  const mutate = async <Result>(holder: string, operation: () => Promise<Result>): Promise<Result> =>
    runWithMutationLock(await mutationLock(), holder, operation)

  /**
   * Why a worktree still holds this branch NAME, or undefined when none does.
   * One predicate for both the retirement write and its dry run (28989): a dry
   * run that disagreed with the write would be worse than no dry run at all.
   */
  const branchHolder = async (branch: string): Promise<string | undefined> => {
    const ref = `refs/heads/${branch}`
    for (const row of await listWorktrees(git, repo)) {
      const operation = row.branch === undefined ? worktreeOperationBranch(row.path) : null
      if (row.branch === ref || operation?.branch === branch) {
        return `branch ${branch} is ${
          operation === null ? "checked out" : `held by ${operation.operation}`
        } at ${row.path}; keep it until the worktree releases it`
      }
    }
    return undefined
  }

  return Object.freeze({
    repo,
    git,
    branchHolder,
    async ready(): Promise<void> {
      await mutationLock()
    },
    async removeLegacySharedPushDefault(): Promise<void> {
      if ((await localConfig(git, repo, "remote.pushDefault")) !== "bay") return
      await mutate("Bay legacy push configuration cleanup", () => removeLegacySharedPushDefault(git, repo))
    },
    async prepareRoot(root: string, required = false): Promise<void> {
      await mutate(`prepare worktree root ${resolve(root)}`, async () => {
        await git.run(repo, ["rev-parse", "--show-toplevel"])
        await ignoreInRepositoryRoot(git, repo, resolve(root))
        await prepareWorktreeConfig(git, repo, required)
      })
    },
    async add(input: WorktreeAdd): Promise<void> {
      await mutate(input.operation ?? `worktree add ${input.path}`, async () => {
        if (existsSync(input.path)) {
          throw new Error(`workspace path '${input.path}' already exists; inspect or remove it explicitly`)
        }
        const addArgs =
          input.kind === "branch"
            ? ["worktree", "add", input.path, input.branch]
            : input.kind === "new-branch"
              ? ["worktree", "add", "-b", input.branch, input.path, input.ref]
              : input.kind === "reset-branch"
                ? ["worktree", "add", "-B", input.branch, input.path, input.ref]
                : input.kind === "detached"
                  ? ["worktree", "add", "--detach", input.path, input.ref]
                  : ["worktree", "add", input.path, input.ref]
        const insertion = addArgs.indexOf("add") + 1
        addArgs.splice(
          insertion,
          0,
          ...(input.lockReason === undefined ? [] : ["--lock", "--reason", input.lockReason]),
        )
        await git.run(repo, withHookPolicy(addArgs, input.hooks))
      })
    },
    async materializeSubmodules(
      path: string,
      materializeOptions: Readonly<{
        force?: boolean
        hooks?: WorktreeHookPolicy
        /** Literal root-relative paths left empty and uninitialized: no init, store or gitfile. */
        excludedSubmodules?: readonly string[]
      }> = {},
    ): Promise<void> {
      const materializeProcess = configuredProcess(materializeOptions.hooks)
      const result = await materializeSubmodulesWithProcess(materializeProcess, {
        worktree: path,
        referenceWorktree: repo,
        ...(materializeOptions.force === true ? { force: true } : {}),
        ...(materializeOptions.excludedSubmodules === undefined
          ? {}
          : { excludedSubmodules: materializeOptions.excludedSubmodules }),
      })
      if (result.code !== 0) {
        throw new Error(result.stderr || result.stdout || "could not materialize worktree submodules")
      }
    },
    async lock(path: string, reason: string): Promise<void> {
      await mutate(`worktree lock ${path}`, () => git.run(repo, ["worktree", "lock", "--reason", reason, path]))
    },
    async unlock(path: string): Promise<void> {
      await mutate(`worktree unlock ${path}`, () => unlockWorktree(git, repo, path))
    },
    /**
     * Release the exact full local branch without changing files, index, leases or worktree locks.
     * W1: the mutation lock excludes cooperating store writers, but raw external Git can switch HEAD's
     * symref to another branch at the same OID after this read. The old-OID update rejects an advanced
     * tip, not that same-OID symref race; callers must exclude external checkout writers.
     */
    async detachAt(
      path: string,
      expectedTip: string,
      expectedBranch: string,
    ): Promise<Readonly<{ branch: string; tip: string }>> {
      return mutate(`detach worktree ${path}`, async () => {
        if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(expectedTip)) {
          throw new Error(`worktree ${path}: expected a full SHA1 or SHA256 tip, got ${JSON.stringify(expectedTip)}`)
        }
        const target = realpathSync(path)
        const registered = await listWorktrees(git, repo)
        let exact = registered.some((row) => row.path === target)
        if (!exact) {
          // Absorbed submodules register their primary administration directory, not their checkout.
          const common = realpathSync(
            (await git.run(target, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim(),
          )
          const directory = realpathSync((await git.run(target, ["rev-parse", "--absolute-git-dir"])).stdout.trim())
          const toplevel = realpathSync((await git.run(target, ["rev-parse", "--show-toplevel"])).stdout.trim())
          exact = directory === common && toplevel === target && registered.some((row) => row.path === common)
        }
        if (!exact) {
          throw new Error(`worktree ${path}: no exact registration in ${repo}; refusing to detach HEAD`)
        }
        const symbolic = await git.run(target, ["symbolic-ref", "--quiet", "--no-recurse", "HEAD"], true)
        if (symbolic.code !== 0) {
          throw new Error(`worktree ${path}: HEAD is not a readable symbolic reference: ${symbolic.stderr.trim()}`)
        }
        const branch = symbolic.stdout.trim()
        if (!branch.startsWith("refs/heads/")) {
          throw new Error(`worktree ${path}: HEAD references ${branch}, expected refs/heads/<branch>`)
        }
        await git.run(target, ["check-ref-format", branch])
        if (branch !== expectedBranch) {
          throw new Error(`worktree ${path}: HEAD references ${branch}, expected ${expectedBranch}`)
        }
        const tip = await git.commit(target, branch)
        if (tip !== expectedTip) {
          throw new Error(`worktree ${path}: branch ${branch} tip moved from ${expectedTip} to ${tip}`)
        }
        // The expected old OID also refuses a branch that advances after the read above.
        await git.run(target, ["update-ref", "--no-deref", "HEAD", expectedTip, expectedTip])
        return { branch, tip: expectedTip }
      })
    },
    async remove(
      path: string,
      removeOptions: Readonly<{
        operation?: string
        unlock?: boolean
        retention?: WorktreeRetention
        excludedSubmodules?: readonly string[]
        noRehome?: boolean
        preserved?: readonly string[]
        componentCustody?: ComponentCustodyPolicy
      }> = {},
    ): Promise<
      | void
      | Readonly<{ borrowers: readonly string[] }>
      | Readonly<{ compaction: CompactionResult }>
      | Readonly<{ custodyRefusal: ComponentCustodyRefusal }>
    > {
      await assertRemovalRoot(path)
      if (removeOptions.componentCustody !== undefined && removeOptions.retention === undefined) {
        throw new Error("component custody requires the existing retention proof on worktree removal")
      }
      // The selected checkout can be the removal target. Its registry outlives it.
      const removalRepo = await git.text(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
      let stagingPath: string | undefined
      let borrowed: Readonly<{ borrowers: readonly string[] }> | undefined
      let removalProof: WorktreeRemovalProof | undefined
      let componentCustodyProof: ComponentCustodyProof | undefined
      let compaction: CompactionResult | undefined
      let children: Awaited<ReturnType<typeof captureLinkedChildren>> = []
      let custodyRefusal: ComponentCustodyRefusal | undefined
      await mutate(removeOptions.operation ?? `worktree remove ${path}`, async () => {
        const phaseOrigin = Date.now()
        const phases: Record<string, number> = {}
        const markPhase = (name: string, started: number) => {
          phases[name] = Date.now() - started
        }
        const logPhases = () => {
          if (process.env.GIT_SUPER_REMOVAL_PHASES !== "1") return
          console.error(
            `git-super removal phases ${JSON.stringify({ path, phases, totalMs: Date.now() - phaseOrigin })}`,
          )
        }
        if (removeOptions.retention !== undefined && removeOptions.unlock === true) {
          throw new Error(`retained worktree removal cannot unlock ${path}; resolve its holder first`)
        }
        const prepareStarted = Date.now()
        const { gitDir, rehome, notCompared, stores } = await prepareRemoval(
          path,
          removeOptions.excludedSubmodules,
          removeOptions.retention !== undefined,
        )
        if (notCompared.some((entry) => entry.reason !== "excluded")) {
          throw Object.assign(
            new Error(
              `worktree removal refused: ${notCompared
                .filter((entry) => entry.reason !== "excluded")
                .map((entry) => entry.message)
                .join("; ")}`,
            ),
            { notCompared },
          )
        }
        if (rehome === undefined) throw new Error(`worktree ${path} has no prepared borrower custody`)
        markPhase("prepareRemoval", prepareStarted)
        // No custody rehome or destruction has run; a value-holding store stays in place.
        preserveModuleStoreValueBeforeDelete(stores)
        const proofDeadline = Date.now() + timeouts.cleanup
        const adapters =
          removeOptions.componentCustody === undefined
            ? undefined
            : selectedCustodyAdapters(
                options.gitProcess,
                repo,
                options.env ?? process.env,
                options.signal,
                proofDeadline,
              )
        let initialCensus: ComponentCensus | undefined
        if (removeOptions.componentCustody !== undefined && adapters !== undefined) {
          try {
            initialCensus = await buildComponentCensus({
              git,
              adapters,
              repo,
              worktree: path,
              rootGitDir: gitDir,
              excludedSubmodules: removeOptions.excludedSubmodules ?? [],
              policy: removeOptions.componentCustody,
              deadline: proofDeadline,
            })
          } catch (error) {
            custodyRefusal = {
              status: "unknown",
              component: ".",
              source: "recursive component census",
              detail: error instanceof Error ? error.message : String(error),
            }
            return
          }
        }
        const mutationDirectory = await mutationLock()
        let writerLeases: ReturnType<typeof acquireRemovalWriterLeases>
        try {
          writerLeases = acquireRemovalWriterLeases(gitDir, undefined, {
            ...(initialCensus === undefined ? {} : { additionalGitDirs: initialCensus.externalOwners }),
            skip: [join(mutationDirectory, "writer.lock")],
          })
        } catch (error) {
          if (removeOptions.componentCustody !== undefined) {
            const detail = error instanceof Error ? error.message : String(error)
            const queriedOwner = initialCensus?.externalOwners.find((owner) =>
              detail.includes(join(owner, "yrd-worktree-mutations", "writer.lock")),
            )
            custodyRefusal = {
              status: "unknown",
              component: ".",
              source: queriedOwner === undefined ? "removal writer lease" : `writer lease owner ${queriedOwner}`,
              detail,
            }
            return
          }
          throw error
        }
        const resolvedPath = resolve(path)
        try {
          if (removeOptions.componentCustody !== undefined && adapters !== undefined && initialCensus !== undefined) {
            let sidecarDir: string | undefined
            try {
              const confirmedCensus = await buildComponentCensus({
                git,
                adapters,
                repo,
                worktree: path,
                rootGitDir: gitDir,
                excludedSubmodules: removeOptions.excludedSubmodules ?? [],
                policy: removeOptions.componentCustody,
                deadline: proofDeadline,
              })
              if (confirmedCensus.fingerprint !== initialCensus.fingerprint) {
                custodyRefusal = {
                  status: "unknown",
                  component: ".",
                  source: "component identity recensus",
                  detail:
                    "component population, Git-store identities, alternates, primary witnesses, or lease owners changed after acquiring writer leases",
                }
              } else {
                const preFreshness = await computeCustodyFreshness({
                  adapters,
                  census: confirmedCensus,
                  policy: removeOptions.componentCustody,
                  deadline: proofDeadline,
                })
                const proofSidecarDir = mkdtempSync(join(tmpdir(), "git-super-component-custody-"))
                sidecarDir = proofSidecarDir
                const sidecarReal = realpathSync(proofSidecarDir)
                if (
                  [
                    ...initialCensus.removal,
                    ...initialCensus.identities.flatMap((entry) => [
                      entry.gitDir,
                      entry.commonDir,
                      entry.objectDirectory,
                    ]),
                    ...initialCensus.witnessStores,
                    ...initialCensus.alternateStores,
                    ...initialCensus.externalOwners,
                    realpathSync(removeOptions.componentCustody.primaryRoot),
                  ].some((root) => {
                    const part = relative(root, sidecarReal)
                    return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part))
                  })
                ) {
                  throw new Error(
                    `temporary proof sidecar ${sidecarReal} is inside a source, witness, or removal store`,
                  )
                }
                const ledgerSources = initialCensus.sources.filter((source) => source.component !== ".")
                const contents =
                  ledgerSources.length === 0
                    ? undefined
                    : await scanContents(path, {}, initialCensus.removal, {
                        sidecarDir: proofSidecarDir,
                        sources: ledgerSources,
                        sourceMode: "complete-commit",
                        run: adapters.run,
                        stream: adapters.stream,
                        deadline: proofDeadline,
                      })
                if (contents !== undefined && contents.status !== "pass") {
                  const first = contents.components.find((entry) => entry.missingRoots > 0)
                  custodyRefusal = {
                    status: contents.status,
                    component: first?.component ?? ".",
                    source: contents.status === "blocked" ? "root-reference integrity" : "effective commit inventory",
                    detail: contents.detail,
                    ...(first?.missingRootsSample[0] === undefined ? {} : { oid: first.missingRootsSample[0] }),
                  }
                } else {
                  const contentComponents = contents?.components ?? []
                  const witnesses: WitnessIdentity[] = []
                  const witnessKeys = new Set<string>()
                  let witnessCount = 0
                  let custodyFailure: ComponentCustodyRefusal | undefined
                  for (const component of contentComponents) {
                    const store = initialCensus.witnessStoreByComponent.find(
                      (entry) => entry.component === component.component,
                    )?.store
                    if (store === undefined) {
                      custodyFailure = {
                        status: "unknown",
                        component: component.component,
                        source: "persistent primary object store",
                        detail: `no exact primary witness store was resolved for component ${component.component}`,
                      }
                      break
                    }
                    const custody = await scanCustody(path, [component], [store], initialCensus.removal, {
                      sidecarDir: proofSidecarDir,
                      run: adapters.run,
                      stream: adapters.stream,
                      deadline: proofDeadline,
                      witnessPolicy: { targetBranch: removeOptions.componentCustody.targetBranch },
                      onPhase: (name, ms) => {
                        phases[name] = (phases[name] ?? 0) + ms
                      },
                    })
                    if (custody.status !== "pass") {
                      const first: CustodyTarget | undefined = custody.missing[0]
                      custodyFailure = {
                        status: custody.status,
                        component: first?.component ?? component.component,
                        source: first?.source ?? "surviving primary Git graph",
                        detail: custody.detail,
                        ...(first === undefined ? {} : { oid: first.oid }),
                      }
                      break
                    }
                    witnessCount += custody.witnessCount
                    for (const witness of custody.witnesses) {
                      const key = `${witness.store}\0${witness.ref}\0${witness.tip}`
                      if (witnessKeys.has(key)) continue
                      witnessKeys.add(key)
                      witnesses.push(witness)
                    }
                  }
                  if (custodyFailure !== undefined) {
                    custodyRefusal = custodyFailure
                  } else {
                    const sourceSummary = initialCensus.identities.map(
                      ({ component, gitDir: sourceGitDir, commonDir, objectDirectory }) => ({
                        component,
                        gitDir: sourceGitDir,
                        commonDir,
                        objectDirectory,
                      }),
                    )
                    const atRiskDigest = contentComponents
                      .map(
                        (entry) =>
                          `${entry.component}\t${entry.gitDir ?? ""}\t${entry.atRisk}\t${entry.atRiskSidecar.sha256}`,
                      )
                      .join("\n")
                    const digest = createHash("sha256")
                      .update(
                        JSON.stringify({
                          targetBranch: removeOptions.componentCustody.targetBranch,
                          sources: sourceSummary,
                          atRiskDigest,
                          witnesses,
                          witnessCount,
                        }),
                      )
                      .digest("hex")
                    componentCustodyProof = {
                      targetBranch: removeOptions.componentCustody.targetBranch,
                      sources: sourceSummary,
                      witnesses,
                      componentCount: contentComponents.length,
                      effectiveCommitCount: contentComponents.reduce((count, entry) => count + entry.atRisk, 0),
                      witnessCount,
                      digest,
                      elapsedMs: Date.now() + timeouts.cleanup - proofDeadline,
                    }
                  }
                }
                if (custodyRefusal !== undefined && custodyRefusal.status === "blocked") {
                  const postFreshness = await computeCustodyFreshness({
                    adapters,
                    census: confirmedCensus,
                    policy: removeOptions.componentCustody,
                    deadline: proofDeadline,
                  })
                  if (
                    preFreshness.status === "ok" &&
                    postFreshness.status === "ok" &&
                    preFreshness.fingerprint === postFreshness.fingerprint
                  ) {
                    const scoped = scopeCustodyFreshnessMaterial(
                      postFreshness.material,
                      confirmedCensus.witnessStoreByComponent,
                      custodyRefusal.component,
                    )
                    if (scoped.status === "ok") {
                      custodyRefusal = { ...custodyRefusal, fingerprint: scoped.fingerprint }
                    }
                  }
                }
              }
            } catch (error) {
              custodyRefusal = {
                status: "unknown",
                component: ".",
                source: "component custody proof",
                detail: error instanceof Error ? error.message : String(error),
              }
            } finally {
              if (sidecarDir !== undefined) {
                try {
                  rmSync(sidecarDir, { recursive: true })
                } catch (error) {
                  custodyRefusal = {
                    status: "unknown",
                    component: ".",
                    source: "proof sidecar cleanup",
                    detail: `${custodyRefusal?.detail ? `${custodyRefusal.detail}; ` : ""}could not remove invocation sidecar ${sidecarDir}: ${error instanceof Error ? error.message : String(error)}`,
                  }
                }
              }
            }
            if (custodyRefusal !== undefined) return
          }
          if (removeOptions.noRehome === true) {
            const borrowers = rehome.inspect()
            if (borrowers.length > 0) {
              borrowed = { borrowers }
              return
            }
          }
          if (removeOptions.retention !== undefined) {
            removalProof = await retainWorktreeModules(
              git,
              repo,
              path,
              removeOptions.retention,
              (repository, target) => inspectWorktree(git, repository, target),
              writerLeases.proof,
              writerLeases.created,
              removeOptions.noRehome === true ? () => [] : rehome.run,
              removeOptions.excludedSubmodules,
              notCompared,
              undefined,
              undefined,
              undefined,
              removeOptions.preserved,
              undefined,
              componentCustodyProof,
            )
          } else {
            if (removeOptions.unlock === true) await unlockWorktree(git, repo, path)
            if (removeOptions.noRehome !== true) rehome.run()
          }
          children = await captureLinkedChildren(resolvedPath, gitDir, removeOptions.excludedSubmodules ?? [])

          // Target-only two-phase removal (#27551, CTO ruling beadc3d2):
          // Phase 1 (under mutation lock):
          // Rename the worktree directory to <parent>/.trash/<uuid> on the same filesystem.
          // Leave a stub at the original path holding only its .git gitlink file.
          // Run existing `git worktree remove --force <path>` + verification.
          // On EXDEV, fall back to today's in-lock removal with a warning.
          const parentDir = dirname(resolvedPath)
          const trashDir = join(parentDir, ".trash")
          const targetStaging = join(trashDir, randomUUID())
          const gitlinkPath = join(resolvedPath, ".git")

          if (existsSync(gitlinkPath)) {
            try {
              mkdirSync(trashDir, { recursive: true })
              renameSync(resolvedPath, targetStaging)
              // Ownership changes at rename, even if creating the Git stub fails.
              stagingPath = targetStaging
              mkdirSync(resolvedPath, { recursive: true })
              copyFileSync(join(targetStaging, ".git"), gitlinkPath)
            } catch (stageError) {
              if (
                stagingPath === undefined &&
                stageError !== null &&
                typeof stageError === "object" &&
                "code" in stageError &&
                stageError.code === "EXDEV"
              ) {
                console.warn(
                  `git-super: worktree removal staging rename across devices failed (EXDEV); falling back to in-lock removal for '${path}'`,
                )
              } else {
                throw stageError
              }
            }
          }

          const removeStarted = Date.now()
          await git.run(removalRepo, ["worktree", "remove", "--force", path], false, timeouts.cleanup)
          if (existsSync(path) || (await inspectWorktree(git, removalRepo, path)).registered) {
            throw new Error(`git reported success but did not fully remove worktree '${path}'`)
          }
          markPhase("gitWorktreeRemove", removeStarted)
        } catch (error) {
          if (stagingPath !== undefined && existsSync(stagingPath)) {
            let retainedStaging = stagingPath
            try {
              if (existsSync(resolvedPath)) {
                // Only remove our Git stub. Unexpected contents block restoration
                // rather than being recursively deleted with the original error.
                rmSync(join(resolvedPath, ".git"), { force: true })
                rmdirSync(resolvedPath)
              }
              renameSync(stagingPath, resolvedPath)
              stagingPath = undefined
            } catch (restoreError) {
              // The staging directory survives as the recovery record. Mark it so the clean-root
              // sweep preserves it even after the admin entry is pruned: the sweep keys on this
              // marker (#28800), and an unmarked directory is reclaimed as ordinary leftover trash
              // once quiescent and holder-free (#28906).
              let markerNote = ""
              try {
                writeFileSync(join(retainedStaging, ".restore-failed"), `restore-failed\ntarget ${resolvedPath}\n`)
              } catch (markerError) {
                const detail = markerError instanceof Error ? markerError.message : String(markerError)
                // The in-directory marker failed, so fall back to the sweep's other recogniser --
                // the '.restore-failed' name suffix -- and keep the retained record recoverable
                // instead of letting it be reclaimed as leftover trash (#28906 REVISE).
                const suffixedStaging = `${retainedStaging}.restore-failed`
                try {
                  renameSync(retainedStaging, suffixedStaging)
                  retainedStaging = suffixedStaging
                  markerNote = `; the in-directory marker could not be written (${detail}), so the retained record is marked by its '.restore-failed' name suffix`
                } catch (fallbackError) {
                  const fallbackDetail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
                  markerNote = `; the recovery record is UNMARKED, so the clean-root sweep will reclaim it as leftover (marker write failed: ${detail}; '.restore-failed' name-suffix fallback failed: ${fallbackDetail})`
                  console.warn(
                    `git-super: failed to mark retained restore-failed record in '${retainedStaging}': ${detail}; name-suffix fallback failed: ${fallbackDetail}`,
                  )
                }
              }
              throw writerLeases.refusal(
                new Error(
                  `worktree removal failed: ${error instanceof Error ? error.message : String(error)}; restoration to '${resolvedPath}' failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}; contents retained at '${retainedStaging}'${markerNote}`,
                  { cause: new AggregateError([error, restoreError], "worktree removal and restoration failed") },
                ),
              )
            }
          }
          throw writerLeases.refusal(error)
        } finally {
          logPhases()
          writerLeases.release()
        }
      })

      try {
        // After native --force: pack-refs + drop remote reflogs on the retained copy, then rewrite
        // the proof so gate 2 still matches. Compaction must not throw: --force already succeeded,
        // so a throw would record a failed close for a worktree that is gone (R2). On failure every
        // ref value stays intact, the proof is not rewritten (later retention verify refuses), and
        // the copy is never deleted.
        if (removalProof?.retained != null) {
          compaction = compactRetainedModules(removalProof, {
            common: removalRepo,
            preState: { kind: "in-run" },
          })
        }
      } finally {
        // Phase 2 (outside mutation lock):
        // Delete the staging directory synchronously in the caller. Never fire-and-forget.
        if (stagingPath !== undefined) {
          try {
            rmSync(stagingPath, { recursive: true, force: true })
            try {
              rmdirSync(dirname(stagingPath))
            } catch (error) {
              // Other removals may still own entries in the shared staging directory.
              if (
                error === null ||
                typeof error !== "object" ||
                !("code" in error) ||
                (error.code !== "ENOTEMPTY" && error.code !== "EEXIST")
              ) {
                console.warn(
                  `git-super: failed to remove staging parent '${dirname(stagingPath)}': ${error instanceof Error ? error.message : String(error)}`,
                )
              }
            }
          } catch (error) {
            console.warn(
              `git-super: failed to delete staged worktree directory '${stagingPath}': ${error instanceof Error ? error.message : String(error)}`,
            )
          }
        }
      }
      if (custodyRefusal !== undefined) return { custodyRefusal }
      if (borrowed !== undefined) return borrowed
      const failures: Error[] = []
      for (const child of children) {
        try {
          // Any new contents belong to the next owner, even if the old pointer was reused.
          await lstat(child.path).then(
            () => {
              throw new Error("checkout path survives or was rebound; left untouched")
            },
            (error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error
            },
          )
          if (
            realpathSync(child.common) !== child.common ||
            realpathSync(await git.text(child.primary, ["rev-parse", "--absolute-git-dir"])) !== child.common
          ) {
            throw new Error("independent primary store changed since capture")
          }
          const current = (await listWorktrees(git, child.common)).find((row) => row.path === child.path)
          if (current === undefined) continue
          if (
            current.branch !== child.branch ||
            current.head !== child.tip ||
            resolve(child.admin, (await readFile(join(child.admin, "gitdir"), "utf8")).trim()) !== child.pointer
          ) {
            throw new Error("native registration or administration identity changed since capture")
          }
          await createGitWorktreeStore({ ...options, repo: child.primary }).recoverDestroyed(child.path)
        } catch (cause) {
          let state: string
          try {
            state = (await listWorktrees(git, child.common)).some((row) => row.path === child.path)
              ? "registration kept"
              : "registration removed; cleanup incomplete"
          } catch (inspectionError) {
            state = `registration state unreadable: ${String(inspectionError)}`
          }
          failures.push(
            new Error(
              `root removed; child ${child.path} ${state}: ${String(cause)}; inspect ${child.common} and retry createGitWorktreeStore({ repo: ${JSON.stringify(child.primary)}, gitProcess }).recoverDestroyed(${JSON.stringify(child.path)})`,
              { cause },
            ),
          )
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, failures.map((error) => error.message).join("; "))
      if (compaction !== undefined) return { compaction }
      return undefined
    },
    /**
     * Recover every registration git would prune through `recoverDestroyed`, so each one's module stores are
     * judged and their value archived before the registration goes (30616). A raw `git worktree prune` never
     * runs: it deletes a registration's `modules/` stores unread. git still decides what is prunable, by a dry
     * run that honours `expire`; that also names an administration directory with no gitdir file, which
     * `worktree list` omits. `recoverDestroyed` archives module stores but not the slot's own HEAD, so a detached
     * HEAD no ref holds keeps its registration. A registration that cannot be recovered keeps its stores and is
     * named in the throw, after every other one is handled.
     */
    async prune(pruneOptions: Readonly<{ expire?: string; operation?: string }> = {}): Promise<void> {
      const operation = pruneOptions.operation ?? "worktree prune"
      // git localizes these lines; C keeps them parseable.
      const listed = await git.run(
        repo,
        [
          "worktree",
          "prune",
          "--dry-run",
          "--verbose",
          ...(pruneOptions.expire === undefined ? [] : ["--expire", pruneOptions.expire]),
        ],
        false,
        undefined,
        { env: { LC_ALL: "C" } },
      )
      const candidates: { id: string; reason: string }[] = []
      const unreadable: string[] = []
      for (const line of [...listed.stdout.split("\n"), ...listed.stderr.split("\n")]) {
        if (line.trim() === "") continue
        const [, id, reason] = /^Removing worktrees\/(.+): (.+)$/u.exec(line.trim()) ?? []
        if (id === undefined || reason === undefined) unreadable.push(line)
        else candidates.push({ id, reason })
      }
      if (unreadable.length > 0) {
        throw new Error(
          `worktree prune: git's dry run printed ${String(unreadable.length)} line(s) that name no prunable registration (${unreadable.map((line) => JSON.stringify(line)).join(", ")}); nothing recovered`,
        )
      }
      const common = realpathSync(await git.text(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))
      const recover = async (adminDir: string): Promise<void> => {
        let pointer: string
        try {
          pointer = (await readFile(join(adminDir, "gitdir"), "utf8")).trim()
        } catch (cause) {
          throw new Error(`its gitdir pointer is unreadable (${String(cause)}); its module stores are unjudged`, {
            cause,
          })
        }
        if (pointer === "") throw new Error("its gitdir pointer is empty; its module stores are unjudged")
        const path = dirname(resolve(adminDir, pointer))
        const head = (await readFile(join(adminDir, "HEAD"), "utf8")).trim()
        if (!head.startsWith("ref: ")) {
          const unheld = await git.run(repo, [
            "rev-list",
            "-n",
            "1",
            head,
            "--not",
            "--branches",
            "--remotes",
            "--tags",
            "--glob=refs/archive/*",
          ])
          if (unheld.stdout.trim() !== "") {
            throw new Error(
              `worktree ${path}: detached HEAD ${head.slice(0, 12)} held by no ref (refs/heads, refs/remotes, refs/tags, refs/archive); archive it before pruning`,
            )
          }
        }
        try {
          await createGitWorktreeStore(options).recoverDestroyed(path, `${operation}: recover ${path}`)
        } catch (cause) {
          throw new Error(`worktree ${path}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
        }
      }
      const failures: Error[] = []
      for (const { id, reason } of candidates) {
        const adminDir = join(common, "worktrees", id)
        try {
          await recover(adminDir)
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause)
          failures.push(new Error(`registration ${adminDir} kept (${reason}): ${message}`, { cause }))
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, failures.map((error) => error.message).join("; "))
    },
    async inspect(path: string): Promise<WorktreeInspection> {
      return inspectWorktree(git, repo, path)
    },
    /** This read-only inventory is a snapshot, not permission: removal rechecks under its mutation lock. */
    async list(): Promise<readonly RegisteredWorktree[]> {
      return listWorktrees(git, repo)
    },
    /**
     * Remove only the literal local ref at its exact tip; pre-existing symbolic aliases are refused.
     * The existing worktree writer lock excludes a concurrent store.add; the ref transaction refuses a moved branch.
     * An optional verify line refuses unless that ref still holds that oid in the same transaction.
     * Callers own eligibility, attribution and journal policy. This never removes a worktree or remote ref.
     * beforeRemove rechecks caller authority under the acquired lock; throwing preserves the branch.
     */
    async removeBranch(
      input: Readonly<{
        branch: string
        tip: string
        verify?: Readonly<{ ref: string; oid: string }>
        beforeRemove?: () => Promise<void>
      }>,
    ): Promise<void> {
      await mutate(`retire branch ${input.branch}`, async () => {
        const { branch, tip, verify } = input
        if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(tip)) {
          throw new Error(`branch ${branch}: expected a full SHA1 or SHA256 tip, got ${JSON.stringify(tip)}`)
        }
        await git.run(repo, ["check-ref-format", "--branch", branch])
        if (verify !== undefined) {
          if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(verify.oid)) {
            throw new Error(
              `branch ${branch}: verify ${verify.ref} needs a full oid, got ${JSON.stringify(verify.oid)}`,
            )
          }
          await git.run(repo, ["check-ref-format", verify.ref])
        }
        const ref = `refs/heads/${branch}`
        await input.beforeRemove?.()
        const held = await branchHolder(branch)
        if (held !== undefined) throw new Error(held)
        const symbolic = await git.run(repo, ["symbolic-ref", "--quiet", "--no-recurse", ref], true)
        if (symbolic.code === 0) {
          throw new Error(
            `branch ${branch}: symbolic reference to ${symbolic.stdout.trim()}; refusing branch removal; it is an alias, not a branch: run git symbolic-ref --delete ${shellQuote(ref)} to remove only the alias`,
          )
        }
        if (symbolic.code !== 1) {
          throw new Error(
            `branch ${branch}: symbolic reference inspection failed (exit ${symbolic.code}): ${symbolic.stderr.trim()}`,
          )
        }
        const verifyLine = verify === undefined ? "" : `verify ${verify.ref} ${verify.oid}\n`
        await git.run(
          repo,
          ["-c", "core.fsync=loose-object,reference", "-c", "core.fsyncMethod=fsync", "update-ref", "--stdin"],
          false,
          timeouts.operation,
          // no-deref is per-command: keep verify unchanged and fence a ref rebound after the symbolic check.
          { stdin: `start\n${verifyLine}option no-deref\ndelete ${ref} ${tip}\nprepare\ncommit\n` },
        )
      })
    },
    /**
     * This read-only inspection is a snapshot, not permission: remove rechecks admission under its mutation lock.
     * A removal refused by a non-excluded `notCompared` entry carries that refusal and inspects no `borrowers`.
     */
    async inspectRemoval(
      path: string,
      inspectOptions: Readonly<{ excludedSubmodules?: readonly string[] }> = {},
    ): Promise<
      Pick<SuperStatusResult, "records" | "notCompared" | "consultedRepositories" | "uninitializedSubmodules"> &
        Readonly<{ borrowers: readonly string[]; moduleStores: readonly ModuleStore[] }>
    > {
      const prepared = await prepareRemoval(path, inspectOptions.excludedSubmodules)
      const status = await inspectRemovalStatusWithGit(git, path, inspectOptions.excludedSubmodules)
      // 27811: prepareRemoval prepares no borrower custody exactly when a non-excluded entry already refuses removal,
      // and remove() reports that refusal before it needs custody. Inspection returns the same refusal, so its caller
      // sees what removal would say; a refused removal inspects no borrowers, so the list is empty beside that refusal.
      // Missing custody without such a refusal is an impossible state and stays loud.
      const refused = prepared.notCompared.some((entry) => entry.reason !== "excluded")
      if (prepared.rehome === undefined && !refused) {
        throw new Error(`worktree ${path} has no prepared borrower custody`)
      }
      return {
        borrowers: prepared.rehome === undefined ? [] : prepared.rehome.inspect(),
        moduleStores: prepared.stores,
        records: status.records,
        notCompared: [...prepared.notCompared, ...status.notCompared],
        consultedRepositories: status.consultedRepositories,
        uninitializedSubmodules: status.uninitializedSubmodules,
      }
    },
    async inspectComponentCustodyFreshness(
      path: string,
      policy: ComponentCustodyPolicy,
      inspectOptions: Readonly<{ excludedSubmodules?: readonly string[]; component?: string }> = {},
    ): Promise<ComponentCustodyFreshness> {
      const proofDeadline = Date.now() + timeouts.cleanup
      const adapters = selectedCustodyAdapters(
        options.gitProcess,
        repo,
        options.env ?? process.env,
        options.signal,
        proofDeadline,
      )
      try {
        await assertRemovalRoot(path)
        const gitDir = realpathSync(await git.text(path, ["--no-optional-locks", "rev-parse", "--absolute-git-dir"]))
        const census = await buildComponentCensus({
          git,
          adapters,
          repo,
          worktree: path,
          rootGitDir: gitDir,
          excludedSubmodules: inspectOptions.excludedSubmodules ?? [],
          policy,
          deadline: proofDeadline,
        })
        const freshness = await computeCustodyFreshness({
          adapters,
          census,
          policy,
          deadline: proofDeadline,
        })
        if (freshness.status !== "ok") return freshness
        const scoped = scopeCustodyFreshnessMaterial(
          freshness.material,
          census.witnessStoreByComponent,
          inspectOptions.component,
        )
        if (scoped.status !== "ok") return scoped
        return { status: "ok", fingerprint: scoped.fingerprint }
      } catch (error) {
        return {
          status: "unknown",
          source: "recursive component census",
          detail: error instanceof Error ? error.message : String(error),
        }
      }
    },
    /** Retention records the destroyed checkout's own HEAD in its proof. Pool/candidate inputs are retained
     * by queue change records; a caller passing a seat environment must first hold its HEAD on its real
     * branch or in its owning tool's durable custody. Recovery never creates an archive ref. */
    async recoverDestroyed(
      path: string,
      operation = `recover destroyed worktree ${path}`,
      retention?: WorktreeRetention,
    ): Promise<void> {
      await mutate(operation, async () => {
        try {
          await lstat(join(path, ".git"))
          throw new Error(`yrd: refusing destroyed-worktree recovery while '${path}/.git' still exists`)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
        if (!(await inspectWorktree(git, repo, path)).registered) return
        const common = realpathSync(await git.text(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))
        let directory: string | undefined
        const unreadable: string[] = []
        for (const candidate of removalBorrowers(common, common)) {
          const pointerPath = join(candidate.adminDir, "gitdir")
          let pointer: string
          try {
            pointer = (await readFile(pointerPath, "utf8")).trim()
          } catch (error) {
            unreadable.push(`${pointerPath}: ${String(error)}`)
            continue
          }
          if (resolve(dirname(pointer)) === resolve(path)) {
            directory = candidate.adminDir
            break
          }
        }
        if (directory === undefined) {
          throw new Error(
            `registered destroyed worktree '${path}' has no administration identity${unreadable.length === 0 ? "" : `; unreadable administration pointers: ${unreadable.join("; ")}`}`,
          )
        }
        const writerLeases = acquireRemovalWriterLeases(directory)
        let releasedHold: { head: string; pointer: string; body: Uint8Array } | undefined
        try {
          if (retention === undefined) {
            // Keep the same value inspection; unresolved value preserves the registration and all its stores.
            preserveModuleStoreValueBeforeDelete(inspectDestroyedModuleStores(directory).stores)
            rehomeBorrowers(common, directory, join(directory, "modules"))
          } else {
            const identity = await inspectWorktree(git, repo, path)
            const pointer = await readFile(join(directory, "gitdir"), "utf8")
            const lock = identity.locked === undefined ? undefined : await readFile(join(directory, "locked"))
            const head = await git.text(repo, ["--git-dir", directory, "rev-parse", "--verify", "HEAD^{commit}"])
            await retainWorktreeModules(
              git,
              repo,
              path,
              retention,
              (repository, target) => inspectWorktree(git, repository, target),
              writerLeases.proof,
              writerLeases.created,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              { gitDir: directory, common, head },
            )
            const current = await inspectWorktree(git, repo, path)
            if (
              !current.registered ||
              current.locked !== identity.locked ||
              (await readFile(join(directory, "gitdir"), "utf8")) !== pointer ||
              (await git.text(repo, ["--git-dir", directory, "rev-parse", "--verify", "HEAD^{commit}"])) !== head ||
              (lock !== undefined && !lock.equals(await readFile(join(directory, "locked"))))
            ) {
              throw new Error(
                `destroyed worktree ${path} identity or hold changed during retention; registration preserved`,
              )
            }
            try {
              lstatSync(path)
              throw new Error(
                `destroyed worktree ${path} checkout reappeared during retention; checkout and registration preserved`,
              )
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
            }
            if (lock !== undefined) {
              releasedHold = { head, pointer, body: lock }
              await unlockWorktree(git, repo, path)
            }
          }
          await git.run(repo, ["worktree", "remove", "--force", path], false, timeouts.cleanup)
          if ((await inspectWorktree(git, repo, path)).registered) {
            throw new Error(`yrd: destroyed worktree '${path}' survived explicit recovery`)
          }
        } catch (error) {
          if (releasedHold !== undefined) {
            try {
              const current = await inspectWorktree(git, repo, path)
              if (
                current.registered &&
                current.head === releasedHold.head &&
                (await readFile(join(directory, "gitdir"), "utf8")) === releasedHold.pointer
              ) {
                try {
                  // Restore the captured hold atomically; a replacement holder wins, never gets overwritten.
                  await writeFile(join(directory, "locked"), releasedHold.body, { flag: "wx" })
                } catch (restoreError) {
                  if ((restoreError as NodeJS.ErrnoException).code !== "EEXIST") throw restoreError
                  // EEXIST proves another hold is already present; preserve it and still report removal failure.
                }
              }
            } catch (restoreError) {
              throw writerLeases.refusal(
                new Error(`${String(error)}; original hold restoration failed: ${String(restoreError)}`, {
                  cause: error,
                }),
              )
            }
          }
          throw writerLeases.refusal(error)
        } finally {
          writerLeases.release()
        }
      })
    },
  })
}

async function inspectWorktree(git: Git, repo: string, path: string): Promise<WorktreeInspection> {
  const row = (await listWorktrees(git, repo)).find((entry) => entry.path === resolve(path))
  if (row === undefined) return { registered: false }
  const { path: _path, branch: _branch, ...fields } = row
  return { registered: true, ...fields }
}

function parseRegisteredWorktrees(output: string): RegisteredWorktree[] {
  const rows: RegisteredWorktree[] = []
  for (const record of output.split("\0\0")) {
    if (record === "") continue
    const fields = record.split("\0").filter((field) => field !== "")
    const worktree = fields.find((field) => field.startsWith("worktree "))
    if (worktree === undefined || worktree === "worktree ") {
      throw new Error("git worktree list --porcelain -z returned a non-empty record without a worktree path")
    }
    const head = fields.find((field) => field.startsWith("HEAD "))?.slice("HEAD ".length)
    const branch = fields.find((field) => field.startsWith("branch "))?.slice("branch ".length)
    const locked = fields.find((field) => field === "locked" || field.startsWith("locked "))
    rows.push({
      path: resolve(worktree.slice("worktree ".length)),
      ...(head === undefined ? {} : { head }),
      ...(branch === undefined ? {} : { branch }),
      detached: fields.includes("detached"),
      ...(locked === undefined ? {} : { locked: locked === "locked" ? "" : locked.slice("locked ".length) }),
    })
  }
  return rows
}

async function listWorktrees(git: Git, repo: string): Promise<RegisteredWorktree[]> {
  const listed = await git.run(repo, ["worktree", "list", "--porcelain", "-z"])
  return parseRegisteredWorktrees(listed.stdout)
}

export type GitWorktreeStore = Awaited<ReturnType<typeof createGitWorktreeStore>>

async function unlockWorktree(git: Git, repo: string, path: string): Promise<void> {
  const result = await git.run(repo, ["worktree", "unlock", path], true)
  if (result.code !== 0 && !/not locked/iu.test(result.stderr)) {
    throw new Error(result.stderr.trim() || `could not unlock worktree '${path}'`)
  }
}

function withHookPolicy(args: readonly string[], policy: WorktreeHookPolicy | undefined): string[] {
  return policy === "quarantine" ? ["-c", "core.hooksPath=/dev/null", ...args] : [...args]
}

/**
 * The private-store custody reader belongs to the same public surface as the removal it guards, so a caller
 * that removes a worktree WITHOUT the git-super primitive (a plain `rmSync`, a bare `git worktree prune`, the
 * `yrd env close` refusal, 27058) reaches the ONE implementation rather than writing a second one beside it.
 */
export {
  assertNoPrivateStore,
  PrivateStoreRefusalError,
  type PrivateStoreCustody,
  type PrivateStoreRefusal,
} from "./worktree-removal.ts"
