import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManualClock } from "../src/clock/index.ts";
import { startHost } from "../src/runtime/index.ts";
import type { Component, HostContext } from "../src/runtime/index.ts";
import { getHostMeta } from "../src/store/host-meta.ts";
import { configFromEnv } from "../src/runtime/config.ts";
import { DEFAULT_MAX_MEMBERS } from "../src/runtime/config.ts";
import { getHousehold } from "../src/store/identity.ts";
import { hosts as hostRows } from "../src/store/schema/identity.ts";

const directories: string[] = [];
const hosts: Awaited<ReturnType<typeof startHost>>[] = [];

function dataDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "cattt-runtime-"));
  directories.push(directory);
  return join(directory, "nested");
}

afterEach(async () => {
  for (const host of hosts.splice(0)) {
    await host.stop();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("按顺序启动、逆序停止，关闭存储最后执行且停止幂等", async () => {
  const order: string[] = [];
  let ctx: HostContext | undefined;
  const components: Component[] = ["one", "two"].map((name) => ({
    name,
    async start(context) {
      await Promise.resolve();
      ctx = context;
      order.push(`start:${name}`);
      expect(getHostMeta(context.store.db, "host_id")).toBe(context.hostId);
    },
    async stop() {
      await Promise.resolve();
      expect(getHostMeta(ctx!.store.db, "host_id")).toBe(ctx!.hostId);
      order.push(`stop:${name}`);
    },
  }));
  const clock = new ManualClock("test", 123);
  const host = await startHost({ dataDir: dataDir(), clock }, components);
  hosts.push(host);
  expect(host.clock).toBe(clock);
  expect(host.hostId).toStartWith("00000000-007b-7");
  const stopping = host.stop();
  expect(host.stop()).toBe(stopping);
  await stopping;
  await host.stop();
  expect(order).toEqual(["start:one", "start:two", "stop:two", "stop:one"]);
  expect(() => getHostMeta(host.store.db, "host_id")).toThrow();
});

test("启动失败回滚已启动组件，停止错误不遮盖原始错误", async () => {
  const order: string[] = [];
  const errors: unknown[] = [];
  let ctx: HostContext | undefined;
  const failure = new Error("启动失败");
  const stopFailure = new Error("停止失败");
  const components: Component[] = [
    {
      name: "one",
      start(context) {
        ctx = context;
      },
      stop() {
        order.push("one");
      },
    },
    {
      name: "two",
      start() {},
      async stop() {
        order.push("two");
        throw stopFailure;
      },
    },
    {
      name: "failed",
      async start() {
        throw failure;
      },
      stop() {
        order.push("failed");
      },
    },
  ];
  await expect(startHost({
    dataDir: dataDir(),
    onError(error) {
      errors.push(error);
    },
  }, components)).rejects.toBe(failure);
  expect(order).toEqual(["two", "one"]);
  expect(errors).toEqual([stopFailure]);
  expect(() => getHostMeta(ctx!.store.db, "host_id")).toThrow();
});

test("正常停止隔离同步错误和报告回调错误", async () => {
  const stopped: string[] = [];
  const host = await startHost({
    dataDir: dataDir(),
    onError() {
      throw new Error("报告失败");
    },
  }, [
    {
      name: "one",
      start() {},
      stop() {
        stopped.push("one");
      },
    },
    {
      name: "two",
      start() {},
      stop() {
        throw new Error("停止失败");
      },
    },
  ]);
  hosts.push(host);
  await host.stop();
  expect(stopped).toEqual(["one"]);
  expect(() => getHostMeta(host.store.db, "host_id")).toThrow();
});

test("空组件列表可运行，hostId 与家庭跨重启持久化，名称来自配置", async () => {
  const config = { dataDir: dataDir(), householdName: "共享的家", hostName: "卧室 Mac", maxMembers: 3 };
  const first = await startHost(config, []);
  hosts.push(first);
  const hostId = first.hostId;
  const householdId = first.householdId;
  expect(getHousehold(first.store.db, householdId)!.name).toBe(config.householdName);
  expect(first.store.db.select().from(hostRows).get()!.displayName).toBe(config.hostName);
  expect(first.config.maxMembers).toBe(3);
  expect(first.clock.hlc().nodeId).toBe(hostId);
  await first.stop();
  const second = await startHost(config, []);
  hosts.push(second);
  expect(second.hostId).toBe(hostId);
  expect(second.householdId).toBe(householdId);
});

test("环境配置提供本机默认值并拒绝非法端口", () => {
  expect(configFromEnv({}).port).toBe(8788);
  expect(configFromEnv({}).hostname).toBe("127.0.0.1");
  expect(configFromEnv({}).maxMembers).toBe(DEFAULT_MAX_MEMBERS);
  expect(configFromEnv({})).toMatchObject({ householdName: "我们的家", hostName: "我的 Mac" });
  expect(configFromEnv({ CATTT_HOUSEHOLD_NAME: "家", CATTT_HOST_NAME: "Mac" }))
    .toMatchObject({ householdName: "家", hostName: "Mac" });
  expect(configFromEnv({}).dataDir).toEndWith("/.cattt/host");
  expect(configFromEnv({ CATTT_PORT: "0", CATTT_DATA_DIR: "/custom" }))
    .toMatchObject({ port: 0, dataDir: "/custom" });
  for (const port of ["", "-1", "65536", "1.5", "abc"]) {
    expect(() => configFromEnv({ CATTT_PORT: port })).toThrow();
  }
});
