import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const body = fixture(url.pathname);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
});

test("总览明确区分校正趋势与采样明细", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "总览" })).toBeVisible();
  await expect(page.getByText("采样校正趋势").first()).toBeVisible();
  await expect(page.getByText("明细是 Cloudflare 返回的真实请求样本")).toBeVisible();
  await expect(page.locator(".metric-card")).toHaveCount(4);
});

test("请求筛选会同步到 URL，并可在刷新后恢复", async ({ page }) => {
  await page.goto("/requests");
  await page.getByLabel("IP", { exact: true }).fill("192.0.2.10");
  await page.getByRole("button", { name: "查询" }).click();
  await expect(page).toHaveURL(/ip=192\.0\.2\.10/u);
  await page.reload();
  await expect(page.getByLabel("IP", { exact: true })).toHaveValue("192.0.2.10");
});

test("英文与移动布局可用", async ({ page }) => {
  await page.goto("/settings");
  await page.getByRole("combobox", { name: "语言" }).selectOption("en");
  await expect(page.getByRole("heading", { name: "Settings & Health" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".sidebar")).toHaveCSS("position", "fixed");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
});

function fixture(pathname: string): unknown {
  if (pathname.endsWith("/me")) return { email: "test@example.com", subject: "test" };
  if (pathname.endsWith("/zones")) return { zones: [], capabilities: [] };
  if (pathname.endsWith("/metrics")) return { bucketSeconds: 300, series: [] };
  if (pathname.endsWith("/requests")) return { items: [], nextCursor: null };
  if (pathname.endsWith("/security-events")) return { items: [], nextCursor: null };
  if (pathname.endsWith("/archives")) return { items: [] };
  if (pathname.endsWith("/health")) return { status: "unconfigured", now: Date.now(), d1WarningBytes: 419430400, usageToday: { graphqlQueries: 0, d1RowsRead: 0, d1RowsWritten: 0, d1SizeAfter: 0, queueMessages: 0, r2BytesWritten: 0 }, cursors: [], gaps: [] };
  if (pathname.endsWith("/settings/smtp")) return { configured: false, enabled: false };
  if (pathname.endsWith("/settings")) return { d1WarningBytes: 419430400, estimatedDailyQueueOperations: 0, safeDailyQueueOperations: 8000, capabilities: [] };
  if (pathname.endsWith("/saved-views")) return { items: [] };
  return {};
}
