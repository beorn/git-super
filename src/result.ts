export type GitResultState = "updated" | "unchanged" | "failed" | "not-run" | "unknown"

export type ExpectedDestination = Readonly<{ state: "missing" }> | Readonly<{ state: "oid"; oid: string }>

export type RefUpdate = Readonly<{
  repository: string
  remote: string
  source: string
  destination: string
  expectedDestination?: ExpectedDestination
  allowNonFastForward?: boolean
}>

export type GitResultDetail = Readonly<{
  code: string
  phase: string
  message: string
  subject?: string
  evidence?: string
  next?: string
  owner?: string
  paths?: readonly string[]
  objectIds?: readonly string[]
  remedy?: string
}>

export type GitSuperRefResult = Readonly<{
  source: string
  destination: string
  state: GitResultState
  /**
   * The destination's head AS OBSERVED when this operation planned, before any
   * write. Present wherever the operation actually looked; absent means it did
   * not, and absent must never be read as "unchanged from what you remember".
   *
   * It exists because `state` alone cannot answer the question readers actually
   * ask of it. `unchanged` says the head equals the target — a fact about the
   * CURRENT state — and it gets read as "there was nothing to do, so you are
   * where you were", a fact about the PRIOR state. Those coincide right up
   * until something else moved the checkout, which is exactly when someone is
   * reading the report to find out.
   *
   * Measured cost (@i/10-yrd/24243): a sweep fast-forwarded @ci's bay; their
   * later `pull --ff-only --dry-run` honestly reported `state=unchanged` with
   * `source=f0656279` because by then the root DID equal the target. Two
   * careful agents and a chief built "the dry-run mutates" on that output and
   * spent two hours disproving it. The tool held both facts when it decided and
   * collapsed them into one word on the way out. With the observed head beside
   * the source, a reader comparing against a recorded precondition sees the
   * contradiction instead of having their theory confirmed.
   */
  observed?: string
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
