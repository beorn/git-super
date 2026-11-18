/**
 * Removal inspection reads each component's status once, not once per dirty file in it (#34883).
 *
 * @failure a worktree with thousands of dirty files inside one component makes removal inspection run one
 *   synchronous `git status` of that component per file: 19,459 blocking statuses (about five minutes) for
 *   /hh/var/wt/26788-gate, during which yrd's service could not write its heartbeat and paged
 *   queue-round-overdue.
 * @level l1
 * @consumer yrd env-close sweep (proveEnvironmentRemovable -> inspectRemoval -> admitOnRemoteSelections)
 * @testonly none
 * @reach fs-walk <fixture-only: mkdtempSync(tmpdir()) Git repos and a PATH shim that logs each git call>
 */
import { afterEach, describe, expect, test } from "vitest"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { inspectRemovalStatus } from "../src/worktree-removal.ts"
import { canonicalTmpdir, createProductFixture } from "./fixture.ts"

const roots: string[] = []
const savedPath = process.env.PATH

afterEach(() => {
  process.env.PATH = savedPath
  // raw-delete-allow: teardown of this file's own mkdtempSync fixture roots under tmpdir.
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Put a `git` first on PATH that appends "<cwd-arg> <args>" to `log`, then runs the real git. */
function shimGit(root: string): string {
  const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim()
  if (realGit === "") throw new Error("no git on PATH for the shim to run")
  const bin = join(root, "shim")
  const log = join(root, "git-calls.log")
  mkdirSync(bin)
  writeFileSync(log, "")
  writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${realGit}' "$@"\n`)
  chmodSync(join(bin, "git"), 0o755)
  process.env.PATH = `${bin}:${savedPath ?? ""}`
  return log
}

describe("removal inspection of a component with many dirty files (#34883)", () => {
  test("the component's status is read once, whatever its dirty-file count", () => {
    const root = mkdtempSync(join(canonicalTmpdir(), "git-super-removal-per-component-"))
    roots.push(root)
    const fixture = createProductFixture(root)
    const checkout = join(fixture.product, "packages/alpha")
    const files = 40
    for (let index = 0; index < files; index++) {
      writeFileSync(join(checkout, `work-${index}.ts`), `export const n = ${index}\n`)
    }
    const log = shimGit(root)

    const result = inspectRemovalStatus(fixture.product)

    // The verdict is unchanged: every file is still dirt, each with its reason.
    expect(result.records.filter((record) => record.includes("packages/alpha/work-"))).toHaveLength(files)
    expect(result.offRemote?.filter((entry) => entry.record.includes("packages/alpha/work-"))).toHaveLength(files)
    const componentStatuses = readFileSync(log, "utf8")
      .split("\n")
      .filter((line) => line.startsWith(`-C ${checkout} --no-optional-locks status --porcelain --untracked-files=all`))
    expect(componentStatuses).toHaveLength(1)
  })
})
