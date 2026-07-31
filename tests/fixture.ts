import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

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
