/**
 * Run `task` over `items` with at most `limit` in flight, and answer in input
 * order. Every item runs to completion; the first failure BY INPUT POSITION is
 * rethrown, so a concurrent plan fails on the same update a sequential one did.
 */
export async function mapInOrder<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const settled: ({ ok: true; value: R } | { ok: false; error: unknown })[] = []
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next
      next += 1
      const item = items[index] as T
      try {
        settled[index] = { ok: true, value: await task(item) }
      } catch (error) {
        settled[index] = { ok: false, error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return settled.map((outcome) => {
    if (!outcome.ok) throw outcome.error
    return outcome.value
  })
}
