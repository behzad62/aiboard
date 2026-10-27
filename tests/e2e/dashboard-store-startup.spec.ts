import { expect, test } from "@playwright/test";

test("dashboard initializes a fresh store without a runtime error", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "What are we working on?" })).toBeVisible();
  // Wait for initialization, including its reads of IndexedDB, to finish.
  await expect.poll(() => page.evaluate(async () => {
    const databases = await indexedDB.databases();
    return databases.some((database) => database.name === "ai-discussion-board");
  })).toBe(true);
  await expect(page.getByText("Failed to load dashboard")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("dashboard shows the lock screen for encrypted storage", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("ai-discussion-board", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("kv");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("kv", "readwrite");
      transaction.objectStore("kv").put(JSON.stringify({ v: 1, encrypted: true, data: "locked" }), "store");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  });

  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.reload();
  await expect(page.getByText("Storage is locked")).toBeVisible();
  expect(errors).toEqual([]);
});
