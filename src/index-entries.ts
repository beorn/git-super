export type IndexEntry = Readonly<{ mode: string; oid: string; stage: number; path: string }>

/** Shared NUL-delimited stage records from ls-files and merge-tree. */
export function parseIndexEntries(
  output: string,
  invalidRecord: (record: string, path: string | undefined) => Error,
): IndexEntry[] {
  return output
    .split("\0")
    .filter((row) => row !== "")
    .map((row) => {
      const separator = row.indexOf("\t")
      const header = separator < 0 ? "" : row.slice(0, separator)
      const match = /^(\d{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])$/iu.exec(header)
      if (separator < 1 || match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
        throw invalidRecord(row, separator < 0 ? undefined : row.slice(separator + 1))
      }
      return { mode: match[1], oid: match[2], stage: Number(match[3]), path: row.slice(separator + 1) }
    })
}
