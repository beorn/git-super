/**
 * @failure Worktree consumers can fall back to divergent submodule materializers or serialize sibling clones.
 * @level l1
 * @consumer Yrd, Bearly, and hh worktree adapters
 */
import { writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

    await expect(
      materializeSubmodules(git, { worktree, referenceWorktree, log: (message) => messages.push(message) }),
    ).resolves.toMatchObject({ code: 0, borrowed: 0, remoteFallbacks: 1 })
    expect(messages).toEqual([expect.stringContaining("using the configured remote fallback")])
    expect(commands.some(({ repo }) => repo === `${referenceWorktree}/apps/maddoc`)).toBe(false)
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
