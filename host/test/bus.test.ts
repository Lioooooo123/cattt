import { expect, test } from "bun:test";
import { EventBus } from "../src/bus/index.ts";

interface Events {
  message: { text: string };
  count: number;
}

test("总线分发同步和异步消息，隔离抛错与拒绝", async () => {
  const errors: unknown[] = [];
  const topics: (keyof Events)[] = [];
  const seen: string[] = [];
  const bus = new EventBus<Events>((error, topic) => {
    errors.push(error);
    topics.push(topic);
  });
  const syncError = new Error("同步失败");
  const asyncError = new Error("异步失败");
  bus.subscribe("message", () => {
    throw syncError;
  });
  bus.subscribe("message", async () => {
    throw asyncError;
  });
  bus.subscribe("message", ({ text }) => {
    seen.push(text);
  });
  bus.subscribe("message", async ({ text }) => {
    await Promise.resolve();
    seen.push(`${text}:async`);
  });
  bus.subscribe("count", () => {
    throw new Error("不应触发");
  });

  expect(() => bus.publish("message", { text: "你好" })).not.toThrow();
  await Bun.sleep(0);
  expect(seen).toEqual(["你好", "你好:async"]);
  expect(errors).toEqual([syncError, asyncError]);
  expect(topics).toEqual(["message", "message"]);
});

test("取消订阅可重复调用，不影响之后的新订阅或重复处理函数", () => {
  const bus = new EventBus<Events>(() => {});
  const seen: number[] = [];
  const handler = (value: number) => {
    seen.push(value);
  };
  const first = bus.subscribe("count", handler);
  first();
  const second = bus.subscribe("count", handler);
  first();
  bus.publish("count", 1);
  const third = bus.subscribe("count", handler);
  second();
  bus.publish("count", 2);
  third();
  bus.publish("count", 3);
  bus.publish("message", { text: "无人订阅" });
  expect(seen).toEqual([1, 2]);
});

test("错误回调自身失败也不泄漏给发布者", async () => {
  for (const onError of [
    () => {
      throw new Error("报告失败");
    },
    async () => {
      throw new Error("报告异步失败");
    },
  ]) {
    const bus = new EventBus<Events>(onError);
    let called = false;
    bus.subscribe("count", () => {
      throw new Error("失败");
    });
    bus.subscribe("count", () => {
      called = true;
    });
    expect(() => bus.publish("count", 1)).not.toThrow();
    await Bun.sleep(0);
    expect(called).toBe(true);
  }
});
