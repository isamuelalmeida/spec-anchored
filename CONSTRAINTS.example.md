# Constraints

Last reviewed: <YYYY-MM-DD>

Copy this file to your project root as `CONSTRAINTS.md` and rewrite the
bullets for your stack. Rules:

- Floor-only: everything here is a hard ban (or a tracked exception table).
  Aspirations, goals and metrics-that-are-not-enforced do NOT belong here —
  they rot into noise. If you want a measured-but-not-enforced number, put it
  under "Measured, not yet enforced" and never gate on it.
- Each numbered threshold carries its direction in words (`at least` for
  minimums, `at most` for maximums). The guard cannot tell tightening from
  loosening on a bare number, so a directionless change is always reported.
- Rule identity is the bullet text before the first colon (or the table's
  first cell). Keep labels stable; rename a rule in one commit and change its
  numbers in another, or the guard reads it as removed + added.

## Floor (always enforced, no setup required)

- No new suppression comments: `@ts-ignore`, `@ts-nocheck`, `eslint-disable`
- No unimplemented stubs: `throw new Error("Not implemented")`, empty `catch {}`, `TODO` standing where implementation should be
- No skipped or deleted tests without a reason in the commit message (`.skip`, `xit`, `xdescribe`, deleted `*.test.*`/`*.spec.*`, assertion removed from a test that stayed)
- No secrets in source (`sk-or-v1-*`, `api_key`/`apikey` assignments)
- This file does not get weakened to make a change pass

Checked by: `node scripts/floor-guard.mjs --base origin/main` for the first three and last bullets (exit `0` clean / `1` violation / `2` no base); the secrets bullet by your secret scanner. Runs at: every diff, CI.

## Measured, not yet enforced

| Metric | Today | Direction |
|--------|-------|-----------|
| — | — | — |

## Exceptions

| ID | Rule | Path | Reason | Owner | Expires |
|----|------|------|--------|-------|---------|
| — | — | — | — | — | — |
