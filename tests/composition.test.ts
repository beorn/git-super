/**
 * @failure Generic gitlink composition mechanics live inside Yrd and return
 * queue-authored refs/messages instead of workflow-neutral Git evidence.
 * @level l0
 * @consumer reusable superproject composition callers
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  composeSubmoduleCommits,
  planSubmoduleComposition,
  type SubmoduleCompositionGitRequest,
  type SubmoduleTreeConflict,
} from "../src/composition.ts"

const oid = (digit: string) => digit.repeat(40)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function gitlinkConflict(
  path: string,
  baseSha: string,
  currentSha: string,
  incomingSha: string,
  origin = `https://example.test/${path}.git`,
): SubmoduleTreeConflict {
  return {
    path,
    origin,
    stages: [
      { stage: 1, mode: "160000", oid: baseSha },
      { stage: 2, mode: "160000", oid: currentSha },
      { stage: 3, mode: "160000", oid: incomingSha },
    ],
  }
}

describe("workflow-neutral submodule composition planning", () => {
  it("returns deterministic Git facts without queue refs or authored messages", () => {
    const conflicts = [
      gitlinkConflict("vendor/zeta", oid("1"), oid("2"), oid("3")),
      gitlinkConflict("vendor/alpha", oid("4"), oid("5"), oid("6")),
    ]

    const planned = planSubmoduleComposition(conflicts)

    expect(planned).toEqual({
      status: "planned",
      resolutions: [
        {
          kind: "compose",
          path: "vendor/alpha",
          origin: "https://example.test/vendor/alpha.git",
          baseSha: oid("4"),
          currentSha: oid("5"),
          incomingSha: oid("6"),
        },
        {
          kind: "compose",
          path: "vendor/zeta",
          origin: "https://example.test/vendor/zeta.git",
          baseSha: oid("1"),
          currentSha: oid("2"),
          incomingSha: oid("3"),
        },
      ],
    })
    expect(planSubmoduleComposition(conflicts.toReversed())).toEqual(planned)
    expect(JSON.stringify(planned)).not.toMatch(/yrd|refs\//iu)
  })

  it("returns structured invalid paths without authoring a queue remedy", () => {
    const planned = planSubmoduleComposition([
      {
        path: "README.md",
        stages: [
          { stage: 1, mode: "100644", oid: oid("1") },
          { stage: 2, mode: "100644", oid: oid("2") },
          { stage: 3, mode: "100644", oid: oid("3") },
        ],
      },
      {
        path: "vendor/no-origin",
        stages: gitlinkConflict("vendor/no-origin", oid("4"), oid("5"), oid("6")).stages,
      },
    ])

    expect(planned).toEqual({
      status: "refused",
      conflicts: [
        { kind: "content", path: "README.md" },
        { kind: "invalid-gitlink", path: "vendor/no-origin" },
      ],
    })
  })
})

async function runGit(
  repo: string,
  args: readonly string[],
  allowFailure = false,
): Promise<Readonly<{ code: number; stdout: string; stderr: string }>> {
  const child = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (!allowFailure && code !== 0) throw new Error(stderr || stdout)
  return { code, stdout: stdout.trim(), stderr: stderr.trim() }
}

async function divergentRepository(): Promise<
  Readonly<{
    root: string
    store: string
    origin: string
    baseSha: string
    currentSha: string
    incomingSha: string
  }>
> {
  const root = await mkdtemp(join(tmpdir(), "git-super-composition-"))
  roots.push(root)
  const store = join(root, "store")
  const origin = join(root, "origin.git")
  await Bun.$`git init -q -b main ${store}`
  await runGit(store, ["config", "user.name", "Git Super Test"])
  await runGit(store, ["config", "user.email", "git-super@example.test"])
  await writeFile(join(store, "notes.md"), "top\nmiddle\nbottom\n")
  await runGit(store, ["add", "notes.md"])
  await runGit(store, ["commit", "-qm", "base"])
  const baseSha = (await runGit(store, ["rev-parse", "HEAD"])).stdout
  await runGit(store, ["switch", "-qc", "current"])
  await writeFile(join(store, "notes.md"), "top-current\nmiddle\nbottom\n")
  await runGit(store, ["commit", "-qam", "current"])
  const currentSha = (await runGit(store, ["rev-parse", "HEAD"])).stdout
  await runGit(store, ["switch", "-qc", "incoming", baseSha])
  await writeFile(join(store, "notes.md"), "top\nmiddle\nbottom-incoming\n")
  await runGit(store, ["commit", "-qam", "incoming"])
  const incomingSha = (await runGit(store, ["rev-parse", "HEAD"])).stdout
  await Bun.$`git init -q --bare ${origin}`
  await runGit(store, ["remote", "add", "origin", origin])
  await runGit(store, ["push", "-q", "origin", "main", "current", "incoming"])
  return { root, store, origin, baseSha, currentSha, incomingSha }
}

describe("workflow-neutral submodule composition construction", () => {
  it("constructs deterministic commits and returns caller-selected review evidence without publishing refs", async () => {
    const repo = await divergentRepository()
    const plan = planSubmoduleComposition([
      gitlinkConflict("vendor/dependency", repo.baseSha, repo.currentSha, repo.incomingSha, repo.origin),
    ])
    if (plan.status !== "planned") throw new Error("expected a composition plan")
    const requests: SubmoduleCompositionGitRequest[] = []
    const git = {
      async run(request: SubmoduleCompositionGitRequest) {
        requests.push(request)
        const child = Bun.spawn(["git", "-C", request.repo, ...request.args], {
          env: request.env,
          stdin: request.stdin === undefined ? "ignore" : new Blob([request.stdin]),
          stdout: "pipe",
          stderr: "pipe",
        })
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        return { code, stdout, stderr }
      },
    }
    const options = {
      inject: { git, storeForOrigin: () => repo.store },
      commit: {
        author: { name: "Queue Actor", email: "queue@example.test" },
        message: () => "compose dependency",
      },
      reviewPath: (path: string) => path.endsWith(".md"),
    } as const

    const first = await composeSubmoduleCommits(plan, options)
    const second = await composeSubmoduleCommits(plan, options)

    expect(first).toEqual(second)
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every((request) => request.timeoutMs === 30_000)).toBe(true)
    expect(first).toMatchObject({
      status: "composed",
      resolutions: [
        {
          kind: "compose",
          path: "vendor/dependency",
          sha: expect.stringMatching(/^[0-9a-f]{40}$/u),
          reviewedBlobs: [
            {
              path: "notes.md",
              oid: expect.stringMatching(/^[0-9a-f]{40}$/u),
              content: "top-current\nmiddle\nbottom-incoming\n",
            },
          ],
        },
      ],
    })
    if (first.status !== "composed" || first.resolutions[0]?.kind !== "compose") {
      throw new Error("expected a composed resolution")
    }
    const composed = first.resolutions[0]
    expect((await runGit(repo.store, ["show", "-s", "--format=%P", composed.sha])).stdout).toBe(
      `${repo.currentSha} ${repo.incomingSha}`,
    )
    expect((await runGit(repo.store, ["show", "-s", "--format=%an <%ae>", composed.sha])).stdout).toBe(
      "Queue Actor <queue@example.test>",
    )
    expect((await runGit(repo.store, ["show", "-s", "--format=%B", composed.sha])).stdout).toBe("compose dependency")
    expect(
      (
        await runGit(
          repo.origin,
          ["for-each-ref", "--format=%(refname)", "refs/yrd/compositions", "refs/git-super/compositions"],
          true,
        )
      ).stdout,
    ).toBe("")
  })
})
