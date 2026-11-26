import {
  commandNode,
  defineCommandNodes,
  type CommandNode,
  type CommandNodeTree,
  type ParseParamSchema,
} from "@silvery/command"
import { superDiff, type SuperDiffOptions, type SuperDiffResult } from "./diff.ts"
import { writeGitlink, type WriteGitlinkOptions } from "./gitlink.ts"
import { superMerge, type SuperMergeOptions, type SuperMergeResult } from "./merge.ts"
import { superIsAncestor, type SuperIsAncestorOptions, type SuperIsAncestorResult } from "./merge-base.ts"
import { superPull, type SuperPullOptions } from "./pull.ts"
import { superPush, type SuperPushOptions } from "./push.ts"
import type { GitSuperResult } from "./result.ts"
import { shellQuote } from "./shell-command.ts"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { repositoryRoot } from "./git.ts"
import { ensureCommitObject } from "./objects.ts"
import { superStatus, type SuperStatusOptions, type SuperStatusResult } from "./status.ts"
import { checkRetentionDiscard } from "./retention-discard.ts"
import {
  admitOnRemoteSelections,
  checkRetentionAttribution,
  enrollRetainedBorrowers,
  type RetentionEnrollReport,
} from "./worktree-removal.ts"
import {
  superSubmodulePrepare,
  type SuperSubmodulePrepareOptions,
  type SuperSubmodulePrepareResult,
} from "./submodule-prepare.ts"
import { superWorktreeAdd, type SuperWorktreeAddOptions } from "./worktree-add.ts"
import {
  verifyPrivateStoreCandidate,
  type PrivateStoreCandidateOptions,
  type PrivateStoreCandidateResult,
} from "./private-store-candidate.ts"
import { verifyRetainedEntry, type RetentionVerifyOptions, type RetentionVerifyResult } from "./retention-verify.ts"
import { auditRetainedEntry, retireRetainedEntry, type RetentionRetireOptions } from "./retention-remove.ts"
import { compactRetainedRoot, type CompactRetainedRootReport } from "./retention-compact.ts"
import { retireRetainedBatch, type RetentionBatchOptions, type RetentionBatchResult } from "./retention-batch.ts"
import {
  retireRetainedBatchInChunks,
  type RetentionChunkOptions,
  type RetentionChunkResult,
} from "./retention-chunks.ts"
import { rankRetainedEntries, type RetainedRanking } from "./retention-bytes.ts"
import { existsSync, realpathSync } from "node:fs"
import { superWorktreeRemove, type SuperWorktreeRemoveOptions } from "./worktree-remove.ts"

export type CommandContext = Readonly<{ repo: string; report?: (message: string) => void }>
export type DiffParams = Omit<SuperDiffOptions, "repo">
export type StatusParams = Omit<SuperStatusOptions, "repo"> & Readonly<{ removal?: boolean }>
export type MergeBaseParams = Omit<SuperIsAncestorOptions, "repo">
export type MergeParams = Omit<SuperMergeOptions, "repo" | "git" | "exclusive" | "report">
export type PullParams = Omit<SuperPullOptions, "repo" | "git" | "exclusive" | "report"> & { progress?: boolean }
export type PushParams = Omit<SuperPushOptions, "repo" | "git" | "exclusive" | "report"> & { progress?: boolean }
export type GitlinkWriteParams = Omit<WriteGitlinkOptions, "repo" | "git">
export type SubmodulePrepareParams = Omit<SuperSubmodulePrepareOptions, "repo" | "git" | "exclusive">
export type WorktreeRemoveParams = Omit<SuperWorktreeRemoveOptions, "repo" | "report">
export type WorktreeAddParams = Omit<SuperWorktreeAddOptions, "repo" | "env" | "log" | "report">
export type RetentionVerifyParams = Omit<RetentionVerifyOptions, "clock">
export type RetentionRetireParams = Omit<RetentionRetireOptions, "clock">
export type RetentionEnrollParams = Readonly<{ root: string; common: string; apply?: boolean }>
export type RetentionCompactParams = Readonly<{ root: string; dryRun?: boolean; limit?: number }>
export type RetentionBatchParams = Pick<
  RetentionBatchOptions,
  | "entries"
  | "root"
  | "common"
  | "namespaceRoots"
  | "artifactDir"
  | "apply"
  | "proofDeadlineMs"
  | "targetBranch"
  | "retiredMaxAgeMs"
>
export type RetentionRankParams = Readonly<{ entries: readonly string[]; root: string; deadlineMs: number }>
export type RetentionChunksParams = Pick<
  RetentionChunkOptions,
  | "entries"
  | "root"
  | "common"
  | "namespaceRoots"
  | "artifactDir"
  | "apply"
  | "chunkSize"
  | "cursorFile"
  | "retiredMaxAgeMs"
  | "deadlineMs"
  | "targetBranch"
>
export type PrivateStoreVerifyParams = Omit<PrivateStoreCandidateOptions, "git">
export type PrivateStoreVerifyNode = CommandNode<CommandContext, PrivateStoreVerifyParams, PrivateStoreCandidateResult>

function params<T>(parse: (value: unknown) => T, missing?: (value: unknown) => string[]): ParseParamSchema<T> {
  return { parse, ...(missing === undefined ? {} : { missing }) }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected command parameters")
  }
  return value as Record<string, unknown>
}

function stringArray(value: unknown, name: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${name} must be strings`)
  }
  return value as string[]
}

const diff = commandNode<CommandContext, DiffParams, SuperDiffResult>({
  title: "Diff across a superproject",
  description: "List root-relative paths, expanding moved gitlinks into their owning repositories.",
  params: params((value) => {
    const input = record(value)
    return {
      refs: stringArray(input.refs, "refs"),
      ...(input.excludedSubmodules === undefined
        ? {}
        : { excludedSubmodules: stringArray(input.excludedSubmodules, "excludedSubmodules") }),
      ...(input.cached === true ? { cached: true } : {}),
      ...(typeof input.diffFilter === "string" ? { diffFilter: input.diffFilter } : {}),
      ...(input.stat === true ? { stat: true } : {}),
      ...(input.patch === true ? { patch: true } : {}),
      ...(typeof input.componentBase === "string" ? { componentBase: input.componentBase } : {}),
    }
  }),
  run: async (context, input) => {
    const root = repositoryRoot(context.repo)
    const options = { repo: root, ...input }
    const attempted = new Set<string>()
    let result = superDiff(options)
    for (;;) {
      let fetched = false
      for (const observation of result.notCompared) {
        if (observation.reason !== "unreadable" || observation.remote === undefined) continue
        const repository = join(root, observation.path)
        for (const commit of observation.objectIds ?? []) {
          const key = `${repository}\0${commit}`
          if (attempted.has(key)) continue
          attempted.add(key)
          context.report?.(`Fetching missing commit ${commit} for ${observation.path}\n`)
          await ensureCommitObject({ repository, remote: observation.remote, commit })
          fetched = true
        }
      }
      if (!fetched) return result
      // Reading a repaired parent can expose a previously unreadable nested component.
      result = superDiff(options)
    }
  },
})

const status = commandNode<CommandContext, StatusParams, SuperStatusResult>({
  title: "Status across a superproject",
  description: "Emit porcelain status with paths prefixed by their owning repository.",
  params: params((value) => {
    const input = record(value)
    if (input.indexFile !== undefined && typeof input.indexFile !== "string") {
      throw new Error("indexFile must be a string")
    }
    if (input.removal !== undefined && typeof input.removal !== "boolean") {
      throw new Error("removal must be a boolean")
    }
    return {
      ...(input.indexFile === undefined ? {} : { indexFile: input.indexFile as string }),
      ...(input.excludedSubmodules === undefined
        ? {}
        : { excludedSubmodules: stringArray(input.excludedSubmodules, "excludedSubmodules") }),
      ...(input.removal === undefined ? {} : { removal: input.removal as boolean }),
    }
  }),
  run: (context, input) => {
    const { removal, ...statusOptions } = input
    const status = superStatus({ repo: context.repo, ...statusOptions })
    return removal === true ? admitOnRemoteSelections(status) : status
  },
})

const mergeBase = commandNode<CommandContext, MergeBaseParams, SuperIsAncestorResult>({
  title: "Test ancestry across a superproject",
  description: "Find the repository that owns a commit and compare it with the selected superproject pin.",
  params: params(
    (value) => {
      const input = record(value)
      if (typeof input.ancestor !== "string" || typeof input.descendant !== "string") {
        throw new Error("ancestor and descendant must be strings")
      }
      return {
        ancestor: input.ancestor,
        descendant: input.descendant,
        ...(input.excludedSubmodules === undefined
          ? {}
          : { excludedSubmodules: stringArray(input.excludedSubmodules, "excludedSubmodules") }),
      }
    },
    (value) => {
      const input = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
      return ["ancestor", "descendant"].filter((name) => typeof input[name] !== "string")
    },
  ),
  run: (context, input) => superIsAncestor({ repo: context.repo, ...input }),
})

const merge = commandNode<CommandContext, MergeParams, SuperMergeResult>({
  title: "Merge and settle a superproject",
  description: "Merge one commit, stage submodule-main gitlinks, settle their checkouts, then commit once.",
  params: params(
    (value) => {
      const input = record(value)
      if (typeof input.commit !== "string") throw new Error("commit must be a string")
      if (input.message !== undefined && typeof input.message !== "string") {
        throw new Error("message must be a string")
      }
      for (const name of ["expectedHead", "expectedBranch"] as const) {
        if (input[name] !== undefined && typeof input[name] !== "string") throw new Error(`${name} must be a string`)
      }
      return {
        commit: input.commit,
        ...(input.message === undefined ? {} : { message: input.message }),
        ...(input.noVerify === true ? { noVerify: true } : {}),
        ...(input.preserveConflicts === true ? { preserveConflicts: true } : {}),
        ...(input.continue === true ? { continue: true } : {}),
        ...(typeof input.expectedHead === "string" ? { expectedHead: input.expectedHead } : {}),
        ...(typeof input.expectedBranch === "string" ? { expectedBranch: input.expectedBranch } : {}),
        ...(input.excludedSubmodules === undefined
          ? {}
          : { excludedSubmodules: stringArray(input.excludedSubmodules, "excludedSubmodules") }),
        ...(input.noFetch === true ? { noFetch: true } : {}),
        ...(input.unboundedLocalMain === true ? { unboundedLocalMain: true } : {}),
        ...(input.retainPins === false ? { retainPins: false } : {}),
      }
    },
    (value) => {
      const input = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
      return typeof input.commit === "string" ? [] : ["commit"]
    },
  ),
  run: async (context, input) => {
    const result = await superMerge({
      repo: context.repo,
      ...input,
      ...(context.report === undefined ? {} : { report: context.report }),
    })
    if (result.detail?.code !== "mutation-lock-busy") return result
    const argv = [
      "git",
      "super",
      "--repo",
      context.repo,
      "merge",
      input.commit,
      ...(input.message === undefined ? [] : ["-m", input.message]),
      ...(input.noVerify === true ? ["--no-verify"] : []),
      ...(input.preserveConflicts === true ? ["--preserve-conflicts"] : []),
      ...(input.continue === true ? ["--continue"] : []),
      ...(input.expectedHead === undefined ? [] : ["--expected-head", input.expectedHead]),
      ...(input.expectedBranch === undefined ? [] : ["--expected-branch", input.expectedBranch]),
      ...(input.excludedSubmodules ?? []).flatMap((path) => ["--exclude-submodule", path]),
      ...(input.noFetch === true ? ["--no-fetch"] : []),
      ...(input.unboundedLocalMain === true ? ["--unbounded-local-main"] : []),
      ...(input.retainPins === false ? ["--no-retain-pins"] : []),
    ]
    const next = `Wait for the named holder to finish, then run ${argv.map(shellQuote).join(" ")}.`
    const detail = result.detail
    if (detail.subject === undefined || detail.evidence === undefined || detail.owner === undefined) {
      throw new Error("git-super: mutation-lock-busy detail is missing its subject, evidence, or owner")
    }
    const updated = {
      ...detail,
      message: `${detail.code}: ${detail.subject}; evidence: ${detail.evidence}; next: ${next}; owner: ${detail.owner}`,
      next,
      remedy: next,
    }
    return {
      ...result,
      detail: updated,
      repositories: result.repositories.map((repository) =>
        repository.detail?.code === "mutation-lock-busy" ? { ...repository, detail: updated } : repository,
      ),
    }
  },
})

const pull = commandNode<CommandContext, PullParams, GitSuperResult>({
  title: "Fast-forward a superproject",
  description: "Fetch and safely fast-forward a root plus its exact recorded submodule commits.",
  params: params((value) => {
    const input = record(value)
    return {
      ffOnly: input.ffOnly === true,
      excludedSubmodules: stringArray(input.excludedSubmodules, "excludedSubmodules"),
      ...(typeof input.repository === "string" ? { repository: input.repository } : {}),
      refspecs: stringArray(input.refspecs, "refspecs"),
      ...(input.dryRun === true ? { dryRun: true } : {}),
      ...(input.progress === true ? { progress: true } : {}),
    }
  }),
  // With progress (GIT_SUPER_PROGRESS=1 at the CLI) each phase is reported as it starts (24907); without it a
  // successful pull stays silent on stderr.
  run: (context, { progress, ...input }) =>
    superPull({
      repo: context.repo,
      ...input,
      ...(progress === true && context.report !== undefined ? { report: context.report } : {}),
      // A signal deferred during the apply is said whether or not progress is on (24907).
      ...(context.report === undefined ? {} : { warn: context.report }),
    }),
})

const push = commandNode<CommandContext, PushParams, GitSuperResult>({
  title: "Push a superproject",
  description: "Check or publish exact submodule commits before updating root refs.",
  params: params((value) => {
    const input = record(value)
    const recurseSubmodules = input.recurseSubmodules
    if (
      recurseSubmodules !== "check" &&
      recurseSubmodules !== "on-demand" &&
      recurseSubmodules !== "only" &&
      recurseSubmodules !== "no"
    ) {
      throw new Error("recurseSubmodules must be check, on-demand, only, or no")
    }
    const signed = input.signed
    if (signed !== undefined && signed !== "true" && signed !== "false" && signed !== "if-asked") {
      throw new Error("signed must be true, false, or if-asked")
    }
    return {
      recurseSubmodules,
      ...(typeof input.remote === "string" ? { remote: input.remote } : {}),
      refspecs: stringArray(input.refspecs, "refspecs"),
      ...(input.atomic === true ? { atomic: true } : {}),
      ...(input.verify === false ? { verify: false } : {}),
      pushOptions: stringArray(input.pushOptions, "pushOptions"),
      forceWithLease: stringArray(input.forceWithLease, "forceWithLease"),
      ...(signed === undefined ? {} : { signed }),
      ...(input.progress === true ? { progress: true } : {}),
    }
  }),
  run: (context, { progress, ...input }) =>
    superPush({
      repo: context.repo,
      ...input,
      ...(progress === true && context.report !== undefined ? { report: context.report } : {}),
    }),
})

const gitlinkWrite = commandNode<CommandContext, GitlinkWriteParams, GitSuperResult>({
  title: "Write an exact gitlink pin",
  description: "Set one existing submodule's index commit without moving its checkout or choosing policy.",
  params: params(
    (value) => {
      const input = record(value)
      if (typeof input.path !== "string" || typeof input.commit !== "string") {
        throw new Error("path and commit must be strings")
      }
      return { path: input.path, commit: input.commit }
    },
    (value) => {
      const input = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
      return ["path", "commit"].filter((name) => typeof input[name] !== "string")
    },
  ),
  run: (context, input) => writeGitlink({ repo: context.repo, ...input }),
})

const submodulePrepare = commandNode<CommandContext, SubmodulePrepareParams, SuperSubmodulePrepareResult>({
  title: "Prepare persistent submodule stores",
  description: "Bind direct gitlinks from one exact root commit to durable checkout-free Git directories.",
  params: params(
    (value) => {
      const input = record(value)
      if (typeof input.commit !== "string" || typeof input.remote !== "string") {
        throw new Error("commit and remote must be strings")
      }
      return { commit: input.commit, remote: input.remote }
    },
    (value) => {
      const input = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
      return ["commit", "remote"].filter((name) => typeof input[name] !== "string")
    },
  ),
  run: (context, input) => superSubmodulePrepare({ repo: context.repo, ...input }),
})

const worktreeAdd = commandNode<CommandContext, WorktreeAddParams, GitSuperResult>({
  title: "Add a worktree with its submodules",
  description: "Create a detached worktree and materialize every gitlink the selected commit records.",
  params: params(
    (value) => {
      const input = record(value)
      if (typeof input.path !== "string" || typeof input.commit !== "string") {
        throw new Error("path and commit must be strings")
      }
      if (input.reference !== undefined && typeof input.reference !== "string") {
        throw new Error("reference must be a string")
      }
      return {
        path: input.path,
        commit: input.commit,
        ...(input.reference === undefined ? {} : { reference: input.reference }),
        ...(input.excludedSubmodules === undefined
          ? {}
          : { excludedSubmodules: stringArray(input.excludedSubmodules, "excludedSubmodules") }),
        ...(input.omitCheckoutDirectories === undefined
          ? {}
          : { omitCheckoutDirectories: stringArray(input.omitCheckoutDirectories, "omitCheckoutDirectories") }),
      }
    },
    (value) => {
      const input = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
      return ["path", "commit"].filter((name) => typeof input[name] !== "string")
    },
  ),
  run: (context, input) =>
    superWorktreeAdd({
      repo: context.repo,
      ...input,
      ...(context.report === undefined ? {} : { report: context.report }),
    }),
})

const retentionVerifySchema = params<RetentionVerifyParams>((value) => {
  const input = record(value)
  if (typeof input.entry !== "string" || input.entry.trim() === "") {
    throw new Error("worktree retention verify requires an entry path")
  }
  if (typeof input.root !== "string" || input.root.trim() === "") {
    throw new Error("worktree retention verify requires --root <declared retained-modules root>")
  }
  if (
    input.namespaceRoots !== undefined &&
    (!Array.isArray(input.namespaceRoots) || input.namespaceRoots.some((entry) => typeof entry !== "string"))
  ) {
    throw new Error("namespaceRoots must be strings")
  }
  if (input.artifactDir !== undefined && typeof input.artifactDir !== "string") {
    throw new Error("artifactDir must be a string")
  }
  if (input.allowTemporaryArtifactDir !== undefined && typeof input.allowTemporaryArtifactDir !== "boolean") {
    throw new Error("allowTemporaryArtifactDir must be a boolean")
  }
  if (input.custodyTargetBranch !== undefined && typeof input.custodyTargetBranch !== "string") {
    throw new Error("custodyTargetBranch must be a string")
  }
  if (input.custodyTargetBranch === "") {
    throw new Error("custodyTargetBranch must be a non-empty branch name")
  }
  return {
    entry: input.entry,
    root: input.root,
    ...(input.custodyTargetBranch === undefined ? {} : { custodyTargetBranch: input.custodyTargetBranch }),

    ...(input.namespaceRoots === undefined ? {} : { namespaceRoots: input.namespaceRoots as string[] }),
    ...(input.artifactDir === undefined ? {} : { artifactDir: input.artifactDir as string }),
    ...(input.allowTemporaryArtifactDir === undefined
      ? {}
      : { allowTemporaryArtifactDir: input.allowTemporaryArtifactDir as boolean }),
  }
})

const retentionVerify = commandNode<CommandContext, RetentionVerifyParams, RetentionVerifyResult>({
  title: "Verify one retained GitSuper entry read-only",
  description:
    "Read a retained entry and its manifest, prove identity, eligibility and the full copy-to-manifest comparison, and refuse or report incomplete rather than authorizing removal.",
  params: retentionVerifySchema,
  run: (_context, input) => verifyRetainedEntry(input),
})

const retentionHeldSchema = params<RetentionRetireParams>((value) => {
  const input = retentionVerifySchema.parse(value)
  const extra = record(value)
  if (typeof extra.common !== "string" || extra.common.trim() === "") {
    throw new Error("held retention operation requires --common <Git common directory>")
  }
  if (input.artifactDir === undefined || input.artifactDir.trim() === "") {
    throw new Error("held retention operation requires --artifact-dir <external directory>")
  }
  if (
    input.namespaceRoots === undefined ||
    input.namespaceRoots.length === 0 ||
    input.namespaceRoots.some((path) => !path.trim())
  ) {
    throw new Error("held retention operation requires a complete nonempty --namespace <path> declaration")
  }
  return {
    ...input,
    common: extra.common,
    artifactDir: input.artifactDir,
    namespaceRoots: input.namespaceRoots,
    ...(extra.discard === undefined ? {} : { discard: checkRetentionDiscard(extra.discard) }),
  }
})

const retentionRetire = commandNode<CommandContext, RetentionRetireParams, GitSuperResult>({
  title: "Retire one verified retained entry under existing writer leases",
  description:
    "Revalidate preliminary proof while holding existing leases, remove only this entry, and retire its exact registry pointers; never unlock a lender.",
  params: retentionHeldSchema,
  run: (_context, input) => retireRetainedEntry(input),
})

/** #34127: the `.retired` age limit, carried through both batch verbs' params; absent, nothing is aged. */
function retiredMaxAge(input: Readonly<Record<string, unknown>>): { retiredMaxAgeMs?: number } {
  const age = input.retiredMaxAgeMs
  if (age === undefined) return {}
  if (typeof age !== "number" || !Number.isFinite(age) || age <= 0) {
    throw new Error("retire-batch retiredMaxAgeMs must be a positive number of milliseconds")
  }
  return { retiredMaxAgeMs: age }
}

const retentionBatch = commandNode<CommandContext, RetentionBatchParams, RetentionBatchResult>({
  title: "Retire selected retained entries on one estate scan",
  description:
    "Dry run by default; --apply rechecks the estate and each entry under existing writer leases before deletion.",
  params: params((value) => {
    const input = record(value)
    const entries = stringArray(input.entries, "entries")
    if (entries.length === 0) throw new Error("retire-batch requires at least one selected entry")
    if (input.apply !== undefined && typeof input.apply !== "boolean") {
      throw new Error("retire-batch apply must be a boolean")
    }
    const deadline = input.proofDeadlineMs
    if (deadline !== undefined && (typeof deadline !== "number" || !Number.isFinite(deadline) || deadline <= 0)) {
      throw new Error("retire-batch proofDeadlineMs must be a positive number of milliseconds")
    }
    const held = retentionHeldSchema.parse({ ...input, entry: entries[0] })
    return {
      entries,
      root: held.root,
      common: held.common,
      namespaceRoots: held.namespaceRoots,
      artifactDir: held.artifactDir,
      ...(held.custodyTargetBranch === undefined ? {} : { targetBranch: held.custodyTargetBranch }),
      ...(input.apply === true ? { apply: true } : {}),
      ...(deadline === undefined ? {} : { proofDeadlineMs: deadline as number }),
      ...retiredMaxAge(input),
    }
  }),
  run: (_context, input) => retireRetainedBatch(input),
})

/**
 * `retire-batch --chunk-size` (34127, @cto 2026-11-24 chunk ruling): the same verb, proving and retiring a chunk at a
 * time with a rotating start, so a deadline ends the run with real retirements behind it instead of discarding the
 * entries it proved. The per-entry invariant is unchanged and is stated in `retention-chunks.ts`.
 */
export const retentionChunks = commandNode<CommandContext, RetentionChunksParams, RetentionChunkResult>({
  title: "Retire selected retained entries in chunks, resuming from a cursor",
  description:
    "Dry run by default; --apply proves a chunk and retires it under existing writer leases before the next chunk. A deadline stop is a success with a named remainder.",
  params: params((value) => {
    const input = record(value)
    const entries = stringArray(input.entries, "entries")
    if (entries.length === 0) throw new Error("retire-batch --chunk-size requires at least one selected entry")
    if (input.apply !== undefined && typeof input.apply !== "boolean") {
      throw new Error("retire-batch apply must be a boolean")
    }
    const chunkSize = input.chunkSize
    if (
      chunkSize !== undefined &&
      (typeof chunkSize !== "number" || !Number.isSafeInteger(chunkSize) || chunkSize < 1)
    ) {
      throw new Error("retire-batch chunkSize must be a positive integer")
    }
    if (input.cursorFile !== undefined && (typeof input.cursorFile !== "string" || input.cursorFile === "")) {
      throw new Error("retire-batch cursorFile must be a nonempty path")
    }
    const deadline = input.deadlineMs
    if (deadline !== undefined && (typeof deadline !== "number" || !Number.isFinite(deadline) || deadline <= 0)) {
      throw new Error("retire-batch deadlineMs must be a positive number of milliseconds")
    }
    const held = retentionHeldSchema.parse({ ...input, entry: entries[0] })
    return {
      entries,
      root: held.root,
      common: held.common,
      namespaceRoots: held.namespaceRoots,
      artifactDir: held.artifactDir,
      ...(held.custodyTargetBranch === undefined ? {} : { targetBranch: held.custodyTargetBranch }),
      ...(input.apply === true ? { apply: true } : {}),
      ...(chunkSize === undefined ? {} : { chunkSize: chunkSize as number }),
      ...(input.cursorFile === undefined ? {} : { cursorFile: input.cursorFile as string }),
      ...(deadline === undefined ? {} : { deadlineMs: deadline as number }),
      ...retiredMaxAge(input),
    }
  }),
  run: (_context, input) => retireRetainedBatchInChunks(input),
})

/**
 * `retire-batch --rank-only` (#34920, @cto 34920-ranking-and-bare-r2 §1): measure the named entries and order them by
 * the bytes each holds alone. A mode of the retire-batch verb, deliberately outside the command tree: it runs no scan,
 * gates, leases or certificates, writes nothing, and its only consumer is Yrd's retained-drain planning.
 */
export const retentionRank = commandNode<CommandContext, RetentionRankParams, RetainedRanking>({
  title: "Rank selected retained entries by the bytes each holds alone",
  description: "Measures each entry with the retained-bytes walker; scans, proves, leases and deletes nothing.",
  params: params((value) => {
    const input = record(value)
    const entries = stringArray(input.entries, "entries")
    if (entries.length === 0) throw new Error("retire-batch --rank-only requires at least one selected entry")
    if (typeof input.root !== "string" || input.root === "") throw new Error("retire-batch --rank-only requires --root")
    if (typeof input.deadlineMs !== "number" || !Number.isFinite(input.deadlineMs) || input.deadlineMs <= 0) {
      throw new Error("retire-batch --rank-only requires a positive deadline")
    }
    // The batch's own path scope, kept in rank mode: every entry is a direct child of the declared root. An absent
    // entry is checked through its parent's real path, so it is reported unmeasured rather than refused here.
    const root = realpathSync(input.root)
    const scoped = entries.map((entry) => {
      const resolved = resolve(entry)
      const real = existsSync(resolved)
        ? realpathSync(resolved)
        : join(realpathSync(dirname(resolved)), basename(resolved))
      if (dirname(real) !== root) throw new Error(`batch entry ${real} is not a direct child of ${root}`)
      return real
    })
    if (new Set(scoped).size !== scoped.length) throw new Error("batch names an entry twice")
    return { entries: scoped, root, deadlineMs: input.deadlineMs }
  }),
  run: (_context, input) => rankRetainedEntries(input.entries, { deadlineMs: input.deadlineMs }),
})

const retentionAudit = commandNode<CommandContext, RetentionRetireParams, GitSuperResult>({
  title: "Audit one retained entry under existing writer leases",
  description:
    "Publish immutable native legacy evidence beside the unchanged original; never retire the entry or unlock a lender.",
  params: retentionHeldSchema,
  run: (_context, input) => auditRetainedEntry(input),
})

const retentionEnroll = commandNode<CommandContext, RetentionEnrollParams, RetentionEnrollReport>({
  title: "Enroll retained borrowers in their common registry",
  description:
    "Plan actual retained dependencies read-only; explicit apply registers linked borrowers under the existing common writer lease without rewriting proofs.",
  params: params((value) => {
    const input = record(value)
    if (typeof input.root !== "string" || input.root.trim() === "") {
      throw new Error("worktree retention enroll requires --root <declared retained root>")
    }
    if (typeof input.common !== "string" || input.common.trim() === "") {
      throw new Error("worktree retention enroll requires --common <Git common directory>")
    }
    if (input.apply !== undefined && typeof input.apply !== "boolean") {
      throw new Error("worktree retention enroll apply must be a boolean")
    }
    return { root: input.root, common: input.common, ...(input.apply === true ? { apply: true } : {}) }
  }),
  run: (context, input) =>
    enrollRetainedBorrowers({ ...input, ...(context.report === undefined ? {} : { report: context.report }) }),
})

const retentionCompact = commandNode<CommandContext, RetentionCompactParams, CompactRetainedRootReport>({
  title: "Compact existing retained GitSuper entries",
  description:
    "Pack refs and drop remote-tracking reflogs on each eligible child of a declared retained-modules root — the same compaction a verified close runs (C1), extended to older stock (C3). Drops remote-tracking reflogs; keeps local reflogs. Never removes an entry.",
  params: params((value) => {
    const input = record(value)
    if (typeof input.root !== "string" || input.root.trim() === "") {
      throw new Error("worktree retention compact requires --root <declared retained-modules root>")
    }
    if (input.dryRun !== undefined && typeof input.dryRun !== "boolean") {
      throw new Error("worktree retention compact dryRun must be a boolean")
    }
    if (
      input.limit !== undefined &&
      (typeof input.limit !== "number" || !Number.isInteger(input.limit) || input.limit < 0)
    ) {
      throw new Error("worktree retention compact --limit must be a non-negative whole number")
    }
    return {
      root: input.root,
      ...(input.dryRun === true ? { dryRun: true } : {}),
      ...(input.limit === undefined ? {} : { limit: input.limit as number }),
    }
  }),
  run: async (_context, input) =>
    compactRetainedRoot(input.root, {
      ...(input.dryRun === true ? { dryRun: true } : {}),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    }),
})

const worktreeRemove = commandNode<CommandContext, WorktreeRemoveParams, GitSuperResult>({
  title: "Remove a clean worktree with retained submodule stores",
  description: "Prove all repositories clean and unlocked, retain and verify Git stores, then remove once.",
  params: params((value) => {
    const input = record(value)
    if (typeof input.path !== "string" || typeof input.retain !== "string" || input.retain.trim() === "") {
      throw new Error("worktree remove requires a path and --retain <external directory>")
    }
    if (input.noRehome !== undefined && typeof input.noRehome !== "boolean") {
      throw new Error("worktree remove noRehome must be a boolean")
    }
    if (input.dryRun !== undefined && typeof input.dryRun !== "boolean") {
      throw new Error("worktree remove dryRun must be a boolean")
    }
    let componentCustody: Readonly<{ primaryRoot: string; targetBranch: string }> | undefined
    if (input.componentCustody !== undefined) {
      const custody = record(input.componentCustody)
      const unknown = Object.keys(custody).filter((key) => key !== "primaryRoot" && key !== "targetBranch")
      if (unknown.length > 0) throw new Error(`componentCustody has unknown property ${unknown[0]}`)
      if (typeof custody.primaryRoot !== "string" || !isAbsolute(custody.primaryRoot)) {
        throw new Error("componentCustody.primaryRoot must be an absolute path")
      }
      if (typeof custody.targetBranch !== "string" || custody.targetBranch === "") {
        throw new Error("componentCustody.targetBranch must be a non-empty branch name")
      }
      componentCustody = { primaryRoot: custody.primaryRoot, targetBranch: custody.targetBranch }
    }
    return {
      path: input.path,
      retain: input.retain,
      ...(input.dryRun === true ? { dryRun: true } : {}),
      ...(input.noRehome === true ? { noRehome: true } : {}),
      ...(componentCustody === undefined ? {} : { componentCustody }),
      ...(input.excludedSubmodules === undefined
        ? {}
        : {
            excludedSubmodules: stringArray(input.excludedSubmodules, "excludedSubmodules"),
          }),
      ...(input.preserved === undefined ? {} : { preserved: stringArray(input.preserved, "preserved") }),
      ...(input.attribution === undefined ? {} : { attribution: checkRetentionAttribution(input.attribution) }),
    }
  }),
  run: (context, input) =>
    superWorktreeRemove({
      repo: context.repo,
      ...input,
      ...(context.report === undefined ? {} : { report: context.report }),
    }),
})

const privateStoreVerify = commandNode<CommandContext, PrivateStoreVerifyParams, PrivateStoreCandidateResult>({
  title: "Check one private submodule store against its remote, read-only",
  description:
    "Compare a private store's refs and HEAD with what its configured remotes advertise, mapped through the store's own fetch refspecs. Emits a point-in-time candidate verdict, never removal authority.",
  params: params((value) => {
    const input = record(value)
    if (typeof input.store !== "string" || input.store.trim() === "") {
      throw new Error("worktree private-store verify requires a store path")
    }
    if (typeof input.checkout !== "string" || input.checkout.trim() === "") {
      throw new Error(
        "worktree private-store verify requires --checkout <path>: the empty-first precondition is stated against it",
      )
    }
    return { store: input.store, checkout: input.checkout }
  }),
  run: (_context, input) => verifyPrivateStoreCandidate(input),
})

export type GitSuperCommands = Readonly<{
  diff: CommandNode<CommandContext, DiffParams, SuperDiffResult>
  status: CommandNode<CommandContext, StatusParams, SuperStatusResult>
  "merge-base": CommandNode<CommandContext, MergeBaseParams, SuperIsAncestorResult>
  merge: CommandNode<CommandContext, MergeParams, SuperMergeResult>
  pull: CommandNode<CommandContext, PullParams, GitSuperResult>
  push: CommandNode<CommandContext, PushParams, GitSuperResult>
  gitlink: Readonly<{
    write: CommandNode<CommandContext, GitlinkWriteParams, GitSuperResult>
  }>
  submodule: Readonly<{
    prepare: CommandNode<CommandContext, SubmodulePrepareParams, SuperSubmodulePrepareResult>
  }>
  worktree: Readonly<{
    add: CommandNode<CommandContext, WorktreeAddParams, GitSuperResult>
    remove: CommandNode<CommandContext, WorktreeRemoveParams, GitSuperResult>
    retention: Readonly<{
      verify: CommandNode<CommandContext, RetentionVerifyParams, RetentionVerifyResult>
      retire: CommandNode<CommandContext, RetentionRetireParams, GitSuperResult>
      "retire-batch": CommandNode<CommandContext, RetentionBatchParams, RetentionBatchResult>
      audit: CommandNode<CommandContext, RetentionRetireParams, GitSuperResult>
      compact: CommandNode<CommandContext, RetentionCompactParams, CompactRetainedRootReport>
      enroll: CommandNode<CommandContext, RetentionEnrollParams, RetentionEnrollReport>
    }>
    "private-store": Readonly<{
      verify: PrivateStoreVerifyNode
    }>
  }>
}>

export const commands = defineCommandNodes({
  diff,
  status,
  "merge-base": mergeBase,
  merge,
  pull,
  push,
  gitlink: { write: gitlinkWrite },
  submodule: { prepare: submodulePrepare },
  worktree: {
    add: worktreeAdd,
    remove: worktreeRemove,
    retention: {
      verify: retentionVerify,
      retire: retentionRetire,
      "retire-batch": retentionBatch,
      audit: retentionAudit,
      compact: retentionCompact,
      enroll: retentionEnroll,
    },
    "private-store": { verify: privateStoreVerify },
  },
}) satisfies CommandNodeTree<CommandContext> as GitSuperCommands
