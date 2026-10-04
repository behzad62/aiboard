# Deliverable review evidence policy

Fresh planning runs record optional `reviewEvidencePolicyVersion: 1` during trusted provisioning. Historical runs without that field retain their original review records and replay behavior.

The native changed-line mutation probe reports only mutants whose test command actually completed successfully as survivors. On activated runs, each built-in survivor becomes a reserved blocking finding. Omission from the reviewer's findings does not remove it. A verdict may release the finding using `survivorDispositions`, with its exact finding ID, `disposition: "not_a_real_gap"`, and a nonempty rationale. The reviewer decides whether the survivor exposes a real gap. The Architect cannot release mutation findings through ordinary finding dispositions. This authority also follows outstanding findings carried through subsequent fix reviews.

Each verified worker claim needs `citations`, containing a file `path` and 1-based `line`, or an `evidenceId`. The fresh verdict session must actually read that location or evidence. Context text and reads from the findings pass do not satisfy this requirement.

Before recording a verdict, the native runtime verifies the current review and active fresh session, then records a runner-owned `delivery.reads_captured` event. The capture binds the run, task, review, submitted change and attempt, canonical reviewer, and verdict session. It derives its read facts from successful completed native tool invocations, including exact ledger keys and completion sequences. A retry's latest preceding invocation supplies its actor; earlier starts cannot lend authority to another actor's completion.

`fs.read` citations are bounded by the actual returned line range. Failed, denied, empty, opaque or foreign-session reads, directory listings, and artifact references grant no location authority. Evidence citations require same-task evidence actually returned by `inspect_evidence`, or complete nonempty UTF-8 content read from its artifact. Partial artifact ranges grant no whole-evidence authority. Model-provided read arrays cannot replace this capture.

These checks establish mechanical provenance. Semantic completeness remains the reviewer's and Architect's responsibility. A rejected verdict can be retried after the reviewer reads the necessary content or records a supported finding disposition. Captures and verdicts replay from durable scheduler and tool-ledger records.

E5 validation is limited to its own core and authenticated native factory/runtime journeys, with real SQLite and Git and mocked model responses. Prior packet, importer, integration, platform, package, build and full-suite gates remain deferred to T8 under the owner continuation amendment.
