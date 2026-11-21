import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function violations(source: string): string[] {
  const sqlNames = new Set(["sql"]);
  const namespaces = new Set<string>();
  const errors: string[] = [];

  for (const match of source.matchAll(/import\s+([\s\S]*?)\s+from\s*["']drizzle-orm(?:\/[^"']*)?["']/g)) {
    const bindings = match[1] ?? "";
    const namespace = /\*\s+as\s+(\w+)/.exec(bindings)?.[1];
    if (namespace) {
      namespaces.add(namespace);
    }
    for (const binding of bindings.matchAll(/\bsql(?:\s+as\s+(\w+))?\b/g)) {
      sqlNames.add(binding[1] ?? "sql");
    }
  }

  if (/["'`]bun:sqlite["'`]/.test(source)) {
    errors.push("bun:sqlite");
  }
  for (const match of source.matchAll(/\b(?:(\w+)\s*\.\s*)?(\w+)\s*`/g)) {
    const namespace = match[1];
    const name = match[2] ?? "";
    if ((!namespace && sqlNames.has(name))
      || (namespace && namespaces.has(namespace) && name === "sql")) {
      errors.push("sql 模板");
    }
  }

  return errors;
}

test("store 外不直接访问 SQLite 或使用原生 SQL 模板", () => {
  const root = fileURLToPath(new URL("../src", import.meta.url));
  const errors: string[] = [];

  function scan(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (path !== join(root, "store")) {
          scan(path);
        }
      } else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
        errors.push(...violations(readFileSync(path, "utf8")).map((error) => `${path}: ${error}`));
      }
    }
  }

  scan(root);
  expect(errors).toEqual([]);
});

test("边界扫描允许仓储调用及空文件", () => {
  expect(violations("")).toEqual([]);
  expect(violations('import { getHostMeta } from "./store/host-meta.ts";')).toEqual([]);
});

test("边界扫描拦截静态、动态 SQLite 导入与 SQL 别名", () => {
  expect(violations('import { Database } from "bun:sqlite";')).toEqual(["bun:sqlite"]);
  expect(violations('const sqlite = await import("bun:sqlite");')).toEqual(["bun:sqlite"]);
  expect(violations('import { sql as query } from "drizzle-orm"; query`SELECT 1`;'))
    .toEqual(["sql 模板"]);
  expect(violations('import * as orm from "drizzle-orm"; orm.sql`SELECT 1`;'))
    .toEqual(["sql 模板"]);
  expect(violations('import { sql } from "drizzle-orm"; sql`SELECT 1`;'))
    .toEqual(["sql 模板"]);
});
