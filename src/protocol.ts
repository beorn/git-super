import { closeSync, fstatSync, write } from "node:fs"

const CONTROL_BYTES = 64 * 1024
const GREETING_TIMEOUT_MS = 5_000

export type InvocationProtocol = Readonly<{
  refuse(kind: "waiting" | "rejected" | "unjudged", message: string): Promise<void>
  close(): Promise<void>
}>

function protocolError(message: string): Error {
  return new Error(`git-super: control descriptor 3 in ${process.cwd()}: ${message}`)
}

/** Open only after the caller explicitly requests --protocol-fd=3. */
export async function openInvocationProtocol(): Promise<InvocationProtocol> {
  try {
    const stat = fstatSync(3)
    if (!stat.isSocket() && !stat.isFIFO()) throw new Error("not a pipe or socket")
  } catch (cause) {
    throw protocolError(`expected a readable duplex endpoint: ${String(cause)}`)
  }
  const reader = Bun.file(3).stream().getReader()
  let closed = false
  let invalid: Error | undefined
  let monitored = Promise.resolve()
  const requireValid = () => {
    if (invalid !== undefined) throw invalid
  }
  const close = async () => {
    if (closed) return
    closed = true
    try {
      await reader.cancel()
      await monitored
    } finally {
      try {
        reader.releaseLock()
      } finally {
        closeSync(3)
      }
    }
    requireValid()
  }
  let written = 0
  const send = async (frame: object) => {
    const bytes = Buffer.from(JSON.stringify(frame) + "\n")
    if (written + bytes.length > CONTROL_BYTES) {
      throw protocolError(`producer frames exceed the ${CONTROL_BYTES}-byte limit; no truncated frame was sent`)
    }
    const count = await new Promise<number>((resolve, reject) => {
      write(3, bytes, 0, bytes.length, null, (error, count) => {
        if (error !== null) reject(error)
        else resolve(count)
      })
    })
    written += count
    if (count !== bytes.length) {
      throw protocolError(`frame write stopped after ${count} of ${bytes.length} bytes; it was not retried`)
    }
  }
  try {
    const token = await greeting(reader)
    // Retain one reader through enriched work. A separately delivered second
    // frame must not become valid merely because ready was already written.
    monitored = (async () => {
      try {
        while (true) {
          const next = await reader.read()
          if (next.done) return
          if (next.value.byteLength === 0) continue
          invalid = protocolError("unexpected input after the greeting; expected exactly one frame")
          return
        }
      } catch (error) {
        invalid = protocolError(`cannot read the greeting endpoint: ${String(error)}`)
      }
    })()
    await send({ version: 1, token, ready: true })
    requireValid()
    let refused = false
    return {
      async refuse(kind, message) {
        requireValid()
        if (closed) throw protocolError("cannot send a refusal after closing the endpoint")
        if (refused) throw protocolError("a second refusal is not permitted")
        refused = true
        await send({ version: 1, token, refusal: kind, message })
        requireValid()
      },
      close,
    }
  } catch (error) {
    try {
      await close()
    } catch (closeError) {
      throw protocolError(`${String(error)}; closing the endpoint also failed: ${String(closeError)}`)
    }
    throw error
  }
}

async function greeting(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(protocolError(`no complete greeting within ${GREETING_TIMEOUT_MS}ms`)),
      GREETING_TIMEOUT_MS,
    )
  })
  try {
    let bytes = Buffer.alloc(0)
    while (true) {
      const next = await Promise.race([reader.read(), expired])
      if (next.done) throw protocolError("endpoint closed before a complete greeting")
      bytes = Buffer.concat([bytes, Buffer.from(next.value)])
      if (bytes.length > CONTROL_BYTES) throw protocolError(`greeting exceeds the ${CONTROL_BYTES}-byte limit`)
      const end = bytes.indexOf(10)
      if (end === -1) continue
      if (end !== bytes.length - 1) throw protocolError("expected exactly one greeting frame")
      let frame: unknown
      try {
        frame = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)))
      } catch (error) {
        throw protocolError(`expected one UTF-8 JSON greeting: ${String(error)}`)
      }
      if (
        typeof frame !== "object" ||
        frame === null ||
        Array.isArray(frame) ||
        Object.keys(frame).length !== 2 ||
        !("version" in frame) ||
        frame.version !== 1 ||
        !("token" in frame) ||
        typeof frame.token !== "string" ||
        frame.token === ""
      ) {
        throw protocolError("expected version 1 and one nonempty invocation token")
      }
      return frame.token
    }
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}
