/* Chess export checks (run: npx tsx scripts/test-chess-export.mts) */
import { readFileSync } from "node:fs";
import {
  createInitialState,
  makeMove,
  toFEN,
} from "../lib/games/chess/engine";
import {
  exportChessFenList,
  exportChessJson,
  exportChessMoveList,
  exportChessPgnLike,
} from "../lib/games/chess/export";
import {
  copyGameExportToClipboard,
  downloadGameExport,
} from "../lib/games/core/export";
import type { ChessSessionSnapshot } from "../lib/games/chess/session";
import type { GameExport } from "../lib/games/core/types";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

async function expectReject(
  name: string,
  action: () => Promise<void>,
  messagePattern: RegExp
): Promise<void> {
  try {
    await action();
    check(name, false, "resolved");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(name, messagePattern.test(message), message);
  }
}

function sampleState() {
  let state = createInitialState();
  state = makeMove(state, { from: "e2", to: "e4" });
  state = makeMove(state, { from: "e7", to: "e5" });
  state = makeMove(state, { from: "g1", to: "f3" });
  return state;
}

function sampleSnapshot(): ChessSessionSnapshot {
  return {
    gameMode: "pvp",
    humanColor: "white",
    whiteAI: { modelId: "", reasoningEffort: "default" },
    blackAI: { modelId: "", reasoningEffort: "default" },
    gameState: sampleState(),
    whiteTimeMs: 2500,
    blackTimeMs: 1300,
    gameStartTime: 1_782_172_800_000,
    isPaused: false,
    lastAiInteraction: null,
  };
}

const state = sampleState();
const exportMenuSource = readFileSync(
  new URL("../components/games/chess/ExportGameMenu.tsx", import.meta.url),
  "utf8"
);

check(
  "export disclosure does not advertise menu semantics",
  !/aria-haspopup="menu"|role="menu"|role="menuitem"/.test(exportMenuSource)
);
check(
  "export status is announced to assistive technology",
  exportMenuSource.includes('role="status"') &&
    exportMenuSource.includes('aria-live="polite"') &&
    exportMenuSource.includes('aria-atomic="true"')
);

const moveList = exportChessMoveList(state);
check("move list uses text/plain", moveList.mimeType === "text/plain", moveList);
check("move list filename is stable", moveList.filename === "ai-board-chess-moves.txt", moveList);
check("move list groups SAN by move number", moveList.content === "1. e4 e5 2. Nf3", moveList.content);

const fenList = exportChessFenList(state);
check("FEN list uses text/plain", fenList.mimeType === "text/plain", fenList);
check("FEN list includes initial FEN", fenList.content.includes(
  "Initial FEN: rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
), fenList.content);
check("FEN list includes every move FEN", fenList.content.includes(
  "After 1. e4: rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1"
) && fenList.content.includes(
  "After 1... e5: rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2"
) && fenList.content.includes(
  "After 2. Nf3: rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2"
), fenList.content);
check("FEN list includes current FEN", fenList.content.endsWith(`Current FEN: ${toFEN(state)}`), fenList.content);

const pgn = exportChessPgnLike(state, {
  date: "2026-06-23T12:34:00.000Z",
  white: "Ada",
  black: "Turing",
});
check("PGN-like export has pgn extension", pgn.filename === "ai-board-chess.pgn", pgn);
check("PGN-like export includes required tags", pgn.content.includes(
  [
    '[Event "AI Board Chess"]',
    '[Site "AI Board"]',
    '[Date "2026.06.23"]',
    '[Result "*"]',
  ].join("\n")
), pgn.content);
check("PGN-like export includes optional player tags", pgn.content.includes('[White "Ada"]') && pgn.content.includes('[Black "Turing"]'), pgn.content);
check("PGN-like export includes numbered SAN and result", pgn.content.endsWith("1. e4 e5 2. Nf3 *"), pgn.content);

check(
  "PGN-like result maps white checkmate",
  exportChessPgnLike({ ...state, status: "checkmate", winner: "white" }, { date: "2026.06.23" }).content.includes('[Result "1-0"]')
);
check(
  "PGN-like result maps black checkmate",
  exportChessPgnLike({ ...state, status: "checkmate", winner: "black" }, { date: "2026.06.23" }).content.includes('[Result "0-1"]')
);
check(
  "PGN-like result maps draws",
  exportChessPgnLike({ ...state, status: "draw", winner: null }, { date: "2026.06.23" }).content.includes('[Result "1/2-1/2"]')
);

const jsonExport = exportChessJson(sampleSnapshot());
const parsedJson = JSON.parse(jsonExport.content) as {
  export: { game: string; format: string; generatedAt: string };
  snapshot: ChessSessionSnapshot;
};
check("JSON export uses application/json", jsonExport.mimeType === "application/json", jsonExport);
check("JSON export includes compact metadata", parsedJson.export.game === "chess" && parsedJson.export.format === "json" && typeof parsedJson.export.generatedAt === "string", parsedJson);
check("JSON export includes snapshot", parsedJson.snapshot.gameState.moveHistory.length === 3 && parsedJson.snapshot.whiteTimeMs === 2500, parsedJson.snapshot);

const copied: string[] = [];
const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "navigator"
);
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    clipboard: {
      writeText: async (value: string) => {
        copied.push(value);
      },
    },
  },
});
await copyGameExportToClipboard(moveList);
check("copy helper writes export content", copied[0] === moveList.content, copied);

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {},
});
await expectReject(
  "copy helper rejects when clipboard is unavailable",
  () => copyGameExportToClipboard(moveList),
  /clipboard/i
);
if (originalNavigatorDescriptor) {
  Object.defineProperty(globalThis, "navigator", originalNavigatorDescriptor);
} else {
  delete (globalThis as unknown as { navigator?: unknown }).navigator;
}

const downloadEvents: Array<{ href: string; download: string; clicked: boolean }> = [];
const createdUrls: string[] = [];
const revokedUrls: string[] = [];
const exportForDownload: GameExport = {
  filename: "sample.txt",
  mimeType: "text/plain",
  content: "sample",
};
const originalBlobDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Blob");
const originalUrlDescriptor = Object.getOwnPropertyDescriptor(globalThis, "URL");
const originalDocumentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
Object.defineProperty(globalThis, "Blob", {
  configurable: true,
  value: class FakeBlob {
  readonly parts: unknown[];
  readonly type: string;
  constructor(parts: unknown[], options?: { type?: string }) {
    this.parts = parts;
    this.type = options?.type ?? "";
  }
} as unknown as typeof Blob,
});
Object.defineProperty(globalThis, "URL", {
  configurable: true,
  value: {
    createObjectURL: (blob: Blob) => {
      createdUrls.push((blob as unknown as { type: string }).type);
      return "blob:test-export";
    },
    revokeObjectURL: (url: string) => {
      revokedUrls.push(url);
    },
  },
});
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: {
    createElement: (tagName: string) => {
      if (tagName !== "a") throw new Error(`unexpected tag: ${tagName}`);
      const event = { href: "", download: "", clicked: false };
      downloadEvents.push(event);
      return {
        style: {},
        set href(value: string) {
          event.href = value;
        },
        get href() {
          return event.href;
        },
        set download(value: string) {
          event.download = value;
        },
        get download() {
          return event.download;
        },
        click: () => {
          event.clicked = true;
        },
        remove: () => {},
      } as HTMLAnchorElement;
    },
    body: {
      appendChild: () => {},
    },
  },
});
downloadGameExport(exportForDownload);
check(
  "download helper creates and revokes object URL",
  downloadEvents[0]?.href === "blob:test-export" &&
    downloadEvents[0]?.download === "sample.txt" &&
    downloadEvents[0]?.clicked === true &&
    createdUrls[0] === "text/plain;charset=utf-8" &&
    revokedUrls[0] === "blob:test-export",
  { downloadEvents, createdUrls, revokedUrls }
);

if (originalBlobDescriptor) {
  Object.defineProperty(globalThis, "Blob", originalBlobDescriptor);
} else {
  delete (globalThis as unknown as { Blob?: unknown }).Blob;
}
if (originalUrlDescriptor) {
  Object.defineProperty(globalThis, "URL", originalUrlDescriptor);
} else {
  delete (globalThis as unknown as { URL?: unknown }).URL;
}
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: undefined,
});

await expectReject(
  "download helper rejects when document is unavailable",
  async () => downloadGameExport(exportForDownload),
  /browser/i
);

if (originalDocumentDescriptor) {
  Object.defineProperty(globalThis, "document", originalDocumentDescriptor);
} else {
  delete (globalThis as unknown as { document?: unknown }).document;
}

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
