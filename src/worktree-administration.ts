import { existsSync, readdirSync, realpathSync } from "node:fs"
import { join } from "node:path"

export type RemovalBorrower = Readonly<{
  adminDir: string
  name: string
  excludedStores?: readonly Readonly<{ path: string; store: string }>[]
  includedStores?: readonly string[]
}>

/** Private administration census shared by removal admission and destroyed-worktree recovery. */
export function removalBorrowers(commonDir: string, lenderGitDir: string): RemovalBorrower[] {
  const worktreesDir = join(commonDir, "worktrees")
  const candidates: RemovalBorrower[] = []
  const lender = realpathSync(lenderGitDir)
  if (existsSync(worktreesDir)) {
    for (const entry of readdirSync(worktreesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const adminDir = join(worktreesDir, entry.name)
        if (realpathSync(adminDir) !== lender) candidates.push({ adminDir, name: entry.name })
      }
    }
  }
  if (realpathSync(commonDir) !== lender) candidates.push({ adminDir: commonDir, name: "primary" })
  return candidates
}
