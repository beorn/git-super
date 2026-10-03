import { readCommitSubmodules } from "./commit-graph.ts"
import type { GitProcess } from "./process.ts"
import type { ExpectedDestination } from "./result.ts"

export const PUSH_INTENT_TRAILER = "Git-Super-Push"

/** Child-only intent. The containing merge object binds these exact bytes. */
export type FrozenPushIntent = Readonly<{
  version: 1
  rootRemote: string
  children: readonly Readonly<{
    path: string
    remote: string
    pin: string
    publication?: Readonly<{
      destination: string
      source: string
      expectedDestination: ExpectedDestination
    }>
  }>[]
  /**
   * Root gitlinks the merge admitted as excluded (`merge --exclude-submodule`, 27147): their own disposition, never a
   * pin row, because a pin row is verified in the child's store and an excluded child has none. Each names the
   * gitlink target the merge saw. Absent when the merge excluded nothing, so every intent without exclusions keeps
   * its exact bytes; a reader that predates the field refuses it as unknown.
   */
  excluded?: readonly Readonly<{ path: string; pin: string }>[]
}>

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u

function invalid(reason: string): never {
  const message = `Invalid frozen Git Super push intent: ${reason}`
  throw Object.assign(new Error(message), {
    resultDetail: {
      code: "invalid-frozen-push-intent",
      phase: "read-frozen-push-intent",
      message,
      remedy: "Preserve the merge and its message; repair the producer before preparing a new checked merge.",
    },
  })
}

/** Logical hosted identity, before Git's transport-only url.insteadOf rewrite. */
export function hostedRemoteIdentity(
  remote: string,
): Readonly<{ host: string; namespace: string; repository: string }> {
  let host: string
  let path: string
  if (/^[^/:]+@[^/:]+:/u.test(remote)) {
    const split = remote.indexOf(":")
    host = remote.slice(remote.indexOf("@") + 1, split).toLowerCase()
    path = remote.slice(split + 1)
  } else {
    let url: URL
    try {
      url = new URL(remote)
    } catch {
      return invalid(`remote ${remote} has no hosted identity; local paths and file URLs cannot establish ownership`)
    }
    if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol) || url.hostname === "") {
      return invalid(`remote ${remote} has no hosted identity; local paths and file URLs cannot establish ownership`)
    }
    if (
      url.password !== "" ||
      (["http:", "https:"].includes(url.protocol) && url.username !== "") ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return invalid("remote URLs must not contain credentials, a query or a fragment")
    }
    host = url.host.toLowerCase()
    path = url.pathname.replace(/^\//u, "")
  }
  path = path.replace(/\.git$/u, "")
  const parts = path.split("/")
  if (parts.length < 2 || parts.some((part) => part === "" || part === "." || part === "..")) {
    return invalid(`remote ${remote} does not name a hosted namespace and repository`)
  }
  return { host, namespace: parts.slice(0, -1).join("/"), repository: path }
}

/** Whether `remote` names a hosted repository; a local path or file URL does not, and nothing else is swallowed. */
export function hasHostedIdentity(remote: string): boolean {
  try {
    hostedRemoteIdentity(remote)
    return true
  } catch (error) {
    if ((error as { resultDetail?: { code?: string } }).resultDetail?.code === "invalid-frozen-push-intent") {
      return false
    }
    throw error
  }
}

export function sameHostedOwner(left: string, right: string): boolean {
  const a = hostedRemoteIdentity(left)
  const b = hostedRemoteIdentity(right)
  return a.host === b.host && a.namespace === b.namespace
}

export function sameHostedRepository(left: string, right: string): boolean {
  const a = hostedRemoteIdentity(left)
  const b = hostedRemoteIdentity(right)
  return a.host === b.host && a.repository === b.repository
}

/** Canonical JSON rejects duplicate/unknown fields without another JSON parser. */
export function decodePushIntent(encoded: string): FrozenPushIntent {
  const bytes = Buffer.from(encoded, "base64")
  if (bytes.length === 0 || bytes.toString("base64") !== encoded) invalid("payload is not canonical base64")
  let json: string
  let parsed: unknown
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    parsed = JSON.parse(json)
  } catch {
    return invalid("payload is not UTF-8 JSON")
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) invalid("payload must be an object")
  const value = parsed as Record<string, unknown>
  if (value.version !== 1 || typeof value.rootRemote !== "string" || !Array.isArray(value.children)) {
    invalid("version 1 requires rootRemote and children")
  }
  const rootRemote = value.rootRemote
  const owner = hostedRemoteIdentity(rootRemote)
  const paths = new Set<string>()
  const children = value.children.map((item: unknown) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) invalid("child update must be an object")
    const row = item as Record<string, unknown>
    if (
      typeof row.path !== "string" ||
      typeof row.remote !== "string" ||
      typeof row.pin !== "string" ||
      !OID.test(row.pin)
    ) {
      invalid("child requires path, remote and a full pin OID")
    }
    if (
      row.path.includes("\0") ||
      row.path.includes("\\") ||
      row.path.split("/").some((part) => part === "" || part === "." || part === "..") ||
      paths.has(row.path)
    ) {
      invalid(`child path ${row.path} is not unique and root-relative`)
    }
    for (const earlier of paths) {
      if (row.path.startsWith(`${earlier}/`)) invalid(`nested child ${row.path} follows parent ${earlier}`)
    }
    paths.add(row.path)
    const child = hostedRemoteIdentity(row.remote)
    if (row.publication === undefined) return { path: row.path, remote: row.remote, pin: row.pin }
    if (owner.host !== child.host || owner.namespace !== child.namespace) {
      invalid(`external remote ${row.remote} cannot receive a frozen child update for ${rootRemote}`)
    }
    if (typeof row.publication !== "object" || row.publication === null || Array.isArray(row.publication)) {
      invalid(`invalid publication for ${row.path}`)
    }
    const publication = row.publication as Record<string, unknown>
    if (
      typeof publication.destination !== "string" ||
      !publication.destination.startsWith("refs/heads/") ||
      typeof publication.source !== "string" ||
      !OID.test(publication.source) ||
      publication.source.length !== row.pin.length
    ) {
      invalid(`invalid destination or source for ${row.path}`)
    }
    const expected = publication.expectedDestination
    if (typeof expected !== "object" || expected === null || Array.isArray(expected)) {
      invalid(`expected destination missing for ${row.path}`)
    }
    const old = expected as Record<string, unknown>
    let expectedDestination: ExpectedDestination
    if (old.state === "missing") expectedDestination = { state: "missing" }
    else if (
      old.state === "oid" &&
      typeof old.oid === "string" &&
      OID.test(old.oid) &&
      old.oid.length === row.pin.length
    ) {
      expectedDestination = { state: "oid", oid: old.oid }
    } else invalid(`invalid expected destination for ${row.path}`)
    return {
      path: row.path,
      remote: row.remote,
      pin: row.pin,
      publication: { destination: publication.destination, source: publication.source, expectedDestination },
    }
  })
  let excluded: { path: string; pin: string }[] | undefined
  if (value.excluded !== undefined) {
    if (!Array.isArray(value.excluded) || value.excluded.length === 0) {
      invalid("excluded must be a nonempty array when present")
    }
    excluded = value.excluded.map((item: unknown) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) invalid("excluded row must be an object")
      const row = item as Record<string, unknown>
      if (typeof row.path !== "string" || typeof row.pin !== "string" || !OID.test(row.pin)) {
        invalid("excluded row requires path and a full pin OID")
      }
      if (
        row.path.includes("\0") ||
        row.path.includes("\\") ||
        row.path.split("/").some((part) => part === "" || part === "." || part === "..") ||
        paths.has(row.path)
      ) {
        invalid(`excluded path ${row.path} is not unique and root-relative`)
      }
      for (const other of paths) {
        if (row.path.startsWith(`${other}/`) || other.startsWith(`${row.path}/`)) {
          invalid(`excluded path ${row.path} overlaps ${other}`)
        }
      }
      paths.add(row.path)
      return { path: row.path, pin: row.pin }
    })
  }
  const intent: FrozenPushIntent = { version: 1, rootRemote, children, ...(excluded === undefined ? {} : { excluded }) }
  if (JSON.stringify(intent) !== json) invalid("payload has duplicate, unknown or noncanonical fields")
  return intent
}

/**
 * The root paths a frozen merge excludes, after proving agreement both ways (27147, @cto 361c4071): each is a root
 * gitlink of `commit` at the pin the merge saw. A disagreement is refused by name before any child is read. Every
 * reader of an intent (push, observe) takes its exclusions here and nowhere else.
 */
export async function frozenExclusionPaths(
  git: GitProcess,
  root: string,
  commit: string,
  intent: FrozenPushIntent | undefined,
): Promise<readonly string[]> {
  const excluded = intent?.excluded ?? []
  if (excluded.length === 0) return []
  const pins = new Map((await readCommitSubmodules(git, root, commit)).map((entry) => [entry.path, entry.target]))
  for (const row of excluded) {
    const recorded = pins.get(row.path)
    if (recorded === row.pin) continue
    const message =
      `Frozen merge ${commit} excludes ${row.path}@${row.pin}, but the commit records ` +
      (recorded === undefined ? "no such root gitlink" : `${row.path}@${recorded}`)
    throw Object.assign(new Error(message), {
      resultDetail: {
        code: "frozen-exclusion-disagrees",
        phase: "read-frozen-push-intent",
        message,
        paths: [row.path],
        objectIds: [commit, row.pin],
        remedy: "Preserve the merge; recompose it so its frozen exclusions match its own gitlinks.",
      },
    })
  }
  return excluded.map((row) => row.path)
}

export function encodePushIntent(intent: FrozenPushIntent): string {
  const encoded = Buffer.from(JSON.stringify(intent)).toString("base64")
  decodePushIntent(encoded)
  return encoded
}

function decodeIntentFromCommit(source: string, trailers: string, parents: string): FrozenPushIntent | undefined {
  const values = trailers
    .split(/\r?\n/u)
    .filter(
      (line) => line.slice(0, PUSH_INTENT_TRAILER.length + 1).toLowerCase() === `${PUSH_INTENT_TRAILER.toLowerCase()}:`,
    )
  if (values.length === 0) return undefined
  if (values.length !== 1) throw new Error(`Merge ${source} carries duplicate ${PUSH_INTENT_TRAILER} trailers`)
  const value = values[0]
  if (value === undefined) throw new Error(`Merge ${source} lost its frozen push trailer`)
  const intent = decodePushIntent(value.slice(PUSH_INTENT_TRAILER.length + 1).trim())
  if (parents.trim().split(/\s+/u).length !== 2) {
    throw new Error(`Frozen push intent must belong to an actual two-parent merge: ${source}`)
  }
  return intent
}

/** Read bounded groups of commits through the same trailer parser as a single intent. */
export async function readFrozenPushIntents(
  git: GitProcess,
  root: string,
  sources: readonly string[],
): Promise<ReadonlyMap<string, FrozenPushIntent | undefined>> {
  const intents = new Map<string, FrozenPushIntent | undefined>()
  const unique = [...new Set(sources)]
  for (let offset = 0; offset < unique.length; offset += 128) {
    const chunk = unique.slice(offset, offset + 128)
    const args = ["show", "-s", "-z", "--format=%H%x00%(trailers:only,unfold)%x00%P", ...chunk]
    const result = await git.run({ repo: root, args })
    if (result.code !== 0 || result.timedOut === true || result.failure !== undefined || result.signal) {
      throw new Error(
        `Merge intent batch: git ${args.join(" ")} failed in ${root} (exit ${result.code})\n${result.failure ?? result.stderr}`,
      )
    }
    const fields = result.stdout.split("\0")
    if (fields.pop() !== "" || fields.length !== chunk.length * 3) {
      throw new Error(`Merge intent batch in ${root}: expected ${chunk.length} complete commit records`)
    }
    for (let index = 0; index < chunk.length; index++) {
      const source = chunk[index]
      const oid = fields[index * 3]
      const trailers = fields[index * 3 + 1]
      const parents = fields[index * 3 + 2]
      if (source === undefined || oid !== source || trailers === undefined || parents === undefined) {
        throw new Error(`Merge intent batch in ${root}: expected ${source}, received ${oid}`)
      }
      intents.set(source, decodeIntentFromCommit(source, trailers, parents))
    }
  }
  return intents
}

/**
 * The frozen push intent a checked merge carries, read from that candidate commit: for each child it publishes, the
 * remote, the destination ref and the expected destination oid the publication will lease on. One owner reads and
 * binds the trailer to the actual containing merge. A candidate without one returns undefined. Exported as
 * `git-super/push-intent` so a caller that must know the lease before publishing (yrd's reuse of a compose, 25570)
 * reads this decoder and never a second one (@cto 298075b8).
 */
export async function readFrozenPushIntent(
  git: GitProcess,
  root: string,
  source: string,
): Promise<FrozenPushIntent | undefined> {
  return (await readFrozenPushIntents(git, root, [source])).get(source)
}
