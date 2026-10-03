import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import { alternatesLineage } from "./alternates.ts"
import { readPrivateSubmodulePaths } from "./commit-graph.ts"
import { cleanGitEnvironment, validateExcludedSubmodules, withGitEnvironment } from "./git.ts"
import { createLocalGitProcess, type GitProcess } from "./process.ts"
import { materializeSubmodules } from "./submodules.ts"
import { pinRef } from "./objects.ts"
import { createExclusive } from "./exclusive.ts"
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
): Promise<PrivateGitRetentionResult> {
  const retainedPaths: string[] = []
  let leases: ReturnType<typeof acquireRemovalWriterLeases> | undefined
  try {
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
      ),
    )
    if (retire) await rm(checkout, { recursive: true })
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

/** Retire only after the existing custody owner has proved a durable copy from this plain record. */
export function retirePrivateGitProjection(
  projection: PrivateGitProjection,
  retentionRoot: string,
): Promise<PrivateGitRetentionResult> {
  return preserveProjection(projection, retentionRoot, true)
}

/** Resolve host-selected repository metadata without asking Git to follow an object path. */
async function metadata(checkout: string): Promise<string> {
  const pointer = join(checkout, ".git")
  const stat = await lstat(pointer)
  if (stat.isDirectory()) return realpath(pointer)
  if (!stat.isFile()) throw new Error(`unsupported Git metadata pointer: ${pointer}`)
  const match = /^gitdir: ([^\r\n]+)\r?\n?$/u.exec(await readFile(pointer, "utf8"))
  if (match?.[1] === undefined) throw new Error(`invalid Git metadata pointer: ${pointer}`)
  return realpath(resolve(checkout, match[1]))
}

async function commonDirectory(gitDirectory: string): Promise<string> {
  let content: string
  try {
    content = await readFile(join(gitDirectory, "commondir"), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    // silent-fallback-allow: absent commondir identifies a standalone repository, not a missing store
    return gitDirectory
  }
  const selected = content.trim()
  if (selected === "") throw new Error(`empty commondir under ${gitDirectory}`)
  return realpath(resolve(gitDirectory, selected))
}

/** Make private metadata while the existing materializer owns recursive frozen declaration selection. */
export async function projectPrivateGitWorktree(
  options: PrivateGitProjectionOptions,
): Promise<PrivateGitProjectionResult> {
  const retainedPaths: string[] = []
  const repositories: Array<{ path: string; checkout: string; gitDirectory: string; head: string }> = []
  const stores = new Set<string>()
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
    const createRepository = async (
      checkout: string,
      sourceCheckout: string,
      head: string,
      root: boolean,
      privateGitDirectory?: string,
    ): Promise<void> => {
      const sourceGit = await metadata(sourceCheckout)
      const common = await commonDirectory(sourceGit)
      const objects = join(common, "objects")
      await alternatesLineage([objects], join(checkout, ".git", "objects"), { allowedObjects: new Set([objects]) })
      if (root) await mkdir(checkout)
      else await mkdir(checkout, { recursive: true })
      retainedPaths.push(checkout)
      await run(checkout, ["check-ref-format", "--branch", options.branch])
      await run(checkout, [
        "init",
        "--template=",
        ...(privateGitDirectory === undefined ? [] : ["--separate-git-dir", privateGitDirectory]),
        `--object-format=${head.length === 64 ? "sha256" : "sha1"}`,
        "-b",
        options.branch,
      ])
      const gitDirectory = privateGitDirectory ?? join(checkout, ".git")
      await writeFile(join(gitDirectory, "objects", "info", "alternates"), `${objects}\n`, { flag: "wx" })
      await run(checkout, ["cat-file", "-e", `${head}^{commit}`])
      await createExclusive(join(common, "yrd-worktree-mutations")).run(
        async () => {
          await run(checkout, ["--git-dir", common, "update-ref", pinRef(head), head])
        },
        { holder: `private projection ${destination}` },
      )
      stores.add(objects)
      await run(checkout, ["checkout", "--no-recurse-submodules", "-B", options.branch, head])
      repositories.push({ path: relative(destination, checkout).split(sep).join("/"), checkout, gitDirectory, head })
    }
    await createRepository(destination, source, options.commit, true)
    const materialized = await materializeSubmodules(
      { run: (repo, args) => git.run({ repo, args }) },
      {
        worktree: destination,
        referenceWorktree: source,
        excludedSubmodules: options.excludedSubmodules,
      },
      {
        validate: async (checkout, head, excluded, metadata) => {
          const declared = await readPrivateSubmodulePaths(git, checkout, head)
          const direct = excluded.filter((path) => declared.includes(path))
          const unexpected = excluded.filter(
            (path) =>
              !declared.includes(path) && !metadata.submodules.some((entry) => path.startsWith(`${entry.path}/`)),
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
        },
        materialize: async (parent, entry) => {
          const checkout = join(parent, entry.path)
          const directory = safeStorePath(await metadata(parent), entry.name)
          await mkdir(dirname(directory), { recursive: true })
          await createRepository(
            checkout,
            join(source, relative(destination, checkout)),
            entry.target,
            false,
            directory,
          )
        },
      },
    )
    if (materialized.code !== 0) throw new Error(materialized.stderr)
    const projection: PrivateGitProjection = {
      checkout: destination,
      base: options.commit,
      branch: options.branch,
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
