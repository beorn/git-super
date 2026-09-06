/**
 * @failure The package typecheck follows workspace dependency symlinks into
 *          sibling source trees, so unrelated diagnostics fail git-super's check.
 * @level   l1
 * @consumer vendor/git-super/package.json — typecheck
 * @reach   package
 *
 * A local injected error must stay red. An imported sibling-only error must
 * stay green and increment the loud exclusion count, proving both boundaries.
 */
import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { expect, test } from "vitest"

const PACKAGE_ROOT = resolve(import.meta.dirname, "..")

test("the package typecheck reports its workspace-composition boundary", () => {
  const result = runTypecheck(PACKAGE_ROOT)
  const output = `${result.stdout}${result.stderr}`

  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  expect(result.status).toBe(0)
  expect(output).toMatch(
    /git-super workspace-composition typecheck: filtered diagnostics to \d+ configured git-super files?; \d+ dependency diagnostics? excluded \(packages: (?:none|[^)]+)\)/u,
  )
})

test("the package typecheck rejects an error in a configured git-super file", () => {
  withFixture(
    {
      "git-super/src/local.ts": "export const localValue: string = 1\n",
    },
    ({ root }) => {
      const result = runTypecheck(root)
      const output = `${result.stdout}${result.stderr}`

      expect(result.error).toBeUndefined()
      expect(result.signal).toBeNull()
      expect(result.status).toBe(2)
      expect(output).toContain("src/local.ts")
      expect(output).toContain("TS2322")
    },
  )
})

test("the package typecheck excludes an error attributed only to imported sibling source", () => {
  withFixture(
    {
      "dependency/package.json": JSON.stringify({ name: "fixture-dependency" }),
      "dependency/src/value.ts": "export const dependencyValue: string = 1\n",
      "git-super/src/local.ts":
        'import { dependencyValue } from "../../dependency/src/value.ts"\nexport const localValue = dependencyValue\n',
    },
    ({ root }) => {
      const result = runTypecheck(root)
      const output = `${result.stdout}${result.stderr}`

      expect(result.error).toBeUndefined()
      expect(result.signal).toBeNull()
      expect(result.status).toBe(0)
      expect(output).toContain("1 dependency diagnostic excluded")
      expect(output).toContain("packages: fixture-dependency")
      expect(output).not.toContain("TS2322")
    },
  )
})

test("the package typecheck fails loudly when the config selects no files", () => {
  withFixture({}, ({ root }) => {
    const result = runTypecheck(root)
    const output = `${result.stdout}${result.stderr}`

    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status).toBe(2)
    expect(output).toContain("tsconfig.json configured 0 git-super files; refusing to report success")
  })
})

function runTypecheck(cwd: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ["run", "typecheck"], { cwd, encoding: "utf8" })
}

function withFixture(
  files: Readonly<Record<string, string>>,
  inspect: (fixture: Readonly<{ root: string }>) => void,
): void {
  const fixtureParent = mkdtempSync(resolve(tmpdir(), "git-super-typecheck-"))
  const root = resolve(fixtureParent, "git-super")

  try {
    mkdirSync(resolve(root, "scripts"), { recursive: true })
    mkdirSync(resolve(root, "src"), { recursive: true })
    cpSync(resolve(PACKAGE_ROOT, "scripts/typecheck.ts"), resolve(root, "scripts/typecheck.ts"))
    symlinkSync(resolve(PACKAGE_ROOT, "node_modules"), resolve(root, "node_modules"), "dir")
    writeFileSync(
      resolve(root, "package.json"),
      JSON.stringify({ type: "module", scripts: { typecheck: "bun scripts/typecheck.ts" } }),
    )
    writeFileSync(
      resolve(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          allowImportingTsExtensions: true,
          module: "Preserve",
          moduleResolution: "Bundler",
          noEmit: true,
          strict: true,
          target: "ESNext",
        },
        include: ["src"],
      }),
    )

    for (const [file, contents] of Object.entries(files)) {
      const target = resolve(fixtureParent, file)
      mkdirSync(resolve(target, ".."), { recursive: true })
      writeFileSync(target, contents)
    }

    inspect({ root })
  } finally {
    rmSync(fixtureParent, { recursive: true, force: true })
  }
}
