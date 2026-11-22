export interface Message {
  id: string;
  conversation_id: string;
  cursor: string;
  author: { kind: "member"; member_id: string } | { kind: "cat" };
  text: string;
  modality: "text";
  status: "complete" | "stopped";
  client_message_id: string | null;
  reply_to_message_id: string | null;
  turn_id: string | null;
  created_at: number;
}

export interface Conversation {
  id: string;
  kind: "group" | "direct";
  owner_member_id: string | null;
  participant_member_ids: string[];
  publisher_host_id: string;
  created_at: number;
  last_message: Message | null;
}

export interface MessagePage {
  messages: Message[];
  has_more_before: boolean;
  has_more_after: boolean;
}

export interface Turn {
  id: string;
  conversation_id: string;
  status: "queued" | "generating" | "completed" | "stopped" | "superseded" | "failed";
  trigger_message_id: string;
  reply_message_id: string | null;
  error_code: string | null;
  stream_url: string;
}

export interface PendingGroupSend {
  status: "pending";
  request_id: string;
  client_message_id: string;
  reason: "publication_pending" | "peer_pending" | "replication_pending";
  receipt_url: string;
}

export type GroupSendReceipt =
  | {
    status: "accepted";
    request_id: string;
    client_message_id: string;
    publisher_host_id: string;
    message: Message;
    turn: Turn | null;
  }
  | {
    status: "rejected";
    request_id: string;
    client_message_id: string;
    error: { code: "group_send_rejected" };
  };
