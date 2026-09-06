import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

import ts from "typescript"

const packageRoot = resolve(import.meta.dirname, "..")
const configPath = resolve(packageRoot, "tsconfig.json")
const formatHost: ts.FormatDiagnosticsHost = {
  getCanonicalFileName: (file) => file,
  getCurrentDirectory: () => packageRoot,
  getNewLine: () => ts.sys.newLine,
}

const loaded = ts.readConfigFile(configPath, ts.sys.readFile)
if (loaded.error !== undefined) {
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext([loaded.error], formatHost))
  process.exit(2)
}

const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, packageRoot, { noEmit: true }, configPath)
if (parsed.fileNames.length === 0) {
  process.stderr.write(
    "git-super workspace-composition typecheck: tsconfig.json configured 0 git-super files; refusing to report success\n",
  )
  if (parsed.errors.length > 0) {
    process.stderr.write(ts.formatDiagnosticsWithColorAndContext(parsed.errors, formatHost))
  }
  process.exit(2)
}

const configuredFiles = new Set(parsed.fileNames.map(canonicalFileName))
const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options })
const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)]
const ownedDiagnostics: ts.Diagnostic[] = []
const excludedDiagnostics: Array<ts.Diagnostic & { readonly file: ts.SourceFile }> = []

for (const diagnostic of diagnostics) {
  if (diagnostic.file === undefined || configuredFiles.has(canonicalFileName(diagnostic.file.fileName))) {
    ownedDiagnostics.push(diagnostic)
  } else {
    excludedDiagnostics.push(diagnostic as ts.Diagnostic & { readonly file: ts.SourceFile })
  }
}

const excludedPackages = [
  ...new Set(excludedDiagnostics.map((diagnostic) => dependencyPackageName(diagnostic.file.fileName))),
].sort()

process.stderr.write(
  `git-super workspace-composition typecheck: filtered diagnostics to ${configuredFiles.size} configured git-super file${configuredFiles.size === 1 ? "" : "s"}; ${excludedDiagnostics.length} dependency diagnostic${excludedDiagnostics.length === 1 ? "" : "s"} excluded (packages: ${excludedPackages.length === 0 ? "none" : excludedPackages.join(", ")})\n`,
)

if (ownedDiagnostics.length > 0) {
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext(ownedDiagnostics, formatHost))
  process.exit(2)
}

function canonicalFileName(file: string): string {
  const absolute = resolve(file)
  const real = ts.sys.realpath?.(absolute) ?? absolute
  return ts.sys.useCaseSensitiveFileNames ? real : real.toLowerCase()
}

function dependencyPackageName(file: string): string {
  let directory = dirname(canonicalFileName(file))

  while (true) {
    const manifest = join(directory, "package.json")
    if (existsSync(manifest)) {
      let value: unknown
      try {
        value = JSON.parse(readFileSync(manifest, "utf8"))
      } catch (error) {
        throw new Error(
          `git-super workspace-composition typecheck: dependency diagnostic at ${file} belongs to unreadable manifest ${manifest}; cannot report the excluded package`,
          { cause: error },
        )
      }
      const name = (value as { name?: unknown }).name
      if (typeof name === "string" && name.length > 0) return name
      throw new Error(
        `git-super workspace-composition typecheck: dependency diagnostic at ${file} belongs to unnamed manifest ${manifest}; cannot report the excluded package`,
      )
    }

    const parent = dirname(directory)
    if (parent === directory) {
      throw new Error(
        `git-super workspace-composition typecheck: dependency diagnostic at ${file} has no package.json ancestor; cannot report the excluded package`,
      )
    }
    directory = parent
  }
}
