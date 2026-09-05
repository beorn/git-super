/**
 * @failure Worktree consumers can fall back to divergent submodule materializers or serialize sibling clones.
 * @level l1
 * @consumer Yrd, Bearly, and hh worktree adapters
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { canonicalTmpdir as tmpdir } from "./fixture.ts"
import { join } from "node:path"
import { createLogger, type ConditionalLogger, type Event } from "loggily"
import { afterEach, describe, expect, it } from "vitest"
import {
  materializeSubmodules,
  materializeSubmodulesWithProcess,
  materializeSubmodulesFromLocalWorktree,
  materializeSubmodulesFromLocalWorktreeParallel,
  type SubmoduleGit,
  type SubmoduleGitResult,
} from "../src/submodules.ts"
import { createLocalGitProcess, type GitProcessRequest } from "../src/process.ts"
import { cleanGitRepositoryEnvironment } from "../src/git.ts"

const success = (): SubmoduleGitResult => ({ code: 0, stdout: "", stderr: "" })
const roots: string[] = []

function git(repo: string, args: readonly string[]): string {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`)
  return result.stdout
}

function withPrimaryWorktree(git: SubmoduleGit, primary: string): SubmoduleGit {
  return {
    ...git,
    async run(repo, args, allowFailure) {
      if (repo === primary && args[0] === "worktree" && args[1] === "list") {
        return { ...success(), stdout: `worktree ${primary}\n\n` }
      }
      return git.run(repo, args, allowFailure)
    },
  }
}

/**
 * Answer the anchor's two `rev-parse` reads so a mocked submodule store already
 * LIVES at its durable home (`<root>/modules/<name>/objects`) — the anchor then
 * has nothing to append, exactly like materializing the primary checkout
 * itself. `modules` maps submodule path → submodule name.
 */
function withDurableStores(
  git: SubmoduleGit,
  worktree: string,
  root: string,
  modules: Record<string, string>,
): SubmoduleGit {
  return {
    ...git,
    async run(repo, args, allowFailure) {
      if (args[0] === "rev-parse" && args.includes("--git-common-dir") && repo === worktree) {
        return { ...success(), stdout: `${root}\n` }
      }
      if (args[0] === "rev-parse" && args.includes("--git-path")) {
        const path = Object.keys(modules).find((candidate) => repo === join(worktree, candidate))
        const name = path === undefined ? undefined : modules[path]
        if (name !== undefined) return { ...success(), stdout: `${join(root, "modules", name, "objects")}\n` }
      }
      return git.run(repo, args, allowFailure)
    },
  }
}

/**
 * Log lines only: `spans: false` so the message assertions below stay about
 * what the code SAID. Span timing is asserted separately through collected
 * span records, where the shape is data rather than a rendered line.
 */
function capturingLogger(messages: string[]): ConditionalLogger {
  return createLogger("git-super-test", [
    { level: "trace", spans: false },
    { write: (text: string) => void messages.push(String(text).replace(/\n$/u, "")), objectMode: false },
  ])
}

type SpanEventRow = Readonly<{ name?: string; duration?: number; props?: Record<string, unknown> }>

/**
 * A logger plus the span events a sink received from it. `named` strips the
 * logger namespace loggily prefixes onto every span (`git-super-spans:walk`),
 * so a test names the span the code names and not the wiring around it.
 */
function spanEvents(): Readonly<{ log: ConditionalLogger; named: (span: string) => SpanEventRow[] }> {
  const events: SpanEventRow[] = []
  const log = createLogger("git-super-spans", [
    { level: "trace", spans: true },
    {
      write: (event: Event) => {
        if ((event as { kind?: string }).kind === "span") events.push(event as SpanEventRow)
      },
      objectMode: true,
    },
  ])
  return { log, named: (span) => events.filter((event) => event.name?.endsWith(`:${span}`) === true) }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("materializeSubmodules", () => {
  it("creates a worktree after deleting a gitlink and reports its stale local config once", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "git-super-stale-config-"))
    roots.push(fixtureRoot)
    const dependency = join(fixtureRoot, "dependency")
    const owner = join(fixtureRoot, "owner")
    const candidate = join(fixtureRoot, "candidate")
    await mkdir(dependency)
    await mkdir(owner)
    for (const repository of [dependency, owner]) {
      git(repository, ["init", "-q"])
      git(repository, ["config", "user.email", "git-super@example.invalid"])
      git(repository, ["config", "user.name", "Git Super Test"])
      writeFileSync(join(repository, "README.md"), `${repository}\n`)
      git(repository, ["add", "README.md"])
      git(repository, ["commit", "-q", "-m", "initial"])
    }
    git(owner, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", dependency, "hh-web"])
    git(owner, ["commit", "-q", "-am", "add hh-web"])
    git(owner, ["rm", "-q", "-f", "hh-web"])
    git(owner, ["commit", "-q", "-am", "delete hh-web"])

    // Reproduce the estate residue: the target tree no longer declares the
    // gitlink, while multiple keys keep one stale local subsection alive.
    git(owner, ["config", "--local", "submodule.hh-web.url", dependency])
    git(owner, ["config", "--local", "submodule.hh-web.active", "true"])
    git(owner, ["worktree", "add", "-q", "--detach", candidate, "HEAD"])
    const messages: string[] = []

    const result = await materializeSubmodulesFromLocalWorktreeParallel({
      worktree: candidate,
      referenceWorktree: owner,
      log: capturingLogger(messages),
    })

    expect(result).toMatchObject({ exitCode: 0, considered: 0 })
    expect(git(candidate, ["rev-parse", "HEAD"])).toBe(git(owner, ["rev-parse", "HEAD"]))
    const cleanup = messages.filter((message) => message.includes("--remove-section"))
    expect(cleanup).toHaveLength(1)
    expect(cleanup[0]).toContain(`git -C '${candidate}' config --local --remove-section 'submodule.hh-web'`)
  })

  it("uses the canonical GitProcess request internally", async () => {
    const requests: GitProcessRequest[] = []
    const result = await materializeSubmodulesWithProcess(
      {
        async run(request) {
          requests.push(request)
          if (request.args[0] === "cat-file") return { code: 1, stdout: "", stderr: "", timedOut: false }
          return { code: 0, stdout: "", stderr: "", timedOut: false }
        },
      },
      { worktree: "/worktree" },
    )

    expect(result.code).toBe(0)
    expect(requests.every((request) => request.repo === "/worktree")).toBe(true)
  })

  it("strips repository pointers without deleting caller Git policy", () => {
    expect(
      cleanGitRepositoryEnvironment({
        GIT_DIR: "/wrong",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "protocol.file.allow",
      }),
    ).toMatchObject({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "protocol.file.allow" })
    expect(cleanGitRepositoryEnvironment({ GIT_DIR: "/wrong" })).not.toHaveProperty("GIT_DIR")
  })

  it("falls back loudly when the exact gitlink is absent from the local reference", async () => {
    const worktree = "/candidate"
    const referenceWorktree = await mkdtemp(join(tmpdir(), "git-super-missing-reference-"))
    roots.push(referenceWorktree)
    const messages: string[] = []
    const commands: Array<Readonly<{ repo: string; args: readonly string[] }>> = []
    const git: SubmoduleGit = {
      async run(repo, args) {
        commands.push({ repo, args })
        if (args[0] === "cat-file" && args.at(-1) === "HEAD:.gitmodules") {
          return repo === worktree ? success() : { ...success(), code: 1 }
        }
        if (args[0] === "config" && args[1] === "--blob") {
          return { ...success(), stdout: "submodule.maddoc.path apps/maddoc" }
        }
        if (args[0] === "ls-tree") {
          return { ...success(), stdout: `160000 commit ${"a".repeat(40)}\tapps/maddoc\n` }
        }
        if (args[0] === "config" && args[1] === "--get") {
          return { ...success(), stdout: "https://example.invalid/maddoc.git\n" }
        }
        return success()
      },
    }

    // Was: resolves code 0 with remoteFallbacks 1. The title said "loudly" and
    // the assertion said "succeed" — the counter was incremented, printed, and
    // consumed by nobody. That is the silent error this suite now forbids.
    const refused = await materializeSubmodules(withPrimaryWorktree(git, referenceWorktree), {
      worktree,
      referenceWorktree,
      log: capturingLogger(messages),
    })
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain("would open their own network connection")
    expect(refused.stderr).toContain("apps/maddoc")
    expect(refused.stderr).toContain("a".repeat(40))
    expect(commands.some(({ repo }) => repo === `${referenceWorktree}/apps/maddoc`)).toBe(false)
  })

  it("batches the local probes but NEVER overlaps two warm-up fetches", async () => {
    const referenceWorktree = await mkdtemp(join(tmpdir(), "git-super-serial-"))
    roots.push(referenceWorktree)
    const paths = ["a/one", "a/two", "a/three", "a/four", "a/five"]
    for (const path of paths) await mkdir(join(referenceWorktree, path), { recursive: true })
    const worktree = "/candidate"

    let liveProbes = 0
    let peakProbes = 0
    let liveFetches = 0
    let peakFetches = 0
    const settle = async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 2))
    }

    const git: SubmoduleGit = {
      async run(repo, args) {
        if (args[0] === "cat-file" && args.at(-1) === "HEAD:.gitmodules") {
          return repo === worktree ? success() : { ...success(), code: 1 }
        }
        if (args[0] === "config" && args[1] === "--blob") {
          return {
            ...success(),
            stdout: paths.map((path, index) => `submodule.s${index}.path ${path}`).join("\n"),
          }
        }
        if (args[0] === "ls-tree") {
          liveProbes += 1
          peakProbes = Math.max(peakProbes, liveProbes)
          await settle()
          liveProbes -= 1
          const path = args.at(-1)
          return { ...success(), stdout: `160000 commit ${"1".repeat(40)}\t${String(path)}\n` }
        }
        if (args[0] === "config" && args[1] === "--get-regexp") return { ...success(), code: 1 }
        if (args[0] === "config" && args[1] === "--get") {
          return { ...success(), stdout: "https://example.invalid/x.git\n" }
        }
        if (args[0] === "fetch") {
          // THE INVARIANT. A second concurrent fetch here is the 2026-08-21
          // fan-out, so this counter is the test, not decoration.
          liveFetches += 1
          peakFetches = Math.max(peakFetches, liveFetches)
          await settle()
          liveFetches -= 1
          return success()
        }
        // Never warm: every gitlink misses, so all five reach the warm-up path.
        if (args[0] === "cat-file" && args[1] === "-e") return { ...success(), code: 1 }
        return success()
      },
    }

    const refused = await materializeSubmodules(withPrimaryWorktree(git, referenceWorktree), {
      worktree,
      referenceWorktree,
    })

    // All five missed and could not be repaired, so the fail-loud refuses — that
    // is incidental here. What matters is HOW the work was scheduled.
    expect(refused.code).toBe(1)

    // Local probes ran concurrently: five gitlinks, bound of 20, so all five
    // overlap. A peak of 1 would mean the batching silently did not happen.
    expect(peakProbes).toBe(paths.length)

    // @chief's acceptance criterion, proven rather than asserted:
    // LOCAL PROBES BATCH; WARM-UPS STAY SERIALIZED.
    expect(peakFetches).toBe(1)
  })

  it("SAYS SO when no reference store was supplied, instead of materializing silently", async () => {
    const worktree = "/candidate"
    const messages: string[] = []
    const git: SubmoduleGit = {
      async run(repo, args) {
        if (args[0] === "cat-file" && args.at(-1) === "HEAD:.gitmodules") {
          return repo === worktree ? success() : { ...success(), code: 1 }
        }
        if (args[0] === "config" && args[1] === "--blob") {
          return { ...success(), stdout: "submodule.maddoc.path apps/maddoc" }
        }
        if (args[0] === "ls-tree") return { ...success(), stdout: `160000 commit ${"f".repeat(40)}\tapps/maddoc\n` }
        if (args[0] === "config" && args[1] === "--get") {
          return { ...success(), stdout: "https://example.invalid/maddoc.git\n" }
        }
        return success()
      },
    }

    // No referenceWorktree at all. This is a LEGITIMATE plain clone, so it must
    // succeed — but before this it was also indistinguishable from a caller who
    // meant to pass one and forgot, which is one of the three causes 2026-08-21
    // could not separate. The refusal cannot cover it (no reference means no
    // refusal), so the coverage is this diagnostic plus the `unreferenced`
    // count. The old `reference ?? "(none supplied)"` string was unreachable and
    // covered nothing; this is what actually reaches the case.
    const result = await materializeSubmodules(
      withDurableStores(git, worktree, "/durable", { "apps/maddoc": "maddoc" }),
      {
        worktree,
        log: capturingLogger(messages),
      },
    )

    expect(result).toMatchObject({ code: 0, considered: 1, borrowed: 0, remoteFallbacks: 0, unreferenced: 1 })
    expect(result.borrowed + result.remoteFallbacks + result.unreferenced).toBe(result.considered)
    expect(messages).toEqual([expect.stringContaining("no reference store supplied; materializing from the network")])
    // The remedy is named, or the warning is just an observation.
    expect(messages[0]).toContain("referenceWorktree")
  })

  it("never renders an unreachable '(none supplied)' — the refusal only fires WITH a reference", async () => {
    const worktree = "/candidate"
    const referenceWorktree = await mkdtemp(join(tmpdir(), "git-super-refusal-reference-"))
    roots.push(referenceWorktree)
    const git: SubmoduleGit = {
      async run(repo, args) {
        if (args[0] === "cat-file" && args.at(-1) === "HEAD:.gitmodules") {
          return repo === worktree ? success() : { ...success(), code: 1 }
        }
        if (args[0] === "config" && args[1] === "--blob") {
          return { ...success(), stdout: "submodule.maddoc.path apps/maddoc" }
        }
        if (args[0] === "ls-tree") return { ...success(), stdout: `160000 commit ${"e".repeat(40)}\tapps/maddoc\n` }
        if (args[0] === "config" && args[1] === "--get") {
          return { ...success(), stdout: "https://example.invalid/maddoc.git\n" }
        }
        return success()
      },
    }

    const refused = await materializeSubmodules(withPrimaryWorktree(git, referenceWorktree), {
      worktree,
      referenceWorktree,
    })

    // Every miss is pushed inside `referenceSubmodule !== undefined`, so the
    // refusal always has a real path to print. Asserted so nobody reintroduces
    // a fallback string that can never render and then reports it as coverage.
    expect(refused.code).toBe(1)
    expect(refused.stderr).not.toContain("(none supplied)")
    expect(refused.stderr).toContain(`${referenceWorktree}/apps/maddoc`)
  })

  it("names the missing pin, the reference consulted, and the command that repairs it", async () => {
    const worktree = "/candidate"
    const referenceWorktree = await mkdtemp(join(tmpdir(), "git-super-remedy-reference-"))
    roots.push(referenceWorktree)
    const git: SubmoduleGit = {
      async run(repo, args) {
        if (args[0] === "cat-file" && args.at(-1) === "HEAD:.gitmodules") {
          return repo === worktree ? success() : { ...success(), code: 1 }
        }
        if (args[0] === "config" && args[1] === "--blob") {
          return { ...success(), stdout: "submodule.maddoc.path apps/maddoc" }
        }
        if (args[0] === "ls-tree") return { ...success(), stdout: `160000 commit ${"b".repeat(40)}\tapps/maddoc\n` }
        if (args[0] === "config" && args[1] === "--get") {
          return { ...success(), stdout: "https://example.invalid/maddoc.git\n" }
        }
        return success()
      },
    }

    const refused = await materializeSubmodules(withPrimaryWorktree(git, referenceWorktree), {
      worktree,
      referenceWorktree,
    })

    // A bare count is what made this invisible for a night; the refusal has to
    // carry enough to act on without re-deriving anything.
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain("apps/maddoc")
    expect(refused.stderr).toContain(`${referenceWorktree}/apps/maddoc`)
    expect(refused.stderr).toContain(`fetch --no-tags origin ${"b".repeat(40)}`)
    expect(refused.stderr).toContain("2026-08-21")
  })

  /**
   * A candidate tree that predates a submodule REMOVAL. The reference's own HEAD
   * dropped the gitlink, so the store it names was never merely cold — it is
   * gone by design, and "repair the reference store, then retry" is advice that
   * cannot be followed. Found 2026-08-24 on hh's `hh-web` detachment: every
   * branch older than the removal refused with a fetch command pointing at a
   * directory that does not exist, and the queue kept telling owners to submit
   * or recut those branches, both of which fail at exactly this call.
   */
  const detachedReferenceGit = (
    worktree: string,
    referenceWorktree: string,
    commands: Array<Readonly<{ repo: string; args: readonly string[] }>>,
    options: Readonly<{ referenceTreeReadable?: boolean }> = {},
  ): SubmoduleGit => ({
    async run(repo, args) {
      commands.push({ repo, args })
      if (args[0] === "cat-file" && args.at(-1) === "HEAD:.gitmodules") {
        return repo === worktree ? success() : { ...success(), code: 1 }
      }
      if (args[0] === "config" && args[1] === "--blob") {
        return { ...success(), stdout: "submodule.hh-web.path hh-web" }
      }
      if (args[0] === "ls-tree") {
        // THE WHOLE DISCRIMINATOR. The candidate still carries the gitlink; the
        // reference does not. Two different repos, two different answers — the
        // pair is what separates "cold store" from "removed submodule".
        if (repo === referenceWorktree) {
          return options.referenceTreeReadable === false ? { ...success(), code: 128 } : success()
        }
        return { ...success(), stdout: `160000 commit ${"9".repeat(40)}\thh-web\n` }
      }
      if (args[0] === "log") {
        return { ...success(), stdout: "d9558f2038 chore(repo)!: detach hh-web and remove CI credential arm\n" }
      }
      // The pin is absent from the reference store, and the store is not a
      // partial clone — so without the pre-flight this reaches the warm-up.
      if (args[0] === "cat-file" && args[1] === "-e") return { ...success(), code: 1 }
      if (args[0] === "config" && args[1] === "--get-regexp") return { ...success(), code: 1 }
      if (args[0] === "config" && args[1] === "--get") {
        return { ...success(), stdout: "https://example.invalid/hh-web.git\n" }
      }
      return success()
    },
  })

  it("names the removing commit and asks for a re-author when the reference dropped the submodule", async () => {
    const worktree = "/candidate"
    const referenceWorktree = await mkdtemp(join(tmpdir(), "git-super-detached-reference-"))
    roots.push(referenceWorktree)
    // The store DIRECTORY exists, so a warm-up would really run a fetch here.
    // Without that the "no fetch attempted" assertion below would pass for the
    // wrong reason — `warmReference` short-circuits on a missing directory.
    await mkdir(join(referenceWorktree, "hh-web"), { recursive: true })
    const commands: Array<Readonly<{ repo: string; args: readonly string[] }>> = []

    const refused = await materializeSubmodules(
      withPrimaryWorktree(detachedReferenceGit(worktree, referenceWorktree, commands), referenceWorktree),
      { worktree, referenceWorktree },
    )

    expect(refused.code).toBe(1)
    // The discriminator must have been consulted at the reference path git
    // reports. `materializeSubmodules` canonicalizes the reference, so a mock
    // keyed on an alias (Darwin's /var for /private/var) answers the candidate's
    // tree for both repos and turns this removal into a cold store — which is
    // how macos-15 read a re-author case as "repair the reference store".
    expect(
      commands.filter(({ args }) => args[0] === "ls-tree").map(({ repo }) => repo),
      "ls-tree was never asked about the reference",
    ).toContain(referenceWorktree)
    // The real cause, and the commit that caused it — derived from the
    // reference's own history, never hardcoded.
    expect(refused.stderr).toContain("d9558f2038")
    expect(refused.stderr).toContain("detach hh-web")
    expect(refused.stderr).toMatch(/re-author/iu)
    // The advice that cannot be followed must be ABSENT, not merely accompanied:
    // a caller who reads it provisions a store the repository deliberately
    // dropped, which is satisfying a guard by editing the world.
    expect(refused.stderr).not.toContain("Repair the reference store")
    expect(refused.stderr).not.toContain(`fetch --no-tags origin ${"9".repeat(40)}`)
    // PRE-FLIGHT, not post-mortem: the refusal lands before the network call.
    expect(commands.some(({ args }) => args[0] === "fetch")).toBe(false)
  })

  it("does not call an unreadable reference a removal — that is a different state", async () => {
    const worktree = "/candidate"
    const referenceWorktree = await mkdtemp(join(tmpdir(), "git-super-unreadable-reference-"))
    roots.push(referenceWorktree)
    await mkdir(join(referenceWorktree, "hh-web"), { recursive: true })
    const commands: Array<Readonly<{ repo: string; args: readonly string[] }>> = []

    const refused = await materializeSubmodules(
      withPrimaryWorktree(
        detachedReferenceGit(worktree, referenceWorktree, commands, { referenceTreeReadable: false }),
        referenceWorktree,
      ),
      { worktree, referenceWorktree },
    )

    // An `ls-tree` that FAILED says nothing about whether the submodule was
    // removed. Claiming a permanent repo fact from a failed read would send a
    // recoverable cold store down the re-author path, which is unrecoverable
    // advice. So this one keeps the old, correct remedy.
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain("Repair the reference store")
    expect(refused.stderr).not.toMatch(/re-author/iu)
    expect(commands.some(({ args }) => args[0] === "fetch")).toBe(true)
  })

  it("prints the fetch remedy for the cold store only, never for the removed one", async () => {
    const worktree = "/candidate"
    const referenceWorktree = await mkdtemp(join(tmpdir(), "git-super-mixed-reference-"))
    roots.push(referenceWorktree)
    for (const path of ["hh-web", "ag"]) await mkdir(join(referenceWorktree, path), { recursive: true })
    const removed = "9".repeat(40)
    const cold = "a".repeat(40)
    const treeReads: string[] = []
    const git: SubmoduleGit = {
      async run(repo, args) {
        if (args[0] === "cat-file" && args.at(-1) === "HEAD:.gitmodules") {
          return repo === worktree ? success() : { ...success(), code: 1 }
        }
        if (args[0] === "config" && args[1] === "--blob") {
          return { ...success(), stdout: "submodule.hh-web.path hh-web\nsubmodule.ag.path ag" }
        }
        if (args[0] === "ls-tree") {
          treeReads.push(repo)
          const path = args.at(-1)
          // The reference dropped `hh-web` and still carries `ag`. One tree, two
          // classes — the mix a real superproject actually presents.
          if (repo === referenceWorktree) {
            return path === "hh-web" ? success() : { ...success(), stdout: `160000 commit ${cold}\tag\n` }
          }
          return { ...success(), stdout: `160000 commit ${path === "hh-web" ? removed : cold}\t${String(path)}\n` }
        }
        if (args[0] === "log") return { ...success(), stdout: "d9558f2038 chore(repo)!: detach hh-web\n" }
        if (args[0] === "cat-file" && args[1] === "-e") return { ...success(), code: 1 }
        if (args[0] === "config" && args[1] === "--get-regexp") return { ...success(), code: 1 }
        if (args[0] === "config" && args[1] === "--get") {
          return { ...success(), stdout: "https://example.invalid/x.git\n" }
        }
        return success()
      },
    }

    const refused = await materializeSubmodules(withPrimaryWorktree(git, referenceWorktree), {
      worktree,
      referenceWorktree,
    })

    expect(refused.code).toBe(1)
    // The reference must have been read at the path git reports, or the mock
    // classifies both misses as cold and the re-author remedy never renders.
    expect(treeReads, "ls-tree was never asked about the reference").toContain(referenceWorktree)
    // Both remedies present, each attached to the miss it can actually fix.
    expect(refused.stderr).toMatch(/re-author/iu)
    expect(refused.stderr).toContain("Repair the reference store")
    expect(refused.stderr).toContain(`fetch --no-tags origin ${cold}`)
    // The regression this test exists for: the removed submodule's sha must
    // never appear in a fetch command, however the two blocks are assembled.
    expect(refused.stderr).not.toContain(`fetch --no-tags origin ${removed}`)
  })

  it("permits fallback only when the caller raises the limit deliberately", async () => {
    const worktree = "/candidate"
    const referenceWorktree = await mkdtemp(join(tmpdir(), "git-super-fallback-reference-"))
    roots.push(referenceWorktree)
    const messages: string[] = []
    const git: SubmoduleGit = {
      async run(repo, args) {
        if (args[0] === "cat-file" && args.at(-1) === "HEAD:.gitmodules") {
          return repo === worktree ? success() : { ...success(), code: 1 }
        }
        if (args[0] === "config" && args[1] === "--blob") {
          return { ...success(), stdout: "submodule.maddoc.path apps/maddoc" }
        }
        if (args[0] === "ls-tree") return { ...success(), stdout: `160000 commit ${"c".repeat(40)}\tapps/maddoc\n` }
        if (args[0] === "config" && args[1] === "--get") {
          return { ...success(), stdout: "https://example.invalid/maddoc.git\n" }
        }
        return success()
      },
    }

    await expect(
      materializeSubmodules(
        withDurableStores(withPrimaryWorktree(git, referenceWorktree), worktree, "/durable", {
          "apps/maddoc": "maddoc",
        }),
        {
          worktree,
          referenceWorktree,
          maxRemoteFallbacks: 1,
          log: capturingLogger(messages),
        },
      ),
    ).resolves.toMatchObject({ code: 0, borrowed: 0, remoteFallbacks: 1, warmed: 0 })
    // A warm-up is always attempted first, so the operator sees the repair try
    // and its failure — not just the fallback it silently degraded into.
    expect(messages).toEqual([
      expect.stringContaining("warming the reference with one fetch"),
      expect.stringContaining("using the configured remote fallback"),
    ])
  })

  it("repairs a cold reference with ONE fetch and then borrows locally", async () => {
    const referenceWorktree = await mkdtemp(join(tmpdir(), "git-super-warm-"))
    roots.push(referenceWorktree)
    await mkdir(join(referenceWorktree, "apps/maddoc"), { recursive: true })
    const worktree = "/candidate"
    const required = "d".repeat(40)
    const messages: string[] = []
    let fetched = 0

    const git: SubmoduleGit = {
      async run(repo, args) {
        if (args[0] === "cat-file" && args.at(-1) === "HEAD:.gitmodules") {
          return repo === worktree ? success() : { ...success(), code: 1 }
        }
        if (args[0] === "config" && args[1] === "--blob") {
          return { ...success(), stdout: "submodule.maddoc.path apps/maddoc" }
        }
        if (args[0] === "ls-tree") return { ...success(), stdout: `160000 commit ${required}\tapps/maddoc\n` }
        if (args[0] === "config" && args[1] === "--get-regexp") return { ...success(), code: 1 }
        if (args[0] === "config" && args[1] === "--get") {
          return { ...success(), stdout: "https://example.invalid/maddoc.git\n" }
        }
        if (args[0] === "fetch") {
          fetched += 1
          return success()
        }
        // Cold until the fetch lands, warm afterwards.
        if (args[0] === "cat-file" && args[1] === "-e") {
          return fetched === 0 ? { ...success(), code: 1 } : success()
        }
        return success()
      },
    }

    await expect(
      materializeSubmodules(
        withDurableStores(withPrimaryWorktree(git, referenceWorktree), worktree, "/durable", {
          "apps/maddoc": "maddoc",
        }),
        {
          worktree,
          referenceWorktree,
          log: capturingLogger(messages),
        },
      ),
    ).resolves.toMatchObject({ code: 0, borrowed: 1, remoteFallbacks: 0, warmed: 1 })
    // The whole point: one connection repairs the store for every later
    // candidate, instead of one connection per submodule repairing nothing.
    expect(fetched).toBe(1)
    expect(messages).toEqual([expect.stringContaining("warming the reference with one fetch")])
  })

  it("times each phase and ships the DENOMINATOR beside the counters", async () => {
    const referenceWorktree = await mkdtemp(join(tmpdir(), "git-super-spans-"))
    roots.push(referenceWorktree)
    await mkdir(join(referenceWorktree, "apps/maddoc"), { recursive: true })
    const worktree = "/candidate"
    const required = "e".repeat(40)

    const git: SubmoduleGit = {
      async run(repo, args) {
        if (args[0] === "cat-file" && args.at(-1) === "HEAD:.gitmodules") {
          return repo === worktree ? success() : { ...success(), code: 1 }
        }
        if (args[0] === "config" && args[1] === "--blob") {
          return { ...success(), stdout: "submodule.maddoc.path apps/maddoc" }
        }
        if (args[0] === "ls-tree") return { ...success(), stdout: `160000 commit ${required}\tapps/maddoc\n` }
        if (args[0] === "config" && args[1] === "--get-regexp") return { ...success(), code: 1 }
        if (args[0] === "config" && args[1] === "--get") {
          return { ...success(), stdout: "https://example.invalid/maddoc.git\n" }
        }
        return success()
      },
    }

    // Asserted through a sink rather than `startCollecting()`, because a sink
    // is what an aggregator actually receives. The collector returns proxied
    // spanData carrying only assigned keys — no name, no props, no laps — so a
    // test written against it would pass while the emitted event stayed empty.
    const spans = spanEvents()
    const materialized = await materializeSubmodules(
      withDurableStores(withPrimaryWorktree(git, referenceWorktree), worktree, "/durable", {
        "apps/maddoc": "maddoc",
      }),
      {
        worktree,
        referenceWorktree,
        log: spans.log,
      },
    )
    // The RESULT carries the denominator now, not only the span. A caller with
    // no logger used to get counts and no total.
    expect(materialized).toMatchObject({
      code: 0,
      considered: 1,
      borrowed: 1,
      remoteFallbacks: 0,
      unreferenced: 0,
      warmed: 0,
    })
    // The partition is exact and total, and `warmed` is deliberately outside it
    // because it counts a subset of `borrowed`. Asserted as arithmetic rather
    // than as four literals, so a future counter that breaks the identity fails
    // here instead of quietly making the total mean nothing.
    expect(materialized.borrowed + materialized.remoteFallbacks + materialized.unreferenced).toBe(
      materialized.considered,
    )

    // `remoteFallbacks: 0` is unreadable on its own — zero of zero and zero of
    // sixteen are the same number. The span carries what the counters are
    // counts OF, which is the difference between an instrument and a number.
    expect(spans.named("materialize")[0]?.props).toMatchObject({
      considered: 1,
      borrowed: 1,
      warmed: 0,
      remoteFallbacks: 0,
      outcome: "ok",
    })

    // Per-submodule attribution, and local-vs-network on the record rather than
    // inferred from a total. Without `source` a slow run cannot be told apart
    // from a networked one, which is exactly what 2026-08-21 needed and lacked.
    const updates = spans.named("update")
    expect(updates).toHaveLength(1)
    expect(updates[0]?.props).toMatchObject({ path: "apps/maddoc", source: "local", outcome: "ok" })

    // Phase deltas, so "where did the time go" is answerable from one record.
    // No `enumerate` lap: the span opens after the .gitmodules read, so a lap
    // named for it would time the wrong thing and report ~0ms. These five sum to
    // the span's duration.
    const walk = spans.named("walk").find((event) => event.props?.["depth"] === 0)
    // `probe` is the batched local-read phase; `resolve` is now only the
    // serialized network phase, which does nothing at all on a healthy store.
    expect(Object.keys((walk?.props?.["laps"] ?? {}) as Record<string, unknown>)).toEqual([
      "probe",
      "resolve",
      "init",
      "prepare",
      "local",
      "remote",
    ])
    expect(walk?.props?.["gitlinks"]).toBe(1)

    // A LEAF EMITS NO WALK SPAN. apps/maddoc has no submodules of its own, so its
    // level has nothing to time and a span for it would be five zero laps. On a
    // real 17-gitlink run that was 17 of 18 spans — noise burying the one record
    // that carries the totals.
    expect(spans.named("walk").some((event) => event.props?.["depth"] === 1)).toBe(false)

    // Per-submodule attribution does not depend on those leaf spans; it comes
    // from the `update` span asserted above, which names path and source. That is
    // why dropping them costs no attribution.
    expect(updates[0]?.props?.["path"]).toBe("apps/maddoc")
  })

  it("refuses a partial-clone reference instead of trusting object presence", async () => {
    const referenceWorktree = await mkdtemp(join(tmpdir(), "git-super-promisor-"))
    roots.push(referenceWorktree)
    await mkdir(join(referenceWorktree, "apps/maddoc"), { recursive: true })
    const worktree = "/candidate"
    let fetched = 0

    const git: SubmoduleGit = {
      async run(repo, args) {
        if (args[0] === "cat-file" && args.at(-1) === "HEAD:.gitmodules") {
          return repo === worktree ? success() : { ...success(), code: 1 }
        }
        if (args[0] === "config" && args[1] === "--blob") {
          return { ...success(), stdout: "submodule.maddoc.path apps/maddoc" }
        }
        if (args[0] === "ls-tree") return { ...success(), stdout: `160000 commit ${"e".repeat(40)}\tapps/maddoc\n` }
        if (args[0] === "config" && args[1] === "--get-regexp") {
          return { ...success(), stdout: "remote.origin.promisor true\n" }
        }
        if (args[0] === "config" && args[1] === "--get") {
          return { ...success(), stdout: "https://example.invalid/maddoc.git\n" }
        }
        if (args[0] === "fetch") {
          fetched += 1
          return success()
        }
        if (args[0] === "cat-file" && args[1] === "-e") return { ...success(), code: 1 }
        return success()
      },
    }

    const refused = await materializeSubmodules(withPrimaryWorktree(git, referenceWorktree), {
      worktree,
      referenceWorktree,
    })

    // On a promisor remote `cat-file -e` passes while trees and blobs are still
    // fetched lazily, so presence stops meaning warmth and the counter goes
    // blind. Refuse rather than report a borrow we cannot honour.
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain("partial clone")
    expect(refused.stderr).toContain("remote.origin.promisor")
    expect(fetched).toBe(0)
  })

  it("initializes sibling paths in one config mutation before parallel updates", async () => {
    const worktree = "/worktree"
    const paths = ["vendor/one", "vendor/two", "vendor/three"]
    const commands: Array<Readonly<{ args: readonly string[]; mutation: boolean }>> = []
    const git: SubmoduleGit = {
      async run(repo, args) {
        commands.push({ args, mutation: false })
        if (args[0] === "cat-file" && args.at(-1) === "HEAD:.gitmodules") {
          return repo === worktree ? success() : { ...success(), code: 1 }
        }
        if (args[0] === "config" && args[1] === "--blob") {
          return {
            ...success(),
            stdout: paths.map((path, index) => `submodule.module-${index}.path ${path}`).join("\n"),
          }
        }
        if (args[0] === "ls-tree") {
          return { ...success(), stdout: `160000 commit ${"a".repeat(40)}\t${args.at(-1)}\n` }
        }
        if (args[0] === "config" && args[1] === "--get") {
          return { ...success(), stdout: "https://example.invalid/module.git\n" }
        }
        return success()
      },
      async mutateConfig(_repo, args) {
        commands.push({ args, mutation: true })
        return success()
      },
    }

    await expect(
      materializeSubmodules(
        withDurableStores(git, worktree, "/durable", {
          "vendor/one": "module-0",
          "vendor/two": "module-1",
          "vendor/three": "module-2",
        }),
        { worktree },
      ),
    ).resolves.toMatchObject({ code: 0 })
    expect(commands.filter(({ args }) => args[0] === "submodule" && args[1] === "init")).toEqual([
      { args: ["submodule", "init", "--", ...paths], mutation: true },
    ])
    expect(
      commands
        .filter(({ args }) => args.includes("update"))
        .map(({ args }) => args.at(-1))
        .toSorted(),
    ).toEqual(paths.toSorted())
  })

  it("runs remote-fallback updates ONE AT A TIME while local borrows stay parallel", async () => {
    // 2026-08-21: several seats materializing 16 submodules each, 20-wide,
    // with every update falling back to the remote, made GitHub refuse SSH
    // from the host outright (port 22 refused, 443 reset at key exchange) —
    // every fetch, push, submit and landing stopped for the whole fleet. A
    // borrow is a local clone and can fan out; a remote fallback is a network
    // connection and must not.
    const worktree = "/candidate"
    // referenceContains checks existsSync(<reference>/<path>) before asking
    // git, so the borrowable reference stores must exist on disk.
    const referenceWorktree = await mkdtemp(join(tmpdir(), "git-super-reference-"))
    roots.push(referenceWorktree)
    const borrowable = ["vendor/local-a", "vendor/local-b", "vendor/local-c"]
    const remote = ["vendor/remote-a", "vendor/remote-b", "vendor/remote-c"]
    const paths = [...borrowable, ...remote]
    for (const path of borrowable) await mkdir(join(referenceWorktree, path), { recursive: true })
    let inFlightLocal = 0
    let inFlightRemote = 0
    let peakLocal = 0
    let peakRemote = 0
    const storeProbes: string[] = []
    const git: SubmoduleGit = {
      async run(repo, args) {
        if (args[0] === "cat-file" && args.at(-1) === "HEAD:.gitmodules") {
          return repo === worktree ? success() : { ...success(), code: 1 }
        }
        if (args[0] === "cat-file" && args[1] === "-e") {
          storeProbes.push(repo)
          // The reference store holds the borrowable pins and lacks the rest.
          return borrowable.some((path) => repo === `${referenceWorktree}/${path}`)
            ? success()
            : { ...success(), code: 1 }
        }
        if (args[0] === "config" && args[1] === "--blob") {
          return {
            ...success(),
            stdout: paths.map((path, index) => `submodule.module-${index}.path ${path}`).join("\n"),
          }
        }
        if (args[0] === "ls-tree") {
          return { ...success(), stdout: `160000 commit ${"a".repeat(40)}\t${args.at(-1)}\n` }
        }
        if (args[0] === "config" && args[1] === "--get") {
          return { ...success(), stdout: "https://example.invalid/module.git\n" }
        }
        if (args.includes("update")) {
          const isBorrow = args.includes("--reference")
          if (isBorrow) {
            inFlightLocal += 1
            peakLocal = Math.max(peakLocal, inFlightLocal)
          } else {
            inFlightRemote += 1
            peakRemote = Math.max(peakRemote, inFlightRemote)
          }
          await new Promise((resolve) => setTimeout(resolve, 5))
          if (isBorrow) inFlightLocal -= 1
          else inFlightRemote -= 1
        }
        return success()
      },
    }

    // This test is about ORDERING — local wide, remote one at a time — so it
    // raises the limit to reach the code under test. The default would refuse
    // three unrepairable fallbacks before any of them ran.
    await expect(
      materializeSubmodules(
        withDurableStores(withPrimaryWorktree(git, referenceWorktree), worktree, "/durable", {
          "vendor/local-a": "module-0",
          "vendor/local-b": "module-1",
          "vendor/local-c": "module-2",
          "vendor/remote-a": "module-3",
          "vendor/remote-b": "module-4",
          "vendor/remote-c": "module-5",
        }),
        {
          worktree,
          referenceWorktree,
          maxRemoteFallbacks: 3,
        },
      ),
    ).resolves.toMatchObject({
      code: 0,
      borrowed: 3,
      remoteFallbacks: 3,
    })
    // Every borrowable store was probed at the path git reports; a probe at an
    // alias of it misses, and all six updates go to the network — the exact
    // fan-out this test forbids, reported as `borrowed: 0`.
    expect(storeProbes, "no borrowable reference store was ever probed").toEqual(
      expect.arrayContaining(borrowable.map((path) => `${referenceWorktree}/${path}`)),
    )
    expect(peakLocal).toBe(3)
    expect(peakRemote).toBe(1)
  })

  it("keeps the synchronous host adapter on the same materializer", async () => {
    const root = await mkdtemp(join(tmpdir(), "git-super-submodules-"))
    roots.push(root)
    await Bun.$`git init -q -b main ${root}`
    await Bun.$`git -C ${root} config user.name "Git Super Test"`
    await Bun.$`git -C ${root} config user.email git-super@example.invalid`
    writeFileSync(join(root, "README.md"), "root\n")
    await Bun.$`git -C ${root} add README.md`
    await Bun.$`git -C ${root} commit -qm root`

    expect(materializeSubmodulesFromLocalWorktree({ worktree: root })).toMatchObject({
      exitCode: 0,
      borrowed: 0,
      remoteFallbacks: 0,
    })
  })

  it("borrows from the primary submodule store when given a linked reference worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "git-super-primary-reference-"))
    roots.push(root)
    const dependency = join(root, "dependency")
    const owner = join(root, "owner")
    const linked = join(root, "linked")
    const candidate = join(root, "candidate")

    git(root, ["init", "-q", "-b", "main", dependency])
    git(dependency, ["config", "user.name", "Git Super Test"])
    git(dependency, ["config", "user.email", "git-super@example.invalid"])
    writeFileSync(join(dependency, "dependency.txt"), "dependency\n")
    git(dependency, ["add", "dependency.txt"])
    git(dependency, ["commit", "-qm", "dependency"])

    git(root, ["init", "-q", "-b", "main", owner])
    git(owner, ["config", "user.name", "Git Super Test"])
    git(owner, ["config", "user.email", "git-super@example.invalid"])
    git(owner, ["config", "protocol.file.allow", "always"])
    writeFileSync(join(owner, "README.md"), "owner\n")
    git(owner, ["add", "README.md"])
    git(owner, ["commit", "-qm", "owner"])
    git(owner, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", dependency, "vendor/dependency"])
    git(owner, ["commit", "-qam", "add dependency"])

    git(owner, ["worktree", "add", "-q", "--detach", linked, "HEAD"])
    git(linked, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"])
    git(owner, ["worktree", "add", "-q", "--detach", candidate, "HEAD"])

    const previousGitAllowProtocol = process.env.GIT_ALLOW_PROTOCOL
    process.env.GIT_ALLOW_PROTOCOL = "file"
    let materialized: Awaited<ReturnType<typeof materializeSubmodulesWithProcess>>
    try {
      materialized = await materializeSubmodulesWithProcess(createLocalGitProcess(), {
        worktree: candidate,
        referenceWorktree: linked,
      })
    } finally {
      if (previousGitAllowProtocol === undefined) delete process.env.GIT_ALLOW_PROTOCOL
      else process.env.GIT_ALLOW_PROTOCOL = previousGitAllowProtocol
    }
    expect(materialized, materialized.stderr).toMatchObject({ code: 0, borrowed: 1, remoteFallbacks: 0 })

    const candidateDependency = join(candidate, "vendor/dependency")
    const alternatesFile = git(candidateDependency, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "objects/info/alternates",
    ]).trim()
    const primaryGitDir = git(join(owner, "vendor/dependency"), [
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
    ]).trim()
    expect(readFileSync(alternatesFile, "utf8").trim()).toBe(join(primaryGitDir, "objects"))

    git(owner, ["worktree", "remove", "--force", linked])
    expect(git(candidateDependency, ["cat-file", "-e", "HEAD^{commit}"])).toBe("")
  })

  it("refuses an explicit reference whose primary worktree cannot be proven", async () => {
    const result = await materializeSubmodules(
      {
        async run(_repo, args) {
          return args[0] === "worktree" ? { code: 128, stdout: "", stderr: "fatal: not a git repository" } : success()
        },
      },
      { worktree: "/candidate", referenceWorktree: "/linked-reference" },
    )

    expect(result).toMatchObject({ code: 128, considered: 0, borrowed: 0, remoteFallbacks: 0 })
    expect(result.stderr).toContain("cannot prove the primary worktree")
    expect(result.stderr).toContain("potentially disposable linked worktree")
  })

  it("re-anchors a warm store whose alternates only name a disposable linked worktree", async () => {
    // THE 2026-08-25 DEFECT SHAPE: a candidate's submodule store whose ONLY
    // alternates line points into another linked worktree's module store
    // (`<common>/worktrees/<wt>/modules/<path>/objects`). Recycling that
    // worktree deleted the store and killed every object read — 62 stores on
    // the measured estate. A warm `submodule update` never rewrites alternates,
    // so redirecting NEW borrows to the primary cannot heal an existing store;
    // only the anchor pass can, and this test is the proof it does.
    const root = await mkdtemp(join(tmpdir(), "git-super-reanchor-"))
    roots.push(root)
    const dependency = join(root, "dependency")
    const owner = join(root, "owner")
    const linked = join(root, "linked")
    const candidate = join(root, "candidate")

    git(root, ["init", "-q", "-b", "main", dependency])
    git(dependency, ["config", "user.name", "Git Super Test"])
    git(dependency, ["config", "user.email", "git-super@example.invalid"])
    writeFileSync(join(dependency, "dependency.txt"), "dependency\n")
    git(dependency, ["add", "dependency.txt"])
    git(dependency, ["commit", "-qm", "dependency"])

    git(root, ["init", "-q", "-b", "main", owner])
    git(owner, ["config", "user.name", "Git Super Test"])
    git(owner, ["config", "user.email", "git-super@example.invalid"])
    git(owner, ["config", "protocol.file.allow", "always"])
    writeFileSync(join(owner, "README.md"), "owner\n")
    git(owner, ["add", "README.md"])
    git(owner, ["commit", "-qm", "owner"])
    git(owner, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", dependency, "vendor/dependency"])
    git(owner, ["commit", "-qam", "add dependency"])

    git(owner, ["worktree", "add", "-q", "--detach", linked, "HEAD"])
    git(linked, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"])
    git(owner, ["worktree", "add", "-q", "--detach", candidate, "HEAD"])

    const previousGitAllowProtocol = process.env.GIT_ALLOW_PROTOCOL
    process.env.GIT_ALLOW_PROTOCOL = "file"
    try {
      const materialized = await materializeSubmodulesWithProcess(createLocalGitProcess(), {
        worktree: candidate,
        referenceWorktree: linked,
      })
      expect(materialized, materialized.stderr).toMatchObject({ code: 0 })

      const candidateDependency = join(candidate, "vendor/dependency")
      const alternatesFile = git(candidateDependency, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "objects/info/alternates",
      ]).trim()
      const linkedStoreObjects = git(join(linked, "vendor/dependency"), [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "objects",
      ]).trim()
      const primaryStoreObjects = git(join(owner, "vendor/dependency"), [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "objects",
      ]).trim()

      // Fabricate the legacy emission: the linked worktree's store as the ONLY
      // line. This is byte-for-byte what the pre-anchor materializer wrote when
      // its reference was a linked worktree.
      writeFileSync(alternatesFile, `${linkedStoreObjects}\n`)

      const rematerialized = await materializeSubmodulesWithProcess(createLocalGitProcess(), {
        worktree: candidate,
        referenceWorktree: linked,
      })
      expect(rematerialized, rematerialized.stderr).toMatchObject({ code: 0 })

      const lines = readFileSync(alternatesFile, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
      // The borrow stays as the optional, additive FIRST line — it is a
      // performance borrow, never the store of record.
      expect(lines[0]).toBe(linkedStoreObjects)
      // The durable module store line is MANDATORY in every emission.
      expect(lines).toContain(primaryStoreObjects)

      // The store must survive the borrow target's deletion — the exact way
      // the 62 died.
      git(owner, ["worktree", "remove", "--force", linked])
      expect(git(candidateDependency, ["cat-file", "-e", "HEAD^{commit}"])).toBe("")
    } finally {
      if (previousGitAllowProtocol === undefined) delete process.env.GIT_ALLOW_PROTOCOL
      else process.env.GIT_ALLOW_PROTOCOL = previousGitAllowProtocol
    }
  })

  it("anchors nested submodule stores under the durable modules chain", async () => {
    // Depth is where a wrong durable path would hide: the nested store's home
    // is `<common>/modules/<parent>/modules/<child>`, keyed by NAME at every
    // level. Every emitted line must also EXIST — a fabricated chain that
    // appends a plausible-but-wrong path fails here, not in production.
    const root = await mkdtemp(join(tmpdir(), "git-super-nested-anchor-"))
    roots.push(root)
    const inner = join(root, "inner")
    const dependency = join(root, "dependency")
    const owner = join(root, "owner")
    const candidate = join(root, "candidate")

    git(root, ["init", "-q", "-b", "main", inner])
    git(inner, ["config", "user.name", "Git Super Test"])
    git(inner, ["config", "user.email", "git-super@example.invalid"])
    writeFileSync(join(inner, "inner.txt"), "inner\n")
    git(inner, ["add", "inner.txt"])
    git(inner, ["commit", "-qm", "inner"])

    git(root, ["init", "-q", "-b", "main", dependency])
    git(dependency, ["config", "user.name", "Git Super Test"])
    git(dependency, ["config", "user.email", "git-super@example.invalid"])
    writeFileSync(join(dependency, "dependency.txt"), "dependency\n")
    git(dependency, ["add", "dependency.txt"])
    git(dependency, ["commit", "-qm", "dependency"])
    git(dependency, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "nested/inner"])
    git(dependency, ["commit", "-qam", "add inner"])

    git(root, ["init", "-q", "-b", "main", owner])
    git(owner, ["config", "user.name", "Git Super Test"])
    git(owner, ["config", "user.email", "git-super@example.invalid"])
    git(owner, ["config", "protocol.file.allow", "always"])
    writeFileSync(join(owner, "README.md"), "owner\n")
    git(owner, ["add", "README.md"])
    git(owner, ["commit", "-qm", "owner"])
    git(owner, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", dependency, "vendor/dependency"])
    git(owner, ["commit", "-qam", "add dependency"])
    git(owner, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"])

    git(owner, ["worktree", "add", "-q", "--detach", candidate, "HEAD"])

    const previousGitAllowProtocol = process.env.GIT_ALLOW_PROTOCOL
    process.env.GIT_ALLOW_PROTOCOL = "file"
    try {
      const materialized = await materializeSubmodulesWithProcess(createLocalGitProcess(), {
        worktree: candidate,
        referenceWorktree: owner,
      })
      expect(materialized, materialized.stderr).toMatchObject({ code: 0, considered: 2 })
    } finally {
      if (previousGitAllowProtocol === undefined) delete process.env.GIT_ALLOW_PROTOCOL
      else process.env.GIT_ALLOW_PROTOCOL = previousGitAllowProtocol
    }

    const nestedCheckout = join(candidate, "vendor/dependency", "nested/inner")
    const alternatesFile = git(nestedCheckout, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "objects/info/alternates",
    ]).trim()
    const durableNested = git(join(owner, "vendor/dependency", "nested/inner"), [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "objects",
    ]).trim()
    const lines = readFileSync(alternatesFile, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
    expect(lines).toContain(durableNested)
    for (const line of lines) expect(existsSync(line), `alternates line does not exist: ${line}`).toBe(true)
  })

  it("fails loud when the durable modules root cannot be resolved", async () => {
    // A store the anchor cannot prove durable must refuse, never materialize
    // silently un-anchored — an un-anchored store is the 62-store outage class.
    const worktree = "/candidate"
    const git: SubmoduleGit = {
      async run(repo, args) {
        if (args[0] === "rev-parse" && args.includes("--git-common-dir")) {
          return { code: 128, stdout: "", stderr: "fatal: this operation must be run in a work tree" }
        }
        if (args[0] === "cat-file" && args.at(-1) === "HEAD:.gitmodules") {
          return repo === worktree ? success() : { ...success(), code: 1 }
        }
        if (args[0] === "config" && args[1] === "--blob") {
          return { ...success(), stdout: "submodule.maddoc.path apps/maddoc" }
        }
        if (args[0] === "ls-tree") return { ...success(), stdout: `160000 commit ${"f".repeat(40)}\tapps/maddoc\n` }
        if (args[0] === "config" && args[1] === "--get") {
          return { ...success(), stdout: "https://example.invalid/maddoc.git\n" }
        }
        return success()
      },
    }

    const result = await materializeSubmodules(git, { worktree })

    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("durable")
  })
})
