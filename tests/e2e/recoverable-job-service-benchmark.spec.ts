import { expect, test } from "@playwright/test";

test("Recoverable Job Service pack exposes its exact public scope and readiness gate", async ({
  page,
}) => {
  await page.goto("/benchmark");
  await page.getByText("Advanced: run a single suite or pack", { exact: true }).click();

  await page.getByRole("combobox", { name: "Track" }).click();
  await page.getByRole("option", { name: "WorkBench" }).click();
  await page.getByRole("combobox", { name: "WorkBench case pack" }).click();
  await page
    .getByRole("option", { name: "Recoverable Job Service", exact: true })
    .focus();
  await page.keyboard.press("Enter");

  await expect(page.getByText("Published evaluation scope", { exact: true })).toBeVisible();
  await expect(page.getByText(/69 mandatory families/)).toBeVisible();
  await expect(page.getByText(/302 variants/)).toBeVisible();
  await expect(page.getByText(/11 model-visible files/)).toBeVisible();
  await expect(page.getByText(/Binary scoring/)).toBeVisible();
  await expect(page.getByText("node verify.mjs", { exact: true })).toBeVisible();
  await expect(page.getByText("Recoverable Job Service runtime not checked", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Download WorkBench runner bundle" })
  ).toHaveAttribute("href", "/aiboard-workbench-runner.zip");
  await expect(page.getByRole("button", { name: "Run selected benchmark" })).toBeDisabled();
});
