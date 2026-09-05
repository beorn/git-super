/**
 * Hermetic Git for every test worker.
 *
 * git-super spawns git with the caller's environment, so a commit it writes is
 * signed by whoever the host says. GitHub's ubuntu-latest runner says nobody —
 * the `runner` account has an empty GECOS field — and `git merge` refuses before
 * touching the tree: "fatal: empty ident name (for <runner@…>) not allowed".
 * Every merge test failed there from 2026-08-31 while passing on macos-15, whose
 * runner account has a full name, and on every developer host with a global
 * identity. The fixtures' own `git()` helper always carried an identity; this
 * gives the SAME identity to the code under test, so a commit written by
 * git-super is as reproducible as one written by the fixture.
 *
 * Host configuration is switched off for the same reason in the other
 * direction: `core.hooksPath`, `commit.gpgsign` or `submodule.recurse` in a
 * developer's ~/.gitconfig change what the hook and checkout tests observe, and
 * the runners have none of them. The suite must pass on a bare git and on a
 * decorated one alike, so it runs bare everywhere.
 */
process.env["GIT_AUTHOR_NAME"] = "Git Super Test"
process.env["GIT_AUTHOR_EMAIL"] = "git-super@example.test"
process.env["GIT_COMMITTER_NAME"] = "Git Super Test"
process.env["GIT_COMMITTER_EMAIL"] = "git-super@example.test"
process.env["GIT_CONFIG_GLOBAL"] = "/dev/null"
process.env["GIT_CONFIG_NOSYSTEM"] = "1"
process.env["GIT_TERMINAL_PROMPT"] = "0"
