import { TicketError } from "./types.ts";

export const DEFAULT_TICKET_TIME_ZONE = "Asia/Shanghai";

export function localISO(instant: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(instant);
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

export function parseTicketTime(when: string, timeZone: string): number {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d)(?::(\d\d)(\.\d{1,3})?)?(Z|[+-]\d\d:\d\d)?$/.exec(when);
  if (!match || (match[3] && !match[4])) {
    throw new TicketError(400, "invalid_request", "请先说清具体日期和时间");
  }
  const local = `${match[1]}:${match[2] ?? "00"}`;
  const wall = Date.parse(`${local}Z`);
  if (!Number.isFinite(wall) || localISO(wall, "UTC") !== local) {
    throw new TicketError(400, "invalid_request", "请填写有效的日期和时间");
  }
  if (match[4]) {
    const instant = Date.parse(when);
    if (!Number.isFinite(instant)) {
      throw new TicketError(400, "invalid_request", "时区偏移无效");
    }
    return instant;
  }

  // 以本地时间前后两天的偏移求候选。回拨包括非整小时的时区。
  const day = 86_400_000;
  const candidates = new Set([wall - day, wall, wall + day].map((sample) =>
    wall + sample - Date.parse(`${localISO(sample, timeZone)}Z`)));
  const matches = [...candidates].filter((instant) => localISO(instant, timeZone) === local);
  if (matches.length !== 1) {
    throw new TicketError(400, "invalid_request", matches.length
      ? "这个时间有两个时区偏移，请说清具体偏移" : "这个本地时间不存在，请换个时间");
  }
  return matches[0]!;
}

/** 当地 22:00–09:00 安静，返回当前或下一个可以开口的时间。 */
export function availableAt(instant: number, timeZone: string): number {
  const local = localISO(instant, timeZone);
  const hour = Number(local.slice(11, 13));
  if (hour >= 9 && hour < 22) {
    return instant;
  }
  const date = local.slice(0, 10);
  const day = hour < 9 ? date : localISO(Date.parse(date) + 86_400_000, "UTC").slice(0, 10);
  return parseTicketTime(`${day}T09:00`, timeZone);
}
