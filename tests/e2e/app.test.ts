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
  await expect(page.locator(".metric-card")).toHaveCount(7);
});

test("趋势图可展开并通过 Escape 返回总览", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "展开图表：请求与缓解趋势" }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "请求与缓解趋势" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("多系列趋势可以只显示指定状态", async ({ page }) => {
  await page.goto("/");
  const panel = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "状态码趋势" }) });
  const trigger = panel.getByRole("button", { name: "显示系列：状态码趋势" });
  await trigger.click();
  await panel.getByRole("button", { name: "只看 200" }).click();
  await expect(trigger).toContainText("1/2");
  await expect(panel.getByRole("checkbox", { name: "200" })).toBeChecked();
  await expect(panel.getByRole("checkbox", { name: "403" })).not.toBeChecked();
  await panel.getByRole("button", { name: "显示全部" }).click();
  await expect(trigger).toContainText("2/2");
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
  await expect(page.locator(".global-nav nav")).toHaveCSS("position", "fixed");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
});

function fixture(pathname: string): unknown {
  if (pathname.endsWith("/me")) return { email: "test@example.com", subject: "test" };
  if (pathname.endsWith("/zones")) return { zones: [], capabilities: [] };
  if (pathname.endsWith("/metrics")) return { bucketSeconds: 300, series: ["200", "403"].map((name, index) => ({ name, points: [{ bucket_start: Date.now(), estimated_count: 12 - index, sample_interval: 1, confidence_lower: null, confidence_upper: null }] })) };
  if (pathname.endsWith("/requests")) return { items: [], nextCursor: null };
  if (pathname.endsWith("/security-events")) return { items: [], nextCursor: null };
  if (pathname.endsWith("/archives")) return { items: [] };
  if (pathname.endsWith("/health")) return { status: "unconfigured", now: Date.now(), d1WarningBytes: 419430400, usageToday: { graphqlQueries: 0, d1RowsRead: 0, d1RowsWritten: 0, d1SizeAfter: 0, queueMessages: 0, r2BytesWritten: 0 }, cursors: [], gaps: [], dlqJobs: 0 };
  if (pathname.endsWith("/settings/smtp")) return { configured: false, enabled: false };
  if (pathname.endsWith("/settings")) return { d1WarningBytes: 419430400, estimatedDailyQueueOperations: 0, safeDailyQueueOperations: 8000, capabilities: [] };
  if (pathname.endsWith("/saved-views")) return { items: [] };
  return {};
}
