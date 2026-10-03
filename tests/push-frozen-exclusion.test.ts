/**
 * @failure A merge that excludes a root submodule froze no record of it, so the frozen push prepared a store for the
 *          excluded child (`git init --bare`) and then refused for want of a disposition, stopping every queue
 *          publication of a root that declares a private submodule (27147, @cto 361c4071).
 * @level   l2 (real repositories, real merge, push and observe; hosted names via url.insteadOf)
 * @consumer yrd's queue publication (`git super push --recurse-submodules`) and root-v1 observation
 * @reach fs-walk <fixture-only: temporary repositories>
 * @testonly none
 */
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { superMerge } from "../src/merge.ts"
import { observe, type ObservationInput } from "../src/observe.ts"
import { createLocalGitProcess } from "../src/process.ts"
import {
  decodePushIntent,
  encodePushIntent,
  PUSH_INTENT_TRAILER,
  readFrozenPushIntent,
  type FrozenPushIntent,
} from "../src/push-intent.ts"
import { superPush } from "../src/push.ts"
import { advanceRepository, canonicalTmpdir, createRepository, git } from "./fixture.ts"

const ROOT_URL = "https://git-super.test/owned/root.git"
const CHILD_URL = "https://git-super.test/owned/child.git"
/** Never mapped to a local path: any read of the excluded child would leave the machine and fail. */
const SECRET_URL = "https://git-super.test/owned/secret.git"

const fixtures: string[] = []
const previousGlobal = process.env.GIT_CONFIG_GLOBAL
let config = ""
beforeAll(() => {
  const home = mkdtempSync(join(canonicalTmpdir(), "git-super-frozen-exclusion-config-"))
  fixtures.push(home)
  config = join(home, "gitconfig")
  writeFileSync(config, '[protocol "file"]\n\tallow = always\n')
  process.env.GIT_CONFIG_GLOBAL = config
})
afterAll(() => {
  if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
  else process.env.GIT_CONFIG_GLOBAL = previousGlobal
  // raw-delete-allow: the fixture trees this test made under its own mkdtemp roots
  for (const fixture of fixtures) rmSync(fixture, { recursive: true, force: true })
})

function bare(fixture: string, name: string, file: string): Readonly<{ remote: string; head: string }> {
  const remote = join(fixture, `${name}.git`)
  const seed = join(fixture, `${name}-seed`)
  git(fixture, "init", "--bare", "-q", "-b", "main", remote)
  const head = createRepository(seed, file, `${name}\n`)
  git(seed, "remote", "add", "origin", remote)
  git(seed, "push", "-q", "origin", "main")
  return { remote, head }
}

/**
 * A root with a public child and an excluded `secret` child, a candidate that moves only the public child, and a
 * main that moved on its own. The secret's store and remote are gone before the merge, as for a seat that never
 * held the private submodule.
 */
function excludedFixture(): Readonly<{
  fixture: string
  root: string
  rootRemote: string
  childRemote: string
  secretPin: string
  rootBefore: string
  candidate: string
}> {
  const fixture = mkdtempSync(join(canonicalTmpdir(), "git-super-frozen-exclusion-"))
  fixtures.push(fixture)
  const child = bare(fixture, "child", "child.txt")
  const secret = bare(fixture, "secret", "secret.txt")
  const rootRemote = join(fixture, "root.git")
  git(fixture, "init", "--bare", "-q", "-b", "main", rootRemote)
  // One fixture's hosted names at a time: an earlier fixture's mapping for the same URL would win.
  writeFileSync(config, '[protocol "file"]\n\tallow = always\n')
  git(fixture, "config", "--file", config, `url.${rootRemote}.insteadOf`, ROOT_URL)
  git(fixture, "config", "--file", config, `url.${child.remote}.insteadOf`, CHILD_URL)
  const root = join(fixture, "root")
  createRepository(root, "base.txt", "base\n")
  git(root, "submodule", "add", "-q", CHILD_URL, "child")
  git(root, "submodule", "add", "-q", secret.remote, "secret")
  git(root, "config", "--file", ".gitmodules", "submodule.secret.url", SECRET_URL)
  git(root, "add", ".gitmodules")
  git(root, "commit", "-q", "-m", "a public child and an excluded one")
  git(root, "remote", "add", "origin", ROOT_URL)
  git(root, "push", "-q", "origin", "main")
  const rootBefore = git(root, "rev-parse", "HEAD")
  git(root, "switch", "-q", "-c", "candidate")
  advanceRepository(join(root, "child"), "child.txt", "candidate\n")
  git(root, "add", "child")
  git(root, "commit", "-q", "-m", "candidate moves the public child")
  const candidate = git(root, "rev-parse", "HEAD")
  git(root, "switch", "-q", "main")
  git(root, "submodule", "update", "-q", "--", "child")
  advanceRepository(root, "main.txt", "main moved\n")
  git(root, "submodule", "deinit", "-q", "-f", "--", "secret")
  // raw-delete-allow: the excluded child's store inside this test's own mkdtemp fixture, removed to model a seat that
  // never held it
  rmSync(join(root, ".git", "modules", "secret"), { recursive: true, force: true })
  renameSync(secret.remote, `${secret.remote}.gone`)
  return { fixture, root, rootRemote, childRemote: child.remote, secretPin: secret.head, rootBefore, candidate }
}

async function mergeExcluding(f: ReturnType<typeof excludedFixture>): Promise<string> {
  const merged = await superMerge({
    repo: f.root,
    commit: f.candidate,
    message: "checked merge",
    excludedSubmodules: ["secret"],
  })
  if (merged.state !== "updated" || merged.commit === undefined) throw new Error(JSON.stringify(merged.detail))
  return merged.commit
}

describe("a frozen merge carries its exclusions to the push and the observer (27147)", () => {
  test("merge then push round trip: the exclusion is frozen, the public child publishes, no store is made for the excluded one", async () => {
    const f = excludedFixture()
    const merge = await mergeExcluding(f)

    const intent = await readFrozenPushIntent(createLocalGitProcess(), f.root, merge)
    expect(intent?.excluded).toEqual([{ path: "secret", pin: f.secretPin }])
    expect(intent?.children.map(({ path }) => path)).toEqual(["child"])

    const pushed = await superPush({
      repo: f.root,
      remote: "origin",
      refspecs: [`${merge}:refs/heads/main`],
      recurseSubmodules: "on-demand",
    })

    expect(pushed, JSON.stringify(pushed.detail)).toMatchObject({ state: "updated", partial: false })
    expect(git(f.rootRemote, "rev-parse", "refs/heads/main")).toBe(merge)
    expect(git(f.childRemote, "rev-parse", "refs/heads/main")).toBe(git(f.root, "rev-parse", `${merge}:child`))
    expect(existsSync(join(f.root, ".git", "modules", "secret"))).toBe(false)
  }, 120_000)

  test("a frozen exclusion the commit does not record at that pin is refused by name, before any child is read", async () => {
    const f = excludedFixture()
    const merge = await mergeExcluding(f)
    const intent = (await readFrozenPushIntent(createLocalGitProcess(), f.root, merge)) as FrozenPushIntent
    const wrong = git(f.root, "rev-parse", "HEAD:base.txt")
    const forged = git(
      f.root,
      "commit-tree",
      `${merge}^{tree}`,
      "-p",
      `${merge}^1`,
      "-p",
      `${merge}^2`,
      "-m",
      `forged merge\n\n${PUSH_INTENT_TRAILER}: ${encodePushIntent({ ...intent, excluded: [{ path: "secret", pin: wrong }] })}`,
    )

    const pushed = await superPush({
      repo: f.root,
      remote: "origin",
      refspecs: [`${forged}:refs/heads/main`],
      recurseSubmodules: "on-demand",
    })

    expect(pushed.state).toBe("failed")
    expect(JSON.stringify(pushed.detail)).toContain(
      `Frozen merge ${forged} excludes secret@${wrong}, but the commit records secret@${f.secretPin}`,
    )
    expect(git(f.rootRemote, "rev-parse", "refs/heads/main")).toBe(f.rootBefore)
    expect(existsSync(join(f.root, ".git", "modules", "secret"))).toBe(false)
  }, 120_000)

  test("observe on a checked merge with an excluded child prepares and reads no store for it", async () => {
    const f = excludedFixture()
    const merge = await mergeExcluding(f)
    const pushed = await superPush({
      repo: f.root,
      remote: "origin",
      refspecs: [`${merge}:refs/heads/main`],
      recurseSubmodules: "on-demand",
    })
    expect(pushed.state, JSON.stringify(pushed.detail)).toBe("updated")
    const recordRef = "refs/changes/main/checked"
    git(f.root, "push", "-q", "origin", `${f.candidate}:${recordRef}`)
    const input: ObservationInput = {
      version: 1,
      root: { remote: ROOT_URL, targetRef: "refs/heads/main", targetOid: merge },
      checked: [{ mergeOid: merge, recordRef, recordOid: f.candidate }],
      fence: { prefixes: ["refs/changes/main/"], refs: [{ ref: recordRef, oid: f.candidate }] },
    }

    const observed = await observe(f.root, input, createLocalGitProcess(process.env, { attempts: 1 }))

    expect(observed, JSON.stringify(observed)).toMatchObject({ outcome: "observed", notices: [] })
    expect(existsSync(join(f.root, ".git", "modules", "secret"))).toBe(false)
  }, 120_000)

  test("the field is absent when nothing is excluded, an empty or unknown field is refused, and version stays 1", () => {
    const plain: FrozenPushIntent = { version: 1, rootRemote: ROOT_URL, children: [] }
    const bytes = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64")
    // An intent written before the field decodes to the same bytes it was written as.
    expect(encodePushIntent(plain)).toBe(bytes({ version: 1, rootRemote: ROOT_URL, children: [] }))
    expect(decodePushIntent(bytes({ version: 1, rootRemote: ROOT_URL, children: [] }))).toEqual(plain)
    const pin = "a".repeat(40)
    expect(
      decodePushIntent(bytes({ version: 1, rootRemote: ROOT_URL, children: [], excluded: [{ path: "secret", pin }] })),
    ).toEqual({ ...plain, excluded: [{ path: "secret", pin }] })
    expect(() => decodePushIntent(bytes({ ...plain, excluded: [] }))).toThrow(/excluded must be a nonempty array/u)
    // What a reader that predates the field does with it: a loud refusal, never a silent pass.
    expect(() => decodePushIntent(bytes({ ...plain, excludedLater: [{ path: "secret", pin }] }))).toThrow(
      /duplicate, unknown or noncanonical fields/u,
    )
    expect(() =>
      decodePushIntent(
        bytes({
          ...plain,
          children: [{ path: "secret", remote: CHILD_URL, pin }],
          excluded: [{ path: "secret", pin }],
        }),
      ),
    ).toThrow(/excluded path secret is not unique/u)
  })
})
