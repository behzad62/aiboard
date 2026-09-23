# Gate G qualification refactor — independent review after repair

## Review result

A fresh independent read-only Cursor review of the qualification refactor found **no Blockers** and one **Important** issue after the earlier Blocker/Important repairs: the qualification-harness timeout regression used a 500 ms child budget, which was too tight for cold hosted runners.

The reviewer also identified two concrete minors: unknown-scenario dispatch bypassed `exitScenarioMain`, and the execution record overstated hosted LSP coverage.

Review verdict at that snapshot: `NOT READY` solely because the 500 ms required-CI harness guard remained.

## Repairs made from that review

- Harness timeout regression outer guard is now 10 s on Windows and 5 s elsewhere. Product deadlines are unchanged.
- Unknown scenario dispatch in focused scenario modules now throws through `exitScenarioMain`, preserving diagnostic evidence.
- LSP documentation now states that LSP was not a prior hosted qualification entrypoint and remains covered by existing deterministic/required checks.

## Post-repair verification

Fresh local validation after those repairs:

- workflow / harness / bootstrap targeted bundle: 16/16 pass;
- targeted repaired legacy CLI cases: 2/2 pass;
- focused CLI qualification: 8/8 pass;
- focused Windows portable qualification: 5/5 pass;
- focused recovery qualification: 3/3 pass;
- focused native lifecycle on Windows: 7 pass, 1 expected POSIX host skip, 0 fail;
- TypeScript: exit 0;
- `git diff --check`: exit 0;
- deliberate unknown CLI scenario: exit 1 with a persisted diagnostics summary.

Local Docker was unavailable, so local Docker scenarios produced only their explicitly approved structured skips; none is counted as hosted acceptance.

## Additional final-review attempts

A later Cursor Opus read-only pass inspected the frozen final candidate, including the repaired harness, skip authority, failure evidence, fail-stop sequencing, Docker/MCP path, and focused scenarios. It did not surface a new Blocker/Important before the Cursor account hit its monthly model-usage limit, so that later attempt produced no final verdict. Additional Cursor GPT/Gemini attempts were blocked by the same account limit; Composer exited without review text.

No READY verdict is invented from those incomplete attempts. The complete independent review above, its concrete Important/minor findings, and the fresh post-repair validation are the evidence used to freeze the candidate for final-SHA hosted qualification. Gate G remains open until that hosted qualification is green.
