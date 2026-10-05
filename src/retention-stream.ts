/**
 * Bounded-memory streaming, external sort, k-way merge and content-addressed sidecar primitives
 * for the #27443(b) retirement proof.
 *
 * The verifier's object sets reach 4,000,000 effective and 20,000,000 reachable OIDs. Holding any
 * of them whole in a JS Set/Map/array is the memory blow-up this module removes: every large set
 * is written to a sorted, content-addressed sidecar and consumed as a k-way merge over bounded
 * line readers, so peak memory is the sort run buffer plus one line per source, never the set.
 *
 * A sidecar is named by the sha256 of its own bytes, written to a temporary name in the same
 * directory and renamed once the digest is final. A read-back digest mismatch, a tampered
 * existing sidecar, or an unwritable directory raises, and the caller maps that to `unknown`
 * with no partial certificate.
 */
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { createInterface } from "node:readline"
import { join } from "node:path"
import { StringDecoder } from "node:string_decoder"

/** A durable, content-addressed sidecar: `<dir>/<sha256>.<suffix>`. */
export interface SidecarRef {
  readonly path: string
  readonly sha256: string
  readonly bytes: number
  readonly count: number
}

/** A content-addressed sidecar that could not be written or verified: the caller maps it to `unknown`. */
export class SidecarError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SidecarError"
  }
}

/** The OID prefix of a `key<TAB>payload` line; the whole line when it has no tab. */
export function oidKey(line: string): string {
  const tab = line.indexOf("\t")
  return tab === -1 ? line : line.slice(0, tab)
}

let tempCounter = 0
function tempName(dir: string, prefix: string): string {
  tempCounter += 1
  return join(dir, `.${prefix}-${process.pid}-${tempCounter}`)
}

/**
 * Streams lines to a temporary file, hashing as it goes, then renames to `<sha256>.<suffix>`.
 * `add` is synchronous so a synchronous merge loop can feed it; `finish` reads the temp back and
 * refuses a mismatch. An already-present sidecar is verified rather than trusted, so a tampered
 * file of the right name is `unknown`, never silently reused.
 */
export class SidecarWriter {
  private readonly tempPath: string
  private readonly hash = createHash("sha256")
  private fd: number
  private bytes = 0
  private count = 0
  private finished = false

  constructor(
    readonly dir: string,
    private readonly suffix = "txt",
  ) {
    this.tempPath = tempName(dir, "sidecar")
    try {
      mkdirSync(dir, { recursive: true })
      this.fd = openSync(this.tempPath, "w")
    } catch (error) {
      throw new SidecarError(
        `cannot create sidecar in ${dir}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  add(line: string): void {
    const buffer = Buffer.from(`${line}\n`, "utf8")
    writeSync(this.fd, buffer)
    this.hash.update(buffer)
    this.bytes += buffer.length
    this.count += 1
  }

  async finish(): Promise<SidecarRef> {
    if (this.finished) throw new Error("sidecar writer already finished")
    this.finished = true
    try {
      closeSync(this.fd)
    } catch {
      // silent-fallback-allow: close is best-effort here; an already-closed fd changes nothing
    }
    const sha256 = this.hash.digest("hex")
    const final = join(this.dir, `${sha256}.${this.suffix}`)
    if (existsSync(final)) {
      const existing = await digestFile(final)
      if (existing.sha256 !== sha256 || existing.bytes !== this.bytes) {
        this.discard()
        throw new SidecarError(`existing sidecar ${final} does not match its name: read-back mismatch`)
      }
      this.discard()
      return { path: final, sha256, bytes: this.bytes, count: this.count }
    }
    const readback = await digestFile(this.tempPath)
    if (readback.sha256 !== sha256 || readback.bytes !== this.bytes) {
      this.discard()
      throw new SidecarError(
        `sidecar read-back mismatch in ${this.tempPath}: expected ${sha256}, saw ${readback.sha256}`,
      )
    }
    renameSync(this.tempPath, final)
    return { path: final, sha256, bytes: this.bytes, count: this.count }
  }

  abort(): void {
    if (this.finished) return
    this.finished = true
    try {
      closeSync(this.fd)
    } catch {
      // silent-fallback-allow: abort is best-effort cleanup of an already-finished writer
    }
    this.discard()
  }

  private discard(): void {
    try {
      unlinkSync(this.tempPath)
    } catch {
      // silent-fallback-allow: the temp name may already be renamed or removed; nothing to clean
    }
  }
}

async function digestFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256")
  let bytes = 0
  for await (const chunk of createReadStream(path)) {
    const buffer = chunk as Buffer
    hash.update(buffer)
    bytes += buffer.length
  }
  return { sha256: hash.digest("hex"), bytes }
}

/** Iterates the non-empty lines of a file with a bounded read buffer. */
export async function* readLines(path: string): AsyncGenerator<string> {
  const reader = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  try {
    for await (const line of reader) {
      if (line !== "") yield line
    }
  } finally {
    reader.close()
  }
}

export interface GitStreamOptions {
  /** Hard deadline; the child is killed with SIGKILL at it and reported `timedOut`. */
  readonly timeoutMs?: number
  /** Hard byte cap; the child is killed when stdout exceeds it and reported `capped`. */
  readonly maxBytes?: number
  /** Hard line cap; the child is killed when stdout exceeds it and reported `capped`. */
  readonly maxLines?: number
  /**
   * Observability hook: called with the running maximum of queued stdout lines as the child's
   * output is read. The bounded-memory row uses it to prove the queue never exceeds the pause mark.
   */
  readonly onQueueHighWater?: (depth: number) => void
  /**
   * Test seam: read from this iterable instead of the child's stdout, so a stdout read failure can
   * be injected deterministically. Production always reads the real pipe.
   */
  readonly stdout?: AsyncIterable<Buffer>
}

export interface GitStreamOutcome {
  readonly code: number
  readonly bytes: number
  readonly lines: number
  readonly stderr: string
  readonly timedOut: boolean
  readonly capped: boolean
}

export interface GitLineStream {
  readonly lines: AsyncIterable<string>
  readonly outcome: Promise<GitStreamOutcome>
}

/** The queued-line mark past which the reader stops pulling stdout until the consumer drains. */
export const RETENTION_STREAM_QUEUE_LINES = 2048

export interface StreamFaultMessages {
  /** Message when the child was killed at its deadline. */
  readonly timedOut: string
  /** Message when the child was killed at its byte or line cap. */
  readonly capped: string
  /** Message when the child exited non-zero or its stdout read failed. */
  readonly failed: string
}

class IncompleteStreamError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "IncompleteStreamError"
  }
}

/**
 * The ONE rule every `gitLineStream` consumer applies: a stream that hit its deadline or cap, or
 * exited non-zero, is an incomplete read and must be reported `unknown` — never a partial list.
 * Callers supply one message per cause; this throws the error the retention scans map to `unknown`.
 */
export function assertStreamComplete(outcome: GitStreamOutcome, messages: StreamFaultMessages): void {
  const fault = outcome.timedOut ? "timedOut" : outcome.capped ? "capped" : outcome.code !== 0 ? "failed" : undefined
  if (fault !== undefined) throw new IncompleteStreamError(messages[fault])
}

const MAX_LINE_LENGTH = 1 << 20

/**
 * Spawns git and yields its stdout lines as they arrive, tracking bytes/lines for the caller's
 * cap and deadline checks. The child is a real process, so `capped` and `timedOut` actually stop
 * work instead of buffering an unbounded string first.
 */
export function gitLineStream(args: readonly string[], options: GitStreamOptions = {}): GitLineStream {
  const child = spawn("git", [...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
    },
  })
  let bytes = 0
  let lines = 0
  let capped = false
  let timedOut = false
  let stderr = ""
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < 8192) stderr += chunk.toString("utf8")
  })
  const kill = (): void => {
    try {
      child.kill("SIGKILL")
    } catch {
      // silent-fallback-allow: a child that already exited cannot be signalled; cap/deadline still reported
    }
  }
  const timer =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(
          () => {
            timedOut = true
            kill()
          },
          Math.max(1, options.timeoutMs),
        )

  let resolveClose!: (outcome: GitStreamOutcome) => void
  const closePromise = new Promise<GitStreamOutcome>((resolve) => {
    resolveClose = resolve
  })
  let resolveDone!: () => void
  const donePromise = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  const settle = (code: number): void => {
    if (timer !== undefined) clearTimeout(timer)
    resolveClose({ code, bytes, lines, stderr, timedOut, capped })
  }
  child.on("close", (code) => settle(timedOut ? 1 : (code ?? 1)))
  child.on("error", (error: Error) => {
    stderr = `${stderr}\n${error.message}`.trim()
    settle(1)
  })

  // The child's stdout is drained EAGERLY from spawn, before it can exit: a fast command such as
  // `cat-file --batch-all-objects` on a small store finishes within a tick, and starting the
  // stdout iteration only when the caller first pulls reads an already ended pipe and silently
  // yields nothing (measured: a lazy read lost the whole output in 30/30 trials, which dropped a
  // whole store's OIDs from the proof). Decoded lines land in a bounded queue the caller drains;
  // the reader stops pulling past the bound and resumes as the queue drains, so a slow consumer
  // cannot grow the queue without limit.
  const QUEUE_LINES = RETENTION_STREAM_QUEUE_LINES
  const pending: string[] = []
  let ended = false
  let readFailed = false
  let queueHighWater = 0
  let waiting: (() => void) | undefined
  let draining: (() => void) | undefined
  const wakeConsumer = (): void => {
    if (waiting !== undefined) {
      const resolve = waiting
      waiting = undefined
      resolve()
    }
  }
  const wakeProducer = (): void => {
    if (draining !== undefined) {
      const resolve = draining
      draining = undefined
      resolve()
    }
  }
  const push = (line: string): void => {
    pending.push(line)
    if (options.onQueueHighWater !== undefined && pending.length > queueHighWater) {
      queueHighWater = pending.length
      options.onQueueHighWater(queueHighWater)
    }
    wakeConsumer()
  }
  // Real backpressure: the producer awaits here while the queue is full, so the async iterator
  // stops pulling, the pipe fills, and git blocks on write. `pause()`/`resume()` are no-ops under
  // an async iterator and would let the queue grow without bound.
  const waitForCapacity = async (): Promise<void> => {
    while (pending.length >= QUEUE_LINES) {
      await new Promise<void>((resolve) => {
        draining = resolve
      })
    }
  }
  void (async (): Promise<void> => {
    const decoder = new StringDecoder("utf8")
    let remainder = ""
    try {
      const source = options.stdout ?? (child.stdout as AsyncIterable<Buffer>)
      for await (const chunk of source) {
        bytes += chunk.length
        if (options.maxBytes !== undefined && bytes > options.maxBytes) {
          capped = true
          kill()
          break
        }
        remainder += decoder.write(chunk)
        let index = remainder.indexOf("\n")
        while (index !== -1) {
          const line = remainder.slice(0, index)
          remainder = remainder.slice(index + 1)
          if (line !== "") {
            if (options.maxLines !== undefined && lines >= options.maxLines) {
              capped = true
              kill()
              break
            }
            lines += 1
            push(line)
            if (capped) break
            if (pending.length >= QUEUE_LINES) await waitForCapacity()
          }
          index = remainder.indexOf("\n")
        }
        if (capped) break
        if (remainder.length > MAX_LINE_LENGTH) {
          capped = true
          kill()
          break
        }
        if (pending.length >= QUEUE_LINES) await waitForCapacity()
      }
      if (!capped) {
        const tail = remainder + decoder.end()
        if (tail !== "") {
          if (pending.length >= QUEUE_LINES) await waitForCapacity()
          lines += 1
          push(tail)
        }
      }
    } finally {
      ended = true
      wakeConsumer()
      resolveDone()
    }
  })().catch((error: unknown) => {
    // A stdout read failure is never a silent short read: it lands in `stderr` and forces a
    // non-zero code whatever the close/catch order, so the caller maps the source to `unknown`
    // instead of trusting a partial list.
    readFailed = true
    stderr = `${stderr}\nstdout read failed: ${error instanceof Error ? error.message : String(error)}`.trim()
    ended = true
    wakeConsumer()
    resolveDone()
    settle(1)
  })

  const lineIterable = (async function* (): AsyncGenerator<string> {
    for (;;) {
      while (pending.length > 0) {
        const line = pending.shift()
        if (line === undefined) break
        if (pending.length < QUEUE_LINES) wakeProducer()
        yield line
      }
      if (ended) return
      await new Promise<void>((resolve) => {
        waiting = resolve
      })
    }
  })()

  return {
    lines: lineIterable,
    outcome: (async () => {
      const settled = await closePromise
      await donePromise
      const code = settled.code !== 0 ? settled.code : readFailed || capped || timedOut ? 1 : 0
      return { code, bytes, lines, stderr, timedOut, capped }
    })(),
  }
}

export interface MergeSource {
  readonly label: string
  readonly lines: AsyncIterable<string>
  /** The comparison key of a line; defaults to the whole line. */
  readonly keyOf?: (line: string) => string
}

export type MergeConsumer = (
  key: string,
  groups: readonly Readonly<{ label: string; lines: readonly string[] }>[],
) => void | Promise<void>

/**
 * k-way merge over already-sorted line sources. For each distinct key (in ascending string order)
 * the consumer receives every source's consecutive lines for that key. Memory is one pending line
 * per source plus the per-key groups, never the whole set.
 */
export async function mergeSorted(sources: readonly MergeSource[], consume: MergeConsumer): Promise<void> {
  const state = sources.map((source) => ({
    label: source.label,
    keyOf: source.keyOf ?? ((line: string) => line),
    iterator: source.lines[Symbol.asyncIterator](),
    current: undefined as string | undefined,
    done: false,
  }))
  for (const source of state) {
    const next = await source.iterator.next()
    if (next.done === true) source.done = true
    else source.current = next.value
  }
  for (;;) {
    let minKey: string | undefined
    for (const source of state) {
      if (source.done || source.current === undefined) continue
      const key = source.keyOf(source.current)
      if (minKey === undefined || key < minKey) minKey = key
    }
    if (minKey === undefined) return
    const groups: { label: string; lines: string[] }[] = []
    for (const source of state) {
      if (source.done || source.current === undefined || source.keyOf(source.current) !== minKey) continue
      const collected: string[] = []
      while (!source.done && source.current !== undefined && source.keyOf(source.current) === minKey) {
        collected.push(source.current)
        const next = await source.iterator.next()
        if (next.done === true) {
          source.done = true
          source.current = undefined
        } else {
          source.current = next.value
        }
      }
      groups.push({ label: source.label, lines: collected })
    }
    await consume(minKey, groups)
  }
}

export interface SidecarSortOptions {
  readonly dir: string
  /** Soft bound on lines held in memory for one sort run. */
  readonly runLines?: number
  readonly suffix?: string
  readonly maxFanIn?: number
}

/** 250,000 OID lines is ~12 MB; the run buffer, not the set, bounds sort memory. */
export const DEFAULT_SORT_RUN_LINES = 250_000
export const DEFAULT_MAX_FAN_IN = 128

/**
 * The named peak-RSS budget for one bounded pass: the sort run buffer plus one pending line per
 * merge source, never the OID set. Measured on the synthetic 4,000,000-at-risk /
 * 20,000,000-reachable fixture in `tests/retention-stream.test.ts`: three runs of the dev host
 * measured 601, 731 and 819 MB of RSS growth (the runtime's garbage collector lags the ~20M
 * short-lived OID strings, which is what the peak samples, not a retained set). The bound is 1
 * GiB, above the observed peak with margin and far below the multi-gigabyte cost of holding the
 * 20M reachable OIDs in one Set/Map.
 */
export const RETENTION_STREAM_RSS_BOUND_BYTES = 1024 * 1024 * 1024

function sortLines(lines: string[]): string[] {
  return lines.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

function writeRun(dir: string, lines: string[]): string {
  sortLines(lines)
  const path = tempName(dir, "run")
  writeFileSync(path, lines.map((line) => `${line}\n`).join(""))
  return path
}

/**
 * Bounded-memory external sort of a line stream into one sorted, deduplicated sidecar. The stream
 * is consumed once into sorted runs; the runs are then k-way merged in bounded-fan-in rounds.
 */
export async function externalSortToSidecar(
  lines: AsyncIterable<string> | Iterable<string>,
  options: SidecarSortOptions,
): Promise<SidecarRef> {
  const runLines = options.runLines ?? DEFAULT_SORT_RUN_LINES
  const dir = options.dir
  mkdirSync(dir, { recursive: true })
  const runs: string[] = []
  let buffer: string[] = []
  try {
    for await (const line of lines) {
      if (line === "") continue
      buffer.push(line)
      if (buffer.length >= runLines) {
        runs.push(writeRun(dir, buffer))
        buffer = []
      }
    }
    if (buffer.length > 0) {
      runs.push(writeRun(dir, buffer))
      buffer = []
    }
    if (runs.length === 0) {
      const empty = new SidecarWriter(dir, options.suffix ?? "txt")
      return await empty.finish()
    }
    return await mergeSortedFilesToSidecar(runs, {
      dir,
      keyOf: oidKey,
      pick: (group) => group[0],
      suffix: options.suffix ?? "txt",
      maxFanIn: options.maxFanIn ?? DEFAULT_MAX_FAN_IN,
      deleteInputs: true,
    })
  } catch (error) {
    for (const run of runs) {
      try {
        unlinkSync(run)
      } catch {
        // silent-fallback-allow: a run file may already be consumed; cleanup of temporaries is best-effort
      }
    }
    throw error
  }
}

export interface MergeFilesOptions {
  readonly dir: string
  readonly keyOf: (line: string) => string
  /** Chooses the single output line for a key, or drops the key with `undefined`. */
  readonly pick: (group: readonly string[]) => string | undefined
  readonly suffix?: string
  readonly maxFanIn?: number
  /** When true, the input paths are temporaries and are removed once consumed. */
  readonly deleteInputs?: boolean
}

/**
 * Merges already-sorted files into one sorted, reduced sidecar, batching the fan-in so a caller
 * may pass thousands of inputs (one per witness ref) without opening them all at once.
 */
export async function mergeSortedFilesToSidecar(
  paths: readonly string[],
  options: MergeFilesOptions,
): Promise<SidecarRef> {
  const maxFanIn = Math.max(2, options.maxFanIn ?? DEFAULT_MAX_FAN_IN)
  let level: string[] = [...paths]
  const temporary = new Set<string>(options.deleteInputs === true ? level : [])
  const writer = new SidecarWriter(options.dir, options.suffix ?? "txt")
  try {
    while (level.length > maxFanIn) {
      const next: string[] = []
      for (let index = 0; index < level.length; index += maxFanIn) {
        const group = level.slice(index, index + maxFanIn)
        next.push(await reduceMergeGroup(group, options))
        for (const path of group) removeTemp(path, temporary)
      }
      level = next
      for (const path of next) temporary.add(path)
    }
    await mergeSorted(
      level.map((path) => ({ label: path, lines: readLines(path), keyOf: options.keyOf })),
      (_key, groups) => {
        const picked = options.pick(groups.flatMap((group) => group.lines))
        if (picked !== undefined) writer.add(picked)
      },
    )
    for (const path of level) removeTemp(path, temporary)
    return await writer.finish()
  } catch (error) {
    writer.abort()
    const leftovers = [...temporary]
    for (const path of leftovers) removeTemp(path, temporary)
    throw error
  }
}

async function reduceMergeGroup(group: readonly string[], options: MergeFilesOptions): Promise<string> {
  // Stream the merged group to its file: a merge of already-sorted inputs IS sorted, so the output
  // needs no in-memory array or re-sort, and a merge level larger than the fan-in stays bounded.
  const path = tempName(options.dir, "merge")
  const fd = openSync(path, "w")
  try {
    await mergeSorted(
      group.map((input) => ({ label: input, lines: readLines(input), keyOf: options.keyOf })),
      (_key, groups) => {
        const picked = options.pick(groups.flatMap((entry) => entry.lines))
        if (picked !== undefined) writeSync(fd, Buffer.from(`${picked}\n`, "utf8"))
      },
    )
  } finally {
    closeSync(fd)
  }
  return path
}

function removeTemp(path: string, temporary: Set<string>): void {
  temporary.delete(path)
  rmSync(path, { force: true })
}

export interface LabeledSortSource {
  readonly path: string
  /** Orders the sources; compare as strings, so zero-pad a numeric rank. */
  readonly label: string
}

async function* decorateLines(lines: AsyncIterable<string>, label: string): AsyncGenerator<string> {
  for await (const line of lines) yield `${line}\t${label}`
}

function pickFirst(groups: readonly Readonly<{ label: string; lines: readonly string[] }>[]): string | undefined {
  const first = groups[0]
  return first === undefined ? undefined : first.lines[0]
}

async function writeMergePick(
  entries: readonly Readonly<{ path: string; lines: () => AsyncIterable<string> }>[],
  path: string,
): Promise<void> {
  const fd = openSync(path, "w")
  try {
    await mergeSorted(
      entries.map((entry) => ({ label: entry.path, lines: entry.lines(), keyOf: oidKey })),
      (_key, groups) => {
        const picked = pickFirst(groups)
        if (picked !== undefined) writeSync(fd, Buffer.from(`${picked}\n`, "utf8"))
      },
    )
  } finally {
    closeSync(fd)
  }
}

/**
 * Merges sorted OID-list files under a bounded fan-in, tagging each surviving OID with the
 * smallest-ranked source label that carries it. Intermediate files are temporary; the input files
 * are left in place (they are the durable per-ref/witness sidecars). Output lines are
 * `<oid>\t<label>`, sorted by OID.
 */
export async function mergeLabeledFiles(
  sources: readonly LabeledSortSource[],
  options: { readonly dir: string; readonly maxFanIn?: number },
): Promise<SidecarRef> {
  const fanIn = Math.max(2, options.maxFanIn ?? DEFAULT_MAX_FAN_IN)
  const dir = options.dir
  mkdirSync(dir, { recursive: true })
  const temps: string[] = []
  try {
    let level: Array<{ path: string; lines: () => AsyncIterable<string> }> = sources.map((source) => ({
      path: source.path,
      lines: () => decorateLines(readLines(source.path), source.label),
    }))
    while (level.length > fanIn) {
      const next: Array<{ path: string; lines: () => AsyncIterable<string> }> = []
      for (let index = 0; index < level.length; index += fanIn) {
        const group = level.slice(index, index + fanIn)
        const path = tempName(dir, "labeled")
        temps.push(path)
        await writeMergePick(group, path)
        next.push({ path, lines: () => readLines(path) })
      }
      level = next
    }
    const writer = new SidecarWriter(dir, "txt")
    await mergeSorted(
      level.map((entry) => ({ label: entry.path, lines: entry.lines(), keyOf: oidKey })),
      (_key, groups) => {
        const picked = pickFirst(groups)
        if (picked !== undefined) writer.add(picked)
      },
    )
    return await writer.finish()
  } finally {
    for (const path of temps) rmSync(path, { force: true })
  }
}
