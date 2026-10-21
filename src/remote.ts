type RemoteParts = Readonly<{
  host: string
  hostname: string
  port: string
  protocol: string
  path: string
  explicitUrl: string
}>

function invalidRemote(reason: string): never {
  throw new Error(`Invalid Git remote: ${reason}`)
}

/** Shared transport parser; the push owner supplies its existing refusal representation and stricter path policy. */
export function parseGitRemote(remote: string, invalid: (reason: string) => never = invalidRemote): RemoteParts {
  if (/^[^/:]+@[^/:]+:/u.test(remote)) {
    const split = remote.indexOf(":")
    const host = remote.slice(remote.indexOf("@") + 1, split).toLowerCase()
    const path = remote.slice(split + 1)
    return {
      host,
      hostname: host,
      port: "",
      protocol: "ssh:",
      path,
      explicitUrl: `ssh://${remote.slice(0, split)}${path.startsWith("/") ? "" : "/"}${path}`,
    }
  }
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
  return {
    host: url.host.toLowerCase(),
    hostname: url.hostname.toLowerCase(),
    port: url.port,
    protocol: url.protocol,
    path: url.pathname.replace(/^\//u, ""),
    explicitUrl: remote,
  }
}

/** Explicit source spelling for diagnostics, preserving the SSH username, host alias and repository path. */
export function gitExplicitSourceUrl(remote: string): string {
  return parseGitRemote(remote).explicitUrl
}

/** Logical repository identity before Git's transport-only url.insteadOf rewrite; SSH aliases remain literal. */
export function gitRemoteIdentity(remote: string): Readonly<{ host: string; repository: string }> {
  const parsed = parseGitRemote(remote)
  const path = parsed.path.replace(/^\/+|\/+$/gu, "")
  if (parsed.hostname.startsWith("-") || path.startsWith("-")) {
    return invalidRemote("remote host and repository path must not begin with '-'")
  }
  const repository = path.replace(/\/\.git$/u, "").replace(/\.git$/u, "")
  if (repository.split("/").some((part) => part === "" || part === "." || part === "..")) {
    return invalidRemote(`remote ${remote} does not name a repository`)
  }
  const defaultPorts: Readonly<Record<string, string>> = {
    "https:": "443",
    "http:": "80",
    "ssh:": "22",
    "git:": "9418",
  }
  const defaultPort = defaultPorts[parsed.protocol]
  const port = parsed.port === defaultPort ? "" : parsed.port
  return { host: `${parsed.hostname}${port === "" ? "" : `:${port}`}`, repository }
}

export function sameGitRepository(left: string, right: string): boolean {
  const a = gitRemoteIdentity(left)
  const b = gitRemoteIdentity(right)
  return a.host === b.host && a.repository === b.repository
}

/** Native `git clone <remote>` destination for the supported network transports, without contacting the remote. */
export function gitCloneDirectoryName(remote: string): string {
  const { repository } = gitRemoteIdentity(remote)
  return repository.slice(repository.lastIndexOf("/") + 1)
}
