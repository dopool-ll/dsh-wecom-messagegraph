import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { fields } from './protobuf';
import { decodeMessage, type DecodedPart } from './rich';
import type { MediaCache } from './media';
import type { Contact, ContactFilter, ContactScope, Conversation, ConversationFilter, Message, MessagePart, Page, Platform, ReadFilter } from './types';

const schemas = {
  macos: {
    message: 'MESSAGE', lid: 'LID', convId: 'conv_id',
    conversation: 'CONVERSATION', conversationId: 'RID', contact: 'USER', contactId: 'RID',
  },
  windows: {
    message: 'message_table', lid: 'message_id', convId: 'conversation_id',
    conversation: 'conversation_table', conversationId: 'id', contact: 'user_table', contactId: 'id',
  },
} as const;

export const requiredTables = (platform: Platform) => schemas[platform];
const empty = <T>(): Page<T> => ({ items: [], more: false });
const pageSize = 60;
const untilCondition = '(CASE WHEN send_time>=1000000000000 THEN send_time<? ELSE send_time<? END)';
const sinceCondition = '(CASE WHEN send_time>=1000000000000 THEN send_time>=? ELSE send_time>=? END)';
const label = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const id = (value: unknown) => value == null ? '' : String(value);
const time = (value: unknown) => {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? (number >= 1e12 ? Math.floor(number / 1000) : number) : 0;
};
const sample = (value: string) => value.replace(/\s+/g, ' ').slice(0, 150);
type Category = Pick<Conversation, 'kind' | 'scope'>;
const unknown: Category = { kind: 'unknown', scope: 'unknown' };

function conversationFields(payload: unknown) {
  if (!(payload instanceof Uint8Array)) return [];
  try {
    return fields(payload);
  } catch { return []; }
}

function integerField(items: ReturnType<typeof fields>, tag: number) {
  const matches = items.filter(field => field.number === tag);
  return matches.length === 1 && typeof matches[0].value === 'bigint' ? matches[0].value : undefined;
}

function macConversationInfo(extras: unknown, keyExtras: unknown) {
  const values = conversationFields(extras);
  const keys = conversationFields(keyExtras);
  // These fields match the current macOS list, including muted conversations
  // whose MESSAGE.isread flags do not reflect the conversation's unread count.
  const unread = integerField(keys, 3) ?? integerField(values, 27);
  const group = integerField(values, 57);
  return {
    unreadCount: unread !== undefined && unread <= 0xffffffffn ? Number(unread) : null,
    muted: integerField(keys, 9) === 1n,
    groupScope: group === 0n ? 'internal' : group === 1n || group === 2n ? 'external' : 'unknown',
  } as const;
}

function macGroupMembers(bytes: Uint8Array) {
  const members: string[] = [];
  let offset = 0;
  // Each member record is a 0x02 marker, a varint length and a protobuf.
  for (let index = 0; index < 48 && offset < bytes.length; index++) {
    if (bytes[offset++] !== 2) break;
    let length = 0;
    let shift = 0;
    let next: number;
    do {
      if (offset >= bytes.length || shift > 14) return members;
      next = bytes[offset++];
      length += (next & 127) << shift;
      shift += 7;
    } while (next & 128);
    if (length === 0 || length > bytes.length - offset) break;
    const person = integerField(conversationFields(bytes.subarray(offset, offset + length)), 1);
    if (person !== undefined && person > 0n) members.push(String(person));
    offset += length;
  }
  return members;
}

function corporateScope(own: string | undefined, other: string | undefined): Category['scope'] {
  if (!own || !other || own === '0' || other === '0') return 'unknown';
  return own === other ? 'internal' : 'external';
}
interface ChatRow { id: unknown; sent: unknown; sender: unknown; kind: unknown; payload: unknown; extra?: unknown }
// macOS stores the quoted message in extracontent. Its local row ID is absent,
// so the enclosing conversation, sender, time and original bytes must agree.
const quotePayload = new Map([
  [0n, 101], [2n, 101], [14n, 103], [101n, 103], [15n, 103], [23n, 102],
  [13n, 105], [103n, 102], [652n, 102], [123n, 107],
]);

function quote(row: ChatRow) {
  if (!(row.extra instanceof Uint8Array) || row.extra.length > 1024 * 1024) return;
  const envelopes = conversationFields(row.extra).filter(field => field.number === 1002);
  if (envelopes.length !== 1) return;
  const originals = conversationFields(envelopes[0].value).filter(field => field.number === 1);
  if (originals.length !== 1) return;
  const parts = conversationFields(originals[0].value);
  const sender = integerField(parts, 1);
  const sent = integerField(parts, 2);
  const type = integerField(parts, 5) ?? 0n;
  const tag = quotePayload.get(type);
  const bodies = parts.filter(field => field.number === tag);
  const payload = bodies.length === 1 ? bodies[0].value : undefined;
  if (!sender || !sent || sender > 0x7fff_ffff_ffff_ffffn || sent > 0x7fff_ffff_ffff_ffffn ||
      !(payload instanceof Uint8Array) || !payload.length) return;
  return {sender, sent, payload};
}

function paginate<T>(items: T[], offset: number): Page<T> {
  return { items: items.slice(offset, offset + pageSize), more: items.length > offset + pageSize, total: items.length };
}

export class Catalog {
  readonly contacts: Contact[];
  readonly conversations: Conversation[];
  readonly counts: { contacts: number; conversations: number; messages: number };
  private contactNames = new Map<string, string>();
  private contactScopes = new Map<string, ContactScope>();
  private avatarUrls = new Map<string, string>();
  private groupMembers = new Map<string, Uint8Array>();
  private ownId?: string;
  private readonly hasQuotes: boolean;
  private schema: (typeof schemas)[Platform];

  constructor(
    private platform: Platform,
    private messagesDb: Database,
    conversationsDb: Database | undefined,
    contactsDb: Database | undefined,
    vid: string,
    private media?: MediaCache,
  ) {
    this.schema = schemas[platform];
    const s = this.schema;
    this.hasQuotes = platform === 'macos' && Boolean(messagesDb.query(
      'SELECT 1 FROM pragma_table_info(?) WHERE lower(name)=?').get(s.message, 'extracontent'));
    const contactColumns = new Set(contactsDb?.query<{name: string}, [string]>(
      'SELECT lower(name) AS name FROM pragma_table_info(?)',
    ).all(s.contact).map(row => row.name));
    const company = ['corpid', 'corp_id'].find(column => contactColumns.has(column)) ?? 'NULL';
    const avatar = contactColumns.has('avatarurl') ? 'avatarurl' : 'NULL';
    const people = contactsDb ? contactsDb.query<{ id: unknown; name: unknown; job: unknown; company: unknown; avatar: unknown }, []>(
      `SELECT ${s.contactId} AS id, name, ${platform === 'macos' ? 'job' : 'position'} AS job,
        ${company} AS company, ${avatar} AS avatar FROM ${s.contact}`,
    ).all().filter(row => id(row.id)) : [];
    // A matched decryption VID only identifies a sender when the same value
    // also appears in the local contact table for this profile.
    const own = people.find(row => id(row.id) === vid);
    if (own) this.ownId = vid;
    const ownCompany = id(own?.company);
    this.contacts = people.map(row => {
      const personId = id(row.id);
      const name = label(row.name) || '未知联系人';
      const scope = corporateScope(ownCompany, id(row.company));
      this.contactNames.set(personId, name);
      this.contactScopes.set(personId, scope);
      if (typeof row.avatar === 'string') this.avatarUrls.set(personId, row.avatar);
      return {id: personId, name, job: label(row.job), scope};
    }).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

    const convColumns = new Set(conversationsDb?.query<{name: string}, [string]>(
      'SELECT lower(name) AS name FROM pragma_table_info(?)',
    ).all(s.conversation).map(row => row.name));
    const keyExtras = convColumns.has('key_extras') ? 'key_extras' : 'NULL';
    const members = convColumns.has('member_bin') ? 'member_bin' : 'NULL';
    const metadata = new Map<string, { name: string; type: unknown } & ReturnType<typeof macConversationInfo>>();
    for (const row of conversationsDb?.query<{
      id: unknown; name: unknown; type: unknown; extras: unknown; keys: unknown; members: unknown;
    }, []>(
      `SELECT ${s.conversationId} AS id, name${platform === 'macos' ? ', conversationtype AS type, extras' : ''},
        ${keyExtras} AS keys, ${members} AS members
      FROM ${s.conversation}`,
    ).all() ?? []) {
      const convId = id(row.id);
      if (!convId) continue;
      metadata.set(convId, {name: label(row.name), type: row.type, ...macConversationInfo(row.extras, row.keys)});
      if (platform === 'macos' && Number(row.type) === 1 && row.members instanceof Uint8Array && row.members.length <= 1024 * 1024)
        this.groupMembers.set(convId, row.members);
    }
    const hasReadFlag = platform === 'macos' && Boolean(messagesDb.query(
      'SELECT 1 FROM pragma_table_info(?) WHERE lower(name)=?',
    ).get(s.message, 'isread'));
    const latest = messagesDb.query<{
      conv: unknown; sent: unknown; kind: unknown; payload: unknown; sender: unknown;
      count: bigint; unread: bigint | null; known: bigint | null;
    }, string[]>(`
      WITH ranked AS (
        SELECT ${s.convId} AS conv, ${s.lid} AS lid, send_time AS sent,
          COUNT(*) OVER (PARTITION BY ${s.convId}) AS count,
          ${hasReadFlag ? `SUM(isread=0 AND CAST(sender_id AS TEXT) IS NOT ?) OVER (PARTITION BY ${s.convId})` : 'NULL'} AS unread,
          ${hasReadFlag ? `COUNT(CASE WHEN isread IN (0,1) THEN 1 END) OVER (PARTITION BY ${s.convId})` : 'NULL'} AS known,
          ROW_NUMBER() OVER (PARTITION BY ${s.convId} ORDER BY COALESCE(send_time,0) DESC, ${s.lid} DESC) AS row
        FROM ${s.message} WHERE ${s.convId} IS NOT NULL
      )
      SELECT r.conv, r.sent, m.content_type AS kind, m.content AS payload, m.sender_id AS sender, r.count, r.unread, r.known
      FROM ranked r JOIN ${s.message} m ON m.${s.lid}=r.lid WHERE r.row=1
    `).all(...(hasReadFlag ? [this.ownId ?? vid] : []));
    const sessions = latest.map(row => {
      const convId = id(row.conv);
      const record = metadata.get(convId);
      metadata.delete(convId);
      const category = this.category(platform, convId, record);
      const unread = Number(row.unread ?? 0);
      return {
        id: convId, name: record?.name || this.contactNames.get(this.windowsPeer(platform, convId) ?? '') || '未命名会话',
        ...category,
        previewSender: category.kind === 'group' ? this.contactNames.get(id(row.sender)) : undefined,
        time: time(row.sent), preview: sample(decodeMessage(platform, row.kind, row.payload).text), count: Number(row.count),
        unreadCount: record?.unreadCount ?? (unread > 0 || row.known === row.count ? unread : null),
        muted: record?.muted ?? false,
      };
    });
    for (const [convId, record] of metadata)
      sessions.push({ id: convId, name: record.name || '未命名会话', time: 0, preview: '', count: 0,
        unreadCount: record.unreadCount, muted: record.muted,
        ...this.category(platform, convId, record) });
    this.conversations = sessions.sort((a, b) => b.time - a.time || a.name.localeCompare(b.name, 'zh-CN'));
    const total = messagesDb.query<{ count: bigint }, []>(`SELECT COUNT(*) AS count FROM ${s.message}`).get();
    this.counts = { conversations: sessions.length, contacts: this.contacts.length, messages: Number(total?.count ?? 0) };
  }

  private windowsPeer(platform: Platform, conversation: string): string | undefined {
    if (platform !== 'windows' || !this.ownId || !conversation.startsWith('S:')) return;
    const members = conversation.slice(2).split('_');
    if (!members.includes(this.ownId)) return;
    return members.length === 2 ? members.find(member => member !== this.ownId) : undefined;
  }

  private category(platform: Platform, conversation: string, metadata?: {type: unknown; groupScope: ContactScope}): Category {
    if (platform === 'macos') {
      if (metadata?.type === 0n || metadata?.type === 0)
        return {kind: 'direct', scope: this.contactScopes.get(conversation) ?? 'unknown'};
      if (metadata?.type === 1n || metadata?.type === 1)
        return {kind: 'group', scope: metadata.groupScope};
      return unknown;
    }
    if (/^R:[^\s]+$/.test(conversation)) return {kind: 'group', scope: 'unknown'};
    if (/^S:[0-9]+_[0-9]+$/.test(conversation)) {
      const peer = this.windowsPeer(platform, conversation);
      return {kind: 'direct', scope: (peer && this.contactScopes.get(peer)) || 'unknown'};
    }
    return unknown;
  }

  list(kind: 'contacts', search: string, offset: number, filter?: ContactFilter): Page<Contact>;
  list(kind: 'conversations', search: string, offset: number, filter?: ConversationFilter, read?: ReadFilter): Page<Conversation>;
  list(kind: 'contacts' | 'conversations', search: string, offset: number,
    filter: ConversationFilter = 'all', read: ReadFilter = 'all'): Page<Contact> | Page<Conversation> {
    const term = search.trim().toLocaleLowerCase();
    if (kind === 'contacts')
      return paginate(this.contacts.filter(row => (filter === 'all' || row.scope === filter)
        && (!term || `${row.name} ${row.job}`.toLocaleLowerCase().includes(term))), offset);
    return paginate(this.conversations.filter(row => (filter === 'all' || row.kind === filter || row.scope === filter)
      && (read === 'all' || (row.unreadCount !== null && (read === 'read' ? row.unreadCount === 0 : row.unreadCount > 0)))
      && (!term || `${row.name} ${row.preview}`.toLocaleLowerCase().includes(term))), offset);
  }

  contactConversations(contact: string): Page<Conversation> {
    const s = this.schema;
    const ids = new Set(this.messagesDb.query<{ id: unknown }, [string]>(
      `SELECT DISTINCT ${s.convId} AS id FROM ${s.message} WHERE CAST(sender_id AS TEXT)=?`,
    ).all(contact).map(row => id(row.id)));
    return paginate(this.conversations.filter(row => ids.has(row.id)), 0);
  }

  conversationAvatars(conversation: string): string[] {
    if (!this.media || this.platform !== 'macos') return [];
    const row = this.conversations.find(item => item.id === conversation);
    const members = this.groupMembers.get(conversation);
    const people = row?.kind === 'direct' ? [conversation] : members ? macGroupMembers(members) : [];
    const images: string[] = [];
    for (const person of new Set(people)) {
      if (!this.contactNames.has(person)) continue;
      const avatar = this.media.avatar(person, this.avatarUrls.get(person));
      if (avatar) images.push(avatar);
      if (images.length === 9) break;
    }
    return images;
  }

  mediaFile(conversation: string, message: string, part?: number, refreshCache = false, fingerprint?: string) {
    const s = this.schema;
    const row = this.messagesDb.query<ChatRow, [string, string]>(
      `SELECT ${this.messageColumns()} FROM ${s.message}
       WHERE CAST(${s.convId} AS TEXT)=? AND CAST(${s.lid} AS TEXT)=? LIMIT 1`,
    ).get(conversation, message);
    if (!row || (fingerprint && this.fingerprint(row) !== fingerprint)) return;
    const decoded = decodeMessage(this.platform, row.kind, row.payload);
    const asset = decoded.kind === 'mixed' ? (part !== undefined ? decoded.parts[part]?.asset : undefined)
      : part === undefined ? decoded.asset : undefined;
    return asset ? this.media?.resolve(asset, refreshCache && asset.kind === 'image') : undefined;
  }

  private withLocalMedia({asset, ...part}: DecodedPart): MessagePart {
    if (!asset) return part;
    const file = this.media?.resolve(asset);
    return {...part, localMedia: Boolean(file), localPreview: file?.variant === 'preview' || undefined};
  }

  private messageColumns() {
    return `${this.schema.lid} AS id, COALESCE(send_time,0) AS sent, sender_id AS sender, content_type AS kind, content AS payload`;
  }

  private messageView(row: ChatRow, withMedia: boolean): Message {
    const decoded = decodeMessage(this.platform, row.kind, row.payload);
    const partView = (part: DecodedPart) => {
      if (withMedia) return this.withLocalMedia(part);
      const {asset: _asset, ...view} = part;
      return view;
    };
    return {
      id: id(row.id), sender: this.contactNames.get(id(row.sender)) ?? '未知发送者',
      own: this.ownId !== undefined && id(row.sender) === this.ownId,
      time: time(row.sent),
      ...(decoded.kind === 'mixed' ? {...decoded, parts: decoded.parts.map(partView)} : partView(decoded)),
    };
  }

  private fingerprint(row: ChatRow) {
    const hash = createHash('sha256').update(JSON.stringify([id(row.sender), id(row.sent), id(row.kind)]));
    if (row.payload instanceof Uint8Array) hash.update(row.payload);
    return hash.digest('hex');
  }

  contextConversationIds() {
    return this.conversations
      .filter(({kind}) => kind === 'group' || kind === 'direct')
      .map(({id}) => id);
  }

  contextScan(conversations: string[], since: number, limit: number, known = new Map<string, string>()) {
    const s = this.schema;
    const query = this.messagesDb.query<ChatRow, [string, number, number, number]>(
      `SELECT ${this.messageColumns()} FROM ${s.message} WHERE CAST(${s.convId} AS TEXT)=?
       AND ${sinceCondition}
       ORDER BY COALESCE(send_time,0) DESC, ${s.lid} DESC LIMIT ?`,
    );
    return conversations.flatMap(conversation => {
      const record = this.conversations.find(item => item.id === conversation && (item.kind === 'group' || item.kind === 'direct'));
      if (!record) return [];
      const rows = query.all(conversation, since * 1000, since, limit + 1);
      const more = rows.length > limit;
      const hash = createHash('sha256').update(JSON.stringify([record.name, record.kind, more]));
      const messages = rows.slice(0, limit).map(row => {
        const fingerprint = this.fingerprint(row);
        const senderId = id(row.sender);
        hash.update(JSON.stringify([id(row.id), fingerprint, this.contactNames.get(senderId)]));
        return {row, fingerprint, senderId};
      });
      const signature = hash.digest('hex');
      return [{conversation: record, more, signature, messages: signature === known.get(conversation) ? null
        : messages.map(({row, fingerprint, senderId}) => ({fingerprint, senderId, message: this.messageView(row, false)}))}];
    });
  }

  private contextRow(conversation: string, message: string, fingerprint: string, withQuote = false) {
    const s = this.schema;
    const columns = this.messageColumns();
    const row = this.messagesDb.query<ChatRow, [string, string]>(
      `SELECT ${columns}${withQuote && this.hasQuotes ? ',extracontent AS extra' : ''} FROM ${s.message}
       WHERE CAST(${s.convId} AS TEXT)=? AND CAST(${s.lid} AS TEXT)=?`,
    ).get(conversation, message);
    return row && this.fingerprint(row) === fingerprint ? row : null;
  }

  private contextSide(conversation: string, anchor: ChatRow, before: boolean, limit: number, since?: number, until?: number) {
    if (!limit) return [];
    const s = this.schema;
    const direction = before ? 'DESC' : 'ASC';
    const order = `(COALESCE(send_time,0), ${s.lid})`;
    return this.messagesDb.query<ChatRow, [string, string, string, ...number[]]>(
      `SELECT ${this.messageColumns()} FROM ${s.message} WHERE CAST(${s.convId} AS TEXT)=?
       AND ${order} ${before ? '<' : '>'} (CAST(? AS INTEGER),CAST(? AS INTEGER))
       ${since === undefined ? '' : 'AND ' + sinceCondition} ${until === undefined ? '' : 'AND ' + untilCondition}
       ORDER BY COALESCE(send_time,0) ${direction}, ${s.lid} ${direction} LIMIT ?`,
    ).all(conversation, id(anchor.sent), id(anchor.id), ...(since === undefined ? [] : [since * 1000, since]),
      ...(until === undefined ? [] : [until * 1000, until]), limit);
  }

  private contextItem(row: ChatRow) {
    return {message: this.messageView(row, false), fingerprint: this.fingerprint(row), senderId: id(row.sender)};
  }

  contextSource(conversation: string, message: string, fingerprint: string, around: number) {
    const record = this.conversations.find(item => item.id === conversation);
    const anchor = this.contextRow(conversation, message, fingerprint);
    if (!record || !anchor) return null;
    const before = this.contextSide(conversation, anchor, true, around);
    const after = this.contextSide(conversation, anchor, false, around);
    return {conversation: record, items: [...before.reverse(), anchor, ...after]
      .map(row => this.messageView(row, true))};
  }

  contextPage(conversation: string, message: string, fingerprint: string, direction: 'before' | 'after', limit: number, since: number, until?: number) {
    const record = this.conversations.find(item => item.id === conversation);
    const anchor = this.contextRow(conversation, message, fingerprint);
    if (!record || !anchor) return null;
    const rows = this.contextSide(conversation, anchor, direction === 'before', limit + 1, since, until);
    return {conversation: record, items: rows.slice(0, limit).map(row => this.contextItem(row)), more: rows.length > limit};
  }

  contextRelated(conversation: string, message: string, fingerprint: string, limit: number, since: number,
    {until, newest = false}: {until?: number; newest?: boolean} = {}) {
    const record = this.conversations.find(item => item.id === conversation);
    const anchor = this.contextRow(conversation, message, fingerprint, true);
    if (!record || !anchor) return null;
    const result = {conversation: record, anchor: this.contextItem(anchor),
      quoted: null as ReturnType<Catalog['contextItem']> | null,
      replies: [] as ReturnType<Catalog['contextItem']>[], more: false};
    if (!this.hasQuotes || !limit) return result;

    const s = this.schema;
    const columns = this.messageColumns();
    const conv = `CAST(${s.convId} AS TEXT)=?`;
    const position = `(COALESCE(send_time,0), ${s.lid})`;
    const target = this.messagesDb.query<ChatRow, [string, bigint, bigint, Uint8Array, string, string]>(
      `SELECT ${columns} FROM ${s.message} WHERE ${conv} AND sender_id=? AND send_time=? AND content=?
       AND ${position} < (CAST(? AS INTEGER),CAST(? AS INTEGER)) LIMIT 2`,
    );
    function original(row: ChatRow, hint = quote(row)) {
      if (!hint) return;
      const rows = target.all(conversation, hint.sender, hint.sent, hint.payload, id(row.sent), id(row.id));
      if (rows.length === 1) return rows[0];
    }

    const quoted = original(anchor);
    if (quoted && time(quoted.sent) >= since && (until === undefined || time(quoted.sent) < until)) result.quoted = this.contextItem(quoted);
    if (!(anchor.payload instanceof Uint8Array) || !anchor.payload.length) return result;
    const order = newest ? 'DESC' : 'ASC';
    const replies = this.messagesDb.query<ChatRow, [string, string, string, Uint8Array, ...number[]]>(
      `SELECT ${columns},extracontent AS extra FROM ${s.message} WHERE ${conv}
       AND ${position} > (CAST(? AS INTEGER),CAST(? AS INTEGER)) AND instr(extracontent,?)>0 AND ${sinceCondition}
       ${until === undefined ? '' : 'AND ' + untilCondition}
       ORDER BY COALESCE(send_time,0) ${order},${s.lid} ${order}`,
    );
    for (const row of replies.iterate(conversation, id(anchor.sent), id(anchor.id), anchor.payload, since * 1000, since,
      ...(until === undefined ? [] : [until * 1000, until]))) {
      const hint = quote(row);
      if (!hint || id(hint.sender) !== id(anchor.sender) || id(hint.sent) !== id(anchor.sent) ||
          !Buffer.from(hint.payload).equals(anchor.payload)) continue;
      if (id(original(row, hint)?.id) !== message) continue;
      if (result.replies.length === limit) { result.more = true; break; }
      result.replies.push(this.contextItem(row));
    }
    return result;
  }

  messages(conversation: string, before?: string): Page<Message> {
    const s = this.schema;
    const conv = `CAST(${s.convId} AS TEXT)=?`;
    const limit = pageSize + 1;
    const columns = this.messageColumns();
    const order = `ORDER BY COALESCE(send_time,0) DESC, ${s.lid} DESC LIMIT ${limit}`;
    let rows: ChatRow[];
    if (before !== undefined) {
      const anchor = this.messagesDb.query<{ id: string | bigint | number; sent: string | bigint | number }, [string, string]>(
        `SELECT ${s.lid} AS id, COALESCE(send_time,0) AS sent FROM ${s.message} WHERE ${conv} AND CAST(${s.lid} AS TEXT)=?`,
      ).get(conversation, before);
      if (!anchor) return empty();
      rows = this.messagesDb.query<ChatRow, [string, typeof anchor.sent, typeof anchor.id]>(
        `SELECT ${columns} FROM ${s.message} WHERE ${conv} AND (COALESCE(send_time,0),${s.lid}) < (?,?) ${order}`,
      ).all(conversation, anchor.sent, anchor.id);
    } else {
      rows = this.messagesDb.query<ChatRow, [string]>(
        `SELECT ${columns} FROM ${s.message} WHERE ${conv} ${order}`,
      ).all(conversation);
    }
    return {
      more: rows.length > pageSize,
      items: rows.slice(0, pageSize).reverse().map(row => this.messageView(row, true)),
    };
  }
}
