import { wallDate } from "../clock/index.ts";
import { localISO, parseTicketTime } from "../tickets/time.ts";
import { TicketError } from "../tickets/types.ts";

type TicketTime = { instant: number; wall: string };

export type TicketIntent =
  | { kind: "schedule"; when: TicketTime; topic: string }
  | { kind: "start"; topic: string }
  | { kind: "reschedule"; target: string; when: TicketTime }
  | { kind: "append"; target: string }
  | { kind: "cancel"; target: string };

const digits = "零一二三四五六七八九";
const count = (part: string): number => {
  if (/^\d+$/.test(part)) return Number(part);
  if (part === "两") return 2;
  const [tens, ones] = part.split("十");
  return ones === undefined ? digits.indexOf(part) : (tens ? digits.indexOf(tens) : 1) * 10 + (ones ? digits.indexOf(ones) : 0);
};

function localTime(value: string, anchor: number, zone: string): TicketTime | undefined {
  const compact = value.replaceAll(/\s/g, "");
  const iso = /^(\d{4}-\d\d-\d\d)T(\d\d:\d\d(?::\d\d)?(?:Z|[+-]\d\d:\d\d)?)$/.exec(compact);
  const local = localISO(anchor, zone).slice(0, 10);
  const dateAndTime = /^(今天|明天|后天|大后天|明晚|今晚|(?:\d{4}年)?\d{1,2}月\d{1,2}[日号]|\d{4}-\d\d-\d\d|(?:本|这|下)?(?:周|星期)[一二三四五六日天])(.+)$/.exec(compact);
  if (!iso && !dateAndTime) return;
  let time = iso ? compact : undefined;
  if (dateAndTime && !iso) {
    const date = dateAndTime[1]!;
    const clock = dateAndTime[2]!;
    const today = Date.parse(local);
    const relative: Record<string, number> = { 今天: 0, 明天: 1, 后天: 2, 大后天: 3, 今晚: 0, 明晚: 1 };
    const monthDay = /^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})[日号]$/.exec(date);
    const week = /^(本|这|下)?(?:星期|周)([一二三四五六日天])$/.exec(date);
    let day = date;
    if (Object.hasOwn(relative, date)) {
      day = localISO(today + relative[date]! * 86_400_000, "UTC").slice(0, 10);
    } else if (monthDay) {
      day = `${monthDay[1] ?? local.slice(0, 4)}-${monthDay[2]!.padStart(2, "0")}-${monthDay[3]!.padStart(2, "0")}`;
    } else if (week) {
      const weekday = (wallDate(today).getUTCDay() + 6) % 7;
      const to = "一二三四五六日".indexOf(week[2]!.replace("天", "日"));
      let advance = to - weekday;
      if (week[1] === "下" || !week[1] && advance < 0) advance += 7;
      day = localISO(today + advance * 86_400_000, "UTC").slice(0, 10);
    }
    const hourMatch = /^(凌晨|早上|上午|中午|下午|傍晚|晚上)?([\d零一二两三四五六七八九十]{1,3})(?::([0-5]\d)|[点时](半|一刻|三刻|[\d零一二两三四五六七八九十]{1,3}分?)?)$/.exec(clock);
    if (!hourMatch) return;
    const [, period = date.endsWith("晚") ? "晚上" : "", hour, digital, spoken] = hourMatch;
    let hh = count(hour!);
    const mm = digital ? Number(digital) : !spoken ? 0 : spoken === "半" ? 30 : spoken === "一刻" ? 15
      : spoken === "三刻" ? 45 : count(spoken.replace(/分$/, ""));
    if (period && (hh < 1 || hh > 12) || hh < 0 || mm < 0 || mm > 59) return;
    if (!period && !digital && hh >= 1 && hh <= 12 && !/^0[1-9]$/.test(hour!)) return;
    if (/^(下午|傍晚|晚上)$/.test(period) && hh < 12 || period === "中午" && hh < 11) hh += 12;
    if (/^(凌晨|早上|上午)$/.test(period) && hh === 12) hh = 0;
    time = `${day}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  }
  try {
    if (!time) return;
    const instant = parseTicketTime(time, zone);
    return { instant, wall: localISO(instant, zone) };
  } catch (error) {
    if (!(error instanceof TicketError)) throw error;
  }
}

function topic(value: string) {
  const text = value.trim();
  return text && !/[，,]/.test(text) && [...text].length <= 60 ? text : undefined;
}

/** 只承认本轮的单一、明示请求。日期以该条消息当时的成员本地日期解释。 */
export function ticketChatIntent(text: string, anchor: number, zone: string): TicketIntent | undefined {
  const sentence = text.trim().replace(/^(?:@?团子|猫猫)[，,：:、\s]*/, "").replace(/[。！？!?～~]+$/, "");
  const invitation = /(?:，\s*)?(?:好吗|可以吗|行吗|好不好|吧)$/.exec(sentence);
  const request = (invitation ? sentence.slice(0, invitation.index) : sentence).trim();
  if (/[\n\r。！？!?；;「」『』“”'"《》]/.test(request) || /(?:吗|是不是)$/.test(request)
    || /(?:如果|假如|假设|比如|举个例|要是|倘若|只是举例|只是假设|不用|不必|别帮|不要安排|不要托付|不要真的|只是假装|当作例子)/.test(request)) return;

  const appointment = /^(?:(?:我们)?(?:约好|定好|说定|约定|约在)|(?:请|麻烦)?(?:帮我)?(?:安排(?:和你)?|约一下)|我们约个时间[，,]?)\s*(.+?)[，,\s]*(?:再聊|聊聊|聊|说说)\s*(.+)$/.exec(request)
    ?? (invitation ? /^(.+?)[，,\s]*(?:我们|和你|和我)?(?:再聊|聊聊|聊|说说)\s*(.+)$/.exec(request) : null)
    ?? /^(.+?)[，,\s]*(?:来找我|提醒我)(?:再聊|聊聊|聊|说说)\s*(.+)$/.exec(request);
  if (appointment) {
    const when = localTime(appointment[1]!, anchor, zone);
    const about = topic(appointment[2]!);
    return when && about && !/(?:了|过|没有)$/.test(about) ? { kind: "schedule", when, topic: about } : undefined;
  }

  const changed = /^(?:请|麻烦)?(?:把|将)?\s*(.+?)(?:改期到|改到|改为|改成)\s*(.+)$/.exec(request);
  if (changed) {
    const when = localTime(changed[2]!, anchor, zone);
    return when ? { kind: "reschedule", target: changed[1]!.trim(), when } : undefined;
  }

  const cancel = /^(?:请|麻烦)?(?:帮我)?(?:取消|撤销|撤回)\s*(.+)$/.exec(request)
    ?? /^(?:请)?(?:把|将)\s*(.+?)(?:取消|撤销|撤回)(?:掉)?$/.exec(request);
  if (cancel) return { kind: "cancel", target: cancel[1]!.trim() };

  const supplement = /^(?:请|麻烦)?(?:给|为)\s*(.+?)\s*补充[：:]\s*(\S.*)$/.exec(request)
    ?? /^(?:请|麻烦)?(?:继续|接着)\s*(.+)$/.exec(request);
  if (supplement) return { kind: "append", target: supplement[1]!.trim() };

  const mandate = /^(?:(?:请|麻烦|拜托)\s*(?:你|帮我)?|(?:能不能|可以|请你|想请你)?帮我|我想(?:托付你|请你))\s*(?:之后|稍后|慢慢|花点时间)?\s*((?:想想?|整理|梳理|列|拟|写|规划|构思|准备|总结|分析|比较|归纳|起草).+)$/.exec(request);
  const goal = mandate && topic(mandate[1]!);
  if (goal && !/(?:记住|记一下|记下来|保存(?:我的|这条|这个)|记忆|联网|上网|搜索|外部文档|执行代码)/.test(goal)) {
    return { kind: "start", topic: goal };
  }
}
