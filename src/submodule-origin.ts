import { isAbsolute, resolve } from "node:path"
import { join as joinPosix, normalize as normalizePosix } from "node:path/posix"

const REMOTE_SCHEME = /^[a-z][a-z\d+.-]*:/iu
const SCP_REMOTE = /^((?:[^/@:]+@)?[^/:]+:)(.+)$/u

/** Resolve a Git-relative submodule URL with the superproject remote as a directory. */
export function resolveRelativeSubmoduleOrigin(superOrigin: string, relativeUrl: string): string {
  if (REMOTE_SCHEME.test(superOrigin)) {
    const directory = new URL(superOrigin)
    if (!directory.pathname.endsWith("/")) directory.pathname += "/"
    return new URL(relativeUrl, directory).toString()
  }

  const scp = SCP_REMOTE.exec(superOrigin)
  if (scp?.[1] !== undefined && scp[2] !== undefined) {
    return `${scp[1]}${normalizePosix(joinPosix(scp[2], relativeUrl))}`
  }

  return resolve(superOrigin, relativeUrl)
}

function canonicalRemote(repository: string, value: string): string {
  if (isAbsolute(value) || REMOTE_SCHEME.test(value) || SCP_REMOTE.test(value)) return value
  return resolve(repository, value)
}

/** Resolve one declared submodule URL without applying product-specific remote policy. */
export function resolveSubmoduleOrigin(repository: string, superOrigin: string | undefined, value: string): string {
  if (!value.startsWith("./") && !value.startsWith("../")) return canonicalRemote(repository, value)
  if (superOrigin === undefined) {
    throw new Error(`relative submodule URL '${value}' has no superproject origin`)
  }
  const base = canonicalRemote(repository, superOrigin)
  try {
    return resolveRelativeSubmoduleOrigin(base, value)
  } catch (cause) {
    throw new Error(
      `could not resolve submodule URL '${value}' against '${base}': ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    )
  }
}
