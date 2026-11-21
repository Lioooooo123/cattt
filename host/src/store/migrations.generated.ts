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
  },
  {
    "sql": [
      "CREATE TABLE `leases` (\n\t`name` text PRIMARY KEY NOT NULL,\n\t`holder` text NOT NULL,\n\t`epoch` integer NOT NULL,\n\t`acquired_hlc` text NOT NULL,\n\t`expires_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL\n);\n"
    ],
    "bps": true,
    "folderMillis": 1795280227065,
    "hash": "b715921bd1e35e5cd032074c92e8671802529e16ddbaa5983fb9d1f349e343d3"
  },
  {
    "sql": [
      "CREATE TABLE `chat_events` (\n\t`stream_id` text NOT NULL,\n\t`seq` integer NOT NULL,\n\t`kind` text NOT NULL,\n\t`data` text NOT NULL,\n\t`terminal` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\tPRIMARY KEY(`stream_id`, `seq`)\n);\n",
      "\nCREATE INDEX `chat_events_created_at` ON `chat_events` (`created_at`);"
    ],
    "bps": true,
    "folderMillis": 1795280738334,
    "hash": "b0801c30c2e00705ef652d0cfb4054d8d927800dc548932ec585329531c430a1"
  },
  {
    "sql": [
      "CREATE TABLE `device_credentials` (\n\t`device_id` text PRIMARY KEY NOT NULL,\n\t`token_hash` text NOT NULL,\n\tFOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action\n);\n",
      "\nCREATE UNIQUE INDEX `device_credentials_token_hash_unique` ON `device_credentials` (`token_hash`);",
      "\nCREATE TABLE `devices` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`origin_host_id` text NOT NULL,\n\t`hlc` text NOT NULL,\n\t`rev` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\t`member_id` text NOT NULL,\n\t`host_id` text NOT NULL,\n\t`name` text NOT NULL,\n\t`last_seen_at` integer,\n\t`revoked_at` integer,\n\tFOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE no action\n);\n",
      "\nCREATE TABLE `hosts` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`origin_host_id` text NOT NULL,\n\t`hlc` text NOT NULL,\n\t`rev` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\t`household_id` text NOT NULL,\n\t`display_name` text NOT NULL,\n\tFOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action\n);\n",
      "\nCREATE TABLE `households` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`origin_host_id` text NOT NULL,\n\t`hlc` text NOT NULL,\n\t`rev` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\t`name` text NOT NULL\n);\n",
      "\nCREATE TABLE `members` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`origin_host_id` text NOT NULL,\n\t`hlc` text NOT NULL,\n\t`rev` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\t`household_id` text NOT NULL,\n\t`display_name` text NOT NULL,\n\t`home_host_id` text NOT NULL,\n\tFOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`home_host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE no action\n);\n"
    ],
    "bps": true,
    "folderMillis": 1795281472217,
    "hash": "2539ed6e998c7816e94d47bbc7eeda4e78c9823b922d6de6d12e31ba3d22772a"
  }
];
