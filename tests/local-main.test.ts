/**
 * @failure A caller that leaves a gitlink out of a tree because nobody moved it cannot tell whether a merge would
 *          still raise it to a component main that ran ahead (29560). It either copies the merge's main resolution,
 *          a second implementation, or leaves out a gitlink whose raise then never shows in the submit preview.
 * @level   l2 (real repositories and submodules; the query's own Git calls recorded)
 * @consumer yrd submit's candidate (composeSubmit leaves out only the paths this query confirms), @cto 0a2690f0
 * @testonly none
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { localMainsAtPin } from "../src/local-main.ts"
import { createLocalGitProcess, type GitProcess } from "../src/process.ts"
import { canonicalTmpdir, git } from "./fixture.ts"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

const HOSTED = "https://github.com/beorn/git-super-local-main-fixture.git"

/** A product with one component, declared by a hosted name that a URL rewrite maps to the local repository. */
function world(): Readonly<{ product: string; component: string; pin: string; rewrite: readonly string[] }> {
  const root = mkdtempSync(join(canonicalTmpdir(), "git-super-local-main-"))
  roots.push(root)
  const component = join(root, "component")
  const product = join(root, "product")
  for (const repo of [component, product]) {
    mkdirSync(repo)
    git(repo, "init", "--quiet", "--initial-branch=main")
    writeFileSync(join(repo, "README.md"), `${repo}\n`)
    git(repo, "add", "README.md")
    git(repo, "commit", "--quiet", "-m", "seed")
  }
  const rewrite = ["-c", `url.${component}.insteadOf=${HOSTED}`, "-c", "protocol.file.allow=always"] as const
  git(product, ...rewrite, "submodule", "add", "--quiet", "-b", "main", HOSTED, "vendor/c")
  git(product, "commit", "--quiet", "-m", "add vendor/c")
  return { product, component, pin: git(component, "rev-parse", "HEAD"), rewrite }
}

/** The query's Git, recording every command it runs. */
function recording(): Readonly<{ process: GitProcess; commands: string[][] }> {
  const local = createLocalGitProcess()
  const commands: string[][] = []
  return {
    commands,
    process: {
      run: (request) => {
        commands.push([...request.args])
        return local.run(request)
      },
    },
  }
}

describe("localMainsAtPin answers from the local stores the way a merge without fetching reads them (29560)", () => {
  it("confirms a gitlink whose local main is its pin, and never fetches", async () => {
    const w = world()
    const { process, commands } = recording()
    const commit = git(w.product, "rev-parse", "HEAD")
    const answers = await localMainsAtPin({ repository: w.product, commit, paths: ["vendor/c"], process })
    expect(answers).toEqual([{ path: "vendor/c", atPin: true, reason: expect.stringContaining("is the pin") }])
    expect(commands.filter((args) => args.includes("fetch") || args.includes("ls-remote"))).toEqual([])
  })

  it("leaves in a gitlink whose component main ran ahead, naming both commits", async () => {
    const w = world()
    writeFileSync(join(w.component, "ahead.txt"), "ahead\n")
    git(w.component, "add", "ahead.txt")
    git(w.component, "commit", "--quiet", "-m", "main ran ahead")
    const ahead = git(w.component, "rev-parse", "HEAD")
    git(join(w.product, "vendor/c"), ...w.rewrite, "fetch", "--quiet", "origin")
    const commit = git(w.product, "rev-parse", "HEAD")
    const answers = await localMainsAtPin({ repository: w.product, commit, paths: ["vendor/c"] })
    expect(answers).toEqual([
      { path: "vendor/c", atPin: false, reason: expect.stringContaining(`is ${ahead}, not the pin ${w.pin}`) },
    ])
  })

  it("answers every other case with its reason, never as confirmed", async () => {
    const w = world()
    const commit = git(w.product, "rev-parse", "HEAD")
    const store = join(w.product, "vendor/c")
    // A path that is not a root gitlink.
    expect(await localMainsAtPin({ repository: w.product, commit, paths: ["vendor/none"] })).toEqual([
      { path: "vendor/none", atPin: false, reason: `not a root gitlink at ${commit}` },
    ])
    // A store whose origin is another repository.
    git(store, "remote", "set-url", "origin", "https://github.com/beorn/another-repository.git")
    const foreign = await localMainsAtPin({ repository: w.product, commit, paths: ["vendor/c"] })
    expect(foreign[0]).toMatchObject({ path: "vendor/c", atPin: false })
    expect(foreign[0]?.reason).toContain("is not the declared")
    git(store, "remote", "set-url", "origin", HOSTED)
    // A store with no main to read.
    git(store, "update-ref", "-d", "refs/remotes/origin/main")
    const unreadable = await localMainsAtPin({ repository: w.product, commit, paths: ["vendor/c"] })
    expect(unreadable[0]).toMatchObject({ path: "vendor/c", atPin: false })
    expect(unreadable[0]?.reason).toContain("is unreadable")
    // A component that declares no branch: only the remote could name its default, and the query never asks.
    git(w.product, "config", "-f", ".gitmodules", "--unset", "submodule.vendor/c.branch")
    git(w.product, "commit", "--quiet", "-am", "undeclare the branch")
    const undeclared = recording()
    const branchless = await localMainsAtPin({
      repository: w.product,
      commit: git(w.product, "rev-parse", "HEAD"),
      paths: ["vendor/c"],
      process: undeclared.process,
    })
    expect(branchless[0]).toMatchObject({ path: "vendor/c", atPin: false })
    expect(branchless[0]?.reason).toContain("declares no branch")
    expect(undeclared.commands.filter((args) => args.includes("ls-remote") || args.includes("fetch"))).toEqual([])
    // No paths, no Git.
    const { process, commands } = recording()
    expect(await localMainsAtPin({ repository: w.product, commit, paths: [], process })).toEqual([])
    expect(commands).toEqual([])
  })
})
