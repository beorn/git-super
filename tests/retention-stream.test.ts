/**
 * @failure The retirement proof holds whole OID sets in memory, trusts a sidecar by its name, or
 * buffers an unbounded child's output instead of killing it at the cap.
 * @level l1
 * @consumer the read-only retention verifier, gates 4-6; #27443(b)
 * @testonly none
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import {
  externalSortToSidecar,
  gitLineStream,
  mergeLabeledFiles,
  mergeSorted,
  mergeSortedFilesToSidecar,
  oidKey,
  readLines,
  RETENTION_STREAM_RSS_BOUND_BYTES,
  SidecarWriter,
} from "../src/retention-stream.ts"

const cleanup: string[] = []
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true })
})

function tmp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  cleanup.push(path)
  return path
}

async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
  const lines: string[] = []
  for await (const line of iterable) lines.push(line)
  return lines
}

function linesOf(values: readonly string[]): AsyncIterable<string> {
  return (async function* () {
    for (const value of values) yield value
  })()
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

describe("retention stream primitives (#27443(b))", () => {
  test("externalSortToSidecar sorts, deduplicates, and names the file by its own bytes", async () => {
    const dir = tmp("git-super-stream-")
    const ref = await externalSortToSidecar(linesOf(["ccc", "aaa", "bbb", "aaa"]), { dir })
    expect(await collect(readLines(ref.path))).toEqual(["aaa", "bbb", "ccc"])
    expect(ref.path).toBe(join(dir, `${ref.sha256}.txt`))
    expect(ref.count).toBe(3)
    expect(ref.sha256).toBe(sha256(readFileSync(ref.path)))
  })

  test("a rerun of the same lines reuses the identical content-addressed sidecar", async () => {
    const dir = tmp("git-super-stream-")
    const first = await externalSortToSidecar(linesOf(["b", "a"]), { dir })
    const second = await externalSortToSidecar(linesOf(["b", "a"]), { dir })
    expect(second.path).toBe(first.path)
    expect(second.sha256).toBe(first.sha256)
    expect(readFileSync(second.path, "utf8")).toBe(readFileSync(first.path, "utf8"))
  })

  test("a tampered sidecar of the right name is refused, never silently reused", async () => {
    const dir = tmp("git-super-stream-")
    const ref = await externalSortToSidecar(linesOf(["b", "a"]), { dir })
    writeFileSync(ref.path, "tampered\n")
    await expect(externalSortToSidecar(linesOf(["b", "a"]), { dir })).rejects.toThrow(/read-back mismatch/u)
  })

  test("an unwritable sidecar directory is refused, never a silent pass", async () => {
    const root = tmp("git-super-stream-")
    writeFileSync(join(root, "file"), "x")
    await expect(externalSortToSidecar(linesOf(["a"]), { dir: join(root, "file", "sidecars") })).rejects.toThrow()
  })

  test("mergeSorted groups each key's lines in ascending key order", async () => {
    const seen: Array<readonly [string, readonly string[]]> = []
    await mergeSorted(
      [
        { label: "left", lines: linesOf(["b\t2", "d\t4"]), keyOf: oidKey },
        { label: "right", lines: linesOf(["a\t1", "b\t9", "c\t3"]), keyOf: oidKey },
      ],
      (key, groups) => {
        seen.push([key, groups.flatMap((group) => group.lines)])
      },
    )
    expect(seen).toEqual([
      ["a", ["a\t1"]],
      ["b", ["b\t2", "b\t9"]],
      ["c", ["c\t3"]],
      ["d", ["d\t4"]],
    ])
  })

  test("mergeSortedFilesToSidecar batches fan-in without losing or reordering keys", async () => {
    const dir = tmp("git-super-stream-")
    const chunks: string[][] = [["a", "e"], ["b", "f"], ["c", "g"], ["d", "h"], ["i"]]
    const inputs = chunks.map((chunk, index) => {
      const path = join(dir, `input-${index}`)
      writeFileSync(path, chunk.map((line) => `${line}\n`).join(""))
      return path
    })
    const ref = await mergeSortedFilesToSidecar(inputs, {
      dir,
      keyOf: oidKey,
      pick: (group) => group[0],
      maxFanIn: 2,
      deleteInputs: true,
    })
    expect(await collect(readLines(ref.path))).toEqual(["a", "b", "c", "d", "e", "f", "g", "h", "i"])
  })

  test("SidecarWriter hashes bytes it writes and reads them back before renaming", async () => {
    const dir = tmp("git-super-stream-")
    const writer = new SidecarWriter(dir)
    writer.add("one")
    writer.add("two")
    const ref = await writer.finish()
    expect(ref.count).toBe(2)
    expect(ref.bytes).toBe(Buffer.byteLength("one\ntwo\n"))
    expect(ref.sha256).toBe(sha256(readFileSync(ref.path)))
  })

  test("gitLineStream counts bytes and lines and reports a clean exit", async () => {
    const stream = gitLineStream(["--version"])
    const lines = await collect(stream.lines)
    const outcome = await stream.outcome
    expect(lines[0]).toMatch(/^git version /u)
    expect(outcome.code).toBe(0)
    expect(outcome.lines).toBe(1)
    expect(outcome.bytes).toBeGreaterThan(0)
    expect(outcome.capped).toBe(false)
    expect(outcome.timedOut).toBe(false)
  })

  test("gitLineStream kills the child at the line cap rather than buffering its output", async () => {
    const root = tmp("git-super-stream-repo-")
    const environment = {
      ...process.env,
      GIT_AUTHOR_NAME: "S",
      GIT_AUTHOR_EMAIL: "s@e",
      GIT_COMMITTER_NAME: "S",
      GIT_COMMITTER_EMAIL: "s@e",
    }
    try {
      const run = spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root, env: environment })
      expect(run.status).toBe(0)
      writeFileSync(join(root, "a.txt"), "alpha\n")
      spawnSync("git", ["add", "a.txt"], { cwd: root, env: environment })
      spawnSync("git", ["commit", "-q", "-m", "first"], { cwd: root, env: environment })
      const stream = gitLineStream(
        [`--git-dir=${join(root, ".git")}`, "cat-file", "--batch-all-objects", "--batch-check"],
        {
          maxLines: 2,
        },
      )
      const lines = await collect(stream.lines)
      const outcome = await stream.outcome
      expect(lines.length).toBe(2)
      expect(outcome.capped).toBe(true)
      expect(outcome.lines).toBe(2)
    } finally {
      void environment
    }
  })

  test("gitLineStream kills a hung child at its deadline", async () => {
    const bin = tmp("git-super-stream-bin-")
    writeFileSync(join(bin, "git"), "#!/bin/sh\nexec sleep 5\n", { mode: 0o755 })
    const saved = process.env.PATH
    process.env.PATH = `${bin}:${saved ?? ""}`
    const started = Date.now()
    try {
      const stream = gitLineStream(["--version"], { timeoutMs: 200 })
      await collect(stream.lines)
      const outcome = await stream.outcome
      expect(outcome.timedOut).toBe(true)
      expect(outcome.code).not.toBe(0)
      expect(Date.now() - started).toBeLessThan(3_000)
    } finally {
      process.env.PATH = saved
    }
  })

  test("gitLineStream keeps a fast child's whole output when the first pull happens after it exits", async () => {
    // The verifier opens one child per object store and pulls them in sequence, so a store whose
    // child exits before its turn used to read an ended pipe and silently yield zero lines — a
    // whole store dropped from the proof. The stream must drain the child from spawn, not from the
    // first pull. Without the eager pump this is deterministically 0 lines.
    const root = tmp("git-super-stream-eager-")
    const environment = {
      ...process.env,
      GIT_AUTHOR_NAME: "S",
      GIT_AUTHOR_EMAIL: "s@e",
      GIT_COMMITTER_NAME: "S",
      GIT_COMMITTER_EMAIL: "s@e",
    }
    try {
      const run = spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root, env: environment })
      expect(run.status).toBe(0)
      writeFileSync(join(root, "a.txt"), "alpha\n")
      spawnSync("git", ["add", "a.txt"], { cwd: root, env: environment })
      spawnSync("git", ["commit", "-q", "-m", "first"], { cwd: root, env: environment })
      const stream = gitLineStream([
        `--git-dir=${join(root, ".git")}`,
        "cat-file",
        "--batch-all-objects",
        "--batch-check",
      ])
      await new Promise((resolve) => setTimeout(resolve, 300))
      const lines = await collect(stream.lines)
      const outcome = await stream.outcome
      expect(lines.length).toBe(3)
      expect(outcome.lines).toBe(3)
      expect(outcome.bytes).toBeGreaterThan(0)
      expect(outcome.code).toBe(0)
    } finally {
      void environment
    }
  })
})

async function* scrambledOids(count: number): AsyncGenerator<string> {
  // A bijective scramble so the external sort is actually exercised; 49,999 is coprime with the
  // 2^a * 5^b counts used here.
  const multiplier = 49_999
  for (let index = 0; index < count; index += 1) {
    yield ((index * multiplier) % count).toString(16).padStart(40, "0")
  }
}

async function* ascendingOids(count: number): AsyncGenerator<string> {
  for (let index = 0; index < count; index += 1) yield index.toString(16).padStart(40, "0")
}

async function measurePeakRss(run: () => Promise<void>): Promise<number> {
  const baseline = process.memoryUsage().rss
  let peak = baseline
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss)
  }, 20)
  try {
    await run()
  } finally {
    clearInterval(timer)
  }
  return Math.max(peak, process.memoryUsage().rss) - baseline
}

describe("retention stream bounded memory (#27443(b))", () => {
  test("a bounded pass keeps peak RSS far below the set size, not proportional to it", async () => {
    const dir = tmp("git-super-bounded-")
    const delta = await measurePeakRss(async () => {
      const witness = await externalSortToSidecar(scrambledOids(400_000), { dir })
      const index = await mergeLabeledFiles([{ path: witness.path, label: "0" }], { dir })
      const atRisk = await externalSortToSidecar(ascendingOids(80_000), { dir })
      await mergeSorted(
        [
          { label: "at-risk", lines: readLines(atRisk.path), keyOf: oidKey },
          { label: "index", lines: readLines(index.path), keyOf: oidKey },
        ],
        () => {},
      )
    })
    expect(delta).toBeLessThan(RETENTION_STREAM_RSS_BOUND_BYTES)
  })

  test.runIf(process.env.GIT_SUPER_SCALE === "1")(
    "sorts 4,000,000 at-risk and merges 20,000,000 reachable OIDs under the named RSS bound",
    async () => {
      const dir = mkdtempSync(join("/var/tmp", "git-super-scale-"))
      cleanup.push(dir)
      let witnessed = 0
      const delta = await measurePeakRss(async () => {
        const witness = await externalSortToSidecar(scrambledOids(20_000_000), { dir })
        const index = await mergeLabeledFiles([{ path: witness.path, label: "0" }], { dir })
        const atRisk = await externalSortToSidecar(ascendingOids(4_000_000), { dir })
        await mergeSorted(
          [
            { label: "at-risk", lines: readLines(atRisk.path), keyOf: oidKey },
            { label: "index", lines: readLines(index.path), keyOf: oidKey },
          ],
          (_key, groups) => {
            if (groups.some((group) => group.label === "at-risk") && groups.some((group) => group.label === "index")) {
              witnessed += 1
            }
          },
        )
      })
      expect(witnessed).toBe(4_000_000)
      expect(delta).toBeLessThan(RETENTION_STREAM_RSS_BOUND_BYTES)
    },
    900_000,
  )
})
