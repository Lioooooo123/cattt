import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHostMeta, setHostMeta } from "../src/store/host-meta.ts";
import { openStore, writeTransaction } from "../src/store/index.ts";
import type { Store } from "../src/store/index.ts";
import { migrations } from "../src/store/migrations.generated.ts";

const stores: Store[] = [];
const directories: string[] = [];

function open(path = ":memory:") {
  const store = openStore(path);
  stores.push(store);
  return store;
}

function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), "cattt-store-"));
  directories.push(directory);
  return join(directory, "host.sqlite");
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("store", () => {
  test("文件数据库启用 WAL、持久提交、外键和等待超时", () => {
    const { raw } = open(databasePath());

    expect(raw.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(raw.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(raw.query("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
    expect(raw.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    raw.exec("CREATE TABLE parent (id INTEGER PRIMARY KEY)");
    raw.exec("CREATE TABLE child (parent_id INTEGER REFERENCES parent(id))");
    expect(() => raw.exec("INSERT INTO child VALUES (1)")).toThrow();
  });

  test("重复打开只应用一次迁移并保留数据", () => {
    const path = databasePath();
    const first = openStore(path);
    try {
      setHostMeta(first.db, "host_id", "本机");
    } finally {
      first.close();
    }
    const second = open(path);

    expect(getHostMeta(second.db, "host_id")).toBe("本机");
    expect(second.raw.query("SELECT count(*) AS count FROM __drizzle_migrations").get())
      .toEqual({ count: migrations.length });
  });

  test("元数据支持缺失、空值和覆盖", () => {
    const { db } = open();

    expect(getHostMeta(db, "missing")).toBeUndefined();
    setHostMeta(db, "", "");
    expect(getHostMeta(db, "")).toBe("");
    setHostMeta(db, "host_id", "初值");
    setHostMeta(db, "host_id", "新值");
    expect(getHostMeta(db, "host_id")).toBe("新值");
  });

  test("立即事务提交并返回结果，空事务也可执行", () => {
    const store = open();

    expect(writeTransaction(store, (db) => {
      setHostMeta(db, "host_id", "已提交");
      return 42;
    })).toBe(42);
    expect(getHostMeta(store.db, "host_id")).toBe("已提交");
    expect(writeTransaction(store, () => undefined)).toBeUndefined();
  });

  test("回调执行前就获得写锁", () => {
    const path = databasePath();
    const first = open(path);
    const second = open(path);
    second.raw.exec("PRAGMA busy_timeout = 0");

    writeTransaction(first, () => {
      expect(() => writeTransaction(second, () => undefined)).toThrow();
    });
    expect(() => writeTransaction(second, () => undefined)).not.toThrow();
  });

  test("异常回滚全部写入，之后仍可提交", () => {
    const store = open();
    setHostMeta(store.db, "existing", "原值");
    const error = new Error("中断");

    expect(() => writeTransaction(store, (db) => {
      setHostMeta(db, "existing", "不应保存");
      setHostMeta(db, "new", "不应保存");
      throw error;
    })).toThrow(error);
    expect(getHostMeta(store.db, "existing")).toBe("原值");
    expect(getHostMeta(store.db, "new")).toBeUndefined();
    writeTransaction(store, (db) => setHostMeta(db, "new", "已恢复"));
    expect(getHostMeta(store.db, "new")).toBe("已恢复");
  });

  test("拒绝异步回调并回滚其同步写入", () => {
    const store = open();

    expect(() => writeTransaction(store, async (db) => {
      setHostMeta(db, "host_id", "不应保存");
    })).toThrow("写事务回调必须同步执行");
    expect(getHostMeta(store.db, "host_id")).toBeUndefined();
  });

  test("无法打开的路径直接报错", () => {
    expect(() => openStore(join(databasePath(), "missing.sqlite"))).toThrow();
  });
});
