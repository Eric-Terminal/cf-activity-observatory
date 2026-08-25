import { nowMs } from "@/worker/utils";

// 应用计数不覆盖所有控制语句、索引写入和同账户数据库，预留 30% 避免免费额度被打满。
export const D1_DAILY_WRITE_PAUSE = 70_000;
export const D1_DAILY_BACKFILL_PAUSE = 20_000;

export async function d1WritesPaused(database: D1Database): Promise<boolean> {
  return (await d1RowsWrittenToday(database)) >= D1_DAILY_WRITE_PAUSE;
}

export async function d1RowsWrittenToday(database: D1Database): Promise<number> {
  const day = new Date(nowMs()).toISOString().slice(0, 10);
  const usage = await database.prepare("SELECT d1_rows_written FROM usage_daily WHERE day = ?")
    .bind(day)
    .first<{ d1_rows_written: number }>();
  return usage?.d1_rows_written ?? 0;
}
