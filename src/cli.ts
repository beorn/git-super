import { readFileSync } from "node:fs"
import type { RetentionDiscard } from "./retention-discard.ts"
import { checkRetentionAttribution, type RetentionEnrollReport } from "./worktree-removal.ts"
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
  type RetentionBatchParams,
  type RetentionRankParams,
  type RetentionChunksParams,
  type retentionChunks,
  type retentionRank,
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
import { fragmentUseText, RETIRED_MAX_AGE_MS, type BatchWindow, type RetentionBatchResult } from "./retention-batch.ts"
import type { RetentionChunkResult } from "./retention-chunks.ts"
import { formatRetainedBytes, type RetainedRanking } from "./retention-bytes.ts"
import type { PrivateStoreCandidateResult } from "./private-store-candidate.ts"
import type { SuperStatusResult } from "./status.ts"
import type { SuperSubmodulePrepareResult } from "./submodule-prepare.ts"
import { delegateNativeGit, readNativeGit, type ProcessOutputSink } from "./process.ts"
import { openInvocationProtocol, type InvocationProtocol } from "./protocol.ts"
import { basename, isAbsolute } from "node:path"
import {
  probeRepository,
  repositoryRoot,
  runGit,
  validateGitObjectContext,
  withGitEnvironment,
  type GitObjectContext,
} from "./git.ts"

/** #33010 (@cto): the window's own receipt, so the delta's "< 10 s" target is read off a real apply, not inferred. */
function windowLine(window: BatchWindow): string {
  return (
    `lease hold ${String(window.holdMs)}ms; delta ${window.delta} ${String(window.deltaMs)}ms; ` +
    `statted ${String(window.filesStatted)} read ${String(window.filesRead)}; ` +
    `new stores ${String(window.discoveredStores)} walked ${String(window.walkedDirs)} pruned ${String(window.prunedDirs)}; ` +
    `entries ${String(window.entries.length)}`
  )
}

export type OutputSink = ProcessOutputSink &
  Readonly<{
    isTTY?: boolean
    columns?: number
  }>

type CapturedInvocation =
  | CapturedEnrollment
  | Readonly<{
      node: (typeof commands.worktree.retention)["retire-batch"]
      params: RetentionBatchParams
      json: boolean
      nul: boolean
    }>
  | Readonly<{ node: typeof retentionRank; params: RetentionRankParams; json: boolean; nul: boolean }>
  | Readonly<{ node: typeof retentionChunks; params: RetentionChunksParams; json: boolean; nul: boolean }>
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
  | RetentionBatchResult
  | RetentionChunkResult
  | RetainedRanking
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
      | RetentionBatchResult
      | RetentionChunkResult
      | RetainedRanking
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
  // Enriched command dependencies can initialize Bun's stdout stream. Load
  // them after native delegation so execve inherits the original descriptor.
  const [{ Command: CliCommand, CommanderError }, commandNodes] = await Promise.all([
    import("@silvery/commander"),
    import("./commands.ts"),
  ])
  const { commands, retentionChunks, retentionRank } = commandNodes
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
    .option(
      "--omit-checkout-directory <path>",
      "omit a literal tracked directory while materializing this fresh worktree",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .argument("<path>", "path the new detached worktree is created at")
    .argument("<commit>", "commit the worktree and every recorded gitlink are placed at")
    .action((path, commit, options, command) => {
      const globals = command.optsWithGlobals() as { repo: string; json?: boolean }
      const excluded = (options as { excludeSubmodule?: string[] }).excludeSubmodule
      const omissions = (options as { omitCheckoutDirectory?: string[] }).omitCheckoutDirectory
      captured = {
        node: commands.worktree.add,
        params: {
          path,
          commit,
          ...(typeof options.reference === "string" ? { reference: options.reference } : {}),
          ...(excluded?.length ? { excludedSubmodules: excluded } : {}),
          ...(omissions?.length ? { omitCheckoutDirectories: omissions } : {}),
        },
        json: globals.json === true,
        nul: false,
      }
    })

  worktree
    .command("remove")
    .description(commands.worktree.remove.description ?? commands.worktree.remove.title)
    .requiredOption("--retain <directory>", "durable directory outside the worktree and its Git directory")
    .option(
      "--component-custody <json>",
      "prove every component commit has durable custody in the named primary store; the proof reads each component remote at check time and writes into the primary store (fetched objects, and GitSuper pin refs under their own names), so it is not write-free and runs under the removal's existing writer leases",
    )
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
    .option(
      "--attribution <json>",
      "record the caller's attribution for this retention in its manifest as given: a JSON object of string or null values, never interpreted by GitSuper",
    )
    .argument("<path>", "registered clean worktree to remove")
    .option(
      "--dry-run",
      "report every nested component worktree as 'will remove (clean, contained)' or 'blocks (reason)' and remove nothing",
    )
    .action((path, _options, command) => {
      const globals = command.optsWithGlobals() as { repo: string; json?: boolean }
      const options = command.opts() as {
        retain: string
        attribution?: string
        excludeSubmodule?: string[]
        preserved?: string[]
        rehome: boolean
        componentCustody?: string
        dryRun?: boolean
      }
      const invocation: Extract<CapturedInvocation, { node: typeof commands.worktree.remove }> = {
        node: commands.worktree.remove,
        params: {
          path,
          retain: options.retain,
          ...(options.dryRun === true ? { dryRun: true } : {}),
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
          ...(options.attribution === undefined
            ? {}
            : { attribution: checkRetentionAttribution(JSON.parse(options.attribution) as unknown) }),
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
          ? "git-super: worktree retention needs verify, audit, compact, enroll, retire, or retire-batch\n"
          : `git-super: unknown worktree retention subcommand '${subcommand}'; choose verify, audit, compact, enroll, retire, or retire-batch\n`) +
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
    const subcommand = retention
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
    if (verb === "retire") {
      subcommand.option(
        "--discard <disposition.json>",
        "explicitly lose exactly the un-witnessed objects this file names (entry, manifest, missing-object list, commit roots, reason, attribution); every other check still applies",
      )
    }
    subcommand.action((entry, _options, command) => {
      const globals = command.optsWithGlobals() as { json?: boolean }
      const options = command.opts() as {
        root: string
        common: string
        namespace: string[]
        artifactDir: string
        discard?: string
      }
      let discard: unknown
      if (options.discard !== undefined) {
        try {
          discard = JSON.parse(readFileSync(options.discard, "utf8")) as unknown
        } catch (error) {
          usage = `git super worktree retention retire: --discard ${options.discard} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`
          return
        }
      }
      captured = {
        node: commands.worktree.retention[verb],
        params: {
          entry,
          root: options.root,
          common: options.common,
          namespaceRoots: options.namespace,
          artifactDir: options.artifactDir,
          // The command's params run checkRetentionDiscard on this parsed value before any effect.
          ...(discard === undefined ? {} : { discard: discard as RetentionDiscard }),
        },
        json: globals.json === true,
        nul: false,
      }
    })
  }

  retention
    .command("retire-batch")
    .description(
      "Dry-run selected retained entries on one estate scan; --apply re-verifies under held leases and deletes",
    )
    .requiredOption("--root <directory>", "declared retention root whose direct children are selected")
    .requiredOption("--common <directory>", "owning Git common directory")
    .requiredOption("--artifact-dir <directory>", "external caller-owned directory for per-entry evidence")
    .option(
      "--namespace <path>",
      "complete estate namespace; repeat for each managed root",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option("--apply", "delete only entries passing preliminary and lease-held proofs; omitted means dry run")
    .option(
      "--rank-only",
      "measure the entries and order them by the bytes each holds alone; runs no scan, gates or leases, deletes nothing",
    )
    .option(
      "--rank-deadline-seconds <seconds>",
      "soft admission deadline for --rank-only, checked before each entry (default 1080, under Yrd's 1200 s timeout)",
    )
    .option(
      "--proof-deadline-seconds <seconds>",
      "proof budget for the batch: an entry not proved by then is kept with the cause named (default 960: the report after it took 105 s on the live estate, under Yrd's 1200 s timeout)",
    )
    .option(
      "--chunk-size <count>",
      "prove and retire this many entries per chunk, resuming after the cursor; a deadline stop is then a success with a named remainder (34127)",
    )
    .option(
      "--cursor-file <path>",
      "rotating start for chunked runs (default <artifact-dir>/cursor.json); rewritten after each chunk",
    )
    .option(
      "--batch-deadline-seconds <seconds>",
      "total time across every chunk; each chunk gets a fair share, never more than the remainder (default: the proof budget)",
    )
    .option(
      "--custody-target-branch <branch>",
      "published branch gate 5 proves component heads against (37792); omitted keeps the witness and patch proofs",
    )
    .argument("<entries...>", "exact retained entries selected by the caller")
    .action((entries: string[], _options, command) => {
      const globals = command.optsWithGlobals() as { json?: boolean }
      const options = command.opts() as {
        root: string
        common: string
        artifactDir: string
        namespace: string[]
        apply?: boolean
        rankOnly?: boolean
        rankDeadlineSeconds?: string
        proofDeadlineSeconds?: string
        chunkSize?: string
        cursorFile?: string
        batchDeadlineSeconds?: string
        custodyTargetBranch?: string
      }
      if (options.rankOnly === true) {
        if (options.proofDeadlineSeconds !== undefined) {
          usage = "git super worktree retention retire-batch: --proof-deadline-seconds does not apply with --rank-only"
          return
        }
        if (options.apply === true) {
          usage = "git super worktree retention retire-batch: --rank-only deletes nothing and refuses --apply"
          return
        }
        const seconds = options.rankDeadlineSeconds === undefined ? 1080 : Number(options.rankDeadlineSeconds)
        if (!Number.isFinite(seconds) || seconds <= 0) {
          usage = `git super worktree retention retire-batch: --rank-deadline-seconds must be a positive number, got ${options.rankDeadlineSeconds}`
          return
        }
        captured = {
          node: retentionRank,
          params: { entries, root: options.root, deadlineMs: seconds * 1000 },
          json: globals.json === true,
          nul: false,
        }
        return
      }
      if (options.rankDeadlineSeconds !== undefined) {
        usage = "git super worktree retention retire-batch: --rank-deadline-seconds applies only with --rank-only"
        return
      }
      const proofSeconds = options.proofDeadlineSeconds === undefined ? 960 : Number(options.proofDeadlineSeconds)
      if (!Number.isFinite(proofSeconds) || proofSeconds <= 0) {
        usage = `git super worktree retention retire-batch: --proof-deadline-seconds must be a positive number, got ${options.proofDeadlineSeconds}`
        return
      }
      if (options.chunkSize !== undefined || options.cursorFile !== undefined) {
        const chunkSize = options.chunkSize === undefined ? undefined : Number(options.chunkSize)
        if (chunkSize !== undefined && (!Number.isSafeInteger(chunkSize) || chunkSize < 1)) {
          usage = `git super worktree retention retire-batch: --chunk-size must be a positive integer, got ${String(options.chunkSize)}`
          return
        }
        const totalSeconds =
          options.batchDeadlineSeconds === undefined ? proofSeconds : Number(options.batchDeadlineSeconds)
        if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
          usage = `git super worktree retention retire-batch: --batch-deadline-seconds must be a positive number, got ${String(options.batchDeadlineSeconds)}`
          return
        }
        captured = {
          node: retentionChunks,
          params: {
            entries,
            root: options.root,
            common: options.common,
            artifactDir: options.artifactDir,
            namespaceRoots: options.namespace,
            ...(options.apply === true ? { apply: true } : {}),
            ...(options.custodyTargetBranch === undefined ? {} : { targetBranch: options.custodyTargetBranch }),
            ...(chunkSize === undefined ? {} : { chunkSize }),
            ...(options.cursorFile === undefined ? {} : { cursorFile: options.cursorFile }),
            deadlineMs: totalSeconds * 1000,
            retiredMaxAgeMs: RETIRED_MAX_AGE_MS,
          },
          json: globals.json === true,
          nul: false,
        }
        return
      }
      captured = {
        node: commands.worktree.retention["retire-batch"],
        params: {
          entries,
          root: options.root,
          common: options.common,
          artifactDir: options.artifactDir,
          namespaceRoots: options.namespace,
          ...(options.apply === true ? { apply: true } : {}),
          ...(options.custodyTargetBranch === undefined ? {} : { targetBranch: options.custodyTargetBranch }),
          proofDeadlineMs: proofSeconds * 1000,
          retiredMaxAgeMs: RETIRED_MAX_AGE_MS,
        },
        json: globals.json === true,
        nul: false,
      }
    })

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
    | RetentionBatchResult
    | RetentionChunkResult
    | RetainedRanking
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
          {
            repo: globals.repo,
            // Every report is one line on the stream: a caller that writes anything after it (yrd's retained removal
            // proof) must find a line start, and two consecutive reports must not run together.
            report: (message) => stderr.write(message.endsWith("\n") ? message : `${message}\n`),
          },
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
  await writeResult(captured, result, stdout, stderr, commandNodes)
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
  if (captured.node === retentionRank) {
    // A ranking that measured nothing chooses nothing: fail rather than hand the caller an empty order.
    return (result as RetainedRanking).ranked.length > 0 ? 0 : 2
  }
  if (captured.node === commands.worktree.retention["retire-batch"]) {
    const batch = result as RetentionBatchResult
    // 34127 (@cto 2026-11-24 chunk ruling): a time stop is a success with a remainder. Only a condition stop (a shifted
    // census, a held lease, a partial retirement) or a failed row is a failure.
    return (batch.stoppedKind === undefined || batch.stoppedKind === "deadline" || batch.stoppedKind === "budget") &&
      !batch.rows.some((row) => row.outcome === "failed")
      ? 0
      : 2
  }
  if (captured.node === retentionChunks) {
    const chunks = result as RetentionChunkResult
    const hardStop = chunks.chunks.some((chunk) => chunk.stoppedKind === "stop")
    return !hardStop && !chunks.rows.some((row) => row.outcome === "failed") ? 0 : 2
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
  { commands: nodes, retentionChunks, retentionRank }: typeof import("./commands.ts"),
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
  } else if (captured.node === retentionRank) {
    const ranking = result as RetainedRanking
    stdout.write(
      `rank-only: ${ranking.ranked.length} measured, ${ranking.unmeasured.length} unmeasured in ${ranking.ms}ms; ` +
        `${formatRetainedBytes(ranking.measuredBytes)} summed own bytes${ranking.partial ? " (partial)" : ""}` +
        `${ranking.deadlineHit ? "; deadline reached before every entry" : ""}\n`,
    )
    for (const row of ranking.ranked) {
      stdout.write(
        `${formatRetainedBytes(row.bytes)}\t${row.entry}` +
          (row.sharedBytes > 0 ? `\tshared ${formatRetainedBytes(row.sharedBytes)}` : "") +
          (row.unreadable > 0 ? `\tunreadable ${row.unreadable}, e.g. ${row.unreadableExample ?? "?"}` : "") +
          "\n",
      )
    }
    for (const row of ranking.unmeasured) stderr.write(`unmeasured ${row.reason}: ${row.entry}\n`)
  } else if (captured.node === nodes.worktree.retention["retire-batch"]) {
    const batch = result as RetentionBatchResult
    stdout.write(
      `${batch.apply ? "apply" : "dry-run"} retained batch: ${batch.rows.length} selected entries; scan ${batch.scan.status} ${batch.scan.ms}ms` +
        (batch.proofPhases === undefined
          ? ""
          : `; custody phases ${Object.entries(batch.proofPhases)
              .map(([name, ms]) => `${name} ${String(Math.round(ms))}ms`)
              .join(", ")}`) +
        (batch.bytesPlanned === undefined
          ? ""
          : `; ${formatRetainedBytes(batch.bytesPlanned)} allocated in the selected stores` +
            (batch.bytesSharedLinked === undefined
              ? ""
              : `, plus ${formatRetainedBytes(batch.bytesSharedLinked)} in files also linked outside the set, not freed`) +
            (batch.bytesUnreadable === undefined || batch.bytesUnreadable === 0
              ? ""
              : ` (${batch.bytesUnreadable} unreadable path(s) NOT counted, so the figure understates the free space)`)) +
        (batch.bytesEvidence === undefined
          ? ""
          : `; this batch's evidence holds ${formatRetainedBytes(batch.bytesEvidence)} under the artifact directory`) +
        "\n",
    )
    // 34127 (@cto e8f6c3b5): one line per entry, so a starved batch names where its budget went. `lastPhase` survives a
    // deadline cut, which is the case this exists for; receiptMs is the part no phase owns.
    if (batch.preliminaryEntryTimings !== undefined) {
      for (const [entry, timing] of Object.entries(batch.preliminaryEntryTimings)) {
        const phases = Object.entries(timing.phases)
          .map(([name, ms]) => `${name} ${String(Math.round(ms))}ms`)
          .join(", ")
        const subphases = Object.entries(timing.subphases ?? {})
          .map(([name, ms]) => `${name} ${String(Math.round(ms))}ms`)
          .join(", ")
        // 37854 (@cto 7debe1c0): absolute counts and the ratio, so the diagnostic can be read without the JSON.
        const fragmentText = fragmentUseText(timing.fragments)
        stdout.write(
          `timing ${basename(entry)}: start ${String(Math.round(timing.startMs))}ms, end ${String(Math.round(timing.endMs))}ms, ` +
            `slice ${String(timing.sliceMs)}ms` +
            (timing.sliceDeadlineMs === undefined ? "" : ` (deadline +${String(timing.sliceDeadlineMs)}ms)`) +
            `, last ${timing.lastPhase}` +
            (timing.deadlineCutMs === undefined ? "" : ` (cut +${String(Math.round(timing.deadlineCutMs))}ms)`) +
            (timing.receiptMs === undefined
              ? ", receipt not reached"
              : `, receipt ${String(Math.round(timing.receiptMs))}ms`) +
            `, unattributed ${String(Math.round(timing.unattributedMs))}ms` +
            `, ${fragmentText}` +
            (phases === "" ? "" : `; ${phases}`) +
            (subphases === "" ? "" : `; in child: ${subphases}`) +
            "\n",
        )
      }
    }
    if (batch.owners !== undefined && batch.owners.unproved > 0) {
      stdout.write(
        `identity-unknown: ${String(batch.owners.unproved)} object director(ies) have no proved Git owner and cannot be leased; nothing under them is deleted` +
          (batch.owners.identityUnknownBytes === undefined
            ? ""
            : `; ${formatRetainedBytes(batch.owners.identityUnknownBytes)} held there` +
              (batch.owners.identityUnknownUnreadable === undefined || batch.owners.identityUnknownUnreadable === 0
                ? ""
                : ` (${String(batch.owners.identityUnknownUnreadable)} unreadable path(s) NOT counted)`)) +
          (batch.owners.identityUnknownUnmeasured === undefined
            ? ""
            : `; ${String(batch.owners.identityUnknownUnmeasured)} director(ies) not measured: the proof deadline came first`) +
          `; ${String(batch.owners.identityUnknownEntries)} selected entr(ies) kept for borrowing from them; paths in ` +
          `${batch.owners.unprovedList}, per-entry skips in ${batch.owners.identityUnknownList}\n`,
      )
    }
    for (const row of batch.rows) stdout.write(`${row.outcome} ${row.entry}: ${row.reason}\n`)
    for (const window of batch.windows) {
      stdout.write(`${windowLine(window)}\n`)
    }
    if (batch.stopped !== undefined) stderr.write(`${batch.stopped}\n`)
  } else if (captured.node === retentionChunks) {
    const chunks = result as RetentionChunkResult
    stdout.write(
      `retained chunks: ${chunks.rows.some((row) => row.outcome === "retired") ? "apply" : "dry-run"} ${String(chunks.retired)} retired, ` +
        `${String(chunks.provedButUnreached)} proved but unreached, examined ${String(chunks.examined)} of ${String(chunks.total)}, ` +
        `outcome ${chunks.outcome}` +
        (chunks.nextCursor === null ? "" : `; next run starts after ${basename(chunks.nextCursor)}`) +
        "\n",
    )
    for (const row of chunks.rows) stdout.write(`${row.outcome} ${row.entry}: ${row.reason}\n`)
    for (const chunk of chunks.chunks) {
      for (const window of chunk.windows) stdout.write(`${windowLine(window)}\n`)
    }
    if (chunks.stopped !== undefined) stderr.write(`${chunks.stopped}\n`)
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
