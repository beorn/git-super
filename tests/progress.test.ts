/**
 * @failure A periodic progress line repeats the phase it was given at its first tick, so a long
 *          writer-lock wait reports a holder that already left and an age that never moves (30095).
 * @level l1
 * @consumer Yrd submit merge and post-merge worktree add
 */

import { afterEach, describe, expect, test, vi } from "vitest"
import { createProgressReporter } from "../src/progress.ts"

describe("progress reporter", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test("re-reads a live phase on every interval instead of repeating the first string", () => {
    vi.useFakeTimers()
    const lines: string[] = []
    let holder = "first operation (pid:1, age 10ms)"
    const reporter = createProgressReporter(
      (message) => lines.push(message),
      (phase, elapsedMs) => `${phase} +${elapsedMs}ms`,
    )
    reporter.phase(holder, () => holder)
    vi.advanceTimersByTime(9_000)
    holder = "second operation (pid:2, age 5ms)"
    vi.advanceTimersByTime(9_000)
    reporter.cancel()
    expect(lines).toEqual([
      "first operation (pid:1, age 10ms) +0ms",
      "first operation (pid:1, age 10ms) +9000ms",
      "second operation (pid:2, age 5ms) +18000ms",
    ])
  })

  test("a phase without a reader keeps its static string and emits once", () => {
    vi.useFakeTimers()
    const lines: string[] = []
    const reporter = createProgressReporter(
      (message) => lines.push(message),
      (phase, elapsedMs) => `${phase} +${elapsedMs}ms`,
    )
    reporter.phase("apply")
    vi.advanceTimersByTime(9_000)
    reporter.cancel()
    expect(lines).toEqual(["apply +0ms", "apply +9000ms"])
  })
})
