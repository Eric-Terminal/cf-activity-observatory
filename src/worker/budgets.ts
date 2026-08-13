import { nowMs } from "@/worker/utils";

export const D1_DAILY_WRITE_PAUSE = 80_000;
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
