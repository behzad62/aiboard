import { expect, test, type Page } from "@playwright/test";

async function startFreshPvpGame(page: Page): Promise<void> {
  await page.goto("/games/quoridor");
  await page.getByTestId("quoridor-start").click();
  await expect(page.getByTestId("quoridor-board")).toBeVisible();
}

test("moves and walls share one board and both player boxes share one width", async ({
  page,
}) => {
  await startFreshPvpGame(page);

  await expect(page.getByTestId("quoridor-mode-move")).toHaveCount(0);
  await expect(page.getByTestId("quoridor-mode-wall")).toHaveCount(0);
  await expect(page.getByTestId("quoridor-orientation-H")).toBeVisible();
  await expect(page.getByTestId("quoridor-orientation-V")).toBeVisible();

  await expect(page.getByTestId("quoridor-square-7-4")).toBeEnabled();
  await expect(page.getByTestId("quoridor-wall-0-0")).toBeEnabled();

  const northBox = await page
    .getByTestId("quoridor-player-north")
    .boundingBox();
  const southBox = await page
    .getByTestId("quoridor-player-south")
    .boundingBox();
  expect(northBox).not.toBeNull();
  expect(southBox).not.toBeNull();
  expect(northBox?.width).toBe(southBox?.width);
  expect(northBox?.width).toBeGreaterThan(300);

  await expect(
    page.getByTestId("quoridor-player-north").getByText("Turn", { exact: true })
  ).toHaveCount(1);
  await expect(
    page.getByTestId("quoridor-player-south").getByText("Turn", { exact: true })
  ).toHaveCount(1);
});

test("hovering a wall intersection previews the full wall before placement", async ({
  page,
}) => {
  await startFreshPvpGame(page);

  const intersection = page.getByTestId("quoridor-wall-4-4");
  const leftGap = page.getByTestId("quoridor-hgap-4-4");
  const rightGap = page.getByTestId("quoridor-hgap-4-5");
  await expect(intersection).toBeEnabled();

  await intersection.hover();
  await expect(intersection).toHaveClass(/bg-sky-400\/70/);
  await expect(leftGap).toHaveClass(/bg-sky-400\/60/);
  await expect(rightGap).toHaveClass(/bg-sky-400\/60/);
  await expect(page.getByTestId("quoridor-walls-south")).toHaveText("10");

  await page.getByTestId("quoridor-orientation-V").hover();
  await expect(intersection).not.toHaveClass(/bg-sky-400\/70/);
  await expect(leftGap).not.toHaveClass(/bg-sky-400\/60/);
  await expect(rightGap).not.toHaveClass(/bg-sky-400\/60/);

  await page.getByTestId("quoridor-orientation-V").click();
  const verticalIntersection = page.getByTestId("quoridor-wall-2-5");
  const topGap = page.getByTestId("quoridor-vgap-2-5");
  const bottomGap = page.getByTestId("quoridor-vgap-3-5");
  await verticalIntersection.hover();
  await expect(verticalIntersection).toHaveClass(/bg-sky-400\/70/);
  await expect(topGap).toHaveClass(/bg-sky-400\/60/);
  await expect(bottomGap).toHaveClass(/bg-sky-400\/60/);

  await verticalIntersection.click();
  await expect(verticalIntersection).toHaveClass(/bg-amber-950/);
  await expect(topGap).toHaveClass(/bg-amber-950/);
  await expect(bottomGap).toHaveClass(/bg-amber-950/);
  await expect(page.getByTestId("quoridor-walls-south")).toHaveText("9");
  await expect(page.getByTestId("quoridor-status")).toContainText(
    "North to move"
  );
});
