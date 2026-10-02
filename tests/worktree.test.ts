/**
 * @failure Worktree mutations can escape the shared repository lock or accept ambiguous process authority.
 * @level l1
 * @consumer Yrd worktree and deployment stores
 * @reach fs-walk <fixture-only: worktree stores and retention checks read isolated mkdtemp Git repositories>
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { acquireExclusive, DEFAULT_MUTATION_LOCK_WAIT_MS } from "../src/exclusive.ts"
import {
  createGitWorktreeStore,
  createLocalGitWorktreeStore,
  runLocalGitWorktreeMutationSync,
  type GitWorktreeStoreOptions,
} from "../src/worktree.ts"
import { rehomeBorrowers, type WorktreeRemovalProof } from "../src/worktree-removal.ts"
import type { GitProcessRequest } from "../src/process.ts"
import { canonicalTmpdir, createProductFixture, createRepository } from "./fixture.ts"
import { runCli } from "../src/cli.ts"
import { discoverRepository } from "../src/push.ts"
import { createLocalGitProcess } from "../src/process.ts"

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>()
  return { ...fs, readdirSync: vi.fn(fs.readdirSync), readFileSync: vi.fn(fs.readFileSync) }
})

function git(repo: string, args: readonly string[]): string {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`)
  return result.stdout
}

async function addAlphaWorktree(store: ReturnType<typeof createLocalGitWorktreeStore>, root: string, name: string) {
  const linked = join(root, name)
  await store.add({ kind: "detached", path: linked, ref: "HEAD" })
  git(linked, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "packages/alpha"])
  const moduleDir = git(join(linked, "packages/alpha"), ["rev-parse", "--absolute-git-dir"]).trim()
  return { linked, moduleDir, objects: join(moduleDir, "objects") }
}

async function linkObjects(moduleDir: string, target: string, relativeLink = false) {
  const objects = join(moduleDir, "objects")
  await rm(objects, { recursive: true, force: true })
  const declaration = relativeLink ? relative(moduleDir, target) : target
  await symlink(declaration, objects, "dir")
  return declaration
}

function objectStoreSnapshot(objects: string) {
  return readdirSync(objects, { recursive: true, withFileTypes: true })
    .map((entry) => ({
      path: relative(objects, join(entry.parentPath, entry.name)),
      kind: entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other",
      bytes: entry.isFile() ? readFileSync(join(entry.parentPath, entry.name)) : null,
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

describe("createGitWorktreeStore", () => {
  /**
   * @failure Caller inspection admits a private checkout that removal refuses, or changes Git state before admission (27058).
   * @level l1
   * @consumer Bearly worktree admission and Git-super removal
   * @testonly none
   */
  // Removal-only tests cannot prove a read-only caller preflight or matching refusal diagnostics.
  it.each(["empty", "uninitialized-public", "nonempty", "symlink", "unsafe-ancestor", "retained-borrower"] as const)(
    "shares inspection and removal admission for private %s checkout",
    async (kind) => {
      const root = await mkdtemp(join(canonicalTmpdir(), "git-super-removal-inspection-"))
      try {
        const repo = join(root, "product")
        const component = join(root, "component")
        createRepository(repo, "root.txt", "root\n")
        createRepository(component, "component.txt", "component\n")
        const excluded = "vendor/private"
        git(repo, [
          "-c",
          "protocol.file.allow=always",
          "submodule",
          "add",
          "--name",
          "private-store",
          component,
          excluded,
        ])
        if (kind === "uninitialized-public") {
          git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", component, "vendor/public"])
        }
        git(repo, ["commit", "-q", "-am", "add private fixture"])
        const linked = join(root, "linked")
        // Native fixture preparation creates no mechanics writer lock; inspection must not create one either.
        git(repo, ["worktree", "add", "--detach", linked, "HEAD"])
        const checkout = join(linked, excluded)
        if (kind === "nonempty") await writeFile(join(checkout, "keep.txt"), "keep\n")
        if (kind === "symlink") {
          await rm(checkout, { recursive: true })
          await symlink(component, checkout, "dir")
        }
        if (kind === "unsafe-ancestor") {
          await rm(join(linked, "vendor"), { recursive: true })
          await symlink(component, join(linked, "vendor"), "dir")
        }
        const common = git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim()
        if (kind === "retained-borrower") {
          await writeFile(join(common, "git-super-retained-borrowers"), "unresolved fixture\n")
        }
        const directory = git(linked, ["rev-parse", "--absolute-git-dir"]).trim()
        const storeBefore = objectStoreSnapshot(common)
        const registration = git(repo, ["worktree", "list", "--porcelain"])
        const local = createLocalGitProcess()
        const requests: GitProcessRequest[] = []
        const store = createGitWorktreeStore({
          repo,
          gitProcess: {
            run(request) {
              requests.push(request)
              if (request.repo === checkout || request.repo.startsWith(`${checkout}/`)) {
                throw new Error(`private checkout was probed: ${request.repo}`)
              }
              return local.run(request)
            },
          },
        })
        const selection = { excludedSubmodules: [excluded] }
        const inspection = await store.inspectRemoval(linked, selection).then(
          (result) => ({ result, error: undefined }),
          (error: unknown) => ({ result: undefined, error }),
        )
        expect(objectStoreSnapshot(common)).toEqual(storeBefore)
        expect(existsSync(join(directory, "yrd-worktree-mutations"))).toBe(false)
        expect(existsSync(join(common, "yrd-worktree-mutations"))).toBe(false)
        expect(git(repo, ["worktree", "list", "--porcelain"])).toBe(registration)
        expect(
          requests.every((request) => !request.args.includes("worktree") && !request.args.includes("repack")),
        ).toBe(true)
        const removal = await store.remove(linked, selection).then(
          () => undefined,
          (error: unknown) => error,
        )
        if (kind === "empty" || kind === "uninitialized-public") {
          expect(inspection.error).toBeUndefined()
          expect(inspection.result?.consultedRepositories).toEqual([{ path: ".", root: linked }])
          expect(inspection.result?.notCompared).toContainEqual({
            path: excluded,
            reason: "excluded",
            message: expect.stringContaining("nothing to preserve in the checkout"),
          })
          expect(inspection.result?.uninitializedSubmodules).toEqual(
            kind === "uninitialized-public" ? ["vendor/public"] : [],
          )
          expect(removal).toBeUndefined()
          expect(existsSync(linked)).toBe(false)
        } else {
          expect(inspection.error).toBeInstanceOf(Error)
          expect(removal).toBeInstanceOf(Error)
          expect((removal as Error).message).toBe((inspection.error as Error).message)
          expect(existsSync(linked)).toBe(true)
        }
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  /**
   * @failure The removal CLI drops the shared exclusion or omits named preserved-store observations (27058 AC3/AC5).
   * @level l1
   * @consumer git-super worktree remove CLI and JSON readers
   * @testonly none
   */
  // Engine-only removal cannot prove command parsing, forwarding or the operator-facing receipt.
  it.each([false, true])("routes removal exclusions and names the untouched store; json=%s", async (json) => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-private-remove-cli-"))
    try {
      const fixture = createProductFixture(root)
      const excluded = "vendor/private"
      const name = "sensitive-store"
      git(fixture.product, [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "--name",
        name,
        "-q",
        fixture.alpha,
        excluded,
      ])
      git(fixture.product, ["commit", "-q", "-m", "add fixture private component"])
      const privateStore = git(fixture.product, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        `modules/${name}`,
      ]).trim()
      const before = objectStoreSnapshot(privateStore)
      const linked = join(root, "linked")
      await createLocalGitWorktreeStore({ repo: fixture.product }).add({
        kind: "detached",
        path: linked,
        ref: "HEAD",
      })
      let stdout = ""
      let stderr = ""
      const code = await runCli(
        [
          "--repo",
          fixture.product,
          ...(json ? ["--json"] : []),
          "worktree",
          "remove",
          linked,
          "--retain",
          join(root, "retained"),
          "--exclude-submodule",
          excluded,
          "--exclude-submodule",
          excluded,
        ],
        {
          write: (text) => {
            stdout += text
          },
        },
        {
          write: (text) => {
            stderr += text
          },
        },
      )
      expect(code).toBe(0)
      expect(existsSync(linked)).toBe(false)
      expect(objectStoreSnapshot(privateStore)).toEqual(before)
      expect(stderr).toContain(excluded)
      expect(stderr).toContain(privateStore)
      expect(stderr).toMatch(/preserved.*untouched|untouched.*preserv/u)
      if (json) {
        const result = JSON.parse(stdout) as {
          state: string
          notCompared: Array<{ path: string; reason: string; message: string }>
          proof: { notCompared: unknown }
        }
        expect(result.state).toBe("updated")
        expect(result.notCompared).toContainEqual({
          path: excluded,
          reason: "excluded",
          message: expect.stringContaining(privateStore),
        })
        expect(result.proof.notCompared).toEqual(result.notCompared)
      } else {
        expect(stdout).toContain("updated")
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  /**
   * @failure Removal walks private stores in surviving common custody despite an empty excluded checkout (27058 AC3/AC5).
   * @level l1
   * @consumer git-super retained worktree removal
   * @testonly none
   */
  // In-deletion refusal cannot prove the distinct success case or detect a forbidden recursive parent enumeration.
  it("leaves an excluded common store untouched and never enumerates it during removal", async () => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-private-common-custody-"))
    try {
      const fixture = createProductFixture(root)
      const excluded = "vendor/private"
      const name = "sensitive-store"
      git(fixture.product, [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "--name",
        name,
        "-q",
        fixture.alpha,
        excluded,
      ])
      git(fixture.product, ["commit", "-q", "-m", "add fixture private component"])
      const privateStore = git(fixture.product, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        `modules/${name}`,
      ]).trim()
      const before = objectStoreSnapshot(privateStore)
      const store = createLocalGitWorktreeStore({ repo: fixture.product })
      const linked = join(root, "linked")
      await store.add({ kind: "detached", path: linked, ref: "HEAD" })
      expect(readdirSync(join(linked, excluded))).toEqual([])
      const proofs: WorktreeRemovalProof[] = []
      const options = {
        excludedSubmodules: [excluded],
        retention: {
          root: join(root, "retained"),
          report: (proof: WorktreeRemovalProof) => {
            proofs.push(proof)
          },
        },
      }
      vi.mocked(readdirSync).mockClear()
      vi.mocked(readFileSync).mockClear()
      await store.remove(linked, options)
      const privateQueries = [
        ...vi
          .mocked(readFileSync)
          .mock.calls.filter(([path]) => String(path) === privateStore || String(path).startsWith(`${privateStore}/`)),
        ...vi.mocked(readdirSync).mock.calls.filter(([path, options]) => {
          const queried = String(path)
          const recursive =
            typeof options === "object" && options !== null && "recursive" in options && options.recursive === true
          return (
            queried === privateStore ||
            queried.startsWith(`${privateStore}/`) ||
            (recursive && privateStore.startsWith(`${queried}/`))
          )
        }),
      ]
      expect(privateQueries).toEqual([])
      expect(existsSync(linked)).toBe(false)
      expect(objectStoreSnapshot(privateStore)).toEqual(before)
      expect(proofs).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  /**
   * @failure Excluded empty checkout hides a private Git store that native removal deletes or retention reads/copies (27058 AC3/AC5).
   * @level l1
   * @consumer git-super worktree removal
   * @testonly none
   */
  // Public retention tests authorize hashing/copying; empty-checkout tests do not carry a private owned store.
  it.each([false, true])(
    "refuses an excluded store inside deletion custody before touching it; retain=%s",
    async (retain) => {
      const root = await mkdtemp(join(canonicalTmpdir(), "git-super-private-removal-custody-"))
      try {
        const fixture = createProductFixture(root)
        const excluded = "vendor/private"
        const name = "sensitive-store"
        git(fixture.product, [
          "-c",
          "protocol.file.allow=always",
          "submodule",
          "add",
          "--name",
          name,
          "-q",
          fixture.alpha,
          excluded,
        ])
        git(fixture.product, ["commit", "-q", "-m", "add fixture private component"])
        const linked = join(root, "linked")
        const privateCheckout = join(linked, excluded)
        const requests: GitProcessRequest[] = []
        const local = createLocalGitProcess()
        const store = createGitWorktreeStore({
          repo: fixture.product,
          gitProcess: {
            run(request) {
              if (request.repo === privateCheckout || request.repo.startsWith(`${privateCheckout}/`)) {
                requests.push(request)
                throw new Error(`private checkout was probed: ${request.repo}`)
              }
              return local.run(request)
            },
          },
        })
        await store.add({ kind: "detached", path: linked, ref: "HEAD" })
        // Fixture preparation may initialize its own data; the exclusion boundary starts at removal below.
        git(linked, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", excluded])
        const privateStore = git(linked, [
          "rev-parse",
          "--path-format=absolute",
          "--git-path",
          `modules/${name}`,
        ]).trim()
        expect(git(privateCheckout, ["rev-parse", "--absolute-git-dir"]).trim()).toBe(privateStore)
        git(linked, ["submodule", "deinit", "-f", "--", excluded])
        expect(readdirSync(privateCheckout)).toEqual([])
        const lease = join(privateStore, "yrd-worktree-mutations", "writer.lock")
        expect(existsSync(lease)).toBe(false)
        const retained = join(root, "retained")
        const options = {
          excludedSubmodules: [excluded],
          ...(retain ? { retention: { root: retained, report: () => {} } } : {}),
        }
        const failure = await store.remove(linked, options).then(
          () => undefined,
          (error: unknown) => error,
        )
        expect(failure).toBeInstanceOf(Error)
        expect((failure as Error).message).toContain(excluded)
        expect((failure as Error).message).toContain(privateStore)
        expect((failure as Error).message).toMatch(/custody|deletion/u)
        expect(requests).toEqual([])
        expect(existsSync(linked)).toBe(true)
        expect(readdirSync(privateCheckout)).toEqual([])
        expect(existsSync(privateStore)).toBe(true)
        expect(existsSync(lease)).toBe(false)
        expect(existsSync(retained)).toBe(false)
        expect(git(fixture.product, ["worktree", "list", "--porcelain"])).toContain(linked)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  /**
   * @failure Retained removal rejects a shared objects symlink or follows it and changes another store (26270).
   * @level l1
   * @consumer git-super worktree remove --retain
   * @testonly none
   */
  // AC: retain a same-common surviving objects link, including relative declarations.
  // Regular-file retention and alternates tests cannot prove link relocation or retained HEAD/index lookup.
  it.each([false, true])(
    "retains an objects symlink without touching its target; relative=%s",
    async (relativeLink) => {
      const root = await mkdtemp(join(canonicalTmpdir(), "git-super-linked-objects-"))
      try {
        const fixture = createProductFixture(root)
        const store = createLocalGitWorktreeStore({ repo: fixture.product })
        const owner = await addAlphaWorktree(store, root, "owner")
        const borrower = await addAlphaWorktree(store, root, "borrower")
        const declaration = await linkObjects(borrower.moduleDir, owner.objects, relativeLink)
        const targetBefore = objectStoreSnapshot(owner.objects)
        const headBefore = await readFile(join(borrower.moduleDir, "HEAD"))
        const indexBefore = await readFile(join(borrower.moduleDir, "index"))
        const proofs: WorktreeRemovalProof[] = []
        await store.remove(borrower.linked, {
          retention: { root: join(root, "retained"), report: (proof) => proofs.push(proof) },
        })
        expect(existsSync(borrower.linked)).toBe(false)
        expect(git(fixture.product, ["worktree", "list", "--porcelain"])).not.toContain(borrower.linked)
        expect(proofs).toHaveLength(1)
        const proof = proofs[0]!
        const retained = join(proof.retained!, "packages/alpha")
        expect(await readlink(join(retained, "objects"))).toBe(owner.objects)
        expect(await readFile(join(retained, "HEAD"))).toEqual(headBefore)
        expect(await readFile(join(retained, "index"))).toEqual(indexBefore)
        // Retained config bytes keep the original checkout path; recovery supplies its own workspace.
        expect(git(root, ["--git-dir", retained, "--work-tree", root, "rev-parse", "HEAD"]).trim()).toBe(
          fixture.alphaBase,
        )
        expect(git(root, ["--git-dir", retained, "--work-tree", root, "show", ":alpha.ts"])).toBe(
          "export const alpha = 1\n",
        )
        const manifest = JSON.parse(await readFile(proof.manifest, "utf8")) as {
          externalObjectStores: readonly { path: string; declaration: string; target: string }[]
        }
        expect(manifest.externalObjectStores).toEqual([
          { path: "packages/alpha/objects", declaration, target: owner.objects },
        ])
        expect(objectStoreSnapshot(owner.objects)).toEqual(targetBefore)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  /**
   * @failure An objects link makes removal skip dirty payload instead of preserving its registered checkout (26270).
   * @level l1
   * @consumer git-super worktree remove --retain
   * @testonly none
   */
  // AC: dirt must refuse independently of the positive retention path; ordinary metadata fixtures have no objects link.
  it("refuses a dirty objects-link worktree and keeps its payload", async () => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-dirty-linked-objects-"))
    try {
      const fixture = createProductFixture(root)
      const store = createLocalGitWorktreeStore({ repo: fixture.product })
      const owner = await addAlphaWorktree(store, root, "owner")
      const borrower = await addAlphaWorktree(store, root, "borrower")
      await linkObjects(borrower.moduleDir, owner.objects)
      const targetBefore = objectStoreSnapshot(owner.objects)
      await writeFile(join(borrower.linked, "packages/alpha/keep.txt"), "keep this change\n")
      await expect(
        store.remove(borrower.linked, { retention: { root: join(root, "retained"), report: () => {} } }),
      ).rejects.toThrow("packages/alpha/keep.txt")
      expect(await readFile(join(borrower.linked, "packages/alpha/keep.txt"), "utf8")).toBe("keep this change\n")
      expect(git(fixture.product, ["worktree", "list", "--porcelain"])).toContain(borrower.linked)
      expect(objectStoreSnapshot(owner.objects)).toEqual(targetBefore)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  /**
   * @failure An unsafe objects link permits deletion of its target or silently retains an unusable store (26270).
   * @level l1
   * @consumer git-super worktree remove --retain
   * @testonly none
   */
  // AC: both native removal paths, missing targets and targets outside root common custody refuse by name.
  // Existing metadata tests reject arbitrary files, not working or dangling objects links.
  it.each(["checkout", "gitdir", "missing", "outside-common"] as const)(
    "refuses an unsafe objects link; target=%s",
    async (kind) => {
      const root = await mkdtemp(join(canonicalTmpdir(), "git-super-unsafe-linked-objects-"))
      try {
        const fixture = createProductFixture(root)
        const store = createLocalGitWorktreeStore({ repo: fixture.product })
        const borrower = await addAlphaWorktree(store, root, "borrower")
        let target: string
        if (kind === "checkout" || kind === "gitdir") {
          target =
            kind === "checkout" ? join(borrower.linked, "ignored-objects") : join(borrower.moduleDir, "own-objects")
          if (kind === "checkout") {
            const common = git(fixture.product, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim()
            await writeFile(join(common, "info/exclude"), "ignored-objects/\n")
          }
          await rename(borrower.objects, target)
          await symlink(target, borrower.objects, "dir")
        } else {
          target =
            kind === "missing" ? join(borrower.moduleDir, "missing-objects") : join(fixture.alpha, ".git/objects")
          await linkObjects(borrower.moduleDir, target)
        }
        if (kind !== "missing") {
          expect(git(join(borrower.linked, "packages/alpha"), ["rev-parse", "HEAD"]).trim()).toBe(fixture.alphaBase)
        }
        const failure = await store
          .remove(borrower.linked, { retention: { root: join(root, "retained"), report: () => {} } })
          .then(
            () => undefined,
            (error: unknown) => error,
          )
        expect(failure).toBeInstanceOf(Error)
        expect((failure as Error).message).toContain(borrower.objects)
        expect((failure as Error).message).toContain(target)
        expect(existsSync(borrower.linked)).toBe(true)
        expect(git(fixture.product, ["worktree", "list", "--porcelain"])).toContain(borrower.linked)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  /**
   * @failure A store owner is removed while a retained copy still points at it, or a stale dependency never releases it (26270).
   * @level l1
   * @consumer git-super retained object-store custody
   * @testonly none
   */
  // AC: live and retained objects links protect an owner; unknown registry data refuses, gone/repointed copies release it loudly.
  // Alternates rehoming cannot see live objects symlinks or retained copies.
  it.each(["gone", "repointed"] as const)(
    "protects an objects owner until its retained borrower is resolved; resolution=%s",
    async (resolution) => {
      const root = await mkdtemp(join(canonicalTmpdir(), "git-super-retained-object-custody-"))
      try {
        const fixture = createProductFixture(root)
        const store = createLocalGitWorktreeStore({ repo: fixture.product })
        const owner = await addAlphaWorktree(store, root, "owner")
        const borrower = await addAlphaWorktree(store, root, "borrower")
        await linkObjects(borrower.moduleDir, owner.objects)
        const targetBefore = objectStoreSnapshot(owner.objects)
        const proofs: WorktreeRemovalProof[] = []
        const retention = { root: join(root, "retained"), report: (proof: WorktreeRemovalProof) => proofs.push(proof) }
        await expect(store.remove(owner.linked, { retention })).rejects.toThrow(borrower.linked)
        expect(existsSync(owner.linked)).toBe(true)
        expect(git(fixture.product, ["worktree", "list", "--porcelain"])).toContain(owner.linked)
        expect(git(join(borrower.linked, "packages/alpha"), ["rev-parse", "HEAD"]).trim()).toBe(fixture.alphaBase)
        expect(git(join(borrower.linked, "packages/alpha"), ["show", ":alpha.ts"])).toBe("export const alpha = 1\n")
        expect(objectStoreSnapshot(owner.objects)).toEqual(targetBefore)
        // An unresolvable live dependency must refuse by name instead of looking independent.
        await linkObjects(borrower.moduleDir, join(fixture.product, ".git/missing-objects"))
        const unknownLive = await store.remove(owner.linked, { retention }).then(
          () => undefined,
          (error: unknown) => error,
        )
        expect(unknownLive).toBeInstanceOf(Error)
        expect((unknownLive as Error).message).toContain(borrower.linked)
        expect((unknownLive as Error).message).toContain(borrower.objects)
        expect(existsSync(owner.linked)).toBe(true)
        await linkObjects(borrower.moduleDir, owner.objects)
        await store.remove(borrower.linked, { retention })
        const proof = proofs[0]!
        await expect(store.remove(owner.linked, { retention })).rejects.toThrow(proof.retained!)
        expect(existsSync(owner.linked)).toBe(true)
        expect(objectStoreSnapshot(owner.objects)).toEqual(targetBefore)
        const common = git(fixture.product, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim()
        const registry = join(common, "git-super-retained-borrowers")
        const entry = join(registry, readdirSync(registry)[0]!)
        if (resolution === "gone") {
          const registered = await readFile(entry)
          await writeFile(entry, "unknown registry bytes\n")
          await expect(store.remove(owner.linked, { retention })).rejects.toThrow(entry)
          expect(existsSync(owner.linked)).toBe(true)
          await writeFile(entry, registered)
          await rm(dirname(proof.manifest), { recursive: true, force: true })
        } else {
          const replacement = join(common, "modules/packages/alpha/objects")
          await rm(join(proof.retained!, "packages/alpha/objects"))
          await symlink(replacement, join(proof.retained!, "packages/alpha/objects"), "dir")
        }
        const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
        try {
          await store.remove(owner.linked, { retention })
          expect(stderr.mock.calls.map(([line]) => String(line)).join("")).toContain(proof.retained!)
        } finally {
          stderr.mockRestore()
        }
        expect(existsSync(owner.linked)).toBe(false)
        expect(existsSync(entry)).toBe(false)
        expect(git(fixture.product, ["worktree", "list", "--porcelain"])).not.toContain(owner.linked)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  /**
   * @failure Repointing a retained objects link to another linked owner drops its custody record and permits that owner's deletion (26270).
   * @level l1
   * @consumer git-super retained object-store custody
   * @testonly none
   */
  // AC: custody follows the actual retained link between linked owners, even after the original owner is removed.
  // Gone/primary-target stale rows cannot detect a dependency transferred to a second removable store.
  it("keeps retained objects custody after repointing to another linked owner", async () => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-repointed-object-custody-"))
    try {
      const fixture = createProductFixture(root)
      const store = createLocalGitWorktreeStore({ repo: fixture.product })
      const owner = await addAlphaWorktree(store, root, "owner")
      const nextOwner = await addAlphaWorktree(store, root, "next-owner")
      const borrower = await addAlphaWorktree(store, root, "borrower")
      await linkObjects(borrower.moduleDir, owner.objects)
      const nextTargetBefore = objectStoreSnapshot(nextOwner.objects)
      const proofs: WorktreeRemovalProof[] = []
      const retention = { root: join(root, "retained"), report: (proof: WorktreeRemovalProof) => proofs.push(proof) }
      await store.remove(borrower.linked, { retention })
      const proof = proofs[0]!
      const retained = join(proof.retained!, "packages/alpha")
      await rm(join(retained, "objects"))
      await symlink(nextOwner.objects, join(retained, "objects"), "dir")
      const common = git(fixture.product, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim()
      const registry = join(common, "git-super-retained-borrowers")
      const entry = join(registry, readdirSync(registry)[0]!)
      await store.remove(owner.linked, { retention })
      expect(existsSync(owner.linked)).toBe(false)
      expect(existsSync(entry)).toBe(true)
      expect(JSON.parse(await readFile(entry, "utf8"))).toMatchObject({
        retained: proof.retained,
        manifest: proof.manifest,
      })
      await expect(store.remove(nextOwner.linked, { retention })).rejects.toThrow(proof.retained!)
      expect(existsSync(nextOwner.linked)).toBe(true)
      expect(git(fixture.product, ["worktree", "list", "--porcelain"])).toContain(nextOwner.linked)
      expect(await readlink(join(retained, "objects"))).toBe(nextOwner.objects)
      expect(git(root, ["--git-dir", retained, "--work-tree", root, "rev-parse", "HEAD"]).trim()).toBe(
        fixture.alphaBase,
      )
      expect(git(root, ["--git-dir", retained, "--work-tree", root, "show", ":alpha.ts"])).toBe(
        "export const alpha = 1\n",
      )
      expect(objectStoreSnapshot(nextOwner.objects)).toEqual(nextTargetBefore)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  /**
   * @failure Concurrent retained removals overwrite dependency registrations and permit their shared owner's deletion (26270).
   * @level l1
   * @consumer git-super retained object-store custody
   * @testonly none
   */
  // AC: both concurrent retains remain registered and both block owner removal; existing lock tests have no custody records.
  it("keeps both concurrent retained objects borrowers registered", async () => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-concurrent-object-custody-"))
    try {
      const fixture = createProductFixture(root)
      const store = createLocalGitWorktreeStore({ repo: fixture.product })
      const owner = await addAlphaWorktree(store, root, "owner")
      const borrowers = [
        await addAlphaWorktree(store, root, "borrower-a"),
        await addAlphaWorktree(store, root, "borrower-b"),
      ]
      for (const borrower of borrowers) await linkObjects(borrower.moduleDir, owner.objects)
      const proofs: WorktreeRemovalProof[] = []
      const retention = { root: join(root, "retained"), report: (proof: WorktreeRemovalProof) => proofs.push(proof) }
      await Promise.all(borrowers.map((borrower) => store.remove(borrower.linked, { retention })))
      expect(proofs).toHaveLength(2)
      const common = git(fixture.product, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim()
      const registry = join(common, "git-super-retained-borrowers")
      const entries = readdirSync(registry).map(
        (name) => JSON.parse(readFileSync(join(registry, name), "utf8")) as { retained: string },
      )
      expect(entries.map((entry) => entry.retained).sort()).toEqual(proofs.map((proof) => proof.retained).sort())
      for (const proof of proofs) {
        const retained = join(proof.retained!, "packages/alpha")
        expect(await readlink(join(retained, "objects"))).toBe(owner.objects)
        expect(git(root, ["--git-dir", retained, "--work-tree", root, "rev-parse", "HEAD"]).trim()).toBe(
          fixture.alphaBase,
        )
        expect(git(root, ["--git-dir", retained, "--work-tree", root, "show", ":alpha.ts"])).toBe(
          "export const alpha = 1\n",
        )
      }
      const failure = await store.remove(owner.linked, { retention }).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(failure).toBeInstanceOf(Error)
      const first = proofs.find((proof) => (failure as Error).message.includes(proof.retained!))
      expect(first, "owner refusal names one of the two registered retained copies").toBeDefined()
      const remaining = proofs.find((proof) => proof !== first)!
      await rm(dirname(first!.manifest), { recursive: true, force: true })
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
      try {
        await expect(store.remove(owner.linked, { retention })).rejects.toThrow(remaining.retained!)
      } finally {
        stderr.mockRestore()
      }
      expect(existsSync(owner.linked)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  /**
   * @failure Retained removal treats uncertain child checkouts as clean and deletes their checkout or adjacent root payload (26270).
   * @level l1
   * @consumer git-super worktree remove --retain
   * @testonly none
   */
  // AC: the removal caller must reject symlink checkouts and dangling child metadata, with or without root dirt.
  // Status-only unknown-state tests do not prove that the destructive caller observes the uncertainty.
  it.each(["symlink-checkout", "dangling-gitdir"] as const)(
    "preserves an uncertain child during retained removal; shape=%s",
    async (shape) => {
      const root = await mkdtemp(join(canonicalTmpdir(), "git-super-uncertain-retain-"))
      try {
        const fixture = createProductFixture(root)
        const store = createLocalGitWorktreeStore({ repo: fixture.product })
        const linked = await addAlphaWorktree(store, root, "linked")
        const child = join(linked.linked, "packages/alpha")
        const targetBefore = objectStoreSnapshot(fixture.alpha)
        if (shape === "symlink-checkout") {
          await rm(child, { recursive: true, force: true })
          await symlink(fixture.alpha, child, "dir")
        } else {
          await writeFile(join(child, ".git"), `gitdir: ${join(root, "missing-alpha-gitdir")}\n`)
        }
        const retention = { root: join(root, "retained"), report: () => {} }
        // Clean-root refusal prevents root dirt from masking a missing uncertainty guard.
        await expect(store.remove(linked.linked, { retention })).rejects.toThrow(child)
        expect(existsSync(linked.linked)).toBe(true)
        expect(git(fixture.product, ["worktree", "list", "--porcelain"])).toContain(linked.linked)
        await writeFile(join(linked.linked, "rootkeep.txt"), "keep root payload\n")
        await expect(store.remove(linked.linked, { retention })).rejects.toThrow(child)
        expect(await readFile(join(linked.linked, "rootkeep.txt"), "utf8")).toBe("keep root payload\n")
        expect(git(fixture.product, ["worktree", "list", "--porcelain"])).toContain(linked.linked)
        expect(objectStoreSnapshot(fixture.alpha)).toEqual(targetBefore)
        if (shape === "symlink-checkout") expect(await readlink(child)).toBe(fixture.alpha)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  /**
   * @failure Empty submodules are mistaken for the parent repo, blocking safe removal; hidden files or staged pins must not be discarded (26264).
   * @level l1
   * @consumer git-super status and worktree removal
   * @testonly none
   */
  it("reports never-checked-out submodules and removes only clean worktrees", async () => {
    const root = await mkdtemp(join(canonicalTmpdir(), "git-super-uninitialized-"))
    try {
      const fixture = createProductFixture(root)
      const alias = join(root, "aliased-product")
      await symlink(fixture.product, alias, "dir")
      // The shared guard must accept a checkout below a symlinked parent.
      expect(await discoverRepository(createLocalGitProcess(), join(alias, "packages/alpha"), "test", true)).toBe(
        join(fixture.product, "packages/alpha"),
      )
      const store = createLocalGitWorktreeStore({ repo: fixture.product })
      const linked = join(root, "clean")
      await store.add({ kind: "detached", path: linked, ref: "HEAD" })
      // Native add leaves gitlinks as empty directories. Never initialize them.
      expect(git(linked, ["submodule", "status"])).toContain(`-${fixture.alphaBase} packages/alpha`)
      const out = {
        output: "",
        write(value: string) {
          this.output += value
        },
      }
      const err = {
        output: "",
        write(value: string) {
          this.output += value
        },
      }
      expect(await runCli(["--repo", linked, "--json", "status"], out, err), err.output).toBe(0)
      expect(JSON.parse(out.output)).toMatchObject({
        records: [],
        uninitializedSubmodules: ["packages/alpha", "vendor/beta"],
        consultedRepositories: [{ path: ".", root: linked }],
      })
      out.output = ""
      err.output = ""
      expect(await runCli(["--repo", linked, "status"], out, err)).toBe(0)
      expect(out.output).toBe("")
      expect(err.output).toContain("packages/alpha: not checked out")
      expect(err.output).toContain("vendor/beta: not checked out")
      await store.remove(linked, { retention: { root: join(root, "retained"), report: () => {} } })
      expect(existsSync(linked)).toBe(false)
      expect(git(fixture.product, ["worktree", "list", "--porcelain"])).not.toContain(linked)

      for (const dirt of ["root", "staged-pin", "uninitialized-payload"]) {
        const dirty = join(root, dirt)
        await store.add({ kind: "detached", path: dirty, ref: "HEAD" })
        if (dirt === "root") await writeFile(join(dirty, "untracked.txt"), "keep me\n")
        else if (dirt === "staged-pin") {
          git(dirty, ["update-index", "--cacheinfo", `160000,${fixture.betaBase},packages/alpha`])
          out.output = ""
          err.output = ""
          expect(await runCli(["--repo", dirty, "--json", "status"], out, err), err.output).toBe(0)
          expect(JSON.parse(out.output)).toMatchObject({
            records: ["M  packages/alpha"],
            uninitializedSubmodules: ["packages/alpha", "vendor/beta"],
          })
        } else {
          // Git can hide ignored files in an uninitialized gitlink directory.
          await writeFile(join(dirty, "packages/alpha", ".gitignore"), "*\n")
          await writeFile(join(dirty, "packages/alpha", "private.txt"), "keep me\n")
        }
        await expect(
          store.remove(dirty, {
            retention: { root: join(root, "retained"), report: () => {} },
          }),
          dirt,
        ).rejects.toThrow(/dirty|not empty/u)
        expect(existsSync(dirty)).toBe(true)
        expect(git(fixture.product, ["worktree", "list", "--porcelain"])).toContain(dirty)
        if (dirt === "uninitialized-payload") {
          expect(await readFile(join(dirty, "packages/alpha", "private.txt"), "utf8")).toBe("keep me\n")
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  /**
   * @failure Tree materialization gives up after 30 s while a queue merge still holds the shared writer lock (25274).
   * @level l1
   * @consumer Yrd post-merge tree materialization
   */
  it("resolves a writer-lock wait of four minutes by default: under yrd's five-minute per-call cap with room for the add", () => {
    // The inequality against yrd's constant is pinned by the host's test; this is the value it relies on.
    expect(DEFAULT_MUTATION_LOCK_WAIT_MS).toBe(4 * 60_000)
  })

  it("waits for a merge holding the writer lock before adding a worktree, using the shared default wait", async () => {
    const root = await mkdtemp(join(tmpdir(), "git-super-worktree-writer-wait-"))
    const repo = join(root, "owner")
    const linked = join(root, "linked")
    git(root, ["init", "-q", "-b", "main", repo])
    git(repo, ["config", "user.email", "test@example.com"])
    git(repo, ["config", "user.name", "Test"])
    await writeFile(join(repo, "seed.txt"), "seed\n")
    git(repo, ["add", "seed.txt"])
    git(repo, ["commit", "-q", "-m", "seed"])

    const held = await acquireExclusive(
      join(repo, ".git", "yrd-worktree-mutations"),
      { timeoutMs: 0 },
      "git super merge",
    )
    // The lock remains real; advance only the reporter's clock past 30 seconds.
    // The old assertion saw its first line but missed a silent long wait (25274 slice 2).
    const release = Bun.sleep(1_500).then(() => held.release())
    const reports: string[] = []
    let operation: Promise<void> | undefined
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] })
    try {
      const store = createLocalGitWorktreeStore({
        repo,
        report: (line: string) => reports.push(line),
      })
      operation = store.add({ kind: "detached", path: linked, ref: "HEAD" })
      for (let poll = 0; poll < 100 && reports.length === 0; poll += 1) await Bun.sleep(10)
      expect(reports).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(31_000)
      expect(reports.length).toBeGreaterThanOrEqual(4)
      await operation
      expect(existsSync(linked)).toBe(true)
      for (const line of reports) {
        expect(line).toMatch(
          /^git-super worktree: waiting for writer lock held by git super merge \(pid:\d+, age \d+ms\)\n$/u,
        )
      }
    } finally {
      try {
        await release
        if (operation !== undefined) await Promise.allSettled([operation])
      } finally {
        vi.useRealTimers()
        await rm(root, { recursive: true, force: true })
      }
    }
  }, 30_000)

  it("uses the canonical GitProcess request internally", async () => {
    const repo = await mkdtemp(join(tmpdir(), "git-super-process-port-"))
    const requests: GitProcessRequest[] = []
    const store = createGitWorktreeStore({
      repo,
      gitProcess: {
        async run(request) {
          requests.push(request)
          if (request.args.includes("extensions.worktreeConfig")) {
            return { code: 1, stdout: "", stderr: "", timedOut: false }
          }
          return { code: 0, stdout: `${join(repo, ".git")}\n`, stderr: "", timedOut: false }
        },
      },
    })

    try {
      await store.ready()
      expect(requests.map(({ repo: requestRepo, args }) => ({ repo: requestRepo, args }))).toEqual([
        { repo, args: ["config", "--local", "--get", "--type=bool", "extensions.worktreeConfig"] },
        { repo, args: ["rev-parse", "--path-format=absolute", "--git-common-dir"] },
      ])
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it("checks the heal guards before locking and still takes the lock when repair is required", async () => {
    const repo = await mkdtemp(join(tmpdir(), "git-super-config-heal-lock-"))
    const commonDir = join(repo, ".git")
    const lockDirectory = join(commonDir, "yrd-worktree-mutations")
    const requests: GitProcessRequest[] = []
    const held = await acquireExclusive(lockDirectory, { timeoutMs: 0 }, "outer mutation")
    const store = createGitWorktreeStore({
      repo,
      timeouts: { mutationLock: 0 },
      gitProcess: {
        async run(request) {
          requests.push(request)
          if (request.args.includes("extensions.worktreeConfig") || request.args.includes("core.bare")) {
            return { code: 0, stdout: "true\n", stderr: "", timedOut: false }
          }
          return { code: 0, stdout: `${commonDir}\n`, stderr: "", timedOut: false }
        },
      },
    })

    const stderr = vi.spyOn(process.stderr, "write")
    try {
      await expect(store.ready()).rejects.toThrow(
        /timeout=0ms; holder=outer mutation.*operation=worktree configuration repair/iu,
      )
      expect(stderr).not.toHaveBeenCalled()
      expect(requests.map(({ args }) => args)).toEqual([
        ["config", "--local", "--get", "--type=bool", "extensions.worktreeConfig"],
        ["config", "--local", "--get", "--type=bool", "core.bare"],
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      ])
    } finally {
      stderr.mockRestore()
      held.release()
      await rm(repo, { recursive: true, force: true })
    }
  })

  it("refuses to build without the one injected Git capability", () => {
    // A JavaScript caller can still omit it, so this run-time refusal stays.
    // What is GONE is the companion assertion that TWO capabilities are
    // rejected: the options type now carries exactly one capability field, so
    // "two were supplied" is unrepresentable rather than merely detected.
    expect(() => createGitWorktreeStore({ repo: "/repo" } as unknown as GitWorktreeStoreOptions)).toThrow(
      /requires one injected GitProcess/iu,
    )
  })

  it("lets pool policy reset a slot branch at an explicit base", async () => {
    const repo = await mkdtemp(join(tmpdir(), "git-super-reset-branch-"))
    const calls: Array<{ repo: string; args: readonly string[] }> = []
    const store = createGitWorktreeStore({
      repo,
      gitProcess: {
        run: async (request) => {
          calls.push({ repo: request.repo, args: request.args })
          if (request.args[0] === "rev-parse") return { code: 0, stdout: `${join(repo, ".git")}\n`, stderr: "" }
          return { code: 0, stdout: "", stderr: "" }
        },
      },
    })

    try {
      const path = join(repo, ".worktrees/repo-wt5")
      await store.add({
        kind: "reset-branch",
        path,
        branch: "wt5",
        ref: "refs/remotes/origin/main",
        hooks: "quarantine",
      })

      expect(calls.at(-1)).toEqual({
        repo,
        args: ["-c", "core.hooksPath=/dev/null", "worktree", "add", "-B", "wt5", path, "refs/remotes/origin/main"],
      })
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it("adds and fully removes a real linked worktree through the local adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "git super worktree "))
    const repo = join(root, "owner")
    const linked = join(root, "linked worktree")
    git(root, ["init", "-q", "-b", "main", repo])
    git(repo, ["config", "user.email", "test@example.com"])
    git(repo, ["config", "user.name", "Test"])
    await writeFile(join(repo, "seed.txt"), "seed\n")
    git(repo, ["add", "seed.txt"])
    git(repo, ["commit", "-q", "-m", "seed"])

    try {
      const store = createLocalGitWorktreeStore({ repo })
      await store.add({ kind: "detached", path: linked, ref: "HEAD" })
      expect(existsSync(linked)).toBe(true)
      await store.lock(linked, "test locked cleanup")

      expect(runLocalGitWorktreeMutationSync({ kind: "remove", repo, path: linked, unlock: true }).exitCode).toBe(0)
      expect(existsSync(linked)).toBe(false)
      expect(git(repo, ["worktree", "list", "--porcelain"])).not.toContain(linked)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("removes a lender worktree and re-homes borrower alternates cleanly (25908)", async () => {
    const root = await mkdtemp(join(tmpdir(), "git-super-rehome-"))
    const subRemote = join(root, "sub-remote.git")
    const repo = join(root, "owner")
    const lender = join(root, "lender")
    const borrower = join(root, "borrower")
    const retainedDir = join(root, "retained")

    git(root, ["init", "-q", "--bare", "-b", "main", subRemote])
    const subWork = join(root, "sub-work")
    git(root, ["clone", "-q", subRemote, subWork])
    git(subWork, ["config", "user.email", "test@example.com"])
    git(subWork, ["config", "user.name", "Test"])
    await writeFile(join(subWork, "sub.txt"), "sub content\n")
    git(subWork, ["add", "sub.txt"])
    git(subWork, ["commit", "-q", "-m", "init sub"])
    git(subWork, ["push", "-q", "origin", "main"])

    git(root, ["init", "-q", "-b", "main", repo])
    git(repo, ["config", "user.email", "test@example.com"])
    git(repo, ["config", "user.name", "Test"])
    await writeFile(join(repo, "root.txt"), "root\n")
    git(repo, ["add", "root.txt"])
    git(repo, ["commit", "-q", "-m", "init root"])
    git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", subRemote, "vendor/sub"])
    git(repo, ["commit", "-q", "-m", "add submodule"])

    try {
      const store = createLocalGitWorktreeStore({ repo })
      await store.add({ kind: "detached", path: lender, ref: "HEAD" })
      await store.materializeSubmodules(lender)

      await store.add({ kind: "detached", path: borrower, ref: "HEAD" })
      const borrowerSub = join(borrower, "vendor/sub")
      const lenderSubAdmin = join(repo, ".git", "worktrees", "lender", "modules", "vendor/sub")
      const borrowerSubAdmin = join(repo, ".git", "worktrees", "borrower", "modules", "vendor/sub")
      const durableSubObjects = join(repo, ".git", "modules", "vendor/sub", "objects")
      const lenderSubObjects = join(lenderSubAdmin, "objects")

      await store.materializeSubmodules(borrower)
      const altFile = join(borrowerSubAdmin, "objects", "info", "alternates")
      await writeFile(altFile, `${lenderSubObjects}\n${durableSubObjects}\n`, "utf8")

      await store.remove(lender, {
        retention: {
          root: retainedDir,
          report: () => {},
        },
      })
      expect(existsSync(lender)).toBe(false)

      const altContent = await readFile(altFile, "utf8")
      expect(altContent).not.toContain(lenderSubObjects)
      expect(altContent).toContain(durableSubObjects)

      const fsck = spawnSync("git", ["-C", borrowerSub, "fsck", "--full"], { encoding: "utf8" })
      expect(fsck.status).toBe(0)
      expect(fsck.stderr).toBe("")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("dissociates borrower with repack -a -d when lender is packed with a unique commit (25908 cure)", async () => {
    const root = await mkdtemp(join(tmpdir(), "git-super-repack-"))
    const subRemote = join(root, "sub-remote.git")
    const repo = join(root, "owner")
    const lender = join(root, "lender")
    const borrower = join(root, "borrower")
    const retainedDir = join(root, "retained")

    git(root, ["init", "-q", "--bare", "-b", "main", subRemote])
    const subWork = join(root, "sub-work")
    git(root, ["clone", "-q", subRemote, subWork])
    git(subWork, ["config", "user.email", "test@example.com"])
    git(subWork, ["config", "user.name", "Test"])
    await writeFile(join(subWork, "sub.txt"), "sub content\n")
    git(subWork, ["add", "sub.txt"])
    git(subWork, ["commit", "-q", "-m", "init sub"])
    git(subWork, ["push", "-q", "origin", "main"])

    git(root, ["init", "-q", "-b", "main", repo])
    git(repo, ["config", "user.email", "test@example.com"])
    git(repo, ["config", "user.name", "Test"])
    await writeFile(join(repo, "root.txt"), "root\n")
    git(repo, ["add", "root.txt"])
    git(repo, ["commit", "-q", "-m", "init root"])
    git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", subRemote, "vendor/sub"])
    git(repo, ["commit", "-q", "-m", "add submodule"])

    try {
      const store = createLocalGitWorktreeStore({ repo })
      await store.add({ kind: "detached", path: lender, ref: "HEAD" })
      await store.materializeSubmodules(lender)

      const lenderSub = join(lender, "vendor/sub")
      git(lenderSub, ["config", "user.email", "test@example.com"])
      git(lenderSub, ["config", "user.name", "Test"])
      await writeFile(join(lenderSub, "lender-private.txt"), "lender only\n")
      git(lenderSub, ["add", "lender-private.txt"])
      git(lenderSub, ["commit", "-q", "-m", "lender only commit"])
      const lenderCommit = git(lenderSub, ["rev-parse", "HEAD"]).trim()

      git(lender, ["add", "vendor/sub"])
      git(lender, ["commit", "-q", "-m", "update sub in lender"])

      git(lenderSub, ["repack", "-a", "-d"])

      await store.add({ kind: "detached", path: borrower, ref: "HEAD" })
      const borrowerSub = join(borrower, "vendor/sub")
      const lenderSubAdmin = join(repo, ".git", "worktrees", "lender", "modules", "vendor/sub")
      const borrowerSubAdmin = join(repo, ".git", "worktrees", "borrower", "modules", "vendor/sub")
      const durableSubObjects = join(repo, ".git", "modules", "vendor/sub", "objects")
      const lenderSubObjects = join(lenderSubAdmin, "objects")

      await store.materializeSubmodules(borrower)
      const altFile = join(borrowerSubAdmin, "objects", "info", "alternates")
      await writeFile(altFile, `${lenderSubObjects}\n${durableSubObjects}\n`, "utf8")

      git(borrowerSub, ["update-ref", "refs/heads/main", lenderCommit])
      git(borrowerSub, ["symbolic-ref", "HEAD", "refs/heads/main"])

      expect(git(borrowerSub, ["cat-file", "-t", lenderCommit]).trim()).toBe("commit")

      await store.remove(lender, {
        retention: {
          root: retainedDir,
          report: () => {},
        },
      })
      expect(existsSync(lender)).toBe(false)
      expect(existsSync(lenderSubAdmin)).toBe(false)

      const fsck = spawnSync("git", ["-C", borrowerSub, "fsck", "--full"], { encoding: "utf8" })
      expect(fsck.status).toBe(0)
      expect(fsck.stderr).toBe("")

      const readCommit = spawnSync("git", ["-C", borrowerSub, "cat-file", "-t", lenderCommit], { encoding: "utf8" })
      expect(readCommit.status).toBe(0)
      expect(readCommit.stdout.trim()).toBe("commit")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("reports the timeout bound in seconds when repack times out (25908 P4)", async () => {
    const root = await mkdtemp(join(tmpdir(), "git-super-repack-timeout-"))
    try {
      const lenderModules = join(root, "lender/modules")
      const borrowerModules = join(root, "worktrees/borrower/modules/sub/objects/info")
      const { mkdir } = await import("node:fs/promises")
      await mkdir(borrowerModules, { recursive: true })
      await mkdir(lenderModules, { recursive: true })
      await writeFile(join(borrowerModules, "alternates"), `${join(lenderModules, "sub/objects")}\n`, "utf8")

      const fakeSpawn = (() => ({
        error: Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" }),
        status: null,
        signal: null,
        output: [],
        pid: 1234,
        stdout: "",
        stderr: "",
      })) as unknown as typeof spawnSync

      expect(() => rehomeBorrowers(root, join(root, "lender"), lenderModules, { spawn: fakeSpawn })).toThrow(
        /timed out after 120s bound/,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
