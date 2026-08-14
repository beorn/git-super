export type GitResultState = "updated" | "unchanged" | "failed" | "not-run" | "unknown"

export type ExpectedDestination = Readonly<{ state: "missing" }> | Readonly<{ state: "oid"; oid: string }>

export type RefUpdate = Readonly<{
  repository: string
  remote: string
  source: string
  destination: string
  expectedDestination?: ExpectedDestination
}>

export type GitResultDetail = Readonly<{
  code: string
  phase: string
  message: string
  paths?: readonly string[]
  objectIds?: readonly string[]
  remedy?: string
}>

export type GitSuperRefResult = Readonly<{
  source: string
  destination: string
  state: GitResultState
  detail?: GitResultDetail
}>

export type GitSuperRepositoryResult = Readonly<{
  repository: string
  state: GitResultState
  detail?: GitResultDetail
  refs: readonly GitSuperRefResult[]
}>

export type GitSuperResult = Readonly<{
  state: Exclude<GitResultState, "not-run">
  partial: boolean
  detail?: GitResultDetail
  repositories: readonly GitSuperRepositoryResult[]
}>

/** Aggregate repository outcomes without hiding a successful write behind a later failure. */
export function gitSuperResult(
  repositories: readonly GitSuperRepositoryResult[],
  detail?: GitResultDetail,
): GitSuperResult {
  const states = repositories.flatMap((repository) => [repository.state, ...repository.refs.map((ref) => ref.state)])
  const changed = states.includes("updated")
  const incomplete = states.some((state) => state === "failed" || state === "not-run" || state === "unknown")
  const partial = changed && incomplete
  const state: GitSuperResult["state"] =
    states.includes("failed") || partial
      ? "failed"
      : states.includes("unknown")
        ? "unknown"
        : changed
          ? "updated"
          : "unchanged"
  return {
    state,
    partial,
    ...(detail === undefined ? {} : { detail }),
    repositories,
  }
}
