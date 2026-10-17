/** Quote a value as one POSIX sh word that reads back unchanged, for execution or display. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}
