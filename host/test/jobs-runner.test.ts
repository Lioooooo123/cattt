import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ManualClock } from "../src/clock/index.ts";
import { JobRunner } from "../src/jobs/index.ts";
import { startHost } from "../src/runtime/index.ts";
import { getJob } from "../src/store/jobs.ts";

const hosts: Awaited<ReturnType<typeof startHost>>[] = [];
const directories: string[] = [];

async function start(runner: JobRunner) {
  const dataDir = mkdtempSync(join(tmpdir(), "cattt-jobs-"));
  directories.push(dataDir);
  const clock = new ManualClock("test", 100);
  const host = await startHost({ dataDir, clock }, [runner]);
  hosts.push(host);
  return { host, clock };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) {
      return;
    }
    await Bun.sleep(5);
  }
  throw new Error("等待作业状态超时");
}

afterEach(async () => {
  for (const host of hosts.splice(0)) {
    await host.stop();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("总线立即唤醒，不必等待轮询；zod 无效负载直接标死", async () => {
  const runner = new JobRunner({ pollIntervalMs: 60_000 });
  const seen: number[] = [];
  runner.register("test", {
    schema: z.object({ value: z.number() }),
    concurrency: 1,
    handler(payload) {
      seen.push(payload.value);
    },
  });
  const { host } = await start(runner);
  const invalid = runner.enqueue("test", { value: "错误" });
  await until(() => getJob(host.store.db, invalid)?.status === "dead");
  expect(getJob(host.store.db, invalid)?.attempts).toBe(1);
  const valid = runner.enqueue("test", { value: 1 });
  await until(() => getJob(host.store.db, valid)?.status === "done");
  expect(seen).toEqual([1]);
});

test("失败指数退避重试，最后一次失败进入 dead", async () => {
  const runner = new JobRunner({ pollIntervalMs: 60_000 });
  runner.register("test", {
    schema: z.null(),
    concurrency: 1,
    maxAttempts: 3,
    handler() {
      throw new Error("失败");
    },
  });
  const { host, clock } = await start(runner);
  const id = runner.enqueue("test", null);
  await until(() => getJob(host.store.db, id)?.status === "queued");
  expect(getJob(host.store.db, id)?.runAt).toBe(1100);
  clock.setWallMs(1099);
  host.bus.publish("jobs:wake", { queue: "test" });
  expect(getJob(host.store.db, id)?.attempts).toBe(1);
  clock.advance(1);
  host.bus.publish("jobs:wake", { queue: "test" });
  await until(() => getJob(host.store.db, id)?.status === "queued");
  expect(getJob(host.store.db, id)?.runAt).toBe(3100);
  clock.setWallMs(3100);
  host.bus.publish("jobs:wake", { queue: "test" });
  await until(() => getJob(host.store.db, id)?.status === "dead");
  expect(getJob(host.store.db, id)?.attempts).toBe(3);
});

test("并发上限按队列独立控制", async () => {
  const runner = new JobRunner({ pollIntervalMs: 60_000 });
  const release = deferred();
  let active = 0;
  let maximum = 0;
  let other = false;
  runner.register("test", {
    schema: z.number(),
    concurrency: 2,
    async handler() {
      active += 1;
      maximum = Math.max(maximum, active);
      await release.promise;
      active -= 1;
    },
  });
  runner.register("other", {
    schema: z.null(),
    concurrency: 1,
    handler() {
      other = true;
    },
  });
  const { host } = await start(runner);
  const ids = Array.from({ length: 4 }, (_, i) => runner.enqueue("test", i));
  runner.enqueue("other", null);
  await until(() => active === 2 && other);
  expect(getJob(host.store.db, ids[2]!)?.status).toBe("queued");
  release.resolve();
  await until(() => ids.every((id) => getJob(host.store.db, id)?.status === "done"));
  expect(maximum).toBe(2);
});

test("正常停止等待在途处理，不再领取后续作业", async () => {
  const runner = new JobRunner({ graceMs: 1000 });
  const release = deferred();
  const entered = deferred();
  runner.register("test", {
    schema: z.null(),
    concurrency: 1,
    async handler() {
      entered.resolve();
      await release.promise;
    },
  });
  const { host } = await start(runner);
  const first = runner.enqueue("test", null);
  const second = runner.enqueue("test", null);
  await entered.promise;
  let stopped = false;
  const stopping = runner.stop().then(() => {
    stopped = true;
  });
  await Bun.sleep(10);
  expect(stopped).toBe(false);
  release.resolve();
  await stopping;
  expect(getJob(host.store.db, first)?.status).toBe("done");
  expect(getJob(host.store.db, second)?.status).toBe("queued");
  expect(() => runner.enqueue("test", null)).toThrow();
});

test("空运行器可停止，注册与入队配置错误会被拒绝", async () => {
  const runner = new JobRunner();
  expect(() => runner.enqueue("missing", null)).toThrow();
  expect(() => runner.register("bad", {
    schema: z.null(), concurrency: 0, handler() {},
  })).toThrow();
  runner.register("test", { schema: z.null(), concurrency: 1, handler() {} });
  expect(() => runner.register("test", {
    schema: z.null(), concurrency: 1, handler() {},
  })).toThrow();
  const empty = new JobRunner();
  await start(empty);
  await empty.stop();
  await empty.stop();
});

test("处理超时留下租约供恢复，迟到处理不覆盖新尝试", async () => {
  const runner = new JobRunner({ pollIntervalMs: 5 });
  const release = deferred();
  let calls = 0;
  runner.register("test", {
    schema: z.null(),
    concurrency: 1,
    timeoutMs: 20,
    async handler(_payload, ctx) {
      calls += 1;
      if (calls === 1) {
        await release.promise;
        expect(ctx.signal.aborted).toBe(true);
      }
    },
  });
  const { host, clock } = await start(runner);
  const id = runner.enqueue("test", null);
  await until(() => calls === 1);
  await Bun.sleep(30);
  expect(getJob(host.store.db, id)).toMatchObject({ status: "running", attempts: 1 });
  clock.setWallMs(120);
  await until(() => getJob(host.store.db, id)?.status === "done");
  release.resolve();
  await Bun.sleep(5);
  expect(getJob(host.store.db, id)).toMatchObject({ status: "done", attempts: 2 });
});

test("停止宽限到期后返回，迟到的成功或拒绝不访问已关闭数据库", async () => {
  const runner = new JobRunner({ graceMs: 5 });
  const release = deferred();
  const entered = deferred();
  runner.register("test", {
    schema: z.null(),
    concurrency: 1,
    async handler() {
      entered.resolve();
      await release.promise;
      throw new Error("迟到拒绝");
    },
  });
  const { host } = await start(runner);
  runner.enqueue("test", null);
  await entered.promise;
  await host.stop();
  release.resolve();
  await Bun.sleep(5);
  expect(() => getJob(host.store.db, "any")).toThrow();
});
