/**
 * @failure A retained entry is verified from a partial walk, or a preliminary `candidate` is read as removal authority.
 * @level l1
 * @consumer Yrd environment close through git-super worktree remove --retain; #27443(b)
 * @reach fs-walk <fixture-only: the real retention writer, worktree add/remove and the estate scan use mkdtempSync(tmpdir()) Git repos>
 * @testonly none
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { runCli } from "../src/cli.ts"
import { retentionRemovalBoundary, verifyRetainedEntry } from "../src/retention-verify.ts"

/** The shared, real-writer fixture and the pristine snapshot used to restore it in place. */
let fixtureRoot: string | undefined

afterAll(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
})

const environment: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Git Super Test",
  GIT_AUTHOR_EMAIL: "git-super@example.test",
  GIT_COMMITTER_NAME: "Git Super Test",
  GIT_COMMITTER_EMAIL: "git-super@example.test",
  GIT_TERMINAL_PROMPT: "0",
}

function git(repo: string, args: readonly string[]): string {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env: environment })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed in ${repo}`)
  return result.stdout.trim()
}

function outputSink(): { output: string; write(value: string): void } {
  return {
    output: "",
    write(value) {
      this.output += value
    },
  }
}

/**
 * One retained entry produced by the REAL writer (a superproject worktree with one submodule),
 * built once and reused: the suite runs beside a heavily loaded shared host, and rebuilding the
 * fixture per case starves neighbouring files (measured 2026-10-05: ten builds tipped
 * tests/diff.test.ts past its timeout in the full run).
 */
let base: Readonly<{ root: string; entry: string; retainUntil: string; artifactDir: string }>
let pristine: string | undefined

beforeAll(async () => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "git-super-retention-verify-"))
  const dependency = join(fixtureRoot, "dependency")
  const product = join(fixtureRoot, "product")
  mkdirSync(dependency, { recursive: true })
  git(dependency, ["init", "-q", "-b", "main"])
  writeFileSync(join(dependency, "dep.ts"), "export const dep = 1\n")
  git(dependency, ["add", "dep.ts"])
  git(dependency, ["commit", "-q", "-m", "dep"])
  mkdirSync(product, { recursive: true })
  git(product, ["init", "-q", "-b", "main"])
  git(product, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", dependency, "vendor/dep"])
  git(product, ["commit", "-q", "-m", "add vendor/dep"])
  const worktree = join(fixtureRoot, "candidate")
  const root = join(fixtureRoot, "retained")
  expect(await runCli(["--repo", product, "worktree", "add", worktree, "HEAD"], outputSink(), outputSink())).toBe(0)
  expect(
    await runCli(
      ["--repo", product, "--json", "worktree", "remove", worktree, "--retain", root],
      outputSink(),
      outputSink(),
    ),
  ).toBe(0)
  const entries = readdirSync(root)
  expect(entries).toHaveLength(1)
  const entry = join(root, entries[0] as string)
  const manifest = JSON.parse(readFileSync(join(entry, "manifest.json"), "utf8")) as { retainUntil: string }
  // The manifest records absolute paths, so a relocation is refused by design (gate 1). Mutation
  // cases therefore restore the entry in place from this snapshot rather than verifying a copy.
  pristine = join(fixtureRoot, "pristine")
  cpSync(entry, pristine, { recursive: true })
  base = { root, entry, retainUntil: manifest.retainUntil, artifactDir: join(fixtureRoot, "pass") }
}, 120_000)

/**
 * Rewrite the shared entry to its as-written bytes before every case, so a mutation case cannot
 * leak into the next read (see the `pristine` note above).
 */
beforeEach(() => {
  rmSync(base.entry, { recursive: true, force: true })
  cpSync(pristine as string, base.entry, { recursive: true })
  rmSync(base.artifactDir, { recursive: true, force: true })
})

function eligible(): Date {
  return new Date(Date.parse(base.retainUntil) + 1000)
}

function firstFile(root: string): string {
  for (const name of readdirSync(root, { recursive: true }) as string[]) {
    const path = join(root, name)
    if (statSync(path).isFile()) return path
  }
  throw new Error(`no file under ${root}`)
}

describe("retention verify gates 1-6", () => {
  it("reaches candidate only through gate 6 and never claims removal authority", () => {
    const result = verifyRetainedEntry({
      entry: base.entry,
      root: base.root,
      namespaceRoots: [fixtureRoot as string],
      artifactDir: base.artifactDir,
      clock: eligible(),
    })
    expect(result.verdict).toBe("candidate")
    expect(result.gates.map((gate) => gate.status)).toEqual(["pass", "pass", "pass", "pass", "pass", "pass"])
    expect(result.head).toMatch(/^[0-9a-f]{40}$/u)
    expect(result.manifestSha256).toMatch(/^[0-9a-f]{64}$/u)
    // The rendered, content-addressed certificate exists outside E.
    expect(result.certificate?.digest).toMatch(/^[0-9a-f]{64}$/u)
    expect(JSON.parse(readFileSync(result.certificate?.path as string, "utf8"))).toMatchObject({ verdict: "candidate" })
    expect(retentionRemovalBoundary(result).authorized).toBe(false)
    expect(retentionRemovalBoundary(result).reason).toContain("preliminary")
  })

  it("reports gate 2 unknown when no external pass directory was supplied", () => {
    const result = verifyRetainedEntry({ entry: base.entry, root: base.root, clock: eligible() })
    expect(result.verdict).toBe("unknown")
    expect(result.gates[1]).toMatchObject({ gate: "copy-manifest", status: "unknown" })
    expect(retentionRemovalBoundary(result).authorized).toBe(false)
  })

  it("refuses a pass directory inside the retention custody", () => {
    const result = verifyRetainedEntry({
      entry: base.entry,
      root: base.root,
      artifactDir: join(base.root, "inside"),
      clock: eligible(),
    })
    expect(result.verdict).toBe("blocked")
    expect(result.gates[1]).toMatchObject({ gate: "copy-manifest", status: "blocked" })
    expect(result.gates[1]?.message).toContain("inside the retention custody")
  })

  it("refuses eligibility at the retention floor (now == retainUntil)", () => {
    const result = verifyRetainedEntry({
      entry: base.entry,
      root: base.root,
      artifactDir: base.artifactDir,
      clock: new Date(Date.parse(base.retainUntil)),
    })
    expect(result.verdict).toBe("blocked")
    expect(result.gates[0]).toMatchObject({ gate: "identity-eligibility", status: "blocked" })
  })

  it("refuses a changed byte inside the copied store", () => {
    const target = firstFile(join(base.entry, "modules"))
    writeFileSync(target, `${readFileSync(target, "utf8")}changed`)
    const result = verifyRetainedEntry({
      entry: base.entry,
      root: base.root,
      artifactDir: base.artifactDir,
      clock: eligible(),
    })
    expect(result.verdict).toBe("blocked")
    expect(result.gates[1]).toMatchObject({ gate: "copy-manifest", status: "blocked" })
  })

  it("refuses an extra wrapper file beside the manifest", () => {
    writeFileSync(join(base.entry, "notes.txt"), "unrecorded\n")
    const result = verifyRetainedEntry({
      entry: base.entry,
      root: base.root,
      artifactDir: base.artifactDir,
      clock: eligible(),
    })
    expect(result.verdict).toBe("blocked")
    expect(result.gates[1]).toMatchObject({ gate: "copy-manifest", status: "blocked" })
  })

  it("refuses an entry that is not a direct child of the declared root", () => {
    const nested = join(base.entry, "nested")
    mkdirSync(nested, { recursive: true })
    const result = verifyRetainedEntry({
      entry: nested,
      root: base.root,
      artifactDir: base.artifactDir,
      clock: eligible(),
    })
    expect(result.verdict).toBe("blocked")
    expect(result.gates[0]).toMatchObject({ gate: "identity-eligibility", status: "blocked" })
    expect(JSON.stringify(result.gates[0])).toContain("direct child")
  })

  it("refuses an entry with no manifest", () => {
    rmSync(join(base.entry, "manifest.json"))
    const result = verifyRetainedEntry({
      entry: base.entry,
      root: base.root,
      artifactDir: base.artifactDir,
      clock: eligible(),
    })
    expect(result.verdict).toBe("blocked")
    expect(result.gates[0]).toMatchObject({ gate: "identity-eligibility", status: "blocked" })
  })

  it("reports a legacy manifest as unknown rather than a violated condition", () => {
    const manifestPath = join(base.entry, "manifest.json")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
    delete manifest["writerLocks"]
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    const result = verifyRetainedEntry({
      entry: base.entry,
      root: base.root,
      artifactDir: base.artifactDir,
      clock: eligible(),
    })
    expect(result.verdict).toBe("unknown")
    expect(result.gates[0]).toMatchObject({ gate: "identity-eligibility", status: "unknown" })
  })

  it("refuses a present but malformed proof field", () => {
    const manifestPath = join(base.entry, "manifest.json")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
    manifest["writerLocks"] = "not-an-array"
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    const result = verifyRetainedEntry({
      entry: base.entry,
      root: base.root,
      artifactDir: base.artifactDir,
      clock: eligible(),
    })
    expect(result.verdict).toBe("blocked")
    expect(result.gates[0]).toMatchObject({ gate: "identity-eligibility", status: "blocked" })
  })

  it("reports the estate and custody gates unknown without a declared namespace", () => {
    const result = verifyRetainedEntry({
      entry: base.entry,
      root: base.root,
      artifactDir: base.artifactDir,
      clock: eligible(),
    })
    expect(result.verdict).toBe("unknown")
    expect(result.gates[2]).toMatchObject({ gate: "estate-inventory", status: "unknown" })
    expect(result.gates[3]).toMatchObject({ gate: "candidate-contents", status: "unknown" })
  })

  it("exposes the verdict through the CLI, refusing before the retention floor", async () => {
    const stdout = outputSink()
    const code = await runCli(
      [
        "--repo",
        base.root,
        "--json",
        "worktree",
        "retention",
        "verify",
        base.entry,
        "--root",
        base.root,
        "--artifact-dir",
        base.artifactDir,
      ],
      stdout,
      outputSink(),
    )
    expect(code).toBe(1)
    const result = JSON.parse(stdout.output) as { verdict: string; gates: Array<{ gate: string; status: string }> }
    expect(result.verdict).toBe("blocked")
    expect(result.gates[0]).toMatchObject({ gate: "identity-eligibility", status: "blocked" })
  })

  it("exits 0 through the CLI only on a full candidate pass", async () => {
    // The CLI reads the real clock, so bring the recorded retention floor into the past first;
    // only `retainUntil` changes, and gate 2 compares the copied subtree, not these bytes.
    const manifestPath = join(base.entry, "manifest.json")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
    manifest["retainUntil"] = new Date(Date.now() - 1000).toISOString()
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    const stdout = outputSink()
    const code = await runCli(
      [
        "--repo",
        base.root,
        "--json",
        "worktree",
        "retention",
        "verify",
        base.entry,
        "--root",
        base.root,
        "--namespace",
        fixtureRoot as string,
        "--artifact-dir",
        base.artifactDir,
      ],
      stdout,
      outputSink(),
    )
    expect(code).toBe(0)
    expect((JSON.parse(stdout.output) as { verdict: string }).verdict).toBe("candidate")
  })

  it("requires the declared root instead of inferring it", async () => {
    const stdout = outputSink()
    const code = await runCli(["worktree", "retention", "verify", base.entry], stdout, outputSink())
    expect(code).not.toBe(0)
    expect(stdout.output).toBe("")
  })
})
