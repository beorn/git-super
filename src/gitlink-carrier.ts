import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { writeGitlink } from "./gitlink.ts"
import { createLocalGitProcess, type GitProcess, type GitProcessRequest } from "./process.ts"

export type GitlinkCarrierPin = Readonly<{ path: string; commit: string }>

/**
 * One root file the carrier writes beside its pins, as an exact existing blob (hh 38155: a regenerated root
 * lockfile must ride the same carrier that raises the pin it describes, or the carrier's tree pairs a new pin with
 * the base's old lock).
 */
export type GitlinkCarrierFile = Readonly<{ path: string; mode: "100644" | "100755" | "120000"; blob: string }>

export type ComposeGitlinkCarrierOptions = Readonly<{
  repo: string
  /** Exact, locally held queue tip. This is the carrier's sole parent. */
  base: string
  pins: readonly GitlinkCarrierPin[]
  /** Root files to write beside the pins; an empty list is the pin-only carrier every earlier caller builds. */
  files?: readonly GitlinkCarrierFile[]
  message: string
  git?: GitProcess
  /**
   * Forwarded to every pin write. A caller that already holds this repository's
   * writer lock (the root merge does) passes `held`, or the carrier deadlocks
   * against the lock it is running under.
   */
  lock?: "acquire" | "held"
}>

export type GitlinkCarrier = Readonly<{ commit: string; tree: string; base: string }>

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu

/** Create a one-parent root commit containing only exact existing gitlink updates and the named root files. */
export async function composeGitlinkCarrier(options: ComposeGitlinkCarrierOptions): Promise<GitlinkCarrier> {
  if (!OBJECT_ID.test(options.base)) throw new Error(`carrier base ${options.base} is not a full commit object ID`)
  const files = options.files ?? []
  if (options.pins.length === 0 && files.length === 0) throw new Error("carrier needs at least one gitlink pin")
  if (options.message.trim() === "") throw new Error("carrier commit message is empty")
  const seen = new Set<string>()
  for (const pin of options.pins) {
    if (seen.has(pin.path)) throw new Error(`carrier has duplicate gitlink path ${pin.path}`)
    seen.add(pin.path)
  }
  for (const file of files) {
    if (file.path.trim() === "" || file.path.startsWith("/")) throw new Error(`carrier file path ${file.path} is not relative`)
    if (seen.has(file.path)) throw new Error(`carrier has duplicate path ${file.path}`)
    if (!OBJECT_ID.test(file.blob)) throw new Error(`carrier file ${file.path} names no blob object ID`)
    seen.add(file.path)
  }

  const process = options.git ?? createLocalGitProcess()
  const scratch = mkdtempSync(join(tmpdir(), "git-super-carrier-"))
  const index = join(scratch, "index")
  const git: GitProcess = {
    run: (request: GitProcessRequest) =>
      process.run({
        ...request,
        env: { ...request.env, GIT_INDEX_FILE: index },
        timeoutMs: request.timeoutMs ?? 30_000,
      }),
  }
  const required = async (args: readonly string[], stdin?: string): Promise<string> => {
    const result = await git.run({ repo: options.repo, args, ...(stdin === undefined ? {} : { stdin }) })
    if (result.code !== 0 || result.timedOut === true || result.stalled === true || result.failure !== undefined) {
      throw new Error(
        `git-super carrier: git ${args.join(" ")} failed in ${options.repo} (exit ${result.code}): ${result.stderr || result.failure || "no diagnostic"}`,
      )
    }
    return result.stdout.trim()
  }

  let failure: unknown
  try {
    await required(["cat-file", "-e", `${options.base}^{commit}`])
    await required(["read-tree", options.base])
    for (const pin of [...options.pins].sort((a, b) => a.path.localeCompare(b.path))) {
      const written = await writeGitlink({
        commit: pin.commit,
        git,
        ...(options.lock === undefined ? {} : { lock: options.lock }),
        path: pin.path,
        repo: options.repo,
      })
      if (written.state !== "updated") {
        throw new Error(
          `git-super carrier: ${pin.path}@${pin.commit} ${written.state}: ${written.detail?.message ?? "no diagnostic"}`,
        )
      }
    }
    if (files.length > 0) {
      const records = [...files]
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((file) => `${file.mode} ${file.blob}\t${file.path}\0`)
        .join("")
      await required(["update-index", "-z", "--index-info"], records)
    }
    const tree = await required(["write-tree"])
    const baseTree = await required(["rev-parse", `${options.base}^{tree}`])
    if (tree === baseTree) throw new Error("git-super carrier: requested pins leave the base tree unchanged")
    const commit = await required(["commit-tree", tree, "-p", options.base], options.message)
    return { commit, tree, base: options.base }
  } catch (error) {
    failure = error
    throw error
  } finally {
    try {
      rmSync(scratch, { recursive: true })
    } catch (cleanup) {
      if (failure !== undefined) {
        throw new AggregateError([failure, cleanup], `git-super carrier failed and could not clean ${scratch}`)
      }
      throw new Error(`git-super carrier left temporary index at ${scratch}`, { cause: cleanup })
    }
  }
}
