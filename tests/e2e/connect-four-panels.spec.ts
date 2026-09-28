import { expect, test, type Page } from "@playwright/test";

async function startFreshPvpGame(page: Page): Promise<void> {
  await page.goto("/games/connect-four");
  await page.getByTestId("connect-four-start").click();
  await expect(page.getByTestId("connect-four-board")).toBeVisible();
}

async function panelWidths(page: Page): Promise<{
  red: number | undefined;
  yellow: number | undefined;
}> {
  const redBox = await page
    .getByTestId("connect-four-player-red")
    .boundingBox();
  const yellowBox = await page
    .getByTestId("connect-four-player-yellow")
    .boundingBox();
  expect(redBox).not.toBeNull();
  expect(yellowBox).not.toBeNull();
  return { red: redBox?.width, yellow: yellowBox?.width };
}

test("both player boxes share one width and keep it across a move", async ({
  page,
}) => {
  await startFreshPvpGame(page);

  const redTurn = page
    .getByTestId("connect-four-player-red")
    .getByText("Turn", { exact: true });
  const yellowTurn = page
    .getByTestId("connect-four-player-yellow")
    .getByText("Turn", { exact: true });
  await expect(redTurn).toHaveCount(1);
  await expect(yellowTurn).toHaveCount(1);
  await expect(redTurn).toBeVisible();
  await expect(yellowTurn).toBeHidden();

  const before = await panelWidths(page);
  expect(before.red).toBe(before.yellow);
  expect(before.red).toBeGreaterThan(300);

  await page.getByTestId("connect-four-cell-5-3").click();

  await expect(redTurn).toBeHidden();
  await expect(yellowTurn).toBeVisible();

  const after = await panelWidths(page);
  expect(after.red).toBe(after.yellow);
  expect(after.red).toBe(before.red);
});
