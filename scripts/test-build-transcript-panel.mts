/** Build transcript panel windowing checks (run: npx tsx scripts/test-build-transcript-panel.mts) */
import {
  BUILD_TRANSCRIPT_ROUND_INCREMENT,
  BUILD_TRANSCRIPT_INITIAL_ROUNDS,
  selectBuildTranscriptMessages,
} from "../components/BuildTranscriptPanel";
import type { TimelineMessage } from "../components/DiscussionTimeline";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const message = (round: number, suffix: string): TimelineMessage => ({
  id: `${round}-${suffix}`,
  round,
  modelId: "openai:gpt-5.5",
  modelName: "GPT-5.5",
  content: `Round ${round} ${suffix}`,
});

const messages: TimelineMessage[] = [
  message(1, "a"),
  message(1, "b"),
  message(2, "a"),
  message(3, "a"),
  message(4, "a"),
  message(5, "a"),
  message(6, "a"),
  message(7, "a"),
  message(7, "b"),
];

check("initial Build transcript window is five rounds", BUILD_TRANSCRIPT_INITIAL_ROUNDS === 5);
check("load-more increment is five rounds", BUILD_TRANSCRIPT_ROUND_INCREMENT === 5);

const initial = selectBuildTranscriptMessages(messages, BUILD_TRANSCRIPT_INITIAL_ROUNDS);
check(
  "selects only the five newest rounds initially, newest first",
  initial.map((m) => m.id).join(",") === "7-a,7-b,6-a,5-a,4-a,3-a",
  initial.map((m) => m.id),
);

const expanded = selectBuildTranscriptMessages(messages, BUILD_TRANSCRIPT_INITIAL_ROUNDS + BUILD_TRANSCRIPT_ROUND_INCREMENT);
check(
  "loading more appends older rounds after the recent window",
  expanded.map((m) => m.id).join(",") === "7-a,7-b,6-a,5-a,4-a,3-a,2-a,1-a,1-b",
  expanded.map((m) => m.id),
);

process.exit(failed === 0 ? 0 : 1);
