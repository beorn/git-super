/**
 * Gate 4 of the #27443(b) retirement proof: the candidate's own Git contents, per component.
 *
 * `Effective(g)` is Git's complete loose+packed+alternate OID set from
 * `cat-file --batch-all-objects --batch-check` (it FOLLOWS alternates, so it is not the owned
 * set). `IndependentStores(g,R)` is the union of the effective sets of external alternate and
 * objects-link targets that are present, independently owned and disjoint from `R`.
 * `AtRisk(g) = Effective(g) \ IndependentStores(g,R)`. `Roots(g)` is every ref, reflog old/new,
 * pseudo-ref and index OID. Read-only: it runs git queries and reads files; it never writes,
 * prunes or gc's. A malformed row, an unreadable index, a failed git command or a cap hit is
 * `unknown`; a root OID the component's own store no longer carries is a violated condition.
 */
import { spawnSync } from "node:child_process"
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs"
import { isAbsolute, join, relative, sep } from "node:path"
import { alternateEntries } from "./alternates.ts"
import type { ManifestEntry } from "./worktree-removal.ts"

export interface GitRunResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
  /** True when the runner killed the child at `GitRunOptions.timeoutMs`, not on the child's own exit. */
  readonly timedOut?: boolean
}

export interface GitRunOptions {
  /** Hard per-child deadline. A child that outlives it is killed and reported `timedOut`. */
  readonly timeoutMs?: number
}

export type GitRun = (args: readonly string[], options?: GitRunOptions) => GitRunResult

export interface ContentsBounds {
  /** 4,000,000 effective OIDs per candidate component in the contract's initial pass. */
  readonly maxEffectiveOids: number
  /** 120 s per candidate component in the contract's initial pass. */
  readonly componentMs: number
}

export const DEFAULT_CONTENTS_BOUNDS: ContentsBounds = { maxEffectiveOids: 4_000_000, componentMs: 120_000 }

export interface ComponentContents {
  /** The component git directory, relative to the retained copy root. */
  readonly component: string
  readonly effective: number
  readonly independent: number
  /** OIDs reachable in this component but not in any independent store; the gate 5 input. */
  readonly atRisk: number
  /** Root OIDs (refs, reflogs, pseudo-refs, index) that are NOT in the store's effective set. */
  readonly missingRoots: readonly string[]
  /** The full at-risk OID list, sorted (streamed in real runs; a list here for the certificate). */
  readonly atRiskOids: readonly string[]
  /** at-risk OID -> the named source that records it (ref/reflog/pseudo-ref/index), else "owned". */
  readonly atRiskSources: Readonly<Record<string, string>>
  readonly elapsedMs: number
}

export interface ContentsScan {
  readonly status: "pass" | "blocked" | "unknown"
  readonly detail: string
  readonly components: readonly ComponentContents[]
}

const PSEUDO_REFS = [
  "FETCH_HEAD",
  "ORIG_HEAD",
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REBASE_HEAD",
  "BISECT_HEAD",
  "BISECT_LOG",
]
const HEX40 = /^[0-9a-f]{40}$/u

function within(parent: string, path: string): boolean {
  const part = relative(parent, path)
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part))
}

export function defaultGitRun(args: readonly string[], options: GitRunOptions = {}): GitRunResult {
  // spawnSync requires a non-negative integer and treats 0 as "no timeout"; clamp to >=1 ms so a
  // zero or fractional bound still kills a hung child instead of throwing or disarming the guard.
  const timeoutMs = options.timeoutMs === undefined ? undefined : Math.max(1, Math.ceil(options.timeoutMs))
  const result = spawnSync("git", [...args], {
    encoding: "utf8",
    maxBuffer: 1 << 30,
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
    },
  })
  // spawnSync reports a timeout kill as ETIMEDOUT on `error`, with `status` null. Reporting it as a
  // named signal keeps a hung child from being confused with a genuine non-zero exit.
  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT"
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: timedOut ? `git ${args[0] ?? ""} timed out after ${timeoutMs} ms` : (result.stderr ?? ""),
    ...(timedOut ? { timedOut: true } : {}),
  }
}

/** Every nested component git directory the full manifest records, not a fixed list of names. */
export function componentsFromManifest(entries: Readonly<Record<string, ManifestEntry>>): string[] {
  const names = new Set<string>()
  for (const key of Object.keys(entries)) {
    const parts = key.split("/")
    const at = parts.indexOf("objects")
    if (at === -1) continue
    names.add(parts.slice(0, at).join("/"))
  }
  return [...names].sort()
}

function parseEffective(
  stdout: string,
  cap: number,
): { status: "ok"; oids: Set<string> } | { status: "unknown"; detail: string } {
  const oids = new Map<string, string>()
  for (const line of stdout.split("\n")) {
    if (line === "") continue
    const [oid, type, size] = line.split(" ")
    if (oid === undefined || type === undefined || size === undefined || !HEX40.test(oid)) {
      return { status: "unknown", detail: `malformed cat-file row: ${line.slice(0, 120)}` }
    }
    if (type !== "commit" && type !== "tree" && type !== "blob" && type !== "tag") {
      return { status: "unknown", detail: `cat-file reported unsupported object type '${type}' for ${oid}` }
    }
    if (!/^\d+$/u.test(size)) {
      return { status: "unknown", detail: `cat-file reported malformed object size '${size}' for ${oid}` }
    }
    const previous = oids.get(oid)
    if (previous !== undefined && previous !== type) {
      return { status: "unknown", detail: `cat-file reported conflicting types for ${oid}: ${previous} and ${type}` }
    }
    oids.set(oid, type)
    if (oids.size > cap) return { status: "unknown", detail: `effective OID count exceeded the ${cap} cap` }
  }
  return { status: "ok", oids: new Set(oids.keys()) }
}

/** Strict transitive alternates closure of one object dir: every link present, no cycle back into R. */
function closure(
  objects: string,
  removal: readonly string[],
  seen: Set<string>,
): { status: "ok"; stores: string[] } | { status: "unknown"; detail: string } {
  const stores: string[] = []
  const stack = [objects]
  while (stack.length > 0) {
    const store = stack.pop()!
    if (seen.has(store)) continue
    seen.add(store)
    stores.push(store)
    const file = join(store, "info", "alternates")
    if (!existsSync(file)) continue
    let content: string
    try {
      content = readFileSync(file, "utf8")
    } catch (error) {
      return {
        status: "unknown",
        detail: `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    for (const target of alternateEntries(content, store)) {
      if (!existsSync(target) || !statSync(target).isDirectory()) {
        return { status: "unknown", detail: `${file} names a missing alternate ${target}` }
      }
      if (removal.some((root) => within(root, target))) {
        return { status: "unknown", detail: `alternate ${target} resolves inside the removal set` }
      }
      stack.push(target)
    }
  }
  return { status: "ok", stores }
}

type RootSet = Readonly<{ oids: Map<string, string[]>; unreadable?: string }>

const ZERO_OID = /^0+$/u

function addSource(oids: Map<string, string[]>, oid: string, source: string): void {
  // The contract excludes zero OIDs: the creation record of a reflog and a symbolic HEAD both
  // name them, and neither is an object the store must carry.
  if (ZERO_OID.test(oid)) return
  const existing = oids.get(oid)
  if (existing === undefined) oids.set(oid, [source])
  else existing.push(source)
}

function readRootOids(gitDir: string, run: GitRun): RootSet | { unreadable: string } {
  const oids = new Map<string, string[]>()
  const refs = run([`--git-dir=${gitDir}`, "for-each-ref", "--format=%(objectname) %(refname)"])
  if (refs.code !== 0) return { unreadable: `for-each-ref failed in ${gitDir}: ${refs.stderr.trim()}` }
  for (const line of refs.stdout.split("\n")) {
    if (line === "") continue
    const [oid, name] = line.split(" ")
    if (oid === undefined || !HEX40.test(oid)) {
      return { unreadable: `malformed for-each-ref row in ${gitDir}: ${line.slice(0, 120)}` }
    }
    addSource(oids, oid, `ref ${name ?? ""}`.trim())
  }
  const head = run([`--git-dir=${gitDir}`, "rev-parse", "HEAD"])
  if (head.code === 0) {
    const oid = head.stdout.trim()
    if (HEX40.test(oid)) addSource(oids, oid, "HEAD")
  } else if (!/unknown revision|Needed a single revision|ambiguous argument/u.test(head.stderr)) {
    return { unreadable: `rev-parse HEAD failed in ${gitDir}: ${head.stderr.trim()}` }
  }
  const logs = join(gitDir, "logs")
  if (existsSync(logs)) {
    const walk = (dir: string): string | undefined => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          const problem = walk(path)
          if (problem !== undefined) return problem
        } else if (entry.isFile()) {
          let content: string
          try {
            content = readFileSync(path, "utf8")
          } catch (error) {
            return `cannot read reflog ${path}: ${error instanceof Error ? error.message : String(error)}`
          }
          for (const line of content.split("\n")) {
            if (line === "") continue
            const [old, next] = line.split(" ")
            if (old === undefined || next === undefined || !HEX40.test(old) || !HEX40.test(next)) {
              return `malformed reflog record in ${path}: ${line.slice(0, 120)}`
            }
            addSource(oids, old, `reflog ${relative(gitDir, path)}`)
            addSource(oids, next, `reflog ${relative(gitDir, path)}`)
          }
        }
      }
      return undefined
    }
    const problem = walk(logs)
    if (problem !== undefined) return { unreadable: problem }
  }
  for (const name of PSEUDO_REFS) {
    const path = join(gitDir, name)
    if (!existsSync(path) || !statSync(path).isFile()) continue
    const content = readFileSync(path, "utf8")
    const found = (content.match(/[0-9a-f]{40}/gu) ?? []).filter((oid) => HEX40.test(oid))
    if (found.length === 0 && content.trim() !== "") return { unreadable: `pseudo-ref ${path} holds no object id` }
    for (const oid of found) addSource(oids, oid, `pseudo-ref ${name}`)
  }
  const index = run([`--git-dir=${gitDir}`, "ls-files", "--stage"])
  if (index.code === 0) {
    for (const line of index.stdout.split("\n")) {
      if (line === "") continue
      const oid = line.split(/\s+/u)[1]
      if (oid !== undefined && HEX40.test(oid)) addSource(oids, oid, "index")
    }
  } else if (/index file smaller|bad index|unknown index|fatal: index/u.test(index.stderr)) {
    return { unreadable: `unreadable index in ${gitDir}: ${index.stderr.trim()}` }
  }
  return { oids }
}

export function scanContents(
  copyRoot: string,
  entries: Readonly<Record<string, ManifestEntry>>,
  removal: readonly string[],
  run: GitRun = defaultGitRun,
  bounds: ContentsBounds = DEFAULT_CONTENTS_BOUNDS,
  clock: () => number = Date.now,
): ContentsScan {
  const components: ComponentContents[] = []
  for (const component of componentsFromManifest(entries)) {
    const started = clock()
    const gitDir = join(copyRoot, component)
    // Every child is bounded by the component's REMAINING budget, so a hung git child yields
    // `unknown` at the bound instead of blocking the scan forever (the post-component check below
    // could never fire while a single `spawnSync` still had the process).
    const componentRun: GitRun = (args) => {
      const remaining = started + bounds.componentMs - clock()
      if (remaining <= 0) {
        return {
          code: 1,
          stdout: "",
          stderr: `git ${args[0] ?? ""} not run: the ${bounds.componentMs} ms component bound is already exhausted`,
          timedOut: true,
        }
      }
      return run(args, { timeoutMs: remaining })
    }
    const effectiveRun = componentRun([
      `--git-dir=${gitDir}`,
      `--work-tree=${copyRoot}`,
      "cat-file",
      "--batch-all-objects",
      "--batch-check",
    ])
    if (effectiveRun.code !== 0) {
      return {
        status: "unknown",
        detail: `cat-file failed for ${component}: ${effectiveRun.stderr.trim()}`,
        components,
      }
    }
    const effective = parseEffective(effectiveRun.stdout, bounds.maxEffectiveOids)
    if (effective.status !== "ok") return { status: "unknown", detail: `${component}: ${effective.detail}`, components }
    const objects = join(gitDir, "objects")
    const seen = new Set<string>()
    const closureResult = closure(objects, removal, seen)
    if (closureResult.status !== "ok") {
      return { status: "unknown", detail: `${component}: ${closureResult.detail}`, components }
    }
    // IndependentStores(g,R) also includes an actual external `objects`-symlink target: its store
    // survives E and those objects are borrowed, never owned (contract gate 4). Dropping the
    // component's own initial store while keeping the link target is the whole correction.
    const independentStores = new Set<string>()
    for (const store of closureResult.stores) {
      if (store === objects) continue
      independentStores.add(store)
    }
    const linkMetadata = lstatSync(objects, { throwIfNoEntry: false })
    if (linkMetadata?.isSymbolicLink() === true) {
      let linkTarget: string
      try {
        linkTarget = realpathSync(objects)
        if (!statSync(linkTarget).isDirectory()) throw new Error("target is not a directory")
      } catch (error) {
        return {
          status: "unknown",
          detail: `${component}: objects link ${objects} is dangling or not a directory: ${error instanceof Error ? error.message : String(error)}`,
          components,
        }
      }
      if (removal.some((root) => within(root, linkTarget))) {
        return {
          status: "unknown",
          detail: `${component}: objects link target ${linkTarget} resolves inside the removal set`,
          components,
        }
      }
      independentStores.add(linkTarget)
    }
    const independent = new Set<string>()
    for (const store of [...independentStores].sort()) {
      const storeRun = componentRun([
        `--git-dir=${join(store, "..")}`,
        `--work-tree=${copyRoot}`,
        "cat-file",
        "--batch-all-objects",
        "--batch-check",
      ])
      if (storeRun.code !== 0) {
        return {
          status: "unknown",
          detail: `cat-file failed for independent store ${store}: ${storeRun.stderr.trim()}`,
          components,
        }
      }
      const parsed = parseEffective(storeRun.stdout, bounds.maxEffectiveOids)
      if (parsed.status !== "ok") {
        return { status: "unknown", detail: `independent store ${store}: ${parsed.detail}`, components }
      }
      for (const oid of parsed.oids) independent.add(oid)
    }
    const atRiskOids = [...effective.oids].filter((oid) => !independent.has(oid)).sort()
    const roots = readRootOids(gitDir, componentRun)
    if ("unreadable" in roots) return { status: "unknown", detail: `${component}: ${roots.unreadable}`, components }
    const rootOids = roots.oids
    const missingRoots = [...rootOids.keys()].filter((oid) => !effective.oids.has(oid)).sort()
    const atRiskSources: Record<string, string> = {}
    for (const oid of atRiskOids) atRiskSources[oid] = rootOids.get(oid)?.join(", ") ?? "owned"
    components.push({
      component,
      effective: effective.oids.size,
      independent: independent.size,
      atRisk: atRiskOids.length,
      missingRoots,
      atRiskOids,
      atRiskSources,
      elapsedMs: clock() - started,
    })
    if (clock() - started > bounds.componentMs) {
      return {
        status: "unknown",
        detail: `${component} exceeded the ${bounds.componentMs} ms component bound after ${effective.oids.size} OIDs`,
        components,
      }
    }
  }
  const missing = components.filter((entry) => entry.missingRoots.length > 0)
  if (missing.length > 0) {
    return {
      status: "blocked",
      detail: `${missing.length} component(s) name root OIDs their own store no longer carries, e.g. ${missing[0]!.component} ${missing[0]!.missingRoots[0]}`,
      components,
    }
  }
  const atRisk = components.reduce((total, entry) => total + entry.atRisk, 0)
  return {
    status: "pass",
    detail: `${components.length} component(s); ${atRisk} at-risk OID(s) for gate 5 custody`,
    components,
  }
}
