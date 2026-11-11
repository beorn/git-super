/**
 * @failure git-super worktree remove --repo <super> refuses a clean component worktree as not registered in the super (28393).
 * @level l1
 * @consumer WIP sweep retiring landed vendor component worktrees; yrd env close delegates to this verb
 * @reach fs-walk <fixture-only: isolated Git repositories and their retained children>
 * @testonly none
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { tryAcquireFlock } from "@bearly/flock"
import {
  CUSTODY_FRESHNESS_INPUT_SPEC,
  CUSTODY_FRESHNESS_SCHEMA_VERSION,
  createGitWorktreeStore,
  hashCustodyFreshnessMaterial,
  scopeCustodyFreshnessMaterial,
  type CustodyFreshnessMaterial,
} from "../src/worktree.ts"
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

  /**
   * @failure Removal diagnostics hide whether slow witness proof or the global writer accounts for the elapsed time.
   * @level l1
   * @consumer worktree remove that keeps retention custody
   * Empty removals never enter retention-custody.ts, so they cannot time this hold.
   */
  it("names custody proof phases and global writer hold separately", async () => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-removal-hold-phases-"))
    const previous = process.env.GIT_SUPER_REMOVAL_PHASES
    process.env.GIT_SUPER_REMOVAL_PHASES = "1"
    const errors: string[] = []
    const original = console.error
    console.error = (...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(" "))
    }
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
      const line = errors.find((entry) => entry.includes("git-super removal phases"))
      expect(line, errors.join("\n")).toBeDefined()
      const phases = (JSON.parse(line!.slice(line!.indexOf("{"))) as { phases: Record<string, number> }).phases
      expect(phases).toHaveProperty("witnessFsck")
      expect(phases).toHaveProperty("refGraph")
      expect(phases).toHaveProperty("globalWriterHeld")
      expect(phases).toHaveProperty("unlockedProof")
      expect(phases).toHaveProperty("globalWriterHeldBeforeProof")
      expect(phases).toHaveProperty("globalWriterHeldAfterProof")
      expect(phases).toHaveProperty("retainedCopy")
      expect(phases).toHaveProperty("preserveModuleStoreValue")
      expect(phases.globalWriterHeld).toBe(phases.globalWriterHeldBeforeProof! + phases.globalWriterHeldAfterProof!)
    } finally {
      console.error = original
      if (previous === undefined) delete process.env.GIT_SUPER_REMOVAL_PHASES
      else process.env.GIT_SUPER_REMOVAL_PHASES = previous
      // raw-delete-allow: this isolated mkdtemp fixture owns every path beneath root
      await rm(root, { recursive: true, force: true })
    }
  })

  /**
   * @failure A custody scan monopolizes the root writer, or removal acts on source/witness state changed while unlocked.
   * @level l1 @consumer automatic environment removal and unrelated root writers (31301)
   * Existing census and phase tests never contend for the actual root flock during a paused witness scan.
   */
  it.each([
    "unchanged",
    "witness-added",
    "witness-forwarded",
    "witness-rewound",
    "witness-deleted",
    "component-changed",
    "identity-changed",
    "witness-diverged-after-read",
  ] as const)("admits a root writer during custody proof and validates the gap: %s", async (mode) => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-custody-unlocked-"))
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    let removal: ReturnType<ReturnType<typeof createGitWorktreeStore>["remove"]> | undefined
    let contender: ReturnType<typeof tryAcquireFlock> | undefined
    try {
      const fixture = createProductFixture(root)
      const product = fixture.product
      const target = join(root, "target")
      git(product, "worktree", "add", "--detach", target)
      git(target, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive")
      const witness = join(product, "packages/alpha")
      const source = join(target, "packages/alpha")
      const witnessDir = git(witness, "rev-parse", "--path-format=absolute", "--git-common-dir")
      const original = git(witness, "rev-parse", "HEAD")
      const tree = git(witness, "rev-parse", "HEAD^{tree}")
      const proofTip = git(witness, "commit-tree", tree, "-p", original, "-m", "proof-time witness")
      const newerTip = git(witness, "commit-tree", tree, "-p", proofTip, "-m", "forward witness")
      const otherTip = git(witness, "commit-tree", tree, "-p", proofTip, "-m", "divergent witness")
      git(witness, "update-ref", "refs/heads/main", proofTip)
      const common = git(product, "rev-parse", "--path-format=absolute", "--git-common-dir")
      const local = createLocalGitProcess()
      const localStream = local.stream!
      let paused = false
      let replacedAfterRead = false
      const store = createGitWorktreeStore({
        repo: product,
        gitProcess: {
          ...local,
          stream(request) {
            const stream = localStream(request)
            if (
              mode === "witness-diverged-after-read" &&
              !replacedAfterRead &&
              request.args.includes(`--git-dir=${witnessDir}`) &&
              request.args.includes("rev-list") &&
              request.args.includes(newerTip)
            ) {
              // The graph query already names newerTip; its ref now moves to a sibling of that proof-time tip.
              git(witness, "update-ref", "refs/heads/main", otherTip)
              replacedAfterRead = true
            }
            if (!paused && request.args.includes("fsck") && request.args.includes(`--git-dir=${witnessDir}`)) {
              paused = true
              entered.resolve()
              return {
                ...stream,
                lines: (async function* () {
                  await resume.promise
                  yield* stream.lines
                })(),
              }
            }
            return stream
          },
        },
      })
      removal = store.remove(target, {
        retention: { root: join(root, "retained"), report: () => undefined },
        componentCustody: { primaryRoot: product, targetBranch: "main" },
      })
      await Promise.race([
        entered.promise,
        removal.then((outcome) => {
          throw new Error(`removal ended before witness barrier: ${JSON.stringify(outcome)}`)
        }),
      ])
      contender = tryAcquireFlock(join(common, "yrd-worktree-mutations", "writer.lock"), {
        body: "unrelated root writer",
      })
      expect(contender, "the root writer must be available while custody proof is paused").not.toBeNull()
      const witnessContender = tryAcquireFlock(join(witnessDir, "yrd-worktree-mutations", "writer.lock"))
      witnessContender?.release()
      expect(witnessContender, "the witness owner lease must remain held during the gap").toBeNull()
      if (mode === "witness-added") git(witness, "update-ref", `refs/git-super/pins/${newerTip}`, newerTip)
      if (mode === "witness-forwarded" || mode === "witness-diverged-after-read") {
        git(witness, "update-ref", "refs/heads/main", newerTip)
      }
      if (mode === "witness-rewound") git(witness, "update-ref", "refs/heads/main", original)
      if (mode === "witness-deleted") git(witness, "update-ref", "-d", "refs/heads/main")
      if (mode === "component-changed") git(source, "update-ref", "refs/heads/during-proof", original)
      if (mode === "identity-changed") {
        const beta = git(join(product, "vendor/beta"), "rev-parse", "--path-format=absolute", "--git-path", "objects")
        writeFileSync(join(witnessDir, "objects/info/alternates"), `${beta}\n`)
      }
      contender?.release()
      contender = undefined
      resume.resolve()
      const outcome = await removal
      if (mode === "witness-diverged-after-read") expect(replacedAfterRead).toBe(true)
      const kept = [
        "witness-rewound",
        "witness-deleted",
        "component-changed",
        "identity-changed",
        "witness-diverged-after-read",
      ].includes(mode)
      if (kept) {
        expect(outcome).toMatchObject({ custodyRefusal: { status: "unknown" } })
        expect(existsSync(target)).toBe(true)
        expect(git(product, "worktree", "list", "--porcelain")).toContain(`worktree ${target}\n`)
      } else {
        expect(outcome ?? {}).not.toHaveProperty("custodyRefusal")
        expect(existsSync(target)).toBe(false)
      }
      const released = tryAcquireFlock(join(witnessDir, "yrd-worktree-mutations", "writer.lock"))
      expect(released, "all outcomes must release witness leases").not.toBeNull()
      released?.release()
    } finally {
      contender?.release()
      resume.resolve()
      await removal
      // raw-delete-allow: this isolated mkdtemp fixture owns every path beneath root
      await rm(root, { recursive: true, force: true })
    }
  })

  /**
   * @failure Retention verification holds the root writer or a changed prepared copy authorizes deletion.
   * @level l1 @consumer automatic retained environment removal (31301)
   * The custody-gap table pauses witness proof, before the distinct retention normalization stage.
   */
  it.each(["unchanged", "source-changed", "copy-changed", "failed-preparation"] as const)(
    "prepares retention without the root writer and validates its exact child: %s",
    async (mode) => {
      const root = await mkdtemp(join(canonicalTmpdir(), "git-super-retention-unlocked-"))
      const entered = Promise.withResolvers<void>()
      const resume = Promise.withResolvers<void>()
      let removal: ReturnType<ReturnType<typeof createGitWorktreeStore>["remove"]> | undefined
      let contender: ReturnType<typeof tryAcquireFlock> | undefined
      try {
        const fixture = createProductFixture(root)
        const product = fixture.product
        const target = join(root, "target")
        const retainedRoot = join(root, "retained")
        const unrelatedEntry = join(retainedRoot, "other-keeper")
        mkdirSync(unrelatedEntry, { recursive: true })
        writeFileSync(join(unrelatedEntry, "keep.txt"), "another invocation's custody\n")
        git(product, "worktree", "add", "--detach", target)
        git(target, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive")
        const sourceGitDir = git(target, "rev-parse", "--absolute-git-dir")
        const sourceStore = git(join(target, "packages/alpha"), "rev-parse", "--absolute-git-dir")
        const witnessDir = git(
          join(product, "packages/alpha"),
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        )
        const common = git(product, "rev-parse", "--path-format=absolute", "--git-common-dir")
        const local = createLocalGitProcess()
        let paused = false
        let copiedStore = ""
        let changedPreparedCopy = false
        let reports = 0
        const store = createGitWorktreeStore({
          repo: product,
          gitProcess: {
            ...local,
            stream(request) {
              // The post-preparation census uses bounded streaming, unlike normalization's buffered run.
              if (
                mode === "copy-changed" &&
                copiedStore !== "" &&
                !changedPreparedCopy &&
                request.args.includes("check-ref-format")
              ) {
                writeFileSync(join(copiedStore, "description"), "changed prepared metadata\n")
                changedPreparedCopy = true
              }
              return local.stream!(request)
            },
            async run(request) {
              const gitDirAt = request.args.indexOf("--git-dir")
              const candidate = gitDirAt < 0 ? undefined : request.args[gitDirAt + 1]
              if (!paused && request.args.includes("fsck") && candidate?.startsWith(`${retainedRoot}/`)) {
                paused = true
                copiedStore = candidate
                entered.resolve()
                await resume.promise
                if (mode === "failed-preparation") throw new Error("fixture retention preparation failed")
              }
              return local.run(request)
            },
          },
        })
        removal = store.remove(target, {
          retention: { root: retainedRoot, report: () => reports++ },
          componentCustody: { primaryRoot: product, targetBranch: "main" },
        })
        await Promise.race([
          entered.promise,
          removal.then((outcome) => {
            throw new Error(`removal ended before retention barrier: ${JSON.stringify(outcome)}`)
          }),
        ])
        const preparingChild = readdirSync(retainedRoot).find((name) => name !== "other-keeper")
        expect(preparingChild).toBeTruthy()
        const preparingPath = join(retainedRoot, preparingChild!)
        const marker = JSON.parse(readFileSync(join(preparingPath, "preparation.json"), "utf8")) as Record<
          string,
          unknown
        >
        expect(marker).toMatchObject({ version: 1, state: "preparing", sourceGitDir })
        expect(typeof marker.createdAt === "string" && Number.isFinite(Date.parse(marker.createdAt))).toBe(true)
        expect(existsSync(join(preparingPath, "manifest.json"))).toBe(false)
        expect(reports).toBe(0)
        contender = tryAcquireFlock(join(common, "yrd-worktree-mutations", "writer.lock"))
        expect(contender, "root writer must be available during retention verification").not.toBeNull()
        for (const owner of [sourceGitDir, sourceStore, witnessDir]) {
          const competingOwner = tryAcquireFlock(join(owner, "yrd-worktree-mutations", "writer.lock"))
          competingOwner?.release()
          expect(competingOwner, `source/witness owner remains held: ${owner}`).toBeNull()
        }
        if (mode === "source-changed") writeFileSync(join(sourceStore, "description"), "changed source metadata\n")
        contender?.release()
        contender = undefined
        resume.resolve()
        const outcome = await removal.then(
          (value) => ({ value, error: undefined }),
          (error: unknown) => ({ value: undefined, error }),
        )
        if (mode === "copy-changed") {
          expect(changedPreparedCopy, "the prepared copy was actually changed after hashing").toBe(true)
        }
        expect(readFileSync(join(unrelatedEntry, "keep.txt"), "utf8")).toBe("another invocation's custody\n")
        if (mode === "unchanged") {
          expect(outcome.error).toBeUndefined()
          expect(outcome.value ?? {}).not.toHaveProperty("custodyRefusal")
          expect(existsSync(target)).toBe(false)
          expect(reports).toBe(1)
          const ownEntry = readdirSync(retainedRoot).find((name) => name !== "other-keeper")
          expect(ownEntry).toBeTruthy()
          expect(existsSync(join(retainedRoot, ownEntry!, "manifest.json"))).toBe(true)
          expect(existsSync(join(retainedRoot, ownEntry!, "preparation.json"))).toBe(false)
        } else {
          expect(existsSync(target)).toBe(true)
          expect((await store.inspect(target)).registered).toBe(true)
          expect(reports).toBe(0)
          expect(readdirSync(retainedRoot)).toEqual(["other-keeper"])
          expect(
            outcome.error !== undefined || (outcome.value !== undefined && "custodyRefusal" in outcome.value),
          ).toBe(true)
        }
        if (mode !== "unchanged") {
          const released = tryAcquireFlock(join(sourceGitDir, "yrd-worktree-mutations", "writer.lock"))
          released?.release()
          expect(released).not.toBeNull()
        }
      } finally {
        contender?.release()
        resume.resolve()
        await removal?.catch(() => undefined)
        // raw-delete-allow: this test owns the isolated mkdtemp fixture, never an authored checkout
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  /**
   * @failure SIGKILL leaves an unidentifiable partial retained copy or source deletion without publication.
   * @level l1 @consumer a host inspecting retained custody after its remover process dies (31301)
   * The exception table runs finally/discard; only a separate killed process proves the no-finally boundary.
   */
  it("keeps an identifiable unpublished child and its registered source after the preparation process is killed", async () => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-retention-killed-"))
    let child: ReturnType<typeof Bun.spawn> | undefined
    let killDeadline: ReturnType<typeof setTimeout> | undefined
    try {
      const fixture = createProductFixture(root)
      const product = fixture.product
      const target = join(root, "target")
      const retainedRoot = join(root, "retained")
      const published = join(root, "published")
      git(product, "worktree", "add", "--detach", target)
      git(target, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive")
      const sourceGitDir = git(target, "rev-parse", "--absolute-git-dir")
      const sourceStore = git(join(target, "packages/alpha"), "rev-parse", "--absolute-git-dir")
      const witnessDir = git(join(product, "packages/alpha"), "rev-parse", "--path-format=absolute", "--git-common-dir")
      const common = git(product, "rev-parse", "--path-format=absolute", "--git-common-dir")
      const script = `
        import { createGitWorktreeStore } from ${JSON.stringify(new URL("../src/worktree.ts", import.meta.url).href)};
        import { createLocalGitProcess } from ${JSON.stringify(new URL("../src/process.ts", import.meta.url).href)};
        import { writeFileSync } from "node:fs";
        const local = createLocalGitProcess();
        const retainedRoot = ${JSON.stringify(retainedRoot)};
        const store = createGitWorktreeStore({repo: ${JSON.stringify(product)}, gitProcess: {
          ...local,
          async run(request) {
            const at = request.args.indexOf("--git-dir");
            const candidate = at < 0 ? undefined : request.args[at + 1];
            if (request.args.includes("fsck") && candidate?.startsWith(retainedRoot + "/")) {
              console.log("retention-preparation-ready");
              await Bun.sleep(60000);
            }
            return local.run(request);
          }
        }});
        await store.remove(${JSON.stringify(target)}, {
          retention: {root: retainedRoot, report: () => writeFileSync(${JSON.stringify(published)}, "published")},
          componentCustody: {primaryRoot: ${JSON.stringify(product)}, targetBranch: "main"}
        });
      `
      const running = Bun.spawn([process.execPath, "--eval", script], {
        cwd: product,
        env: { ...process.env, GIT_SUPER_REMOVAL_PHASES: "0" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      child = running
      // Readiness has a generous bound under fleet load; the child is always reaped, including a failed setup.
      killDeadline = setTimeout(() => running.kill("SIGKILL"), 20_000)
      const reader = running.stdout.getReader()
      const decoder = new TextDecoder()
      const ended = running.exited.then(async (code) => {
        throw new Error(
          `remover exited before preparation barrier (${code}): ${await new Response(running.stderr).text()}`,
        )
      })
      let output = ""
      while (!output.includes("retention-preparation-ready\n")) {
        const next = await Promise.race([reader.read(), ended])
        if (next.done) throw new Error("remover stdout ended before its preparation barrier")
        output += decoder.decode(next.value, { stream: true })
      }
      const children = readdirSync(retainedRoot)
      expect(children).toHaveLength(1)
      const partial = join(retainedRoot, children[0]!)
      expect(existsSync(join(partial, "preparation.json"))).toBe(true)
      const marker = JSON.parse(readFileSync(join(partial, "preparation.json"), "utf8")) as Record<string, unknown>
      expect(marker).toMatchObject({ version: 1, state: "preparing", sourceGitDir })
      expect(typeof marker.createdAt === "string" && Number.isFinite(Date.parse(marker.createdAt))).toBe(true)
      expect(existsSync(join(partial, "manifest.json"))).toBe(false)
      expect(existsSync(published)).toBe(false)

      running.kill("SIGKILL")
      expect(await running.exited).not.toBe(0)
      clearTimeout(killDeadline)
      killDeadline = undefined
      expect(existsSync(join(partial, "preparation.json"))).toBe(true)
      expect(existsSync(join(partial, "manifest.json"))).toBe(false)
      expect(existsSync(target)).toBe(true)
      expect(git(product, "worktree", "list", "--porcelain")).toContain(`worktree ${target}\n`)
      for (const owner of [common, sourceGitDir, sourceStore, witnessDir]) {
        const released = tryAcquireFlock(join(owner, "yrd-worktree-mutations", "writer.lock"))
        released?.release()
        expect(released, `killed remover releases its writer lease: ${owner}`).not.toBeNull()
      }
    } finally {
      if (killDeadline !== undefined) clearTimeout(killDeadline)
      if (child?.exitCode === null) child.kill("SIGKILL")
      await child?.exited
      // raw-delete-allow: this test owns the isolated fixture and the explicitly reaped child process
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

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
   * @failure A commit created while reading the final ledger is omitted, allowing removal on stale source state.
   * @level l1 @consumer automatic environment removal through GitSuper
   * This must be caught at the transaction seam; the Gate 4 inventory unit tests do not exercise census/lease ordering.
   */
  it("keeps and names a commit introduced during the acquired final proof", async () => {
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
            ) {
              nulFraming.push({ args: request.args, framing: request.framing })
            }
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
        // The ledger found the new commit; the changed source state invalidates the gap's proof (31301).
        custodyRefusal: { status: "unknown", component: "packages/alpha", oid: introduced },
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
   * @failure A commit only a surviving lender store holds, which the environment never references, is
   *          counted as at risk and refuses a removal that destroys nothing (#31738 @cto ruling).
   * @level l1 @consumer automatic environment removal through GitSuper
   * Gate 4 verifies alternate enumeration and Gate 5 verifies graph coverage separately; this pins their
   * removal-path composition. Complete-commit mode counts what the removal destroys or un-references, so a
   * borrowed commit no root of this environment reaches is lender debris, and its object outlives the removal.
   */
  it("removes a target whose alternate-supplied commit is lender debris the lender keeps", async () => {
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

      expect(outcome, JSON.stringify(outcome)).not.toHaveProperty("custodyRefusal")
      expect(existsSync(target)).toBe(false)
      // The commit is un-referenced by nothing and destroyed by nothing: the lender's store still has it.
      expect(git(alphaPrimary, "cat-file", "-e", dangling)).toBe("")
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

  it("enumerates all custody freshness inputs with reasons and changes the hash when any single input changes", () => {
    expect(CUSTODY_FRESHNESS_SCHEMA_VERSION).toBe(3)
    expect(CUSTODY_FRESHNESS_INPUT_SPEC).toHaveLength(15)
    for (const entry of CUSTODY_FRESHNESS_INPUT_SPEC) {
      expect(entry.input.trim()).not.toBe("")
      expect(entry.reason.trim().length).toBeGreaterThan(10)
    }
    const alphaWitnessStore = "/tmp/primary/.git/modules/packages/alpha/objects"
    const betaWitnessStore = "/tmp/primary/.git/modules/vendor/beta/objects"
    const baseline: CustodyFreshnessMaterial = {
      schemaVersion: CUSTODY_FRESHNESS_SCHEMA_VERSION,
      targetBranch: "main",
      censusFingerprint: "a".repeat(64),
      witnessStores: [
        {
          store: alphaWitnessStore,
          objectFormat: "sha1",
          shallow: "false",
          alternatesContent: null,
          refs: ["refs/heads/main\t" + "1".repeat(40) + "\tcommit"],
        },
        {
          store: betaWitnessStore,
          objectFormat: "sha1",
          shallow: "false",
          alternatesContent: null,
          refs: ["refs/heads/main\t" + "9".repeat(40) + "\tcommit"],
        },
      ],
      components: [
        {
          component: "packages/alpha",
          gitDir: "/tmp/wt/.git/modules/packages/alpha",
          objectDirectory: "/tmp/wt/.git/modules/packages/alpha/objects",
          head: "2".repeat(40),
          refs: ["refs/heads/task\t" + "2".repeat(40) + "\t"],
          reflogs: [{ path: "logs/HEAD", sha256: "b".repeat(64) }],
          pseudoRefs: [{ name: "ORIG_HEAD", oids: ["2".repeat(40)] }],
          indexStat: "128:100:100:42",
          alternatesContent: null,
          privateObjectStore: {
            packs: ["pack-1.idx:1024", "pack-1.pack:4096"],
            looseObjects: ["ab/" + "c".repeat(38)],
          },
        },
      ],
    }
    const baseHash = hashCustodyFreshnessMaterial(baseline)
    expect(baseHash).toMatch(/^[0-9a-f]{64}$/u)

    const witnessStoreByComponent = [
      { component: "packages/alpha", store: alphaWitnessStore },
      { component: "vendor/beta", store: betaWitnessStore },
    ] as const
    const alphaScoped = scopeCustodyFreshnessMaterial(baseline, witnessStoreByComponent, "packages/alpha")
    expect(alphaScoped.status).toBe("ok")
    if (alphaScoped.status !== "ok") throw new Error("expected alpha scoped material ok")
    expect(alphaScoped.material.witnessStores).toEqual([baseline.witnessStores[0]!])

    const dotScoped = scopeCustodyFreshnessMaterial(baseline, witnessStoreByComponent, ".")
    expect(dotScoped).toEqual({
      status: "ok",
      material: baseline,
      fingerprint: baseHash,
    })

    const missingScoped = scopeCustodyFreshnessMaterial(baseline, witnessStoreByComponent, "packages/missing")
    expect(missingScoped).toEqual({
      status: "unknown",
      source: "persistent primary object store",
      detail: "no exact primary witness store was resolved for component packages/missing",
    })

    const mutations: Record<(typeof CUSTODY_FRESHNESS_INPUT_SPEC)[number]["input"], CustodyFreshnessMaterial> = {
      schemaVersion: { ...baseline, schemaVersion: CUSTODY_FRESHNESS_SCHEMA_VERSION + 1 },
      "policy.targetBranch": { ...baseline, targetBranch: "release" },
      "census.fingerprint": { ...baseline, censusFingerprint: "c".repeat(64) },
      "witness.scope": alphaScoped.material,
      "witness.objectFormat": {
        ...baseline,
        witnessStores: [{ ...baseline.witnessStores[0]!, objectFormat: "sha256" }, baseline.witnessStores[1]!],
      },
      "witness.shallow": {
        ...baseline,
        witnessStores: [{ ...baseline.witnessStores[0]!, shallow: "true" }, baseline.witnessStores[1]!],
      },
      "witness.alternatesContent": {
        ...baseline,
        witnessStores: [
          { ...baseline.witnessStores[0]!, alternatesContent: "/tmp/alt/objects\n" },
          baseline.witnessStores[1]!,
        ],
      },
      "witness.refs": {
        ...baseline,
        witnessStores: [
          {
            ...baseline.witnessStores[0]!,
            refs: ["refs/heads/main\t" + "3".repeat(40) + "\tcommit"],
          },
          baseline.witnessStores[1]!,
        ],
      },
      "component.head": {
        ...baseline,
        components: [{ ...baseline.components[0]!, head: "4".repeat(40) }],
      },
      "component.refs": {
        ...baseline,
        components: [{ ...baseline.components[0]!, refs: ["refs/heads/task\t" + "4".repeat(40) + "\t"] }],
      },
      "component.reflogs": {
        ...baseline,
        components: [{ ...baseline.components[0]!, reflogs: [{ path: "logs/HEAD", sha256: "d".repeat(64) }] }],
      },
      "component.pseudoRefs": {
        ...baseline,
        components: [{ ...baseline.components[0]!, pseudoRefs: [{ name: "ORIG_HEAD", oids: ["5".repeat(40)] }] }],
      },
      "component.indexStat": {
        ...baseline,
        components: [{ ...baseline.components[0]!, indexStat: "256:100:100:42" }],
      },
      "component.alternatesContent": {
        ...baseline,
        components: [{ ...baseline.components[0]!, alternatesContent: "/tmp/comp-alt/objects\n" }],
      },
      "component.privateObjectStore": {
        ...baseline,
        components: [
          {
            ...baseline.components[0]!,
            privateObjectStore: {
              packs: ["pack-1.idx:1024", "pack-1.pack:4096"],
              looseObjects: ["ab/" + "c".repeat(38), "de/" + "f".repeat(38)],
            },
          },
        ],
      },
    }
    for (const spec of CUSTODY_FRESHNESS_INPUT_SPEC) {
      const nextHash = hashCustodyFreshnessMaterial(mutations[spec.input])
      expect(nextHash, `mutating ${spec.input} alone must change the freshness hash`).not.toBe(baseHash)
      expect(nextHash).toMatch(/^[0-9a-f]{64}$/u)
    }
  })

  it("attaches a component-scoped custody freshness fingerprint on blocked refusal, ignores W(C') advances in other primary components, and invalidates on W(C) or any candidate component change", async () => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-custody-freshness-noise-"))
    try {
      const fixture = createProductFixture(root)
      const product = fixture.product
      const target = join(root, "target")
      git(product, "worktree", "add", "--detach", target)
      git(target, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive")

      const store = createGitWorktreeStore({ repo: product, gitProcess: createLocalGitProcess() })
      const policy = { primaryRoot: product, targetBranch: "release" } as const
      const initialFull = await store.inspectComponentCustodyFreshness(target, policy, { component: "." })
      expect(initialFull.status).toBe("ok")
      if (initialFull.status !== "ok") throw new Error("expected initial full freshness ok")

      const result = await superWorktreeRemove({
        repo: product,
        path: target,
        retain: join(root, "retained"),
        componentCustody: policy,
      })

      expect(result.state).toBe("unchanged")
      expect(result.reason).toBe("component-custody")
      expect(result.custody).toMatchObject({
        status: "blocked",
        component: "packages/alpha",
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
      })
      const blockedFingerprint = result.custody!.fingerprint!
      // (4) A "." refusal hashes the full witness set, whereas a blocked refusal on packages/alpha hashes only W(packages/alpha).
      expect(blockedFingerprint).not.toBe(initialFull.fingerprint)

      // Noise in primaryRoot and primary submodule: unrelated commit + unrelated branch/tag updates.
      const productHead = git(product, "rev-parse", "HEAD")
      const productTree = git(product, "rev-parse", "HEAD^{tree}")
      const noiseCommit = git(product, "commit-tree", productTree, "-p", productHead, "-m", "unrelated primary commit")
      git(product, "update-ref", "refs/heads/unrelated-noise", noiseCommit)
      git(product, "update-ref", "refs/tags/unrelated-tag", noiseCommit)
      const alphaPrimary = join(product, "packages/alpha")
      const alphaHead = git(alphaPrimary, "rev-parse", "HEAD")
      const alphaTree = git(alphaPrimary, "rev-parse", "HEAD^{tree}")
      const alphaNoise = git(alphaPrimary, "commit-tree", alphaTree, "-p", alphaHead, "-m", "unrelated alpha commit")
      git(alphaPrimary, "update-ref", "refs/heads/unrelated-alpha", alphaNoise)

      const afterNoise = await store.inspectComponentCustodyFreshness(target, policy, {
        component: "packages/alpha",
      })
      expect(afterNoise).toEqual({ status: "ok", fingerprint: blockedFingerprint })

      // (1) Blocked on C ("packages/alpha"), a target-branch or pin advance in W(C') ("vendor/beta")
      // leaves the C-scoped fingerprint unchanged while the full "." fingerprint changes.
      const betaPrimary = join(product, "vendor/beta")
      const betaHead = git(betaPrimary, "rev-parse", "HEAD")
      const betaTree = git(betaPrimary, "rev-parse", "HEAD^{tree}")
      const betaAdvance = git(betaPrimary, "commit-tree", betaTree, "-p", betaHead, "-m", "advance vendor/beta release")
      git(betaPrimary, "update-ref", "refs/heads/release", betaAdvance)
      git(betaPrimary, "update-ref", "refs/remotes/origin/release", betaAdvance)
      git(betaPrimary, "update-ref", `refs/yrd/pins/${betaAdvance}`, betaAdvance)

      const afterBetaWitnessAdvanceScoped = await store.inspectComponentCustodyFreshness(target, policy, {
        component: "packages/alpha",
      })
      expect(afterBetaWitnessAdvanceScoped).toEqual({ status: "ok", fingerprint: blockedFingerprint })

      const afterBetaWitnessAdvanceFull = await store.inspectComponentCustodyFreshness(target, policy, {
        component: ".",
      })
      expect(afterBetaWitnessAdvanceFull.status).toBe("ok")
      if (afterBetaWitnessAdvanceFull.status === "ok") {
        expect(afterBetaWitnessAdvanceFull.fingerprint).not.toBe(initialFull.fingerprint)
      }

      // (3) Any candidate component's head/ref/reflog change in target — including in C' ("vendor/beta") —
      // changes the C-scoped fingerprint.
      const betaTarget = join(target, "vendor/beta")
      git(betaTarget, "update-ref", "refs/heads/local-beta-wip", betaHead)
      const afterBetaComponentRefChange = await store.inspectComponentCustodyFreshness(target, policy, {
        component: "packages/alpha",
      })
      expect(afterBetaComponentRefChange.status).toBe("ok")
      if (afterBetaComponentRefChange.status !== "ok") throw new Error("expected freshness ok after C' ref change")
      expect(afterBetaComponentRefChange.fingerprint).not.toBe(blockedFingerprint)

      // (2) Publishing the target branch in W(C) ("packages/alpha") changes the C-scoped fingerprint again.
      git(alphaPrimary, "update-ref", "refs/heads/release", alphaHead)
      const afterAlphaPublish = await store.inspectComponentCustodyFreshness(target, policy, {
        component: "packages/alpha",
      })
      expect(afterAlphaPublish.status).toBe("ok")
      if (afterAlphaPublish.status === "ok") {
        expect(afterAlphaPublish.fingerprint).not.toBe(afterBetaComponentRefChange.fingerprint)
      }
    } finally {
      // raw-delete-allow: this isolated mkdtemp fixture owns every path beneath root
      await rm(root, { recursive: true, force: true })
    }
  })

  it("reports unknown without a fingerprint when component freshness changes during proof", async () => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-custody-freshness-prepost-"))
    try {
      const fixture = createProductFixture(root)
      const product = fixture.product
      const target = join(root, "target")
      git(product, "worktree", "add", "--detach", target)
      git(target, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive")
      const alphaTarget = join(target, "packages/alpha")
      const alphaGitDir = git(alphaTarget, "rev-parse", "--absolute-git-dir")
      const alphaHead = git(alphaTarget, "rev-parse", "HEAD")
      const baselineOutcome = await createGitWorktreeStore({
        repo: product,
        gitProcess: createLocalGitProcess(),
      }).remove(target, {
        retention: { root: join(root, "retained"), report: () => undefined },
        componentCustody: { primaryRoot: product, targetBranch: "release" },
      })
      expect(baselineOutcome).toMatchObject({
        custodyRefusal: {
          status: "blocked",
          component: "packages/alpha",
          fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
        },
      })
      let mutatedDuringProof = false
      const local = createLocalGitProcess()
      const localStream = local.stream!
      const store = createGitWorktreeStore({
        repo: product,
        gitProcess: {
          run: local.run,
          stream: (request) => {
            if (!mutatedDuringProof && request.args.includes("fsck")) {
              writeFileSync(join(alphaGitDir, "ORIG_HEAD"), `${alphaHead}\n`)
              mutatedDuringProof = true
            }
            return localStream(request)
          },
        },
      })

      const outcome = await store.remove(target, {
        retention: { root: join(root, "retained"), report: () => undefined },
        componentCustody: { primaryRoot: product, targetBranch: "release" },
      })

      expect(mutatedDuringProof).toBe(true)
      expect(outcome).toMatchObject({
        custodyRefusal: { status: "unknown", component: "packages/alpha" },
      })
      if (outcome !== undefined && "custodyRefusal" in outcome) {
        expect(outcome.custodyRefusal.fingerprint).toBeUndefined()
      }
    } finally {
      // raw-delete-allow: this isolated mkdtemp fixture owns every path beneath root
      await rm(root, { recursive: true, force: true })
    }
  })

  it("returns status unknown from inspectComponentCustodyFreshness when an expected input is unreadable", async () => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-custody-freshness-unknown-"))
    try {
      const fixture = createProductFixture(root)
      const product = fixture.product
      const target = join(root, "target")
      git(product, "worktree", "add", "--detach", target)
      git(target, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive")
      const alphaTarget = join(target, "packages/alpha")
      const alphaGitDir = git(alphaTarget, "rev-parse", "--absolute-git-dir")
      writeFileSync(join(alphaGitDir, "logs", "HEAD"), "corrupt-reflog-line\n")

      const store = createGitWorktreeStore({ repo: product, gitProcess: createLocalGitProcess() })
      const freshness = await store.inspectComponentCustodyFreshness(target, {
        primaryRoot: product,
        targetBranch: "main",
      })

      expect(freshness).toMatchObject({
        status: "unknown",
        source: expect.stringContaining("reflog"),
        detail: expect.stringContaining("malformed reflog record"),
      })
      expect("fingerprint" in freshness).toBe(false)
    } finally {
      // raw-delete-allow: this isolated mkdtemp fixture owns every path beneath root
      await rm(root, { recursive: true, force: true })
    }
  })
})
