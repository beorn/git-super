import { Command as CliCommand, CommanderError } from "@silvery/commander"
import { resolveInvocation, type CommandNode } from "@silvery/command"
import {
  commands,
  type CommandContext,
  type DiffParams,
  type GitlinkWriteParams,
  type MergeBaseParams,
  type MergeParams,
  type PullParams,
  type PushParams,
  type StatusParams,
  type SubmodulePrepareParams,
  type WorktreeAddParams,
} from "./commands.ts"
import type { ConsultedRepository, SuperDiffResult } from "./diff.ts"
import type { SuperIsAncestorResult } from "./merge-base.ts"
import type { SuperMergeResult } from "./merge.ts"
import type { GitSuperResult } from "./result.ts"
import { renderConsultedRepositories } from "./report.tsx"
import type { SuperStatusResult } from "./status.ts"
import type { SuperSubmodulePrepareResult } from "./submodule-prepare.ts"

export type OutputSink = Readonly<{
  write(value: string): unknown
  isTTY?: boolean
  columns?: number
}>

type CapturedInvocation =
  | Readonly<{ node: typeof commands.diff; params: DiffParams; json: boolean; nul: boolean }>
  | Readonly<{ node: typeof commands.status; params: StatusParams; json: boolean; nul: boolean }>
  | Readonly<{ node: (typeof commands)["merge-base"]; params: MergeBaseParams; json: boolean; nul: boolean }>
  | Readonly<{ node: typeof commands.merge; params: MergeParams; json: boolean; nul: boolean }>
  | Readonly<{ node: typeof commands.pull; params: PullParams; json: boolean; nul: boolean }>
  | Readonly<{ node: typeof commands.push; params: PushParams; json: boolean; nul: boolean }>
  | Readonly<{ node: typeof commands.gitlink.write; params: GitlinkWriteParams; json: boolean; nul: boolean }>
  | Readonly<{ node: typeof commands.submodule.prepare; params: SubmodulePrepareParams; json: boolean; nul: boolean }>
  | Readonly<{ node: typeof commands.worktree.add; params: WorktreeAddParams; json: boolean; nul: boolean }>

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (typeof value !== "object" || value === null) return value
  const object = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(object)
      .sort()
      .filter((key) => object[key] !== undefined)
      .map((key) => [key, stableValue(object[key])]),
  )
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(stableValue(value))}\n`
}

async function writeReport(repositories: readonly ConsultedRepository[], stderr: OutputSink): Promise<void> {
  const report = await renderConsultedRepositories(repositories, {
    plain: !stderr.isTTY,
    width: stderr.columns ?? 100,
  })
  stderr.write(`${report}\n`)
}

function commandResult(
  node: CapturedInvocation["node"],
  context: CommandContext,
  params: CapturedInvocation["params"],
): Promise<
  | SuperDiffResult
  | SuperStatusResult
  | SuperIsAncestorResult
  | SuperMergeResult
  | SuperSubmodulePrepareResult
  | GitSuperResult
> {
  const invocation = resolveInvocation(
    node as CommandNode<
      CommandContext,
      CapturedInvocation["params"],
      | SuperDiffResult
      | SuperStatusResult
      | SuperIsAncestorResult
      | SuperMergeResult
      | SuperSubmodulePrepareResult
      | GitSuperResult
    >,
    context,
    params,
  )
  if (invocation.state !== "ready") throw new Error(`git super: command invocation is ${invocation.state}`)
  return Promise.resolve(node.run(context, invocation.params as never))
}

export async function runCli(argv: readonly string[], stdout: OutputSink, stderr: OutputSink): Promise<number> {
  let captured: CapturedInvocation | undefined
  let usage: string | undefined
  const program = new CliCommand("git super")
    .description("Git commands that treat superprojects and submodule interiors as one product")
    .option("--repo <path>", "repository to inspect", ".")
    .option("--json", "emit one stable JSON result")
    .exitOverride()
    .configureOutput({
      writeOut: (value) => stdout.write(value),
      writeErr: (value) => stderr.write(value),
    })

  program
    .command("merge")
    .description(commands.merge.description ?? commands.merge.title)
    .option("-m, --message <message>", "merge commit message")
    .option("--no-verify", "emergency only: bypass ordinary merge and commit hooks")
    .argument("<commit>", "commit to merge into the current branch")
    .action((commit, options, command) => {
      const globals = command.optsWithGlobals() as { repo: string; json?: boolean }
      captured = {
        node: commands.merge,
        params: {
          commit,
          ...(typeof options.message === "string" ? { message: options.message } : {}),
          ...(options.verify === false ? { noVerify: true } : {}),
        },
        json: globals.json === true,
        nul: false,
      }
    })

  program
    .command("pull")
    .description(commands.pull.description ?? commands.pull.title)
    .option("--ff-only", "refuse merge, rebase, stash, force, or conflict resolution")
    .option("--dry-run", "fetch and show the frozen plan without changing a checkout or local branch")
    .argument("[repository]", "remote repository to fetch")
    .argument("[refspecs...]", "root refspecs to fetch")
    .action((repository, refspecs, options, command) => {
      const globals = command.optsWithGlobals() as { repo: string; json?: boolean }
      captured = {
        node: commands.pull,
        params: {
          ...(typeof repository === "string" ? { repository } : {}),
          refspecs,
          ffOnly: options.ffOnly === true,
          ...(options.dryRun === true ? { dryRun: true } : {}),
        },
        json: globals.json === true,
        nul: false,
      }
    })

  program
    .command("push")
    .description(commands.push.description ?? commands.push.title)
    .option(
      "--recurse-submodules <check|on-demand|only|no>",
      "check requires commits on at least one submodule remote; on-demand publishes missing submodules before the root; only publishes submodules; no updates only root refs",
      "check",
    )
    .option("--atomic", "request an atomic update only within each one remote repository")
    .option(
      "--force-with-lease <ref:expect>",
      "require one explicit expected old object; repeat for multiple refs (empty expect means create-only)",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option("--no-verify", "bypass the ordinary local pre-push hook")
    .option("--signed <true|false|if-asked>", "pass Git's signed-push mode")
    .option("-o, --push-option <option...>", "pass push options to the selected remote")
    .argument("[remote]", "remote name or URL; omit it to use Git's configured push remote")
    .argument("[refspecs...]", "exact root source:destination refspecs")
    .action((remote, refspecs, options, command) => {
      const globals = command.optsWithGlobals() as { repo: string; json?: boolean }
      const pushOptions = Array.isArray(options.pushOption)
        ? (options.pushOption as string[])
        : typeof options.pushOption === "string"
          ? [options.pushOption]
          : []
      captured = {
        node: commands.push,
        params: {
          recurseSubmodules: (options.recurseSubmodules ?? "check") as PushParams["recurseSubmodules"],
          ...(typeof remote === "string" ? { remote } : {}),
          refspecs,
          ...(options.atomic === true ? { atomic: true } : {}),
          ...(options.verify === false ? { verify: false } : {}),
          ...(options.signed === undefined ? {} : { signed: options.signed as NonNullable<PushParams["signed"]> }),
          ...(pushOptions.length === 0 ? {} : { pushOptions }),
          ...(Array.isArray(options.forceWithLease) && options.forceWithLease.length > 0
            ? { forceWithLease: options.forceWithLease as string[] }
            : {}),
        },
        json: globals.json === true,
        nul: false,
      }
    })

  const gitlink = program.command("gitlink").description("Inspect or update superproject gitlink entries")
  gitlink
    .command("write")
    .description(commands.gitlink.write.description ?? commands.gitlink.write.title)
    .argument("<path>", "existing root-relative submodule path")
    .argument("<commit>", "exact commit object already present in that submodule repository")
    .action((path, commit, _options, command) => {
      const globals = command.optsWithGlobals() as { repo: string; json?: boolean }
      captured = {
        node: commands.gitlink.write,
        params: { path, commit },
        json: globals.json === true,
        nul: false,
      }
    })

  const submodule = program.command("submodule").description("Inspect or prepare durable direct-component stores")
  submodule
    .command("prepare")
    .description(commands.submodule.prepare.description ?? commands.submodule.prepare.title)
    .requiredOption(
      "--remote <name-or-url>",
      "explicit root remote name or URL used to resolve frozen relative component URLs",
    )
    .argument("<commit>", "exact root commit whose direct gitlinks are prepared")
    .action((commit, options, command) => {
      const globals = command.optsWithGlobals() as { repo: string; json?: boolean }
      const remote = (options as { remote: string }).remote
      captured = {
        node: commands.submodule.prepare,
        params: { commit, remote },
        json: globals.json === true,
        nul: false,
      }
    })

  const worktree = program
    .command("worktree")
    .description("Create worktrees that carry a superproject's submodules")
    // An action handler on the PARENT, so an unknown subcommand reaches this
    // handler instead of Commander's own `unknown command` exit. A bare
    // `worktree` and a misspelled subcommand are the same mistake, and they now
    // get one usage line and one exit code rather than Commander's 1 beside
    // git-super's 2. The excess operand is allowed only so it can be NAMED in
    // the refusal; declaring it as an argument instead would advertise a
    // parameter this command does not have.
    .allowExcessArguments()
    .action((_options, command) => {
      const subcommand = command.args[0]
      usage =
        (subcommand === undefined
          ? "git-super: worktree needs a subcommand\n"
          : `git-super: unknown worktree subcommand '${subcommand}'\n`) + command.helpInformation()
    })
  worktree
    .command("add")
    .description(commands.worktree.add.description ?? commands.worktree.add.title)
    .option("--reference <path>", "repository whose object stores the gitlinks borrow from")
    .argument("<path>", "path the new detached worktree is created at")
    .argument("<commit>", "commit the worktree and every recorded gitlink are placed at")
    .action((path, commit, options, command) => {
      const globals = command.optsWithGlobals() as { repo: string; json?: boolean }
      captured = {
        node: commands.worktree.add,
        params: {
          path,
          commit,
          ...(typeof options.reference === "string" ? { reference: options.reference } : {}),
        },
        json: globals.json === true,
        nul: false,
      }
    })

  program
    .command("diff")
    .description(commands.diff.description ?? commands.diff.title)
    .option("--name-only", "emit root-relative changed paths")
    .option("-z, --null", "terminate paths with NUL instead of newline")
    .option("--cached", "compare the index instead of the working tree")
    .option("--diff-filter <letters>", "select paths by Git diff status")
    .argument("[refs...]", "Git revision range or refs")
    .action((refs, options, command) => {
      const globals = command.optsWithGlobals() as { repo: string; json?: boolean }
      captured = {
        node: commands.diff,
        params: {
          refs,
          ...(options.cached ? { cached: true } : {}),
          ...(options.diffFilter === undefined ? {} : { diffFilter: options.diffFilter }),
        },
        json: globals.json === true,
        nul: options.null === true,
      }
    })

  program
    .command("status")
    .description(commands.status.description ?? commands.status.title)
    .option("--porcelain", "emit stable machine-readable status")
    .option("-z, --null", "terminate records with NUL instead of newline")
    .action((options, command) => {
      const globals = command.optsWithGlobals() as { repo: string; json?: boolean }
      captured = { node: commands.status, params: {}, json: globals.json === true, nul: options.null === true }
    })

  program
    .command("merge-base")
    .description(commands["merge-base"].description ?? commands["merge-base"].title)
    .requiredOption("--is-ancestor", "test whether the first commit is an ancestor of the second")
    .argument("<ancestor>", "commit whose owning repository should be discovered")
    .argument("<descendant>", "commit or superproject ref to compare")
    .action((ancestor, descendant, _options, command) => {
      const globals = command.optsWithGlobals() as { repo: string; json?: boolean }
      captured = {
        node: commands["merge-base"],
        params: { ancestor, descendant },
        json: globals.json === true,
        nul: false,
      }
    })

  try {
    await program.parseAsync(["bun", "git-super", ...argv])
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode
    throw error
  }
  if (usage !== undefined) {
    stderr.write(usage.endsWith("\n") ? usage : `${usage}\n`)
    return 2
  }
  if (captured === undefined) return 0

  const globals = program.opts() as { repo: string }
  let result:
    | SuperDiffResult
    | SuperStatusResult
    | SuperIsAncestorResult
    | SuperMergeResult
    | SuperSubmodulePrepareResult
    | GitSuperResult
  try {
    result = await commandResult(captured.node, { repo: globals.repo }, captured.params)
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
  if (captured.json) {
    stdout.write(stableJson(result))
  } else if (captured.node === commands.diff) {
    const diff = result as SuperDiffResult
    if (diff.paths.length > 0) {
      stdout.write(`${diff.paths.join(captured.nul ? "\0" : "\n")}${captured.nul ? "\0" : "\n"}`)
    }
    await writeReport(diff.consultedRepositories, stderr)
  } else if (captured.node === commands.status) {
    const status = result as SuperStatusResult
    if (status.records.length > 0) {
      stdout.write(`${status.records.join(captured.nul ? "\0" : "\n")}${captured.nul ? "\0" : "\n"}`)
    }
    await writeReport(status.consultedRepositories, stderr)
  } else if (captured.node === commands["merge-base"]) {
    await writeReport((result as SuperIsAncestorResult).consultedRepositories, stderr)
  } else if (captured.node === commands.merge) {
    const merge = result as SuperMergeResult
    if (merge.commit !== undefined) stdout.write(`${merge.commit}\n`)
    for (const gitlink of merge.gitlinks) {
      stderr.write(
        gitlink.state === "raised"
          ? `${gitlink.path} ${gitlink.from.slice(0, 7)} -> ${gitlink.to.slice(0, 7)} (component main)\n`
          : gitlink.state === "left-off-main"
            ? `left-off-main ${gitlink.path} ${gitlink.from} (component main ${gitlink.to})\n`
            : `not-run ${gitlink.path} ${gitlink.from} -> ${gitlink.to} (component main)\n`,
      )
    }
    if (merge.partial) {
      for (const checkout of merge.checkouts ?? []) {
        stderr.write(
          `checkout-state ${checkout.path} recorded=${checkout.recorded} staged-index=${checkout.index} checkout=${checkout.checkout ?? "unreadable"} pre-checkout=${checkout.preCheckout} state=${checkout.state}\n`,
        )
      }
    }
    if (merge.detail !== undefined) stderr.write(`${merge.detail.message}\n`)
  } else {
    const pull = result as GitSuperResult
    stdout.write(`${pull.state}\n`)
    if (pull.detail !== undefined) stderr.write(`${pull.detail.message}\n`)
  }

  if (captured.node === commands["merge-base"] && !(result as SuperIsAncestorResult).isAncestor) return 1
  if (captured.node === commands.merge) {
    const merge = result as SuperMergeResult
    if (merge.state === "updated" || merge.state === "unchanged") return 0
    return merge.partial ? 2 : 1
  }
  if (
    captured.node === commands.pull ||
    captured.node === commands.push ||
    captured.node === commands.gitlink.write ||
    captured.node === commands.submodule.prepare ||
    captured.node === commands.worktree.add
  ) {
    const operation = result as GitSuperResult
    return operation.state === "updated" || operation.state === "unchanged" ? 0 : 2
  }
  return 0
}
