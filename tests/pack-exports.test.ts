/**
 * @failure A publishConfig export can name a dist file tsdown never builds, so the packed package cannot resolve it.
 * @level l1
 * @consumer 21076 old-pin pack proof and npm consumers of git-super/gitlink-carrier
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  tsdown: { entry: readonly string[] }
  publishConfig: { exports: Record<string, { import?: string; types?: string }> }
}

test("tsdown builds every publishConfig export (26412)", () => {
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
