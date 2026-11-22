import "reflect-metadata";
import { ChatEventSweeper } from "../chat-events/index.ts";
import { assessKnowledgeUse } from "../context/policy.ts";
import type { KnowledgeEvidence } from "../context/policy.ts";
import { GroupSends } from "../group-sends/index.ts";
import { PeerBehaviorChannel } from "../peer-behavior/index.ts";
import { Gateway } from "../gateway/index.ts";
import { JobRunner } from "../jobs/index.ts";
import { extractSpec, modelConfigFromEnv } from "../llm/config.ts";
import { registerMemoryExtraction } from "../memory/jobs.ts";
import { RelayService } from "../relay/index.ts";
import { registerCatDiaryPublisher } from "../router/cat-diary.ts";
import { ReportRouter } from "../router/index.ts";
import { quietGroupReply, readConversationScope } from "../store/conversations.ts";
import { readKnowledgeSource } from "../store/knowledge-source.ts";
import { readProactivePermission } from "../store/proactive-permission.ts";
import { registerTicketWorkers, TicketQueueAdmission } from "../ticket-workers/index.ts";
import { TurnRunner } from "../turns/index.ts";
import { registerMemoryActions } from "../member-resources/memory-actions.ts";
import { CatDiaryCalendar, registerCatDiary } from "../soul/daily-diary.ts";
import { startHost } from "./index.ts";
import type { HostConfig } from "./index.ts";

export function startConfiguredHost(
  config: HostConfig, gateway = new Gateway(), routerOptions?: ConstructorParameters<typeof ReportRouter>[0],
) {
  const jobs = new JobRunner();
  const model = config.model ?? modelConfigFromEnv({});
  if (extractSpec(model).model) {
    registerMemoryExtraction(jobs);
  }
  registerTicketWorkers(jobs);
  registerCatDiary(jobs);
  registerCatDiaryPublisher(jobs);
  const transport = () => gateway.peerTransport;
  const channel = new PeerBehaviorChannel(transport);
  registerMemoryActions(channel);
  channel.registerDelivery(jobs);
  const groupSends = new GroupSends(channel, quietGroupReply);
  gateway.attachBehavior(channel, groupSends);
  const merged: HostConfig = {
    ...config, model,
    relay: new RelayService(transport, jobs, channel),
    ticketAdmission: {
      readKnowledgeSource,
      allowsTopic(db, { householdId, memberId, conversationId, text }) {
        const scope = readConversationScope(db, conversationId);
        return scope?.householdId === householdId && scope.participantMemberIds.includes(memberId)
          && assessKnowledgeUse(db, { householdId, audienceMemberIds: scope.participantMemberIds, evidence: [], text }) === "allowed";
      },
      timeZone(db, actor) {
        const pref = readProactivePermission(db, actor.memberId);
        return pref.revision ? pref.timeZone : undefined;
      },
      publicationTimeZone(db, actor) {
        const pref = readProactivePermission(db, actor.memberId);
        return pref.revision ? pref.timeZone : undefined;
      },
      ...config.ticketAdmission,
    },
    ticketWorkerContext: config.ticketWorkerContext ?? {
      prepare: () => ({}),
      permits(db, ticket, dependencies) {
        const scope = readConversationScope(db, ticket.conversationId);
        if (!scope || scope.householdId !== ticket.householdId || !scope.participantMemberIds.includes(ticket.forMemberId)) {
          return false;
        }
        const evidence: KnowledgeEvidence[] = [];
        for (const item of dependencies) {
          if (item.kind === "memory" || item.kind === "diary") {
            evidence.push({ kind: item.kind, id: item.id, rev: item.revision });
          } else if (item.kind === "message" && (!item.memberId || item.memberId === ticket.forMemberId)) {
            const proof = { householdId: ticket.householdId, sourceMemberId: ticket.forMemberId,
              sourceMessageId: item.id, sourceRevision: item.revision };
            if (readKnowledgeSource(db, proof)?.conversationId !== ticket.conversationId) { return false; }
            evidence.push({ kind: "message", ...proof });
          } else {
            return false;
          }
        }
        return assessKnowledgeUse(db, {
          householdId: ticket.householdId, audienceMemberIds: scope.participantMemberIds, evidence,
        }) === "allowed";
      },
    },
  };
  const business = [new ChatEventSweeper(), new TurnRunner(), new TicketQueueAdmission(), new ReportRouter(routerOptions)];
  const background = [groupSends, jobs, new CatDiaryCalendar()];
  const barrier = config.beforeBusiness && { name: "restore-validation", start: config.beforeBusiness, stop() {} };
  return startHost(merged, barrier
    ? [gateway, barrier, ...business, ...background]
    : [...business, gateway, ...background]);
}
