import { expect, test } from "bun:test";
import {
  ClockDriftError,
  ManualClock,
  SystemClock,
  compareHlc,
  encodeHlc,
  parseHlc,
} from "../src/clock/index.ts";
import type { Hlc } from "../src/clock/index.ts";

function stamp(physicalMs: number, logical = 0, nodeId = "remote"): Hlc {
  return { physicalMs, logical, nodeId };
}

test("手动时间可设置与推进，墙钟倒退不影响 HLC 单调性", () => {
  const clock = new ManualClock("local", 100);
  expect(clock.hlc()).toEqual(stamp(100, 0, "local"));
  expect(clock.hlc()).toEqual(stamp(100, 1, "local"));
  clock.setWallMs(90);
  expect(clock.hlc()).toEqual(stamp(100, 2, "local"));
  clock.advance(20);
  expect(clock.wallMs()).toBe(110);
  expect(clock.hlc()).toEqual(stamp(110, 0, "local"));
  expect(new ManualClock("zero").hlc()).toEqual(stamp(0, 0, "zero"));
});

test("真实时钟读取系统时间", () => {
  const clock = new SystemClock("real");
  const before = Date.now();
  const value = clock.hlc();
  expect(value.physicalMs).toBeGreaterThanOrEqual(before);
  expect(value.physicalMs).toBeLessThanOrEqual(Date.now());
});

test("observe 覆盖墙钟、本地、远端和同物理时间的最大值", () => {
  const clock = new ManualClock("local", 100);
  expect(clock.observe(stamp(90, 8))).toEqual(stamp(100, 0, "local"));
  expect(clock.observe(stamp(90, 9))).toEqual(stamp(100, 1, "local"));
  expect(clock.observe(stamp(110, 4))).toEqual(stamp(110, 5, "local"));
  expect(clock.observe(stamp(110, 9))).toEqual(stamp(110, 10, "local"));
  expect(clock.observe(stamp(110, 2))).toEqual(stamp(110, 11, "local"));
  clock.setWallMs(120);
  expect(clock.observe(stamp(110, 20))).toEqual(stamp(120, 0, "local"));
});

test("超前偏差拒绝使用类型错误，拒绝不改变状态", () => {
  const clock = new ManualClock("local", 100, { maxDriftMs: 10 });
  clock.hlc();
  expect(() => clock.observe(stamp(111))).toThrow(ClockDriftError);
  expect(clock.hlc()).toEqual(stamp(100, 1, "local"));
  expect(clock.observe(stamp(110))).toEqual(stamp(110, 1, "local"));
  const defaults = new ManualClock("default", 0);
  expect(() => defaults.observe(stamp(300_001))).toThrow(ClockDriftError);
  expect(defaults.observe(stamp(300_000)).physicalMs).toBe(300_000);
});

test("逻辑计数溢出推进物理时间，超出范围报错且状态保持有效", () => {
  const clock = new ManualClock("local", 100);
  expect(clock.observe(stamp(100, 0xffffffff))).toEqual(stamp(101, 0, "local"));
  const end = new ManualClock("end", 0xffffffffffff);
  expect(() => end.observe(stamp(0xffffffffffff, 0xffffffff))).toThrow(RangeError);
  expect(end.hlc()).toEqual(stamp(0xffffffffffff, 0, "end"));
});

test("固定宽编码往返与比较顺序一致，包括节点前缀", () => {
  const values: Hlc[] = [];
  const nodes = ["A", "a", "aa", "a-", "b", "_", "z".repeat(64)];
  let seed = 42;
  for (let i = 0; i < 300; i += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    values.push(stamp(seed % 7, (seed >>> 4) % 5, nodes[i % nodes.length]!));
  }
  values.push(stamp(0, 0, "A"), stamp(0xffffffffffff, 0xffffffff, "z"));
  for (const value of values) {
    expect(encodeHlc(value).length).toBe(150);
    expect(parseHlc(encodeHlc(value))).toEqual(value);
  }
  expect([...values].sort(compareHlc).map(encodeHlc))
    .toEqual(values.map(encodeHlc).sort());
  for (let i = 1; i < nodes.length; i += 1) {
    const left = stamp(1, 1, nodes[i - 1]!);
    const right = stamp(1, 1, nodes[i]!);
    expect(Math.sign(compareHlc(left, right))).toBe(
      encodeHlc(left) < encodeHlc(right) ? -1 : 1,
    );
  }
});

test("拒绝空编码、非法节点、非法时间和非法配置", () => {
  for (const encoded of ["", "bad", "0".repeat(150)]) {
    expect(() => parseHlc(encoded)).toThrow();
  }
  for (const node of ["", "中文", "a".repeat(65)]) {
    expect(() => new ManualClock(node)).toThrow();
  }
  for (const time of [-1, NaN, Infinity, 0.5, 0x1000000000000]) {
    expect(() => new ManualClock("local", time)).toThrow();
  }
  expect(() => new ManualClock("local", 0, { maxDriftMs: -1 })).toThrow();
  const clock = new ManualClock("local");
  expect(() => clock.observe(stamp(0, -1))).toThrow();
});
