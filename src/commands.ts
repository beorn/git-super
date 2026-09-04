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
import { superStatus, type SuperStatusResult } from "./status.ts"
import { superWorktreeAdd, type SuperWorktreeAddOptions } from "./worktree-add.ts"

export type CommandContext = Readonly<{ repo: string }>
export type DiffParams = Omit<SuperDiffOptions, "repo">
export type StatusParams = Record<string, never>
export type MergeBaseParams = Omit<SuperIsAncestorOptions, "repo">
export type MergeParams = Omit<SuperMergeOptions, "repo" | "git" | "exclusive">
export type PullParams = Omit<SuperPullOptions, "repo" | "git" | "exclusive">
export type PushParams = Omit<SuperPushOptions, "repo" | "git" | "exclusive">
export type GitlinkWriteParams = Omit<WriteGitlinkOptions, "repo" | "git">
export type WorktreeAddParams = Omit<SuperWorktreeAddOptions, "repo" | "env" | "log">

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
      ...(input.cached === true ? { cached: true } : {}),
      ...(typeof input.diffFilter === "string" ? { diffFilter: input.diffFilter } : {}),
    }
  }),
  run: (context, input) => superDiff({ repo: context.repo, ...input }),
})

const status = commandNode<CommandContext, StatusParams, SuperStatusResult>({
  title: "Status across a superproject",
  description: "Emit porcelain status with paths prefixed by their owning repository.",
  params: params(() => ({})),
  run: (context) => superStatus({ repo: context.repo }),
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
      return { ancestor: input.ancestor, descendant: input.descendant }
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
  description: "Merge one commit, stage component-main gitlinks, settle their checkouts, then commit once.",
  params: params(
    (value) => {
      const input = record(value)
      if (typeof input.commit !== "string") throw new Error("commit must be a string")
      if (input.message !== undefined && typeof input.message !== "string") {
        throw new Error("message must be a string")
      }
      return {
        commit: input.commit,
        ...(input.message === undefined ? {} : { message: input.message }),
        ...(input.noVerify === true ? { noVerify: true } : {}),
      }
    },
    (value) => {
      const input = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
      return typeof input.commit === "string" ? [] : ["commit"]
    },
  ),
  run: (context, input) => superMerge({ repo: context.repo, ...input }),
})

const pull = commandNode<CommandContext, PullParams, GitSuperResult>({
  title: "Fast-forward a superproject",
  description: "Fetch and safely fast-forward a root plus its exact recorded submodule commits.",
  params: params((value) => {
    const input = record(value)
    return {
      ffOnly: input.ffOnly === true,
      ...(typeof input.repository === "string" ? { repository: input.repository } : {}),
      refspecs: stringArray(input.refspecs, "refspecs"),
      ...(input.dryRun === true ? { dryRun: true } : {}),
    }
  }),
  run: (context, input) => superPull({ repo: context.repo, ...input }),
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
    }
  }),
  run: (context, input) => superPush({ repo: context.repo, ...input }),
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
      }
    },
    (value) => {
      const input = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
      return ["path", "commit"].filter((name) => typeof input[name] !== "string")
    },
  ),
  run: (context, input) => superWorktreeAdd({ repo: context.repo, ...input }),
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
  worktree: Readonly<{
    add: CommandNode<CommandContext, WorktreeAddParams, GitSuperResult>
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
  worktree: { add: worktreeAdd },
}) satisfies CommandNodeTree<CommandContext> as GitSuperCommands
