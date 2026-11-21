import type { MigrationMeta } from "drizzle-orm/migrator";

export const migrations: MigrationMeta[] = [
  {
    "sql": [
      "CREATE TABLE `host_meta` (\n\t`key` text PRIMARY KEY NOT NULL,\n\t`value` text NOT NULL\n);\n"
    ],
    "bps": true,
    "folderMillis": 1795278448063,
    "hash": "af1280060394fa0e5e299872b404c11450c2e173edbdaa646397891da6fe4a20"
  }
];
