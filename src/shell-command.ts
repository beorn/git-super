/** Quote one argument for a POSIX shell command shown to a human. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}
