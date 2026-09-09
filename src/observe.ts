import { createHash } from "node:crypto"
import { readCommitSubmodules, resolveSubmoduleBranch } from "./commit-graph.ts"
import { ensureCommitObject } from "./objects.ts"
import { createLocalGitProcess, type GitProcess } from "./process.ts"
import { hostedRemoteIdentity, readFrozenPushIntent, sameHostedOwner, sameHostedRepository } from "./push-intent.ts"
import { superSubmodulePrepare, type PreparedSubmodule } from "./submodule-prepare.ts"
import type { OutputSink } from "./cli.ts"

export type ObservationInput = Readonly<{
  version: 1
  root: Readonly<{ remote: string; targetRef: string; targetOid: string }>
  checked: readonly Readonly<{ mergeOid: string; recordRef: string; recordOid: string }>[]
  fence: Readonly<{ prefixes: readonly string[]; refs: readonly Readonly<{ ref: string; oid: string }>[] }>
}>
export type ObservationResult = Readonly<{
  version: 1
  outcome: "observed" | "changed-during-read" | "unavailable-transport" | "invalid"
  message: string
  notices: readonly Readonly<{ id: string; text: string }>[]
}>

const EXITS = { observed: 0, "changed-during-read": 3, "unavailable-transport": 4, invalid: 2 } as const
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u
const READ_TIMEOUT_MS = 30_000

class ObservationFailure extends Error {
  constructor(
    readonly outcome: "unavailable-transport" | "invalid",
    message: string,
  ) {
    super(message)
  }
}

function object(value: unknown, fields: readonly string[], subject: string): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    fields.some((key) => !(key in value))
  ) {
    throw new Error(`${subject}: expected exactly ${fields.join(", ")}`)
  }
  return value as Record<string, unknown>
}

function text(value: unknown, subject: string): string {
  if (typeof value !== "string" || value === "" || value.includes("\0")) {
    throw new Error(`${subject}: expected a nonempty string without NUL`)
  }
  return value
}

function oid(value: unknown, subject: string): string {
  const result = text(value, subject)
  if (!OID.test(result)) throw new Error(`${subject}: expected a full lowercase object ID`)
  return result
}

function array(value: unknown, subject: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${subject}: expected an array`)
  return value
}

function parseInput(value: unknown): ObservationInput {
  const input = object(value, ["version", "root", "checked", "fence"], "observation input")
  if (input.version !== 1) throw new Error("observation input: expected version 1")
  const root = object(input.root, ["remote", "targetRef", "targetOid"], "observation root")
  const fence = object(input.fence, ["prefixes", "refs"], "observation fence")
  return {
    version: 1,
    root: {
      remote: text(root.remote, "root.remote"),
      targetRef: text(root.targetRef, "root.targetRef"),
      targetOid: oid(root.targetOid, "root.targetOid"),
    },
    checked: array(input.checked, "checked").map((value) => {
      const row = object(value, ["mergeOid", "recordRef", "recordOid"], "checked witness")
      return {
        mergeOid: oid(row.mergeOid, "checked.mergeOid"),
        recordRef: text(row.recordRef, "checked.recordRef"),
        recordOid: oid(row.recordOid, "checked.recordOid"),
      }
    }),
    fence: {
      prefixes: array(fence.prefixes, "fence.prefixes").map((value) => text(value, "fence prefix")),
      refs: array(fence.refs, "fence.refs").map((value) => {
        const row = object(value, ["ref", "oid"], "fence ref")
        return { ref: text(row.ref, "fence.ref"), oid: oid(row.oid, "fence.oid") }
      }),
    },
  }
}

/** Fail before a graph helper can interpret a transport/process failure as absence. */
function observationGit(inner: GitProcess): GitProcess {
  return {
    async run(request) {
      const result = await inner.run({
        ...request,
        timeoutMs: request.timeoutMs ?? READ_TIMEOUT_MS,
        env: { ...request.env, GIT_NO_LAZY_FETCH: "1" },
      })
      const network = request.args[0] === "ls-remote" || request.args[0] === "fetch"
      if (result.timedOut === true || result.failure !== undefined || result.signal || (network && result.code !== 0)) {
        throw new ObservationFailure(
          network ? "unavailable-transport" : "invalid",
          `${request.repo}: git ${request.args.join(" ")} failed (exit ${result.code}${result.timedOut ? ", timed out" : ""}${result.signal ? `, signal ${result.signal}` : ""})\n${result.failure ?? ""}${result.stderr}${result.stdout ? `\nstdout: ${result.stdout}` : ""}`,
        )
      }
      return result
    },
  }
}

async function required(git: GitProcess, repo: string, args: readonly string[]): Promise<string> {
  const result = await git.run({ repo, args })
  if (result.code !== 0) {
    throw new Error(`${repo}: git ${args.join(" ")} failed (exit ${result.code})\n${result.stderr}`)
  }
  return result.stdout.trimEnd()
}

async function validateFence(git: GitProcess, repo: string, input: ObservationInput): Promise<void> {
  hostedRemoteIdentity(input.root.remote)
  const fullRef = async (ref: string) => {
    if (!ref.startsWith("refs/")) throw new Error(`Observation ref ${ref}: expected a full ref beginning refs/`)
    await required(git, repo, ["check-ref-format", ref])
  }
  await fullRef(input.root.targetRef)
  if (new Set(input.fence.prefixes).size !== input.fence.prefixes.length) {
    throw new Error("Observation fence: duplicate ref prefix")
  }
  for (const prefix of input.fence.prefixes) await fullRef(prefix.endsWith("/") ? `${prefix}observation` : prefix)
  const refs = new Map<string, string>()
  for (const row of input.fence.refs) {
    await fullRef(row.ref)
    if (!input.fence.prefixes.some((prefix) => row.ref.startsWith(prefix))) {
      throw new Error(`Fence ref ${row.ref}: outside the selected prefixes`)
    }
    if (refs.has(row.ref)) throw new Error(`Fence ref ${row.ref}: duplicate or contradictory row`)
    if (row.oid.length !== input.root.targetOid.length) {
      throw new Error(`Fence ref ${row.ref}: object format differs from root`)
    }
    refs.set(row.ref, row.oid)
  }
  const checked = new Set<string>()
  for (const row of input.checked) {
    if (checked.has(row.mergeOid) || refs.get(row.recordRef) !== row.recordOid) {
      throw new Error(
        `Checked merge ${row.mergeOid}: duplicate or record ${row.recordRef}@${row.recordOid} is not in the captured fence`,
      )
    }
    if (row.mergeOid.length !== input.root.targetOid.length) {
      throw new Error(`Checked merge ${row.mergeOid}: object format differs from root`)
    }
    checked.add(row.mergeOid)
  }
}

async function prepared(
  git: GitProcess,
  repo: string,
  commit: string,
  remote: string,
): Promise<readonly PreparedSubmodule[]> {
  const result = await superSubmodulePrepare({ repo, commit, remote, git })
  if (result.state !== "updated" && result.state !== "unchanged") {
    throw new Error(
      result.detail?.message ?? `Root ${commit}: submodule store preparation ended ${result.state} in ${repo}`,
    )
  }
  return result.submodules
}

async function advertisements(git: GitProcess, repo: string, remote: string): Promise<Map<string, string>> {
  const output = await required(git, repo, ["ls-remote", "--refs", remote])
  const refs = new Map<string, string>()
  for (const line of output.split("\n").filter(Boolean)) {
    const match = /^([0-9a-f]{40}(?:[0-9a-f]{24})?)\t(refs\/[^\s]+)$/u.exec(line)
    if (match?.[1] === undefined || match[2] === undefined || refs.has(match[2])) {
      throw new Error(`${remote}: invalid or duplicate advertised ref ${JSON.stringify(line)}`)
    }
    refs.set(match[2], match[1])
  }
  return refs
}

/** This is one observation, never a retry, a queue reader or a verdict cache. */
export async function observe(repo: string, value: unknown, process?: GitProcess): Promise<ObservationResult> {
  try {
    const input = parseInput(value)
    const git = observationGit(process ?? createLocalGitProcess(globalThis.process.env, { attempts: 1 }))
    await validateFence(git, repo, input)
    const modules = await prepared(git, repo, input.root.targetOid, input.root.remote)
    const descriptors = await readCommitSubmodules(git, repo, input.root.targetOid)
    const explained = new Set<string>()
    const identity = (remote: string, ref: string, source: string) =>
      JSON.stringify([hostedRemoteIdentity(remote), ref, source])
    for (const checked of input.checked) {
      const intent = await readFrozenPushIntent(git, repo, checked.mergeOid)
      if (intent === undefined) throw new Error(`Checked merge ${checked.mergeOid}: missing Git-Super-Push intent`)
      if (!sameHostedRepository(intent.rootRemote, input.root.remote)) {
        throw new Error(
          `Checked merge ${checked.mergeOid}: frozen root ${intent.rootRemote} differs from ${input.root.remote}`,
        )
      }
      const selected = await prepared(git, repo, checked.mergeOid, intent.rootRemote)
      for (const module of selected) {
        const row = intent.children.find((entry) => entry.path === module.path && entry.pin === module.gitlink)
        if (row === undefined || !sameHostedRepository(row.remote, module.url)) {
          throw new Error(
            `Checked merge ${checked.mergeOid}: frozen child ${module.path} does not match its tree and descriptor`,
          )
        }
        if (row.publication === undefined) continue
        // Source N is authority only after the frozen merge proves this pin.
        await ensureCommitObject({ repository: module.gitdir, remote: row.remote, commit: row.pin, git })
        await ensureCommitObject({ repository: module.gitdir, remote: row.remote, commit: row.publication.source, git })
        await required(git, module.gitdir, ["merge-base", "--is-ancestor", row.pin, row.publication.source])
        explained.add(identity(row.remote, row.publication.destination, row.publication.source))
      }
    }
    const notices: { id: string; text: string }[] = []
    let examined = 0
    let external = 0
    for (const module of modules) {
      if (!sameHostedOwner(input.root.remote, module.url)) {
        external += 1
        continue
      }
      const descriptor = descriptors.find((entry) => entry.path === module.path)
      if (descriptor === undefined) {
        throw new Error(`Root ${input.root.targetOid}: missing descriptor for ${module.path}`)
      }
      const branch = await resolveSubmoduleBranch(git, repo, module.gitdir, descriptor, module.url)
      const ref = `refs/heads/${branch}`
      const tip = (await advertisements(git, module.gitdir, module.url)).get(ref)
      if (tip === undefined) {
        throw new Error(`${module.url}: required branch ${ref} is absent from the completed advertisement`)
      }
      await ensureCommitObject({ repository: module.gitdir, remote: module.url, commit: tip, git })
      examined += 1
      if (tip === module.gitlink || explained.has(identity(module.url, ref, tip))) continue
      const id = createHash("sha256")
        .update(
          JSON.stringify([
            hostedRemoteIdentity(input.root.remote),
            input.root.targetRef,
            identity(module.url, ref, tip),
          ]),
        )
        .digest("hex")
      notices.push({
        id,
        text: `${module.path} ${ref} at ${module.url} moved outside the queue to ${tip}; it is neither captured root pin ${module.gitlink} nor the exact source of a current checked merge.`,
      })
    }
    const current = await advertisements(git, repo, input.root.remote)
    const captured = new Map(input.fence.refs.map((row) => [row.ref, row.oid]))
    const selected = new Map(
      [...current].filter(([ref]) => input.fence.prefixes.some((prefix) => ref.startsWith(prefix))),
    )
    const moved = [...new Set([...captured.keys(), ...selected.keys()])].filter(
      (ref) => captured.get(ref) !== selected.get(ref),
    )
    if (current.get(input.root.targetRef) !== input.root.targetOid || moved.length > 0) {
      return {
        version: 1,
        outcome: "changed-during-read",
        notices: [],
        message: `${input.root.remote} changed during observation: ${input.root.targetRef} ${input.root.targetOid} -> ${current.get(input.root.targetRef) ?? "absent"}; changed selected refs: ${moved.join(", ") || "none"}. All buffered findings were discarded.`,
      }
    }
    return {
      version: 1,
      outcome: "observed",
      notices,
      message: `${input.root.remote} ${input.root.targetRef} at ${input.root.targetOid}: examined ${examined} owned direct submodules; excluded ${external} external submodules. Root and all selected refs still match the captured reading.`,
    }
  } catch (error) {
    return {
      version: 1,
      outcome: error instanceof ObservationFailure ? error.outcome : "invalid",
      notices: [],
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Fixed versioned command, separate from ordinary Git stdout/stderr semantics. */
export async function observeCli(args: readonly string[], repo: string, stdout: OutputSink): Promise<number> {
  let result: ObservationResult
  try {
    if (args.length !== 1 || args[0] !== "--protocol=1") {
      throw new Error("super observe: expected --protocol=1 and one UTF-8 JSON document on stdin")
    }
    const input = new TextDecoder("utf-8", { fatal: true }).decode(await Bun.stdin.bytes())
    result = await observe(repo, JSON.parse(input))
  } catch (error) {
    result = {
      version: 1,
      outcome: "invalid",
      notices: [],
      message: `Observation in ${repo}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  stdout.write(`${JSON.stringify(result)}\n`)
  return EXITS[result.outcome]
}
