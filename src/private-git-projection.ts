import { lstat, mkdir, realpath, writeFile } from "node:fs/promises"
import { rmSync, type Stats } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { alternatesLineage } from "./alternates.ts"
import { commonDirectory, readMetadataFile } from "./git-metadata.ts"
import { readPrivateSubmodulePaths } from "./commit-graph.ts"
import { cleanGitEnvironment, validateExcludedSubmodules, withGitEnvironment } from "./git.ts"
import { createLocalGitProcess, type GitProcess } from "./process.ts"
import { materializeSubmodules } from "./submodules.ts"
import { ensureCommitObject, pinRef } from "./objects.ts"
import { createExclusive, type WriterLock } from "./exclusive.ts"
import { safeStorePath } from "./submodule-prepare.ts"
import { createGit, createGitWorktreeStore } from "./worktree.ts"
import {
  acquireRemovalWriterLeases,
  metadataFileDigest,
  retainWorktreeModules,
  type WorktreeRemovalProof,
} from "./worktree-removal.ts"
import type { NotCompared } from "./diff.ts"
import type { GitSuperResult } from "./result.ts"

export type PrivateGitProjection = Readonly<{
  checkout: string
  base: string
  branch: string
  createdAt: string
  repositories: readonly Readonly<{
    path: string
    checkout: string
    gitDirectory: string
    head: string
    configurationSha256: string
  }>[]
  mounts: readonly Readonly<{ source: string; target: string; mode: "ro" | "rw" }>[]
  excluded: readonly NotCompared[]
}>

/** Neutral host attestation; GitSuper validates binding, while the sandbox owns stop truth. */
export type PrivateGitStopCertificate = Readonly<{
  schema: "hab-sandbox/stop-certificate/1"
  subject: string
  container: string
  projection: Readonly<Pick<PrivateGitProjection, "checkout" | "base" | "branch" | "createdAt">>
  certifiedAt: string
  certifier: string
}>

function validateStopCertificate(projection: PrivateGitProjection, certificate: unknown): void {
  if (typeof projection.createdAt !== "string" || !Number.isFinite(Date.parse(projection.createdAt))) {
    throw new Error("record predates createdAt; re-create the projection")
  }
  if (typeof certificate !== "object" || certificate === null) throw new Error("missing unit stop certificate")
  const fields = certificate as Record<string, unknown>
  if (!("schema" in certificate) || certificate.schema !== "hab-sandbox/stop-certificate/1") {
    throw new Error("invalid unit stop certificate schema")
  }
  for (const field of ["subject", "container", "certifier", "certifiedAt"] as const) {
    const value = fields[field]
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`unit stop certificate has missing or empty ${field}`)
    }
  }
  if (!("projection" in certificate) || typeof certificate.projection !== "object" || certificate.projection === null) {
    throw new Error("unit stop certificate has missing projection identity")
  }
  const identity = certificate.projection as Record<string, unknown>
  for (const field of ["checkout", "base", "branch", "createdAt"] as const) {
    if (identity[field] !== projection[field]) {
      throw new Error(`unit stop certificate projection mismatch: ${field}`)
    }
  }
  if (!("certifiedAt" in certificate) || typeof certificate.certifiedAt !== "string") {
    throw new Error("unit stop certificate has missing certifiedAt")
  }
  const certifiedAt = Date.parse(certificate.certifiedAt)
  if (!Number.isFinite(certifiedAt) || certifiedAt < Date.parse(projection.createdAt)) {
    throw new Error("unit stop certificate predates projection createdAt")
  }
}

export type PrivateGitProjectionOptions = Readonly<{
  sourceCheckout: string
  commit: string
  branch: string
  destination: string
  excludedSubmodules: readonly string[]
  git?: GitProcess
  report?: (result: PrivateGitProjectionResult) => void
}>
export type PrivateGitProjectionResult = GitSuperResult &
  Readonly<{
    projection?: PrivateGitProjection
    retainedPaths: readonly string[]
  }>

export type PrivateGitRetentionResult = GitSuperResult &
  Readonly<{ retainedPaths: readonly string[]; manifest?: string }>

async function preserveProjection(
  projection: PrivateGitProjection,
  retentionRoot: string,
  retire: boolean,
  stopCertificate?: PrivateGitStopCertificate,
): Promise<PrivateGitRetentionResult> {
  const retainedPaths: string[] = []
  let leases: ReturnType<typeof acquireRemovalWriterLeases> | undefined
  try {
    if (retire) validateStopCertificate(projection, stopCertificate)
    const checkout = await realpath(projection.checkout)
    if (checkout !== projection.checkout || projection.repositories.length === 0) {
      throw new Error("invalid private projection checkout or repository record")
    }
    const rootGit = join(checkout, ".git")
    if ((await metadata(checkout)) !== rootGit) throw new Error(`private root metadata changed at ${checkout}`)
    const allowedObjects = new Set(
      projection.mounts
        .filter((mount) => mount.mode === "ro" && mount.source === mount.target)
        .map((mount) => mount.source),
    )
    for (const repository of projection.repositories) {
      validateExcludedSubmodules(repository.path === "" ? [] : [repository.path])
      if (
        repository.checkout !== join(checkout, repository.path) ||
        (!repository.gitDirectory.startsWith(`${rootGit}${sep}`) && repository.gitDirectory !== rootGit)
      ) {
        throw new Error(`private repository escapes its recorded checkout: ${repository.checkout}`)
      }
      if ((await metadata(repository.checkout)) !== repository.gitDirectory) {
        throw new Error(`private metadata pointer changed at ${repository.checkout}`)
      }
      const configuration = join(repository.gitDirectory, "config")
      if (
        (await lstat(configuration)).isSymbolicLink() ||
        !/^[0-9a-f]{64}$/u.test(repository.configurationSha256) ||
        metadataFileDigest(configuration) !== repository.configurationSha256
      ) {
        throw new Error(
          `private Git configuration changed or is unknown: ${configuration}; preserve the checkout and inspect its configuration before custody`,
        )
      }
      const objects = join(repository.gitDirectory, "objects")
      await alternatesLineage([objects], "", { allowedObjects: new Set([...allowedObjects, objects]) })
    }
    leases = acquireRemovalWriterLeases(rootGit, (path) => retainedPaths.push(path))
    const heldLeases = leases
    const environment = {
      ...cleanGitEnvironment(),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_NO_LAZY_FETCH: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
    }
    const transport = createLocalGitProcess(environment)
    const process: GitProcess = {
      run: (request) =>
        transport.run({
          ...request,
          env: environment,
          args: [
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "protocol.allow=never",
            ...request.args,
          ],
        }),
    }
    const git = createGit(process, environment, 30_000)
    const excluded = projection.excluded.map((entry) => entry.path)
    const proof = await withGitEnvironment(environment, () =>
      retainWorktreeModules(
        git,
        checkout,
        checkout,
        { root: retentionRoot, report: (_proof: WorktreeRemovalProof) => {} },
        (repository, path) =>
          createGitWorktreeStore({ repo: repository, gitProcess: process, env: environment }).inspect(path),
        heldLeases.proof,
        heldLeases.created,
        undefined,
        excluded,
        projection.excluded,
        projection,
        (path) => retainedPaths.push(path),
        retire
          ? () => {
              validateStopCertificate(projection, stopCertificate)
              rmSync(checkout, { recursive: true })
            }
          : undefined,
      ),
    )
    return {
      state: "updated",
      partial: false,
      repositories: [],
      retainedPaths: retire
        ? retainedPaths.filter((path) => path !== checkout && !path.startsWith(`${checkout}${sep}`))
        : retainedPaths,
      manifest: proof.manifest,
    }
  } catch (error) {
    return {
      state: "failed",
      partial: retainedPaths.length > 0,
      repositories: [],
      retainedPaths,
      detail: {
        code: "private-projection-retention-failed",
        phase: retire ? "retire" : "retain",
        message: String(error),
        paths: [projection.checkout, ...retainedPaths],
      },
    }
  } finally {
    leases?.release()
  }
}

/** Preserve the private root, every child store and unreferenced objects under existing manifest custody. */
export function retainPrivateGitProjection(
  projection: PrivateGitProjection,
  retentionRoot: string,
): Promise<PrivateGitRetentionResult> {
  return preserveProjection(projection, retentionRoot, false)
}

/** Retire after explicit sandbox stop attestation and the custody owner's final manifest equality. */
export function retirePrivateGitProjection(
  projection: PrivateGitProjection,
  retentionRoot: string,
  stopCertificate?: PrivateGitStopCertificate,
): Promise<PrivateGitRetentionResult> {
  return preserveProjection(projection, retentionRoot, true, stopCertificate)
}

async function metadata(
  checkout: string,
  inspect?: (path: string, stat: Stats | undefined, bytes: Buffer | undefined) => void,
): Promise<string> {
  const pointer = join(checkout, ".git")
  const stat = await lstat(pointer)
  if (stat.isDirectory()) {
    inspect?.(pointer, stat, undefined)
    return realpath(pointer)
  }
  if (!stat.isFile()) throw new Error(`unsupported Git metadata pointer: ${pointer}`)
  const match = /^gitdir: ([^\r\n]+)\r?\n?$/u.exec(await readMetadataFile(pointer, stat, inspect))
  if (match?.[1] === undefined) throw new Error(`invalid Git metadata pointer: ${pointer}`)
  return realpath(resolve(checkout, match[1]))
}

/** Make private metadata while the existing materializer owns recursive frozen declaration selection. */
export async function projectPrivateGitWorktree(
  options: PrivateGitProjectionOptions,
): Promise<PrivateGitProjectionResult> {
  const retainedPaths: string[] = []
  const repositories: Array<{ path: string; checkout: string; gitDirectory: string; head: string }> = []
  const stores = new Set<string>()
  const objectOwners = new Map<string, string>()
  const publicDirectories = new Map<string, string>()
  const destination = resolve(options.destination)
  const environment = {
    ...cleanGitEnvironment(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
  }
  const transport = options.git ?? createLocalGitProcess(environment)
  const git: GitProcess = {
    run: (request) =>
      transport.run({
        ...request,
        env: environment,
        args: [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "protocol.allow=never",
          ...request.args,
        ],
      }),
  }
  const run = async (repo: string, args: readonly string[]): Promise<string> => {
    const result = await git.run({ repo, args })
    if (result.code !== 0 || result.timedOut || result.failure !== undefined) {
      throw new Error(`private projection Git failed in ${repo}: ${args.join(" ")}\n${result.failure ?? result.stderr}`)
    }
    return result.stdout.trim()
  }
  try {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(options.commit)) {
      throw new Error("projection requires a full commit object ID")
    }
    if (!Array.isArray(options.excludedSubmodules)) throw new Error("projection requires frozen excludedSubmodules")
    validateExcludedSubmodules(options.excludedSubmodules)
    if (options.branch === "" || options.branch.startsWith("-") || /[\u0000-\u0020\u007f]/u.test(options.branch)) {
      throw new Error(`invalid new projection branch: ${options.branch}`)
    }
    if ((await realpath(dirname(destination))) !== dirname(destination)) {
      throw new Error(`projection destination has a redirected parent: ${destination}`)
    }
    const source = await realpath(options.sourceCheckout)
    if (destination === source || destination.startsWith(`${source}${sep}`)) {
      throw new Error(`projection destination is inside its source: ${destination}`)
    }
    const prepared = new Map<
      string,
      {
        sourceCheckout: string
        sourceGit: string
        common: string
        objects: string
        publicDirectory: string
        publicCommon: string
        lineage: string[]
        owners: Set<string>
        head: string
      }
    >()
    const privateDirectories = new Map<string, string>([[destination, join(destination, ".git")]])
    const heldLocks = new Map<string, WriterLock>()
    const inputs = new Map<string, { stat: Stats | undefined; bytes: Buffer | undefined }>()
    const sameEntry = (before: Stats | undefined, after: Stats | undefined): boolean =>
      before === undefined
        ? after === undefined
        : after !== undefined &&
          before.dev === after.dev &&
          before.ino === after.ino &&
          before.mode === after.mode &&
          (!before.isFile() ||
            (before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs))
    const inspect = (path: string, stat: Stats | undefined, bytes: Buffer | undefined): void => {
      const previous = inputs.get(path)
      if (
        previous !== undefined &&
        (!sameEntry(previous.stat, stat) ||
          (previous.bytes === undefined ? bytes !== undefined : bytes === undefined || !previous.bytes.equals(bytes)))
      ) {
        throw new Error(`Git metadata identity changed during preparation: ${path}`)
      }
      inputs.set(path, { stat, bytes: bytes === undefined ? undefined : Buffer.from(bytes) })
    }
    const prepareRepository = async (
      checkout: string,
      sourceCheckout: string,
      head: string,
      publicGitDirectory?: string,
    ): Promise<void> => {
      if ((await realpath(sourceCheckout)) !== sourceCheckout) {
        throw new Error(`redirected source checkout metadata: ${sourceCheckout}`)
      }
      const sourceGit = await metadata(sourceCheckout, inspect)
      const common = await commonDirectory(sourceGit, inspect)
      const objects = join(common, "objects")
      const publicDirectory = publicGitDirectory ?? common
      if (!(await lstat(publicDirectory)).isDirectory() || (await realpath(publicDirectory)) !== publicDirectory) {
        throw new Error(`nonphysical declared public metadata: ${publicDirectory}`)
      }
      const publicCommon = await commonDirectory(publicDirectory, inspect)
      for (const directory of new Set([sourceCheckout, sourceGit, common, publicDirectory, publicCommon])) {
        inspect(directory, await lstat(directory), undefined)
      }
      objectOwners.set(objects, common)
      objectOwners.set(join(publicCommon, "objects"), publicCommon)
      publicDirectories.set(checkout, publicDirectory)
      const publicObjects = join(publicDirectory, "objects")
      const lineage = await alternatesLineage([objects], join(checkout, ".git", "objects"), {
        allowedObjects: new Set([...stores, objects, publicObjects]),
        inspect,
      })
      const owners = new Set<string>()
      for (const store of [objects, ...lineage]) {
        const owner = objectOwners.get(store)
        if (owner === undefined) throw new Error(`unproven object-store owner: ${store}`)
        owners.add(owner)
      }
      prepared.set(checkout, {
        sourceCheckout,
        sourceGit,
        common,
        objects,
        publicDirectory,
        publicCommon,
        lineage,
        owners,
        head,
      })
      stores.add(objects)
      for (const lender of lineage) stores.add(lender)
    }
    await prepareRepository(destination, source, options.commit)
    const validateExclusions = async (
      checkout: string,
      head: string,
      excluded: readonly string[],
      metadata: import("./commit-graph.ts").SelectedCommitSubmodules,
    ) => {
      const declared = await readPrivateSubmodulePaths(git, checkout, head)
      const direct = excluded.filter((path) => declared.includes(path))
      const unexpected = excluded.filter(
        (path) => !declared.includes(path) && !metadata.submodules.some((entry) => path.startsWith(`${entry.path}/`)),
      )
      if (
        declared.length !== direct.length ||
        unexpected.length > 0 ||
        declared.some((path) => !excluded.includes(path))
      ) {
        throw new Error(
          `frozen private exclusions disagree at ${checkout}@${head}: declared ${declared.join(", ")}; supplied ${excluded.join(", ")}`,
        )
      }
    }
    const preparation = await materializeSubmodules(
      { run: (repo, args) => git.run({ repo, args }) },
      { worktree: source, excludedSubmodules: options.excludedSubmodules },
      {
        prepareCommit: options.commit,
        validate: async (checkout, head, excluded, metadata) => {
          await validateExclusions(checkout, head, excluded, metadata)
        },
        materialize: async (parent, entry, descend) => {
          const targetParent = join(destination, relative(source, parent))
          const target = join(targetParent, entry.path)
          const publicParent = publicDirectories.get(targetParent)
          const privateParent = privateDirectories.get(targetParent)
          if (publicParent === undefined || privateParent === undefined) {
            throw new Error(`missing prepared metadata parent: ${targetParent}`)
          }
          publicDirectories.set(target, safeStorePath(publicParent, entry.name))
          privateDirectories.set(target, safeStorePath(privateParent, entry.name))
          await prepareRepository(target, join(parent, entry.path), entry.target, publicDirectories.get(target))
          return descend()
        },
      },
    )
    if (preparation.code !== 0) throw new Error(preparation.stderr)
    const createRepository = async <T>(
      checkout: string,
      sourceCheckout: string,
      head: string,
      root: boolean,
      consume: (writerLock: WriterLock) => Promise<T>,
      privateGitDirectory?: string,
    ): Promise<T> => {
      const selected = prepared.get(checkout)
      if (selected === undefined || selected.sourceCheckout !== sourceCheckout || selected.head !== head) {
        throw new Error(`private repository differs from frozen preparation: ${checkout}`)
      }
      const { objects, lineage } = selected
      if (!root) await mkdir(checkout, { recursive: true })
      retainedPaths.push(checkout)
      const gitDirectory = privateGitDirectory ?? join(checkout, ".git")
      const held = heldLocks.get(gitDirectory)
      if (held === undefined) throw new Error(`missing prepared private writer custody: ${gitDirectory}`)
      // The existing lease creates this new metadata directory and owns its first Git initialization.
      return createExclusive(join(gitDirectory, "yrd-worktree-mutations")).run(
        async (writerLock) => {
          if (writerLock === undefined) throw new Error(`private projection lacks issued writer custody: ${checkout}`)
          await run(checkout, ["check-ref-format", "--branch", options.branch])
          await run(checkout, [
            "init",
            "--template=",
            ...(privateGitDirectory === undefined ? [] : ["--separate-git-dir", privateGitDirectory]),
            `--object-format=${head.length === 64 ? "sha256" : "sha1"}`,
            "-b",
            options.branch,
          ])
          await writeFile(
            join(gitDirectory, "objects", "info", "alternates"),
            `${[...lineage, objects].join("\n")}\n`,
            {
              flag: "wx",
            },
          )
          await run(checkout, ["cat-file", "-e", `${head}^{commit}`])
          await run(checkout, ["checkout", "--no-recurse-submodules", "-B", options.branch, head])
          repositories.push({
            path: relative(destination, checkout).split(sep).join("/"),
            checkout,
            gitDirectory,
            head,
          })
          return consume(writerLock)
        },
        { holder: `private projection ${checkout}`, held },
      )
    }
    const execute = async (): Promise<PrivateGitProjectionResult> => {
      const materialized = await createRepository(destination, source, options.commit, true, (writerLock) =>
        materializeSubmodules(
          { run: (repo, args) => git.run({ repo, args }) },
          {
            worktree: destination,
            writerLock,
            referenceWorktree: source,
            excludedSubmodules: options.excludedSubmodules,
          },
          {
            validate: validateExclusions,
            materialize: async (parent, entry, descend) => {
              const checkout = join(parent, entry.path)
              const directory = safeStorePath(await metadata(parent), entry.name)
              await mkdir(dirname(directory), { recursive: true })
              return createRepository(
                checkout,
                join(source, relative(destination, checkout)),
                entry.target,
                false,
                descend,
                directory,
              )
            },
          },
        ),
      )
      if (materialized.code !== 0) throw new Error(materialized.stderr)
      const projection: PrivateGitProjection = {
        checkout: destination,
        base: options.commit,
        branch: options.branch,
        createdAt: new Date().toISOString(),
        repositories: repositories.map((repository) => ({
          ...repository,
          configurationSha256: metadataFileDigest(join(repository.gitDirectory, "config")),
        })),
        mounts: [
          { source: destination, target: destination, mode: "rw" },
          ...[...stores].map((store) => ({ source: store, target: store, mode: "ro" as const })),
        ],
        excluded: materialized.notCompared,
      }
      const result: PrivateGitProjectionResult = {
        state: "updated",
        partial: false,
        repositories: [],
        projection,
        retainedPaths,
      }
      options.report?.(result)
      return result
    }
    await mkdir(destination)
    retainedPaths.push(destination)
    const owners = [
      ...new Set([
        ...privateDirectories.values(),
        ...[...prepared.values()].flatMap((selected) => [...selected.owners]),
      ]),
    ].sort()
    const acquire = async (index: number): Promise<PrivateGitProjectionResult> => {
      const owner = owners[index]
      if (owner !== undefined) {
        return createExclusive(join(owner, "yrd-worktree-mutations")).run(
          async (held) => {
            if (held === undefined) throw new Error(`missing issued projection custody: ${owner}`)
            heldLocks.set(owner, held)
            try {
              return await acquire(index + 1)
            } finally {
              heldLocks.delete(owner)
            }
          },
          { holder: `private projection ${destination}` },
        )
      }
      for (const [path, inspected] of inputs) {
        let current: Stats | undefined
        try {
          current = await lstat(path)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw new Error(`cannot reinspect prepared Git metadata: ${path}`, { cause: error })
          }
        }
        if (!sameEntry(inspected.stat, current)) throw new Error(`prepared Git metadata identity changed: ${path}`)
        if (current !== undefined && (await realpath(path)) !== path) {
          throw new Error(`prepared Git metadata path redirected: ${path}`)
        }
        if (inspected.bytes !== undefined && current !== undefined) {
          await readMetadataFile(path, current, (_path, _stat, bytes) => {
            if (bytes === undefined || !inspected.bytes?.equals(bytes)) {
              throw new Error(`prepared Git metadata bytes changed: ${path}`)
            }
          })
        }
      }
      for (const selected of prepared.values()) {
        if (
          (await metadata(selected.sourceCheckout)) !== selected.sourceGit ||
          (await commonDirectory(selected.sourceGit)) !== selected.common ||
          (await commonDirectory(selected.publicDirectory)) !== selected.publicCommon
        ) {
          throw new Error(`public metadata changed before projection: ${selected.sourceCheckout}`)
        }
        const lineage = await alternatesLineage([selected.objects], "", { allowedObjects: new Set(stores) })
        if (
          lineage.length !== selected.lineage.length ||
          lineage.some((store, index) => store !== selected.lineage[index])
        ) {
          throw new Error(`public object closure changed before projection: ${selected.sourceCheckout}`)
        }
      }
      // Trusted preparation pins every selected baseline in its actual GC owner before private Git.
      for (const selected of prepared.values()) {
        for (const directory of selected.owners) {
          await ensureCommitObject({
            repository: selected.sourceCheckout,
            remote: selected.common,
            commit: selected.head,
            git: {
              run: (request) =>
                git.run({
                  ...request,
                  args: [
                    "--git-dir",
                    directory,
                    ...(request.args[0] === "fetch" ? ["-c", "protocol.file.allow=always"] : []),
                    ...request.args,
                  ],
                }),
            },
          })
          await run(selected.sourceCheckout, [
            "--git-dir",
            directory,
            "update-ref",
            pinRef(selected.head),
            selected.head,
          ])
        }
      }
      return execute()
    }
    return await acquire(0)
  } catch (error) {
    const result: PrivateGitProjectionResult = {
      state: "failed",
      partial: retainedPaths.length > 0,
      repositories: [],
      retainedPaths,
      detail: {
        code: "private-projection-failed",
        phase: "private-projection",
        message: String(error),
        paths: retainedPaths,
      },
    }
    options.report?.(result)
    return result
  }
}
