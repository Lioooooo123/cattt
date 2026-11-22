import { Database } from "bun:sqlite";
import { ImportError } from "../../import-pg/snapshot.ts";
import { IMPORT_VERSION } from "./index.ts";
import type { ImportReport } from "./index.ts";

export function readImportReceipt(path: string): ImportReport {
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true, create: false, strict: true });
    const row = db.query<{ source_sha256: string; report: string }, []>(
      "SELECT source_sha256, report FROM pg_import_receipts WHERE id = 1",
    ).get();
    if (row) {
      const report = JSON.parse(row.report) as ImportReport;
      if (report.formatVersion === IMPORT_VERSION && report.status === "imported" && report.sourceSha256 === row.source_sha256) {
        return report;
      }
    }
  } catch {
    // The user may own this file. Never open it for migrations or repairs.
  } finally {
    db?.close();
  }
  throw new ImportError("目标已存在且没有可核对的同版本导入收据");
}
