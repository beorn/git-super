import type { CommandNode } from "@silvery/command"
import {
  type commands,
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
  type WorktreeRemoveParams,
} from "./commands.ts"
import type { ConsultedRepository, SuperDiffResult } from "./diff.ts"
import type { SuperIsAncestorResult } from "./merge-base.ts"
import type { SuperMergeResult } from "./merge.ts"
import type { GitSuperResult } from "./result.ts"
import type { SuperStatusResult } from "./status.ts"
import type { SuperSubmodulePrepareResult } from "./submodule-prepare.ts"
import { delegateNativeGit, readNativeGit, type ProcessOutputSink } from "./process.ts"
import { openInvocationProtocol, type InvocationProtocol } from "./protocol.ts"

export type OutputSink = ProcessOutputSink &
  Readonly<{
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
  | Readonly<{ node: typeof commands.worktree.remove; params: WorktreeRemoveParams; json: boolean; nul: boolean }>

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
  const { renderConsultedRepositories } = await import("./report.tsx")
  const report = await renderConsultedRepositories(repositories, {
    plain: !stderr.isTTY,
    width: stderr.columns ?? 100,
  })
  stderr.write(`${report}\n`)
}

async function commandResult(
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
  const { resolveInvocation } = await import("@silvery/command")
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

// Only these existing operations interpret superproject topology. Ordinary Git
// commands are delegated by default; there is no registry of native commands.
const ENRICHED_COMMANDS = new Set(["diff", "status", "merge-base", "merge", "pull", "push", "worktree"])

function inputObjects(command: string, args: readonly string[]): readonly { argument: string; object: string }[] {
  if (command === "status") return []
  if (command === "pull") throw new Error("implicit pull does not identify its incoming objects")
  const operands: string[] = []
  let options = true
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === undefined) break
    if (options && arg === "--") {
      if (command === "diff") break // The remaining words are paths, not revisions.
      options = false
    } else if (options && arg.startsWith("-")) {
      if (["-m", "--message", "-b", "-B"].includes(arg)) index += 1
      else if (
        ![
          "--quiet",
          "-q",
          "--atomic",
          "--no-verify",
          "--is-ancestor",
          "--cached",
          "--staged",
          "--name-only",
          "--name-status",
          "--stat",
          "-z",
          "--no-ff",
          "--ff-only",
          "--no-edit",
          "--detach",
          "--dry-run",
          "-n",
        ].includes(arg) &&
        !arg.startsWith("--force-with-lease=") &&
        !arg.startsWith("--message=")
      ) {
        throw new Error(`implicit ${command} cannot determine input objects for option '${arg}'`)
      }
    } else operands.push(arg)
  }
  if (command === "push") {
    const refspecs = operands.slice(1) // The first operand is Git's remote, never an object.
    if (refspecs.length === 0) throw new Error("implicit push requires explicit source refspecs")
    return refspecs.map((argument) => {
      const object = argument.replace(/^\+/u, "").split(":")[0] ?? ""
      if (object === "" || object.includes("*")) {
        throw new Error(`implicit push cannot determine objects for '${argument}'`)
      }
      return { argument, object }
    })
  }
  if (command === "worktree") return [{ argument: operands[2] ?? "HEAD", object: operands[2] ?? "HEAD" }]
  return operands.flatMap((argument) =>
    argument.split(/\.{2,3}/u).map((object) => ({ argument, object: object || "HEAD" })),
  )
}

async function enrichedInvocation(argv: readonly string[]): Promise<readonly string[] | undefined> {
  // Explicit extension calls retain their existing parser and result contract.
  if (argv.length === 0 || argv[0] === "--repo" || argv[0]?.startsWith("--repo=") || argv[0] === "--json") return argv
  if (
    argv[0] === "-h" ||
    argv[0] === "--help" ||
    argv[0] === "gitlink" ||
    (argv[0] === "submodule" && ["prepare", "-h", "--help"].includes(argv[1] ?? ""))
  ) {
    return argv
  }
  if (argv[0] === "--version" || argv[0] === "-v") return undefined
  if (ENRICHED_COMMANDS.has(argv[0] ?? "") && (argv[1] === "-h" || argv[1] === "--help")) return argv

  let commandIndex = 0
  while (argv[commandIndex]?.startsWith("-")) {
    const option = argv[commandIndex]
    if (option === undefined) break
    if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(option)) {
      if (argv[commandIndex + 1] === undefined) return undefined // Native Git diagnoses the missing operand.
      commandIndex += 2
    } else if (
      /^(?:--(?:git-dir|work-tree|namespace|config-env)=|-C.|-c.)/u.test(option) ||
      [
        "--no-pager",
        "--paginate",
        "--no-optional-locks",
        "--literal-pathspecs",
        "--no-literal-pathspecs",
        "--glob-pathspecs",
        "--noglob-pathspecs",
        "--icase-pathspecs",
        "--no-replace-objects",
      ].includes(option)
    ) {
      commandIndex += 1
    } else {
      throw new Error(`git-super: cannot select an operation with unsupported global option '${option}'`)
    }
  }
  const command = argv[commandIndex]
  if (command === undefined || !ENRICHED_COMMANDS.has(command)) return undefined
  if (command === "worktree" && argv[commandIndex + 1] !== "add") return undefined
  const globals = argv.slice(0, commandIndex)
  const bare = await readNativeGit([...globals, "rev-parse", "--is-bare-repository"])
  if (bare.code !== 0 || !["true\n", "false\n"].includes(bare.stdout)) {
    throw new Error(`git-super: cannot determine repository topology for ${argv.join(" ")}\n${bare.stderr}`)
  }
  const root = await readNativeGit([
    ...globals,
    "rev-parse",
    bare.stdout === "true\n" ? "--absolute-git-dir" : "--show-toplevel",
  ])
  if (root.code !== 0) throw new Error(`git-super: cannot locate repository for ${argv.join(" ")}\n${root.stderr}`)
  const repo = root.stdout.trim()
  const refuse = (reason: string) =>
    new Error(
      `git-super: ${command}: ${reason}. Use the explicit git-super --repo ${repo} interface; implicit superproject operation contracts are not yet supported.`,
    )
  let objects: readonly { argument: string; object: string }[]
  try {
    objects = inputObjects(command, argv.slice(commandIndex + 1))
  } catch (error) {
    throw refuse(error instanceof Error ? error.message : String(error))
  }
  const tree = await readNativeGit([...globals, "ls-files", "--stage", "-z"])
  // failure to measure topology is not evidence of a plain repository
  if (tree.code !== 0) {
    throw refuse(`cannot read the index for ${argv.join(" ")}\n${tree.stderr}`)
  }
  const { readCommitSubmodules } = await import("./commit-graph.ts")
  // Reuse the existing strict tree reader. These reads only identify ambiguity;
  // they do not choose composition or recovery semantics for the operation.
  const git = { run: (request: { args: readonly string[] }) => readNativeGit([...globals, ...request.args]) }
  for (const { argument, object } of [...objects, { argument: "HEAD", object: "HEAD" }]) {
    const resolved = await readNativeGit([
      ...globals,
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${object}^{tree}`,
    ])
    // Git's quiet verification returns 1 for an absent/non-tree object, including
    // an unborn HEAD. The actual command retains responsibility for that error.
    if (resolved.code === 1 && resolved.stderr === "") continue
    if (resolved.code !== 0) throw refuse(`cannot inspect argument '${argument}'\n${resolved.stderr}`)
    let hasGitlinks: boolean
    try {
      hasGitlinks = (await readCommitSubmodules(git, repo, resolved.stdout.trim())).length > 0
    } catch (error) {
      throw refuse(`cannot classify argument '${argument}': ${error instanceof Error ? error.message : String(error)}`)
    }
    if (hasGitlinks) {
      throw refuse(
        `argument '${argument}' carries gitlinks against this ${bare.stdout === "true\n" ? "bare" : "worktree"} context`,
      )
    }
  }
  if (tree.stdout.split("\0").some((entry) => entry.startsWith("160000 "))) throw refuse("the index carries gitlinks")
  return undefined
}

export async function runCli(
  argv: readonly string[],
  stdout: OutputSink,
  stderr: OutputSink,
  replaceProcess = false,
): Promise<number> {
  if (!argv[0]?.startsWith("--protocol-fd")) return runInvocation(argv, stdout, stderr, replaceProcess)
  let protocol: InvocationProtocol | undefined
  let code = 1
  try {
    if (argv[0] !== "--protocol-fd=3") throw new Error("git-super: the control option must be --protocol-fd=3")
    protocol = await openInvocationProtocol()
    code = await runInvocation(argv.slice(1), stdout, stderr, replaceProcess, protocol)
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  } finally {
    try {
      await protocol?.close()
    } catch (error) {
      stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      code = 1
    }
  }
  return code
}

async function runInvocation(
  argv: readonly string[],
  stdout: OutputSink,
  stderr: OutputSink,
  replaceProcess: boolean,
  protocol?: InvocationProtocol,
): Promise<number> {
  let delegated = false
  try {
    const enriched = await enrichedInvocation(argv)
    // execve on the executable path leaves native Git owning the PID, byte
    // streams and cancellation. In-process callers retain their process owner.
    if (enriched === undefined) {
      delegated = true
      await protocol?.close()
      return await delegateNativeGit(argv, stdout, stderr, replaceProcess)
    }
    argv = enriched
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    stderr.write(`${message}\n`)
    if (!delegated) await protocol?.refuse("unjudged", message)
    return 1
  }
  const [{ Command: CliCommand, CommanderError }, { commands }] = await Promise.all([
    import("@silvery/commander"),
    import("./commands.ts"),
  ])
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

  worktree
    .command("remove")
    .description(commands.worktree.remove.description ?? commands.worktree.remove.title)
    .requiredOption("--retain <directory>", "durable directory outside the worktree and its Git directory")
    .argument("<path>", "registered clean worktree to remove")
    .action((path, _options, command) => {
      const globals = command.optsWithGlobals() as { repo: string; json?: boolean }
      const options = command.opts() as { retain: string }
      captured = {
        node: commands.worktree.remove,
        params: { path, retain: options.retain },
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
    .option("--stat", "show per-repository diffstat, including each moved gitlink's own component diff")
    .option("-p, --patch", "show per-repository patch, including each moved gitlink's own component diff")
    .argument("[refs...]", "Git revision range or refs")
    .action((refs, options, command) => {
      const globals = command.optsWithGlobals() as { repo: string; json?: boolean }
      captured = {
        node: commands.diff,
        params: {
          refs,
          ...(options.cached ? { cached: true } : {}),
          ...(options.diffFilter === undefined ? {} : { diffFilter: options.diffFilter }),
          ...(options.stat === true ? { stat: true } : {}),
          ...(options.patch === true ? { patch: true } : {}),
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
    result = await commandResult(
      captured.node,
      { repo: globals.repo, report: (message) => stderr.write(message) },
      captured.params,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    stderr.write(`${message}\n`)
    await protocol?.refuse("unjudged", message)
    return 2
  }
  await writeResult(captured, result, stdout, stderr, commands)

  if (captured.node === commands["merge-base"] && !(result as SuperIsAncestorResult).isAncestor) return 1
  if (captured.node === commands.merge) {
    const merge = result as SuperMergeResult
    if (merge.state === "updated" || merge.state === "unchanged") return 0
    await protocol?.refuse(
      "unjudged",
      merge.detail?.message ?? `Merge in ${globals.repo} ended ${merge.state}; its outcome requires reconciliation.`,
    )
    return merge.partial ? 2 : 1
  }
  if (
    captured.node === commands.pull ||
    captured.node === commands.push ||
    captured.node === commands.gitlink.write ||
    captured.node === commands.submodule.prepare ||
    captured.node === commands.worktree.add ||
    captured.node === commands.worktree.remove
  ) {
    const operation = result as GitSuperResult
    if (operation.state !== "updated" && operation.state !== "unchanged") {
      await protocol?.refuse(
        "unjudged",
        operation.detail?.message ??
          `Operation in ${globals.repo} ended ${operation.state}; its outcome requires reconciliation.`,
      )
    }
    return operation.state === "updated" || operation.state === "unchanged" ? 0 : 2
  }
  return 0
}

async function writeResult(
  captured: CapturedInvocation,
  result: Awaited<ReturnType<typeof commandResult>>,
  stdout: OutputSink,
  stderr: OutputSink,
  nodes: typeof commands,
): Promise<void> {
  if (captured.json) {
    stdout.write(stableJson(result))
  } else if (captured.node === nodes.diff) {
    const diff = result as SuperDiffResult
    if (diff.paths.length > 0) {
      stdout.write(`${diff.paths.join(captured.nul ? "\0" : "\n")}${captured.nul ? "\0" : "\n"}`)
    }
    for (const stat of diff.stats ?? []) {
      stdout.write(`\n== ${stat.repository} ==\n`)
      for (const file of stat.files) {
        stdout.write(` ${file.path} | ${file.binary ? "Bin" : `+${file.added} -${file.deleted}`}\n`)
      }
      stdout.write(
        ` ${stat.totals.files} file${stat.totals.files === 1 ? "" : "s"} changed, ` +
          `${stat.totals.added} insertion${stat.totals.added === 1 ? "" : "s"}(+), ` +
          `${stat.totals.deleted} deletion${stat.totals.deleted === 1 ? "" : "s"}(-)\n`,
      )
      for (const move of stat.pointerMoves) {
        stdout.write(` ${move.path}: pointer ${move.from.slice(0, 7)} -> ${move.to.slice(0, 7)}\n`)
      }
    }
    for (const patch of diff.patches ?? []) {
      stdout.write(`\n== ${patch.repository} ==\n${patch.patch}`)
    }
    await writeReport(diff.consultedRepositories, stderr)
  } else if (captured.node === nodes.status) {
    const status = result as SuperStatusResult
    if (status.records.length > 0) {
      stdout.write(`${status.records.join(captured.nul ? "\0" : "\n")}${captured.nul ? "\0" : "\n"}`)
    }
    await writeReport(status.consultedRepositories, stderr)
  } else if (captured.node === nodes["merge-base"]) {
    await writeReport((result as SuperIsAncestorResult).consultedRepositories, stderr)
  } else if (captured.node === nodes.merge) {
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
}
