import {
  commandNode,
  defineCommandNodes,
  type CommandNode,
  type CommandNodeTree,
  type ParseParamSchema,
} from "@silvery/command"
import { superDiff, type SuperDiffOptions, type SuperDiffResult } from "./diff.ts"
import { superIsAncestor, type SuperIsAncestorOptions, type SuperIsAncestorResult } from "./merge-base.ts"
import { superPull, type SuperPullOptions } from "./pull.ts"
import { superPush, type SuperPushOptions } from "./push.ts"
import type { GitSuperResult } from "./result.ts"
import { superStatus, type SuperStatusResult } from "./status.ts"

export type CommandContext = Readonly<{ repo: string }>
export type DiffParams = Omit<SuperDiffOptions, "repo">
export type StatusParams = Record<string, never>
export type MergeBaseParams = Omit<SuperIsAncestorOptions, "repo">
export type PullParams = Omit<SuperPullOptions, "repo" | "git" | "exclusive">
export type PushParams = Omit<SuperPushOptions, "repo" | "git" | "exclusive">

function params<T>(parse: (value: unknown) => T, missing?: (value: unknown) => string[]): ParseParamSchema<T> {
  return { parse, ...(missing === undefined ? {} : { missing }) }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("expected command parameters")
  return value as Record<string, unknown>
}

function stringArray(value: unknown, name: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
    throw new Error(`${name} must be strings`)
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

export type GitSuperCommands = Readonly<{
  diff: CommandNode<CommandContext, DiffParams, SuperDiffResult>
  status: CommandNode<CommandContext, StatusParams, SuperStatusResult>
  "merge-base": CommandNode<CommandContext, MergeBaseParams, SuperIsAncestorResult>
  pull: CommandNode<CommandContext, PullParams, GitSuperResult>
  push: CommandNode<CommandContext, PushParams, GitSuperResult>
}>

export const commands = defineCommandNodes({
  diff,
  status,
  "merge-base": mergeBase,
  pull,
  push,
}) satisfies CommandNodeTree<CommandContext> as GitSuperCommands
