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
  const intent: FrozenPushIntent = { version: 1, rootRemote, children }
  if (JSON.stringify(intent) !== json) invalid("payload has duplicate, unknown or noncanonical fields")
  return intent
}

export function encodePushIntent(intent: FrozenPushIntent): string {
  const encoded = Buffer.from(JSON.stringify(intent)).toString("base64")
  decodePushIntent(encoded)
  return encoded
}
