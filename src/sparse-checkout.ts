/** Choose a native cone complement at the exact commit, before its first checkout. */
export async function configureSparseCheckout(
  git: (args: readonly string[]) => Promise<string>,
  commit: string,
  paths: readonly string[],
): Promise<void> {
  const omitted = new Set(paths)
  const parents = new Set([""])
  for (const path of paths) {
    const parts = path.split("/")
    for (let length = 1; length < parts.length; length++) {
      const parent = parts.slice(0, length).join("/")
      if ([...omitted].some((entry) => parent === entry || parent.startsWith(`${entry}/`))) break
      parents.add(parent)
    }
  }
  const included = new Set<string>()
  for (const parent of parents) {
    const tree = parent === "" ? commit : `${commit}:${parent}`
    const entries = (await git(["ls-tree", "-z", tree])).split("\0").filter(Boolean)
    let retainedFile: string | undefined
    for (const entry of entries) {
      const match = /^\d{6} (tree|blob|commit) [a-f0-9]+\t(.+)$/su.exec(entry)
      if (match?.[2] === undefined) throw new Error(`malformed ls-tree entry in ${tree}: ${JSON.stringify(entry)}`)
      const path = parent === "" ? match[2] : `${parent}/${match[2]}`
      if (match[1] === "tree") {
        if (!omitted.has(path) && !parents.has(path)) included.add(path)
      } else {
        retainedFile ??= path
      }
    }
    // An existing file can be a cone leaf with --skip-checks. It keeps the
    // containing directory's direct files even when all its child trees are omitted.
    if (parent !== "" && retainedFile !== undefined) included.add(retainedFile)
  }
  await git(["sparse-checkout", "set", "--cone", "--skip-checks", "--", ...[...included].sort()])
}
