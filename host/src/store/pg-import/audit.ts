import { count, eq } from "drizzle-orm";
import { ImportError } from "../../import-pg/snapshot.ts";
import type { LegacyRow, PgSnapshot, SourceTable } from "../../import-pg/snapshot.ts";
import { canonicalJson, sha256, textSha256 } from "../../import-pg/values.ts";
import type { ReplicationTx } from "../replication-adapter.ts";
import { pgImportArchive } from "../schema/pg-import.ts";

interface TargetRow {
  table: string;
  row: Record<string, unknown>;
}

/** Compare the mapped fields against actual SQLite INSERT RETURNING values. */
export function checked(table: string, projected: object, persisted: object | undefined): TargetRow {
  const expected = Object.entries(projected);
  const written = persisted && Object.fromEntries(expected.map(([key]) => [key, (persisted as Record<string, unknown>)[key]]));
  if (!written || canonicalJson(projected) !== canonicalJson(written)) {
    throw new ImportError(`SQLite 表 ${table} 字段核对失败`);
  }
  return { table, row: written };
}

export interface TableReport {
  sourceCount: number;
  outsideScope: number;
  liveCount: number;
  archiveCount: number;
  excludedCount: number;
  evidenceCount: number;
  sourceSha256: string;
  targetSha256: string;
  targets: Record<string, number>;
  reasons: Record<string, number>;
}

type Outcome = { live: TargetRow[]; reason?: string; evidence?: TargetRow };
type SourceBook = Map<string, Outcome>;

export class ImportAudit {
  private readonly books = new Map<SourceTable, SourceBook>();

  constructor(private readonly tx: ReplicationTx, private readonly snapshot: PgSnapshot) {}

  private book(table: SourceTable): SourceBook {
    const existing = this.books.get(table);
    if (existing) return existing;
    const book = new Map<string, Outcome>();
    this.books.set(table, book);
    return book;
  }

  add(table: SourceTable, row: LegacyRow, live: TargetRow[], reason?: string, evidenceJson = row.json) {
    const book = this.book(table);
    if (book.has(row.key) || (!live.length && !reason)) throw new ImportError(`PG 表 ${table} 的映射缺失或重复`);
    let evidence: TargetRow | undefined;
    if (reason) {
      const target = {
        sourceTable: table, sourceKey: row.key, sourceSha256: textSha256(row.json),
        targetId: typeof live[0]?.row.id === "string" ? live[0].row.id : null,
        reason, evidenceJson,
      };
      evidence = checked("pg_import_archive", target, this.tx.insert(pgImportArchive).values(target).returning().get());
    }
    book.set(row.key, { live, reason, evidence });
  }

  reject(table: SourceTable, row: LegacyRow, reason: string, fields?: readonly string[]) {
    const evidence = fields ? canonicalJson(Object.fromEntries(fields.map((field) => [field, row.data[field]]))) : row.json;
    this.add(table, row, [], reason, evidence);
  }

  mapped(table: SourceTable, row: LegacyRow, live: TargetRow[], residual: readonly string[] = []) {
    const fields = Object.fromEntries(residual.map((field) => [field, row.data[field]]));
    this.add(table, row, live, residual.length ? "legacy_fields" : undefined, canonicalJson(fields));
  }

  pending(table: SourceTable, row: LegacyRow) {
    return !this.books.get(table)?.has(row.key);
  }

  finish(): Record<SourceTable, TableReport> {
    const result = {} as Record<SourceTable, TableReport>;
    for (const table of Object.keys(this.snapshot.tables) as SourceTable[]) {
      const { rows, sourceCount, outsideScope, sourceSha256, excluded } = this.snapshot.tables[table];
      const book = this.book(table);
      const targets: Record<string, number> = {};
      const reasons: Record<string, number> = {};
      const mapped = rows.map(({ key }) => {
        const outcome = book.get(key);
        if (!outcome) throw new ImportError(`PG 表 ${table} 未完成逐行核对`);
        for (const item of outcome.live) targets[item.table] = (targets[item.table] ?? 0) + 1;
        if (outcome.evidence) targets.pg_import_archive = (targets.pg_import_archive ?? 0) + 1;
        if (outcome.reason) reasons[outcome.reason] = (reasons[outcome.reason] ?? 0) + 1;
        return [key, outcome];
      });
      const liveCount = [...book.values()].filter(({ live }) => live.length > 0).length;
      const archiveCount = book.size - liveCount;
      const excludedCount = excluded ? sourceCount : 0;
      if (excludedCount) reasons.credentials_or_ephemeral = excludedCount;
      if (liveCount + archiveCount + excludedCount !== sourceCount) {
        throw new ImportError(`PG 表 ${table} 的目标行数核对失败`);
      }
      const evidenceCount = targets.pg_import_archive ?? 0;
      const actualCount = this.tx.select({ count: count() }).from(pgImportArchive)
        .where(eq(pgImportArchive.sourceTable, table)).get()!.count;
      if (actualCount !== evidenceCount) throw new ImportError(`SQLite 归档表 ${table} 的行数核对失败`);
      result[table] = {
        sourceCount, outsideScope, liveCount, archiveCount, excludedCount, evidenceCount,
        sourceSha256, targetSha256: sha256(mapped), targets, reasons,
      };
    }
    return result;
  }
}
