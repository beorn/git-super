/** One periodic report path for push phases and repository writer-lock waits. */
const PROGRESS_INTERVAL_MS = 9_000

export function createProgressReporter(
  report: ((message: string) => void) | undefined,
  format: (phase: string, elapsedMs: number) => string,
): Readonly<{ phase(name: string): void; cancel(): void }> {
  const startedAt = Date.now()
  let current: string | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let failure: { error: unknown } | undefined
  const stop = (): void => {
    if (timer !== undefined) globalThis.clearInterval(timer)
    timer = undefined
  }
  const check = (): void => {
    if (failure !== undefined) throw failure.error
  }
  const emit = (): void => {
    if (current === undefined) throw new Error("git-super progress: phase was not set")
    report?.(format(current, Date.now() - startedAt))
  }
  return {
    phase(name): void {
      check()
      current = name
      emit()
      if (report !== undefined && timer === undefined) {
        timer = globalThis.setInterval(() => {
          try {
            emit()
          } catch (error) {
            failure = { error }
            stop()
          }
        }, PROGRESS_INTERVAL_MS)
        timer.unref?.()
      }
    },
    cancel(): void {
      stop()
      check()
    },
  }
}
