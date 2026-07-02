/* Fireworks AI schema checks (run: npx tsx scripts/test-fireworks-ai-schema.mts) */
import { createFireworksGame } from "../lib/games/fireworks/engine";
import {
  buildFireworksActionSchema,
  buildFireworksPrompt,
  chooseDeterministicFireworksFallback,
  parseFireworksActionResponseResult,
} from "../lib/games/fireworks/ai";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

const state = createFireworksGame({
  seed: "ai-schema",
  players: [
    { id: "P1", label: "Player 1", kind: "human" },
    { id: "P2", label: "Player 2", kind: "human" },
  ],
});
state.hands[1].cards[0] = { id: "red-one", color: "red", rank: 1 };

const schema = buildFireworksActionSchema();
const schemaProperties = schema.schema.properties as Record<string, unknown>;
const sortedRequired = [...(schema.schema.required ?? [])].sort();
check(
  "structured schema is strict and names Fireworks actions",
  schema.name === "fireworks_action" &&
    schema.strict === true &&
    schemaProperties.action !== undefined,
  schema
);
check(
  "strict structured schema requires every Fireworks action property",
  JSON.stringify(sortedRequired) ===
    JSON.stringify(
      ["action", "cardIndex", "color", "rank", "strategyNote", "targetPlayerId"].sort()
    ),
  schema
);
check(
  "action-dependent Fireworks fields are nullable for strict providers",
  JSON.stringify((schemaProperties.targetPlayerId as { type?: unknown }).type) ===
    JSON.stringify(["string", "null"]) &&
    JSON.stringify((schemaProperties.color as { type?: unknown; enum?: unknown }).type) ===
      JSON.stringify(["string", "null"]) &&
    JSON.stringify((schemaProperties.color as { type?: unknown; enum?: unknown }).enum) ===
      JSON.stringify(["red", "blue", "green", null]) &&
    JSON.stringify((schemaProperties.rank as { type?: unknown; enum?: unknown }).type) ===
      JSON.stringify(["integer", "null"]) &&
    JSON.stringify((schemaProperties.rank as { type?: unknown; enum?: unknown }).enum) ===
      JSON.stringify([1, 2, 3, 4, 5, null]) &&
    JSON.stringify((schemaProperties.cardIndex as { type?: unknown }).type) ===
      JSON.stringify(["integer", "null"]),
  schema
);
check(
  "structured schema restricts clue rank to Fireworks ranks",
  JSON.stringify((schemaProperties.rank as { enum?: unknown }).enum) ===
    JSON.stringify([1, 2, 3, 4, 5, null]),
  schemaProperties.rank
);
check(
  "structured schema allows nullable provisional strategy notes",
  JSON.stringify((schemaProperties.strategyNote as { type?: unknown } | undefined)?.type) ===
    JSON.stringify(["string", "null"]) &&
    (schemaProperties.strategyNote as { maxLength?: unknown } | undefined)?.maxLength === 240,
  schemaProperties.strategyNote
);

const parsedClueColor = parseFireworksActionResponseResult(
  state,
  "P1",
  '{"action":"clue_color","targetPlayerId":"P2","color":"red","reason":"playable","strategyNote":"Clue playable ones first, but recheck current hands each turn."}'
);
check(
  "valid clue_color parses",
  parsedClueColor.ok,
  parsedClueColor
);
check(
  "valid clue_color retains compact provisional strategy note",
  parsedClueColor.ok &&
    parsedClueColor.strategyNote ===
      "Clue playable ones first, but recheck current hands each turn.",
  parsedClueColor
);
check(
  "valid clue_rank parses",
  parseFireworksActionResponseResult(
    state,
    "P1",
    '{"action":"clue_rank","targetPlayerId":"P2","rank":1}'
  ).ok,
  null
);
check(
  "valid play parses",
  parseFireworksActionResponseResult(state, "P1", '{"action":"play","cardIndex":0}')
    .ok,
  null
);
check(
  "valid discard parses",
  parseFireworksActionResponseResult(
    state,
    "P1",
    '{"action":"discard","cardIndex":0}'
  ).ok,
  null
);
check(
  "invalid self-clue is rejected",
  !parseFireworksActionResponseResult(
    state,
    "P1",
    '{"action":"clue_color","targetPlayerId":"P1","color":"red"}'
  ).ok,
  null
);
check(
  "invalid card index is rejected",
  !parseFireworksActionResponseResult(state, "P1", '{"action":"play","cardIndex":99}')
    .ok,
  null
);
check(
  "invalid clue target is rejected",
  !parseFireworksActionResponseResult(
    state,
    "P1",
    '{"action":"clue_rank","targetPlayerId":"PX","rank":1}'
  ).ok,
  null
);

const fallback = chooseDeterministicFireworksFallback(state, "P1");
check(
  "fallback always returns a legal action",
  parseFireworksActionResponseResult(state, "P1", JSON.stringify(fallback)).ok,
  fallback
);

const notedPrompt = buildFireworksPrompt(
  {
    ...state,
    aiStrategyNotes: {
      P1: "P2 has a playable red 1; prefer a clue if tokens remain.",
    },
  },
  "P1"
);
check(
  "Fireworks prompt frames prior strategy as provisional context",
  notedPrompt.user.includes("Previous strategic note") &&
    notedPrompt.user.includes("context only") &&
    notedPrompt.user.includes("current hidden-safe view and legal actions are authoritative") &&
    notedPrompt.user.includes("P2 has a playable red 1"),
  notedPrompt.user
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
