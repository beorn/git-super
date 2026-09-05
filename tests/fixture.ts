import { mkdirSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect } from "vitest"
import type { GitProcessRequest } from "../src/process.ts"

/** Git reports physical repository roots; Darwin's tmpdir is commonly a /var alias for /private/var. */
export function canonicalTmpdir(): string {
  return realpathSync(tmpdir())
}

export function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Git Super Test",
      GIT_AUTHOR_EMAIL: "git-super@example.test",
      GIT_COMMITTER_NAME: "Git Super Test",
      GIT_COMMITTER_EMAIL: "git-super@example.test",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr.toString().trim()}`)
  }
  return result.stdout.toString().trim()
}

export function createRepository(root: string, file: string, content: string): string {
  mkdirSync(root, { recursive: true })
  git(root, "init", "-q", "-b", "main")
  writeFileSync(join(root, file), content)
  git(root, "add", file)
  git(root, "commit", "-q", "-m", `add ${file}`)
  return git(root, "rev-parse", "HEAD")
}

export function advanceRepository(root: string, file: string, content: string): string {
  writeFileSync(join(root, file), content)
  git(root, "add", file)
  git(root, "commit", "-q", "-m", `update ${file}`)
  return git(root, "rev-parse", "HEAD")
}

export type ProductFixture = Readonly<{
  alpha: string
  alphaBase: string
  beta: string
  betaBase: string
  product: string
  productBase: string
}>

export type NestedProductFixture = ProductFixture &
  Readonly<{
    leaf: string
    leafBase: string
    productWithNestedBase: string
  }>

export function createProductFixture(fixture: string): ProductFixture {
  const alpha = join(fixture, "alpha")
  const beta = join(fixture, "beta")
  const product = join(fixture, "product")
  const alphaBase = createRepository(alpha, "alpha.ts", "export const alpha = 1\n")
  const betaBase = createRepository(beta, "beta.ts", "export const beta = 1\n")
  mkdirSync(product, { recursive: true })
  git(product, "init", "-q", "-b", "main")
  git(product, "-c", "protocol.file.allow=always", "submodule", "add", "-q", alpha, "packages/alpha")
  git(product, "-c", "protocol.file.allow=always", "submodule", "add", "-q", beta, "vendor/beta")
  git(product, "commit", "-q", "-am", "add product submodules")
  return {
    alpha,
    alphaBase,
    beta,
    betaBase,
    product,
    productBase: git(product, "rev-parse", "HEAD"),
  }
}

export function bumpProductSubmodules(fixture: ProductFixture): string {
  const alphaHead = advanceRepository(fixture.alpha, "alpha.ts", "export const alpha = 2\n")
  const betaHead = advanceRepository(fixture.beta, "new-beta.ts", "export const beta = 2\n")
  git(join(fixture.product, "packages/alpha"), "fetch", "-q", "origin")
  git(join(fixture.product, "packages/alpha"), "checkout", "-q", alphaHead)
  git(join(fixture.product, "vendor/beta"), "fetch", "-q", "origin")
  git(join(fixture.product, "vendor/beta"), "checkout", "-q", betaHead)
  git(fixture.product, "add", "packages/alpha", "vendor/beta")
  git(fixture.product, "commit", "-q", "-m", "bump product submodules")
  return git(fixture.product, "rev-parse", "HEAD")
}

export function addNestedAlphaSubmodule(fixture: ProductFixture): NestedProductFixture {
  const leaf = join(fixture.alpha, "..", "leaf")
  const leafBase = createRepository(leaf, "leaf.ts", "export const leaf = 1\n")
  git(fixture.alpha, "-c", "protocol.file.allow=always", "submodule", "add", "-q", leaf, "apps/maddoc")
  git(fixture.alpha, "commit", "-q", "-am", "add nested app")
  const alphaWithNested = git(fixture.alpha, "rev-parse", "HEAD")
  const alphaCheckout = join(fixture.product, "packages/alpha")
  git(alphaCheckout, "fetch", "-q", "origin")
  git(alphaCheckout, "checkout", "-q", alphaWithNested)
  git(alphaCheckout, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive")
  git(fixture.product, "add", "packages/alpha")
  git(fixture.product, "commit", "-q", "-m", "pin nested app")
  return {
    ...fixture,
    leaf,
    leafBase,
    productWithNestedBase: git(fixture.product, "rev-parse", "HEAD"),
  }
}

export function bumpNestedAlphaSubmodule(fixture: NestedProductFixture): string {
  const leafHead = advanceRepository(fixture.leaf, "leaf.ts", "export const leaf = 2\n")
  const alphaCheckout = join(fixture.product, "packages/alpha")
  const leafCheckout = join(alphaCheckout, "apps/maddoc")
  git(leafCheckout, "fetch", "-q", "origin")
  git(leafCheckout, "checkout", "-q", leafHead)
  git(alphaCheckout, "add", "apps/maddoc")
  git(alphaCheckout, "commit", "-q", "-m", "bump nested app")
  git(fixture.product, "add", "packages/alpha")
  git(fixture.product, "commit", "-q", "-m", "bump alpha")
  return git(fixture.product, "rev-parse", "HEAD")
}

export type InjectionProbe = Readonly<{
  /** Record every request the wrapper saw, matched or not. */
  observe(request: GitProcessRequest): void
  /** Record that the named injection replaced git's answer. */
  fire(injection: string): void
  /** Fail by name, listing the repositories git was asked about, when an injection never matched. */
  expectFired(...injections: readonly string[]): void
}>

/**
 * Proof that a failure injection actually fired.
 *
 * An injection keyed on `request.repo` compares against the PHYSICAL path git
 * reports (`rev-parse --show-toplevel`), never the path the test typed. On
 * Darwin `os.tmpdir()` is `/var/folders/…`, an alias of `/private/var/…`, so a
 * fixture rooted there never matched: five failure-path merge tests took the
 * success branch on macos-15 from 2026-08-31 and failed on `state`, two
 * assertions away from the cause. `canonicalTmpdir` removes the alias; this
 * probe makes a missed injection fail by its own name, saying which
 * repositories git was asked about, instead of proving the happy path.
 */
export function injectionProbe(): InjectionProbe {
  const repositories = new Set<string>()
  const fired = new Map<string, number>()
  return {
    observe(request) {
      repositories.add(request.repo)
    },
    fire(injection) {
      fired.set(injection, (fired.get(injection) ?? 0) + 1)
    },
    expectFired(...injections) {
      for (const injection of injections) {
        expect(
          fired.get(injection) ?? 0,
          `injection "${injection}" never fired; git was asked about: ${[...repositories].sort().join(", ") || "nothing"}`,
        ).toBeGreaterThan(0)
      }
    },
  }
}
