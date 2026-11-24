/**
 * @failure 34787: a retained component entry whose local commits have no durable witness can never be removed, even by
 *          an owner who decides to lose exactly those commits; or a discard that is not bound to the exact loss (wrong
 *          entry, changed manifest, extra un-witnessed objects, unknown commit roots) removes it anyway; or a discard
 *          reads as witnessed custody.
 * @level l1
 * @consumer yrd env retained --discard, which records the decision and then calls `worktree retention retire --discard`
 * @reach fs-walk <fixture-only: isolated mkdtemp Git repositories and an external /var/tmp pass directory the test owns>
 * @testonly none
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tryAcquireFlock } from "@bearly/flock"
import { describe, expect, it } from "vitest"
import { runCli } from "../src/cli.ts"
import { checkRetentionDiscard, RETENTION_DISCARD_SCHEMA, type RetentionDiscard } from "../src/retention-discard.ts"
import { auditRetainedEntry, retireRetainedEntry } from "../src/retention-remove.ts"
import { verifyRetainedEntry, type RetentionVerifyResult } from "../src/retention-verify.ts"
import { createLocalGitWorktreeStore } from "../src/worktree.ts"
import { superWorktreeRemove } from "../src/worktree-remove.ts"
import { retainedManifestOf } from "../src/worktree-removal.ts"
import { canonicalTmpdir, createProductFixture, git } from "./fixture.ts"

type Fixture = Readonly<{
  root: string
  product: string
  entry: string
  retain: string
  local: string
  artifactDir: string
  leases: string[]
}>

/** A retained entry whose component holds one commit nobody else has; retainUntil already passed. */
async function retainedLocalCommit(): Promise<Fixture> {
  const root = await mkdtemp(join(canonicalTmpdir(), "git-super-discard-"))
  const fixture = createProductFixture(root)
  const linked = join(root, "linked")
  await createLocalGitWorktreeStore({ repo: fixture.product }).add({ kind: "detached", path: linked, ref: "HEAD" })
  git(linked, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive")
  const alpha = join(linked, "packages/alpha")
  // Production component stores carry no core.worktree (read 2026-11-18 in /hh/dev/.git/retained-modules); a plain
  // `submodule update` writes a relative one that no longer resolves once the store is retained.
  for (const component of [alpha, join(linked, "vendor/beta")]) git(component, "config", "--unset", "core.worktree")
  await writeFile(join(alpha, "alpha.ts"), "export const alpha = 4\n")
  git(alpha, "commit", "-q", "-am", "local only")
  const local = git(alpha, "rev-parse", "HEAD")
  git(linked, "add", "packages/alpha")
  const retain = join(root, "retained")
  const removed = await superWorktreeRemove({ repo: fixture.product, path: linked, retain, preserved: [] })
  expect(removed.state, removed.detail?.message ?? "").toBe("updated")
  if (removed.proof === undefined) throw new Error("removal returned no proof")
  const entry = dirname(retainedManifestOf(removed.proof))
  const manifestPath = join(entry, "manifest.json")
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
  manifest["retainUntil"] = new Date(Date.now() - 1000).toISOString()
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  const artifactDir = mkdtempSync(join("/var/tmp", "git-super-discard-pass-"))
  const leases: string[] = []
  const pre = await verifyRetainedEntry({
    entry,
    root: retain,
    namespaceRoots: [root],
    artifactDir: join(artifactDir, "lease"),
  })
  for (const objects of pre.estate?.objectDirs ?? []) {
    if (objects.startsWith(`${entry}/`)) continue
    const lockPath = join(dirname(objects), "yrd-worktree-mutations", "writer.lock")
    if (existsSync(lockPath)) continue
    leases.push(lockPath)
    using lease = tryAcquireFlock(lockPath)
    expect(lease?.held).toBe(true)
  }
  return { root, product: fixture.product, entry, retain, local, artifactDir, leases }
}

async function cleanup(fixture: Fixture): Promise<void> {
  // raw-delete-allow: the fixture tree and pass directory this test made under its own mkdtemp roots
  await rm(fixture.root, { recursive: true, force: true })
  rmSync(fixture.artifactDir, { recursive: true, force: true })
}

function preview(fixture: Fixture, name: string, discard?: RetentionDiscard): Promise<RetentionVerifyResult> {
  return verifyRetainedEntry({
    entry: fixture.entry,
    root: fixture.retain,
    namespaceRoots: [fixture.root],
    artifactDir: join(fixture.artifactDir, name),
    ...(discard === undefined ? {} : { discard }),
  })
}

/** The disposition a caller writes from a preview: exactly the loss that preview found. */
function dispositionOf(proof: RetentionVerifyResult, reason = "abandoned experiment"): RetentionDiscard {
  if (proof.custody?.missingSidecar === undefined) throw new Error("preview found no loss")
  return checkRetentionDiscard({
    schema: RETENTION_DISCARD_SCHEMA,
    entry: proof.entry,
    entryDevIno: proof.entryDevIno,
    manifestSha256: proof.manifestSha256,
    missingCount: proof.custody.missingCount,
    missingSidecarSha256: proof.custody.missingSidecar.sha256,
    loss: proof.custody.loss,
    reason,
    attribution: { actor: "@seat/other", owner: null },
  })
}

function retire(fixture: Fixture, name: string, discard?: RetentionDiscard) {
  return retireRetainedEntry({
    entry: fixture.entry,
    root: fixture.retain,
    common: join(fixture.product, ".git"),
    namespaceRoots: [fixture.root],
    artifactDir: join(fixture.artifactDir, name),
    ...(discard === undefined ? {} : { discard }),
  })
}

describe("explicit discard of a retained entry's un-witnessed objects (34787)", () => {
  it("previews the exact loss, keeps gate 5 blocked, and removes only with the matching disposition", async () => {
    const fixture = await retainedLocalCommit()
    try {
      const blocked = await preview(fixture, "preview")
      expect(blocked.verdict, blocked.reasons.join("\n")).toBe("blocked")
      expect(blocked.gates.find((gate) => gate.gate === "positive-custody")?.status).toBe("blocked")
      const component = blocked.custody?.loss.find((entry) => entry.roots?.some((root) => root.oid === fixture.local))
      expect(component?.roots).toEqual([{ oid: fixture.local, subject: "local only" }])

      const kept = await retire(fixture, "plain")
      expect(kept.detail?.code).toBe("custody-unknown")
      expect(existsSync(fixture.entry)).toBe(true)

      const disposition = dispositionOf(blocked)
      const accepted = await preview(fixture, "accepted", disposition)
      expect(accepted.verdict).toBe("discard-candidate")
      // Explicit loss is reported apart from custody: gate 5 never passes and claims no witness.
      expect(accepted.gates.find((gate) => gate.gate === "positive-custody")?.status).toBe("blocked")
      expect(accepted.gates.find((gate) => gate.gate === "certificate")?.status).toBe("pass")
      expect(accepted.explicitLoss).toMatchObject({
        missingCount: blocked.custody?.missingCount,
        reason: "abandoned experiment",
        attribution: { actor: "@seat/other", owner: null },
      })
      const certificate = JSON.parse(readFileSync(accepted.certificate?.path ?? "", "utf8")) as {
        verdict: string
        explicitLoss?: { dispositionSha256: string }
      }
      expect(certificate.verdict).toBe("discard-candidate")
      expect(certificate.explicitLoss?.dispositionSha256).toBe(accepted.explicitLoss?.dispositionSha256)

      const removed = await retire(fixture, "discard", disposition)
      expect(removed.detail?.code, removed.detail?.message).toBe("discarded")
      expect(removed.detail?.message).toContain("no surviving witness is claimed")
      expect(removed.detail?.message).toContain(accepted.explicitLoss?.dispositionSha256 ?? "missing")
      expect(existsSync(fixture.entry)).toBe(false)
    } finally {
      for (const path of fixture.leases) rmSync(dirname(path), { recursive: true, force: true })
      await cleanup(fixture)
    }
  }, 120_000)

  it("keeps the entry when the disposition differs from the loss observed now", async () => {
    const fixture = await retainedLocalCommit()
    try {
      const disposition = dispositionOf(await preview(fixture, "preview"))
      const cases: ReadonlyArray<readonly [string, RetentionDiscard, string]> = [
        ["wrong entry", { ...disposition, entry: join(fixture.retain, "other") }, "entry is"],
        ["wrong identity", { ...disposition, entryDevIno: "1:2" }, "entry identity is"],
        ["changed manifest", { ...disposition, manifestSha256: "0".repeat(64) }, "manifest sha256 is"],
        [
          "uncovered objects",
          { ...disposition, missingCount: disposition.missingCount - 1 || 99 },
          "un-witnessed object(s), not",
        ],
        [
          "other object list",
          { ...disposition, missingSidecarSha256: "f".repeat(64) },
          "missing-object list sha256 is",
        ],
        [
          "other roots",
          { ...disposition, loss: disposition.loss.map((entry) => ({ ...entry, roots: [] })) },
          "per-component loss",
        ],
      ]
      for (const [name, wrong, says] of cases) {
        const result = await retire(fixture, name.replace(/ /gu, "-"), wrong)
        expect(result.detail?.code, name).toBe("discard-refused")
        expect(result.detail?.message, name).toContain("does not name this loss")
        expect(result.detail?.message, name).toContain(says)
        expect(existsSync(fixture.entry), name).toBe(true)
      }
    } finally {
      for (const path of fixture.leases) rmSync(dirname(path), { recursive: true, force: true })
      await cleanup(fixture)
    }
  }, 120_000)

  it("still applies every other gate: an unexpired entry stays, and an audit never takes a disposition", async () => {
    const fixture = await retainedLocalCommit()
    try {
      const disposition = dispositionOf(await preview(fixture, "preview"))
      const audited = await auditRetainedEntry({
        entry: fixture.entry,
        root: fixture.retain,
        common: join(fixture.product, ".git"),
        namespaceRoots: [fixture.root],
        artifactDir: join(fixture.artifactDir, "audit"),
        discard: disposition,
      })
      expect(audited.detail?.code).toBe("discard-refused")
      const manifestPath = join(fixture.entry, "manifest.json")
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
      manifest["retainUntil"] = new Date(Date.now() + 86_400_000).toISOString()
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
      const unexpired = await retire(fixture, "unexpired", disposition)
      expect(unexpired.detail?.code).toBe("unexpired")
      expect(existsSync(fixture.entry)).toBe(true)
    } finally {
      for (const path of fixture.leases) rmSync(dirname(path), { recursive: true, force: true })
      await cleanup(fixture)
    }
  }, 120_000)

  it("takes the disposition from a file on the retire CLI and refuses a malformed one before any effect", async () => {
    const fixture = await retainedLocalCommit()
    try {
      const disposition = dispositionOf(await preview(fixture, "preview"))
      const args = (file: string, name: string) => [
        "--repo",
        fixture.product,
        "--json",
        "worktree",
        "retention",
        "retire",
        fixture.entry,
        "--root",
        fixture.retain,
        "--common",
        join(fixture.product, ".git"),
        "--namespace",
        fixture.root,
        "--artifact-dir",
        join(fixture.artifactDir, name),
        "--discard",
        file,
      ]
      const sink = () => {
        const sinkState = { output: "", write: (chunk: string) => ((sinkState.output += chunk), true) }
        return sinkState
      }
      const bad = join(fixture.artifactDir, "no-reason.json")
      writeFileSync(bad, JSON.stringify({ ...disposition, reason: " " }))
      const badErr = sink()
      expect(await runCli(args(bad, "bad"), sink() as never, badErr as never)).not.toBe(0)
      expect(badErr.output).toContain("discard reason must be a nonempty string")
      expect(existsSync(fixture.entry)).toBe(true)

      const good = join(fixture.artifactDir, "disposition.json")
      writeFileSync(good, JSON.stringify(disposition))
      const out = sink()
      const err = sink()
      expect(await runCli(args(good, "good"), out as never, err as never), err.output || out.output).toBe(0)
      expect(out.output).toContain("discarded")
      expect(existsSync(fixture.entry)).toBe(false)
    } finally {
      for (const path of fixture.leases) rmSync(dirname(path), { recursive: true, force: true })
      await cleanup(fixture)
    }
  }, 120_000)

  it.each([
    ["unknown roots", { rootsUnknown: "too many" }, "roots are unknown cannot be discarded"],
    ["unknown field", { extra: 1 }, "unknown field 'extra'"],
    ["non-string attribution", { attribution: { actor: 7 } }, "retention attribution 'actor' must be a string or null"],
  ])("refuses a disposition with %s", (_name, change, says) => {
    const base = {
      schema: RETENTION_DISCARD_SCHEMA,
      entry: "/x/e",
      entryDevIno: "1:2",
      manifestSha256: "a".repeat(64),
      missingCount: 1,
      missingSidecarSha256: "b".repeat(64),
      loss: [{ component: ".git", count: 1, types: { commit: 1 }, roots: [{ oid: "c".repeat(40), subject: "s" }] }],
      reason: "why",
      attribution: { actor: "@a" },
    }
    const value =
      "rootsUnknown" in change
        ? { ...base, loss: [{ component: ".git", count: 1, types: { commit: 1 }, ...change }] }
        : { ...base, ...change }
    expect(() => checkRetentionDiscard(value)).toThrowError(says)
  })
})
