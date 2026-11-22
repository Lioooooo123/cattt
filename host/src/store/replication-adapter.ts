import { z } from "zod";
import { ReplicationError } from "../replication/types.ts";
import type { MissingReplicaDependency, ReplicatedRevision, ReplicationSource } from "../replication/types.ts";
import type { StoreDb } from "./index.ts";

export type ReplicationTx = Parameters<Parameters<StoreDb["transaction"]>[0]>[0];

export class MissingReplicationDependency extends Error {
  constructor(public readonly dependency: MissingReplicaDependency) {
    super(`等待复制依赖：${dependency.kind}/${dependency.id}`);
    this.name = "MissingReplicationDependency";
  }
}

export function requireReplicaDependency<Row>(row: Row | undefined, kind: string, id: string): Row {
  if (!row) {
    throw new MissingReplicationDependency({ kind, id });
  }
  return row;
}

export function assertReplicaWriter(condition: unknown): asserts condition {
  if (!condition) {
    throw new ReplicationError("unauthorized_writer", "来源宿主无权写入该聚合或其归属不匹配");
  }
}

export function assertReplicaIdentity(condition: unknown): asserts condition {
  if (!condition) {
    throw new ReplicationError("record_conflict", "复制记录的不可变身份或业务唯一键冲突");
  }
}

interface AdapterOptions<Row extends ReplicatedRevision> {
  read(tx: ReplicationTx, id: string): Row | undefined;
  snapshotRows(tx: ReplicationTx, source: ReplicationSource, limit: number): Row[];
  write(tx: ReplicationTx, row: Row): void | boolean;
  authorize(tx: ReplicationTx, source: ReplicationSource, row: Row): void;
  identity(row: Row): readonly unknown[];
  sealed?: (tx: ReplicationTx, row: Row) => boolean;
  fact?: (row: Row) => readonly unknown[];
  equalRevisionOrder?: (next: Row, current: Row) => number;
}

function comparesAfter<Row extends ReplicatedRevision>(
  next: Row, current: Row, equalRevisionOrder?: AdapterOptions<Row>["equalRevisionOrder"],
): boolean {
  if ((next.deletedAt === null) !== (current.deletedAt === null)) {
    return next.deletedAt !== null;
  }
  if (next.rev !== current.rev) {
    return next.rev > current.rev;
  }
  const order = equalRevisionOrder?.(next, current) ?? 0;
  if (order !== 0) {
    return order > 0;
  }
  if (next.hlc !== current.hlc) {
    return next.hlc > current.hlc;
  }
  // Parsed objects use the schema's field order. This also settles equal-HLC forks.
  return JSON.stringify(next) > JSON.stringify(current);
}

export function defineReplicationAdapter<
  const Kind extends string,
  Shape extends z.ZodRawShape,
  Row extends ReplicatedRevision & z.infer<z.ZodObject<Shape>>,
>(
  kind: Kind, schema: z.ZodObject<Shape>, options: AdapterOptions<Row>,
) {
  const projection = z.object(schema.shape);

  function parse(input: unknown, validator: z.ZodType): Row {
    const result = validator.safeParse(input);
    if (!result.success) {
      throw new ReplicationError("invalid_record", `复制记录字段无效：${kind}`);
    }
    return result.data as Row;
  }

  function project(source: ReplicationSource, tx: ReplicationTx, input: Row) {
    const row = parse(input, projection);
    options.authorize(tx, source, row);
    return { kind, row };
  }

  return {
    kind,
    decode(input: unknown) {
      return { kind, row: parse(input, schema) };
    },
    project,
    snapshot(source: ReplicationSource, tx: ReplicationTx, limit: number) {
      return options.snapshotRows(tx, source, limit).map((row) => project(source, tx, row));
    },
    apply(tx: ReplicationTx, source: ReplicationSource, input: unknown): boolean {
      const row = parse(input, schema);
      options.authorize(tx, source, row);
      const existing = options.read(tx, row.id);
      const sealed = options.sealed?.(tx, row);
      if (existing) {
        const current = parse(existing, projection);
        assertReplicaIdentity(row.originHostId === current.originHostId && row.createdAt === current.createdAt
          && JSON.stringify(options.identity(row)) === JSON.stringify(options.identity(current)));
        if (sealed) {
          // An already sealed generation can replay its final fact or an earlier revision.
          assertReplicaWriter(JSON.stringify(row) === JSON.stringify(current)
            || (!comparesAfter(row, current) && (row.rev < current.rev
              || (row.rev === current.rev && row.deletedAt === null && current.deletedAt !== null))));
          return false;
        }
        if (options.fact && current.deletedAt === null && row.deletedAt === null) {
          assertReplicaIdentity(JSON.stringify(options.fact(row)) === JSON.stringify(options.fact(current)));
        }
        if (!comparesAfter(row, current, options.equalRevisionOrder)) {
          return false;
        }
      }
      assertReplicaWriter(!sealed);
      return options.write(tx, row) !== false;
    },
  };
}
