import { SQL } from "bun";
import { z } from "zod";
import { sha256 } from "./values.ts";

// All interpolation in unsafe() below comes from this fixed catalog. The
// three selected legacy identities are always bound parameters.
const byUser = "t.user_id = $1::uuid";
const byCat = "t.cat_id = $2::uuid";
const byConversation = "t.conversation_id = $3::uuid";
const byTicket = "EXISTS (SELECT FROM public.tickets k WHERE k.id = t.ticket_id AND k.cat_id = $2::uuid)";
const byTurn = "EXISTS (SELECT FROM public.turns r WHERE r.id = t.turn_id AND r.conversation_id = $3::uuid)";
const byRun = "EXISTS (SELECT FROM public.runs r JOIN public.tickets k ON k.id = r.ticket_id WHERE r.id = t.run_id AND k.cat_id = $2::uuid)";
const byNotification = "EXISTS (SELECT FROM public.push_notifications n WHERE n.id = t.notification_id AND n.cat_id = $2::uuid)";
const skip = (scope: string, key = "t.id") => ({ scope, key, policy: "excluded" as const });
const legacy = (scope: string, key = "t.id", select = "to_jsonb(t)") => ({ scope, key, select, policy: "data" as const });
const sequence = (scope: string, select = "to_jsonb(t) || jsonb_build_object('seq', t.seq::text)") => ({ ...legacy(scope, "t.id", select), order: "t.seq" });
const catalog = {
  users: legacy("t.id = $1::uuid", "t.id", "jsonb_build_object('id', t.id, 'name', t.name, 'time_zone', t.time_zone, 'created_at', t.created_at, 'host_owner', t.host_owner)"),
  pairing_codes: skip("true", "null"),
  paired_devices: skip(byUser),
  cats: legacy(byUser),
  conversations: legacy(byCat),
  messages: sequence(byConversation),
  turns: legacy(byConversation),
  boundaries: legacy(byCat),
  memories: legacy(byCat),
  memory_blocks: legacy(byCat),
  memory_receipts: legacy(byCat, "t.source_message_id::text || ':' || t.fingerprint"),
  diary_entries: sequence(byCat, "to_jsonb(t) || jsonb_build_object('seq', t.seq::text, 'change_seq', t.change_seq::text)"),
  tickets: legacy(byCat),
  triggers: legacy(byCat),
  decisions: legacy("EXISTS (SELECT FROM public.triggers e WHERE e.id = t.trigger_id AND e.cat_id = $2::uuid)"),
  ticket_inputs: legacy(byTicket),
  runs: legacy(byTicket),
  run_steps: legacy(byRun),
  outbox: sequence(byCat),
  mailbox_letters: sequence(byCat),
  worker_reports: legacy(byCat),
  diary_facts: legacy(byCat),
  diary_calendars: legacy(byCat, "t.cat_id"),
  world_actions: legacy(byCat),
  world_sessions: legacy(byCat),
  cat_runtime_states: legacy(byCat, "t.cat_id"),
  personality_versions: legacy(byCat),
  cat_runtime_events: legacy(byCat),
  soul_versions: legacy(byCat),
  turn_soul_snapshots: legacy(byCat, "t.turn_id"),
  soul_blocked_sources: legacy(byCat, "t.cat_id::text || ':' || t.source_message_id::text"),
  runtime_calls: legacy(byTurn),
  runtime_steps: legacy(byTurn),
  model_calls: legacy(byTurn),
  model_admissions: skip("true", "null"),
  model_reservations: legacy(byUser),
  async_jobs: legacy("EXISTS (SELECT FROM public.cats c WHERE c.id = $2::uuid AND (t.object_id = c.id OR t.source_id = c.id))"
    + " OR EXISTS (SELECT FROM public.turns r WHERE r.conversation_id = $3::uuid AND (r.id = t.source_id OR r.id = t.object_id))"
    + " OR EXISTS (SELECT FROM public.diary_entries d WHERE d.cat_id = $2::uuid AND (d.id = t.source_id OR d.id = t.object_id))"
    + " OR EXISTS (SELECT FROM public.tickets k WHERE k.cat_id = $2::uuid AND (k.id = t.source_id OR k.id = t.object_id))"
    + " OR EXISTS (SELECT FROM public.messages m WHERE m.conversation_id = $3::uuid AND (m.id = t.source_id OR m.id = t.object_id))"
    + " OR EXISTS (SELECT FROM public.boundaries b WHERE b.cat_id = $2::uuid AND (b.id = t.source_id OR b.id = t.object_id))"),
  devices: skip(byUser),
  push_notifications: legacy(byCat, "t.id", "to_jsonb(t) - 'payload' - 'proof'"),
  push_deliveries: legacy(byNotification, "t.id", "to_jsonb(t) - 'device_id' - 'apns_id'"),
  push_budget_reservations: legacy(byCat),
  proactive_rules: legacy("true"),
  inference_watches: legacy(byCat),
  inference_observations: legacy(byCat),
  inferred_publications: legacy(byCat),
  turn_events: legacy(byTurn, "t.turn_id::text || ':' || t.seq::text"),
  turn_controls: legacy(byTurn, "t.turn_id"),
  conversation_locks: skip(byConversation, "null"),
};

export type SourceTable = keyof typeof catalog;
export type LegacyRow = { key: string; json: string; data: Record<string, unknown> };
export type SourceRows = { rows: LegacyRow[]; sourceCount: number; outsideScope: number; sourceSha256: string; excluded: boolean };
export type PgSnapshot = {
  userId: string;
  catId: string | null;
  conversationId: string | null;
  tables: Record<SourceTable, SourceRows>;
  sourceSha256: string;
};

export class ImportError extends Error {}

function pgUrl(value: string) {
  const url = URL.parse(value);
  if (!url || !["postgres:", "postgresql:"].includes(url.protocol)
    || !url.hostname || !url.port || !url.username || !/^\/[^/]+$/.test(url.pathname) || url.hash
    || [...url.searchParams.keys()].some((key) => key !== "sslmode")
    || url.searchParams.getAll("sslmode").length > 1) {
    throw new ImportError("CATTT_IMPORT_PG_URL 须明确指定 PostgreSQL 主机、端口、账号及数据库，可选 sslmode");
  }
  return url;
}

export async function readPgSnapshot(value: string, selectedUserId?: string): Promise<PgSnapshot> {
  const url = pgUrl(value);
  if (selectedUserId !== undefined && !z.uuid().safeParse(selectedUserId).success) {
    throw new ImportError("--legacy-user-id 须为 PostgreSQL 用户 UUID");
  }
  const client = new SQL({ url: url.toString(), adapter: "postgres", max: 1, connectionTimeout: 5, prepare: false });
  let operation = "建立只读事务";
  try {
    return await client.begin("ISOLATION LEVEL REPEATABLE READ READ ONLY", async (pg) => {
      await pg`SET LOCAL search_path TO pg_catalog`;
      await pg`SET LOCAL TIME ZONE 'UTC'`;
      const [mode] = await pg<{ read_only: string; isolation: string }[]>`
        SELECT current_setting('transaction_read_only') AS read_only, current_setting('transaction_isolation') AS isolation
      `;
      if (mode?.read_only !== "on" || mode.isolation !== "repeatable read") throw new ImportError("PG 未进入一致的只读事务");
      operation = "确定旧账号";
      const candidates = await pg<{ id: string; host_owner: boolean }[]>`
        SELECT id, host_owner FROM public.users ORDER BY id
      `;
      const owner = selectedUserId === undefined
        ? (candidates.find((row) => row.host_owner) ?? (candidates.length === 1 ? candidates[0] : undefined))
        : candidates.find((row) => row.id === selectedUserId.toLowerCase());
      if (!owner) throw new ImportError("无法唯一确定 Han 的旧账号，请用 --legacy-user-id 指定");
      const [cat] = await pg<{ id: string }[]>`SELECT id FROM public.cats WHERE user_id = ${owner.id}::uuid`;
      const [conversation] = cat ? await pg<{ id: string }[]>`SELECT id FROM public.conversations WHERE cat_id = ${cat.id}::uuid` : [];
      const tables = {} as Record<SourceTable, SourceRows>;
      const identity = [owner.id, cat?.id ?? null, conversation?.id ?? null];
      for (const table of Object.keys(catalog) as SourceTable[]) {
        operation = table;
        const spec = catalog[table];
        // Referencing all three placeholders keeps binding identical when the
        // table has no natural owner (e.g. the global model admission queue).
        const selection = "WITH selected AS (SELECT $1::uuid, $2::uuid, $3::uuid)";
        const [counts] = await pg.unsafe<{ total: string; scoped: string }[]>(
          `${selection} SELECT count(*)::text AS total, count(*) FILTER (WHERE ${spec.scope})::text AS scoped FROM public.${table} t`, identity,
        );
        const sourceCount = Number(counts!.scoped);
        const outsideScope = Number(counts!.total) - sourceCount;
        const excluded = spec.policy === "excluded";
        const raw = excluded ? [] : await pg.unsafe<{ key: string; json: string }[]>(
          `${selection} SELECT (${spec.key})::text AS key, (${spec.select})::text AS json FROM public.${table} t WHERE ${spec.scope}
            ORDER BY ${"order" in spec ? spec.order + ", " : ""}(${spec.key})::text COLLATE "C"`, identity,
        );
        if (!excluded && raw.length !== sourceCount) throw new ImportError(`PG 表 ${table} 行数核对失败`);
        tables[table] = {
          sourceCount, outsideScope, excluded,
          sourceSha256: sha256(excluded ? ["count-only", sourceCount] : raw.map(({ key, json }) => [key, json])),
          rows: raw.map(({ key, json }) => ({ key, json, data: JSON.parse(json) })),
        };
      }
      const sourceSha256 = sha256([identity, Object.entries(tables).map(([name, row]) => [name, row.sourceSha256, row.outsideScope])]);
      return { userId: owner.id, catId: cat?.id ?? null, conversationId: conversation?.id ?? null, tables, sourceSha256 };
    });
  } catch (error) {
    if (error instanceof ImportError) throw error;
    // SQL errors can contain credentials, hostnames or customer data.
    const code = (error as { code?: string }).code;
    const state = code && /^(?:[A-Z0-9]{5}|ERR_[A-Z0-9_]+)$/.test(code) ? `（${code}）` : "";
    throw new ImportError(`读取 PG 快照失败：${operation}${state}`);
  } finally {
    await client.close({ timeout: 0 });
  }
}
