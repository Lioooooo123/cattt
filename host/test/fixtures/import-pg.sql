INSERT INTO users (id, name, host_owner, time_zone, dev_token_hash, created_at) VALUES
 ('10000000-0000-4000-8000-000000000001', '旧账号', true, 'Asia/Kuala_Lumpur', 'must-not-copy-dev-token', '2025-01-01Z'),
 ('10000000-0000-4000-8000-000000000002', '旁人', false, 'Asia/Shanghai', null, '2025-01-01Z');
INSERT INTO cats (id, user_id, name, appearance, temperament, traits, created_at, updated_at) VALUES
 ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '团子', 'orange', 'quiet', '{}', '2025-01-01Z', '2025-01-01Z'),
 ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', '旁人的猫', 'orange', 'quiet', '{}', '2025-01-01Z', '2025-01-01Z');
INSERT INTO conversations (id, cat_id, version, created_at) VALUES
 ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 3, '2025-01-01Z'),
 ('30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 1, '2025-01-01Z');
INSERT INTO messages (id, conversation_id, role, text, context_allowed, memory_eligible, created_at) VALUES
 ('40000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'user', '记住我喜欢乌龙茶', true, true, '2025-01-03Z'),
 ('40000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000001', 'cat', '我记住了', true, true, '2025-01-02Z'),
 ('40000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000001', 'user', '已经撤回的秘密', false, false, '2025-01-03Z'),
 ('40000000-0000-4000-8000-000000000004', '30000000-0000-4000-8000-000000000001', 'user', '帮我整理面试，下周接着聊', true, true, '2025-01-04Z'),
 ('40000000-0000-4000-8000-000000000005', '30000000-0000-4000-8000-000000000002', 'user', '旁人的原话', true, true, '2025-01-04Z'),
 ('40000000-0000-4000-8000-000000000006', '30000000-0000-4000-8000-000000000001', 'cat', '整理好的结果', true, true, '2025-01-05Z'),
 ('40000000-0000-4000-8000-000000000007', '30000000-0000-4000-8000-000000000001', 'cat', '复述过撤回的秘密', false, false, '2025-01-06Z');
INSERT INTO memories
 (id, cat_id, subject, predicate, value, confidence, sensitivity, status, fingerprint, source_message_id, extractor_version, created_at, last_confirmed_at)
VALUES
 ('50000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '用户', '喜欢的茶', '乌龙茶', 1, 'low', 'active', 'old-tea', '40000000-0000-4000-8000-000000000001', 'example', '2025-01-03Z', '2025-01-03Z'),
 ('50000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', '用户', '撤回的事实', '绝密', 1, 'low', 'active', 'old-secret', '40000000-0000-4000-8000-000000000003', 'example', '2025-01-03Z', '2025-01-03Z'),
 ('50000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000001', '用户', '越权内容', '无效', 1, 'low', 'active', 'old-cross-owner', '40000000-0000-4000-8000-000000000005', 'example', '2025-01-03Z', '2025-01-03Z'),
 ('50000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000001', '用户的妈妈', '喜欢的茶', '红茶', 1, 'low', 'active', 'old-other', '40000000-0000-4000-8000-000000000001', 'example', '2025-01-03Z', '2025-01-03Z');
INSERT INTO memory_blocks (id, cat_id, fingerprint, source_seq, created_at) VALUES
 ('51000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'unknown-prior-aspect', 3, '2025-01-04Z');
INSERT INTO memory_receipts (cat_id, source_message_id, fingerprint, accepted)
 VALUES ('20000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000003','unknown-prior-aspect',false);
INSERT INTO boundaries (id, cat_id, source_message_id, description, created_at)
 VALUES ('52000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000004','不要提旧测验','2025-01-04Z');
INSERT INTO diary_entries
 (id, cat_id, client_id, kind, text, recorded_at, time_zone, day, time, cat_allowed, revision, mutation_id, created_at, updated_at)
VALUES
 ('60000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','text-1','text','这是私人日记','2025-01-03T18:00:00Z','Asia/Kuala_Lumpur','2025-01-04','02:00',false,3,gen_random_uuid(),'2025-01-03Z','2025-01-04Z'),
 ('60000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001','cat-1','cat','团子的院子日记','2025-01-04Z','Asia/Kuala_Lumpur','2025-01-04','08:00',false,1,gen_random_uuid(),'2025-01-04Z','2025-01-04Z');
INSERT INTO tickets (id, cat_id, kind, goal, mandate, status, stage, due_at, time_zone, source_message_id, ended_reason, created_at, updated_at)
VALUES
 ('70000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','errand','整理面试','{"kind":"explicit","source_message_id":"40000000-0000-4000-8000-000000000004"}','ended','delivered',null,'Asia/Kuala_Lumpur','40000000-0000-4000-8000-000000000004','delivered','2025-01-04Z','2025-01-05Z'),
 ('70000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001','followup','下周接着聊','{"kind":"explicit","source_message_id":"40000000-0000-4000-8000-000000000004"}','open','scheduled','2025-01-07Z','Asia/Kuala_Lumpur','40000000-0000-4000-8000-000000000004',null,'2025-01-04Z','2025-01-04Z'),
 ('70000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000001','errand','等待处理的旧托付','{"kind":"explicit","source_message_id":"40000000-0000-4000-8000-000000000004"}','open','queued',null,'Asia/Kuala_Lumpur','40000000-0000-4000-8000-000000000004',null,'2025-01-04Z','2025-01-04Z');
UPDATE messages SET ticket_id = '70000000-0000-4000-8000-000000000001'
 WHERE id = '40000000-0000-4000-8000-000000000006';
INSERT INTO outbox (id, cat_id, ticket_id, purpose, kind, status, created_at) VALUES
 ('71000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000001','errand','chat_message','sent','2025-01-05Z'),
 ('71000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000001','reminder','push','pending','2025-01-05Z');
INSERT INTO mailbox_letters (id, cat_id, ticket_id, text, created_at, read_at) VALUES
 ('72000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000001','旧信箱里的结果','2025-01-05Z','2025-01-06Z');
INSERT INTO runs (id, ticket_id, generation, local_day, status, attempt, output_tokens, elapsed_ms, created_at) VALUES
 ('73000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000001',2,'2025-01-04','ended',1,23,125,'2025-01-04Z'),
 ('73000000-0000-4000-8000-000000000002','70000000-0000-4000-8000-000000000003',0,null,'pending',0,0,0,'2025-01-04Z');
INSERT INTO run_steps (id, run_id, step, messages, usage, finished_at) VALUES
 ('74000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000001',1,'[{"role":"user","content":"历史执行输入"},{"role":"assistant","content":"历史执行结果"}]','{"outputTokens":23}','2025-01-04Z');
INSERT INTO paired_devices (user_id, name, token_hash) VALUES
 ('10000000-0000-4000-8000-000000000001','旧手机','must-not-copy-device-token');

INSERT INTO triggers (id, cat_id, source, idempotency_key, payload, received_at) VALUES (
 '75000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','chat','fixture-old-command',
 jsonb_build_object('message_id','40000000-0000-4000-8000-000000000004','ticket_id','70000000-0000-4000-8000-000000000001',
 'command',jsonb_build_object('kind','start','fingerprint',repeat('a',64)),
 'receipt',jsonb_build_object('ticket_id','70000000-0000-4000-8000-000000000001','queued',false)), '2025-01-04Z');
INSERT INTO decisions (trigger_id, outcome, reasons, ticket_id, created_at) VALUES (
 '75000000-0000-4000-8000-000000000001','accept','["用户明确托付"]','70000000-0000-4000-8000-000000000001','2025-01-04Z');

INSERT INTO world_sessions (cat_id, state_version, snapshot, observed_at, online_until)
VALUES ('20000000-0000-4000-8000-000000000001', 17,
 '{"stateVersion":17,"sceneVersion":4,"destinationIds":["house","tree","bed","grass","pond","fence"],
   "currentDestinationId":"pond","targetDestinationId":"tree","phase":"moving","action":"walk",
   "paused":false,"runnable":true,"mood":"happy","bowlFilledToday":true,
   "lastDrinkAt":"2025-01-06T12:00:00Z","placesToday":["池塘"]}', '2025-01-06T12:05:00Z', '2025-01-06T12:05:03Z');

INSERT INTO soul_versions (cat_id, version, persona_version, entries, markdown, reason, created_at) VALUES (
 '20000000-0000-4000-8000-000000000001', 3, 1,
 '[{"id":"80000000-0000-4000-8000-000000000001","sourceMessageId":"40000000-0000-4000-8000-000000000001","status":"active","kind":"response_length","value":"brief","createdAt":"2025-01-05T00:00:00Z","reason":"明确习惯"},
   {"id":"80000000-0000-4000-8000-000000000002","sourceMessageId":"40000000-0000-4000-8000-000000000003","status":"active","kind":"advice","value":"ask_first","createdAt":"2025-01-05T00:00:00Z","reason":"来源已撤回"}]',
 '旧文本', '明确习惯', '2025-01-05Z');

INSERT INTO cat_runtime_states (cat_id, version, state) VALUES (
 '20000000-0000-4000-8000-000000000001', 1,
 '{"sourceMessageId":"40000000-0000-4000-8000-000000000001","energy":"resting","willingness":"quiet",
   "observedAt":"2025-01-05T00:00:00Z","expiresAt":"2025-01-05T01:00:00Z"}');
INSERT INTO cat_runtime_events (cat_id, source_message_id, state, created_at)
 SELECT cat_id, '40000000-0000-4000-8000-000000000001', state, '2025-01-05Z'
 FROM cat_runtime_states WHERE cat_id = '20000000-0000-4000-8000-000000000001';
