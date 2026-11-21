import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManualClock } from "../src/clock/index.ts";
import { LeaseKeeper } from "../src/leases/index.ts";
import { startHost } from "../src/runtime/index.ts";
import { acquireLease, getLease, LeaseLostError } from "../src/store/leases.ts";

const hosts: Awaited<ReturnType<typeof startHost>>[] = [];
const directories: string[] = [];

async function setup(keeper: LeaseKeeper) {
  const dataDir = mkdtempSync(join(tmpdir(), "cattt-leases-"));
  directories.push(dataDir);
  const clock = new ManualClock("test", 100);
  const host = await startHost({ dataDir, clock }, [keeper]);
  hosts.push(host);
  return { host, clock };
}

async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) {
      return;
    }
    await Bun.sleep(5);
  }
  throw new Error("等待租约事件超时");
}

afterEach(async () => {
  for (const host of hosts.splice(0)) {
    await host.stop();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("维护器周期续租并公布取得事件，停止释放持有租约", async () => {
  const keeper = new LeaseKeeper({ worker: "router" });
  const { host, clock } = await setup(keeper);
  const acquired: unknown[] = [];
  const lost: unknown[] = [];
  host.bus.subscribe("lease:acquired", (event) => {
    acquired.push(event);
  });
  host.bus.subscribe("lease:lost", (event) => {
    lost.push(event);
  });
  const first = keeper.hold("chat", { ttlMs: 100, renewEveryMs: 5 });
  expect(first.acquired).toBe(true);
  expect(keeper.epoch("chat")).toBe(1);
  expect(acquired).toEqual([{ name: "chat", holder: `${host.hostId}:router`, epoch: 1 }]);
  clock.advance(50);
  await until(() => getLease(host.store.db, "chat")!.expiresAt === 250);
  expect(keeper.hold("chat", { ttlMs: 100, renewEveryMs: 5 }).epoch).toBe(1);
  expect(acquired.length).toBe(1);
  keeper.stop();
  keeper.stop();
  expect(getLease(host.store.db, "chat")).toMatchObject({ expiresAt: 0, epoch: 1 });
  expect(keeper.epoch("chat")).toBeUndefined();
  expect(lost).toEqual(acquired);
});

test("过期接管后续租失败，发出一次 lost 且不释放新持有者", async () => {
  const keeper = new LeaseKeeper({ skewMs: 0 });
  const { host, clock } = await setup(keeper);
  const lost: unknown[] = [];
  host.bus.subscribe("lease:lost", (event) => {
    lost.push(event);
  });
  keeper.hold("chat", { ttlMs: 20, renewEveryMs: 5 });
  clock.setWallMs(121);
  const takeover = acquireLease(host.store.db, clock, {
    name: "chat", holder: "other", ttlMs: 100, skewMs: 0,
  });
  expect(takeover.epoch).toBe(2);
  await until(() => lost.length === 1);
  expect(lost).toEqual([{ name: "chat", holder: host.hostId, epoch: 1 }]);
  expect(keeper.epoch("chat")).toBeUndefined();
  keeper.stop();
  expect(getLease(host.store.db, "chat")).toMatchObject({ holder: "other", epoch: 2, expiresAt: 221 });
  expect(lost.length).toBe(1);
});

test("withLease 只在持有时调用，并拒绝执行期间失效的结果", async () => {
  const keeper = new LeaseKeeper();
  const { clock } = await setup(keeper);
  let called = false;
  await expect(keeper.withLease("missing", () => {
    called = true;
  })).rejects.toBeInstanceOf(LeaseLostError);
  expect(called).toBe(false);
  keeper.hold("chat", { ttlMs: 1000, renewEveryMs: 500 });
  expect(await keeper.withLease("chat", (epoch) => epoch)).toBe(1);
  await expect(keeper.withLease("chat", async () => {
    clock.advance(1000);
  })).rejects.toBeInstanceOf(LeaseLostError);
  expect(keeper.epoch("chat")).toBeUndefined();
});

test("竞争失败不产生取得事件，空维护器与非法配置有明确行为", async () => {
  const keeper = new LeaseKeeper();
  expect(() => keeper.hold("chat", { ttlMs: 100, renewEveryMs: 5 })).toThrow();
  const { host, clock } = await setup(keeper);
  acquireLease(host.store.db, clock, { name: "chat", holder: "other", ttlMs: 100 });
  expect(keeper.hold("chat", { ttlMs: 100, renewEveryMs: 5 }).acquired).toBe(false);
  expect(keeper.epoch("chat")).toBeUndefined();
  expect(() => keeper.hold("new", { ttlMs: 100, renewEveryMs: 100 })).toThrow();
  expect(() => new LeaseKeeper({ skewMs: -1 })).toThrow();
  keeper.stop();
});
