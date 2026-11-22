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
  },
  {
    "sql": [
      "CREATE TABLE `boundaries` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`origin_host_id` text NOT NULL,\n\t`hlc` text NOT NULL,\n\t`rev` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\t`household_id` text NOT NULL,\n\t`source_member_id` text NOT NULL,\n\t`source_message_id` text NOT NULL,\n\t`source_revision` integer NOT NULL,\n\t`subject_member_id` text NOT NULL,\n\t`description` text NOT NULL,\n\tFOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`source_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`source_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`subject_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,\n\tCONSTRAINT \"boundaries_source_revision\" CHECK(\"boundaries\".\"source_revision\" > 0)\n);\n",
      "\nCREATE UNIQUE INDEX `boundaries_source_subject` ON `boundaries` (`source_message_id`,`source_revision`,`subject_member_id`);",
      "\nCREATE INDEX `boundaries_household_subject` ON `boundaries` (`household_id`,`subject_member_id`);",
      "\nCREATE INDEX `boundaries_household_source_member` ON `boundaries` (`household_id`,`source_member_id`);",
      "\nCREATE TABLE `diary_entries` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`origin_host_id` text NOT NULL,\n\t`hlc` text NOT NULL,\n\t`rev` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\t`household_id` text NOT NULL,\n\t`owner_member_id` text NOT NULL,\n\t`source_member_id` text NOT NULL,\n\t`source_message_id` text,\n\t`source_revision` integer,\n\t`text` text NOT NULL,\n\t`recorded_at` integer NOT NULL,\n\t`local_day` text NOT NULL,\n\t`time_zone` text NOT NULL,\n\t`cat_allowed` integer DEFAULT false NOT NULL,\n\tFOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`owner_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`source_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`source_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,\n\tCONSTRAINT \"diary_entries_source_revision\" CHECK(\n    (\"diary_entries\".\"source_message_id\" IS NULL AND \"diary_entries\".\"source_revision\" IS NULL)\n    OR (\"diary_entries\".\"source_message_id\" IS NOT NULL AND \"diary_entries\".\"source_revision\" IS NOT NULL AND \"diary_entries\".\"source_revision\" > 0)\n  )\n);\n",
      "\nCREATE INDEX `diary_entries_household_owner_day` ON `diary_entries` (`household_id`,`owner_member_id`,`local_day`);",
      "\nCREATE INDEX `diary_entries_household_source_message` ON `diary_entries` (`household_id`,`source_message_id`);",
      "\nCREATE TABLE `knowledge_source_withdrawals` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`origin_host_id` text NOT NULL,\n\t`hlc` text NOT NULL,\n\t`rev` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\t`household_id` text NOT NULL,\n\t`source_member_id` text NOT NULL,\n\t`source_message_id` text NOT NULL,\n\t`source_revision` integer NOT NULL,\n\tFOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`source_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`source_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,\n\tCONSTRAINT \"knowledge_source_withdrawals_revision\" CHECK(\"knowledge_source_withdrawals\".\"source_revision\" > 0)\n);\n",
      "\nCREATE UNIQUE INDEX `knowledge_source_withdrawals_message` ON `knowledge_source_withdrawals` (`source_message_id`);",
      "\nCREATE TABLE `memories` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`origin_host_id` text NOT NULL,\n\t`hlc` text NOT NULL,\n\t`rev` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\t`household_id` text NOT NULL,\n\t`source_member_id` text NOT NULL,\n\t`source_message_id` text NOT NULL,\n\t`source_revision` integer NOT NULL,\n\t`subject_member_id` text NOT NULL,\n\t`fingerprint` text NOT NULL,\n\t`predicate` text NOT NULL,\n\t`value` text NOT NULL,\n\tFOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`source_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`source_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`subject_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,\n\tCONSTRAINT \"memories_source_revision\" CHECK(\"memories\".\"source_revision\" > 0)\n);\n",
      "\nCREATE UNIQUE INDEX `memories_source_fact` ON `memories` (`source_message_id`,`source_revision`,`subject_member_id`,`fingerprint`);",
      "\nCREATE INDEX `memories_household_subject` ON `memories` (`household_id`,`subject_member_id`);",
      "\nCREATE INDEX `memories_household_source_member` ON `memories` (`household_id`,`source_member_id`);",
      "\nCREATE TABLE `memory_blocks` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`origin_host_id` text NOT NULL,\n\t`hlc` text NOT NULL,\n\t`rev` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\t`household_id` text NOT NULL,\n\t`source_member_id` text NOT NULL,\n\t`source_message_id` text NOT NULL,\n\t`source_revision` integer NOT NULL,\n\t`subject_member_id` text NOT NULL,\n\t`fingerprint` text NOT NULL,\n\tFOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`source_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`source_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`subject_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,\n\tCONSTRAINT \"memory_blocks_source_revision\" CHECK(\"memory_blocks\".\"source_revision\" > 0)\n);\n",
      "\nCREATE UNIQUE INDEX `memory_blocks_source_fact` ON `memory_blocks` (`source_message_id`,`source_revision`,`subject_member_id`,`fingerprint`);",
      "\nCREATE INDEX `memory_blocks_household_subject_fact` ON `memory_blocks` (`household_id`,`subject_member_id`,`fingerprint`);"
    ],
    "bps": true,
    "folderMillis": 1795290478761,
    "hash": "936857e2e1f4b24834cab7e49721c7a2fb1d62d7c62eac388b8cbc7ba643c6e2"
  },
  {
    "sql": [
      "CREATE TABLE `__new_memories` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`origin_host_id` text NOT NULL,\n\t`hlc` text NOT NULL,\n\t`rev` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\t`household_id` text NOT NULL,\n\t`source_member_id` text NOT NULL,\n\t`source_message_id` text NOT NULL,\n\t`source_revision` integer NOT NULL,\n\t`subject_member_id` text,\n\t`fingerprint` text NOT NULL,\n\t`predicate` text NOT NULL,\n\t`value` text NOT NULL,\n\tFOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`source_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`source_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`subject_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,\n\tCONSTRAINT \"memories_source_revision\" CHECK(\"source_revision\" > 0)\n);\n",
      "\nINSERT INTO `__new_memories`(\"id\", \"origin_host_id\", \"hlc\", \"rev\", \"created_at\", \"updated_at\", \"deleted_at\", \"household_id\", \"source_member_id\", \"source_message_id\", \"source_revision\", \"subject_member_id\", \"fingerprint\", \"predicate\", \"value\") SELECT \"id\", \"origin_host_id\", \"hlc\", \"rev\", \"created_at\", \"updated_at\", \"deleted_at\", \"household_id\", \"source_member_id\", \"source_message_id\", \"source_revision\", \"subject_member_id\", \"fingerprint\", \"predicate\", \"value\" FROM `memories`;",
      "\nDROP TABLE `memories`;",
      "\nALTER TABLE `__new_memories` RENAME TO `memories`;",
      "\nCREATE UNIQUE INDEX `memories_source_fact` ON `memories` (`source_message_id`,`source_revision`,`subject_member_id`,`fingerprint`);",
      "\nCREATE UNIQUE INDEX `memories_source_household_fact` ON `memories` (`source_message_id`,`source_revision`,`fingerprint`) WHERE \"memories\".\"subject_member_id\" IS NULL;",
      "\nCREATE INDEX `memories_household_subject` ON `memories` (`household_id`,`subject_member_id`);",
      "\nCREATE INDEX `memories_household_source_member` ON `memories` (`household_id`,`source_member_id`);",
      "\nCREATE TABLE `__new_memory_blocks` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`origin_host_id` text NOT NULL,\n\t`hlc` text NOT NULL,\n\t`rev` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\t`household_id` text NOT NULL,\n\t`source_member_id` text NOT NULL,\n\t`source_message_id` text NOT NULL,\n\t`source_revision` integer NOT NULL,\n\t`subject_member_id` text,\n\t`fingerprint` text NOT NULL,\n\tFOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`source_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`source_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`subject_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,\n\tCONSTRAINT \"memory_blocks_source_revision\" CHECK(\"source_revision\" > 0)\n);\n",
      "\nINSERT INTO `__new_memory_blocks`(\"id\", \"origin_host_id\", \"hlc\", \"rev\", \"created_at\", \"updated_at\", \"deleted_at\", \"household_id\", \"source_member_id\", \"source_message_id\", \"source_revision\", \"subject_member_id\", \"fingerprint\") SELECT \"id\", \"origin_host_id\", \"hlc\", \"rev\", \"created_at\", \"updated_at\", \"deleted_at\", \"household_id\", \"source_member_id\", \"source_message_id\", \"source_revision\", \"subject_member_id\", \"fingerprint\" FROM `memory_blocks`;",
      "\nDROP TABLE `memory_blocks`;",
      "\nALTER TABLE `__new_memory_blocks` RENAME TO `memory_blocks`;",
      "\nCREATE UNIQUE INDEX `memory_blocks_source_fact` ON `memory_blocks` (`source_message_id`,`source_revision`,`subject_member_id`,`fingerprint`);",
      "\nCREATE UNIQUE INDEX `memory_blocks_source_household_fact` ON `memory_blocks` (`source_message_id`,`source_revision`,`fingerprint`) WHERE \"memory_blocks\".\"subject_member_id\" IS NULL;",
      "\nCREATE INDEX `memory_blocks_household_subject_fact` ON `memory_blocks` (`household_id`,`subject_member_id`,`fingerprint`);"
    ],
    "bps": true,
    "folderMillis": 1795290986542,
    "hash": "aa72f78913f78f101272039f07b34807b4046b6b23c9f905501e56c65547b74d"
  },
  {
    "sql": [
      "CREATE TABLE `chat_reply_knowledge` (\n\t`message_id` text PRIMARY KEY NOT NULL,\n\t`evidence` text NOT NULL,\n\tFOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action\n);\n",
      "\nCREATE TABLE `memory_extraction_dependencies` (\n\t`memory_id` text NOT NULL,\n\t`context_message_id` text NOT NULL,\n\t`context_revision` integer NOT NULL,\n\tPRIMARY KEY(`memory_id`, `context_message_id`),\n\tFOREIGN KEY (`memory_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`context_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,\n\tCONSTRAINT \"memory_extraction_dependencies_revision\" CHECK(\"memory_extraction_dependencies\".\"context_revision\" > 0)\n);\n",
      "\nCREATE INDEX `memory_extraction_dependencies_message` ON `memory_extraction_dependencies` (`context_message_id`);",
      "\nCREATE TABLE `pending_memory_extractions` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`origin_host_id` text NOT NULL,\n\t`hlc` text NOT NULL,\n\t`rev` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\t`household_id` text NOT NULL,\n\t`source_member_id` text NOT NULL,\n\t`source_message_id` text NOT NULL,\n\t`source_revision` integer NOT NULL,\n\t`reason` text NOT NULL,\n\t`key` text NOT NULL,\n\t`value` text NOT NULL,\n\tFOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`source_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`source_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,\n\tCONSTRAINT \"pending_memory_extractions_revision\" CHECK(\"pending_memory_extractions\".\"source_revision\" > 0),\n\tCONSTRAINT \"pending_memory_extractions_reason\" CHECK(\"pending_memory_extractions\".\"reason\" IN ('subject', 'source'))\n);\n",
      "\nCREATE UNIQUE INDEX `pending_memory_extractions_source_fact` ON `pending_memory_extractions` (`source_message_id`,`source_revision`,`key`,`value`);",
      "\nCREATE INDEX `pending_memory_extractions_household` ON `pending_memory_extractions` (`household_id`);",
      "\nALTER TABLE `memories` ADD `corrects_previous` integer DEFAULT false NOT NULL;"
    ],
    "bps": true,
    "folderMillis": 1795292417857,
    "hash": "23a2f35d3d77f7d370858e19e2e1a003fd70b71f3475e948354a6e4403142163"
  },
  {
    "sql": [
      "CREATE TABLE `decisions` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`origin_host_id` text NOT NULL,\n\t`hlc` text NOT NULL,\n\t`rev` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\t`trigger_id` text NOT NULL,\n\t`ticket_id` text NOT NULL,\n\t`outcome` text NOT NULL,\n\t`reasons` text NOT NULL,\n\tFOREIGN KEY (`trigger_id`) REFERENCES `triggers`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE no action\n);\n",
      "\nCREATE UNIQUE INDEX `decisions_one_per_trigger` ON `decisions` (`trigger_id`);",
      "\nCREATE INDEX `decisions_ticket` ON `decisions` (`ticket_id`);",
      "\nCREATE TABLE `runs` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`ticket_id` text NOT NULL,\n\t`publisher_host_id` text NOT NULL,\n\t`generation` integer NOT NULL,\n\t`status` text NOT NULL,\n\t`local_day` text,\n\t`output_tokens` integer DEFAULT 0 NOT NULL,\n\t`elapsed_ms` integer DEFAULT 0 NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\tFOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`publisher_host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE no action,\n\tCONSTRAINT \"runs_generation\" CHECK(\"runs\".\"generation\" >= 0),\n\tCONSTRAINT \"runs_budget\" CHECK(\"runs\".\"output_tokens\" >= 0 AND \"runs\".\"elapsed_ms\" >= 0),\n\tCONSTRAINT \"runs_status\" CHECK(\"runs\".\"status\" IN ('pending', 'running', 'ended'))\n);\n",
      "\nCREATE UNIQUE INDEX `runs_ticket_generation` ON `runs` (`ticket_id`,`generation`);",
      "\nCREATE UNIQUE INDEX `runs_ticket_running` ON `runs` (`ticket_id`) WHERE \"runs\".\"status\" = 'running';",
      "\nCREATE INDEX `runs_host_local_day` ON `runs` (`publisher_host_id`,`local_day`);",
      "\nCREATE TABLE `ticket_inputs` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`origin_host_id` text NOT NULL,\n\t`hlc` text NOT NULL,\n\t`rev` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\t`ticket_id` text NOT NULL,\n\t`trigger_id` text NOT NULL,\n\t`member_id` text NOT NULL,\n\t`kind` text NOT NULL,\n\t`source_message_id` text,\n\t`source_revision` integer,\n\t`text` text NOT NULL,\n\tFOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`trigger_id`) REFERENCES `triggers`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`source_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,\n\tCONSTRAINT \"ticket_inputs_source_proof\" CHECK((\"ticket_inputs\".\"source_message_id\" IS NULL AND \"ticket_inputs\".\"source_revision\" IS NULL)\n    OR (\"ticket_inputs\".\"source_message_id\" IS NOT NULL AND \"ticket_inputs\".\"source_revision\" IS NOT NULL AND \"ticket_inputs\".\"source_revision\" > 0))\n);\n",
      "\nCREATE UNIQUE INDEX `ticket_inputs_trigger` ON `ticket_inputs` (`trigger_id`);",
      "\nCREATE INDEX `ticket_inputs_ticket` ON `ticket_inputs` (`ticket_id`,`hlc`,`id`);",
      "\nCREATE TABLE `tickets` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`origin_host_id` text NOT NULL,\n\t`hlc` text NOT NULL,\n\t`rev` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\t`household_id` text NOT NULL,\n\t`conversation_id` text NOT NULL,\n\t`for_member_id` text NOT NULL,\n\t`publisher_host_id` text NOT NULL,\n\t`kind` text NOT NULL,\n\t`mandate_kind` text NOT NULL,\n\t`source_message_id` text NOT NULL,\n\t`source_revision` integer NOT NULL,\n\t`goal` text NOT NULL,\n\t`status` text NOT NULL,\n\t`stage` text NOT NULL,\n\t`ended_reason` text,\n\t`due_at` integer,\n\t`time_zone` text NOT NULL,\n\tFOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`for_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`publisher_host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`source_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,\n\tCONSTRAINT \"tickets_due_at\" CHECK((\"tickets\".\"kind\" = 'followup' AND \"tickets\".\"due_at\" IS NOT NULL)\n    OR (\"tickets\".\"kind\" = 'errand' AND \"tickets\".\"due_at\" IS NULL)),\n\tCONSTRAINT \"tickets_source_revision\" CHECK(\"tickets\".\"source_revision\" > 0),\n\tCONSTRAINT \"tickets_status_stage\" CHECK((\"tickets\".\"status\" = 'open'\n    AND \"tickets\".\"stage\" IN ('scheduled', 'queued', 'thinking', 'waiting', 'quiet_waiting') AND \"tickets\".\"ended_reason\" IS NULL)\n    OR (\"tickets\".\"status\" = 'ended'\n    AND \"tickets\".\"stage\" IN ('completed', 'failed', 'blocked', 'discarded', 'cancelled')))\n);\n",
      "\nCREATE INDEX `tickets_member_status` ON `tickets` (`household_id`,`for_member_id`,`status`,`due_at`);",
      "\nCREATE INDEX `tickets_host_admission` ON `tickets` (`publisher_host_id`,`kind`,`status`,`stage`);",
      "\nCREATE TABLE `triggers` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`origin_host_id` text NOT NULL,\n\t`hlc` text NOT NULL,\n\t`rev` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\t`household_id` text NOT NULL,\n\t`conversation_id` text NOT NULL,\n\t`actor_member_id` text NOT NULL,\n\t`publisher_host_id` text NOT NULL,\n\t`source` text NOT NULL,\n\t`source_message_id` text,\n\t`source_revision` integer,\n\t`idempotency_key` text NOT NULL,\n\t`command_kind` text NOT NULL,\n\t`fingerprint` text NOT NULL,\n\t`receipt` text NOT NULL,\n\tFOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`actor_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`publisher_host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`source_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,\n\tCONSTRAINT \"triggers_source_proof\" CHECK((\"triggers\".\"source_message_id\" IS NULL AND \"triggers\".\"source_revision\" IS NULL AND \"triggers\".\"source\" = 'app')\n    OR (\"triggers\".\"source_message_id\" IS NOT NULL AND \"triggers\".\"source_revision\" IS NOT NULL AND \"triggers\".\"source_revision\" > 0))\n);\n",
      "\nCREATE UNIQUE INDEX `triggers_request_key` ON `triggers` (`household_id`,`actor_member_id`,`source`,`idempotency_key`);"
    ],
    "bps": true,
    "folderMillis": 1795293575282,
    "hash": "214694d5ece4866c7372a34842511e0c1508b333bfcc9a1446c60c32d61d9f6c"
  },
  {
    "sql": [
      "CREATE TABLE `run_steps` (\n\t`run_id` text NOT NULL,\n\t`step` integer NOT NULL,\n\t`ticket_rev` integer NOT NULL,\n\t`history` text NOT NULL,\n\t`input_ids` text NOT NULL,\n\t`conversation_head` text NOT NULL,\n\t`dependencies` text NOT NULL,\n\t`usage` text NOT NULL,\n\t`created_at` integer NOT NULL,\n\tPRIMARY KEY(`run_id`, `step`),\n\tFOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,\n\tCONSTRAINT \"run_steps_position\" CHECK(\"run_steps\".\"step\" BETWEEN 1 AND 20 AND \"run_steps\".\"ticket_rev\" > 0)\n);\n",
      "\nCREATE TABLE `worker_reports` (\n\t`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`id` text NOT NULL,\n\t`ticket_id` text NOT NULL,\n\t`ticket_rev` integer NOT NULL,\n\t`result_ticket_rev` integer NOT NULL,\n\t`household_id` text NOT NULL,\n\t`conversation_id` text NOT NULL,\n\t`for_member_id` text NOT NULL,\n\t`publisher_host_id` text NOT NULL,\n\t`kind` text NOT NULL,\n\t`run_id` text,\n\t`generation` integer,\n\t`job_id` text NOT NULL,\n\t`job_attempt` integer NOT NULL,\n\t`result` text NOT NULL,\n\t`source_proofs` text NOT NULL,\n\t`dependencies` text NOT NULL,\n\t`conversation_head` text NOT NULL,\n\t`due_at` integer,\n\t`time_zone` text NOT NULL,\n\t`quiet_after` integer,\n\t`created_at` integer NOT NULL,\n\tFOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`for_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`publisher_host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,\n\tCONSTRAINT \"worker_reports_kind_run\" CHECK((\"worker_reports\".\"kind\" = 'followup' AND \"worker_reports\".\"run_id\" IS NULL\n    AND \"worker_reports\".\"generation\" IS NULL AND \"worker_reports\".\"due_at\" IS NOT NULL)\n    OR (\"worker_reports\".\"kind\" = 'errand' AND \"worker_reports\".\"run_id\" IS NOT NULL AND \"worker_reports\".\"generation\" IS NOT NULL AND \"worker_reports\".\"generation\" >= 0 AND \"worker_reports\".\"due_at\" IS NULL)),\n\tCONSTRAINT \"worker_reports_revision\" CHECK(\"worker_reports\".\"ticket_rev\" > 0 AND \"worker_reports\".\"result_ticket_rev\" = \"worker_reports\".\"ticket_rev\" + 1\n    AND \"worker_reports\".\"job_attempt\" > 0)\n);\n",
      "\nCREATE UNIQUE INDEX `worker_reports_id_unique` ON `worker_reports` (`id`);",
      "\nCREATE UNIQUE INDEX `worker_reports_ticket_revision` ON `worker_reports` (`ticket_id`,`ticket_rev`);",
      "\nCREATE INDEX `worker_reports_host_cursor` ON `worker_reports` (`publisher_host_id`,`sequence`);"
    ],
    "bps": true,
    "folderMillis": 1795293580269,
    "hash": "7675ff6feadd8d262ce53ca5a06ed3f79f6cca9ea77d8a28e621240fc1b9770e"
  },
  {
    "sql": [
      "CREATE TABLE `mailbox_letters` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`origin_host_id` text NOT NULL,\n\t`hlc` text NOT NULL,\n\t`rev` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\t`household_id` text NOT NULL,\n\t`conversation_id` text NOT NULL,\n\t`for_member_id` text NOT NULL,\n\t`publisher_host_id` text NOT NULL,\n\t`ticket_id` text NOT NULL,\n\t`text` text NOT NULL,\n\t`created_hlc` text NOT NULL,\n\t`read_at` integer,\n\tFOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`for_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`publisher_host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE no action\n);\n",
      "\nCREATE INDEX `mailbox_member_order` ON `mailbox_letters` (`household_id`,`for_member_id`,`created_hlc`,`id`);",
      "\nCREATE TABLE `publication_receipts` (\n\t`report_id` text PRIMARY KEY NOT NULL,\n\t`host_id` text NOT NULL,\n\t`ticket_id` text NOT NULL,\n\t`status` text NOT NULL,\n\t`retry_at` integer,\n\t`reason` text,\n\t`message_id` text,\n\t`letter_id` text,\n\t`resolved_at` integer,\n\tFOREIGN KEY (`report_id`) REFERENCES `worker_reports`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`letter_id`) REFERENCES `mailbox_letters`(`id`) ON UPDATE no action ON DELETE no action,\n\tCONSTRAINT \"publication_receipt_status\" CHECK(\n    (\"publication_receipts\".\"status\" = 'pending' AND \"publication_receipts\".\"retry_at\" IS NOT NULL AND \"publication_receipts\".\"resolved_at\" IS NULL\n      AND \"publication_receipts\".\"message_id\" IS NULL AND \"publication_receipts\".\"letter_id\" IS NULL)\n    OR (\"publication_receipts\".\"status\" = 'dropped' AND \"publication_receipts\".\"retry_at\" IS NULL AND \"publication_receipts\".\"resolved_at\" IS NOT NULL\n      AND \"publication_receipts\".\"reason\" IS NOT NULL AND \"publication_receipts\".\"message_id\" IS NULL AND \"publication_receipts\".\"letter_id\" IS NULL)\n    OR (\"publication_receipts\".\"status\" = 'published' AND \"publication_receipts\".\"retry_at\" IS NULL AND \"publication_receipts\".\"resolved_at\" IS NOT NULL\n      AND (\"publication_receipts\".\"message_id\" IS NOT NULL OR \"publication_receipts\".\"letter_id\" IS NOT NULL)))\n);\n",
      "\nCREATE INDEX `publication_receipts_ready` ON `publication_receipts` (`host_id`,`status`,`retry_at`,`report_id`);",
      "\nCREATE TABLE `publication_push_outbox` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`report_id` text NOT NULL,\n\t`host_id` text NOT NULL,\n\t`member_id` text NOT NULL,\n\t`status` text NOT NULL,\n\t`retry_at` integer NOT NULL,\n\t`budget_day` text,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\tFOREIGN KEY (`report_id`) REFERENCES `publication_receipts`(`report_id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action\n);\n",
      "\nCREATE UNIQUE INDEX `publication_push_outbox_report_id_unique` ON `publication_push_outbox` (`report_id`);",
      "\nCREATE INDEX `publication_push_ready` ON `publication_push_outbox` (`host_id`,`status`,`retry_at`,`id`);",
      "\nCREATE INDEX `publication_push_member_day` ON `publication_push_outbox` (`member_id`,`budget_day`);"
    ],
    "bps": true,
    "folderMillis": 1795293580626,
    "hash": "a21ea11cc6f9133c6a57ff3335137b149c8050fbec151e5c61d64ced4e549de6"
  },
  {
    "sql": [
      "CREATE TABLE `inference_candidates` (\n\t`source_message_id` text PRIMARY KEY NOT NULL,\n\t`source_revision` integer NOT NULL,\n\t`household_id` text NOT NULL,\n\t`conversation_id` text NOT NULL,\n\t`source_member_id` text NOT NULL,\n\t`host_id` text NOT NULL,\n\t`publication_epoch` text NOT NULL,\n\t`audience` text NOT NULL,\n\t`source_time_zone` text NOT NULL,\n\t`rule` text NOT NULL,\n\t`topic` text NOT NULL,\n\t`after_at` integer NOT NULL,\n\t`status` text NOT NULL,\n\t`reason` text,\n\t`retry_at` integer,\n\t`resolved_at` integer,\n\t`ticket_id` text,\n\t`message_id` text,\n\t`letter_id` text,\n\tFOREIGN KEY (`source_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`source_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`letter_id`) REFERENCES `mailbox_letters`(`id`) ON UPDATE no action ON DELETE no action,\n\tCONSTRAINT \"inference_status\" CHECK(\n    (\"inference_candidates\".\"status\" = 'pending' AND \"inference_candidates\".\"retry_at\" IS NOT NULL AND \"inference_candidates\".\"resolved_at\" IS NULL)\n    OR (\"inference_candidates\".\"status\" IN ('observed', 'dropped', 'published') AND \"inference_candidates\".\"retry_at\" IS NULL AND \"inference_candidates\".\"resolved_at\" IS NOT NULL)\n  ),\n\tCONSTRAINT \"inference_delivery\" CHECK(\n    (\"inference_candidates\".\"status\" = 'published' AND \"inference_candidates\".\"ticket_id\" IS NOT NULL AND \"inference_candidates\".\"message_id\" IS NOT NULL AND \"inference_candidates\".\"letter_id\" IS NOT NULL)\n    OR (\"inference_candidates\".\"status\" <> 'published' AND \"inference_candidates\".\"ticket_id\" IS NULL AND \"inference_candidates\".\"message_id\" IS NULL AND \"inference_candidates\".\"letter_id\" IS NULL)\n  )\n);\n",
      "\nCREATE INDEX `inference_ready` ON `inference_candidates` (`host_id`,`status`,`retry_at`,`source_message_id`);",
      "\nCREATE TABLE `inference_daily_receipts` (\n\t`member_id` text NOT NULL,\n\t`local_day` text NOT NULL,\n\t`source_message_id` text NOT NULL,\n\tPRIMARY KEY(`member_id`, `local_day`),\n\tFOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`source_message_id`) REFERENCES `inference_candidates`(`source_message_id`) ON UPDATE no action ON DELETE no action\n);\n",
      "\nCREATE TABLE `proactive_permissions` (\n\t`member_id` text PRIMARY KEY NOT NULL,\n\t`allowed` integer NOT NULL,\n\t`revision` integer NOT NULL,\n\t`time_zone` text NOT NULL,\n\tFOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action\n);\n",
      "\nALTER TABLE `turns` ADD `publication_epoch` text;"
    ],
    "bps": true,
    "folderMillis": 1795293622701,
    "hash": "36d9e991f4c06417d7f03b2af3f775916791520bc8391febbd9abb3fcbd93069"
  },
  {
    "sql": [
      "CREATE TABLE `change_log` (\n\t`source_host_id` text NOT NULL,\n\t`generation` text NOT NULL,\n\t`seq` integer NOT NULL,\n\t`kind` text NOT NULL,\n\t`payload` text NOT NULL,\n\tPRIMARY KEY(`source_host_id`, `generation`, `seq`)\n);\n",
      "\nCREATE TABLE `peer_cursors` (\n\t`source_host_id` text PRIMARY KEY NOT NULL,\n\t`household_id` text NOT NULL,\n\t`generation` text NOT NULL,\n\t`seq` integer NOT NULL\n);\n",
      "\nCREATE TABLE `peers` (\n\t`host_id` text PRIMARY KEY NOT NULL,\n\t`household_id` text NOT NULL,\n\t`join_from_household_id` text,\n\t`join_prepared_at` integer,\n\t`address_host` text NOT NULL,\n\t`address_port` integer NOT NULL,\n\t`ca_certificate` text NOT NULL,\n\t`fingerprint` text NOT NULL,\n\t`protocol_version` integer NOT NULL,\n\t`approved_at` integer NOT NULL,\n\t`confirmed_at` integer,\n\t`confirmed_local_fingerprint` text,\n\t`revoked_at` integer,\n\t`pull_paused` integer DEFAULT false NOT NULL,\n\tFOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action\n);\n",
      "\nCREATE UNIQUE INDEX `peers_fingerprint_unique` ON `peers` (`fingerprint`);",
      "\nCREATE TABLE `replication_state` (\n\t`source_host_id` text PRIMARY KEY NOT NULL,\n\t`generation` text NOT NULL,\n\t`last_seq` integer NOT NULL,\n\t`snapshot_required` integer NOT NULL\n);\n"
    ],
    "bps": true,
    "folderMillis": 1795294636865,
    "hash": "b1d2a3362d3126368dfa08759ce6a7c54105755d9b2938348ab0f3c4c721c6d1"
  },
  {
    "sql": [
      "CREATE TABLE `peer_inbox` (\n\t`household_id` text NOT NULL,\n\t`source_host_id` text NOT NULL,\n\t`idempotency_key` text NOT NULL,\n\t`request_hash` text NOT NULL,\n\t`receipt` text NOT NULL,\n\tPRIMARY KEY(`household_id`, `source_host_id`, `idempotency_key`)\n);\n",
      "\nCREATE TABLE `peer_outbox` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`household_id` text NOT NULL,\n\t`target_host_id` text NOT NULL,\n\t`idempotency_key` text NOT NULL,\n\t`request_hash` text NOT NULL,\n\t`envelope` text NOT NULL,\n\t`job_id` text NOT NULL,\n\t`status` text NOT NULL,\n\t`receipt` text,\n\t`created_at` integer NOT NULL,\n\t`settled_at` integer,\n\tCONSTRAINT \"peer_outbox_state\" CHECK(\n    (\"peer_outbox\".\"status\" = 'pending' AND \"peer_outbox\".\"receipt\" IS NULL AND \"peer_outbox\".\"settled_at\" IS NULL)\n    OR (\"peer_outbox\".\"status\" = 'delivered' AND \"peer_outbox\".\"receipt\" IS NOT NULL AND \"peer_outbox\".\"settled_at\" IS NOT NULL)\n    OR (\"peer_outbox\".\"status\" = 'rejected' AND \"peer_outbox\".\"receipt\" IS NULL AND \"peer_outbox\".\"settled_at\" IS NOT NULL))\n);\n",
      "\nCREATE UNIQUE INDEX `peer_outbox_target_key` ON `peer_outbox` (`household_id`,`target_host_id`,`idempotency_key`);"
    ],
    "bps": true,
    "folderMillis": 1795294637262,
    "hash": "0b8152ad9a9e05db6cd2cadefc7cc9d79826ed479db19fc756ef18d8bccdf2d5"
  },
  {
    "sql": [
      "CREATE TABLE `relay_grants` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`origin_host_id` text NOT NULL,\n\t`hlc` text NOT NULL,\n\t`rev` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\t`household_id` text NOT NULL,\n\t`source_member_id` text NOT NULL,\n\t`source_message_id` text NOT NULL,\n\t`source_revision` integer NOT NULL,\n\t`target_member_id` text NOT NULL,\n\t`target_host_id` text NOT NULL,\n\t`source_generation` text NOT NULL,\n\t`source_seq` integer NOT NULL,\n\t`source_day` text NOT NULL,\n\t`source_time_zone` text NOT NULL,\n\t`urgent` integer NOT NULL,\n\tFOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`source_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`source_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`target_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`target_host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE no action,\n\tCONSTRAINT \"relay_grants_proof\" CHECK(\"relay_grants\".\"source_member_id\" <> \"relay_grants\".\"target_member_id\"\n    AND \"relay_grants\".\"source_revision\" > 0 AND \"relay_grants\".\"source_seq\" > 0 AND \"relay_grants\".\"rev\" = 1 AND \"relay_grants\".\"deleted_at\" IS NULL)\n);\n",
      "\nCREATE UNIQUE INDEX `relay_grants_original` ON `relay_grants` (`source_message_id`);",
      "\nCREATE INDEX `relay_grants_quota` ON `relay_grants` (`source_member_id`,`source_day`,`urgent`);",
      "\nCREATE TABLE `relay_publications` (\n\t`grant_id` text PRIMARY KEY NOT NULL,\n\t`target_host_id` text NOT NULL,\n\t`state` text NOT NULL,\n\t`reason` text,\n\t`retry_at` integer,\n\t`message_id` text,\n\tFOREIGN KEY (`grant_id`) REFERENCES `relay_grants`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`target_host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,\n\tCONSTRAINT \"relay_publications_state\" CHECK(\n    (\"relay_publications\".\"state\" = 'pending' AND \"relay_publications\".\"retry_at\" IS NOT NULL AND \"relay_publications\".\"message_id\" IS NULL)\n    OR (\"relay_publications\".\"state\" = 'published' AND \"relay_publications\".\"retry_at\" IS NULL AND \"relay_publications\".\"message_id\" IS NOT NULL)\n    OR (\"relay_publications\".\"state\" = 'dropped' AND \"relay_publications\".\"retry_at\" IS NULL AND \"relay_publications\".\"message_id\" IS NULL))\n);\n",
      "\nCREATE INDEX `relay_publications_due` ON `relay_publications` (`target_host_id`,`state`,`retry_at`);",
      "\nCREATE UNIQUE INDEX `relay_publications_message` ON `relay_publications` (`message_id`);"
    ],
    "bps": true,
    "folderMillis": 1795294946787,
    "hash": "13b4da90aea79608ad61e0b361249151c60d9e077e97a3e301adb15b7ec98910"
  },
  {
    "sql": [
      "CREATE TABLE `mailbox_reads` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`origin_host_id` text NOT NULL,\n\t`hlc` text NOT NULL,\n\t`rev` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\t`household_id` text NOT NULL,\n\t`letter_id` text NOT NULL,\n\t`member_id` text NOT NULL,\n\t`read_at` integer NOT NULL,\n\tFOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`letter_id`) REFERENCES `mailbox_letters`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action\n);\n",
      "\nCREATE UNIQUE INDEX `mailbox_reads_letter_id_unique` ON `mailbox_reads` (`letter_id`);",
      "\nCREATE TABLE `ticket_publications` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`origin_host_id` text NOT NULL,\n\t`hlc` text NOT NULL,\n\t`rev` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\t`household_id` text NOT NULL,\n\t`ticket_id` text NOT NULL,\n\t`ticket_rev` integer NOT NULL,\n\t`kind` text NOT NULL,\n\t`message_id` text,\n\t`letter_id` text,\n\t`audience_days` text NOT NULL,\n\tFOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`letter_id`) REFERENCES `mailbox_letters`(`id`) ON UPDATE no action ON DELETE no action,\n\tCONSTRAINT \"ticket_publication_content\" CHECK(\"ticket_publications\".\"message_id\" IS NOT NULL OR \"ticket_publications\".\"letter_id\" IS NOT NULL)\n);\n",
      "\nCREATE UNIQUE INDEX `ticket_publications_message_id_unique` ON `ticket_publications` (`message_id`);",
      "\nCREATE UNIQUE INDEX `ticket_publications_letter_id_unique` ON `ticket_publications` (`letter_id`);",
      "\nCREATE INDEX `ticket_publications_ticket` ON `ticket_publications` (`ticket_id`);",
      "\nCREATE TABLE `publication_epochs` (\n\t`household_id` text NOT NULL,\n\t`epoch` integer NOT NULL,\n\t`grant_id` text NOT NULL,\n\t`holder_host_id` text NOT NULL,\n\t`previous_holder_host_id` text NOT NULL,\n\t`previous_grant_id` text NOT NULL,\n\t`history_digest` text NOT NULL,\n\t`acknowledged` integer NOT NULL,\n\tPRIMARY KEY(`household_id`, `epoch`),\n\tFOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action\n);\n",
      "\nCREATE UNIQUE INDEX `publication_grant_id` ON `publication_epochs` (`household_id`,`grant_id`);",
      "\nCREATE TABLE `publication_renewals` (\n\t`household_id` text NOT NULL,\n\t`epoch` integer NOT NULL,\n\t`sequence` integer NOT NULL,\n\t`request_id` text NOT NULL,\n\tPRIMARY KEY(`household_id`, `epoch`),\n\tFOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action\n);\n",
      "\nCREATE TABLE `group_send_intents` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`origin_host_id` text NOT NULL,\n\t`hlc` text NOT NULL,\n\t`rev` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\t`household_id` text NOT NULL,\n\t`conversation_id` text NOT NULL,\n\t`member_id` text NOT NULL,\n\t`client_message_id` text NOT NULL,\n\t`text` text NOT NULL,\n\t`status` text,\n\t`delivery_id` text,\n\tFOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action\n);\n",
      "\nCREATE UNIQUE INDEX `group_send_client_request` ON `group_send_intents` (`conversation_id`,`member_id`,`client_message_id`);",
      "\nCREATE INDEX `group_send_pending` ON `group_send_intents` (`origin_host_id`,`household_id`) WHERE \"group_send_intents\".\"status\" = 'pending';",
      "\nALTER TABLE `messages` ADD `publication_epoch` integer;",
      "\nALTER TABLE `peer_outbox` ADD `rejection_code` text;",
      "\nALTER TABLE `peers` ADD `approval_id` text;",
      "\nALTER TABLE `tickets` ADD `publication_epoch` integer;\n",
      "\n-- The migration reconstructs business evidence only. Existing local reports,\n-- jobs and delivery receipts keep their status and original references.\nINSERT INTO mailbox_reads\n  (id, origin_host_id, hlc, rev, created_at, updated_at, deleted_at, household_id, letter_id, member_id, read_at)\nSELECT l.id, m.home_host_id, l.hlc, 1, l.read_at, l.read_at, NULL, l.household_id, l.id, l.for_member_id, l.read_at\nFROM mailbox_letters l JOIN members m ON m.id = l.for_member_id\nWHERE l.read_at IS NOT NULL AND m.home_host_id = (SELECT value FROM host_meta WHERE key = 'host_id');\n",
      "\nINSERT INTO ticket_publications\n  (id, origin_host_id, hlc, rev, created_at, updated_at, deleted_at, household_id, ticket_id, ticket_rev, kind, message_id, letter_id, audience_days)\nSELECT p.report_id, p.host_id, coalesce(m.hlc, l.created_hlc), 1, p.resolved_at, p.resolved_at, NULL,\n  t.household_id, p.ticket_id, r.result_ticket_rev, 'worker', p.message_id, p.letter_id, '[]'\nFROM publication_receipts p JOIN worker_reports r ON r.id = p.report_id JOIN tickets t ON t.id = p.ticket_id\nLEFT JOIN messages m ON m.id = p.message_id LEFT JOIN mailbox_letters l ON l.id = p.letter_id\nWHERE p.status = 'published';\n",
      "\nINSERT INTO ticket_publications\n  (id, origin_host_id, hlc, rev, created_at, updated_at, deleted_at, household_id, ticket_id, ticket_rev, kind, message_id, letter_id, audience_days)\nSELECT i.message_id, i.host_id, m.hlc, 1, i.resolved_at, i.resolved_at, NULL, i.household_id,\n  i.ticket_id, 1, 'inference', i.message_id, i.letter_id,\n  (SELECT json_group_array(json_object('memberId', d.member_id, 'localDay', d.local_day))\n   FROM inference_daily_receipts d WHERE d.source_message_id = i.source_message_id ORDER BY d.member_id)\nFROM inference_candidates i JOIN messages m ON m.id = i.message_id\nWHERE i.status = 'published';\n"
    ],
    "bps": true,
    "folderMillis": 1795296103098,
    "hash": "67d5c61b76fcd22ee54b3fefc2c5f51280d5a01604a4420c001bae12054534db"
  },
  {
    "sql": [
      "CREATE TABLE `file_blobs` (\n\t`sha256` text PRIMARY KEY NOT NULL,\n\t`byte_size` integer NOT NULL,\n\t`verified_at` integer NOT NULL\n);\n",
      "\nCREATE TABLE `file_descriptions` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`origin_host_id` text NOT NULL,\n\t`hlc` text NOT NULL,\n\t`rev` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\t`file_id` text NOT NULL,\n\t`file_rev` integer NOT NULL,\n\t`source_message_id` text,\n\t`source_message_rev` integer,\n\t`sha256` text NOT NULL,\n\t`model_id` text NOT NULL,\n\t`text` text NOT NULL,\n\tFOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action\n);\n",
      "\nCREATE UNIQUE INDEX `file_descriptions_file_revision` ON `file_descriptions` (`file_id`,`file_rev`);",
      "\nCREATE TABLE `file_uploads` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`client_upload_id` text NOT NULL,\n\t`household_id` text NOT NULL,\n\t`owner_member_id` text NOT NULL,\n\t`conversation_id` text NOT NULL,\n\t`source_message_id` text,\n\t`source_message_rev` integer,\n\t`sha256` text NOT NULL,\n\t`byte_size` integer NOT NULL,\n\t`file_name` text NOT NULL,\n\t`media_type` text NOT NULL,\n\t`description` text,\n\tFOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`owner_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action\n);\n",
      "\nCREATE UNIQUE INDEX `file_uploads_owner_client_id` ON `file_uploads` (`owner_member_id`,`client_upload_id`);",
      "\nCREATE TABLE `files` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`origin_host_id` text NOT NULL,\n\t`hlc` text NOT NULL,\n\t`rev` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\t`household_id` text NOT NULL,\n\t`owner_member_id` text NOT NULL,\n\t`conversation_id` text NOT NULL,\n\t`source_message_id` text,\n\t`source_message_rev` integer,\n\t`sha256` text NOT NULL,\n\t`byte_size` integer NOT NULL,\n\t`file_name` text NOT NULL,\n\t`media_type` text NOT NULL,\n\t`description` text,\n\tFOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`owner_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,\n\tCONSTRAINT \"files_source_message\" CHECK((\"files\".\"source_message_id\" IS NULL AND \"files\".\"source_message_rev\" IS NULL)\n    OR (\"files\".\"source_message_id\" IS NOT NULL AND \"files\".\"source_message_rev\" IS NOT NULL AND \"files\".\"source_message_rev\" > 0))\n);\n",
      "\nCREATE INDEX `files_conversation_order` ON `files` (`conversation_id`,`id`);",
      "\nCREATE INDEX `files_sha256` ON `files` (`sha256`);",
      "\nCREATE TABLE `member_change_projections` (\n\t`household_id` text NOT NULL,\n\t`member_id` text NOT NULL,\n\t`generation` text NOT NULL,\n\t`kind` text NOT NULL,\n\t`resource_id` text NOT NULL,\n\t`sequence` integer NOT NULL,\n\t`fingerprint` text,\n\tPRIMARY KEY(`household_id`, `member_id`, `kind`, `resource_id`)\n);\n",
      "\nCREATE UNIQUE INDEX `member_change_sequence` ON `member_change_projections` (`household_id`,`member_id`,`sequence`);",
      "\nCREATE TABLE `member_resource_receipts` (\n\t`member_id` text NOT NULL,\n\t`request_id` text NOT NULL,\n\t`request_hash` text NOT NULL,\n\t`resource_id` text NOT NULL,\n\tPRIMARY KEY(`member_id`, `request_id`),\n\tFOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action\n);\n",
      "\nCREATE TABLE `retired_peer_generations` (\n\t`source_host_id` text NOT NULL,\n\t`generation` text NOT NULL,\n\tPRIMARY KEY(`source_host_id`, `generation`)\n);\n",
      "\nALTER TABLE `change_log` ADD `transaction_end_seq` integer;"
    ],
    "bps": true,
    "folderMillis": 1795297553784,
    "hash": "0ee66211680ad3a39a496129d65d4f95d3e03cbfbae7e8263835b915cc4236e5"
  },
  {
    "sql": [
      "CREATE TABLE `imported_cat_diary` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`origin_host_id` text NOT NULL,\n\t`hlc` text NOT NULL,\n\t`rev` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\t`household_id` text NOT NULL,\n\t`owner_member_id` text NOT NULL,\n\t`text` text NOT NULL,\n\t`recorded_at` integer NOT NULL,\n\t`local_day` text NOT NULL,\n\t`time_zone` text NOT NULL,\n\tFOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`owner_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action\n);\n",
      "\nCREATE TABLE `imported_memory_blocks` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`origin_host_id` text NOT NULL,\n\t`hlc` text NOT NULL,\n\t`rev` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\t`household_id` text NOT NULL,\n\t`member_id` text NOT NULL,\n\t`fingerprint` text NOT NULL,\n\tFOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action\n);\n",
      "\nCREATE UNIQUE INDEX `imported_memory_block_identity` ON `imported_memory_blocks` (`member_id`,`fingerprint`);",
      "\nCREATE TABLE `imported_memory_restrictions` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`origin_host_id` text NOT NULL,\n\t`hlc` text NOT NULL,\n\t`rev` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\t`household_id` text NOT NULL,\n\t`member_id` text NOT NULL,\n\t`learning_disabled` integer NOT NULL,\n\t`recall_disabled` integer NOT NULL,\n\tFOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action\n);\n",
      "\nCREATE UNIQUE INDEX `imported_memory_restrictions_member_id_unique` ON `imported_memory_restrictions` (`member_id`);",
      "\nCREATE TABLE `pg_import_archive` (\n\t`source_table` text NOT NULL,\n\t`source_key` text NOT NULL,\n\t`source_sha256` text NOT NULL,\n\t`target_id` text,\n\t`reason` text NOT NULL,\n\t`evidence_json` text NOT NULL,\n\tPRIMARY KEY(`source_table`, `source_key`)\n);\n",
      "\nCREATE TABLE `pg_import_receipts` (\n\t`id` integer PRIMARY KEY NOT NULL,\n\t`source_sha256` text NOT NULL,\n\t`report` text NOT NULL\n);\n",
      "\nALTER TABLE `messages` ADD `history_context_blocked` integer DEFAULT false NOT NULL;"
    ],
    "bps": true,
    "folderMillis": 1795299801391,
    "hash": "e4d525fa99d59a58fa46d4fa79376cf2d8160d948b3b6900dd2a0463436e1b33"
  },
  {
    "sql": [
      "CREATE TABLE `device_push_registrations` (\n\t`device_id` text PRIMARY KEY NOT NULL,\n\t`binding_id` text NOT NULL,\n\t`token` text NOT NULL,\n\t`environment` text NOT NULL,\n\t`topic` text NOT NULL,\n\t`updated_at` integer NOT NULL,\n\tFOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action\n);\n",
      "\nCREATE UNIQUE INDEX `device_push_provider_token` ON `device_push_registrations` (`environment`,`topic`,`token`);",
      "\nCREATE TABLE `publication_push_deliveries` (\n\t`notification_id` text NOT NULL,\n\t`device_id` text NOT NULL,\n\t`binding_id` text NOT NULL,\n\t`apns_id` text NOT NULL,\n\t`status` text NOT NULL,\n\tPRIMARY KEY(`notification_id`, `device_id`),\n\tFOREIGN KEY (`notification_id`) REFERENCES `publication_push_outbox`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action\n);\n",
      "\nCREATE UNIQUE INDEX `publication_push_deliveries_apns_id_unique` ON `publication_push_deliveries` (`apns_id`);"
    ],
    "bps": true,
    "folderMillis": 1795301192645,
    "hash": "6de494d3e99638fcd51dcc41438a4c88d9eccd01d63ec356a7f18a6368f1ffe9"
  },
  {
    "sql": [
      "CREATE TABLE `model_calls` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`host_id` text NOT NULL,\n\t`day` text NOT NULL,\n\t`slot` text NOT NULL,\n\t`purpose` text NOT NULL,\n\t`provider` text NOT NULL,\n\t`model` text NOT NULL,\n\t`turn_id` text,\n\t`job_id` text,\n\t`reserved_tokens` integer NOT NULL,\n\t`status` text NOT NULL,\n\t`input_tokens` integer,\n\t`output_tokens` integer,\n\t`reasoning_tokens` integer,\n\t`cache_read_tokens` integer,\n\t`latency_ms` integer,\n\t`created_at` integer NOT NULL,\n\tFOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE no action,\n\tCONSTRAINT \"model_calls_status\" CHECK(\"model_calls\".\"status\" IN ('reserved', 'completed', 'failed')),\n\tCONSTRAINT \"model_calls_reservation\" CHECK(\"model_calls\".\"reserved_tokens\" > 0)\n);\n",
      "\nCREATE INDEX `model_calls_host_day` ON `model_calls` (`host_id`,`day`);"
    ],
    "bps": true,
    "folderMillis": 1795304003820,
    "hash": "229ed354a4d2054b345b9bad98dd34747701643d04b4056406690dc536735da1"
  },
  {
    "sql": [
      "CREATE TABLE `world_actions` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`origin_host_id` text NOT NULL,\n\t`hlc` text NOT NULL,\n\t`rev` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\t`household_id` text NOT NULL,\n\t`cat_id` text NOT NULL,\n\t`epoch` integer NOT NULL,\n\t`grant_id` text NOT NULL,\n\t`member_id` text NOT NULL,\n\t`request_id` text NOT NULL,\n\t`destination_id` text NOT NULL,\n\t`activity` text,\n\t`state_version` integer NOT NULL,\n\t`status` text NOT NULL,\n\t`reason` text,\n\t`accept_before` integer NOT NULL,\n\t`finish_before` integer NOT NULL,\n\t`result_snapshot` text,\n\t`occurred_at` integer,\n\tFOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`cat_id`) REFERENCES `world_cats`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action\n);\n",
      "\nCREATE UNIQUE INDEX `world_action_request` ON `world_actions` (`household_id`,`member_id`,`request_id`);",
      "\nCREATE INDEX `world_action_publication` ON `world_actions` (`household_id`,`epoch`,`status`);",
      "\nCREATE TABLE `world_cats` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`origin_host_id` text NOT NULL,\n\t`hlc` text NOT NULL,\n\t`rev` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\t`household_id` text NOT NULL,\n\t`legacy_id` text,\n\t`epoch` integer NOT NULL,\n\t`grant_id` text NOT NULL,\n\tFOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action\n);\n",
      "\nCREATE UNIQUE INDEX `world_cats_household_id_unique` ON `world_cats` (`household_id`);",
      "\nCREATE UNIQUE INDEX `world_cats_legacy_id_unique` ON `world_cats` (`legacy_id`);",
      "\nCREATE TABLE `world_executors` (\n\t`action_id` text PRIMARY KEY NOT NULL,\n\t`session_id` text NOT NULL,\n\tFOREIGN KEY (`action_id`) REFERENCES `world_actions`(`id`) ON UPDATE no action ON DELETE no action\n);\n",
      "\nCREATE INDEX `world_executor_session` ON `world_executors` (`session_id`);",
      "\nCREATE TABLE `world_sessions` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`household_id` text NOT NULL,\n\t`member_id` text NOT NULL,\n\t`device_id` text NOT NULL,\n\t`generation` text NOT NULL,\n\t`present_until` integer NOT NULL,\n\t`stream_until` integer NOT NULL,\n\t`drive_grant_id` text,\n\t`snapshot` text,\n\t`state_version` integer NOT NULL,\n\t`observed_at` integer,\n\tFOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action\n);\n",
      "\nCREATE UNIQUE INDEX `world_sessions_member_id_unique` ON `world_sessions` (`member_id`);",
      "\nCREATE INDEX `world_sessions_household` ON `world_sessions` (`household_id`);",
      "\nCREATE TABLE `world_states` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`origin_host_id` text NOT NULL,\n\t`hlc` text NOT NULL,\n\t`rev` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\t`household_id` text NOT NULL,\n\t`cat_id` text NOT NULL,\n\t`epoch` integer NOT NULL,\n\t`grant_id` text NOT NULL,\n\t`profile` text NOT NULL,\n\t`snapshot` text,\n\t`observed_at` integer,\n\tFOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`cat_id`) REFERENCES `world_cats`(`id`) ON UPDATE no action ON DELETE no action\n);\n",
      "\nCREATE UNIQUE INDEX `world_state_publication` ON `world_states` (`household_id`,`epoch`);"
    ],
    "bps": true,
    "folderMillis": 1795306043401,
    "hash": "5b72a7968de84d8d7fd883f19983fd5ca3082f6ab2b7739a5c06c910e577b30f"
  },
  {
    "sql": [
      "CREATE TABLE `cat_facts` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`origin_host_id` text NOT NULL,\n\t`hlc` text NOT NULL,\n\t`rev` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`deleted_at` integer,\n\t`household_id` text NOT NULL,\n\t`cat_id` text NOT NULL,\n\t`epoch` integer NOT NULL,\n\t`grant_id` text NOT NULL,\n\t`kind` text NOT NULL,\n\t`business_key` text NOT NULL,\n\t`fact` text NOT NULL,\n\tFOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`cat_id`) REFERENCES `world_cats`(`id`) ON UPDATE no action ON DELETE no action\n);\n",
      "\nCREATE UNIQUE INDEX `cat_facts_business` ON `cat_facts` (`cat_id`,`kind`,`business_key`);",
      "\nCREATE INDEX `cat_facts_publication` ON `cat_facts` (`household_id`,`epoch`);"
    ],
    "bps": true,
    "folderMillis": 1795307693958,
    "hash": "cdb119b31a101851818e95fd614322756348e0d0e918bcce8f3b81f984d4b854"
  }
];
