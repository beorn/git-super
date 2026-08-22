/**
 * @failure Worktree consumers can fall back to divergent submodule materializers or serialize sibling clones.
 * @level l1
 * @consumer Yrd, Bearly, and hh worktree adapters
 */
import { writeFileSync } from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLogger, type ConditionalLogger, type Event } from "loggily"
import { afterEach, describe, expect, it } from "vitest"
import {
  materializeSubmodules,
  materializeSubmodulesWithProcess,
  materializeSubmodulesFromLocalWorktree,
  type SubmoduleGit,
  type SubmoduleGitResult,
} from "../src/submodules.ts"
import type { GitProcessRequest } from "../src/process.ts"
import { cleanGitRepositoryEnvironment } from "../src/git.ts"

const success = (): SubmoduleGitResult => ({ code: 0, stdout: "", stderr: "" })
const roots: string[] = []

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
    const referenceWorktree = "/reference"
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
    const refused = await materializeSubmodules(git, {
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
    const result = await materializeSubmodules(git, { worktree, log: capturingLogger(messages) })

    expect(result).toMatchObject({ code: 0, considered: 1, borrowed: 0, remoteFallbacks: 0, unreferenced: 1 })
    expect(result.borrowed + result.remoteFallbacks + result.unreferenced).toBe(result.considered)
    expect(messages).toEqual([expect.stringContaining("no reference store supplied; materializing from the network")])
    // The remedy is named, or the warning is just an observation.
    expect(messages[0]).toContain("referenceWorktree")
  })

  it("never renders an unreachable '(none supplied)' — the refusal only fires WITH a reference", async () => {
    const worktree = "/candidate"
    const referenceWorktree = "/reference"
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

    const refused = await materializeSubmodules(git, { worktree, referenceWorktree })

    // Every miss is pushed inside `referenceSubmodule !== undefined`, so the
    // refusal always has a real path to print. Asserted so nobody reintroduces
    // a fallback string that can never render and then reports it as coverage.
    expect(refused.code).toBe(1)
    expect(refused.stderr).not.toContain("(none supplied)")
    expect(refused.stderr).toContain(`${referenceWorktree}/apps/maddoc`)
  })

  it("names the missing pin, the reference consulted, and the command that repairs it", async () => {
    const worktree = "/candidate"
    const referenceWorktree = "/reference"
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

    const refused = await materializeSubmodules(git, { worktree, referenceWorktree })

    // A bare count is what made this invisible for a night; the refusal has to
    // carry enough to act on without re-deriving anything.
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain("apps/maddoc")
    expect(refused.stderr).toContain(`${referenceWorktree}/apps/maddoc`)
    expect(refused.stderr).toContain(`fetch --no-tags origin ${"b".repeat(40)}`)
    expect(refused.stderr).toContain("2026-08-21")
  })

  it("permits fallback only when the caller raises the limit deliberately", async () => {
    const worktree = "/candidate"
    const referenceWorktree = "/reference"
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
      materializeSubmodules(git, {
        worktree,
        referenceWorktree,
        maxRemoteFallbacks: 1,
        log: capturingLogger(messages),
      }),
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
      materializeSubmodules(git, { worktree, referenceWorktree, log: capturingLogger(messages) }),
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
    const materialized = await materializeSubmodules(git, { worktree, referenceWorktree, log: spans.log })
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
    const walk = spans.named("walk").find((event) => event.props?.["depth"] === 0)
    expect(Object.keys((walk?.props?.["laps"] ?? {}) as Record<string, unknown>)).toEqual([
      "enumerate",
      "resolve",
      "init",
      "prepare",
      "local",
      "remote",
    ])

    // The recursion is instrumented too: a nested submodule gets its own walk
    // at depth 1, so a slow leaf is attributable instead of billed to its root.
    expect(spans.named("walk").some((event) => event.props?.["depth"] === 1)).toBe(true)
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

    const refused = await materializeSubmodules(git, { worktree, referenceWorktree })

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

    await expect(materializeSubmodules(git, { worktree })).resolves.toMatchObject({ code: 0 })
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
    const git: SubmoduleGit = {
      async run(repo, args) {
        if (args[0] === "cat-file" && args.at(-1) === "HEAD:.gitmodules") {
          return repo === worktree ? success() : { ...success(), code: 1 }
        }
        if (args[0] === "cat-file" && args[1] === "-e") {
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
      materializeSubmodules(git, { worktree, referenceWorktree, maxRemoteFallbacks: 3 }),
    ).resolves.toMatchObject({
      code: 0,
      borrowed: 3,
      remoteFallbacks: 3,
    })
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
})
