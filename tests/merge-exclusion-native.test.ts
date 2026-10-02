/**
 * @failure Native Git reads an excluded retained store although explicit child requests are absent.
 * @level l3
 * @consumer git-super merge and root merge-base callers excluding an unchanged public submodule
 * @reach fs-walk <fixture-only: synthetic repositories under the checkout's .cache>
 * @testonly none
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { advanceRepository, createRepository, git } from "./fixture.ts"

const cli = fileURLToPath(new URL("../bin/git-super", import.meta.url))

function completeSyscalls(lines: readonly string[]): string[] {
  const complete: string[] = []
  const pending = new Map<string, { syscall: string; prefix: string; index: number }>()
  for (const line of lines) {
    const unfinished = /^(\d+)\s+(\w+)\(.*<unfinished \.\.\.>$/u.exec(line)
    if (unfinished) {
      const [, pid, syscall] = unfinished
      if (pending.has(pid!)) throw new Error(`Duplicate unfinished strace syscall for PID ${pid}`)
      pending.set(pid!, {
        syscall: syscall!,
        prefix: line.slice(0, line.lastIndexOf("<unfinished")).trimEnd(),
        index: complete.length,
      })
      complete.push(line)
      continue
    }
    const resumed = /^(\d+)\s+<\.\.\. (\w+) resumed>(.*)$/u.exec(line)
    if (resumed) {
      const [, pid, syscall, suffix] = resumed
      const start = pending.get(pid!)
      if (!start || start.syscall !== syscall) {
        throw new Error(`Unmatched resumed strace syscall ${syscall} for PID ${pid}`)
      }
      complete[start.index] = `${start.prefix}${suffix}`
      pending.delete(pid!)
      continue
    }
    complete.push(line)
  }
  if (pending.size > 0) throw new Error(`Unpaired unfinished strace syscall for PID ${[...pending.keys()].join(", ")}`)
  return complete
}

it("finished merge and root merge-base never access an excluded populated store under strace (27058)", () => {
  // Native scheduling may split rows nondeterministically; pin the interleaved
  // framing here so missing paths or ENOENT results can never be discarded.
  expect(
    completeSyscalls([
      '1 newfstatat(AT_FDCWD, "child/.git" <unfinished ...>',
      '2 openat(AT_FDCWD, "store/HEAD", O_RDONLY <unfinished ...>',
      "1 <... newfstatat resumed>, 0x1, 0) = -1 ENOENT",
      "2 <... openat resumed>) = 3<store/HEAD>",
    ]),
  ).toEqual([
    '1 newfstatat(AT_FDCWD, "child/.git", 0x1, 0) = -1 ENOENT',
    '2 openat(AT_FDCWD, "store/HEAD", O_RDONLY) = 3<store/HEAD>',
  ])
  for (const malformed of [
    ['1 newfstatat(AT_FDCWD, "child/.git" <unfinished ...>'],
    ["1 <... newfstatat resumed>, 0x1, 0) = -1 ENOENT"],
    ['1 newfstatat(AT_FDCWD, "child/.git" <unfinished ...>', "1 <... openat resumed>) = 3"],
    ['1 newfstatat(AT_FDCWD, "child/.git" <unfinished ...>', '1 openat(AT_FDCWD, "store/HEAD" <unfinished ...>'],
  ]) {
    expect(() => completeSyscalls(malformed)).toThrow(/strace syscall/u)
  }
  const available = spawnSync("strace", ["--version"], { encoding: "utf8" })
  if (available.error || available.status !== 0) {
    throw new Error("NOT RUN: native exclusion proof requires strace; report this row explicitly on unsupported hosts")
  }
  const cache = resolve(".cache", "git-super-native-exclusion")
  mkdirSync(cache, { recursive: true })
  const fixture = mkdtempSync(join(cache, "public-"))
  const child = join(fixture, "child")
  const root = join(fixture, "root")
  const selected = "components/excluded-public"
  try {
    createRepository(child, "public.txt", "public synthetic child\n")
    createRepository(root, "base.txt", "public synthetic root\n")
    git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", child, selected)
    git(root, "commit", "-q", "-am", "add selected public child")
    const base = git(root, "rev-parse", "HEAD")
    const remote = join(fixture, "root-remote.git")
    git(fixture, "clone", "--bare", "-q", root, remote)
    git(root, "remote", "add", "origin", remote)
    git(root, "fetch", "-q", "origin")
    const pin = git(root, "rev-parse", `HEAD:${selected}`)
    const store = git(root, "rev-parse", "--path-format=absolute", "--git-path", `modules/${selected}`)
    expect(existsSync(join(store, "HEAD"))).toBe(true)
    expect(readdirSync(join(store, "objects")).length).toBeGreaterThan(0)
    git(root, "switch", "-q", "-c", "target")
    const target = advanceRepository(root, "target.txt", "target root change\n")
    git(root, "switch", "-q", "main")
    advanceRepository(root, "head.txt", "HEAD root change\n")
    git(root, "submodule", "deinit", "-f", "--", selected)
    const checkout = join(root, selected)
    expect(readdirSync(checkout)).toEqual([])

    const traced = (name: string, args: string[]) => {
      const trace = join(fixture, `${name}.strace`)
      const result = spawnSync(
        "strace",
        ["-f", "-yy", "-v", "-s", "4096", "-o", trace, "bun", cli, "--repo", root, "--json", ...args],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 60_000,
          maxBuffer: 4 * 1024 * 1024,
          env: {
            ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
            ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
            ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
            GIT_AUTHOR_NAME: "Native Exclusion Test",
            GIT_AUTHOR_EMAIL: "native@example.test",
            GIT_COMMITTER_NAME: "Native Exclusion Test",
            GIT_COMMITTER_EMAIL: "native@example.test",
            GIT_TERMINAL_PROMPT: "0",
          },
        },
      )
      const retainedTrace = join(cache, `${name}-${fixture.split("/").at(-1)}.strace`)
      writeFileSync(retainedTrace, readFileSync(trace))
      expect(result.error, `${name}: ${result.stderr}`).toBeUndefined()
      expect(result.status, `${name}: ${result.stdout}\n${result.stderr}`).toBe(0)
      const lines = completeSyscalls(readFileSync(trace, "utf8").split("\n"))
      // Keep -yy descriptor identities for every syscall, including writes.
      // Read/write buffers and execve argv mention paths without accessing them.
      const accesses = lines.map((line) => {
        if (/\b(?:read|readv|write|writev|pread64|pwrite64)\(/u.test(line)) return line.split(", ")[0] ?? line
        if (/\bexecve\(/u.test(line)) return line.split(", [")[0] ?? line
        return line
      })
      const storeCalls = accesses.filter((line) => line.includes(store) || line.includes(`".git/modules/${selected}`))
      expect(storeCalls, `${name}: selected store native access`).toEqual([])
      const checkoutCalls = accesses.filter(
        (line) => line.includes(checkout) || line.includes(`"${selected}"`) || line.includes(`"${selected}/`),
      )
      const directoryOpens = checkoutCalls.filter((line) => /\bopen(?:at|at2)?\(/u.test(line))
      expect(directoryOpens, `${name}: only guard's directory open is permitted`).toHaveLength(
        name === "finished-merge" ? 1 : 0,
      )
      for (const line of directoryOpens) {
        expect(line).toContain("O_DIRECTORY")
        expect(line).toContain(`"${checkout}"`)
      }
      for (const line of checkoutCalls) {
        expect(line, `${name}: checkout access must be metadata or the guard directory census`).toMatch(
          /\b(?:stat|lstat|fstat|newfstatat|statx|openat|openat2|getdents|getdents64|close)\(/u,
        )
        if (/\bgetdents(?:64)?\(/u.test(line)) {
          const names = [...line.matchAll(/d_name="([^"]+)"/gu)].map((match) => match[1])
          expect(
            names.filter((name) => name !== "." && name !== ".."),
            `${name}: checkout must remain empty`,
          ).toEqual([])
        }
        if (line.includes(`${selected}/.git`)) expect(line).toContain("ENOENT")
      }
      if (name === "finished-merge") {
        expect(checkoutCalls.length, `${name}: positive checkout metadata witness`).toBeGreaterThan(0)
      }
      expect(
        accesses.some((line) => /\bopenat\(/u.test(line) && line.includes(`${root}/.git/objects/`)),
        `${name}: root object read positive control`,
      ).toBe(true)
      return JSON.parse(result.stdout) as { state?: string; isAncestor?: boolean; notCompared?: unknown[] }
    }

    expect(
      traced("root-merge-base", ["merge-base", "--is-ancestor", base, target, "--exclude-submodule", selected]),
    ).toMatchObject({ isAncestor: true })
    expect(traced("finished-merge", ["merge", target, "--exclude-submodule", selected])).toMatchObject({
      state: "updated",
      notCompared: [{ path: selected, reason: "excluded" }],
    })
    expect(git(root, "rev-parse", `HEAD:${selected}`)).toBe(pin)
    expect(git(root, "merge-base", "--is-ancestor", target, "HEAD")).toBe("")
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
}, 90_000)
