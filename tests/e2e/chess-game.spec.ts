import { expect, test, type Page } from "@playwright/test";

async function waitForPersistedChessMove(page: Page, san: string): Promise<void> {
  await expect
    .poll(
      async () => {
        return page.evaluate(async (expectedSan) => {
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

          if (typeof rawStore !== "string") return false;

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

            if (!store) return false;

            const typedStore = store as {
              gameSessions?: Array<{ id?: string; stateJson?: string }>;
            };
            const session = typedStore.gameSessions?.find(
              (record) => record.id === "chess-active-session"
            );
            if (!session?.stateJson) return false;

            const snapshot = JSON.parse(session.stateJson) as {
              gameState?: { moveHistory?: Array<{ san?: string }> };
            };
            return snapshot.gameState?.moveHistory?.some(
              (move) => move.san === expectedSan
            );
          } catch {
            return false;
          }
        }, san);
      },
      { timeout: 5000 }
    )
    .toBe(true);
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

    await page.reload();
    await page.waitForLoadState("networkidle");

    await expect(page.getByTestId("restore-game-banner")).toBeVisible();
    await page.getByTestId("resume-game-button").click();

    await expect(page.getByText("e4")).toBeVisible();
    await expect(page.getByTestId("chess-clock-white")).toContainText(/\d{2}:\d{2}/);
    await expect(page.getByTestId("chess-clock-black")).toContainText(/\d{2}:\d{2}/);
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
