import { expect, test, type Page } from "@playwright/test";

type DelayedAIResponseWindow = Window & {
  __delayedChessAIResponsesObserved?: number;
};

interface PersistedChessSnapshot {
  blackTimeMs?: number;
  gameState?: { moveHistory?: Array<{ san?: string }> };
  whiteTimeMs?: number;
}

type PromotionChoice = "Queen" | "Rook" | "Bishop" | "Knight";

const PROMOTION_EXPECTATIONS: Array<{
  choice: PromotionChoice;
  san: string;
}> = [
  { choice: "Queen", san: "e8=Q+" },
  { choice: "Rook", san: "e8=R+" },
  { choice: "Bishop", san: "e8=B" },
  { choice: "Knight", san: "e8=N" },
];

async function seedDelayedChessAIModel(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const now = new Date().toISOString();
    const store = {
      userSettings: {
        id: "default",
        defaultEffort: "medium",
        defaultMode: "panel",
        judgeModelId: null,
        defaultVerbosity: "balanced",
        defaultStyleNote: "",
        defaultReasoningEffort: "default",
        defaultBuildRunPolicy: "finish",
        defaultBuildBudgetUsd: 0,
        defaultBuildTimeLimitMinutes: 120,
      },
      providerKeys: [],
      customModels: [
        {
          id: "delayed-chess-ai",
          label: "Delayed Chess AI",
          baseURL: `${window.location.origin}/__chess-ai-test/v1`,
          model: "delayed-chess-ai",
          apiKey: "test-key",
          hasKey: true,
          capabilities: {
            image: false,
            document: false,
            audio: false,
            video: false,
          },
          lastValidationSucceeded: true,
          lastValidatedAt: now,
          createdAt: now,
        },
      ],
      discussions: [],
      messages: [],
      finalResults: [],
      attachments: [],
      buildFiles: [],
      buildCheckpoints: [],
      gameSessions: [],
      gameMatchRecords: [],
      gameStatsLegacyImportAttempted: false,
      modelStats: [],
    };

    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open("ai-discussion-board", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("kv")) {
          db.createObjectStore("kv");
        }
      };
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("kv", "readwrite");
        tx.objectStore("kv").put(
          JSON.stringify({
            v: 1,
            encrypted: false,
            data: JSON.stringify(store),
          }),
          "store"
        );
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      };
    });
  });
}

async function seedPromotionChessSession(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const now = new Date().toISOString();
    const promotionState = {
      board: [
        [{ color: "black", type: "king" }, null, null, null, null, null, null, null],
        [null, null, null, null, { color: "white", type: "pawn" }, null, null, null],
        [null, null, null, null, null, null, null, null],
        [null, null, null, null, null, null, null, null],
        [null, null, null, null, null, null, null, null],
        [null, null, null, null, null, null, null, null],
        [null, null, null, null, null, null, null, null],
        [null, null, null, null, { color: "white", type: "king" }, null, null, null],
      ],
      turn: "white",
      castlingRights: {
        whiteKingside: false,
        whiteQueenside: false,
        blackKingside: false,
        blackQueenside: false,
      },
      enPassantTarget: null,
      halfmoveClock: 0,
      fullmoveNumber: 1,
      status: "playing",
      winner: null,
      moveHistory: [],
    };
    const sessionSnapshot = {
      gameMode: "pvp",
      humanColor: "white",
      whiteAI: { modelId: "", reasoningEffort: "default" },
      blackAI: { modelId: "", reasoningEffort: "default" },
      gameState: promotionState,
      whiteTimeMs: 0,
      blackTimeMs: 0,
      gameStartTime: Date.now(),
      isPaused: false,
      lastAiInteraction: null,
    };
    const store = {
      userSettings: {
        id: "default",
        defaultEffort: "medium",
        defaultMode: "panel",
        judgeModelId: null,
        defaultVerbosity: "balanced",
        defaultStyleNote: "",
        defaultReasoningEffort: "default",
        defaultBuildRunPolicy: "finish",
        defaultBuildBudgetUsd: 0,
        defaultBuildTimeLimitMinutes: 120,
      },
      providerKeys: [],
      customModels: [],
      discussions: [],
      messages: [],
      finalResults: [],
      attachments: [],
      buildFiles: [],
      buildCheckpoints: [],
      gameSessions: [
        {
          id: "chess-active-session",
          gameId: "chess",
          title: "Chess: Player vs Player",
          status: "active",
          participants: [
            { id: "white", kind: "human", label: "White Player" },
            { id: "black", kind: "human", label: "Black Player" },
          ],
          stateJson: JSON.stringify(sessionSnapshot),
          metadataJson: JSON.stringify({
            version: 1,
            savedAt: now,
          }),
          createdAt: now,
          updatedAt: now,
        },
      ],
      gameMatchRecords: [],
      gameStatsLegacyImportAttempted: false,
      modelStats: [],
    };

    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open("ai-discussion-board", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("kv")) {
          db.createObjectStore("kv");
        }
      };
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("kv", "readwrite");
        tx.objectStore("kv").put(
          JSON.stringify({
            v: 1,
            encrypted: false,
            data: JSON.stringify(store),
          }),
          "store"
        );
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      };
    });
  });
}

function openAIStreamChunk(content: string): string {
  return [
    `data: ${JSON.stringify({
      id: "chatcmpl-delayed-chess-ai",
      object: "chat.completion.chunk",
      created: 0,
      model: "delayed-chess-ai",
      choices: [
        {
          index: 0,
          delta: { content },
          finish_reason: null,
        },
      ],
    })}`,
    `data: ${JSON.stringify({
      id: "chatcmpl-delayed-chess-ai",
      object: "chat.completion.chunk",
      created: 0,
      model: "delayed-chess-ai",
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop",
        },
      ],
    })}`,
    "data: [DONE]",
    "",
  ].join("\n\n");
}

async function installDelayedAIResponseObserver(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const observedWindow = window as DelayedAIResponseWindow;
    observedWindow.__delayedChessAIResponsesObserved = 0;

    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const response = await originalFetch(input, init);
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;

      if (
        !url.includes("/__chess-ai-test/v1/chat/completions") ||
        !response.body
      ) {
        return response;
      }

      const reader = response.body.getReader();
      let observed = false;
      const markObservedAfterClientTurn = () => {
        if (observed) return;
        observed = true;
        window.setTimeout(() => {
          observedWindow.__delayedChessAIResponsesObserved =
            (observedWindow.__delayedChessAIResponsesObserved ?? 0) + 1;
        }, 0);
      };

      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const result = await reader.read();
          if (result.done) {
            controller.close();
            markObservedAfterClientTurn();
            return;
          }

          controller.enqueue(result.value);
          markObservedAfterClientTurn();
        },
        cancel(reason) {
          return reader.cancel(reason);
        },
      });

      return new Response(stream, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      });
    };
  });
}

async function waitForDelayedAIResponseObserved(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as DelayedAIResponseWindow)
              .__delayedChessAIResponsesObserved ?? 0
        ),
      { timeout: 5000 }
    )
    .toBeGreaterThan(0);
}

async function readPersistedChessSnapshot(
  page: Page
): Promise<PersistedChessSnapshot | null> {
  return page.evaluate(async () => {
    const rawStore = await new Promise<unknown>((resolve) => {
      const req = indexedDB.open("ai-discussion-board", 1);
      req.onerror = () => resolve(null);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("kv", "readonly");
        const getReq = tx.objectStore("kv").get("store");
        getReq.onerror = () => {
          db.close();
          resolve(null);
        };
        getReq.onsuccess = () => {
          db.close();
          resolve(getReq.result);
        };
      };
    });

    if (typeof rawStore !== "string") return null;

    try {
      const parsedStore = JSON.parse(rawStore) as
        | {
            encrypted?: boolean;
            data?: string;
          }
        | {
            gameSessions?: Array<{ id?: string; stateJson?: string }>;
          };
      const store =
        "encrypted" in parsedStore
          ? parsedStore.encrypted || typeof parsedStore.data !== "string"
            ? null
            : (JSON.parse(parsedStore.data) as {
                gameSessions?: Array<{
                  id?: string;
                  stateJson?: string;
                }>;
              })
          : (parsedStore as {
              gameSessions?: Array<{ id?: string; stateJson?: string }>;
            });

      if (!store) return null;

      const session = store.gameSessions?.find(
        (record) => record.id === "chess-active-session"
      );
      if (!session?.stateJson) return null;

      return JSON.parse(session.stateJson) as PersistedChessSnapshot;
    } catch {
      return null;
    }
  });
}

async function waitForPersistedChessMove(page: Page, san: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const snapshot = await readPersistedChessSnapshot(page);
        return snapshot?.gameState?.moveHistory?.some(
          (move) => move.san === san
        );
      },
      { timeout: 5000 }
    )
    .toBe(true);
}

async function waitForPersistedBlackClock(
  page: Page,
  minMs: number
): Promise<void> {
  await expect
    .poll(
      async () => {
        const snapshot = await readPersistedChessSnapshot(page);
        return snapshot?.blackTimeMs ?? 0;
      },
      { timeout: 10_000 }
    )
    .toBeGreaterThanOrEqual(minMs);
}

test.describe("Chess game", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/games");
    await page.waitForLoadState("networkidle");
  });

  test("setup screen shows game modes", async ({ page }) => {
    await expect(page.getByText("Player vs Player")).toBeVisible();
    await expect(page.getByText("Player vs AI")).toBeVisible();
    await expect(page.getByText("AI vs AI")).toBeVisible();

    await expect(page.getByText("Two humans play")).toBeVisible();
    await expect(page.getByText("Play against an AI")).toBeVisible();
    await expect(page.getByText("Watch AIs compete")).toBeVisible();
  });

  test("player vs AI shows the AI config panel", async ({ page }) => {
    await page.click("text=Player vs AI");
    await page.waitForTimeout(300);

    await expect(page.getByText("Play as")).toBeVisible();
    await expect(page.getByText("Black AI")).toBeVisible();
    await expect(page.locator('label:has-text("Model")')).toBeVisible();
    await expect(page.getByText("Reasoning Level")).toBeVisible();
    await expect(page.locator('input[type="range"]')).toBeVisible();
  });

  test("AI vs AI shows two AI config panels", async ({ page }) => {
    await page.click("text=AI vs AI");
    await page.waitForTimeout(300);

    await expect(page.getByText("White AI")).toBeVisible();
    await expect(page.getByText("Black AI")).toBeVisible();

    const modelLabels = page.locator('label:has-text("Model")');
    await expect(modelLabels).toHaveCount(2);

    const sliders = page.locator('input[type="range"]');
    await expect(sliders).toHaveCount(2);
  });

  test("player vs player gameplay supports move, pause, resume, and reset", async ({ page }) => {
    await page.click("text=Player vs Player");
    await page.click('button:has-text("Start Game")');
    await page.waitForTimeout(500);

    const board = page.locator(".grid-cols-8");
    await expect(board).toBeVisible();

    const svgPieces = page.locator(".grid-cols-8 svg");
    await expect(svgPieces).toHaveCount(32);

    const squares = page.locator(".grid-cols-8 > div");
    await squares.nth(52).click();
    await page.waitForTimeout(300);

    const legalMoveIndicators = page.locator(".grid-cols-8 .rounded-full");
    await expect(legalMoveIndicators.first()).toBeVisible();

    await squares.nth(36).click();
    await page.waitForTimeout(300);

    await expect(page.getByTestId("chess-clock-black")).toContainText("Black");

    await page.waitForTimeout(1000);
    const whiteClockTime = page.locator(".font-mono.tabular-nums").first();
    const whiteTime = await whiteClockTime.textContent();
    expect(whiteTime).toBeTruthy();

    await page.click('button:has-text("Pause")');
    await page.waitForTimeout(200);

    await expect(page.getByTestId("game-controls")).toContainText("Paused");

    await page.click('button:has-text("Resume")');
    await page.waitForTimeout(200);

    await expect(page.getByTestId("game-controls")).toContainText("Playing");

    await page.click('button:has-text("Reset")');
    await page.waitForTimeout(300);

    await expect(page.getByText("Player vs Player")).toBeVisible();
    await expect(page.locator('button:has-text("Start Game")')).toBeVisible();
  });

  test("restores an active player vs player game after refresh", async ({ page }) => {
    await page.click("text=Player vs Player");
    await page.click('button:has-text("Start Game")');

    const squares = page.locator(".grid-cols-8 > div");
    await squares.nth(52).click();
    await squares.nth(36).click();

    await expect(page.getByText("e4")).toBeVisible();
    await waitForPersistedChessMove(page, "e4");
    await waitForPersistedBlackClock(page, 4_000);

    await page.reload();
    await page.waitForLoadState("networkidle");

    await expect(page.getByTestId("restore-game-banner")).toBeVisible();
    await page.getByTestId("resume-game-button").click();

    await expect(page.getByText("e4")).toBeVisible();
    await expect(page.getByTestId("chess-clock-white")).toContainText(/\d{2}:\d{2}/);
    await expect(page.getByTestId("chess-clock-black")).toContainText(/\d{2}:\d{2}/);
    await expect(page.getByTestId("chess-clock-black")).not.toContainText("00:00");
  });

  test("player pawn promotion accepts all promotion choices", async ({ context }) => {
    for (const { choice, san } of PROMOTION_EXPECTATIONS) {
      await test.step(`promotes to ${choice}`, async () => {
        const promotionPage = await context.newPage();
        try {
          await promotionPage.goto("/games");
          await promotionPage.waitForLoadState("networkidle");
          await seedPromotionChessSession(promotionPage);
          await promotionPage.reload();
          await promotionPage.waitForLoadState("networkidle");

          await expect(promotionPage.getByTestId("restore-game-banner")).toBeVisible();
          await promotionPage.getByTestId("resume-game-button").click();

          await promotionPage.getByTestId("square-e7").click();
          await promotionPage.getByTestId("square-e8").click();

          const dialog = promotionPage.getByRole("dialog", {
            name: "Choose promotion",
          });
          await expect(dialog).toBeVisible();
          await dialog.getByRole("button", { name: choice }).click();

          await expect(dialog).toBeHidden();
          await expect(
            promotionPage.getByTestId("square-e7").getByTestId("chess-piece")
          ).toHaveCount(0);
          await expect(
            promotionPage.getByTestId("square-e8").getByTestId("chess-piece")
          ).toHaveCount(1);
          await expect(
            promotionPage.getByText(san, { exact: true })
          ).toBeVisible();
        } finally {
          await promotionPage.close();
        }
      });
    }
  });

  test("promotion dialog supports keyboard focus, trapping, cancel, and selection", async ({ page }) => {
    await seedPromotionChessSession(page);
    await page.reload();
    await page.waitForLoadState("networkidle");

    await expect(page.getByTestId("restore-game-banner")).toBeVisible();
    await page.getByTestId("resume-game-button").click();

    await page.getByTestId("square-e7").click();
    await page.getByTestId("square-e8").click();

    const dialog = page.getByRole("dialog", { name: "Choose promotion" });
    const queenButton = dialog.getByRole("button", { name: "Queen" });
    const rookButton = dialog.getByRole("button", { name: "Rook" });
    const bishopButton = dialog.getByRole("button", { name: "Bishop" });
    const knightButton = dialog.getByRole("button", { name: "Knight" });

    await expect(dialog).toBeVisible();
    await expect(queenButton).toBeFocused();

    await page.keyboard.press("Tab");
    await expect(rookButton).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(bishopButton).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(knightButton).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(queenButton).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(
      page.getByTestId("square-e7").getByTestId("chess-piece")
    ).toHaveCount(1);
    await expect(
      page.getByTestId("square-e8").getByTestId("chess-piece")
    ).toHaveCount(0);

    await page.getByTestId("square-e7").click();
    await page.getByTestId("square-e8").click();
    await expect(dialog).toBeVisible();
    await expect(queenButton).toBeFocused();

    await page.keyboard.press("Tab");
    await expect(rookButton).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(dialog).toBeHidden();
    await expect(
      page.getByTestId("square-e7").getByTestId("chess-piece")
    ).toHaveCount(0);
    await expect(
      page.getByTestId("square-e8").getByTestId("chess-piece")
    ).toHaveCount(1);
    await expect(page.getByText("e8=R+", { exact: true })).toBeVisible();
  });

  test("reset ignores a stale delayed AI move", async ({ page }) => {
    let aiRequestCount = 0;
    let releaseAIResponse!: () => void;
    const aiResponseReleased = new Promise<void>((resolve) => {
      releaseAIResponse = resolve;
    });

    await page.route("**/__chess-ai-test/v1/chat/completions", async (route) => {
      aiRequestCount += 1;
      await aiResponseReleased;
      await route.fulfill({
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
        },
        body: openAIStreamChunk('{"from":"e2","to":"e4"}'),
      });
    });

    await installDelayedAIResponseObserver(page);
    await seedDelayedChessAIModel(page);
    await page.reload();
    await page.waitForLoadState("networkidle");

    await page.getByTestId("game-mode-pvai").click();
    await page.getByTestId("color-black").click();
    await expect(page.getByTestId("model-select-white")).toHaveValue(
      "custom:delayed-chess-ai"
    );

    await page.getByTestId("start-game-button").click();
    await expect(page.getByTestId("ai-thinking")).toBeVisible();
    await expect
      .poll(() => aiRequestCount, { timeout: 5000 })
      .toBeGreaterThanOrEqual(1);

    await page.getByTestId("game-reset").click();
    await expect(page.getByTestId("start-game-button")).toBeVisible();

    releaseAIResponse();
    await waitForDelayedAIResponseObserved(page);

    await expect(
      page.getByTestId("square-e2").getByTestId("chess-piece")
    ).toHaveCount(1);
    await expect(
      page.getByTestId("square-e4").getByTestId("chess-piece")
    ).toHaveCount(0);
  });

  test("benchmark page includes the chess benchmark segment", async ({ page }) => {
    await page.goto("/benchmark");
    await page.waitForLoadState("networkidle");

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

    const benchmarkSection = page.locator("h2", {
      hasText: "AI vs AI Chess Benchmark",
    });
    await expect(benchmarkSection).toBeVisible({ timeout: 10000 });
  });
});
