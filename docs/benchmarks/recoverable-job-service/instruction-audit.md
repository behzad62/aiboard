# Instruction sufficiency audit — 2026-09-08

The owner required that candidates lose no points for behavior they were not
properly instructed to implement. The previous draft had broad requirement links,
but those links alone did not prove sufficient instructions for every private case.

## Result

All 69 proposed behavioral families now have candidate-visible expectations in
[acceptance-contract.md](acceptance-contract.md), referenced by stable family IDs.
The public contract includes terminology, cleanup ordering, deadline boundaries,
the permitted fault-model boundary, outcome examples and fairness rules. Private
tests may choose data and lawful event schedules; they cannot add obligations.

Twenty-eight family descriptions were clarified to remove reference-specific
assumptions or state their public prerequisites. This is a design audit, not blind
instruction review or test qualification. **Zero families are admitted for scoring.**
[scoring-admission.json](scoring-admission.json) records that status explicitly.
The record is declarative; a grading implementation that enforces it has not yet
been written.

## Gaps found and disposition

| Gap | Change or admission blocker |
| --- | --- |
| Broad clauses did not tell candidates all the behavioral families being assessed. | Publish all 69 families and expected outcomes; keep only concrete tests, seeds and source history private. |
| Two recovery passes and a 1,024-record batch were inherited implementation details. | B14/B16 now require complete accounting within published capacity, independent of algorithm or pass count. |
| Particular page/spool/SQL layouts and two store implementations appeared mandatory. | C02/C09/C15–C18 now grade observable durability/integrity on required profiles and accept alternative representations. |
| Rejecting every extra field assumed an unpublished closed schema. | C05 follows the supplied schema's closed/open policy. Exact schemas remain an admission blocker. |
| Process coordination holder tracking was not clearly assigned to candidate or adapter. | Add public D5 and conditional D07 responsibility. Adapter-owned behavior is infrastructure-only and earns no candidate points. |
| 'Active handoff' and 'terminal transfer' could imply conflicting rules about finalized evidence. | Define them as separate operations and clarify C12/C16. Exact public transition types remain required. |
| Progress versus safe refusal depended on unstated available proofs. | Define the prerequisite rule and paired examples; exact receipts, reconstruction and loss policies must be supplied before scoring. |
| Deadline ordering and dependency prerequisites were insufficiently concrete. | Publish the exclusive success/expiry boundary and cleanup order. Numeric clocks, leases, reserve and bounds still block admission. |
| Unknown native/legacy guarantees could become hidden prerequisites. | Require explicit profiles, formats, capability guarantees and candidate responsibility before an affected family may count. |
| A reference-shaped test might reject a design that prevents its assumed intermediate state. | Tests must use public fixtures/boundaries and accept equivalent correctness; private-state injection is disallowed. |

## Required release audit

For each concrete scoring assertion, record the exact public family, requirement,
given conditions, permissible events, expected alternatives and violated observable
outcome. A reviewer who has only the candidate package must be able to derive that
decision without reference code or private project history. If not, clarify before
release or leave the case unscored. This rule also applies to safety gates.

The release package still needs compile-ready interfaces/adapters, exact schemas,
numeric profiles, responsibility and score manifests, executable public examples,
a reviewed independent reference and qualified hidden/fault controls. This audit
does not pretend those artifacts are present. Existing tests are not run because
the task modified design documents only.

After a campaign starts, ambiguity is handled as a benchmark defect consistently
for every affected submission. No retroactive instruction, private reviewer
preference or new edge-case requirement may reduce an earlier candidate's score.


September 12 status: executable producer sources now exist. This historical design audit is not executable qualification evidence. Amended-profile qualification, independent public-only correct-control admission and end-to-end AI Board validation remain pending.
