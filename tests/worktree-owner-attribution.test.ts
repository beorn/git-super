/**
 * @failure `git worktree list` cannot say who owns a worktree, so a reconciler
 *          needs a lookup table beside git's own registry — and 866 registered
 *          worktrees accumulated because nothing could attribute one to a live
 *          owner.
 * @level   l1
 * @consumer src/worktree-add.ts — every worktree registration
 * @bead    @i/4-supervision/24306
 *
 * MEASURED on git 2.53 before building on it, because the mechanism hinges on
 * which field carries the owner:
 *
 *   - git derives the registration name from the basename of the path, and
 *     `git worktree add` takes `<path>` only — no flag sets it independently;
 *   - `git worktree list --porcelain` emits worktree/HEAD/branch and does NOT
 *     print the registration name, so the field a reconciler reads is the PATH;
 *   - two paths sharing a basename collide into `same` and `same1`.
 *
 * The collision is why this lives in the registering layer: only here can an
 * ambiguous name be refused at composition time rather than discovered as a
 * dedupe afterwards.
 *
 * Measured on the live estate 2026-09-08, both un-attributable:
 *   a pool slot   registers as `dev-wt11`
 *   a bay         registers as `dev11-24153`
 * Neither names an owner, and the second does not even say which slot's bays it
 * lives under, so two bays from different owners can collide on it.
 */
import { describe, expect, test } from "vitest"

import { ownerFromRegistrationName, registrationNameForOwner } from "git-super"

describe("worktree registration names are self-attributing (24306)", () => {
  test("a name built for an owner yields that owner back", () => {
    const name = registrationNameForOwner("hab-session-7f3a1c", "wt11")
    expect(ownerFromRegistrationName(name)).toBe("hab-session-7f3a1c")
  })

  test("the label survives alongside the owner, so the name still reads for a human", () => {
    expect(registrationNameForOwner("hab-session-7f3a1c", "wt11")).toContain("wt11")
  })

  test("names registered before this exist read as UNATTRIBUTABLE, not as a guessed owner", () => {
    expect(ownerFromRegistrationName("dev-wt11")).toBeUndefined()
    expect(ownerFromRegistrationName("dev11-24153")).toBeUndefined()
  })

  test("two owners with the same label do not collide", () => {
    const a = registrationNameForOwner("hab-session-aaaa", "24153")
    const b = registrationNameForOwner("hab-session-bbbb", "24153")
    expect(a).not.toBe(b)
    expect(ownerFromRegistrationName(a)).toBe("hab-session-aaaa")
    expect(ownerFromRegistrationName(b)).toBe("hab-session-bbbb")
  })

  test("an owner id containing the separator cannot forge another owner", () => {
    expect(() => registrationNameForOwner("hab~session~evil", "wt1")).toThrow("owner separator")
  })

  test("the name is a legal single path segment, since git uses it as a directory", () => {
    const name = registrationNameForOwner("hab-session-7f3a1c", "wt11")
    expect(name).not.toContain("/")
    expect(name).not.toContain("\0")
    expect(name.length).toBeGreaterThan(0)
  })
})
