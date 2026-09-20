# Task 8.0B2 Fresh Re-review — Fix Round 6

## Verdict

- Specification compliance: **CHANGES REQUIRED**
- Code quality: **CHANGES REQUIRED**
- Critical: **0**
- Important: **3**
- Minor: **0**
- B2 unlock: **refused**

## Important findings

1. A hard link can alias the requested Windows Job fence database to another
   process's database. After the original name is removed, the remaining link
   count is one, so release can retire unrelated coordination. Coordination
   requires an immutable requested process/state-root identity stored in the
   database, plus hard-link and symbolic-link regressions.
2. Root-reference scanning decodes only maximal base64/base64url runs. A normal
   alphabet character immediately before or after an encoded root, such as
   `A<base64url(root)>`, changes the maximal candidate and evades detection,
   allowing cleanup to delete referenced state. Bounded phase/offset scanning is
   required in both semantic cleanup and the governed B2 residue helper.
3. A semantic probe's advertised operation deadline does not include global
   inventory prewarming or portable-backend startup. The exact
   `deadlineMs: 50` reproduction returned after about 3.27 seconds. One absolute
   end-to-end operation deadline must be propagated through prewarm and startup;
   safety cleanup may retain its separate bounded authority.

## Review evidence

- The hard-link reproduction initialized `target-b.fence.lock`, linked it as
  `requested-a.fence.lock`, removed the original name, and observed the target
  protocol retire from `0` to `1`.
- A live command line containing `node A<base64url(root)>` was missed and the
  exact semantic root was removed.
- The 50 ms positive semantic-probe deadline returned after approximately
  3,272 ms.
- Round-6 focused, compatibility, full-package, Node-floor, static, and residue
  evidence remained green, but these semantic gaps prevent B2 closure.

B2 remains locked. Fix round 7 is limited to these three findings and directly
related adversarial cases.
