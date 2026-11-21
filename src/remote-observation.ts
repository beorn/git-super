import type { GitProcess, GitProcessResult } from "./process.ts"

const OBSERVED_NAMESPACE = "refs/git-super/observed/"
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u

type RemoteNames = Readonly<{ required: string }> | Readonly<{ candidates: readonly string[] }>

type RemoteObservation =
  | Readonly<{ kind: "observed" | "invalid"; objectIds: readonly string[] }>
  | Readonly<{ kind: "failed"; args: readonly string[]; result: GitProcessResult }>

export function isSettledGitResult(result: GitProcessResult): boolean {
  return (
    result.failure === undefined &&
    result.timedOut !== true &&
    result.stalled !== true &&
    result.backstop === undefined &&
    (result.signal === undefined || result.signal === null)
  )
}

/**
 * Fetch refspecs narrow the protocol v2 advertisement; ls-remote patterns only
 * filter the received rows. Dry-run can fetch objects, but writes no refs or
 * FETCH_HEAD. Optional candidates use wildcard refspecs so one absent name
 * cannot hide another present name. Only the exact mapped rows are counted.
 */
export async function observeRemoteRefs(
  git: GitProcess,
  repo: string,
  remote: string,
  names: RemoteNames,
): Promise<RemoteObservation> {
  const candidates = "candidates" in names
  const refs = candidates ? names.candidates : [names.required]
  const targets = refs.map((ref, index) =>
    candidates ? `${OBSERVED_NAMESPACE}candidate-${index}/tip` : OBSERVED_NAMESPACE + ref.replace(/^refs\//u, ""),
  )
  const suffix = candidates ? "*" : ""
  const args = [
    "fetch",
    "--dry-run",
    "--verbose",
    "--porcelain",
    "--no-tags",
    "--no-recurse-submodules",
    "--no-write-fetch-head",
    "--no-auto-maintenance",
    "--refmap=",
    remote,
    ...refs.map((ref, index) => `+${ref}${suffix}:${targets[index]}${suffix}`),
  ]
  const result = await git.run({ repo, args, env: { LC_ALL: "C" } })
  if (!isSettledGitResult(result)) return { kind: "failed", args, result }
  if (result.code !== 0) {
    if (!candidates && result.stderr.includes(`couldn't find remote ref ${names.required}`)) {
      return { kind: "observed", objectIds: [] }
    }
    return { kind: "failed", args, result }
  }

  const observed = new Map<string, string>()
  let invalid = false
  for (const row of result.stdout.split(/\r?\n/u).filter((line) => line !== "")) {
    // The status is one character and can itself be a space.
    const [, oid, local] = row.slice(2).split(" ")
    if (local === undefined || oid === undefined || !OBJECT_ID.test(oid)) {
      invalid = true
    } else if (targets.includes(local) && !observed.has(local)) {
      observed.set(local, oid)
    } else if (
      !candidates ||
      !(
        targets.some((target) => local !== target && local.startsWith(target)) ||
        (local === "FETCH_HEAD" && refs.includes("HEAD"))
      )
    ) {
      invalid = true
    }
  }
  const objectIds = [...observed.values()]
  const missingRequired = !candidates && objectIds.length !== 1
  return { kind: invalid || missingRequired ? "invalid" : "observed", objectIds }
}
