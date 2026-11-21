import { expect, test } from "bun:test";
import { ManualClock } from "../src/clock/index.ts";
import { uuidv7 } from "../src/ids/index.ts";

test("UUIDv7 使用 Clock 毫秒，版本和变体符合 RFC 9562", () => {
  const timeMs = 0x019001234567;
  const clock = new ManualClock("local", timeMs);
  const id = uuidv7(clock);
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const hex = id.replaceAll("-", "");
  expect(Number.parseInt(hex.slice(0, 12), 16)).toBe(timeMs);
  expect((Number.parseInt(hex.slice(12, 14), 16) >> 4)).toBe(7);
  expect((Number.parseInt(hex.slice(16, 18), 16) >> 6)).toBe(2);
});

test("同一时钟同毫秒和时间倒退时保持唯一且按创建顺序排序", () => {
  const clock = new ManualClock("local", 100);
  const ids: string[] = [];
  for (let i = 0; i < 2000; i += 1) {
    if (i === 1000) {
      clock.setWallMs(90);
    }
    ids.push(uuidv7(clock));
  }
  clock.setWallMs(110);
  ids.push(uuidv7(clock));
  expect(new Set(ids).size).toBe(ids.length);
  expect([...ids].sort()).toEqual(ids);
});

test("零时间和独立时钟可生成，非法时钟时间被拒绝", () => {
  expect(uuidv7(new ManualClock("zero"))).toStartWith("00000000-0000-7");
  const first = uuidv7(new ManualClock("a", 10));
  const second = uuidv7(new ManualClock("b", 10));
  expect(first).not.toBe(second);
  expect(() => uuidv7({
    wallMs: () => NaN,
    hlc: () => { throw new Error("不应调用"); },
    observe: () => { throw new Error("不应调用"); },
  })).toThrow(RangeError);
});
