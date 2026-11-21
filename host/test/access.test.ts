import { expect, test } from "bun:test";
import { AccessDeniedError, assertCan, can, canWriteAs } from "../src/identity/access.ts";
import type { Actor } from "../src/identity/index.ts";

const actor: Actor = { memberId: "甲", deviceId: "device", hostId: "host", householdId: "家" };

test("同家庭可读伴侣成员资源，不构成两人间隐私边界；不同家庭拒绝", () => {
  expect(can(actor, { householdId: "家" })).toBe(true);
  expect(can(actor, { householdId: "家", memberId: "乙" })).toBe(true);
  expect(can(actor, { householdId: "别家", memberId: "甲" })).toBe(false);
  expect(() => assertCan(actor, { householdId: "别家" })).toThrow(AccessDeniedError);
  expect(() => assertCan(actor, { householdId: "家", memberId: "乙" })).not.toThrow();
});

test("只允许以自己的成员身份写入，不能冒充伴侣", () => {
  expect(canWriteAs(actor, "甲")).toBe(true);
  expect(canWriteAs(actor, "乙")).toBe(false);
  expect(canWriteAs(actor, "")).toBe(false);
});
