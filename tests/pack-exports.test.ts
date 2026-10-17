/**
 * @failure A public export can be unimportable, omitted from publication, or name an unbuilt dist file.
 * @level l2
 * @consumer npm consumers of git-super/gitlink-carrier and Yrd's git-super/shell-command import
 */

import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  exports: Record<string, string>
  tsdown: { entry: readonly string[] }
  publishConfig: { exports: Record<string, { import?: string; types?: string }> }
}

test("tsdown builds every publishConfig export (26412)", () => {
  expect(Object.keys(pkg.publishConfig.exports).sort()).toEqual(Object.keys(pkg.exports).sort())
  const entries = new Set(pkg.tsdown.entry)
  const missing: string[] = []
  for (const [name, spec] of Object.entries(pkg.publishConfig.exports)) {
    const importPath = spec.import
    if (typeof importPath !== "string" || !importPath.startsWith("./dist/") || !importPath.endsWith(".js")) {
      missing.push(`${name} has no ./dist/*.js import`)
      continue
    }
    const src = `src/${importPath.slice("./dist/".length, -".js".length)}.ts`
    if (!entries.has(src)) missing.push(`${name} -> ${src}`)
  }
  expect(missing).toEqual([])
})

test("a consumer imports shellQuote publicly and preserves one POSIX argument", () => {
  const value = "path with spaces/'quoted'/$HOME;$(printf expanded)\nlast line"
  const result = spawnSync(
    process.execPath,
    [
      "--eval",
      `import { shellQuote } from "git-super/shell-command";
const value = ${JSON.stringify(value)};
const output = Bun.spawnSync(["sh", "-c", "printf %s " + shellQuote(value)]);
if (output.exitCode !== 0) throw new Error(output.stderr.toString());
process.stdout.write(output.stdout);`,
    ],
    { cwd: root, encoding: "utf8" },
  )
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toBe(value)
})
