import { z } from "zod";
import { wallDate } from "../clock/index.ts";
import { localISO } from "../tickets/time.ts";

export const timeZoneSchema = z.string().min(1).max(100).refine((timeZone) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return true;
  } catch {
    return false;
  }
});
export const localDay = (at: number, zone: string) => localISO(at, zone).slice(0, 10);
export const nextDay = (day: string, offset = 1) =>
  wallDate(Date.parse(`${day}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);

/** 查找 IANA 本地日期的第一个真实时刻，包括跳过午夜或整日的情况。 */
export function dayStart(day: string, zone: string): number {
  let low = Date.parse(day + "T00:00:00Z") - 36 * 3600000;
  let high = low + 72 * 3600000;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (localDay(mid, zone) < day) low = mid;
    else high = mid;
  }
  return high;
}
