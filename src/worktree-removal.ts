import { createHash } from "node:crypto"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs"
import { spawnSync } from "node:child_process"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { superStatus } from "./status.ts"
import type { Git, WorktreeInspection } from "./worktree.ts"

export type WorktreeRemovalProof = Readonly<{
  path: string
  head: string
  repositories: readonly string[]
  modules: string
  retained: string | null
  manifest: string
  createdAt: string
  retainUntil: string
  rehomedBorrowers?: readonly string[]
}>

export type WorktreeRetention = Readonly<{
  root: string
  report: (proof: WorktreeRemovalProof) => void
}>

function within(parent: string, path: string): boolean {
  const part = relative(parent, path)
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part))
}

function toCanonical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/**
 * Any live worktree in the superproject whose submodule alternates point into `lenderModules`
 * is dissociated using git repack -a -d while alternates still resolve, and its alternates are updated
 * before `lenderModules` is destroyed, preventing dangling alternates and silent object loss (hh 25908).
 *
 * If dissociation fails, throws before removing anything, naming the borrowers.
 */
export function rehomeBorrowers(commonDir: string, lenderGitDir: string, lenderModules: string): readonly string[] {
  if (!existsSync(lenderModules)) return []

  const worktreesDir = join(commonDir, "worktrees")
  const candidates: Array<{ adminDir: string; name: string }> = []
  if (existsSync(worktreesDir)) {
    for (const entry of readdirSync(worktreesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const adminDir = join(worktreesDir, entry.name)
        if (toCanonical(adminDir) !== toCanonical(lenderGitDir)) {
          candidates.push({ adminDir, name: entry.name })
        }
      }
    }
  }
  if (toCanonical(commonDir) !== toCanonical(lenderGitDir)) {
    candidates.push({ adminDir: commonDir, name: "primary" })
  }

  const rehomedBorrowers = new Set<string>()

  for (const candidate of candidates) {
    const candidateModules = join(candidate.adminDir, "modules")
    if (!existsSync(candidateModules)) continue

    let borrowerIdentity = candidate.name
    try {
      const gitdirFile = join(candidate.adminDir, "gitdir")
      if (existsSync(gitdirFile)) {
        const text = readFileSync(gitdirFile, "utf8").trim()
        borrowerIdentity = dirname(text.replace(/^gitdir:\s*/u, ""))
      }
    } catch {
      // Keep candidate name
    }

    try {
      for (const entry of readdirSync(candidateModules, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile() || entry.name !== "alternates") continue
        const alternatesPath = join(entry.parentPath, entry.name)
        const objectsDir = dirname(entry.parentPath)
        const content = readFileSync(alternatesPath, "utf8")
        const lines = content
          .split(/\r?\n/u)
          .map((l) => l.trim())
          .filter((l) => l !== "" && !l.startsWith("#"))

        const hasLender = lines.some((line) => {
          const abs = isAbsolute(line) ? line : resolve(objectsDir, line)
          return within(lenderModules, toCanonical(abs))
        })
        if (!hasLender) continue

        rehomedBorrowers.add(borrowerIdentity)

        const subGitDir = dirname(objectsDir)
        const subRel = relative(candidateModules, subGitDir)
        const timeoutMs = 120_000
        const repacked = spawnSync("git", ["--git-dir", subGitDir, "repack", "-a", "-d"], {
          encoding: "utf8",
          timeout: timeoutMs,
        })
        if (repacked.error || repacked.status !== 0) {
          const timeoutDetail =
            (repacked.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT"
              ? `timed out after ${timeoutMs / 1000}s bound`
              : undefined
          const detail =
            timeoutDetail ?? (repacked.error?.message || repacked.stderr || repacked.stdout || `exit ${String(repacked.status)}`)
          throw new Error(
            `git repack -a -d failed for submodule ${subRel} in borrower ${borrowerIdentity}: ${detail}`,
          )
        }

        const updated = lines.filter((line) => {
          const abs = isAbsolute(line) ? line : resolve(objectsDir, line)
          return !within(lenderModules, toCanonical(abs))
        })

        const staged = `${alternatesPath}.rehome-${process.pid}`
        writeFileSync(staged, updated.length > 0 ? `${updated.join("\n")}\n` : "", "utf8")
        renameSync(staged, alternatesPath)
      }
    } catch (error) {
      throw new Error(
        `worktree ${lenderGitDir} could not be removed: borrower ${borrowerIdentity} borrows submodule objects from it and could not be re-homed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
  }

  return [...rehomedBorrowers]
}

/** The existing status walker owns repository discovery; every native status is exact, including gitlink changes. */
async function cleanSnapshot(
  git: Git,
  path: string,
  inspect: (repository: string, path: string) => Promise<WorktreeInspection>,
): Promise<readonly Readonly<{ path: string; head: string }>[]> {
  const status = superStatus({ repo: path })
  if (status.records.length > 0) {
    throw new Error(`worktree ${path} is dirty: ${status.records.join("; ")}; preserve its changes before removal`)
  }
  const snapshot: { path: string; head: string }[] = []
  for (const entry of status.consultedRepositories) {
    let state = await inspect(entry.root, entry.root)
    if (!state.registered) {
      // Git lists a primary clone with a separate gitdir at the gitdir path,
      // even though rev-parse --show-toplevel reports its actual checkout.
      const directory = realpathSync(await git.text(entry.root, ["rev-parse", "--absolute-git-dir"]))
      const common = realpathSync(
        await git.text(entry.root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      )
      if (directory === common) state = await inspect(entry.root, common)
    }
    if (!state.registered) {
      throw new Error(`worktree ${entry.root} is absent from its Git registration; inspect git worktree list`)
    }
    if (state.locked !== undefined) {
      throw new Error(`worktree ${entry.root} is locked: ${state.locked}; resolve its holder before removal`)
    }
    const dirty = await git.text(entry.root, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ])
    if (dirty !== "") throw new Error(`worktree ${entry.root} is dirty: ${dirty}; preserve its changes before removal`)
    const head = await git.commit(entry.root, "HEAD")
    snapshot.push({ path: entry.root, head })
  }
  return snapshot
}

/** Refuse symlinks and unfinished Git mutations; a retained manifest covers every ordinary file, including refs and reflogs. */
function manifest(root: string): Readonly<Record<string, string>> {
  const hashes: Record<string, string> = {}
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name)
    if (entry.name.endsWith(".lock")) throw new Error(`Git lock ${path} prevents worktree removal; resolve its holder`)
    if (entry.isDirectory()) continue
    if (!entry.isFile()) {
      throw new Error(`Git store ${path} is not a regular file; preserve and resolve it before removal`)
    }
    hashes[relative(root, path)] = createHash("sha256").update(readFileSync(path)).digest("hex")
  }
  return Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)))
}

/** Runs inside the worktree store's existing mutation lock, immediately before its one native remove. */
export async function retainWorktreeModules(
  git: Git,
  repo: string,
  requested: string,
  retention: WorktreeRetention,
  inspect: (repository: string, path: string) => Promise<WorktreeInspection>,
): Promise<WorktreeRemovalProof> {
  const path = realpathSync(requested)
  const registered = await inspect(repo, path)
  if (!registered.registered) {
    throw new Error(`worktree ${path} is not registered in ${repo}; inspect git worktree list`)
  }
  if (registered.locked !== undefined) {
    throw new Error(`worktree ${path} is locked: ${registered.locked}; resolve its holder before removal`)
  }
  const gitDir = realpathSync(await git.text(path, ["rev-parse", "--absolute-git-dir"]))
  const common = realpathSync(await git.text(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))
  if (gitDir === common) {
    throw new Error(`worktree ${path} is the primary worktree; only a linked worktree can be removed`)
  }
  const before = await cleanSnapshot(git, path, inspect)
  const modules = join(gitDir, "modules")
  // Check metadata locks before copying. The modules subtree includes every store,
  // even one left by an earlier gitlink that the current tree no longer records.
  manifest(gitDir)
  const requestedRoot = resolve(retention.root)
  // Resolve existing ancestors before creating anything, so a symlink cannot put
  // the only retained copy back inside either native deletion path.
  let ancestor = requestedRoot
  while (!existsSync(ancestor)) {
    const next = resolve(ancestor, "..")
    if (next === ancestor) throw new Error(`retention directory ${requestedRoot} has no existing parent`)
    ancestor = next
  }
  const canonical = resolve(realpathSync(ancestor), relative(ancestor, requestedRoot))
  if (within(path, canonical) || within(gitDir, canonical)) {
    throw new Error(
      `retention directory ${canonical} is inside worktree removal paths ${path} or ${gitDir}; choose an external durable directory`,
    )
  }
  mkdirSync(canonical, { recursive: true })
  const retainedRoot = mkdtempSync(join(canonical, `${basename(gitDir)}-`))
  const retained = existsSync(modules) ? join(retainedRoot, "modules") : null
  let hashes: Readonly<Record<string, string>> = {}
  if (retained !== null) {
    hashes = manifest(modules)
    cpSync(modules, retained, { recursive: true, errorOnExist: true, force: false })
    const compared = spawnSync("diff", ["-r", "--", modules, retained], {
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    })
    if (compared.error || compared.status !== 0) {
      throw new Error(
        `retention comparison failed for ${modules} and ${retained}: ${compared.error?.message || compared.stderr || compared.stdout || `exit ${String(compared.status)}`}; worktree preserved`,
      )
    }
    if (
      JSON.stringify(manifest(retained)) !== JSON.stringify(hashes) ||
      JSON.stringify(manifest(modules)) !== JSON.stringify(hashes)
    ) {
      throw new Error(
        `Git store ${modules} changed during retention at ${retained}; worktree preserved, retry after its writer stops`,
      )
    }
  }
  const rehomedBorrowers = rehomeBorrowers(common, gitDir, modules)
  const after = await cleanSnapshot(git, path, inspect)
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    throw new Error(`worktree ${path} changed during retention; preserved, retry after its writer stops`)
  }
  const proof: WorktreeRemovalProof = {
    path,
    head: await git.commit(path, "HEAD"),
    repositories: before.map((entry) => entry.path),
    modules,
    retained,
    manifest: join(retainedRoot, "manifest.json"),
    createdAt: new Date().toISOString(),
    retainUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    ...(rehomedBorrowers.length === 0 ? {} : { rehomedBorrowers }),
  }
  writeFileSync(proof.manifest, `${JSON.stringify({ ...proof, files: hashes }, null, 2)}\n`, { flag: "wx" })
  retention.report(proof)
  return proof
}
