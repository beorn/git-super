/**
 * @failure The chunk-fed framer and the spawned `gitLineStream` drift: one applies the decoder, the bounds, the
 *          queue and the incomplete-read rules and the other does not, so a supervised host streams a read the
 *          local path would refuse - or refuses one that was complete.
 * @level l1
 * @consumer git-super/process
 * @reach fs-walk <fixture-only: no repository; every byte is written by the test>
 */
import { describe, expect, test } from "vitest"
import {
  assertStreamComplete,
  createGitLineStream,
  RETENTION_STREAM_QUEUE_LINES,
  type GitLineFramer,
} from "../src/retention-stream.ts"

const MESSAGES = { timedOut: "deadline", capped: "cap", failed: "failed", warned: "warned" }
const bytes = (text: string) => new TextEncoder().encode(text)
const collect = async (lines: AsyncIterable<string>): Promise<string[]> => {
  const out: string[] = []
  for await (const line of lines) out.push(line)
  return out
}

async function framed(chunks: readonly string[], options: Parameters<typeof createGitLineStream>[0] = {}) {
  const framer = createGitLineStream(options)
  for (const chunk of chunks) await framer.write(bytes(chunk))
  await framer.end()
  framer.settle({ code: 0 })
  return { lines: await collect(framer.lines), outcome: await framer.outcome }
}

describe("createGitLineStream", () => {
  test("frames LF lines across chunk boundaries and flushes an unterminated final record", async () => {
    const { lines, outcome } = await framed(["alpha\nbe", "ta\ngamma"])
    expect(lines).toEqual(["alpha", "beta", "gamma"])
    expect(outcome).toEqual({ code: 0, bytes: 16, lines: 3, stderr: "", timedOut: false, capped: false })
  })

  test("decodes a multi-byte code point split across two chunks", async () => {
    const encoded = bytes("héllo\n")
    const framer = createGitLineStream()
    await framer.write(encoded.subarray(0, 2))
    await framer.write(encoded.subarray(2))
    await framer.end()
    framer.settle({ code: 0 })
    expect(await collect(framer.lines)).toEqual(["héllo"])
  })

  test("NUL framing keeps every record and its delimiter", async () => {
    const { lines, outcome } = await framed(["a\0", "\0b\0"], { framing: "nul" })
    expect(lines).toEqual(["a\0", "\0", "b\0"])
    expect(outcome.lines).toBe(3)
    expect(lines.join("")).toBe("a\0\0b\0")
  })

  test("a byte cap stops the framing, calls onCap once and settles incomplete", async () => {
    let caps = 0
    const framer = createGitLineStream({ maxBytes: 8, onCap: () => (caps += 1) })
    await framer.write(bytes("12345\n"))
    await framer.write(bytes("6789\n"))
    await framer.write(bytes("ignored\n"))
    await framer.end()
    framer.settle({ code: 0 })
    expect(caps).toBe(1)
    expect(framer.capped).toBe(true)
    expect(await collect(framer.lines)).toEqual(["12345"])
    const outcome = await framer.outcome
    expect(outcome).toMatchObject({ code: 1, capped: true })
    expect(() => assertStreamComplete(outcome, MESSAGES)).toThrow("cap")
  })

  test("a line cap and a per-line bound both stop the framing", async () => {
    const capped = await framed(["a\nb\nc\n"], { maxLines: 2 })
    expect(capped.lines).toEqual(["a", "b"])
    expect(capped.outcome).toMatchObject({ code: 1, capped: true, lines: 2 })
    const long = await framed([`${"x".repeat((1 << 20) + 1)}\n`])
    expect(long.outcome).toMatchObject({ code: 1, capped: true, lines: 0 })
  })

  test("the queue is the bound the producer waits on, and the high-water mark never passes it", async () => {
    const depths: number[] = []
    const framer: GitLineFramer = createGitLineStream({ onQueueHighWater: (depth) => depths.push(depth) })
    const lineCount = RETENTION_STREAM_QUEUE_LINES * 3
    let wrote = false
    const write = framer.write(bytes("line\n".repeat(lineCount))).then(() => {
      wrote = true
    })
    await new Promise((resolve) => setTimeout(resolve, 25))
    // Nobody is consuming, so the producer must be parked at the bound instead of buffering the rest.
    expect(wrote).toBe(false)
    expect(Math.max(...depths)).toBe(RETENTION_STREAM_QUEUE_LINES)
    const consumed: string[] = []
    const drain = (async () => {
      for await (const line of framer.lines) consumed.push(line)
    })()
    await write
    await framer.end()
    framer.settle({ code: 0 })
    await drain
    expect(consumed).toHaveLength(lineCount)
    expect(Math.max(...depths)).toBeLessThanOrEqual(RETENTION_STREAM_QUEUE_LINES)
  })

  test("a stdout read failure settles incomplete whatever the child's exit says", async () => {
    const framer = createGitLineStream()
    await framer.write(bytes("half\n"))
    framer.fail(new Error("EPIPE reading stdout"))
    framer.settle({ code: 0 })
    expect(await framer.outcome).toMatchObject({ code: 1, lines: 1 })
    expect((await framer.outcome).stderr).toContain("stdout read failed")
  })

  test("settlement names each host-proved fault, and a warning still reads as warned", async () => {
    const timedOut = await (async () => {
      const framer = createGitLineStream()
      await framer.end()
      framer.settle({ code: 1, timedOut: true })
      return framer.outcome
    })()
    expect(() => assertStreamComplete(timedOut, MESSAGES)).toThrow("deadline")
    const warned = await (async () => {
      const framer = createGitLineStream()
      await framer.end()
      framer.settle({ code: 0, stderr: "warning: alternate ignored\n" })
      return framer.outcome
    })()
    expect(() => assertStreamComplete(warned, MESSAGES)).toThrow("warned")
    const failed = await (async () => {
      const framer = createGitLineStream()
      await framer.end()
      framer.settle({ code: 0, failure: "process verdict SIGNALED" })
      return framer.outcome
    })()
    expect(failed.stderr).toContain("process verdict SIGNALED")
    expect(() => assertStreamComplete(failed, MESSAGES)).toThrow("failed")
  })
})
