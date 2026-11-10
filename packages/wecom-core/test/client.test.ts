import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import { checksum, cryptPage } from '../src/storage/wxsqlite.mjs';
import { deriveKey, discover } from '../src/discovery';
import { Catalog } from '../src/catalog';
import { companyIdentity } from '../src/protobuf';
import { decodeMessage } from '../src/rich';
import { MediaCache } from '../src/media';
import { Synchronizer } from '../src/sync';

const vid = '1688850000000001';
const contactId = '9007199254740999';
const startId = 9007199254741011n;
const sessionId = `S:${vid}_${contactId}`;
const pageSize = 4096;

function varint(value: bigint): Buffer {
  const bytes = [];
  while (value > 127n) {
    bytes.push(Number(value & 127n) | 128);
    value >>= 7n;
  }
  bytes.push(Number(value));
  return Buffer.from(bytes);
}
const integer = (tag: number, value: bigint) => Buffer.concat([varint(BigInt(tag * 8)), varint(value)]);
function blob(tag: number, bytes: Buffer) {
  return Buffer.concat([varint(BigInt(tag * 8 + 2)), varint(BigInt(bytes.length)), bytes]);
}
const string = (tag: number, value: string) => blob(tag, Buffer.from(value));

test('resolves only verifiable macOS quote targets and pages raw originals by message order', () => {
  const db = new Database(':memory:', {safeIntegers: true});
  try {
    db.exec(`CREATE TABLE MESSAGE(LID INTEGER PRIMARY KEY, conv_id TEXT, send_time INTEGER, sender_id INTEGER,
      content_type INTEGER, content BLOB, extracontent BLOB);
      CREATE TABLE CONVERSATION(RID TEXT PRIMARY KEY, name TEXT, conversationtype INTEGER, extras BLOB);
      INSERT INTO CONVERSATION VALUES ('main', 'Main', 1, NULL), ('other', 'Other', 1, NULL)`);
    const body = (text: string) => blob(1, blob(2, string(1, text)));
    const embedded = (sender: bigint, sent: bigint, text: string) => blob(1002, blob(1, Buffer.concat([
      integer(1, sender), integer(2, sent), integer(5, 2n), blob(101, body(text)),
    ])));
    const insert = db.query('INSERT INTO MESSAGE VALUES (?,?,?,?,?,?,?)');
    insert.run(startId, 'main', 100, 5, 2, body('original'), null);
    insert.run(startId + 1n, 'other', 100, 5, 2, body('original'), null);
    insert.run(startId + 2n, 'main', 100, 5, 2, body('same time but different text'), null);
    for (let n = 3; n <= 12; n++) insert.run(startId + BigInt(n), 'main', 100 + n, 5, 2, body('filler'), null);
    insert.run(startId + 13n, 'main', 130, 6, 2, body('reply'), embedded(5n, 100n, 'original'));
    insert.run(startId + 14n, 'main', 130, 6, 2, body('same timestamp next'), null);
    const catalog = new Catalog('macos', db, db, undefined, '0');
    const item = catalog.contextScan(['main'], 0, 30)[0].messages!
      .find(({message}) => message.id === String(startId + 13n))!;
    const related = catalog.contextRelated('main', item.message.id, item.fingerprint, 10, 0)!;
    expect(related.quoted?.message.id).toBe(String(startId));
    expect(catalog.contextRelated('main', related.quoted!.message.id, related.quoted!.fingerprint, 10, 0)
      ?.replies.map(({message}) => message.id)).toEqual([item.message.id]);
    expect(catalog.contextRelated('main', item.message.id, item.fingerprint, 10, 101)?.quoted).toBeNull();
    const before = catalog.contextPage('main', item.message.id, item.fingerprint, 'before', 2, 111)!;
    expect(before.items.map(({message}) => message.id)).toEqual([String(startId + 12n), String(startId + 11n)]);
    expect(before.more).toBe(false);
    const after = catalog.contextPage('main', item.message.id, item.fingerprint, 'after', 1, 0)!;
    expect(after.items[0].message.id).toBe(String(startId + 14n));
    expect(after.more).toBe(false);
    // Equal source bytes and sender in the same second make the quote ambiguous.
    insert.run(startId + 15n, 'main', 100, 5, 2, body('original'), null);
    expect(catalog.contextRelated('main', item.message.id, item.fingerprint, 10, 0)?.quoted).toBeNull();
  } finally {
    db.close();
  }
});

test('shows verified rich types and resolves media only for the matching conversation and cache', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-media-test-'));
  const messages = new Database(':memory:', {safeIntegers: true});
  try {
    const images = path.join(root, 'Caches', 'Images');
    fs.mkdirSync(images, {recursive: true});
    const name = '0123456789abcdef0123456789abcdef';
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/qsAAAAASUVORK5CYII=', 'base64');
    const image = path.join(images, `${name}.png`);
    fs.writeFileSync(image, png);
    const foreign = path.join(root, 'outside.png');
    fs.writeFileSync(foreign, png);
    const link = path.join(images, 'symlink.png');
    fs.symlinkSync(foreign, link);
    const previewDigest = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const previewFolder = path.join(images, '2026-11', previewDigest);
    fs.mkdirSync(previewFolder, {recursive: true});
    fs.writeFileSync(path.join(previewFolder, 'preview.jpg'), Buffer.from('ffd8ffe000104a46', 'hex'));
    messages.exec('CREATE TABLE MESSAGE(LID INTEGER PRIMARY KEY,conv_id TEXT,send_time INTEGER,sender_id INTEGER,content_type INTEGER,content BLOB)');
    const insert = messages.prepare('INSERT INTO MESSAGE VALUES (?,?,?,?,?,?)');
    insert.run(1, 'first', 1, 5, 14, Buffer.concat([string(10, name), integer(5, 1n), integer(6, 1n)]));
    insert.run(2, 'second', 1, 5, 653, string(202, link));
    insert.run(3, 'third', 1, 5, 653, string(202, foreign));
    const original = (digest: string) => Buffer.concat([string(2, 'preview.jpg'), integer(4, 9000n), string(10, digest)]);
    insert.run(4, 'fourth', 1, 5, 14, original(previewDigest));
    const lateDigest = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    insert.run(5, 'fifth', 1, 5, 14, original(lateDigest));
    const catalog = new Catalog('macos', messages, undefined, undefined, '0', new MediaCache(fs.realpathSync(root)));
    expect(catalog.messages('first').items[0]).toMatchObject({kind: 'image', localMedia: true, detail: {width: 1, height: 1}});
    expect(catalog.mediaFile('first', '1')).toMatchObject({mime: 'image/png', size: png.length});
    expect(catalog.mediaFile('second', '1')).toBeUndefined();
    expect(catalog.messages('second').items[0]).toMatchObject({kind: 'image', localMedia: false});
    expect(catalog.messages('third').items[0]).toMatchObject({kind: 'image', localMedia: false});
    expect(catalog.messages('fourth').items[0]).toMatchObject({kind: 'image', localMedia: true, localPreview: true});
    expect(catalog.mediaFile('fourth', '4')).toMatchObject({mime: 'image/jpeg', variant: 'preview'});
    expect(catalog.mediaFile('fifth', '5')).toBeUndefined();
    const lateFolder = path.join(images, '2026-11', lateDigest);
    fs.mkdirSync(lateFolder);
    fs.writeFileSync(path.join(lateFolder, 'preview.jpg'), Buffer.from('ffd8ffe000104a46', 'hex'));
    expect(catalog.mediaFile('fifth', '5', undefined, true)).toMatchObject({mime: 'image/jpeg', variant: 'preview'});
    expect(catalog.messages('fifth').items[0]).toMatchObject({localMedia: true, localPreview: true});
    expect(decodeMessage('macos', 16, integer(7, 3n))).toMatchObject({kind: 'voice', detail: {seconds: 3}});
    expect(decodeMessage('macos', 13, Buffer.concat([string(1, 'javascript:alert(1)'), string(3, '本地卡片')]))).toMatchObject({
      kind: 'link', text: '本地卡片', detail: {url: undefined},
    });
    expect(decodeMessage('macos', 1011, null)).toMatchObject({kind: 'system', text: '[撤回消息]'});
    expect(decodeMessage('macos', 1052, Buffer.from('置顶了一条消息'))).toMatchObject({
      kind: 'system', text: '置顶了一条消息', placeholder: false,
    });
  } finally {
    messages.close();
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('decodes ordered parts of type 123 and verifies duplicate image cache entries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-mixed-test-'));
  const messages = new Database(':memory:', {safeIntegers: true});
  try {
    const png = Buffer.from('89504e470d0a1a0a01', 'hex');
    const incorrect = Buffer.from('89504e470d0a1a0a02', 'hex');
    const filename = 'image.png';
    for (const [folder, bytes] of [['a', incorrect], ['b', png], ['c', png]] as const) {
      const directory = path.join(root, 'Caches', 'Images', folder);
      fs.mkdirSync(directory, {recursive: true});
      fs.writeFileSync(path.join(directory, filename), bytes);
    }
    const image = Buffer.concat([string(2, filename), integer(4, BigInt(png.length)),
      string(10, createHash('md5').update(png).digest('hex'))]);
    const text = Buffer.concat([
      blob(1, Buffer.concat([integer(1, 5n), blob(2, string(2, '测试联系人'))])),
      blob(1, Buffer.concat([integer(1, 0n), string(2, ' 看这张图')])),
    ]);
    const message = Buffer.concat([
      blob(1, Buffer.concat([integer(5, 14n), blob(103, image)])),
      blob(1, Buffer.concat([integer(5, 2n), blob(101, text)])),
    ]);
    messages.exec('CREATE TABLE MESSAGE(LID INTEGER PRIMARY KEY,conv_id TEXT,send_time INTEGER,sender_id INTEGER,content_type INTEGER,content BLOB)');
    messages.run('INSERT INTO MESSAGE VALUES (?,?,?,?,?,?)', [1, 'chat', 1, 5, 123, message]);
    messages.run('INSERT INTO MESSAGE VALUES (?,?,?,?,?,?)', [2, 'chat', 2, 5, 14, image]);
    const catalog = new Catalog('macos', messages, undefined, undefined, '0', new MediaCache(fs.realpathSync(root)));
    expect(catalog.messages('chat').items[0]).toMatchObject({kind: 'mixed', parts: [
      {kind: 'image', localMedia: true}, {kind: 'text', text: '@测试联系人 看这张图'},
    ]});
    expect(fs.readFileSync(catalog.mediaFile('chat', '1', 0)!.path)).toEqual(png);
    expect(fs.readFileSync(catalog.mediaFile('chat', '2')!.path)).toEqual(png);
    expect(catalog.mediaFile('chat', '1')).toBeUndefined();
    expect(catalog.mediaFile('chat', '1', 1)).toBeUndefined();
    expect(catalog.mediaFile('other', '1', 0)).toBeUndefined();
  } finally {
    messages.close();
    fs.rmSync(root, {recursive: true, force: true});
  }
});

function database(schema: string, populate: (db: Database) => void): Buffer {
  const db = new Database(':memory:', {safeIntegers: true});
  try {
    db.exec(`PRAGMA page_size=${pageSize}; ${schema}`);
    populate(db);
    return Buffer.from(db.serialize());
  } finally { db.close(); }
}

function windowsMessages(count: number): Buffer {
  return database('CREATE TABLE message_table(message_id INTEGER PRIMARY KEY, conversation_id TEXT, sender_id INTEGER, send_time INTEGER, content_type INTEGER, content BLOB)', db => {
    for (let n = 0; n < count; n++) {
      const value = Buffer.from(`text-${n}`);
      const data = Buffer.concat([Buffer.from([10,value.length+4,18,value.length+2,10,value.length]),value]);
      db.run('INSERT INTO message_table VALUES (?,?,?,?,?,?)', [
        startId + BigInt(n), sessionId, n === 0 ? 7n : BigInt(contactId), 1600000000 + n, 2, data,
      ]);
    }
  });
}

function encrypt(plain: Buffer, key: Buffer): Buffer {
  const pages: Buffer[] = [];
  for (let offset = 0; offset < plain.length; offset += pageSize)
    pages.push(cryptPage(plain.subarray(offset, offset + pageSize), key, offset / pageSize + 1, true));
  return Buffer.concat(pages);
}

function wal(ciphertext: Buffer, previous?: Buffer) {
  const header = Buffer.alloc(32);
  header.writeUInt32BE(0x377f0682);
  header.writeUInt32BE(3007000, 4);
  header.writeUInt32BE(pageSize, 8);
  header.writeUInt32BE(2, 16);
  header.writeUInt32BE(3, 20);
  let rolling = checksum(header.subarray(0, 24), true);
  header.writeUInt32BE(rolling[0], 24);
  header.writeUInt32BE(rolling[1], 28);
  if (previous) {
    const last = previous.length - pageSize - 24;
    rolling = [previous.readUInt32BE(last + 16), previous.readUInt32BE(last + 20)];
  }
  const frames = [previous ?? header];
  for (let offset = 0; offset < ciphertext.length; offset += pageSize) {
    const frame = Buffer.alloc(24);
    frame.writeUInt32BE(offset / pageSize + 1);
    if (offset + pageSize === ciphertext.length) frame.writeUInt32BE(ciphertext.length / pageSize, 4);
    header.copy(frame, 8, 16, 24);
    const page = ciphertext.subarray(offset, offset + pageSize);
    rolling = checksum(Buffer.concat([frame.subarray(0, 8), page]), true, rolling);
    frame.writeUInt32BE(rolling[0], 16);
    frame.writeUInt32BE(rolling[1], 20);
    frames.push(frame, page);
  }
  return Buffer.concat(frames);
}

test('discovers a Windows-shaped VID, validates WAL commits, and exports the last good SQLite snapshots', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-desktop-test-'));
  const root = path.join(scratch, 'WXWork');
  const sync = new Synchronizer();
  const key = deriveKey(vid);
  const nextTick = () => {
    const now = Date.now() + 12000;
    sync.tick(now);
    sync.tick(now + 2000);
  };
  try {
    const data = path.join(root, vid, 'Data');
    const wrong = path.join(root, '999', 'Data');
    for (const directory of [data, wrong]) fs.mkdirSync(directory, {recursive: true});
    const message = path.join(data, 'message.db');
    const main = encrypt(windowsMessages(61), key);
    fs.writeFileSync(message, main);
    const unknownKey = deriveKey('1688850000000333');
    fs.writeFileSync(path.join(wrong, 'message.db'), encrypt(windowsMessages(1), unknownKey));
    unknownKey.fill(0);
    const team = Buffer.concat([integer(1, 10n), integer(2, BigInt(vid)), string(3, '示例企业')]);
    fs.writeFileSync(path.join(path.dirname(data), 'io_data.json'), JSON.stringify({team_info: team.toString('base64')}));
    fs.writeFileSync(path.join(data, 'session.db'), encrypt(database(
      'CREATE TABLE conversation_table(id TEXT PRIMARY KEY, name TEXT)',
      db => db.run('INSERT INTO conversation_table VALUES (?, ?)', [sessionId, '示例会话']),
    ), key));
    fs.writeFileSync(path.join(data, 'user.db'), encrypt(database(
      'CREATE TABLE user_table(id INTEGER PRIMARY KEY, name TEXT, position TEXT)',
      db => db.run('INSERT INTO user_table VALUES (?, ?, ?)', [BigInt(contactId), '示例联系人', '开发']),
    ), key));

    const sources = discover('windows', undefined, root);
    expect(sources.find(source => !source.profile.available)?.profile.issue).toBe('vid_not_verified');
    const source = sources.find(source => source.profile.available)!;
    expect(source.profile.name).toBe('示例企业');
    sync.start(source);
    expect(() => sync.exportDatabases(source.profile.id, scratch)).toThrow('export_not_ready');
    await Promise.resolve();
    expect(sync.state.phase).toBe('ready');
    expect(sync.state.counts).toEqual({contacts: 1, conversations: 1, messages: 61});
    expect(sync.catalog?.list('contacts', '开发', 0).items[0]?.id).toBe(contactId);
    expect(sync.catalog?.contactConversations(contactId).items[0]?.id).toBe(sessionId);
    expect(sync.catalog?.list('conversations', '', 0, 'direct').total).toBe(1);
    expect(sync.catalog?.list('conversations', '', 0, 'external').total).toBe(0);
    const recent = sync.catalog!.messages(sessionId);
    expect(recent.more).toBe(true);
    expect(recent.items[0].id).toBe(String(startId + 1n));
    expect(sync.catalog!.messages(sessionId, recent.items[0].id).items[0]).toMatchObject({
      id: String(startId), sender: '未知发送者', text: 'text-0', own: false,
    });

    const walPath = message + '-wal';
    const version2 = encrypt(windowsMessages(62), key);
    const version3 = encrypt(windowsMessages(63), key);
    const initialWal = wal(version2);
    fs.writeFileSync(walPath, initialWal);
    sync.pause(true);
    nextTick();
    expect(sync.state.counts.messages).toBe(61);
    sync.pause(false);
    nextTick();
    expect(sync.state.counts.messages).toBe(62);

    const appended = wal(version3, initialWal);
    fs.writeFileSync(walPath, appended);
    nextTick();
    expect(sync.state.counts.messages).toBe(63);
    const lastRevision = sync.state.revision;
    nextTick();
    expect(sync.state.revision).toBe(lastRevision);

    const invalid = Buffer.from(appended);
    invalid[invalid.length - 1] ^= 1;
    fs.writeFileSync(walPath, invalid);
    nextTick();
    expect(sync.state.phase).toBe('retrying');
    expect(sync.state.counts.messages).toBe(63);

    expect(() => sync.exportDatabases(source.profile.id, data)).toThrow('export_inside_source');
    expect(() => sync.exportDatabases('other-profile', scratch)).toThrow('export_profile_changed');
    const snapshot = sync.exportDatabases(source.profile.id, scratch);
    const names = ['message.db', 'session.db', 'user.db'];
    expect([...snapshot.files].sort()).toEqual(names);
    expect(fs.readdirSync(snapshot.directory).sort()).toEqual(names);
    expect(snapshot.capturedAt).toBe(sync.state.updatedAt!);
    const exported = new Database(path.join(snapshot.directory, 'message.db'), {readonly: true, safeIntegers: true});
    try {
      expect(exported.query('PRAGMA integrity_check').get()).toEqual({integrity_check: 'ok'});
      expect(exported.query('SELECT count(*) AS n, max(message_id) AS last FROM message_table').get())
        .toEqual({n: 63n, last: startId + 62n});
    } finally { exported.close(); }
    expect(fs.readFileSync(message).equals(main)).toBe(true);
    expect(fs.readFileSync(walPath).equals(invalid)).toBe(true);

    fs.unlinkSync(walPath);
    sync.pause(false);
    nextTick();
    expect(sync.state.phase).toBe('ready');
    // The restored main file has the same bytes as before the first WAL.
    // Its visible version still has to replace the previous WAL overlay.
    expect(sync.state.counts.messages).toBe(61);

    fs.writeFileSync(walPath, appended);
    nextTick();
    expect(sync.state.counts.messages).toBe(63);
    const restoredRevision = sync.state.revision;
    fs.writeFileSync(message, version3);
    fs.unlinkSync(walPath);
    nextTick();
    expect(sync.state.counts.messages).toBe(63);
    expect(sync.state.revision).toBe(restoredRevision);

    // Restore a coherent, older source and discard WAL-only page versions.
    fs.writeFileSync(message, main);
    nextTick();
    expect(sync.state.counts.messages).toBe(61);
    fs.unlinkSync(message);
    nextTick();
    expect(sync.state.phase).toBe('retrying');
    expect(sync.state.counts.messages).toBe(61);
  } finally {
    sync.close();
    key.fill(0);
    fs.rmSync(scratch, {recursive: true, force: true});
  }
});

test('binds a macOS enterprise name to a matching user and company identity', () => {
  const user = Buffer.concat([integer(1, BigInt(vid)), integer(13, 10n)]).toString('base64');
  const corp = (id: bigint) => Buffer.concat([string(1, '示例企业'), integer(43, id)]).toString('base64');
  expect(companyIdentity(JSON.stringify({user_info: user, corp_info: corp(10n)}))).toEqual({vid, name: '示例企业'});
  expect(companyIdentity(JSON.stringify({user_info: user, corp_info: corp(11n)}))).toBeUndefined();
});

test('filters contacts by enterprise and combines conversation type with locally recorded read status', () => {
  const info = new Database(':memory:', {safeIntegers: true});
  const contacts = new Database(':memory:', {safeIntegers: true});
  try {
    info.exec(`CREATE TABLE MESSAGE(LID INTEGER PRIMARY KEY, conv_id INTEGER, send_time INTEGER, sender_id INTEGER, content_type INTEGER, content BLOB, isread INTEGER);
      CREATE TABLE CONVERSATION(RID INTEGER PRIMARY KEY, name TEXT, conversationtype INTEGER, extras BLOB);`);
    contacts.exec('CREATE TABLE USER(RID INTEGER PRIMARY KEY, name TEXT, job TEXT, corpid INTEGER)');
    for (const [rid, name, company] of [[BigInt(vid), '本人', 10], [2, '同事', 10], [3, '客户', 20], [8, '待分类', null]] as const) {
      contacts.run('INSERT INTO USER VALUES (?, ?, NULL, ?)', [rid, name, company]);
    }
    const insert = info.query('INSERT INTO CONVERSATION VALUES (?,?,?,?)');
    insert.run(2, '同事单聊', 0, null);
    insert.run(3, '客户单聊', 0, null);
    insert.run(4, '内部群聊', 1, Buffer.from([0xc8, 3, 0]));
    insert.run(5, '外部群聊', 1, Buffer.from([0xc8, 3, 2]));
    insert.run(6, '未标定群聊', 1, Buffer.from([0xc8, 3, 3]));
    insert.run(9, '另一种外部群聊', 1, Buffer.from([0xc8, 3, 1]));
    insert.run(7, '系统通知', 103, null);
    info.exec('ALTER TABLE CONVERSATION ADD COLUMN key_extras BLOB');
    info.run('UPDATE CONVERSATION SET key_extras=? WHERE RID=4', [integer(3, 5n)]);
    info.run('UPDATE CONVERSATION SET key_extras=? WHERE RID=5', [Buffer.concat([integer(3, 22n), integer(9, 1n)])]);
    const message = info.query('INSERT INTO MESSAGE VALUES (?, ?, ?, ?, 1011, NULL, ?)');
    message.run(1, 2, 1, 2, 1);
    message.run(2, 3, 2, 3, 0);
    message.run(3, 3, 3, BigInt(vid), 0);
    message.run(4, 5, 4, 3, 1);
    message.run(5, 6, 5, 3, null);
    const catalog = new Catalog('macos', info, info, contacts, vid);
    const ids = (filter: 'all' | 'direct' | 'group' | 'internal' | 'external', search = '') =>
      catalog.list('conversations', search, 0, filter).items.map(row => row.id).sort();
    expect(ids('all')).toEqual(['2', '3', '4', '5', '6', '7', '9']);
    expect(ids('direct')).toEqual(['2', '3']);
    expect(ids('group')).toEqual(['4', '5', '6', '9']);
    expect(ids('internal')).toEqual(['2', '4']);
    expect(ids('external')).toEqual(['3', '5', '9']);
    expect(ids('external', '群聊')).toEqual(['5', '9']);
    expect(catalog.list('contacts', '', 0, 'internal').items.map(row => row.id).sort()).toEqual([vid, '2'].sort());
    expect(catalog.list('contacts', '客户', 0, 'external').items).toMatchObject([{id: '3', scope: 'external'}]);
    expect(catalog.list('contacts', '待分类', 0).items).toMatchObject([{id: '8', scope: 'unknown'}]);
    expect(catalog.list('conversations', '', 0, 'external', 'unread').items).toMatchObject([
      {id: '5', unreadCount: 22, muted: true, previewSender: '客户'}, {id: '3', unreadCount: 1, muted: false},
    ]);
    expect(catalog.conversations.find(row => row.id === '4')).toMatchObject({unreadCount: 5, muted: false});
    expect(catalog.list('conversations', '', 0, 'all', 'read').items.map(row => row.id)).toEqual(['2']);
    expect(catalog.conversations.find(row => row.id === '6')?.unreadCount).toBeNull();
  } finally {
    info.close();
    contacts.close();
  }
});
