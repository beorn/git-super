/**
 * @failure A retained entry is verified from a partial walk, or a preliminary `candidate` is read as removal authority.
 * @level l1
 * @consumer Yrd environment close through git-super worktree remove --retain; #27443(b)
 * @reach fs-walk <fixture-only: the real retention writer, worktree add/remove and the estate scan use mkdtempSync(tmpdir()) Git repos>
 * @testonly none
 */
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { runCli } from "../src/cli.ts"
import { scanContents, type ComponentContents } from "../src/retention-contents.ts"
import { scanCustody } from "../src/retention-custody.ts"
import { scanEstate } from "../src/retention-estate.ts"
import { readLines, SidecarWriter } from "../src/retention-stream.ts"
import {
  DEFAULT_NON_OBJECT_METADATA_BOUNDS,
  retentionRemovalBoundary,
  verifyRetainedEntry,
} from "../src/retention-verify.ts"
import type { ManifestEntry } from "../src/worktree-removal.ts"

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

async function atRiskComponent(
  sidecarDir: string,
  rows: ReadonlyArray<{ oid: string; type: string; source: string }>,
): Promise<ComponentContents> {
  const writer = new SidecarWriter(sidecarDir, "txt")
  for (const row of [...rows].sort((left, right) => (left.oid < right.oid ? -1 : 1))) {
    writer.add(`${row.oid}\t${row.type}\t${row.source}`)
  }
  return {
    component: ".git",
    effective: rows.length,
    independent: 0,
    atRisk: rows.length,
    atRiskSidecar: await writer.finish(),
    missingRoots: 0,
    missingRootsSample: [],
    elapsedMs: 0,
  }
}

async function sidecarRows(path: string): Promise<string[]> {
  const rows: string[] = []
  for await (const line of readLines(path)) rows.push(line)
  return rows
}

describe("retention verify gates 1-6", () => {
  it("reaches candidate only through gate 6 and never claims removal authority", async () => {
    const result = await verifyRetainedEntry({
      entry: base.entry,
      root: base.root,
      namespaceRoots: [fixtureRoot as string],
      artifactDir: base.artifactDir,
      allowTemporaryArtifactDir: true,
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

  it("reports gate 2 unknown when no external pass directory was supplied", async () => {
    const result = await verifyRetainedEntry({ entry: base.entry, root: base.root, clock: eligible() })
    expect(result.verdict).toBe("unknown")
    expect(result.gates[1]).toMatchObject({ gate: "copy-manifest", status: "unknown" })
    expect(retentionRemovalBoundary(result).authorized).toBe(false)
  })

  it("refuses a pass directory inside the retention custody", async () => {
    const result = await verifyRetainedEntry({
      entry: base.entry,
      root: base.root,
      artifactDir: join(base.root, "inside"),
      clock: eligible(),
    })
    expect(result.verdict).toBe("blocked")
    expect(result.gates[1]).toMatchObject({ gate: "copy-manifest", status: "blocked" })
    expect(result.gates[1]?.message).toContain("inside the retention custody")
  })

  it("refuses eligibility at the retention floor (now == retainUntil)", async () => {
    const result = await verifyRetainedEntry({
      entry: base.entry,
      root: base.root,
      artifactDir: base.artifactDir,
      clock: new Date(Date.parse(base.retainUntil)),
    })
    expect(result.verdict).toBe("blocked")
    expect(result.gates[0]).toMatchObject({ gate: "identity-eligibility", status: "blocked" })
  })

  it("refuses a changed byte inside the copied store", async () => {
    const target = firstFile(join(base.entry, "modules"))
    writeFileSync(target, `${readFileSync(target, "utf8")}changed`)
    const result = await verifyRetainedEntry({
      entry: base.entry,
      root: base.root,
      artifactDir: base.artifactDir,
      clock: eligible(),
    })
    expect(result.verdict).toBe("blocked")
    expect(result.gates[1]).toMatchObject({ gate: "copy-manifest", status: "blocked" })
  })

  it("refuses an extra wrapper file beside the manifest", async () => {
    writeFileSync(join(base.entry, "notes.txt"), "unrecorded\n")
    const result = await verifyRetainedEntry({
      entry: base.entry,
      root: base.root,
      artifactDir: base.artifactDir,
      clock: eligible(),
    })
    expect(result.verdict).toBe("blocked")
    expect(result.gates[1]).toMatchObject({ gate: "copy-manifest", status: "blocked" })
  })

  it("refuses an entry that is not a direct child of the declared root", async () => {
    const nested = join(base.entry, "nested")
    mkdirSync(nested, { recursive: true })
    const result = await verifyRetainedEntry({
      entry: nested,
      root: base.root,
      artifactDir: base.artifactDir,
      clock: eligible(),
    })
    expect(result.verdict).toBe("blocked")
    expect(result.gates[0]).toMatchObject({ gate: "identity-eligibility", status: "blocked" })
    expect(JSON.stringify(result.gates[0])).toContain("direct child")
  })

  it("refuses an entry with no manifest", async () => {
    rmSync(join(base.entry, "manifest.json"))
    const result = await verifyRetainedEntry({
      entry: base.entry,
      root: base.root,
      artifactDir: base.artifactDir,
      clock: eligible(),
    })
    expect(result.verdict).toBe("blocked")
    expect(result.gates[0]).toMatchObject({ gate: "identity-eligibility", status: "blocked" })
  })

  it("reports a legacy manifest as unknown rather than a violated condition", async () => {
    const manifestPath = join(base.entry, "manifest.json")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
    delete manifest["writerLocks"]
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    const result = await verifyRetainedEntry({
      entry: base.entry,
      root: base.root,
      artifactDir: base.artifactDir,
      clock: eligible(),
    })
    expect(result.verdict).toBe("unknown")
    expect(result.gates[0]).toMatchObject({ gate: "identity-eligibility", status: "unknown" })
  })

  it("refuses a present but malformed proof field", async () => {
    const manifestPath = join(base.entry, "manifest.json")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
    manifest["writerLocks"] = "not-an-array"
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    const result = await verifyRetainedEntry({
      entry: base.entry,
      root: base.root,
      artifactDir: base.artifactDir,
      clock: eligible(),
    })
    expect(result.verdict).toBe("blocked")
    expect(result.gates[0]).toMatchObject({ gate: "identity-eligibility", status: "blocked" })
  })

  it("reports the estate and custody gates unknown without a declared namespace", async () => {
    const result = await verifyRetainedEntry({
      entry: base.entry,
      root: base.root,
      artifactDir: base.artifactDir,
      allowTemporaryArtifactDir: true,
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

  it("keeps the public CLI from certifying a temporary artifact directory", async () => {
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
    // The fixture's pass directory is under the OS temporary directory, so gate 6 can never see
    // durable evidence: the public CLI reports unknown and never a candidate (exit 2).
    expect(code).toBe(2)
    const result = JSON.parse(stdout.output) as {
      verdict: string
      gates: Array<{ gate: string; status: string; message?: string }>
    }
    expect(result.verdict).toBe("unknown")
    expect(result.gates[1]).toMatchObject({ gate: "copy-manifest", status: "unknown" })
    expect(result.gates[1]?.message).toContain("temporary")
  })

  it("non-object metadata over the per-entry bound is unknown with the observed bytes and the cap", async () => {
    const result = await verifyRetainedEntry({
      entry: base.entry,
      root: base.root,
      namespaceRoots: [fixtureRoot as string],
      artifactDir: base.artifactDir,
      allowTemporaryArtifactDir: true,
      clock: eligible(),
      bounds: { metadata: { maxBytes: 1 } },
    })
    expect(result.verdict).toBe("unknown")
    expect(result.gates[1]).toMatchObject({ gate: "copy-manifest", status: "unknown" })
    expect(result.gates[1]?.message).toMatch(/non-object metadata/)
    expect(result.gates[1]?.message).toContain("bound")
  })

  it("defaults the per-entry non-object metadata bound to the contract's 256 MiB", () => {
    expect(DEFAULT_NON_OBJECT_METADATA_BOUNDS.maxBytes).toBe(256 * 1024 * 1024)
  })

  it("does not expose a public temporary-artifact bypass flag", async () => {
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
        "--allow-temporary-artifact",
      ],
      stdout,
      outputSink(),
    )
    expect(code).not.toBe(0)
    expect(stdout.output).toBe("")
  })

  it("requires the declared root instead of inferring it", async () => {
    const stdout = outputSink()
    const code = await runCli(["worktree", "retention", "verify", base.entry], stdout, outputSink())
    expect(code).not.toBe(0)
    expect(stdout.output).toBe("")
  })
})

describe("retention verify fix-forward #27443(b) gaps", () => {
  it("follows alternate targets transitively and blocks a survivor that borrows into the removal set", async () => {
    const scene = mkdtempSync(join(tmpdir(), "estate-transitive-"))
    const roots = join(scene, "S")
    const target = join(scene, "T")
    const removal = join(scene, "E")
    mkdirSync(join(roots, "objects", "info"), { recursive: true })
    mkdirSync(join(target, "objects", "info"), { recursive: true })
    mkdirSync(join(removal, "kept", "objects", "info"), { recursive: true })
    writeFileSync(join(roots, "objects", "info", "alternates"), `${join(target, "objects")}\n`)
    writeFileSync(join(target, "objects", "info", "alternates"), `${join(removal, "kept", "objects")}\n`)
    const result = scanEstate([roots], [removal])
    expect(result.status).toBe("blocked")
    expect(result.objectDirs).toContain(realpathSync(join(target, "objects")))
    expect(result.survivorIntoRemoval.some((edge) => edge.borrower === realpathSync(join(target, "objects")))).toBe(
      true,
    )
  })

  it("keeps a transitive alternate chain that never enters the removal set at pass", async () => {
    const scene = mkdtempSync(join(tmpdir(), "estate-transitive-pass-"))
    const roots = join(scene, "S")
    const target = join(scene, "T")
    mkdirSync(join(roots, "objects", "info"), { recursive: true })
    mkdirSync(join(target, "objects", "info"), { recursive: true })
    writeFileSync(join(roots, "objects", "info", "alternates"), `${join(target, "objects")}\n`)
    const result = scanEstate([roots], [join(scene, "E")])
    expect(result.status).toBe("pass")
  })

  it("reports a malformed borrower registry record unknown", async () => {
    const scene = mkdtempSync(join(tmpdir(), "estate-registry-"))
    const roots = join(scene, "R")
    mkdirSync(join(roots, "git-super-retained-borrowers"), { recursive: true })
    writeFileSync(join(roots, "git-super-retained-borrowers", "broken.json"), "{ not json")
    const result = scanEstate([roots], [join(scene, "E")])
    expect(result.status).toBe("unknown")
    expect(result.detail).toContain("not valid JSON")
  })

  it("reads a valid borrower registry record and reconciles it with the manifest it names", async () => {
    const scene = mkdtempSync(join(tmpdir(), "estate-registry-good-"))
    const roots = join(scene, "R")
    const entry = join(scene, "entry")
    mkdirSync(join(roots, "git-super-retained-borrowers"), { recursive: true })
    mkdirSync(entry, { recursive: true })
    const manifestPath = join(entry, "manifest.json")
    writeFileSync(manifestPath, `${JSON.stringify({ retainUntil: "2020-01-01T00:00:00Z" })}\n`)
    writeFileSync(
      join(roots, "git-super-retained-borrowers", "good.json"),
      `${JSON.stringify({ retained: entry, manifest: manifestPath })}\n`,
    )
    const result = scanEstate([roots], [join(scene, "E")])
    expect(result.status).toBe("pass")
    expect(result.registries).toHaveLength(1)
  })

  it("records the at-risk OID's own type in the sidecar and names the ref whose closure carries it", async () => {
    const scene = mkdtempSync(join(tmpdir(), "custody-type-"))
    const repo = join(scene, "witness")
    const sidecarDir = join(scene, "sidecars")
    mkdirSync(repo, { recursive: true })
    git(repo, ["init", "-q", "-b", "main"])
    writeFileSync(join(repo, "f.txt"), "hello\n")
    git(repo, ["add", "f.txt"])
    git(repo, ["commit", "-q", "-m", "c"])
    const blob = git(repo, ["rev-parse", "HEAD:f.txt"])
    const commit = git(repo, ["rev-parse", "HEAD"])
    const component = await atRiskComponent(sidecarDir, [{ oid: blob, type: "blob", source: "owned" }])
    const result = await scanCustody(repo, [component], [join(repo, ".git", "objects")], [], { sidecarDir })
    expect(result.status).toBe("pass")
    expect(result.witnesses[0]).toMatchObject({ ref: "refs/heads/main", tip: commit })
    expect(await sidecarRows(component.atRiskSidecar.path)).toEqual([`${blob}\tblob\towned`])
  })

  it("refuses a transient operation ref as a durable witness", async () => {
    const scene = mkdtempSync(join(tmpdir(), "custody-transient-"))
    const repo = join(scene, "witness")
    const sidecarDir = join(scene, "sidecars")
    mkdirSync(repo, { recursive: true })
    git(repo, ["init", "-q", "-b", "main"])
    writeFileSync(join(repo, "f.txt"), "hello\n")
    git(repo, ["add", "f.txt"])
    git(repo, ["commit", "-q", "-m", "c"])
    const blob = git(repo, ["rev-parse", "HEAD:f.txt"])
    git(repo, ["update-ref", "refs/rewritten/temporary-review", blob])
    git(repo, ["update-ref", "-d", "refs/heads/main"])
    const component = await atRiskComponent(sidecarDir, [{ oid: blob, type: "blob", source: "owned" }])
    const result = await scanCustody(repo, [component], [join(repo, ".git", "objects")], [], { sidecarDir })
    expect(result.status).toBe("blocked")
  })

  it("subtracts an external objects-symlink target from the at-risk set", async () => {
    const scene = mkdtempSync(join(tmpdir(), "contents-link-"))
    const source = join(scene, "source")
    const component = join(scene, "comp")
    mkdirSync(source, { recursive: true })
    mkdirSync(component, { recursive: true })
    git(source, ["init", "-q", "-b", "main"])
    writeFileSync(join(source, "f.txt"), "hello\n")
    git(source, ["add", "f.txt"])
    git(source, ["commit", "-q", "-m", "c"])
    const commit = git(source, ["rev-parse", "HEAD"])
    git(component, ["init", "-q", "-b", "main"])
    rmSync(join(component, ".git", "objects"), { recursive: true, force: true })
    symlinkSync(join(source, ".git", "objects"), join(component, ".git", "objects"))
    git(component, ["update-ref", "refs/heads/main", commit])
    const entries = {
      ".git/objects/info/alternates": { kind: "file", sha256: "0".repeat(64) },
    } as Record<string, ManifestEntry>
    const result = await scanContents(component, entries, [], {
      sidecarDir: mkdtempSync(join(tmpdir(), "contents-link-sidecars-")),
    })
    expect(result.status).toBe("pass")
    expect(result.components[0]).toMatchObject({ component: ".git", atRisk: 0 })
    expect(result.components[0]!.independent).toBeGreaterThan(0)
  })

  it("refuses a temporary artifact directory as durable evidence", async () => {
    const result = await verifyRetainedEntry({
      entry: base.entry,
      root: base.root,
      namespaceRoots: [fixtureRoot as string],
      artifactDir: base.artifactDir,
      clock: eligible(),
    })
    expect(result.verdict).toBe("unknown")
    expect(result.gates[1]).toMatchObject({ gate: "copy-manifest", status: "unknown" })
    expect(result.gates[1]?.message).toContain("temporary")
  })

  it("still certifies durable evidence with no test seam", async () => {
    // Durable means outside the OS temporary directory. The refusal above and this candidate must
    // stay a pair: the correction for #27443(b) tightened the temporary path, never the durable one.
    // /var/tmp is the OS's persistent scratch, outside tmpdir() and writable on Linux and macOS
    // runners alike. The earlier dirname(tmpdir()) was `/` on Linux CI, where mkdtemp failed EACCES,
    // so the durable case was never exercised there.
    const durableRoot = mkdtempSync(join("/var/tmp", "git-super-retention-durable-"))
    try {
      const result = await verifyRetainedEntry({
        entry: base.entry,
        root: base.root,
        namespaceRoots: [fixtureRoot as string],
        artifactDir: join(durableRoot, "pass"),
        clock: eligible(),
      })
      expect(result.verdict).toBe("candidate")
      expect(result.gates[5]).toMatchObject({ gate: "certificate", status: "pass" })
    } finally {
      rmSync(durableRoot, { recursive: true, force: true })
    }
  })

  it("emits a byte-identical certificate and sidecars on a rerun of the same estate", async () => {
    const artifactDir = mkdtempSync(join(tmpdir(), "verify-rerun-"))
    const options = {
      entry: base.entry,
      root: base.root,
      namespaceRoots: [fixtureRoot as string],
      artifactDir,
      allowTemporaryArtifactDir: true,
      clock: eligible(),
      monotonic: () => 0,
    }
    const first = await verifyRetainedEntry(options)
    expect(first.verdict).toBe("candidate")
    const firstBytes = readFileSync(first.certificate?.path as string, "utf8")
    const sidecarsAfterFirst = readdirSync(join(artifactDir, "sidecars")).sort()
    expect(sidecarsAfterFirst.length).toBeGreaterThan(0)
    const second = await verifyRetainedEntry(options)
    expect(second.certificate?.digest).toBe(first.certificate?.digest)
    expect(readFileSync(second.certificate?.path as string, "utf8")).toBe(firstBytes)
    expect(readdirSync(join(artifactDir, "sidecars")).sort()).toEqual(sidecarsAfterFirst)
    // Content-addressed only: no temporary name (`.<prefix>-<pid>-<n>`) survives a pass.
    expect(sidecarsAfterFirst.every((name) => /^[0-9a-f]{64}\.txt$/u.test(name))).toBe(true)
  })

  it("reports unknown when a previously written sidecar was tampered with", async () => {
    const artifactDir = mkdtempSync(join(tmpdir(), "verify-tamper-"))
    const options = {
      entry: base.entry,
      root: base.root,
      namespaceRoots: [fixtureRoot as string],
      artifactDir,
      allowTemporaryArtifactDir: true,
      clock: eligible(),
      monotonic: () => 0,
    }
    const first = await verifyRetainedEntry(options)
    expect(first.verdict).toBe("candidate")
    // Corrupt every sidecar: whichever ones a rerun re-derives, it must refuse to trust a name.
    for (const name of readdirSync(join(artifactDir, "sidecars"))) {
      writeFileSync(join(artifactDir, "sidecars", name), "tampered\n")
    }
    const second = await verifyRetainedEntry(options)
    expect(second.verdict).toBe("unknown")
    expect(second.reasons.join(" ")).toContain("read-back mismatch")
  })

  it("reports an uncreatable pass directory unknown, never a crash", async () => {
    const scene = mkdtempSync(join(tmpdir(), "verify-unwritable-"))
    writeFileSync(join(scene, "blocker"), "x")
    const result = await verifyRetainedEntry({
      entry: base.entry,
      root: base.root,
      namespaceRoots: [fixtureRoot as string],
      artifactDir: join(scene, "blocker", "pass"),
      allowTemporaryArtifactDir: true,
      clock: eligible(),
    })
    expect(result.verdict).toBe("unknown")
    expect(result.gates[1]).toMatchObject({ gate: "copy-manifest", status: "unknown" })
  })
})
