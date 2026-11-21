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
  },
  {
    "sql": [
      "CREATE TABLE `pairing_codes` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`member_id` text NOT NULL,\n\t`code_hash` text NOT NULL,\n\t`expires_at` integer NOT NULL,\n\t`used_at` integer,\n\t`failures` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\tFOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action\n);\n"
    ],
    "bps": true,
    "folderMillis": 1795282060204,
    "hash": "0acf0dd6e49c61890ffdb7a2c1414c61f31b4bfe5d74ee8311850038006d7f8c"
  },
  {
    "sql": [
      "CREATE TABLE `member_invites` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`household_id` text NOT NULL,\n\t`display_name` text,\n\t`code_hash` text NOT NULL,\n\t`invited_by_member_id` text,\n\t`expires_at` integer NOT NULL,\n\t`used_at` integer,\n\t`revoked_at` integer,\n\t`failures` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\tFOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`invited_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action\n);\n"
    ],
    "bps": true,
    "folderMillis": 1795282767505,
    "hash": "a436664f7e8a6491391a18a5c6d68786d3e90a90642a9bfb76c431e2cae1a5bb"
  },
  {
    "sql": [
      "CREATE TABLE `conversations` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`origin_host_id` text NOT NULL,\n\t`hlc` text NOT NULL,\n\t`rev` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\t`household_id` text NOT NULL,\n\t`kind` text NOT NULL,\n\t`owner_member_id` text,\n\t`publisher_host_id` text NOT NULL,\n\tFOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`owner_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`publisher_host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE no action,\n\tCONSTRAINT \"conversations_kind_owner\" CHECK((\"conversations\".\"kind\" = 'group' AND \"conversations\".\"owner_member_id\" IS NULL)\n    OR (\"conversations\".\"kind\" = 'direct' AND \"conversations\".\"owner_member_id\" IS NOT NULL))\n);\n",
      "\nCREATE UNIQUE INDEX `conversations_one_group` ON `conversations` (`household_id`) WHERE \"conversations\".\"kind\" = 'group';",
      "\nCREATE UNIQUE INDEX `conversations_one_direct` ON `conversations` (`owner_member_id`) WHERE \"conversations\".\"kind\" = 'direct';",
      "\nCREATE TABLE `messages` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`origin_host_id` text NOT NULL,\n\t`hlc` text NOT NULL,\n\t`rev` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\t`conversation_id` text NOT NULL,\n\t`author_member_id` text,\n\t`text` text NOT NULL,\n\t`modality` text NOT NULL,\n\t`status` text NOT NULL,\n\t`client_message_id` text,\n\t`reply_to_message_id` text,\n\t`turn_id` text,\n\tFOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`author_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`reply_to_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,\n\tCONSTRAINT \"messages_modality\" CHECK(\"messages\".\"modality\" = 'text'),\n\tCONSTRAINT \"messages_status\" CHECK(\"messages\".\"status\" IN ('complete', 'stopped'))\n);\n",
      "\nCREATE UNIQUE INDEX `messages_client_idempotency` ON `messages` (`conversation_id`,`author_member_id`,`client_message_id`);",
      "\nCREATE INDEX `messages_conversation_order` ON `messages` (`conversation_id`,`hlc`,`id`);",
      "\nCREATE TABLE `participants` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`origin_host_id` text NOT NULL,\n\t`hlc` text NOT NULL,\n\t`rev` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\t`conversation_id` text NOT NULL,\n\t`member_id` text NOT NULL,\n\tFOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action\n);\n",
      "\nCREATE UNIQUE INDEX `participants_conversation_member` ON `participants` (`conversation_id`,`member_id`);"
    ],
    "bps": true,
    "folderMillis": 1795283431688,
    "hash": "00a203512319feb776a127ec7c8a1ee203e7c79230ae81c359d05f2974d80f03"
  },
  {
    "sql": [
      "CREATE TABLE `turns` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`conversation_id` text NOT NULL,\n\t`trigger_message_id` text NOT NULL,\n\t`request_id` text,\n\t`status` text NOT NULL,\n\t`reply_message_id` text,\n\t`error_code` text,\n\t`cancel_reason` text,\n\t`visible_length` integer,\n\t`first_token_at` integer,\n\t`heartbeat_at` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`finished_at` integer,\n\t`draft_text` text NOT NULL,\n\t`event_seq` integer NOT NULL,\n\t`superseded_by_turn_id` text,\n\tFOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`trigger_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`reply_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,\n\tCONSTRAINT \"turns_status\" CHECK(\"turns\".\"status\" IN ('queued','generating','completed','stopped','superseded','failed'))\n);\n",
      "\nCREATE UNIQUE INDEX `turns_request_id_unique` ON `turns` (`request_id`);",
      "\nCREATE INDEX `turns_pending` ON `turns` (`status`,`created_at`);",
      "\nCREATE INDEX `turns_conversation` ON `turns` (`conversation_id`,`created_at`);"
    ],
    "bps": true,
    "folderMillis": 1795284051025,
    "hash": "23e9e3ed9483f19b556e50b6d809d26edaf963ddd170684b8659ee4768a9bf30"
  }
];
