import type { RetentionEnrollReport } from "./worktree-removal.ts"
import type { RetentionEnrollParams } from "./commands.ts"
import type { CommandNode } from "@silvery/command"
import { constants as osConstants } from "node:os"
import {
  type commands,
  type CommandContext,
  type DiffParams,
  type GitlinkWriteParams,
  type MergeBaseParams,
  type MergeParams,
  type PullParams,
  type PushParams,
  type PrivateStoreVerifyNode,
  type PrivateStoreVerifyParams,
  type RetentionCompactParams,
  type RetentionVerifyParams,
  type RetentionRetireParams,
  type StatusParams,
  type SubmodulePrepareParams,
  type WorktreeAddParams,
  type WorktreeRemoveParams,
} from "./commands.ts"
import type { ConsultedRepository, SuperDiffResult } from "./diff.ts"
import type { SuperIsAncestorResult } from "./merge-base.ts"
import type { SuperMergeResult } from "./merge.ts"
import type { GitSuperResult } from "./result.ts"
import type { RetentionVerifyResult } from "./retention-verify.ts"
import type { CompactRetainedRootReport } from "./retention-compact.ts"
import type { PrivateStoreCandidateResult } from "./private-store-candidate.ts"
import type { SuperStatusResult } from "./status.ts"
import type { SuperSubmodulePrepareResult } from "./submodule-prepare.ts"
import { delegateNativeGit, readNativeGit, type ProcessOutputSink } from "./process.ts"
import { openInvocationProtocol, type InvocationProtocol } from "./protocol.ts"
import { isAbsolute } from "node:path"
import {
  probeRepository,
  repositoryRoot,
  runGit,
  validateGitObjectContext,
  withGitEnvironment,
  type GitObjectContext,
} from "./git.ts"

export type OutputSink = ProcessOutputSink &
  Readonly<{
    isTTY?: boolean
    columns?: number
  }>

type CapturedInvocation =
  | CapturedEnrollment
  | Readonly<{
      node: typeof commands.worktree.retention.retire | typeof commands.worktree.retention.audit
      params: RetentionRetireParams
      json: boolean
      nul: boolean
    }>
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
  | Readonly<{
      node: typeof commands.worktree.retention.verify
      params: RetentionVerifyParams
      json: boolean
      nul: boolean
    }>
  | Readonly<{
      node: PrivateStoreVerifyNode
      params: PrivateStoreVerifyParams
      json: boolean
      nul: boolean
    }>
  | Readonly<{
      node: typeof commands.worktree.retention.compact
      params: RetentionCompactParams
      json: boolean
      nul: boolean
    }>

type CapturedEnrollment = Readonly<{
  node: typeof commands.worktree.retention.enroll
  params: RetentionEnrollParams
  json: boolean
  nul: boolean
}>

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
  | RetentionVerifyResult
  | RetentionEnrollReport
  | CompactRetainedRootReport
  | PrivateStoreCandidateResult
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
      | RetentionVerifyResult
      | RetentionEnrollReport
      | PrivateStoreCandidateResult
      | GitSuperResult
    >,
    context,
    params,
  )
  if (invocation.state === "invalid") throw invocation.error
  if (invocation.state !== "ready") throw new Error(`git super: command invocation is ${invocation.state}`)
  return Promise.resolve(node.run(context, invocation.params as never))
}

// Only these existing operations interpret superproject topology. Ordinary Git
// commands are delegated by default; there is no registry of native commands.
const ENRICHED_COMMANDS = new Set(["diff", "status", "merge-base", "merge", "pull", "push", "worktree"])
const OWNED_WORKTREE_SUBCOMMANDS = new Set(["add", "remove", "retention", "private-store"])

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
      if (["-m", "--message", "-b", "-B", "--expected-head", "--expected-branch"].includes(arg)) index += 1
      else if (
        ![
          "--quiet",
          "-q",
          "--atomic",
          "--no-verify",
          "--no-fetch",
          "--unbounded-local-main",
          "--preserve-conflicts",
          "--continue",
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
        !arg.startsWith("--message=") &&
        !arg.startsWith("--expected-head=") &&
        !arg.startsWith("--expected-branch=")
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

/**
 * The tree a `status` caller named with a bare path argument. `status` declares no
 * positional, so a path here is the caller naming the tree they meant - not a
 * pathspec. The refusal's cure reads it so the named command addresses THAT tree
 * instead of the CWD repo (28962). Returns undefined when no path was given; the
 * value options that DO take a following word are skipped whole.
 */
function statusPathArgument(args: readonly string[]): string | undefined {
  const valueOptions = new Set(["--exclude-submodule", "--index-file"])
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === undefined) continue
    if (argument.startsWith("-")) {
      if (valueOptions.has(argument)) index += 1
      continue
    }
    return argument
  }
  return undefined
}

/**
 * The absolute work tree a `status` caller's path names - but only when that path
 * IS a work tree root. --repo <path> refuses a subdirectory ('is not a worktree
 * root; its git dir resolves to the parent repository'), so naming one prints a
 * cure that cannot run; a file or an empty directory is the same (@cto, @dev/12,
 * 28962). The probe runs THROUGH the caller's own globals, so a relative path
 * resolves against the directory the implicit git context already uses, and the
 * cure prints the absolute toplevel the explicit call needs.
 */
async function namesRepositoryPath(globals: readonly string[], path: string | undefined): Promise<string | undefined> {
  if (path === undefined) return undefined
  const probe = await readNativeGit([...globals, "-C", path, "rev-parse", "--show-toplevel", "--show-prefix"])
  if (probe.code !== 0) return undefined
  const [toplevel, prefix] = probe.stdout.split("\n")
  if (toplevel === undefined || (prefix ?? "").trim() !== "") return undefined
  return toplevel.trim()
}

async function enrichedInvocation(argv: readonly string[]): Promise<readonly string[] | undefined> {
  // Explicit extension calls retain their existing parser and result contract.
  // The gate below refuses the IMPLICIT form, where gitlinks make the answer
  // ambiguous. commander accepts the global --repo AFTER its subcommand, so
  // `status --repo <path>` is an explicit call; reading --repo only at argv[0], it
  // was judged against the CWD and refused with a cure for the wrong tree (28962).
  // A leading native Git global (-C, --no-pager, ...) must never reach commander,
  // so --repo counts as explicit only when the argv opens with the subcommand.
  // Tokens after `--` are operands: a diff pathspec named --repo is not the option.
  const endOfOptions = argv.indexOf("--")
  const beforeOperands = endOfOptions === -1 ? argv : argv.slice(0, endOfOptions)
  const namesRepository =
    argv[0] === "--repo" ||
    argv[0]?.startsWith("--repo=") === true ||
    (ENRICHED_COMMANDS.has(argv[0] ?? "") &&
      beforeOperands.some((argument) => argument === "--repo" || argument.startsWith("--repo=")))
  if (
    argv.length === 0 ||
    namesRepository ||
    argv[0] === "--json" ||
    argv[0]?.startsWith("--object-directory") ||
    argv[0]?.startsWith("--alternate-object-directory")
  ) {
    return argv
  }
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
  if (command === "worktree") {
    if (!OWNED_WORKTREE_SUBCOMMANDS.has(argv[commandIndex + 1] ?? "")) return undefined
    return argv
  }
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
  // The refusal's cure must name a tree that actually works: the work tree the
  // caller's path names when that path is one, else the CWD repo. It named the CWD
  // repo unconditionally, so a sweep reading a yrd environment got a cure for
  // /hh/dev - a tree it did not ask about - and the path was dropped without a word
  // (28962).
  const statusPath = command === "status" ? statusPathArgument(argv.slice(commandIndex + 1)) : undefined
  const cure = (await namesRepositoryPath(globals, statusPath)) ?? repo
  // The refusal must name the tree it judged AND a command that runs there. "this
  // worktree context" told a reader neither which tree was read nor how to retry,
  // so a clean check that spans submodules was unreachable without guessing --repo
  // (30539).
  const context = bare.stdout === "true\n" ? `bare context (${repo})` : `worktree context (${repo})`
  const refuse = (reason: string) =>
    new Error(
      `git-super: ${command}: ${reason}. Use the explicit git-super --repo ${cure} ${command} … interface; implicit superproject operation contracts are not yet supported.`,
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
      throw refuse(`argument '${argument}' carries gitlinks against this ${context}`)
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
  if (argv[0] === "observe") argv = ["super", ...argv]
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
  const observationArgs = argv[0] === "super" && argv[1] === "observe" ? argv.slice(2) : undefined
  if (observationArgs !== undefined) {
    if (protocol !== undefined) {
      throw new Error("super observe uses stdin/stdout, not the ordinary Git control descriptor")
    }
    const { observeCli } = await import("./observe.ts")
    return observeCli(observationArgs, process.cwd(), stdout)
  }
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
    // A refusal to select or measure exits 2, like every commandResult refusal
    // below. It must never exit 1: for merge-base that code is a measured verdict
    // ("not an ancestor"), and the post-land audit read a superproject's
    // "carries gitlinks ... use --repo" refusal as its settled pin being
    // unreachable (2026-09-10, @i/1-instruments/24411).
    return 2
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
    .option("--object-directory <absolute-path>", "host-selected object directory; requires explicit absolute --repo")
    .option(
      "--alternate-object-directory <absolute-path>",
      "host-selected alternate object directory, in search order; requires --object-directory and explicit --repo",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .addHelpText("after", "\nObservation protocol: git-super super observe --protocol=1 < captured-root.json\n")
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
    .option("--preserve-conflicts", "leave ordinary conflicts pending on the current branch")
    .option("--continue", "finish a resolved pending merge using the required caller expectations")
    .option("--expected-head <oid>", "original HEAD required by --continue")
    .option("--expected-branch <full-ref>", "original symbolic branch required by --continue")
    .option(
      "--exclude-submodule <path>",
      "exclude an empty root-direct submodule whose HEAD, target and sole merge-base pin are unchanged",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option(
      "--no-fetch",
      "reuse untouched Equal main observations under ten minutes old; fetch moved, unequal or expired mains",
    )
    .option(
      "--unbounded-local-main",
      "with --no-fetch, read unchanged Equal child mains locally without a refresh age bound",
    )
    .option(
      "--no-retain-pins",
      "preview only: write no refs/git-super/pins and push no composed child; the caller keeps custody of the result",
    )
    .argument("<commit>", "commit to merge into the current branch")
    .action((commit, options, command) => {
      const globals = command.optsWithGlobals() as { repo: string; json?: boolean }
      captured = {
        node: commands.merge,
        params: {
          commit,
          ...(typeof options.message === "string" ? { message: options.message } : {}),
          ...(options.verify === false ? { noVerify: true } : {}),
          ...(options.preserveConflicts === true ? { preserveConflicts: true } : {}),
          ...(options.continue === true ? { continue: true } : {}),
          ...(typeof options.expectedHead === "string" ? { expectedHead: options.expectedHead } : {}),
          ...(typeof options.expectedBranch === "string" ? { expectedBranch: options.expectedBranch } : {}),
          ...(options.excludeSubmodule === undefined || options.excludeSubmodule.length === 0
            ? {}
            : { excludedSubmodules: options.excludeSubmodule }),
          ...(options.fetch === false ? { noFetch: true } : {}),
          ...(options.unboundedLocalMain === true ? { unboundedLocalMain: true } : {}),
          ...(options.retainPins === false ? { retainPins: false } : {}),
        },
        json: globals.json === true,
        nul: false,
      }
    })

  program
    .command("pull")
    .description(commands.pull.description ?? commands.pull.title)
    .option(
      "--exclude-submodule <path>",
      "exclude an empty uninitialized literal root-relative submodule and its descendants before content access",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
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
          ...(options.excludeSubmodule === undefined ? {} : { excludedSubmodules: options.excludeSubmodule }),
          ...(options.dryRun === true ? { dryRun: true } : {}),
          // GIT_SUPER_PROGRESS=1 reports each phase to stderr as it starts. An environment switch, not a flag: a
          // caller that sets it still works against an older git-super, which ignores it, so a half-landed update
          // that moved the caller before this binary cannot wedge every pull on an unknown option (24907).
          ...(process.env.GIT_SUPER_PROGRESS === "1" ? { progress: true } : {}),
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
      "check requires commits on at least one submodule remote; on-demand publishes missing submodules before the root (to refs/git-super/pins/<sha> unless the root destination is main, which publishes to refs/heads/<branch> from .gitmodules); only publishes submodules the same way; no updates only root refs",
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
          ...(process.env.GIT_SUPER_PROGRESS === "1" ? { progress: true } : {}),
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

  const submodule = program.command("submodule").description("Inspect or prepare durable direct-submodule stores")
  submodule
    .command("prepare")
    .description(commands.submodule.prepare.description ?? commands.submodule.prepare.title)
    .requiredOption(
      "--remote <name-or-url>",
      "explicit root remote name or URL used to resolve frozen relative submodule URLs",
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
    .option(
      "--exclude-submodule <path>",
      "leave a literal root-relative submodule and descendants empty and uninitialized; no init, store or gitfile",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .argument("<path>", "path the new detached worktree is created at")
    .argument("<commit>", "commit the worktree and every recorded gitlink are placed at")
    .action((path, commit, options, command) => {
      const globals = command.optsWithGlobals() as { repo: string; json?: boolean }
      const excluded = (options as { excludeSubmodule?: string[] }).excludeSubmodule
      captured = {
        node: commands.worktree.add,
        params: {
          path,
          commit,
          ...(typeof options.reference === "string" ? { reference: options.reference } : {}),
          ...(excluded?.length ? { excludedSubmodules: excluded } : {}),
        },
        json: globals.json === true,
        nul: false,
      }
    })

  worktree
    .command("remove")
    .description(commands.worktree.remove.description ?? commands.worktree.remove.title)
    .requiredOption("--retain <directory>", "durable directory outside the worktree and its Git directory")
    .option("--component-custody <json>", "prove every component commit has durable custody in the named primary store")
    .option("--no-rehome", "keep a lender with borrowers instead of changing their object stores")
    .option(
      "--exclude-submodule <path>",
      "exclude a literal root-relative submodule and descendants before content access",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option(
      "--preserved <ref>",
      "admit a dirty store for removal only against a ref (comma-separated, repeatable) that resolves to a commit in that same store",
      (value: string, previous: string[]) => [...previous, ...value.split(",").filter((ref) => ref !== "")],
      [],
    )
    .argument("<path>", "registered clean worktree to remove")
    .action((path, _options, command) => {
      const globals = command.optsWithGlobals() as { repo: string; json?: boolean }
      const options = command.opts() as {
        retain: string
        excludeSubmodule?: string[]
        preserved?: string[]
        rehome: boolean
        componentCustody?: string
      }
      const invocation: Extract<CapturedInvocation, { node: typeof commands.worktree.remove }> = {
        node: commands.worktree.remove,
        params: {
          path,
          retain: options.retain,
          ...(options.rehome === false ? { noRehome: true } : {}),
          ...(options.componentCustody === undefined
            ? {}
            : {
                componentCustody: JSON.parse(options.componentCustody) as NonNullable<
                  WorktreeRemoveParams["componentCustody"]
                >,
              }),
          ...(options.excludeSubmodule?.length ? { excludedSubmodules: options.excludeSubmodule } : {}),
          ...(options.preserved?.length ? { preserved: options.preserved } : {}),
        },
        json: globals.json === true,
        nul: false,
      }
      captured = invocation
    })

  const retention = worktree
    .command("retention")
    .description(
      "Verify, audit, compact, enroll borrowers, or explicitly retire one retained entry under existing leases",
    )
    .allowExcessArguments()
    .action((_options, command) => {
      const subcommand = command.args[0]
      usage =
        (subcommand === undefined
          ? "git-super: worktree retention needs verify, audit, compact, enroll, or retire\n"
          : `git-super: unknown worktree retention subcommand '${subcommand}'; choose verify, audit, compact, enroll, or retire\n`) +
        command.helpInformation()
    })
  retention
    .command("verify")
    .description("Read one retained entry and refuse or report incomplete unless every gate passes")
    .requiredOption("--root <directory>", "the declared retained-modules root this entry is a direct child of")
    .option(
      "--namespace <path>",
      "a managed root whose object stores and borrower registries belong to the estate",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option(
      "--artifact-dir <directory>",
      "external, caller-owned pass directory for the non-object metadata sidecar and the certificate",
    )
    .argument("<entry>", "retained entry directory to verify")
    .action((entry, _options, command) => {
      const globals = command.optsWithGlobals() as { repo: string; json?: boolean }
      const options = command.opts() as {
        root: string
        namespace?: string[]
        artifactDir?: string
      }
      const namespaces = options.namespace
      captured = {
        node: commands.worktree.retention.verify,
        params: {
          entry,
          root: options.root,
          ...(namespaces === undefined || namespaces.length === 0 ? {} : { namespaceRoots: namespaces }),
          ...(options.artifactDir === undefined ? {} : { artifactDir: options.artifactDir }),
        },
        json: globals.json === true,
        nul: false,
      }
    })

  for (const verb of ["retire", "audit"] as const) {
    retention
      .command(verb)
      .description(
        verb === "retire"
          ? "Retire one eligible retained entry after held-lease revalidation; never unlock a lender"
          : "Publish immutable audit evidence under existing leases; preserve the original and entry",
      )
      .argument(
        "<entry>",
        verb === "retire" ? "the retained entry to retire" : "the retained entry to audit without removal",
      )
      .requiredOption("--root <directory>", "declared retained-modules root")
      .requiredOption("--common <directory>", "Git common directory for the existing mutation lease")
      .requiredOption(
        "--namespace <path>",
        "complete managed namespace; repeat for every root",
        (value: string, previous: string[]) => [...previous, value],
        [],
      )
      .requiredOption("--artifact-dir <directory>", "external durable directory for preliminary and held proofs")
      .action((entry, _options, command) => {
        const globals = command.optsWithGlobals() as { json?: boolean }
        const options = command.opts() as { root: string; common: string; namespace: string[]; artifactDir: string }
        captured = {
          node: commands.worktree.retention[verb],
          params: {
            entry,
            root: options.root,
            common: options.common,
            namespaceRoots: options.namespace,
            artifactDir: options.artifactDir,
          },
          json: globals.json === true,
          nul: false,
        }
      })
  }

  retention
    .command("enroll")
    .description(
      "Plan retained linked-store borrowers; --apply writes existing registry pointers under the common lease",
    )
    .requiredOption("--root <directory>", "declared retained root whose immediate entries are inspected")
    .requiredOption("--common <directory>", "Git common directory whose borrowers are registered")
    .option("--apply", "recompute under the common writer lease and register the exact proposed pointers")
    .action((_options, command) => {
      const globals = command.optsWithGlobals() as { json?: boolean }
      const options = command.opts() as { root: string; common: string; apply?: boolean }
      captured = {
        node: commands.worktree.retention.enroll,
        params: { root: options.root, common: options.common, ...(options.apply === true ? { apply: true } : {}) },
        json: globals.json === true,
        nul: false,
      }
    })

  retention
    .command("compact")
    .description(
      "Pack refs and drop remote-tracking reflogs on each eligible child of a declared retained-modules root — C1's post-close compaction, extended to older stock. Drops remote-tracking reflogs; keeps local reflogs. Never removes an entry.",
    )
    .requiredOption("--root <directory>", "the declared retained-modules root whose direct children are compacted")
    .option("--dry-run", "verify each eligible child's copy and report the forecast without writing")
    .option("--limit <count>", "compact at most this many eligible children, in sorted order", (value) => {
      const parsed = Number(value)
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`git-super: --limit must be a non-negative whole number, got '${value}'`)
      }
      return parsed
    })
    .action((_options, command) => {
      const globals = command.optsWithGlobals() as { repo: string; json?: boolean }
      const options = command.opts() as { root: string; dryRun?: boolean; limit?: number }
      captured = {
        node: commands.worktree.retention.compact,
        params: {
          root: options.root,
          ...(options.dryRun === true ? { dryRun: true } : {}),
          ...(options.limit === undefined ? {} : { limit: options.limit }),
        },
        json: globals.json === true,
        nul: false,
      }
    })

  // #27120 AC1: the read-only half of the ruled retirement route for an initialized private
  // submodule. It answers one metadata question and is never removal authority.
  const privateStore = worktree
    .command("private-store")
    .description("Read-only candidate check for one private submodule store")
    .allowExcessArguments()
    .action((_options, command) => {
      const subcommand = command.args[0]
      usage =
        (subcommand === undefined
          ? "git-super: worktree private-store needs a subcommand\n"
          : `git-super: unknown worktree private-store subcommand '${subcommand}'\n`) + command.helpInformation()
    })
  privateStore
    .command("verify")
    .description(
      commands.worktree["private-store"].verify.description ?? commands.worktree["private-store"].verify.title,
    )
    .option(
      "--checkout <path>",
      "the excluded checkout this store belongs to (required); its absent-or-empty state is the empty-first precondition",
    )
    .argument("<store>", "the private store directory, a worktree admin dir's modules/<name>")
    .action((store, _options, command) => {
      const globals = command.optsWithGlobals() as { repo: string; json?: boolean }
      const options = command.opts() as { checkout?: string }
      if (options.checkout === undefined || options.checkout === "") {
        usage =
          "git-super: worktree private-store verify requires --checkout <path>: the empty-first precondition is stated against it\n" +
          command.helpInformation()
        return
      }
      captured = {
        node: commands.worktree["private-store"].verify,
        params: { store, checkout: options.checkout },
        json: globals.json === true,
        nul: false,
      }
    })

  program
    .command("diff")
    .description(commands.diff.description ?? commands.diff.title)
    .option(
      "--exclude-submodule <path>",
      "exclude a literal root-relative submodule and its descendants before content access",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option("--name-only", "emit root-relative changed paths")
    .option("-z, --null", "terminate paths with NUL instead of newline")
    .option("--cached", "compare the index instead of the working tree")
    .option("--diff-filter <letters>", "select paths by Git diff status")
    .option("--stat", "show per-repository diffstat, including each moved gitlink's own submodule diff")
    .option("-p, --patch", "show per-repository patch, including each moved gitlink's own submodule diff")
    .option(
      "--component-base <ref>",
      "measure each moved gitlink from the pin <ref> records for it (the component main a landing carries), not from the range's old pin",
    )
    .argument("[refs...]", "Git revision range or refs")
    .action((refs, options, command) => {
      const globals = command.optsWithGlobals() as { repo: string; json?: boolean }
      // Commander removes -- from positionals; Git still needs it before deleted or option-shaped paths.
      const separator = argv.indexOf("--")
      const paths = separator === -1 ? [] : argv.slice(separator + 1)
      const diffRefs = separator === -1 ? refs : [...refs.slice(0, refs.length - paths.length), "--", ...paths]
      captured = {
        node: commands.diff,
        params: {
          refs: diffRefs,
          ...(options.excludeSubmodule?.length ? { excludedSubmodules: options.excludeSubmodule } : {}),
          ...(options.cached ? { cached: true } : {}),
          ...(options.diffFilter === undefined ? {} : { diffFilter: options.diffFilter }),
          ...(options.componentBase === undefined ? {} : { componentBase: options.componentBase }),
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
    .option(
      "--exclude-submodule <path>",
      "exclude a literal root-relative submodule and descendants before content access",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option("--porcelain", "emit stable machine-readable status")
    .option("-z, --null", "terminate records with NUL instead of newline")
    .option("--index-file <absolute-path>", "hook context: the index git will commit (root repository only)")
    .option("--removal", "removal safety verdict: exit 0 clean, 1 dirty (records as JSON), 2 unknown submodule state")
    .action((options, command) => {
      const globals = command.optsWithGlobals() as { repo: string; json?: boolean }
      const removal = options.removal === true
      captured = {
        node: commands.status,
        params: {
          ...(options.indexFile === undefined ? {} : { indexFile: options.indexFile }),
          ...(options.excludeSubmodule?.length ? { excludedSubmodules: options.excludeSubmodule } : {}),
          ...(removal ? { removal: true } : {}),
        },
        json: globals.json === true || removal,
        nul: options.null === true,
      }
    })

  program
    .command("merge-base")
    .description(commands["merge-base"].description ?? commands["merge-base"].title)
    .option(
      "--exclude-submodule <path>",
      "exclude a literal root-relative submodule and descendants before content access",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .requiredOption("--is-ancestor", "test whether the first commit is an ancestor of the second")
    .argument("<ancestor>", "commit whose owning repository should be discovered")
    .argument("<descendant>", "commit or superproject ref to compare")
    .action((ancestor, descendant, options, command) => {
      const globals = command.optsWithGlobals() as { repo: string; json?: boolean }
      captured = {
        node: commands["merge-base"],
        params: {
          ancestor,
          descendant,
          ...(options.excludeSubmodule?.length ? { excludedSubmodules: options.excludeSubmodule } : {}),
        },
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
  const invocation = captured

  const globals = program.opts() as { repo: string; objectDirectory?: string; alternateObjectDirectory: string[] }
  let result:
    | SuperDiffResult
    | SuperStatusResult
    | SuperIsAncestorResult
    | SuperMergeResult
    | SuperSubmodulePrepareResult
    | RetentionVerifyResult
    | RetentionEnrollReport
    | CompactRetainedRootReport
    | PrivateStoreCandidateResult
    | GitSuperResult
  try {
    let objects: GitObjectContext | undefined
    if (globals.objectDirectory !== undefined || globals.alternateObjectDirectory.length > 0) {
      if (program.getOptionValueSource("repo") !== "cli" || !isAbsolute(globals.repo)) {
        throw new Error(
          "git super: explicit public object context requires --repo <absolute-path>; select the repository before Git runs",
        )
      }
      if (globals.objectDirectory === undefined) {
        throw new Error("git super: alternate public objects require --object-directory <absolute-path>")
      }
      objects = { directory: globals.objectDirectory, alternates: globals.alternateObjectDirectory }
      validateGitObjectContext(objects)
    }
    result = await withGitEnvironment(
      process.env,
      () => {
        if (invocation.node === commands.status && program.getOptionValueSource("repo") === "cli") {
          const discovered = repositoryRoot(globals.repo)
          const identity = probeRepository(discovered, runGit(globals.repo, ["rev-parse", "--show-prefix"]))
          if (identity.kind === "absent") {
            throw new Error(
              `${globals.repo} is not a worktree root; its git dir resolves to the parent repository ${identity.discovered}`,
            )
          }
        }
        return commandResult(
          invocation.node,
          { repo: globals.repo, report: (message) => stderr.write(message) },
          invocation.params,
        )
      },
      objects,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    stderr.write(`${message}\n`)
    await protocol?.refuse("unjudged", message)
    return 2
  }
  await writeResult(captured, result, stdout, stderr, commands)
  if (
    captured.node === commands.diff &&
    (result as SuperDiffResult).notCompared.some(({ reason }) => reason === "unreadable")
  ) {
    await protocol?.refuse(
      "unjudged",
      "Comparison contains unreadable components; see each named observation and remedy.",
    )
    return 2
  }

  if (captured.node === commands["merge-base"] && !(result as SuperIsAncestorResult).isAncestor) return 1
  // Removal safety is a verdict, not a plain status: a scripted reaper must see clean (0), dirty (1) and
  // unknown submodule state (2) as distinct outcomes rather than a status that always succeeds. The JSON
  // result (records + submoduleProblems) is the dirty/unknown payload.
  if (captured.node === commands.status && (captured.params as StatusParams).removal === true) {
    const status = result as SuperStatusResult
    return status.submoduleProblems.length > 0 ? 2 : status.records.length > 0 ? 1 : 0
  }
  // A stopped compaction is a judgment too: a run that refused at a child must not read as success.
  if (captured.node === commands.worktree.retention.enroll) return (result as RetentionEnrollReport).complete ? 0 : 1
  if (captured.node === commands.worktree.retention.compact) {
    const report = result as CompactRetainedRootReport
    // A refusal before any write is reported by class and the run continues, but it is never
    // success: the caller scripted against this must see 1 whenever a child was refused.
    return report.failed === null && report.counts.refused === 0 ? 0 : 1
  }
  // A verdict is a judgment, so it carries its own code rather than the generic 0: a caller scripted
  // against it must not read "not a candidate" as success. Same code family as `super observe`.
  if (captured.node === commands.worktree["private-store"].verify) {
    const candidate = result as PrivateStoreCandidateResult
    if (candidate.verdict === "candidate") return 0
    return candidate.verdict === "not-a-candidate" ? 3 : candidate.verdict === "unproven" ? 4 : 2
  }
  if (captured.node === commands.merge) {
    const merge = result as SuperMergeResult
    if (merge.state === "updated" || merge.state === "unchanged") return 0
    await protocol?.refuse(
      "unjudged",
      merge.detail?.message ?? `Merge in ${globals.repo} ended ${merge.state}; its outcome requires reconciliation.`,
    )
    return merge.partial ? 2 : 1
  }
  // A pull that held a signal during its apply exits for it now that its result is written (24907, 128+signal).
  const deferred = captured.node === commands.pull ? (result as GitSuperResult).deferredSignal : undefined
  if (deferred !== undefined) return 128 + (osConstants.signals[deferred.signal] ?? 15)
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
  if (captured.node === commands.worktree.retention.retire) {
    const operation = result as GitSuperResult
    return operation.state === "updated" ? 0 : operation.state === "unchanged" ? 1 : 2
  }
  if (captured.node === commands.worktree.retention.audit) {
    const operation = result as GitSuperResult
    return operation.detail?.code === "audit-pass" ? 0 : operation.detail?.code === "audit-incomplete" ? 1 : 2
  }
  if (captured.node === commands.worktree.retention.verify) {
    const verify = result as RetentionVerifyResult
    return verify.verdict === "candidate" ? 0 : verify.verdict === "blocked" ? 1 : 2
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
  if (
    captured.node === nodes.diff ||
    captured.node === nodes.status ||
    captured.node === nodes["merge-base"] ||
    captured.node === nodes.merge ||
    captured.node === nodes.worktree.remove
  ) {
    const observations =
      captured.node === nodes.merge
        ? ((result as SuperMergeResult).notCompared ?? [])
        : (result as SuperDiffResult | SuperStatusResult | SuperIsAncestorResult).notCompared
    for (const observation of observations) {
      stderr.write(`${observation.path}: ${observation.message}\n`)
      if (observation.remedy !== undefined) stderr.write(`${observation.remedy}\n`)
    }
  }
  if (captured.node === nodes.status) {
    const reasons = new Set((result as SuperStatusResult).offRemote?.map(({ reason }) => reason))
    for (const reason of reasons) stderr.write(`${reason}\n`)
    for (const problem of (result as SuperStatusResult).submoduleProblems) {
      stderr.write(
        `${problem.path}: ${problem.reason}${problem.gitDir === undefined ? "" : `; Git directory ${problem.gitDir}`}\n`,
      )
    }
  }
  if (captured.node === nodes.diff) {
    for (const entry of (result as SuperDiffResult).consultedRepositories) {
      const comparison = entry.targetComparison
      if (comparison === undefined || (captured.json && comparison.kind === "at-target")) continue
      stderr.write(
        comparison.kind === "at-target"
          ? `${entry.path}: already in ${comparison.target} @ ${comparison.commit}\n`
          : `${entry.path}: comparison with ${comparison.target} @ ${comparison.commit} unavailable: ${comparison.error}\n`,
      )
    }
  }
  if (captured.json) {
    stdout.write(stableJson(result))
  } else if (captured.node === nodes.diff) {
    const diff = result as SuperDiffResult
    const targetLabel = (path: string): string => {
      const comparison = diff.consultedRepositories.find((entry) => entry.path === path)?.targetComparison
      return comparison?.kind === "at-target"
        ? ` (already in ${comparison.target} @ ${comparison.commit.slice(0, 7)})`
        : ""
    }
    if (diff.paths.length > 0) {
      stdout.write(`${diff.paths.join(captured.nul ? "\0" : "\n")}${captured.nul ? "\0" : "\n"}`)
    }
    for (const stat of diff.stats ?? []) {
      stdout.write(`\n== ${stat.repository}${targetLabel(stat.repository)} ==\n`)
      if (stat.untrackedOnly) {
        stdout.write(" dirty (untracked files only)\n")
        continue
      }
      for (const file of stat.files) {
        stdout.write(` ${file.path} | ${file.binary ? "Bin" : `+${file.added} -${file.deleted}`}\n`)
      }
      stdout.write(
        ` ${stat.totals.files} file${stat.totals.files === 1 ? "" : "s"} changed, ` +
          `${stat.totals.added} insertion${stat.totals.added === 1 ? "" : "s"}(+), ` +
          `${stat.totals.deleted} deletion${stat.totals.deleted === 1 ? "" : "s"}(-)\n`,
      )
      for (const move of stat.pointerMoves) {
        const path = stat.repository === "." ? move.path : `${stat.repository}/${move.path}`
        stdout.write(` ${move.path}: pointer ${move.from.slice(0, 7)} -> ${move.to.slice(0, 7)}${targetLabel(path)}\n`)
      }
    }
    for (const patch of diff.patches ?? []) {
      stdout.write(`\n== ${patch.repository}${targetLabel(patch.repository)} ==\n${patch.patch}`)
    }
    await writeReport(diff.consultedRepositories, stderr)
  } else if (captured.node === nodes.status) {
    const status = result as SuperStatusResult
    for (const path of status.uninitializedSubmodules) stderr.write(`${path}: not checked out\n`)
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
      if (
        merge.notCompared?.some((observation) => observation.path === gitlink.path && observation.reason === "excluded")
      ) {
        continue
      }
      stderr.write(
        gitlink.state === "raised"
          ? `${gitlink.path} ${gitlink.recordedPin.slice(0, 7)} -> ${gitlink.landingPin.slice(0, 7)} (submodule main)\n`
          : gitlink.state === "left-off-main"
            ? `left-off-main ${gitlink.path} ${gitlink.recordedPin} (submodule main ${gitlink.mainPin})\n`
            : `not-run ${gitlink.path} ${gitlink.recordedPin} -> ${gitlink.landingPin} (submodule main)\n`,
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
  } else if (captured.node === nodes.push) {
    const push = result as GitSuperResult
    stdout.write(`${push.state}\n`)
    for (const repository of push.repositories) {
      for (const ref of repository.refs) {
        if (ref.state === "updated") {
          stdout.write(`${repository.repository}: ${ref.destination}\n`)
        }
      }
    }
    if (push.detail !== undefined) stderr.write(`${push.detail.message}\n`)
  } else if (captured.node === nodes.worktree.retention.verify) {
    const verify = result as RetentionVerifyResult
    stdout.write(`${verify.verdict}\n`)
    for (const gate of verify.gates) {
      stdout.write(`${gate.status} ${gate.gate}: ${gate.message}\n`)
    }
  } else if (captured.node === nodes.worktree.retention.audit) {
    const operation = result as GitSuperResult
    if (operation.detail === undefined) throw new Error("retention audit returned no result detail")
    const product = operation.detail.code === "audit-pass" || operation.detail.code === "audit-incomplete"
    const sink = product ? stdout : stderr
    sink.write(`${operation.detail.message}\n`)
    for (const row of operation.repositories) {
      if (row.detail?.code === "audit-stale") stdout.write(`${row.detail.message}\n`)
    }
  } else if (captured.node === nodes.worktree.retention.enroll) {
    const report = result as RetentionEnrollReport
    stdout.write(`${report.apply ? "apply" : "dry-run"} enroll ${report.root} common ${report.common}\n`)
    stdout.write(
      `children ${report.children}, inspected ${report.inspected}, proposed ${report.proposed.length}, enrolled ${report.enrolled}, observations ${report.observations.length}, complete ${report.complete}\n`,
    )
    for (const row of report.entries) {
      stdout.write(
        `${row.classification} ${row.entry}${row.registration === undefined ? "" : " -> " + row.registration}${row.reason === null ? "" : ": " + row.reason}\n`,
      )
    }
    for (const observation of report.observations) {
      stdout.write(`${observation.kind} ${observation.path} -> ${observation.target}: ${observation.reason}\n`)
    }
    for (const error of report.errors) stderr.write(error + "\n")
  } else if (captured.node === nodes.worktree.retention.compact) {
    const report = result as CompactRetainedRootReport
    stdout.write(`${report.dryRun ? "dry-run" : "compact"} ${report.root}\n`)
    stdout.write(
      `children ${report.children}: eligible ${report.counts.eligible}, refused ${report.counts.refused}, stopped-partial ${report.counts["stopped-partial"]}, already-compacted ${report.counts["already-compacted"]}, no-entries-map ${report.counts["no-entries-map"]}, incomplete-proof ${report.counts["incomplete-proof"]}, no-manifest ${report.counts["no-manifest"]}${report.limit === null ? "" : `, limit ${report.limit}`}\n`,
    )
    for (const entry of report.entries) {
      if (entry.classification === "eligible") continue
      stdout.write(
        `${entry.classification} ${entry.entry}${entry.step === null ? "" : ` ${entry.step}`}${entry.detail === null ? "" : ` (${entry.detail})`}\n`,
      )
    }
    for (const entry of report.processed) {
      stdout.write(`${report.dryRun ? "would-compact" : "compacted"} ${entry}\n`)
    }
    if (report.failed !== null) stdout.write(`failed ${report.failed.entry} ${report.failed.step}\n`)
  } else if (captured.node === nodes.worktree["private-store"].verify) {
    const candidate = result as PrivateStoreCandidateResult
    stdout.write(`${candidate.verdict}\n`)
    for (const reason of candidate.reasons) stdout.write(`${reason.code}: ${reason.message}\n`)
    stdout.write(`${candidate.notCovered}\n`)
    for (const path of candidate.paths) stdout.write(`${path}\n`)
  } else {
    const pull = result as GitSuperResult
    stdout.write(`${pull.state}\n`)
    if (pull.detail !== undefined) stderr.write(`${pull.detail.message}\n`)
  }
}
