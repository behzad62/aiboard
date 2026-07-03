import { expect, test } from "@playwright/test";

test.describe("responsive tabs", () => {
  test("primary app navigation stays compact on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/games");

    const metrics = await page.evaluate(() => {
      const header = document.querySelector("header");
      if (!header) {
        throw new Error("Header was not found");
      }

      const rect = (element: Element) => {
        const bounds = element.getBoundingClientRect();
        return {
          bottom: bounds.bottom,
          height: bounds.height,
          top: bounds.top,
        };
      };

      const appLinkRects = ["Games", "Benchmark", "Settings"].map((label) => {
        const link = Array.from(header.querySelectorAll("a")).find(
          (element) => element.textContent?.trim() === label
        );

        if (!link) {
          throw new Error(`${label} navigation link was not found`);
        }

        return rect(link);
      });

      return {
        appNavVerticalSpan:
          Math.max(...appLinkRects.map((bounds) => bounds.bottom)) -
          Math.min(...appLinkRects.map((bounds) => bounds.top)),
        headerHeight: rect(header).height,
      };
    });

    expect(metrics.headerHeight).toBeLessThanOrEqual(120);
    expect(metrics.appNavVerticalSpan).toBeLessThanOrEqual(44);
  });

  test("settings page tab list contains wrapped tabs on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/settings");

    const metrics = await page.evaluate(() => {
      const tabList = Array.from(document.querySelectorAll('[role="tablist"]')).find(
        (element) => {
          const text = element.textContent ?? "";
          return text.includes("Providers") && text.includes("Security");
        }
      );

      if (!tabList) {
        throw new Error("Settings tab list was not found");
      }

      const tabs = Array.from(tabList.querySelectorAll('[role="tab"]'));
      const listRect = tabList.getBoundingClientRect();
      const tabRects = tabs.map((tab) => tab.getBoundingClientRect());

      return {
        listBottom: listRect.bottom,
        listHeight: listRect.height,
        maxTabBottom: Math.max(...tabRects.map((rect) => rect.bottom)),
        tabCount: tabs.length,
      };
    });

    expect(metrics.tabCount).toBe(5);
    expect(metrics.listHeight).toBeGreaterThan(40);
    expect(metrics.maxTabBottom).toBeLessThanOrEqual(metrics.listBottom + 1);
  });
});
