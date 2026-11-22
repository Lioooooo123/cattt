import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";

const version = "v1";
const nonceLength = 12;
const tagLength = 16;
export const memberCursorFormat = /^v[1-9]\d{0,2}\.[A-Za-z0-9_-]{40,200}$/;

const position = z.object({
  after: z.int().nonnegative(),
  through: z.int().nonnegative().nullable(),
  opening: z.boolean(),
}).strict().refine(({ after, through, opening }) => through === null ? !opening : after < through);

export type MemberChangePosition = z.infer<typeof position>;

interface Scope {
  householdId: string;
  memberId: string;
  hostId: string;
  generation: string;
}

export function memberCursorCodec(key: Buffer, scope: Scope) {
  const binding = Buffer.from(JSON.stringify([
    "cattt:member-changes:" + version, scope.hostId, scope.householdId, scope.memberId, scope.generation,
  ]));

  return {
    seal(value: MemberChangePosition) {
      const nonce = randomBytes(nonceLength);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(binding);
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
      return version + "." + Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64url");
    },
    open(cursor: string): MemberChangePosition | undefined {
      const [prefix, encoded] = cursor.split(".");
      if (prefix !== version || !encoded) {
        return undefined;
      }
      const bytes = Buffer.from(encoded, "base64url");
      if (bytes.toString("base64url") !== encoded || bytes.length <= nonceLength + tagLength) {
        return undefined;
      }
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, nonceLength));
        decipher.setAAD(binding);
        decipher.setAuthTag(bytes.subarray(nonceLength, nonceLength + tagLength));
        const raw = Buffer.concat([decipher.update(bytes.subarray(nonceLength + tagLength)), decipher.final()]);
        const parsed = position.safeParse(JSON.parse(raw.toString("utf8")));
        return parsed.success ? parsed.data : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
