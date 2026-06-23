import { expect, test } from "@playwright/test";

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
    await page.waitForTimeout(700);

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
