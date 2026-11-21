import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gateway } from "../src/gateway/index.ts";
import { startHost } from "../src/runtime/index.ts";

interface Joined {
  member: { id: string; display_name: string; household_id: string };
  device_id: string;
  device_token: string;
  household: { id: string };
}

for (const maxMembers of [2, 3]) {
  test(`真实回环与 HTTPS 完成首成员、配对、邀请、双成员身份及移除（上限 ${maxMembers}）`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "cattt-invites-"));
    const gateway = new Gateway({ lanPort: 0, tls: { ips: () => [], hostname: "test" } });
    const host = await startHost({ dataDir: directory, port: 0, maxMembers }, [gateway]);
    const ca = readFileSync(join(directory, "tls/ca.crt"), "utf8");
    const adminToken = readFileSync(join(directory, "host-admin.token"), "utf8");
    const http = `http://127.0.0.1:${gateway.port}`;
    const https = `https://127.0.0.1:${gateway.lanPort}`;
    const admin = (path: string, method = "GET", body?: unknown) => fetch(http + path, {
      method, headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const phone = (path: string, method = "GET", body?: unknown, token?: string) => fetch(https + path, {
      method, tls: { ca }, headers: {
        "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}),
      }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const accept = async (code: string, displayName: string) => {
      const response = await phone("/v2/invites/accept", "POST", { code, display_name: displayName, device_name: "手机" });
      expect(response.status).toBe(200);
      return await response.json() as Joined;
    };
    try {
      expect((await fetch(http + "/host/members", { method: "POST", body: "{}" })).status).toBe(401);
      expect((await phone("/host/invites", "POST", {})).status).toBe(404);
      expect((await phone("/v2/healthz")).status).toBe(200);
      expect((await admin("/host/members", "POST", { display_name: " " })).status).toBe(400);
      const created = await admin("/host/members", "POST", { display_name: "甲" });
      expect(created.status).toBe(200);
      const firstId = (await created.json() as { member: { id: string } }).member.id;
      expect((await admin("/host/members", "POST", { display_name: "乙" })).status).toBe(409);
      const pairedCode = await (await admin("/host/pairing-codes", "POST", { member_id: firstId })).json() as { code: string };
      const first = await (await phone("/v2/pair", "POST", { code: pairedCode.code, device_name: "甲手机" })).json() as Joined;
      expect(first.member.id).toBe(firstId);
      expect((await phone("/v2/invites", "POST", {})).status).toBe(401);
      const issued = await phone("/v2/invites", "POST", { display_name: "建议乙" }, first.device_token);
      expect(issued.status).toBe(200);
      const invite = await issued.json() as { invite_id: string; code: string; invite_url: string; expires_at: number };
      const url = new URL(invite.invite_url);
      expect(url.protocol).toBe("maomao:");
      expect(url.hostname).toBe("invite");
      expect(url.searchParams.get("v")).toBe("2");
      expect(url.searchParams.get("h")).toBe("test.local");
      expect(url.searchParams.get("p")).toBe(String(gateway.lanPort));
      expect(url.searchParams.get("c")).toBe(invite.code.replace(/-/g, ""));
      const status = await (await admin("/host/status")).json() as { ca_fingerprint: string };
      expect(url.searchParams.get("fp")).toBe(status.ca_fingerprint);
      expect((await phone("/v2/invites/accept", "POST", { code: "IIIIIIII", display_name: "乙", device_name: "手机" })).status).toBe(400);
      const second = await accept(invite.code.toLowerCase(), "乙");
      expect(second.member.id).not.toBe(first.member.id);
      expect(second.household.id).toBe(first.household.id);
      for (const joined of [first, second]) {
        const me = await phone("/v2/me", "GET", undefined, joined.device_token);
        expect(await me.json()).toMatchObject({
          actor: { member_id: joined.member.id, household_id: host.householdId }, member: { id: joined.member.id },
        });
        const list = await phone("/v2/members", "GET", undefined, joined.device_token);
        expect((await list.json() as { members: { id: string }[] }).members.map((member) => member.id))
          .toEqual([first.member.id, second.member.id]);
      }
      const reused = await phone("/v2/invites/accept", "POST", { code: invite.code, display_name: "重复", device_name: "手机" });
      expect(reused.status).toBe(401);
      expect(await reused.json()).toEqual({ error: { code: "invite_code_invalid" } });
      if (maxMembers === 3) {
        const own = await (await phone("/v2/invites", "POST", {}, first.device_token)).json() as { invite_id: string };
        expect((await phone(`/v2/invites/${own.invite_id}`, "DELETE", undefined, second.device_token)).status).toBe(403);
        expect((await phone(`/v2/invites/${own.invite_id}`, "DELETE", undefined, first.device_token)).status).toBe(200);
        const pending = await (await admin("/host/invites", "POST")).json() as { invite_id: string; code: string };
        expect((await phone(`/v2/invites/${pending.invite_id}`, "DELETE", undefined, first.device_token)).status).toBe(403);
        expect((await admin(`/host/invites/${pending.invite_id}`, "DELETE")).status).toBe(200);
        expect((await phone("/v2/invites/accept", "POST", { code: pending.code, display_name: "丙", device_name: "手机" })).status).toBe(401);
        const thirdInvite = await (await admin("/host/invites", "POST")).json() as { code: string };
        const third = await accept(thirdInvite.code, "丙");
        expect(third.household.id).toBe(first.household.id);
      }
      for (const response of [
        await phone("/v2/invites", "POST", {}, first.device_token),
        await admin("/host/invites", "POST"),
      ]) {
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ error: { code: "member_limit" } });
      }
      const stalePair = await (await admin("/host/pairing-codes", "POST", { member_id: second.member.id })).json() as { code: string };
      expect((await phone(`/v2/members/${second.member.id}`, "DELETE", undefined, first.device_token)).status).toBe(404);
      expect((await admin(`/host/members/${second.member.id}`, "DELETE")).status).toBe(200);
      expect((await phone("/v2/me", "GET", undefined, second.device_token)).status).toBe(401);
      expect((await phone("/v2/me", "GET", undefined, first.device_token)).status).toBe(200);
      expect((await phone("/v2/pair", "POST", { code: stalePair.code, device_name: "失效" })).status).toBe(401);
      const adminInvite = await admin("/host/invites", "POST");
      expect(adminInvite.status).toBe(200);
      const replacement = await accept((await adminInvite.json() as { code: string }).code, "新成员");
      expect(replacement.member.id).not.toBe(second.member.id);
      expect(replacement.household.id).toBe(first.household.id);
    } finally {
      await host.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
