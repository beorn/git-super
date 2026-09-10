/**
 * The approved root-v1 observer must judge current submodule tips even when
 * the queue has no history, and publish no findings from a changed reading.
 * This executable boundary is absent from the ordinary status/merge corpus.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, expect, test } from "vitest"
import { observe, type ObservationInput, type ObservationResult } from "../src/observe.ts"
import { createLocalGitProcess, type GitProcess } from "../src/process.ts"
import { encodePushIntent, PUSH_INTENT_TRAILER } from "../src/push-intent.ts"
import { advanceRepository, canonicalTmpdir, createProductFixture, git } from "./fixture.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(canonicalTmpdir(), "git-super-observe-"))
  roots.push(root)
  const product = createProductFixture(root)
  const remote = "https://example.test/acme/product.git"
  const alphaRemote = "https://example.test/acme/alpha.git"
  const betaRemote = "https://example.test/elsewhere/beta.git"
  const config = join(root, "gitconfig")
  for (const [logical, local] of [
    [remote, product.product],
    [alphaRemote, product.alpha],
    [betaRemote, product.beta],
  ]) {
    git(root, "config", "--file", config, `url.${local}.insteadOf`, logical as string)
  }
  git(root, "config", "--file", config, "protocol.file.allow", "always")
  git(product.product, "remote", "add", "origin", remote)
  git(product.product, "config", "-f", ".gitmodules", "submodule.packages/alpha.url", alphaRemote)
  git(product.product, "config", "-f", ".gitmodules", "submodule.vendor/beta.url", betaRemote)
  git(product.product, "config", "-f", ".gitmodules", "submodule.packages/alpha.branch", "main")
  git(product.product, "config", "-f", ".gitmodules", "submodule.vendor/beta.branch", "main")
  git(product.product, "commit", "-qam", "freeze hosted submodule identities")
  const targetOid = git(product.product, "rev-parse", "HEAD")
  const input: ObservationInput = {
    version: 1,
    root: { remote, targetRef: "refs/heads/main", targetOid },
    checked: [],
    fence: { prefixes: ["refs/changes/main/"], refs: [] },
  }
  return {
    ...product,
    input,
    root,
    config,
    alphaRemote,
    betaRemote,
    env: { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" },
  }
}

async function command(f: ReturnType<typeof fixture>, input: unknown = f.input) {
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dirname, "../bin/git-super"), "super", "observe", "--protocol=1"],
    {
      cwd: f.product,
      env: f.env,
      stdin: new Blob([JSON.stringify(input)]),
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}

test("the selected executable observes idle tips, excludes external children and preserves caller refs", async () => {
  const f = fixture()
  const beforeRefs = git(f.product, "for-each-ref", "--format=%(refname) %(objectname)")
  const common = git(f.product, "rev-parse", "--path-format=absolute", "--git-common-dir")
  const fetchHead = join(common, "FETCH_HEAD")
  const beforeFetch = existsSync(fetchHead) ? readFileSync(fetchHead, "utf8") : undefined
  const stores = [join(common, "modules/packages/alpha"), join(common, "modules/vendor/beta")]
  const beforeStores = stores.map((store) => ({
    refs: git(store, "for-each-ref", "--format=%(refname) %(objectname)"),
    fetch: existsSync(join(store, "FETCH_HEAD")) ? readFileSync(join(store, "FETCH_HEAD"), "utf8") : undefined,
  }))
  const initial = await command(f)
  expect(initial.code, initial.stderr).toBe(0)
  expect(JSON.parse(initial.stdout)).toMatchObject({
    version: 1,
    outcome: "observed",
    notices: [],
    message: expect.stringContaining("1 external"),
  })
  const alphaTip = advanceRepository(f.alpha, "alpha.ts", "export const alpha = 2\n")
  advanceRepository(f.beta, "beta.ts", "export const beta = 2\n")
  const moved = await command(f)
  expect(moved.code, moved.stderr).toBe(0)
  const observed = JSON.parse(moved.stdout) as ObservationResult
  expect(observed.notices).toHaveLength(1)
  expect(Object.keys(observed.notices[0] ?? {}).sort()).toEqual(["id", "text"])
  expect(observed.notices[0]?.text).toContain(alphaTip)
  expect(observed.notices[0]?.text).toContain("packages/alpha")
  expect((JSON.parse((await command(f)).stdout) as ObservationResult).notices).toEqual(observed.notices)
  expect(git(f.product, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(beforeRefs)
  expect(existsSync(fetchHead) ? readFileSync(fetchHead, "utf8") : undefined).toBe(beforeFetch)
  expect(git(f.product, "status", "--porcelain")).toBe("")
  expect(
    stores.map((store) => ({
      refs: git(store, "for-each-ref", "--format=%(refname) %(objectname)"),
      fetch: existsSync(join(store, "FETCH_HEAD")) ? readFileSync(join(store, "FETCH_HEAD"), "utf8") : undefined,
    })),
  ).toEqual(beforeStores)
})

test.each(["new", "removed", "changed", "root"] as const)(
  "discards buffered findings when a %s ref changes during child reads",
  async (change) => {
    const f = fixture()
    const recordRef = "refs/changes/main/live"
    git(f.product, "update-ref", recordRef, f.input.root.targetOid)
    const input: ObservationInput = {
      ...f.input,
      fence: { ...f.input.fence, refs: [{ ref: recordRef, oid: f.input.root.targetOid }] },
    }
    advanceRepository(f.alpha, "alpha.ts", "export const alpha = 3\n")
    const other = git(
      f.product,
      "commit-tree",
      `${f.input.root.targetOid}^{tree}`,
      "-p",
      f.input.root.targetOid,
      "-m",
      "new root fact",
    )
    const local = createLocalGitProcess(f.env, { attempts: 1 })
    let injected = false
    const process: GitProcess = {
      async run(request) {
        const result = await local.run(request)
        if (!injected && request.args[0] === "ls-remote" && request.args.includes(f.alphaRemote)) {
          injected = true
          if (change === "new") git(f.product, "update-ref", "refs/changes/main/not-a-recognized-row", other)
          else if (change === "removed") git(f.product, "update-ref", "-d", recordRef)
          else git(f.product, "update-ref", change === "root" ? "refs/heads/main" : recordRef, other)
        }
        return result
      },
    }
    const result = await observe(f.product, input, process)
    expect(injected, "child-read interleaving must actually run").toBe(true)
    expect(result).toMatchObject({ outcome: "changed-during-read", notices: [] })
    expect(result.message).toContain("All buffered findings were discarded")
  },
)

test("only current checked source N explains a tip; expected-old O and retired intent do not", async () => {
  const f = fixture()
  const old = advanceRepository(f.alpha, "alpha.ts", "export const alpha = 4\n")
  const next = advanceRepository(f.alpha, "alpha.ts", "export const alpha = 5\n")
  const other = git(
    f.product,
    "commit-tree",
    `${f.input.root.targetOid}^{tree}`,
    "-p",
    f.input.root.targetOid,
    "-m",
    "candidate",
  )
  const intent = encodePushIntent({
    version: 1,
    rootRemote: f.input.root.remote,
    children: [
      {
        path: "packages/alpha",
        remote: f.alphaRemote,
        pin: f.alphaBase,
        publication: { destination: "refs/heads/main", source: next, expectedDestination: { state: "oid", oid: old } },
      },
      { path: "vendor/beta", remote: f.betaRemote, pin: f.betaBase },
    ],
  })
  const merge = git(
    f.product,
    "commit-tree",
    `${f.input.root.targetOid}^{tree}`,
    "-p",
    f.input.root.targetOid,
    "-p",
    other,
    "-m",
    `checked merge\n\n${PUSH_INTENT_TRAILER}: ${intent}`,
  )
  const recordRef = "refs/changes/main/checked"
  git(f.product, "update-ref", recordRef, other)
  const input: ObservationInput = {
    ...f.input,
    checked: [{ mergeOid: merge, recordRef, recordOid: other }],
    fence: { ...f.input.fence, refs: [{ ref: recordRef, oid: other }] },
  }
  const local = createLocalGitProcess(f.env, { attempts: 1 })
  expect(await observe(f.product, input, local)).toMatchObject({ outcome: "observed", notices: [] })
  git(f.alpha, "update-ref", "refs/heads/main", old, next)
  const before = await observe(f.product, input, local)
  expect(before.outcome).toBe("observed")
  expect(before.notices).toHaveLength(1)
  expect(before.notices[0]?.text).toContain(old)
  git(f.alpha, "update-ref", "refs/heads/main", next, old)
  const retired = await observe(f.product, { ...input, checked: [] }, local)
  expect(retired.outcome).toBe("observed")
  expect(retired.notices).toHaveLength(1)
  expect(retired.notices[0]?.text).toContain(next)
})

test.each(["advertisement", "fetch"] as const)("a failed %s has no findings and is not retried", async (operation) => {
  const f = fixture()
  advanceRepository(f.alpha, "alpha.ts", "export const alpha = 6\n")
  const local = createLocalGitProcess(f.env, { attempts: 1 })
  let attempts = 0
  const process: GitProcess = {
    run(request) {
      if (request.args[0] === (operation === "fetch" ? "fetch" : "ls-remote") && request.args.includes(f.alphaRemote)) {
        attempts += 1
        return Promise.resolve({ code: 128, stdout: "remote evidence", stderr: "denied by test transport" })
      }
      return local.run(request)
    },
  }
  const result = await observe(f.product, f.input, process)
  expect(attempts, "the intended transport fault must fire exactly once").toBe(1)
  expect(result).toMatchObject({ outcome: "unavailable-transport", notices: [] })
  expect(result.message).toContain("denied by test transport")
  expect(result.message).toContain("remote evidence")
  expect(result.message).toContain(f.alphaRemote)
})

test.each([
  "missing root object",
  "missing branch",
  "wrong witness",
  "duplicate fence",
  "outside prefix",
  "unknown field",
  "local ownership",
] as const)("%s is invalid and never an empty observation", async (failure) => {
  const f = fixture()
  const ref = "refs/changes/main/checked"
  const row = { ref, oid: f.input.root.targetOid }
  let input: unknown = f.input
  if (failure === "missing root object") input = { ...f.input, root: { ...f.input.root, targetOid: "a".repeat(40) } }
  else if (failure === "missing branch") git(f.alpha, "update-ref", "-d", "refs/heads/main")
  else if (failure === "wrong witness") {
    input = {
      ...f.input,
      checked: [{ mergeOid: f.input.root.targetOid, recordRef: ref, recordOid: f.input.root.targetOid }],
    }
  } else if (failure === "duplicate fence") input = { ...f.input, fence: { ...f.input.fence, refs: [row, row] } }
  else if (failure === "outside prefix") {
    input = { ...f.input, fence: { ...f.input.fence, refs: [{ ...row, ref: "refs/heads/elsewhere" }] } }
  } else if (failure === "unknown field") input = { ...f.input, children: [] }
  else input = { ...f.input, root: { ...f.input.root, remote: f.product } }
  const result = await command(f, input)
  expect(result.code, result.stderr).toBe(2)
  expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "invalid", notices: [], message: expect.any(String) })
  expect((JSON.parse(result.stdout) as ObservationResult).message.length).toBeGreaterThan(20)
})

test.each(["changed-during-read", "unavailable-transport"] as const)(
  "the executable returns the matching %s envelope and exit",
  async (outcome) => {
    const f = fixture()
    if (outcome === "changed-during-read") git(f.product, "update-ref", "refs/changes/main/new", f.input.root.targetOid)
    else {
      git(f.root, "config", "--file", f.config, "--unset", `url.${f.alpha}.insteadOf`)
      git(f.root, "config", "--file", f.config, `url.${join(f.root, "missing-alpha")}.insteadOf`, f.alphaRemote)
    }
    const result = await command(f)
    expect(result.code, result.stderr).toBe(outcome === "changed-during-read" ? 3 : 4)
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome, notices: [], message: expect.any(String) })
  },
)
