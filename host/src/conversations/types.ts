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
