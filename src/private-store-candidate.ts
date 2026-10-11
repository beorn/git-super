import { readdirSync } from "node:fs"
import { advertisements } from "./observe.ts"
import { createLocalGitProcess, type GitProcess, type GitProcessResult } from "./process.ts"
import { shellQuote } from "./shell-command.ts"

/**
 * Read-only candidate check for ONE private submodule store (#27120 AC1).
 *
 * The store is `<admin dir>/modules/<name>`: live Git storage sitting inside a worktree's deletion
 * custody, which is why `worktree-removal.ts` refuses to take it (R2). This module answers exactly
 * one question, metadata-only: do the store's refs and HEAD still equal what its remote advertises?
 *
 * A `candidate` verdict is POINT-IN-TIME metadata evidence. It is never a no-writer guarantee and
 * never removal authority: `update-ref`, a `fetch` or another linked writer can move refs or HEAD
 * without leaving a trace here, and the operator owns what happens next.
 *
 * What it reads: ref names and values, HEAD, and the store's own configured fetch refspecs.
 * What it never reads: the working tree, the index, the reflog, or any object content. That is the
 * point — a route that needs the private bytes to be *looked at* is the operator's, by design.
 *
 * The ruled ORDER is enforced, not trusted: the operator looks at the checkout, EMPTIES it, and only
 * then does this run. A populated checkout is a named refusal, because a `candidate` from an env whose
 * private checkout still holds bytes would be evidence for the state the operator is trying to leave.
 */

/** Printed with every verdict, verbatim. The scope of the proof, stated where a reader will see it. */
export const PRIVATE_STORE_NOT_COVERED =
  "not covered: the private working tree (modified and untracked files), staged changes (the index) and reflog-only commits — this tool cannot see them by design"

/**
 * Every Git request this verifier may make. Anything else is a bug in the verifier, never a case to
 * fall back from: the guard below turns an unlisted request into an `invalid` verdict.
 */
export const PRIVATE_STORE_GIT_REQUESTS = ["config", "for-each-ref", "ls-remote", "rev-parse", "symbolic-ref"] as const

const ALLOWED = new Set<string>(PRIVATE_STORE_GIT_REQUESTS)
const READ_TIMEOUT_MS = 30_000

export type PrivateStoreVerdict = "candidate" | "not-a-candidate" | "unproven" | "invalid"

/** Why one ref is or is not evidence. `code` is stable; `message` is for a human and carries no content. */
export type PrivateStoreReason = Readonly<{
  code: string
  ref: string | null
  message: string
}>

export type PrivateStoreRefState = "equal" | "differs" | "unadvertised" | "unmapped" | "unqueried-remote"

export type PrivateStoreRefRow = Readonly<{
  ref: string
  /** The advertised ref this one was MAPPED to through the store's own fetch refspec, or null. */
  mappedFrom: string | null
  value: string
  advertised: string | null
  state: PrivateStoreRefState
}>

export type PrivateStoreHeadRow = Readonly<{
  state: "symbolic" | "detached"
  /** The ref HEAD is attached to, when symbolic. */
  attachedTo: string | null
  value: string
  advertised: boolean
}>

export type PrivateStoreCandidateOptions = Readonly<{
  /** The store path (the `modules/<name>` directory inside a worktree's admin dir). */
  store: string
  /**
   * The excluded checkout this store belongs to. Required: its absent-or-empty state IS the ruled
   * empty-first precondition, and the operator's path-only block names it. Only ever listed, never read.
   */
  checkout: string
  git?: GitProcess
}>

export type PrivateStoreCandidateResult = Readonly<{
  version: 1
  verdict: PrivateStoreVerdict
  store: string
  checkout: string
  refs: readonly PrivateStoreRefRow[]
  head: PrivateStoreHeadRow | null
  reasons: readonly PrivateStoreReason[]
  notCovered: string
  /** The operator's own paths, in the ruled order, shell-quoted. Paths only — never private content. */
  paths: readonly string[]
}>

class PrivateStoreFailure extends Error {
  constructor(
    readonly verdict: "unproven" | "invalid",
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/**
 * Wrap the process so two things are structurally impossible rather than merely intended:
 * a request outside the allowlist, and a transport failure read as absence (a `ls-remote` that
 * could not reach the remote must never look like "the remote does not advertise this").
 */
function readonlyGit(inner: GitProcess): GitProcess {
  return {
    async run(request): Promise<GitProcessResult> {
      const verb = request.args[0]
      if (verb === undefined || !ALLOWED.has(verb)) {
        throw new PrivateStoreFailure(
          "invalid",
          "request-outside-allowlist",
          `private store verification refused a Git request outside its allowlist: ${verb ?? "(none)"}`,
        )
      }
      const result = await inner.run({
        ...request,
        timeoutMs: request.timeoutMs ?? READ_TIMEOUT_MS,
        env: { ...request.env, GIT_NO_LAZY_FETCH: "1" },
      })
      const network = verb === "ls-remote"
      if (result.timedOut === true || result.failure !== undefined || result.signal || (network && result.code !== 0)) {
        // The raw stderr is deliberately NOT carried: it can name a private remote path. Say what
        // happened, name the remote and the exit, and let the verdict be `unproven`.
        throw new PrivateStoreFailure(
          "unproven",
          "unavailable-transport",
          `${request.repo}: git ls-remote did not complete (exit ${result.code}${result.timedOut ? ", timed out" : ""}); the remote could not be reached, so nothing is proven`,
        )
      }
      return result
    },
  }
}

async function read(git: GitProcess, repo: string, args: readonly string[]): Promise<string> {
  const result = await git.run({ repo, args })
  if (result.code !== 0) {
    throw new PrivateStoreFailure(
      "invalid",
      "request-refused",
      `${repo}: git ${args[0] ?? "?"} did not succeed (exit ${result.code}); the store could not be read`,
    )
  }
  return result.stdout.trimEnd()
}

type RefSpec = Readonly<{ source: string; destination: string }>

/** The store's OWN fetch refspecs. A convention is never assumed: a narrow or mirror refspec maps correctly. */
function parseFetchRefspecs(lines: readonly string[]): readonly RefSpec[] {
  const specs: RefSpec[] = []
  for (const raw of lines) {
    const spec = raw.startsWith("+") ? raw.slice(1) : raw
    if (spec === "") continue
    const colon = spec.indexOf(":")
    if (colon === -1) {
      // A source-only refspec declares NO destination: real Git writes FETCH_HEAD and creates no ref at
      // all. Synthesizing refs/remotes/<remote>/<branch> here would fabricate a mapping for a local ref
      // Git never wrote, and a fabricated tracker would then read as `equal`.
      continue
    }
    const source = spec.slice(0, colon)
    const destination = spec.slice(colon + 1)
    if (source === "" || destination === "") continue
    specs.push({ source, destination })
  }
  return specs
}

/** The advertised ref a local ref maps to, or null when no configured refspec destination matches it. */
function mapThrough(spec: RefSpec, ref: string): string | null {
  const star = spec.destination.indexOf("*")
  if (star === -1) return spec.destination === ref ? spec.source : null
  if (!spec.source.includes("*")) return null
  const prefix = spec.destination.slice(0, star)
  const suffix = spec.destination.slice(star + 1)
  if (!ref.startsWith(prefix) || !ref.endsWith(suffix)) return null
  if (ref.length < prefix.length + suffix.length) return null
  return spec.source.replace("*", ref.slice(prefix.length, ref.length - suffix.length))
}

/** One configured remote whose fetch refspec destination matches a local ref, with the mapped source. */
type MappedSource = Readonly<{ remote: string; source: string }>

/**
 * V1's mapping is derived from the store's OWN configured fetch refspecs, never from the
 * `refs/remotes/<remote>/<name>` convention, so a narrow or mirror destination maps correctly. Every
 * match is returned: if two configured remotes map this ref to sources they advertise with different
 * values, that disagreement is named rather than resolved silently.
 */
function mappingForRef(remotes: ReadonlyMap<string, readonly string[]>, ref: string): readonly MappedSource[] {
  const matches: MappedSource[] = []
  for (const [remote, lines] of remotes) {
    for (const spec of parseFetchRefspecs(lines)) {
      const source = mapThrough(spec, ref)
      if (source !== null) matches.push({ remote, source })
    }
  }
  return matches
}

/** Sentinel for "the mapped source is not advertised by its own remote" inside a Set of advertised values. */
const UNADVERTISED = "\u0000unadvertised"

/**
 * The checkout's occupancy from a directory listing only — no entry name and no content ever leaves
 * here. `absent` is acceptable: an absent checkout has nothing to empty. R2(a) uses the same
 * absent/empty/populated vocabulary for the removal refusal.
 */
function checkoutOccupancy(checkout: string): "absent" | "empty" | "populated" | "unreadable" {
  let entries: readonly string[]
  try {
    entries = readdirSync(checkout)
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable"
  }
  return entries.length === 0 ? "empty" : "populated"
}

/** The advertised `HEAD` of one remote. `--refs` excludes HEAD, so this is its own request. */
async function advertisedHead(git: GitProcess, repo: string, remote: string): Promise<string | null> {
  const output = await read(git, repo, ["ls-remote", remote, "HEAD"])
  const line = output.split("\n").find((entry) => entry.endsWith("\tHEAD"))
  if (line === undefined) return null
  const value = line.slice(0, line.indexOf("\t"))
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(value)) {
    throw new PrivateStoreFailure("invalid", "malformed-advert", `${remote}: advertised HEAD was not a full object id`)
  }
  return value
}

const TRACKING = /^refs\/remotes\/([^/]+)\/(.+)$/u

export async function verifyPrivateStoreCandidate(
  options: PrivateStoreCandidateOptions,
): Promise<PrivateStoreCandidateResult> {
  const store = options.store
  const checkout = options.checkout
  const base: Pick<PrivateStoreCandidateResult, "version" | "store" | "checkout" | "notCovered"> = {
    version: 1,
    store,
    checkout,
    notCovered: PRIVATE_STORE_NOT_COVERED,
  }
  const paths = [shellQuote(checkout), shellQuote(store)]

  const git = readonlyGit(options.git ?? createLocalGitProcess(globalThis.process.env, { attempts: 1 }))
  try {
    await read(git, store, ["rev-parse", "--git-dir"])

    const reasons: PrivateStoreReason[] = []
    const refRows: PrivateStoreRefRow[] = []

    // The empty-first precondition, ENFORCED here rather than trusted (the ruled order is: the
    // operator looks, empties the checkout, THEN the verifier runs). A `candidate` emitted while the
    // checkout still holds bytes would be evidence for the wrong state, so a populated checkout is a
    // named refusal. This is a directory listing only; no entry name reaches the result.
    const occupancy = checkoutOccupancy(checkout)
    if (occupancy === "unreadable") {
      throw new PrivateStoreFailure(
        "invalid",
        "checkout-unreadable",
        `${checkout}: the excluded checkout could not be listed; nothing is proven`,
      )
    }
    if (occupancy === "populated") {
      reasons.push({
        code: "checkout-not-empty",
        ref: null,
        message: `${checkout}: the excluded checkout is not empty; empty it first — the working tree, the index and reflog-only commits are the operator's own look`,
      })
    }

    const remoteListing = await read(git, store, ["config", "--get-regexp", "^remote\\..*\\.fetch$"])
    const remotes = new Map<string, readonly string[]>()
    for (const line of remoteListing.split("\n").filter(Boolean)) {
      const match = /^remote\.(.+?)\.fetch\s+(.*)$/u.exec(line)
      if (match?.[1] === undefined || match[2] === undefined) continue
      remotes.set(match[1], [...(remotes.get(match[1]) ?? []), match[2]])
    }

    // Query every configured remote once and keep each remote's OWN advertisement. A remote that
    // cannot be reached makes the WHOLE verdict `unproven`, and a flattened map would let one
    // remote's value stand in for another's — the identity defect a peer read named.
    const advertisedByRemote = new Map<string, ReadonlyMap<string, string>>()
    const advertised = new Map<string, string>()
    const ambiguous = new Set<string>()
    for (const remote of remotes.keys()) {
      let rows: Map<string, string>
      try {
        rows = await advertisements(git, store, remote)
      } catch (cause) {
        // `advertisements` carries the raw advertised line into its own error, so it is converted
        // here into a named reason that names the remote and nothing else. No private ref escapes.
        if (cause instanceof PrivateStoreFailure) throw cause
        throw new PrivateStoreFailure(
          "unproven",
          "malformed-advert",
          `${remote}: the remote's advertisement could not be read as refs; nothing is proven`,
        )
      }
      advertisedByRemote.set(remote, rows)
      for (const [ref, value] of rows) {
        const seen = advertised.get(ref)
        if (seen !== undefined && seen !== value) ambiguous.add(ref)
        advertised.set(ref, value)
      }
    }

    const refLines = await read(git, store, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)"])

    for (const line of refLines.split("\n").filter(Boolean)) {
      const [ref, value, symref] = line.split("\0")
      if (ref === undefined || value === undefined) continue
      if (ref === "refs/stash") {
        reasons.push({ code: "local-stash", ref, message: `${ref}: a local stash is never a candidate` })
        refRows.push({ ref, mappedFrom: null, value, advertised: null, state: "unmapped" })
        continue
      }

      // refs/remotes/<remote>/HEAD is a pointer at another tracking ref, not a ref of its own.
      if (ref.endsWith("/HEAD") && TRACKING.test(ref)) {
        if (symref !== undefined && symref !== "") {
          refRows.push({ ref, mappedFrom: symref, value, advertised: null, state: "equal" })
          continue
        }
        const remoteName = TRACKING.exec(ref)?.[1]
        if (remoteName === undefined) continue
        const head = await advertisedHead(git, store, remoteName)
        if (head === value) {
          refRows.push({ ref, mappedFrom: "HEAD", value, advertised: head, state: "equal" })
        } else {
          refRows.push({ ref, mappedFrom: "HEAD", value, advertised: head, state: "differs" })
          reasons.push({
            code: "tracking-head-differs",
            ref,
            message: `${ref}: value differs from the advertised HEAD (behind or diverged)`,
          })
        }
        continue
      }

      // V1's mapping: every configured fetch refspec destination, from every configured remote, is a
      // candidate mapping for this ref — never the refs/remotes pattern. The comparison is against the
      // value THAT ref's own remote advertises for the mapped source, never another remote's.
      const mapping = mappingForRef(remotes, ref)
      if (mapping.length > 0) {
        const sources = new Set(
          mapping.map((entry) => advertisedByRemote.get(entry.remote)?.get(entry.source) ?? UNADVERTISED),
        )
        if (sources.size > 1) {
          refRows.push({ ref, mappedFrom: null, value, advertised: null, state: "differs" })
          reasons.push({
            code: "ambiguous-advertisement",
            ref,
            message: `${ref}: the configured fetch refspecs map this ref to sources the remotes advertise with different values`,
          })
          continue
        }
        const mapped = mapping[0] as MappedSource
        const advertisedValue = advertisedByRemote.get(mapped.remote)?.get(mapped.source)
        if (advertisedValue === undefined) {
          refRows.push({ ref, mappedFrom: mapped.source, value, advertised: null, state: "unadvertised" })
          reasons.push({
            code: "mapped-source-unadvertised",
            ref,
            message: `${ref}: maps to ${mapped.source}, which the remote does not advertise (the branch may be deleted; this commit may exist only here)`,
          })
          continue
        }
        if (advertisedValue === value) {
          refRows.push({ ref, mappedFrom: mapped.source, value, advertised: advertisedValue, state: "equal" })
        } else {
          refRows.push({ ref, mappedFrom: mapped.source, value, advertised: advertisedValue, state: "differs" })
          reasons.push({
            code: "value-differs",
            ref,
            message: `${ref}: value differs from the advertised ${mapped.source} (behind or diverged)`,
          })
        }
        continue
      }

      // A tracking ref for a remote this store does not configure: that remote was never queried.
      const tracking = TRACKING.exec(ref)
      if (tracking?.[1] !== undefined && !remotes.has(tracking[1])) {
        refRows.push({ ref, mappedFrom: null, value, advertised: null, state: "unqueried-remote" })
        reasons.push({
          code: "tracking-unqueried-remote",
          ref,
          message: `${ref}: names remote ${tracking[1]}, which this store does not configure; that remote was not queried`,
        })
        continue
      }

      // Every other namespace is compared strictly by name.
      if (ambiguous.has(ref)) {
        refRows.push({ ref, mappedFrom: null, value, advertised: null, state: "differs" })
        reasons.push({
          code: "ambiguous-advertisement",
          ref,
          message: `${ref}: the configured remotes advertise different values under this name`,
        })
        continue
      }
      const advertisedValue = advertised.get(ref)
      if (advertisedValue === undefined) {
        refRows.push({ ref, mappedFrom: null, value, advertised: null, state: "unadvertised" })
        reasons.push({
          code: "local-only",
          ref,
          message: `${ref}: the remote does not advertise this name`,
        })
        continue
      }
      if (advertisedValue === value) {
        refRows.push({ ref, mappedFrom: null, value, advertised: advertisedValue, state: "equal" })
      } else {
        refRows.push({ ref, mappedFrom: null, value, advertised: advertisedValue, state: "differs" })
        reasons.push({
          code: "value-differs",
          ref,
          message: `${ref}: value differs from the advertised ${ref} (behind or diverged)`,
        })
      }
    }

    const symbolic = await git.run({ repo: store, args: ["symbolic-ref", "--quiet", "HEAD"] })
    const headValue = await read(git, store, ["rev-parse", "HEAD"])
    let head: PrivateStoreHeadRow
    if (symbolic.code === 0) {
      head = { state: "symbolic", attachedTo: symbolic.stdout.trim(), value: headValue, advertised: true }
    } else {
      const advertisedValue = [...advertised.values()].includes(headValue)
      head = { state: "detached", attachedTo: null, value: headValue, advertised: advertisedValue }
      if (!advertisedValue) {
        reasons.push({
          code: "detached-head-unadvertised",
          ref: "HEAD",
          message: `HEAD: detached at ${headValue}, which no configured remote advertises`,
        })
      }
    }

    return {
      ...base,
      verdict: reasons.length === 0 ? "candidate" : "not-a-candidate",
      refs: refRows,
      head,
      reasons,
      paths,
    }
  } catch (cause) {
    const failure =
      cause instanceof PrivateStoreFailure
        ? cause
        : new PrivateStoreFailure(
            "invalid",
            "unreadable-store",
            `${store}: the store could not be read; no claim is made about its refs or HEAD`,
          )
    return {
      ...base,
      verdict: failure.verdict,
      refs: [],
      head: null,
      reasons: [{ code: failure.code, ref: null, message: failure.message }],
      paths,
    }
  }
}
