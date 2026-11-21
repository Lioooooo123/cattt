export interface Hlc {
  readonly physicalMs: number;
  readonly logical: number;
  readonly nodeId: string;
}

export const MAX_PHYSICAL_MS = 0xffffffffffff;
export const MAX_LOGICAL = 0xffffffff;

export function validateWallMs(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_PHYSICAL_MS) {
    throw new RangeError("时间必须是 48 位非负整数毫秒");
  }
}

export function validateHlc(value: Hlc): void {
  validateWallMs(value.physicalMs);
  if (!Number.isInteger(value.logical) || value.logical < 0 || value.logical > MAX_LOGICAL) {
    throw new RangeError("HLC 逻辑计数超出范围");
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value.nodeId)) {
    throw new TypeError("节点标识须为 1 至 64 位字母、数字、下划线或连字符");
  }
}

export function compareHlc(left: Hlc, right: Hlc): number {
  validateHlc(left);
  validateHlc(right);
  return Math.sign(left.physicalMs - right.physicalMs)
    || Math.sign(left.logical - right.logical)
    || (left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0);
}

export function encodeHlc(value: Hlc): string {
  validateHlc(value);
  const physical = value.physicalMs.toString(16).padStart(12, "0");
  const logical = value.logical.toString(16).padStart(8, "0");
  return `${physical}-${logical}-${value.nodeId}`;
}

export function parseHlc(encoded: string): Hlc {
  if (!/^[0-9a-f]{12}-[0-9a-f]{8}-[A-Za-z0-9_-]{1,64}$/.test(encoded)) {
    throw new TypeError("无效的 HLC 编码");
  }
  const value: Hlc = {
    physicalMs: Number.parseInt(encoded.slice(0, 12), 16),
    logical: Number.parseInt(encoded.slice(13, 21), 16),
    nodeId: encoded.slice(22),
  };
  validateHlc(value);
  if (encodeHlc(value) !== encoded) {
    throw new TypeError("无效的 HLC 编码");
  }
  return value;
}
