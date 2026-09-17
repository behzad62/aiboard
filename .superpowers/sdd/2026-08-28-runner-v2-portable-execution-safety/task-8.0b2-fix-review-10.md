# Task 8.0B2 Fresh Re-review — Fix Round 9

## Verdict

- Specification compliance: **CHANGES REQUIRED**
- Code quality: **CHANGES REQUIRED**
- Critical: **0**
- Important: **1**
- Minor: **0**
- B2 unlock: **refused**

## Important finding

1. Physical retirement still deletes sidecar-named files without a live exact
   main-database authority. If revoked recovery starts with the coordination
   database absent but `<path>-wal` present, the allow-missing check succeeds
   and cleanup deletes that unrelated file. The same loop can delete sidecars
   after the main path disappears and accepts a regular single-link replacement
   because it checks only the replacement's shape, not the verified database's
   stable identity.

## Required correction

- If the main coordination database is absent, preserve every sidecar and
  return without physical mutation.
- When the main database exists, carry the verified retired database's stable
  file identity and exact authority into physical cleanup.
- Revalidate that identity before each sidecar removal and before the main
  unlink. Refuse disappearance, replacement, symbolic links, and multiple
  links without removing uncertain files.

## Review evidence

- The three exact round-9 regressions passed.
- Owned-fence and POSIX modules passed 26 tests with one expected Windows-host
  skip; late-birth cleanup proved no binding, live PID, or retained state.
- Runner typecheck, diff integrity, Node-range, and clean-worktree checks passed.
- The independent main-absent reproduction returned successfully while
  deleting the unrelated `-wal` file.
- Review cleanup left zero live helpers and zero review residue.

R9.2 and R9.3 are closed. The in-transaction portion of R9.1 is closed, but
physical cleanup remains unsafe. B2 stays locked; B3 has not started.
