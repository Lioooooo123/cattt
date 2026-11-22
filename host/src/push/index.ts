import type { PublicationPushAdapter } from "../router/types.ts";
import type { HostContext } from "../runtime/index.ts";
import { preparePushDevice, publicationPushDevices, settlePushDevice } from "../store/publication-push.ts";

export function createPublicationPush(ctx: HostContext): PublicationPushAdapter | undefined {
  const apns = ctx.config.apns;
  if (!apns) return;
  return async (intent, signal) => {
    let retryAt = Infinity;
    let sent = false;
    let uncertain = false;
    for (const delivery of publicationPushDevices(ctx, intent.id, apns.topic)) {
      if (delivery.status === "sent") sent = true;
      if (delivery.status === "uncertain") uncertain = true;
      if (delivery.status !== "pending") continue;
      signal.throwIfAborted();
      const request = preparePushDevice(ctx, delivery, apns.topic);
      if (typeof request === "number") {
        retryAt = Math.min(retryAt, request);
        continue;
      }
      if (!request) continue;
      const startedAt = ctx.clock.wallMs();
      try {
        const response = await apns.send(request, signal);
        if (response.status === 200) {
          settlePushDevice(ctx, delivery, "sent");
          sent = true;
        } else if (response.status === 410 || response.reason === "BadDeviceToken" || response.reason === "DeviceTokenNotForTopic") {
          settlePushDevice(ctx, delivery, "dropped", response.timestamp ?? startedAt);
        } else if (response.status === 429 || response.status >= 500) {
          settlePushDevice(ctx, delivery, "pending");
          retryAt = Math.min(retryAt, ctx.clock.wallMs() + 60_000);
        } else {
          settlePushDevice(ctx, delivery, "dropped");
        }
      } catch {
        settlePushDevice(ctx, delivery, "uncertain");
        uncertain = true;
      }
    }
    if (Number.isFinite(retryAt)) return { retryAt };
    return uncertain ? "uncertain" : sent ? "sent" : "dropped";
  };
}
