/**
 * @failure worktree homes multiplied because each caller hardcoded its own,
 *          and nothing could configure the existing one.
 * @level   l1
 * @consumer src/worktree-add.ts — every worktree path composition
 * @bead    @i/4-supervision/24306
 *
 * Operator 2026-09-11: one home, `/hh/var/wt/`, flat at the item level.
 * This is the one reader; callers stop composing a home and start asking
 * for a name under it.
 */
import { describe, expect, test } from "vitest"

import { DEFAULT_WORKTREE_HOME, WORKTREE_HOME_ENV, worktreeHomeRoot } from "git-super"

describe("worktree home is one absolute root (24306)", () => {
  test("the default is the ruled home", () => {
    expect(worktreeHomeRoot({})).toBe("/hh/var/wt")
    expect(DEFAULT_WORKTREE_HOME).toBe("/hh/var/wt")
  })

  test("an absolute override wins, so tests do not write into the live home", () => {
    expect(worktreeHomeRoot({ [WORKTREE_HOME_ENV]: "/tmp/wt-home" })).toBe("/tmp/wt-home")
  })

  test("an empty override falls through rather than becoming a relative home", () => {
    expect(worktreeHomeRoot({ [WORKTREE_HOME_ENV]: "" })).toBe(DEFAULT_WORKTREE_HOME)
  })

  test("a relative override is refused: a home that depends on cwd is another home", () => {
    expect(() => worktreeHomeRoot({ [WORKTREE_HOME_ENV]: "wt" })).toThrow(WORKTREE_HOME_ENV)
    expect(() => worktreeHomeRoot({ [WORKTREE_HOME_ENV]: "wt" })).toThrow("absolute")
  })
})
