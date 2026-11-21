import type { MigrationMeta } from "drizzle-orm/migrator";

export const migrations: MigrationMeta[] = [
  {
    "sql": [
      "CREATE TABLE `host_meta` (\n\t`key` text PRIMARY KEY NOT NULL,\n\t`value` text NOT NULL\n);\n"
    ],
    "bps": true,
    "folderMillis": 1795278448063,
    "hash": "af1280060394fa0e5e299872b404c11450c2e173edbdaa646397891da6fe4a20"
  },
  {
    "sql": [
      "CREATE TABLE `jobs` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`queue` text NOT NULL,\n\t`payload` text NOT NULL,\n\t`status` text NOT NULL,\n\t`attempts` integer NOT NULL,\n\t`max_attempts` integer NOT NULL,\n\t`run_at` integer NOT NULL,\n\t`locked_until` integer,\n\t`dedupe_key` text,\n\t`last_error` text,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\tCONSTRAINT \"jobs_status\" CHECK(\"jobs\".\"status\" IN ('queued', 'running', 'done', 'dead'))\n);\n",
      "\nCREATE UNIQUE INDEX `jobs_active_dedupe` ON `jobs` (`queue`,`dedupe_key`) WHERE \"jobs\".\"dedupe_key\" IS NOT NULL AND \"jobs\".\"status\" IN ('queued', 'running');",
      "\nCREATE INDEX `jobs_claim` ON `jobs` (`queue`,`status`,`run_at`);"
    ],
    "bps": true,
    "folderMillis": 1795279724595,
    "hash": "db408155011f1c0b9e8c19300a8ccbb84f9a18c190c618fa18560974b6c084e5"
  }
];
