import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ResultHistoryRows,
  historyRegionId,
  visibleHistoryRows,
} from "../components/benchmark/results/ResultHistoryRows";
import type { DecisionRow } from "../lib/benchmark/certified/decision-dashboard";
import {
  DecisionLeaderboard,
  resultProfileTriggerKey,
} from "../components/benchmark/results/DecisionLeaderboard";

function row(id: string, completedAt: string, score: number): DecisionRow {
  return {
    id,
    resultSetId: id,
    executionId: `execution-${id}`,
    configurationKey: "configuration-luna",
    completedAt,
    overallDelta: null,
    passRateDelta: null,
    historyCount: 0,
    label: "GPT-5.6 Luna",
    tracks: ["gameiq", "toolreliability"],
    caseTitles: ["Case"],
    attempts: 2,
    passed: 1,
    preliminary: true,
    verifiedQuality: score,
    overallScore: score,
    trackBreakdown: [],
    passRate: 0.5,
    efficiencyScore: 75,
    toolReliabilityScore: 90,
    toolReliabilitySamples: 1,
    averageCostUsd: null,
    costPerPass: null,
    averageDurationMs: 1000,
    durationMs: 2000,
    speedPerPassMs: 2000,
    totalTokens: 100,
    tokensPerPass: 100,
    costBasis: "tokens",
    teamLift: null,
    teamLiftTracks: [],
    teamCompositionId: "luna",
    modelIds: ["account:gpt-5.6-luna"],
    isTeam: false,
    latestAttemptsByTrack: {},
    providerUnavailableAttemptIds: [],
    providerUnavailableAttemptIdsByTrack: {},
    providerIds: ["account"],
    reasoningEfforts: ["medium"],
    failureDetails: [],
    configurationDetails:
      "account · account:gpt-5.6-luna · medium reasoning · max 4,096 tokens · GameIQ suite-v2 / case-a@case-v3 / score-v5",
  };
}

const latest = {
  ...row("set-latest", "2026-07-29T11:00:00.000Z", 0.77),
  overallDelta: 0.07,
  passRateDelta: -0.03,
  historyCount: 7,
};
const older = Array.from({ length: 7 }, (_, index) =>
  row(
    `set-old-${index + 1}`,
    `2026-07-${String(28 - index).padStart(2, "0")}T11:00:00.000Z`,
    0.7 - index / 100
  )
);

assert.deepEqual(
  visibleHistoryRows(older, 5).map((item) => item.resultSetId),
  older.slice(0, 5).map((item) => item.resultSetId)
);
assert.deepEqual(
  visibleHistoryRows(older, 10).map((item) => item.resultSetId),
  older.map((item) => item.resultSetId)
);
assert.equal(
  historyRegionId(latest.configurationKey, "desktop"),
  historyRegionId(latest.configurationKey, "desktop")
);
assert.notEqual(
  historyRegionId(latest.configurationKey, "desktop"),
  historyRegionId(latest.configurationKey, "mobile")
);
assert.notEqual(
  resultProfileTriggerKey(older[0]!, "desktop"),
  resultProfileTriggerKey(older[0]!, "mobile")
);
assert.equal(
  resultProfileTriggerKey(older[0]!, "desktop"),
  `desktop:${older[0]!.resultSetId}`
);

function render(layout: "desktop" | "mobile", expanded: boolean, count: number) {
  return renderToStaticMarkup(
    <ResultHistoryRows
      layout={layout}
      latest={latest}
      older={older}
      expanded={expanded}
      visibleCount={count}
      selectedResultSetId={null}
      deletingIds={new Set()}
      deleteInFlight={false}
      onShowMore={() => undefined}
      onSelectProfile={() => undefined}
      onDelete={() => undefined}
      onCloseProfile={() => undefined}
      registerProfileTrigger={() => undefined}
    />
  );
}

const collapsedDesktop = render("desktop", false, 5);
assert.equal(collapsedDesktop, "");

const latestMarkup = renderToStaticMarkup(
  <DecisionLeaderboard
    rows={[latest, row("set-without-predecessor", "2026-07-29T12:00:00.000Z", 0.8)]}
    totalRows={2}
    sortKey="overall"
    onSortChange={() => undefined}
    history={[
      {
        configurationKey: latest.configurationKey,
        latestResultSetId: latest.resultSetId,
        overallDelta: latest.overallDelta,
        passRateDelta: latest.passRateDelta,
        older,
      },
    ]}
    selectedResultSetId={null}
    onSelect={() => undefined}
  />
);
assert.ok(latestMarkup.includes("Overall +7"));
assert.ok(latestMarkup.includes("Pass -3 pp"));
assert.ok(latestMarkup.includes("Overall higher by 7 points"));
assert.ok(latestMarkup.includes("Pass lower by 3 percentage points"));
assert.ok(latestMarkup.includes("8 runs"));
assert.ok(latestMarkup.includes("max 4,096 tokens"));
assert.ok(latestMarkup.includes("suite-v2"));
assert.ok(latestMarkup.includes("case-a@case-v3"));
assert.ok(latestMarkup.includes("score-v5"));
assert.ok(latestMarkup.includes('aria-expanded="false"'));
assert.ok(
  latestMarkup.includes(
    `aria-controls="${historyRegionId(latest.configurationKey, "desktop")}"`
  )
);
assert.equal(
  latestMarkup.split("Overall +7").length - 1,
  2,
  "desktop and mobile latest rows show one delta each"
);

const expandedDesktop = render("desktop", true, 5);
assert.equal(
  older.filter((item) => expandedDesktop.includes(item.resultSetId)).length,
  5
);
assert.ok(!expandedDesktop.includes(older[5]!.resultSetId));
assert.ok(expandedDesktop.includes("<tr"));
assert.ok(!expandedDesktop.includes("<li"));
assert.ok(expandedDesktop.includes("Show more"));

const allDesktop = render("desktop", true, 10);
assert.deepEqual(
  older.map((item) => allDesktop.indexOf(item.resultSetId)),
  older
    .map((item) => allDesktop.indexOf(item.resultSetId))
    .slice()
    .sort((left, right) => left - right)
);
assert.ok(!allDesktop.includes("Show more"));

const expandedMobile = render("mobile", true, 5);
assert.equal(
  older.filter((item) => expandedMobile.includes(item.resultSetId)).length,
  5
);
assert.ok(expandedMobile.includes("<li"));
assert.ok(!expandedMobile.includes("<tr"));
assert.ok(expandedMobile.includes("View profile"));
assert.ok(expandedMobile.includes("Delete snapshot"));

const exactActionMarkup = renderToStaticMarkup(
  <ResultHistoryRows
    layout="mobile"
    latest={latest}
    older={older}
    expanded
    visibleCount={5}
    selectedResultSetId={older[0]!.resultSetId}
    deletingIds={new Set([older[1]!.resultSetId])}
    deleteInFlight
    onShowMore={() => undefined}
    onSelectProfile={() => undefined}
    onDelete={() => undefined}
    onCloseProfile={() => undefined}
    registerProfileTrigger={() => undefined}
  />
);
assert.ok(
  exactActionMarkup.includes(`data-result-set-id="${older[0]!.resultSetId}"`)
);
assert.ok(exactActionMarkup.includes(`benchmark-evidence-mobile-`));
assert.ok(exactActionMarkup.includes('role="region"'));

console.log("PASS");
