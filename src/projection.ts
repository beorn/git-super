import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { isStrictlyInside, safeRemove } from "removely"
import { runGit, tryGit } from "./git.ts"
import { superStatus } from "./status.ts"

const SCHEMA = "git-super/private-git-metadata-projection/1" as const
const MANIFEST = "projection.json"

export type PrivateGitProjectionMount = Readonly<{
  kind: "private-git-directory" | "borrowed-objects" | "git-file-overlay"
  source: string
  target: string
  readOnly: boolean
}>

type PrivateGitProjectedRepositoryBase = Readonly<{
  relativePath: string
  worktree: string
  privateGitDirectory: string
  sourceObjectDirectory: string
}>

export type PrivateGitProjectedRepository = PrivateGitProjectedRepositoryBase &
  (Readonly<{ gitEntryKind: "file"; gitFile: string }> | Readonly<{ gitEntryKind: "directory" }>)

export type PrivateGitPreservedRef = Readonly<{
  relativePath: string
  sourceRef: string
  preservedRef: string
  sha: string
}>

export type PrivateGitProjectionPreservation = Readonly<{
  preservedAt: string
  refNamespace: string
  refs: readonly PrivateGitPreservedRef[]
}>

export type PrivateGitMetadataProjection = Readonly<{
  schema: typeof SCHEMA
  storageRoot: string
  worktree: string
  repositories: readonly PrivateGitProjectedRepository[]
  mounts: readonly PrivateGitProjectionMount[]
  preservation?: PrivateGitProjectionPreservation
}>

export type PreparePrivateGitMetadataProjectionOptions = Readonly<{
  /** Existing checkout whose root and initialized recursive submodules become private writers. */
  worktree: string
  /** New, caller-owned directory beneath an existing state root. */
  storageRoot: string
}>

export type PreservePrivateGitMetadataProjectionOptions = Readonly<{
  storageRoot: string
  /** Full refs namespace, unique to the seat/run, such as refs/hab-preserved/dev-5/run-42. */
  refNamespace: string
}>

export type RetirePrivateGitMetadataProjectionOptions = Readonly<{ storageRoot: string }>

export type PrivateGitProjectionRetirement =
  | Readonly<{ kind: "unchanged"; retiredAt: string }>
  | Readonly<{ kind: "preserved"; retiredAt: string; preservation: PrivateGitProjectionPreservation }>

type PrivateRefSnapshot = Readonly<{
  relativePath: string
  refs: readonly Readonly<{ name: string; sha: string }>[]
  unreferencedCommits: readonly string[]
  indexHash: string
  head: Readonly<{ kind: "symbolic"; ref: string; sha: string }> | Readonly<{ kind: "detached"; sha: string }>
}>

type StoredProjection = PrivateGitMetadataProjection &
  Readonly<{
    initialSnapshot: readonly PrivateRefSnapshot[]
    preservation?: PrivateGitProjectionPreservation & Readonly<{ snapshot: readonly PrivateRefSnapshot[] }>
  }>

/**
 * Build private writable Git metadata for an existing checkout while borrowing
 * only object databases from its host repositories. The returned mount plan is
 * runtime-neutral: callers decide how their sandbox backend expresses it.
 */
export async function preparePrivateGitMetadataProjection(
  options: PreparePrivateGitMetadataProjectionOptions,
): Promise<PrivateGitMetadataProjection> {
  const worktree = await realpath(options.worktree)
  const repository = await realpath(runGit(worktree, ["rev-parse", "--show-toplevel"]).trim())
  if (repository !== worktree) {
    throw new Error(
      `git-super: projection worktree must be a repository root (received ${worktree}; root ${repository})`,
    )
  }

  const storageRoot = await prospectiveStorageRoot(options.storageRoot)
  refuseOverlappingRoots(storageRoot, worktree)
  if (existsSync(storageRoot)) throw new Error(`git-super: projection storage already exists: ${storageRoot}`)

  const consulted = superStatus({ repo: worktree }).consultedRepositories
  const repositories = uniqueRepositories(consulted.map(({ path, root }) => ({ relativePath: path, worktree: root })))

  await mkdir(storageRoot)
  try {
    const projected: PrivateGitProjectedRepository[] = []
    for (const entry of repositories) projected.push(await projectRepository(storageRoot, entry))
    const projection: StoredProjection = {
      schema: SCHEMA,
      storageRoot,
      worktree,
      repositories: projected,
      mounts: projectionMounts(projected),
      initialSnapshot: projected.map(snapshotRepository),
    }
    await writeManifest(projection)
    return projection
  } catch (cause) {
    await safeRemove(storageRoot, {
      within: dirname(storageRoot),
      allowedRoots: [dirname(storageRoot)],
      allowMissing: true,
    })
    throw cause
  }
}

/** Copy every private ref (and detached HEAD) into a caller-owned source namespace. */
export async function preservePrivateGitMetadataProjection(
  options: PreservePrivateGitMetadataProjectionOptions,
): Promise<PrivateGitProjectionPreservation> {
  const projection = await loadStoredProjection(options.storageRoot)
  const refNamespace = normalizedNamespace(options.refNamespace)
  for (const repository of projection.repositories) assertCleanPrivateRepository(repository)
  const snapshot = projection.repositories.map(snapshotRepository)
  const planned = preservationPlan(snapshot, refNamespace)

  for (const ref of planned) {
    const repository = repositoryForPath(projection, ref.relativePath)
    const current = tryGit(repository.worktree, ["rev-parse", "--verify", "--quiet", ref.preservedRef])
    if (current.exitCode === 0 && current.stdout.trim() !== ref.sha) {
      throw new Error(
        `git-super: preservation ref collision at ${ref.preservedRef}; expected ${ref.sha}, found ${current.stdout.trim()}`,
      )
    }
    if (current.exitCode !== 0 && current.exitCode !== 1) {
      throw new Error(`git-super: could not inspect preservation ref ${ref.preservedRef}: ${current.stderr}`)
    }
  }

  for (const ref of planned) {
    const repository = repositoryForPath(projection, ref.relativePath)
    const current = tryGit(repository.worktree, ["rev-parse", "--verify", "--quiet", ref.preservedRef])
    if (current.exitCode === 0) continue
    runGit(repository.worktree, [
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      repository.privateGitDirectory,
      `${ref.sha}:${ref.preservedRef}`,
    ])
  }
  for (const ref of planned) {
    const repository = repositoryForPath(projection, ref.relativePath)
    const preserved = runGit(repository.worktree, ["rev-parse", "--verify", ref.preservedRef]).trim()
    const object = tryGit(repository.worktree, ["cat-file", "-e", ref.sha])
    if (preserved !== ref.sha || object.exitCode !== 0) {
      throw new Error(`git-super: preservation verification failed for ${ref.preservedRef} at ${ref.sha}`)
    }
  }

  const preservation: PrivateGitProjectionPreservation = {
    preservedAt: new Date().toISOString(),
    refNamespace,
    refs: planned,
  }
  await writeManifest({ ...projection, preservation: { ...preservation, snapshot } })
  return preservation
}

/** Retire only unchanged metadata or metadata whose refs, commits, and index match preserved evidence. */
export async function retirePrivateGitMetadataProjection(
  options: RetirePrivateGitMetadataProjectionOptions,
): Promise<PrivateGitProjectionRetirement> {
  const projection = await loadStoredProjection(options.storageRoot)
  const current = projection.repositories.map(snapshotRepository)
  if (projection.preservation === undefined) {
    if (JSON.stringify(current) !== JSON.stringify(projection.initialSnapshot)) {
      throw new Error(`git-super: projection retirement requires preservation evidence: ${projection.storageRoot}`)
    }
    await removeProjection(projection.storageRoot)
    return { kind: "unchanged", retiredAt: new Date().toISOString() }
  }
  if (JSON.stringify(current) !== JSON.stringify(projection.preservation.snapshot)) {
    throw new Error(`git-super: private refs changed after preservation; preserve again before retirement`)
  }
  await removeProjection(projection.storageRoot)
  return {
    kind: "preserved",
    retiredAt: new Date().toISOString(),
    preservation: publicPreservation(projection.preservation),
  }
}

/** Reopen a durable projection after a caller restart, with its mount plan revalidated. */
export async function loadPrivateGitMetadataProjection(storageRoot: string): Promise<PrivateGitMetadataProjection> {
  return loadStoredProjection(storageRoot)
}

async function projectRepository(
  storageRoot: string,
  entry: Readonly<{ relativePath: string; worktree: string }>,
): Promise<PrivateGitProjectedRepository> {
  const worktree = await realpath(entry.worktree)
  const gitEntry = await lstat(join(worktree, ".git"))
  const gitEntryKind = gitEntry.isFile() ? "file" : gitEntry.isDirectory() ? "directory" : undefined
  if (gitEntryKind === undefined) {
    throw new Error(`git-super: checkout .git entry must be a file or directory: ${join(worktree, ".git")}`)
  }
  const identifier = repositoryIdentifier(entry.relativePath)
  const privateGitDirectory = join(storageRoot, "repositories", `${identifier}.git`)
  await mkdir(dirname(privateGitDirectory), { recursive: true })
  runGit(storageRoot, ["init", "--bare", "--quiet", privateGitDirectory])

  const sourceObjects = runGit(worktree, ["rev-parse", "--path-format=absolute", "--git-path", "objects"]).trim()
  const sourceObjectDirectory = await realpath(sourceObjects)
  await mkdir(join(privateGitDirectory, "objects", "info"), { recursive: true })
  await writeFile(join(privateGitDirectory, "objects", "info", "alternates"), `${sourceObjectDirectory}\n`)

  configurePrivateRepository(worktree, privateGitDirectory)
  initializePrivateHead(worktree, privateGitDirectory)
  privateRun(worktree, privateGitDirectory, ["read-tree", "HEAD"])
  if (gitEntryKind === "directory") {
    return { relativePath: entry.relativePath, worktree, privateGitDirectory, sourceObjectDirectory, gitEntryKind }
  }
  const gitFile = join(storageRoot, "overlays", `${identifier}.git`)
  await mkdir(dirname(gitFile), { recursive: true })
  await writeFile(gitFile, `gitdir: ${privateGitDirectory}\n`)
  return {
    relativePath: entry.relativePath,
    worktree,
    privateGitDirectory,
    sourceObjectDirectory,
    gitEntryKind,
    gitFile,
  }
}

function configurePrivateRepository(worktree: string, gitDirectory: string): void {
  for (const [key, value] of [
    ["core.bare", "false"],
    ["core.worktree", worktree],
    ["core.hooksPath", "/dev/null"],
    ["core.logAllRefUpdates", "true"],
    ["submodule.recurse", "false"],
  ] as const) {
    privateRun(worktree, gitDirectory, ["config", "--local", key, value])
  }

  for (const key of [
    "core.filemode",
    "core.ignorecase",
    "core.symlinks",
    "core.autocrlf",
    "core.eol",
    "user.name",
    "user.email",
    "user.useConfigOnly",
  ]) {
    copyConfigValues(worktree, gitDirectory, key)
  }
  for (const remote of lines(runGit(worktree, ["remote"]))) {
    for (const suffix of ["url", "pushurl", "fetch"])
      copyConfigValues(worktree, gitDirectory, `remote.${remote}.${suffix}`)
  }
  const symbolic = tryGit(worktree, ["symbolic-ref", "-q", "HEAD"])
  if (symbolic.exitCode === 0) {
    const branch = symbolic.stdout.trim().replace(/^refs\/heads\//u, "")
    for (const suffix of ["remote", "merge", "pushRemote", "rebase"]) {
      copyConfigValues(worktree, gitDirectory, `branch.${branch}.${suffix}`)
    }
  }
}

function copyConfigValues(worktree: string, gitDirectory: string, key: string): void {
  const result = tryGit(worktree, ["config", "--local", "--get-all", key])
  if (result.exitCode === 1) return
  if (result.exitCode !== 0) throw new Error(`git-super: could not read local config ${key}: ${result.stderr}`)
  for (const value of lines(result.stdout))
    privateRun(worktree, gitDirectory, ["config", "--local", "--add", key, value])
}

function initializePrivateHead(worktree: string, gitDirectory: string): void {
  const sha = runGit(worktree, ["rev-parse", "HEAD"]).trim()
  const symbolic = tryGit(worktree, ["symbolic-ref", "-q", "HEAD"])
  if (symbolic.exitCode === 0) {
    const ref = symbolic.stdout.trim()
    privateRun(worktree, gitDirectory, ["symbolic-ref", "HEAD", ref])
    privateRun(worktree, gitDirectory, ["update-ref", ref, sha])
    return
  }
  if (symbolic.exitCode !== 1) throw new Error(`git-super: could not inspect HEAD in ${worktree}: ${symbolic.stderr}`)
  privateRun(worktree, gitDirectory, ["update-ref", "--no-deref", "HEAD", sha])
}

function privateRun(worktree: string, gitDirectory: string, args: readonly string[]): string {
  return runGit(worktree, ["--git-dir", gitDirectory, "--work-tree", worktree, ...args])
}

function privateTry(worktree: string, gitDirectory: string, args: readonly string[]) {
  return tryGit(worktree, ["--git-dir", gitDirectory, "--work-tree", worktree, ...args])
}

function snapshotRepository(repository: PrivateGitProjectedRepository): PrivateRefSnapshot {
  const refs = lines(
    privateRun(repository.worktree, repository.privateGitDirectory, [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs",
    ]),
  ).map((line) => {
    const separator = line.indexOf(" ")
    if (separator <= 0) throw new Error(`git-super: malformed private ref row in ${repository.relativePath}: ${line}`)
    return { name: line.slice(0, separator), sha: line.slice(separator + 1) }
  })
  const unreferencedCommits = lines(
    privateRun(repository.worktree, repository.privateGitDirectory, [
      "fsck",
      "--unreachable",
      "--no-reflogs",
      "--no-progress",
      "--no-full",
    ]),
  )
    .flatMap((line) => /^unreachable commit ([0-9a-f]+)$/u.exec(line)?.[1] ?? [])
    .toSorted()
  const indexHash = createHash("sha256")
    .update(privateRun(repository.worktree, repository.privateGitDirectory, ["ls-files", "--stage", "-z"]))
    .digest("hex")
  const sha = privateRun(repository.worktree, repository.privateGitDirectory, ["rev-parse", "HEAD"]).trim()
  const symbolic = privateTry(repository.worktree, repository.privateGitDirectory, ["symbolic-ref", "-q", "HEAD"])
  if (symbolic.exitCode !== 0 && symbolic.exitCode !== 1) {
    throw new Error(`git-super: could not inspect private HEAD in ${repository.relativePath}: ${symbolic.stderr}`)
  }
  const head =
    symbolic.exitCode === 0
      ? ({ kind: "symbolic", ref: symbolic.stdout.trim(), sha } as const)
      : ({ kind: "detached", sha } as const)
  return { relativePath: repository.relativePath, refs, unreferencedCommits, indexHash, head }
}

function assertCleanPrivateRepository(repository: PrivateGitProjectedRepository): void {
  const status = privateRun(repository.worktree, repository.privateGitDirectory, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ])
  if (status !== "") {
    throw new Error(
      `git-super: cannot preserve dirty private Git state in ${repository.relativePath}; commit or remove its changes first`,
    )
  }
}

function preservationPlan(snapshot: readonly PrivateRefSnapshot[], refNamespace: string): PrivateGitPreservedRef[] {
  const planned: PrivateGitPreservedRef[] = []
  for (const repository of snapshot) {
    const repositoryKey = repositoryIdentifier(repository.relativePath)
    const refShas = new Set<string>()
    for (const ref of repository.refs) {
      refShas.add(ref.sha)
      planned.push({
        relativePath: repository.relativePath,
        sourceRef: ref.name,
        preservedRef: `${refNamespace}/${repositoryKey}/${ref.name.slice("refs/".length)}`,
        sha: ref.sha,
      })
    }
    if (repository.head.kind === "detached") {
      planned.push({
        relativePath: repository.relativePath,
        sourceRef: "HEAD",
        preservedRef: `${refNamespace}/${repositoryKey}/HEAD`,
        sha: repository.head.sha,
      })
      refShas.add(repository.head.sha)
    }
    for (const sha of repository.unreferencedCommits) {
      if (refShas.has(sha)) continue
      planned.push({
        relativePath: repository.relativePath,
        sourceRef: `unreferenced:${sha}`,
        preservedRef: `${refNamespace}/${repositoryKey}/unreferenced/${sha}`,
        sha,
      })
    }
  }
  return planned
}

function projectionMounts(repositories: readonly PrivateGitProjectedRepository[]): PrivateGitProjectionMount[] {
  const borrowed = new Map<string, PrivateGitProjectionMount>()
  for (const repository of repositories) {
    borrowed.set(repository.sourceObjectDirectory, {
      kind: "borrowed-objects",
      source: repository.sourceObjectDirectory,
      target: repository.sourceObjectDirectory,
      readOnly: true,
    })
  }
  return [
    ...repositories.map(
      (repository): PrivateGitProjectionMount => ({
        kind: "private-git-directory",
        source: repository.privateGitDirectory,
        target:
          repository.gitEntryKind === "directory" ? join(repository.worktree, ".git") : repository.privateGitDirectory,
        readOnly: false,
      }),
    ),
    ...borrowed.values(),
    ...repositories.flatMap((repository): PrivateGitProjectionMount[] =>
      repository.gitEntryKind === "file"
        ? [
            {
              kind: "git-file-overlay",
              source: repository.gitFile,
              target: join(repository.worktree, ".git"),
              readOnly: true,
            },
          ]
        : [],
    ),
  ]
}

async function prospectiveStorageRoot(path: string): Promise<string> {
  const absolute = resolve(path)
  const parent = await realpath(dirname(absolute))
  return join(parent, basename(absolute))
}

function refuseOverlappingRoots(storageRoot: string, worktree: string): void {
  if (storageRoot === worktree || isStrictlyInside(storageRoot, worktree) || isStrictlyInside(worktree, storageRoot)) {
    throw new Error(`git-super: projection storage and worktree must not overlap (${storageRoot}; ${worktree})`)
  }
}

function uniqueRepositories(
  repositories: readonly Readonly<{ relativePath: string; worktree: string }>[],
): Array<Readonly<{ relativePath: string; worktree: string }>> {
  const unique = new Map<string, Readonly<{ relativePath: string; worktree: string }>>()
  for (const repository of repositories) unique.set(repository.worktree, repository)
  return [...unique.values()]
}

function repositoryIdentifier(relativePath: string): string {
  const label =
    relativePath === "."
      ? "root"
      : relativePath
          .split(/[\\/]/u)
          .at(-1)
          ?.replace(/[^a-z0-9._-]/giu, "-") || "repo"
  const digest = createHash("sha256").update(relativePath).digest("hex").slice(0, 12)
  return `${label}-${digest}`
}

function normalizedNamespace(namespace: string): string {
  const value = namespace.replace(/\/+$/u, "")
  if (!value.startsWith("refs/") || tryGit(process.cwd(), ["check-ref-format", `${value}/probe`]).exitCode !== 0) {
    throw new Error(`git-super: invalid preservation ref namespace: ${namespace}`)
  }
  return value
}

function repositoryForPath(projection: StoredProjection, relativePath: string): PrivateGitProjectedRepository {
  const repository = projection.repositories.find((entry) => entry.relativePath === relativePath)
  if (repository === undefined) throw new Error(`git-super: projection repository missing: ${relativePath}`)
  return repository
}

async function writeManifest(projection: StoredProjection): Promise<void> {
  const manifest = join(projection.storageRoot, MANIFEST)
  const temporary = join(projection.storageRoot, `.${MANIFEST}.${process.pid}.tmp`)
  await writeFile(temporary, `${JSON.stringify(projection, null, 2)}\n`)
  await rename(temporary, manifest)
}

async function loadStoredProjection(storageRoot: string): Promise<StoredProjection> {
  const root = await realpath(storageRoot)
  const value: unknown = JSON.parse(await readFile(join(root, MANIFEST), "utf8"))
  if (!isRecord(value) || value.schema !== SCHEMA || value.storageRoot !== root || !Array.isArray(value.repositories)) {
    throw new Error(`git-super: invalid private Git projection manifest: ${join(root, MANIFEST)}`)
  }
  const projection = value as StoredProjection
  if (!isAbsolute(projection.worktree) || projection.repositories.length === 0) {
    throw new Error(`git-super: invalid private Git projection roots: ${join(root, MANIFEST)}`)
  }
  if (!Array.isArray(projection.initialSnapshot)) {
    throw new Error(`git-super: projection manifest lacks its initial ref snapshot: ${join(root, MANIFEST)}`)
  }
  for (const repository of projection.repositories) {
    if (
      !isAbsolute(repository.worktree) ||
      !isAbsolute(repository.sourceObjectDirectory) ||
      !isStrictlyInside(resolve(repository.privateGitDirectory), root) ||
      (repository.gitEntryKind !== "file" && repository.gitEntryKind !== "directory") ||
      (repository.gitEntryKind === "file" && !isStrictlyInside(resolve(repository.gitFile), root))
    ) {
      throw new Error(`git-super: projection repository escapes storage root: ${repository.relativePath}`)
    }
    if (repository.gitEntryKind === "file") {
      const expectedGitFile = `gitdir: ${repository.privateGitDirectory}\n`
      if ((await readFile(repository.gitFile, "utf8")) !== expectedGitFile) {
        throw new Error(`git-super: projection Git file changed: ${repository.gitFile}`)
      }
    }
  }
  const expectedMounts = projectionMounts(projection.repositories)
  if (!Array.isArray(projection.mounts) || JSON.stringify(projection.mounts) !== JSON.stringify(expectedMounts)) {
    throw new Error(`git-super: projection mount plan changed: ${join(root, MANIFEST)}`)
  }
  if (projection.preservation !== undefined && !Array.isArray(projection.preservation.snapshot)) {
    throw new Error(`git-super: invalid projection preservation evidence: ${join(root, MANIFEST)}`)
  }
  return projection
}

async function removeProjection(storageRoot: string): Promise<void> {
  await safeRemove(storageRoot, {
    within: dirname(storageRoot),
    allowedRoots: [dirname(storageRoot)],
  })
}

function publicPreservation(
  preservation: PrivateGitProjectionPreservation & Readonly<{ snapshot: readonly PrivateRefSnapshot[] }>,
): PrivateGitProjectionPreservation {
  return {
    preservedAt: preservation.preservedAt,
    refNamespace: preservation.refNamespace,
    refs: preservation.refs,
  }
}

function lines(value: string): string[] {
  return value.split(/\r?\n/u).filter(Boolean)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
