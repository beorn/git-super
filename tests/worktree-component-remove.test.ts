/**
 * @failure git-super worktree remove --repo <super> refuses a clean component worktree as not registered in the super (28393).
 * @level l1
 * @consumer WIP sweep retiring landed vendor component worktrees; yrd env close delegates to this verb
 * @testonly none
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { tryAcquireFlock } from "@bearly/flock"
import { createGitWorktreeStore } from "../src/worktree.ts"
import { createLocalGitProcess } from "../src/process.ts"
import { gitLineStream, MAX_LINE_LENGTH, type GitStreamOutcome } from "../src/retention-stream.ts"
import { superWorktreeRemove } from "../src/worktree-remove.ts"
import { addNestedAlphaSubmodule, canonicalTmpdir, createProductFixture, createRepository, git } from "./fixture.ts"

describe("git-super worktree remove of a vendor component worktree (28393)", () => {
  /**
   * @failure Root removal leaves linked child registrations behind or hides partial cleanup failures (29340).
   * @level l1 @consumer every Git Super root remover, including Yrd native environment close
   * The Yrd journey proves ref/copy custody; this table owns nested native registration and failure sequencing.
   */
  it.each(["released", "held", "rebound", "failed", "post-remove-failed"] as const)(
    "cleans only destroyed nested registrations after root removal: %s",
    async (mode) => {
      const root = await mkdtemp(join(canonicalTmpdir(), "git-super-nested-release-"))
      let lease: ReturnType<typeof tryAcquireFlock> | undefined
      try {
        const fixture = addNestedAlphaSubmodule(createProductFixture(root))
        const target = join(root, "target")
        git(fixture.product, "worktree", "add", "--detach", target)
        const alpha = join(target, "packages/alpha")
        const leaf = join(alpha, "apps/maddoc")
        git(fixture.alpha, "worktree", "add", "-b", "task/child", alpha, "HEAD")
        git(fixture.leaf, "worktree", "add", "-b", "task/leaf", leaf, "HEAD")
        const leafAdmin = git(leaf, "rev-parse", "--absolute-git-dir")
        const leafTip = git(leaf, "rev-parse", "HEAD")
        const pointer = await Bun.file(join(leaf, ".git")).text()
        if (mode === "held") {
          const directory = join(leafAdmin, "yrd-worktree-mutations")
          await mkdir(directory, { recursive: true })
          lease = tryAcquireFlock(join(directory, "writer.lock"), { body: "native child holder" })
          expect(lease).not.toBeNull()
        }
        const local = createLocalGitProcess()
        let rootRemoved = false
        let rebound = false
        const store = createGitWorktreeStore({
          repo: fixture.product,
          gitProcess: {
            async run(request) {
              const removing = request.args.includes("worktree") && request.args.includes("remove")
              if (mode === "failed" && removing && request.args.includes(leaf)) {
                return { code: 1, stdout: "", stderr: "fixture child cleanup failure" }
              }
              const result = await local.run(request)
              if (mode === "post-remove-failed" && removing && request.args.includes(leaf) && result.code === 0) {
                throw new Error("fixture failed after child removal")
              }
              if (removing && request.args.includes(target) && result.code === 0) rootRemoved = true
              if (mode === "rebound" && rootRemoved && !rebound && request.args.includes("list")) {
                rebound = true
                await mkdir(leaf, { recursive: true })
                await writeFile(join(leaf, ".git"), pointer)
                await writeFile(join(leaf, "rebound.txt"), "new checkout owner\n")
              }
              return result
            },
          },
        })
        const outcome = await store.remove(target).then(
          () => ({ ok: true, error: "" }),
          (cause: unknown) => ({ ok: false, error: String(cause) }),
        )
        expect(existsSync(join(target, ".git"))).toBe(false)
        expect((await store.inspect(target)).registered).toBe(false)
        const leafRegistered = git(fixture.leaf, "worktree", "list", "--porcelain").includes(`worktree ${leaf}\n`)
        if (mode === "released") {
          expect(outcome).toEqual({ ok: true, error: "" })
          expect(leafRegistered).toBe(false)
          expect(git(fixture.alpha, "worktree", "list", "--porcelain")).not.toContain(`worktree ${alpha}\n`)
        } else {
          expect(outcome.ok).toBe(false)
          expect(outcome.error).toContain("root removed; child")
          expect(outcome.error).toContain(leaf)
          expect(outcome.error).toContain("recoverDestroyed")
          expect(leafRegistered).toBe(mode !== "post-remove-failed")
          if (mode === "post-remove-failed") expect(outcome.error).toContain("registration removed; cleanup incomplete")
          if (mode === "held") expect(outcome.error).toContain("native child holder")
          if (mode === "failed") expect(outcome.error).toContain("fixture child cleanup failure")
          if (mode === "rebound") expect(await Bun.file(join(leaf, "rebound.txt")).text()).toBe("new checkout owner\n")
        }
        expect(git(fixture.leaf, "rev-parse", "refs/heads/task/leaf")).toBe(leafTip)
      } finally {
        lease?.release()
        // raw-delete-allow: this row's isolated mkdtemp fixture, never an authored checkout
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it("retires a destroyed child registered in an independent bare store", async () => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-bare-child-release-"))
    try {
      const product = join(root, "product")
      const childSeed = join(root, "child-seed")
      const childPrimary = join(root, "child.git")
      const target = join(root, "target")
      const child = join(target, "vendor/child")
      createRepository(product, "root.txt", "root\n")
      createRepository(childSeed, "child.txt", "child\n")
      git(root, "clone", "--bare", "-q", childSeed, childPrimary)
      git(product, "-c", "protocol.file.allow=always", "submodule", "add", "-q", childPrimary, "vendor/child")
      git(product, "commit", "-q", "-m", "declare child")
      const tip = git(childPrimary, "rev-parse", "HEAD")
      git(product, "worktree", "add", "--detach", target)
      git(childPrimary, "worktree", "add", "-b", "topic/child", child, tip)

      await createGitWorktreeStore({ repo: product, gitProcess: createLocalGitProcess() }).remove(target)

      expect(existsSync(target)).toBe(false)
      expect(git(childPrimary, "worktree", "list", "--porcelain")).not.toContain(`worktree ${child}\n`)
      expect(git(childPrimary, "rev-parse", "refs/heads/topic/child")).toBe(tip)
    } finally {
      // raw-delete-allow: this isolated mkdtemp fixture owns every path beneath root
      await rm(root, { recursive: true, force: true })
    }
  })

  it("retires a clean linked worktree registered only in the submodule gitdir", async () => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-component-remove-"))
    try {
      const fixture = createProductFixture(root)
      const alpha = join(fixture.product, "packages/alpha")
      const componentWt = join(root, "alpha-wt")
      git(alpha, "worktree", "add", "--detach", componentWt)
      expect(git(alpha, "worktree", "list", "--porcelain")).toContain(componentWt)
      expect(git(fixture.product, "worktree", "list", "--porcelain")).not.toContain(componentWt)

      const result = await superWorktreeRemove({
        repo: fixture.product,
        path: componentWt,
        retain: join(root, "retained"),
      })

      expect(result.state, result.detail?.message ?? JSON.stringify(result)).toBe("updated")
      expect(existsSync(componentWt)).toBe(false)
      expect(git(alpha, "worktree", "list", "--porcelain")).not.toContain(componentWt)
    } finally {
      // raw-delete-allow: the fixture tree this test made under its own mkdtemp root
      await rm(root, { recursive: true, force: true })
    }
  })

  it("refuses a dirty component worktree and keeps it", async () => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-component-soiled-"))
    try {
      const fixture = createProductFixture(root)
      const alpha = join(fixture.product, "packages/alpha")
      const componentWt = join(root, "alpha-wt")
      git(alpha, "worktree", "add", "--detach", componentWt)
      await writeFile(join(componentWt, "keep.txt"), "keep this change\n")

      const result = await superWorktreeRemove({
        repo: fixture.product,
        path: componentWt,
        retain: join(root, "retained"),
      })

      expect(result.state).toBe("failed")
      expect(result.detail?.message ?? "").toContain("keep.txt")
      expect(existsSync(componentWt)).toBe(true)
      expect(git(alpha, "worktree", "list", "--porcelain")).toContain(componentWt)
    } finally {
      // raw-delete-allow: the fixture tree this test made under its own mkdtemp root
      await rm(root, { recursive: true, force: true })
    }
  })

  it("refuses a path whose gitdir sits outside the super's modules store", async () => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-component-foreign-"))
    try {
      const fixture = createProductFixture(root)
      const other = join(root, "other")
      createRepository(other, "other.ts", "export const other = 1\n")
      const outsider = join(root, "other-wt")
      git(other, "worktree", "add", "--detach", outsider)

      const result = await superWorktreeRemove({
        repo: fixture.product,
        path: outsider,
        retain: join(root, "retained"),
      })

      expect(result.state).toBe("failed")
      expect(result.detail?.message ?? "").toMatch(/gitdir .* outside /iu)
      expect(existsSync(outsider)).toBe(true)
    } finally {
      // raw-delete-allow: the fixture tree this test made under its own mkdtemp root
      await rm(root, { recursive: true, force: true })
    }
  })

  it("proves all removal commits in the persistent primary target branch before removing", async () => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-component-custody-"))
    try {
      const fixture = createProductFixture(root)
      const product = fixture.product
      const target = join(root, "target")
      git(product, "worktree", "add", "--detach", target)
      git(target, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive")

      const result = await superWorktreeRemove({
        repo: product,
        path: target,
        retain: join(root, "retained"),
        componentCustody: { primaryRoot: product, targetBranch: "main" },
      })

      expect(result.state, result.detail?.message ?? JSON.stringify(result)).toBe("updated")
      expect(result.proof?.componentCustody).toMatchObject({
        targetBranch: "main",
        componentCount: 2,
        effectiveCommitCount: 2,
        witnessCount: 2,
      })
      expect(existsSync(target)).toBe(false)
    } finally {
      // raw-delete-allow: this isolated mkdtemp fixture owns every path beneath root
      await rm(root, { recursive: true, force: true })
    }
  })

  it("removes a root-only worktree while preserving uncustodied root commits", async () => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-root-only-custody-"))
    try {
      const product = join(root, "product")
      const target = join(root, "target")
      createRepository(product, "root.txt", "root\n")
      git(product, "worktree", "add", "--detach", target)
      const head = git(product, "rev-parse", "HEAD")
      const tree = git(product, "rev-parse", "HEAD^{tree}")
      const dangling = git(product, "commit-tree", tree, "-p", head, "-m", "root-only dangling commit")
      git(product, "update-ref", "refs/heads/queue/root-only", dangling)

      const result = await superWorktreeRemove({
        repo: product,
        path: target,
        retain: join(root, "retained"),
        componentCustody: { primaryRoot: product, targetBranch: "main" },
      })

      expect(result.state, result.detail?.message ?? JSON.stringify(result)).toBe("updated")
      expect(result.proof?.componentCustody).toMatchObject({
        targetBranch: "main",
        componentCount: 0,
        effectiveCommitCount: 0,
        witnessCount: 0,
      })
      expect(git(product, "cat-file", "-e", `${dangling}^{commit}`)).toBe("")
      expect(git(product, "rev-parse", "refs/heads/queue/root-only")).toBe(dangling)
      expect(existsSync(target)).toBe(false)
    } finally {
      // raw-delete-allow: this isolated fixture tree owns every path beneath root
      await rm(root, { recursive: true, force: true })
    }
  })

  it("returns unknown when the removal root does not share the persistent primary Git stores", async () => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-root-identity-mismatch-"))
    try {
      const product = join(root, "product")
      const primary = join(root, "primary")
      const target = join(root, "target")
      createRepository(product, "root.txt", "root\n")
      createRepository(primary, "primary.txt", "primary\n")
      git(product, "worktree", "add", "--detach", target)

      const outcome = await createGitWorktreeStore({
        repo: product,
        gitProcess: createLocalGitProcess(),
      }).remove(target, {
        retention: { root: join(root, "retained"), report: () => undefined },
        componentCustody: { primaryRoot: primary, targetBranch: "main" },
      })

      expect(outcome).toMatchObject({
        custodyRefusal: { status: "unknown", component: ".", source: "recursive component census" },
      })
      expect(JSON.stringify(outcome)).toContain("root persistent primary")
      expect(existsSync(target)).toBe(true)
    } finally {
      // raw-delete-allow: this isolated fixture tree owns every path beneath root
      await rm(root, { recursive: true, force: true })
    }
  })

  /**
   * @failure A commit created after the first identity census but before leases and the final proof is omitted from
   * the complete source ledger, allowing removal to proceed on a stale object population.
   * @level l1 @consumer automatic environment removal through GitSuper
   * This must be caught at the transaction seam; the Gate 4 inventory unit tests do not exercise census/lease ordering.
   */
  it("includes a commit introduced after the initial census in the acquired final proof", async () => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-component-custody-new-commit-"))
    try {
      const fixture = createProductFixture(root)
      const product = fixture.product
      const target = join(root, "target")
      git(product, "worktree", "add", "--detach", target)
      git(target, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive")
      const alphaSource = join(target, "packages/alpha")
      const tree = git(alphaSource, "rev-parse", "HEAD^{tree}")
      const parent = git(alphaSource, "rev-parse", "HEAD")
      let introduced: string | undefined
      const nulFraming: { args: readonly string[]; framing: string | undefined }[] = []
      const local = createLocalGitProcess()
      const localStream = local.stream!
      const store = createGitWorktreeStore({
        repo: product,
        gitProcess: {
          run: local.run,
          stream: (request) => {
            // AC: the selected custody query adapter must carry NUL framing through to
            // native Git; isolated reader tests cannot catch a lost request option.
            const beforePaths = request.args.slice(
              0,
              request.args.indexOf("--") === -1 ? undefined : request.args.indexOf("--"),
            )
            if (
              request.env?.GIT_NO_LAZY_FETCH === "1" &&
              (beforePaths.includes("-z") || beforePaths.includes("--null"))
            )
              nulFraming.push({ args: request.args, framing: request.framing })
            if (introduced === undefined && request.args.includes("--batch-all-objects")) {
              introduced = git(alphaSource, "commit-tree", tree, "-p", parent, "-m", "introduced before final proof")
            }
            const stream = localStream(request)
            return stream
          },
        },
      })

      const outcome = await store.remove(target, {
        retention: { root: join(root, "retained"), report: () => undefined },
        componentCustody: { primaryRoot: product, targetBranch: "main" },
      })

      expect(nulFraming.length).toBeGreaterThan(0)
      expect(nulFraming.filter((request) => request.framing !== "nul")).toEqual([])
      expect(introduced).toMatch(/^[0-9a-f]{40}$/u)
      expect(outcome).toMatchObject({
        custodyRefusal: { status: "blocked", component: "packages/alpha", oid: introduced },
      })
      expect(existsSync(target)).toBe(true)
    } finally {
      // raw-delete-allow: this isolated mkdtemp root owns every path beneath it
      await rm(root, { recursive: true, force: true })
    }
  })

  /**
   * @failure Final custody relies on a persistent primary store whose writer lease is held, yet removal proceeds.
   * @level l1 @consumer automatic environment removal through GitSuper
   * Gate 5 checks graph validity, while the transaction suite must prove the external lease gates that final proof.
   */
  it("keeps the target when its external persistent-primary witness lease is held", async () => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-component-custody-held-primary-"))
    let lease: ReturnType<typeof tryAcquireFlock> | undefined
    try {
      const fixture = createProductFixture(root)
      const target = join(root, "target")
      git(fixture.product, "worktree", "add", "--detach", target)
      git(target, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive")
      const alpha = join(fixture.product, "packages/alpha")
      const owner = git(alpha, "rev-parse", "--path-format=absolute", "--git-common-dir")
      const lock = join(owner, "yrd-worktree-mutations", "writer.lock")
      await mkdir(join(owner, "yrd-worktree-mutations"), { recursive: true })
      lease = tryAcquireFlock(lock, { body: "fixture external witness writer" })
      expect(lease).not.toBeNull()

      const outcome = await createGitWorktreeStore({
        repo: fixture.product,
        gitProcess: createLocalGitProcess(),
      }).remove(target, {
        retention: { root: join(root, "retained"), report: () => undefined },
        componentCustody: { primaryRoot: fixture.product, targetBranch: "main" },
      })

      expect(outcome).toMatchObject({
        custodyRefusal: {
          status: "unknown",
          source: `writer lease owner ${owner}`,
        },
      })
      expect(JSON.stringify(outcome)).toContain(owner)
      expect(JSON.stringify(outcome)).toContain("writer lease")
      expect(existsSync(target)).toBe(true)
      expect(git(fixture.product, "worktree", "list", "--porcelain")).toContain(`worktree ${target}\n`)
    } finally {
      lease?.release()
      // raw-delete-allow: this isolated mkdtemp root owns every path beneath it
      await rm(root, { recursive: true, force: true })
    }
  })

  /**
   * @failure A newly consulted alternate-store identity is added after the initial census, but proof uses the stale census.
   * @level l1 @consumer automatic environment removal through GitSuper
   * Gate tests cover static identities; only the live transaction can assert the two censuses agree before proof.
   */
  it("refuses when a consulted component's alternate identity changes between censuses", async () => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-component-custody-reidentity-"))
    try {
      const fixture = createProductFixture(root)
      const target = join(root, "target")
      git(fixture.product, "worktree", "add", "--detach", target)
      git(target, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive")
      // Both censuses must be valid independently: borrowing a disappearing
      // target store is already refused by root alternate validation.
      const alpha = join(fixture.product, "packages/alpha")
      const alphaObjects = git(alpha, "rev-parse", "--path-format=absolute", "--git-path", "objects")
      const betaObjects = git(
        join(fixture.product, "vendor/beta"),
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "objects",
      )
      const rootObjects = git(target, "rev-parse", "--path-format=absolute", "--git-path", "objects")
      const alternatesFile = join(rootObjects, "info", "alternates")
      const previousAlternates = existsSync(alternatesFile) ? readFileSync(alternatesFile, "utf8") : ""
      const existingAlternates = new Set(previousAlternates.split(/\r?\n/u).filter(Boolean))
      const newAlternate = [alphaObjects, betaObjects].find((candidate) => !existingAlternates.has(candidate))
      expect(newAlternate).toBeDefined()
      let rootStoreLists = 0
      let changed = false
      const local = createLocalGitProcess()
      const localStream = local.stream!
      const store = createGitWorktreeStore({
        repo: fixture.product,
        gitProcess: {
          run: local.run,
          stream: (request) => {
            const changesIdentity =
              !changed &&
              request.args[0] === "-C" &&
              request.args[1] === join(fixture.product, ".git") &&
              request.args.includes("worktree") &&
              request.args.includes("list") &&
              ++rootStoreLists === 3
            if (changesIdentity) {
              mkdirSync(join(rootObjects, "info"), { recursive: true })
              const separator = previousAlternates === "" || previousAlternates.endsWith("\n") ? "" : "\n"
              writeFileSync(alternatesFile, `${previousAlternates}${separator}${newAlternate}\n`)
              changed = true
            }
            const stream = localStream(request)
            return stream
          },
        },
      })

      const outcome = await store.remove(target, {
        retention: { root: join(root, "retained"), report: () => undefined },
        componentCustody: { primaryRoot: fixture.product, targetBranch: "main" },
      })

      expect(changed).toBe(true)
      expect(outcome).toMatchObject({
        custodyRefusal: { status: "unknown", source: "component identity recensus" },
      })
      expect(existsSync(target)).toBe(true)
    } finally {
      // raw-delete-allow: this isolated mkdtemp root owns every path beneath it
      await rm(root, { recursive: true, force: true })
    }
  })

  /**
   * @failure A dangling commit supplied only by a persistent component alternate is omitted from complete-commit census and removal succeeds.
   * @level l1 @consumer automatic environment removal through GitSuper
   * Gate 4 verifies alternate enumeration and Gate 5 verifies graph coverage separately; this pins their removal-path composition.
   */
  it("keeps a target for an alternate-supplied dangling commit", async () => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-component-custody-alternate-dangling-"))
    try {
      const fixture = createProductFixture(root)
      const target = join(root, "target")
      git(fixture.product, "worktree", "add", "--detach", target)
      git(target, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive")
      const alphaPrimary = join(fixture.product, "packages/alpha")
      const alphaHead = git(alphaPrimary, "rev-parse", "HEAD")
      const alphaTree = git(alphaPrimary, "rev-parse", `${alphaHead}^{tree}`)
      const dangling = git(
        alphaPrimary,
        "commit-tree",
        alphaTree,
        "-p",
        alphaHead,
        "-m",
        "alternate-only dangling commit",
      )
      const alphaSource = join(target, "packages/alpha")
      const alphaObjects = git(alphaSource, "rev-parse", "--path-format=absolute", "--git-path", "objects")
      const alternateObjects = git(alphaPrimary, "rev-parse", "--path-format=absolute", "--git-path", "objects")
      const alternatesFile = join(alphaObjects, "info", "alternates")
      const priorAlternates = existsSync(alternatesFile) ? readFileSync(alternatesFile, "utf8") : ""
      await mkdir(join(alphaObjects, "info"), { recursive: true })
      const separator = priorAlternates === "" || priorAlternates.endsWith("\n") ? "" : "\n"
      await writeFile(alternatesFile, `${priorAlternates}${separator}${alternateObjects}\n`)

      const outcome = await createGitWorktreeStore({
        repo: fixture.product,
        gitProcess: createLocalGitProcess(),
      }).remove(target, {
        retention: { root: join(root, "retained"), report: () => undefined },
        componentCustody: { primaryRoot: fixture.product, targetBranch: "main" },
      })

      expect(outcome, JSON.stringify(outcome)).toMatchObject({
        custodyRefusal: { status: "blocked", component: "packages/alpha", oid: dangling },
      })
      expect(existsSync(target)).toBe(true)
    } finally {
      // raw-delete-allow: this isolated mkdtemp root owns every path beneath it
      await rm(root, { recursive: true, force: true })
    }
  })

  /**
   * @failure The persistent witness graph borrows from an object store inside the worktree removal set, yet is accepted.
   * @level l1 @consumer automatic environment removal through GitSuper
   * Gate 5 has a direct unit pin; this confirms the live census passes the true removal boundary to it.
   */
  it.each(["component", "root"] as const)(
    "refuses a %s witness graph that borrows from the disappearing component store",
    async (borrower) => {
      const root = await mkdtemp(join(canonicalTmpdir(), "git-super-component-custody-disappearing-source-"))
      try {
        const fixture = createProductFixture(root)
        const target = join(root, "target")
        git(fixture.product, "worktree", "add", "--detach", target)
        git(target, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive")
        const alphaSource = join(target, "packages/alpha")
        const alphaSourceObjects = git(alphaSource, "rev-parse", "--path-format=absolute", "--git-path", "objects")
        const primary = borrower === "root" ? fixture.product : join(fixture.product, "packages/alpha")
        const primaryObjects = git(primary, "rev-parse", "--path-format=absolute", "--git-path", "objects")
        await mkdir(join(primaryObjects, "info"), { recursive: true })
        await writeFile(join(primaryObjects, "info", "alternates"), `${alphaSourceObjects}\n`)

        const outcome = await createGitWorktreeStore({
          repo: fixture.product,
          gitProcess: createLocalGitProcess(),
        }).remove(target, {
          retention: { root: join(root, "retained"), report: () => undefined },
          componentCustody: { primaryRoot: fixture.product, targetBranch: "main" },
        })

        expect(outcome).toMatchObject({
          custodyRefusal: {
            status: "unknown",
            source: borrower === "root" ? "recursive component census" : "surviving primary Git graph",
            detail: expect.stringContaining("inside the removal set"),
          },
        })
        expect(existsSync(target)).toBe(true)
        expect(git(fixture.product, "worktree", "list", "--porcelain")).toContain(`worktree ${target}\n`)
      } finally {
        // raw-delete-allow: this isolated mkdtemp root owns every path beneath it
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it("returns a structured custody refusal and preserves the target when the primary lacks the named branch", async () => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-component-custody-refusal-"))
    try {
      const fixture = createProductFixture(root)
      const product = fixture.product
      const target = join(root, "target")
      git(product, "worktree", "add", "--detach", target)
      git(target, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive")

      const result = await superWorktreeRemove({
        repo: product,
        path: target,
        retain: join(root, "retained"),
        componentCustody: { primaryRoot: product, targetBranch: "release" },
      })

      expect(result.state).toBe("unchanged")
      expect(result.reason).toBe("component-custody")
      expect(result.custody).toMatchObject({ status: "blocked", component: "packages/alpha" })
      expect(existsSync(target)).toBe(true)
    } finally {
      // raw-delete-allow: this isolated mkdtemp fixture owns every path beneath root
      await rm(root, { recursive: true, force: true })
    }
  })

  it("reports unknown and preserves the target when the selected Git process cannot stream", async () => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-component-custody-no-stream-"))
    try {
      const product = join(root, "product")
      const target = join(root, "target")
      createRepository(product, "root.txt", "root\n")
      git(product, "worktree", "add", "--detach", target)
      const local = createLocalGitProcess()
      const store = createGitWorktreeStore({ repo: product, gitProcess: { run: local.run } })

      const outcome = await store.remove(target, {
        retention: { root: join(root, "retained"), report: () => undefined },
        componentCustody: { primaryRoot: product, targetBranch: "main" },
      })

      expect(outcome).toMatchObject({ custodyRefusal: { status: "unknown", component: "." } })
      expect(existsSync(target)).toBe(true)
    } finally {
      // raw-delete-allow: this isolated mkdtemp fixture owns every path beneath root
      await rm(root, { recursive: true, force: true })
    }
  })

  // The cap case must cross the real stream reader, then preserve both custody evidence and checkout ownership.
  it.each(["failed", "capped"] as const)("refuses custody when a nested component census query is %s", async (mode) => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-component-custody-nested-failure-"))
    try {
      const fixture = createProductFixture(root)
      const target = join(root, "target with spaces")
      git(fixture.product, "worktree", "add", "--detach", target)
      git(target, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive")
      const child = join(target, "packages/alpha")
      const checkoutBytes = readFileSync(join(child, "alpha.ts"))
      const rootRegistration = git(fixture.product, "worktree", "list", "--porcelain")
      const childRegistration = git(child, "worktree", "list", "--porcelain")
      const local = createLocalGitProcess()
      const failed = async function* (): AsyncGenerator<string> {}
      let cappedOutcome: GitStreamOutcome | undefined
      const store = createGitWorktreeStore({
        repo: fixture.product,
        gitProcess: {
          run: (request) => local.run(request),
          stream: (request) => {
            if (request.args[0] === "-C" && request.args[1] === child && request.args.includes("--show-toplevel")) {
              if (mode === "capped") {
                const oversized = async function* (): AsyncGenerator<Buffer> {
                  yield Buffer.from("x".repeat(MAX_LINE_LENGTH) + "\0")
                }
                const stream = gitLineStream(["--version"], {
                  stdout: oversized(),
                  ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
                  ...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }),
                  ...(request.maxLines === undefined ? {} : { maxLines: request.maxLines }),
                })
                return {
                  lines: stream.lines,
                  outcome: stream.outcome.then((outcome) => {
                    cappedOutcome = outcome
                    return { ...outcome, stderr: `${outcome.stderr}fixture nested census failure` }
                  }),
                }
              }
              return {
                lines: failed(),
                outcome: Promise.resolve({
                  code: 1,
                  bytes: 0,
                  lines: 0,
                  stderr: "fixture nested census failure",
                  timedOut: false,
                  capped: false,
                }),
              }
            }
            return local.stream!(request)
          },
        },
      })

      const outcome = await store.remove(target, {
        retention: { root: join(root, "retained"), report: () => undefined },
        componentCustody: { primaryRoot: fixture.product, targetBranch: "main" },
      })

      expect(outcome).toMatchObject({
        custodyRefusal: {
          status: "unknown",
          component: ".",
          source: "recursive component census",
          detail: expect.stringContaining("fixture nested census failure"),
        },
      })
      expect(JSON.stringify(outcome)).toContain("packages/alpha")
      expect(existsSync(target)).toBe(true)
      expect(readFileSync(join(child, "alpha.ts"))).toEqual(checkoutBytes)
      expect(git(fixture.product, "worktree", "list", "--porcelain")).toBe(rootRegistration)
      expect(git(child, "worktree", "list", "--porcelain")).toBe(childRegistration)
      if (mode === "capped") {
        expect(cappedOutcome).toMatchObject({ capped: true, timedOut: false, bytes: MAX_LINE_LENGTH + 1, lines: 0 })
        if (outcome === undefined || !("custodyRefusal" in outcome)) throw new Error("expected a custody refusal")
        const detail = outcome.custodyRefusal.detail
        expect.soft(detail).toContain(`repository=${JSON.stringify(fixture.product)}`)
        expect
          .soft(detail)
          .toContain(
            `argv=${JSON.stringify(["git", "-C", fixture.product, "-C", child, "rev-parse", "--show-toplevel"])}`,
          )
        expect(detail).toContain("selected Git query exceeded its output cap")
      }
    } finally {
      // raw-delete-allow: this isolated mkdtemp fixture owns every path beneath root
      await rm(root, { recursive: true, force: true })
    }
  })

  it("keeps a borrowed component worktree when noRehome is set", async () => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-component-borrow-"))
    try {
      const fixture = addNestedAlphaSubmodule(createProductFixture(root))
      const alpha = join(fixture.product, "packages/alpha")
      const lender = join(root, "alpha-lender")
      const borrower = join(root, "alpha-borrower")
      git(alpha, "worktree", "add", "--detach", lender)
      git(alpha, "worktree", "add", "--detach", borrower)
      git(lender, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "apps/maddoc")
      git(borrower, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "apps/maddoc")
      const lenderObjects = join(git(join(lender, "apps/maddoc"), "rev-parse", "--absolute-git-dir").trim(), "objects")
      const borrowerGitDir = git(join(borrower, "apps/maddoc"), "rev-parse", "--absolute-git-dir").trim()
      const borrowerObjects = join(borrowerGitDir, "objects")
      // raw-delete-allow: the fixture tree this test made under its own mkdtemp root
      await rm(borrowerObjects, { recursive: true, force: true })
      await symlink(lenderObjects, borrowerObjects, "dir")

      const result = await superWorktreeRemove({
        repo: fixture.product,
        path: lender,
        retain: join(root, "retained"),
        noRehome: true,
      })

      expect(result.state).toBe("unchanged")
      expect(result.reason).toBe("borrowed")
      expect(result.borrowers).toEqual([borrower])
      expect(existsSync(lender)).toBe(true)
    } finally {
      // raw-delete-allow: the fixture tree this test made under its own mkdtemp root
      await rm(root, { recursive: true, force: true })
    }
  })
})
