import {
  commandNode,
  defineCommandNodes,
  type CommandNode,
  type CommandNodeTree,
  type ParseParamSchema,
} from "@silvery/command"
import { superDiff, type SuperDiffOptions, type SuperDiffResult } from "./diff.ts"
import { superIsAncestor, type SuperIsAncestorOptions, type SuperIsAncestorResult } from "./merge-base.ts"
import { superStatus, type SuperStatusResult } from "./status.ts"

export type CommandContext = Readonly<{ repo: string }>
export type DiffParams = Omit<SuperDiffOptions, "repo">
export type StatusParams = Record<string, never>
export type MergeBaseParams = Omit<SuperIsAncestorOptions, "repo">

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

export type GitSuperCommands = Readonly<{
  diff: CommandNode<CommandContext, DiffParams, SuperDiffResult>
  status: CommandNode<CommandContext, StatusParams, SuperStatusResult>
  "merge-base": CommandNode<CommandContext, MergeBaseParams, SuperIsAncestorResult>
}>

export const commands = defineCommandNodes({
  diff,
  status,
  "merge-base": mergeBase,
}) satisfies CommandNodeTree<CommandContext> as GitSuperCommands
