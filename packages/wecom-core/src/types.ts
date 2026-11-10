export type Platform = 'macos' | 'windows';
export type Phase = 'idle' | 'syncing' | 'ready' | 'paused' | 'retrying';

export interface Profile {
  id: string;
  name: string;
  platform: Platform;
  available: boolean;
  issue?: string;
}

export interface SyncState {
  phase: Phase;
  profile: string | null;
  revision: number;
  updatedAt: string | null;
  issues: string[];
  counts: { conversations: number; contacts: number; messages: number };
}

export type ContactScope = 'internal' | 'external' | 'unknown';
export type ContactFilter = 'all' | Exclude<ContactScope, 'unknown'>;

export interface Conversation {
  id: string;
  name: string;
  preview: string;
  previewSender?: string;
  time: number;
  count: number;
  unreadCount: number | null;
  muted: boolean;
  kind: 'group' | 'direct' | 'unknown';
  scope: ContactScope;
}

export type ConversationFilter = ContactFilter | 'group' | 'direct';
export type ReadFilter = 'all' | 'read' | 'unread';
export interface Contact {
  id: string;
  name: string;
  job: string;
  scope: ContactScope;
}

export type MessageKind = 'text' | 'image' | 'video' | 'voice' | 'file' | 'sticker' |
  'link' | 'location' | 'card' | 'forward' | 'system' | 'unknown';

export interface MessageDetail {
  name?: string;
  description?: string;
  url?: string;
  seconds?: number;
  bytes?: number;
  width?: number;
  height?: number;
  count?: number;
}

export interface MessagePart {
  text: string;
  placeholder: boolean;
  kind: MessageKind;
  detail?: MessageDetail;
  localMedia?: boolean;
  localPreview?: boolean;
}

export type Message = {
  id: string;
  sender: string;
  time: number;
  own: boolean;
} & (MessagePart | {kind: 'mixed'; text: string; placeholder: false; parts: MessagePart[]});

export interface Page<T> { items: T[]; more: boolean; total?: number }
export interface DatabaseExport {
  directory: string;
  files: string[];
  capturedAt: string;
}

export type Request =
  | { op: 'discover'; documents?: string; root?: string }
  | { op: 'select'; id: string }
  | { op: 'status' }
  | { op: 'pause'; paused: boolean }
  | { op: 'conversations'; search: string; offset: number; filter?: ConversationFilter; read?: ReadFilter }
  | { op: 'contacts'; search: string; offset: number; filter?: ContactFilter }
  | { op: 'contactConversations'; id: string }
  | { op: 'conversationAvatars'; profile: string; id: string }
  | { op: 'messages'; id: string; before?: string }
  | { op: 'contextConversations'; profile: string }
  | { op: 'contextProbe'; profiles: string[] }
  | { op: 'contextStatus' }
  | { op: 'contextScan'; profile: string; conversations: string[]; since: number; limit: number;
      snapshot?: string; known?: [string, string][] }
  | { op: 'contextPage'; profile: string; conversation: string; id: string; fingerprint: string; direction: 'before' | 'after'; limit: number; since: number; until?: number }
  | { op: 'contextRelated'; profile: string; conversation: string; id: string; fingerprint: string; limit: number; since: number; until?: number; newest?: boolean; anchorOnly?: boolean }
  | { op: 'contextSource'; profile: string; conversation: string; id: string; fingerprint: string; around: number }
  | { op: 'media'; profile: string; conversation: string; id: string; part?: number; refreshCache?: boolean; fingerprint?: string }
  | { op: 'exportDatabases'; profile: string; directory: string }
  | { op: 'shutdown' };
