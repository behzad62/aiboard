# AI Board Bench Scoring Rules

Certified scores come only from deterministic verifiers, deterministic game engines, deterministic rule checkers, and schema or tool validators. Architect-reviewed Build quality is Lab evidence and must not become an official Certified score.

## WorkBench

`VerifiedQuality` is the verifier score on a `0..1` scale.

`JobSuccessScore = 100 * VerifiedQuality`

`EfficiencyScore = 0` when `VerifiedQuality == 0`; otherwise:

```text
JobSuccessScore * (
  0.50
  + 0.25 * (CostFactor ?? 1)
  + 0.15 * TimeFactor
  + 0.10 * ToolReliability
)
```

`CostFactor = min(1, targetCost / actualCost)` when cost is known and a target exists. Unknown cost does not crash scoring and is treated as neutral for efficiency.

`TimeFactor = min(1, targetTime / actualTime)` when a target exists, otherwise `1`.

`ToolReliability = validToolCalls / max(totalToolCalls, 1)`.

## GameIQ

```text
100 * (
  0.35 * OutcomeScore
  + 0.30 * MoveQuality
  + 0.20 * LegalActionRate
  + 0.10 * StructuredReliability
  + 0.05 * LatencyFactor
) * (1 - 0.50 * FallbackRate)
```

All inputs are normalized to `0..1`.

## ToolReliability

```text
100 * (
  0.25 * SchemaValidRate
  + 0.20 * FirstAttemptValidRate
  + 0.15 * RepairSuccessRate
  + 0.20 * ToolValidRate
  + 0.15 * PatchSuccessRate
  + 0.05 * CommandSafetyRate
) * (1 - ForbiddenActionRate)
```

Forbidden actions are multiplicative penalties because they invalidate trust in otherwise well-formed tool output.

## TeamIQ

`TeamLift = TeamScore - max(MemberSoloScores)`

Labels:

- `strong_positive`: lift is at least 10, cost-adjusted lift is positive, and the team costs no more than about 3x the best solo.
- `positive`: lift is greater than 3 and the team is not more than 3x the best-solo cost; small overpriced gains are neutral.
- `neutral`: lift is between -3 and 3.
- `negative`: lift is below -3.
- `wasteful`: lift is not positive and team cost exceeds the best solo cost.

TeamIQ requires complete solo baselines for every member, case, and track before an official lift can be computed.

## Reporting

Reports should show quality, efficiency, cost per pass, speed per pass, team lift, tool reliability, and invalid-run counts separately. Do not hide invalid harness, environment, case, provider, or user-aborted runs inside model failure rates.
