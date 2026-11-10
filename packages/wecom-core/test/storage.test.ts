import { test } from 'bun:test';
import { Database } from 'bun:sqlite';
import assert from 'node:assert/strict';
import { checksum, parseWal, cryptPage, reconstruct, deriveWxPassword } from '../src/storage/wxsqlite.mjs';
import { bootstrapMirror, planIncremental } from '../src/storage/mirror.mjs';

test('password KDF keeps input intact, truncates at 32 bytes, and supplies a usable derived key', () => {
  const input = Buffer.from('synthetic-password'), copy = Buffer.from(input);
  const key = deriveWxPassword(input);
  assert.equal(key.length,16); assert.deepEqual(input,copy);
  assert.deepEqual(key,deriveWxPassword(input));
  assert.notDeepEqual(key,deriveWxPassword(Buffer.from('different')));
  assert.deepEqual(deriveWxPassword(Buffer.alloc(32,65)),deriveWxPassword(Buffer.alloc(40,65)));
  const page=fixture().subarray(0,4096);
  assert.deepEqual(cryptPage(cryptPage(page,key,1,true),key,1),page);
});

function fixture(text = 'synthetic only') {
  const db = new Database(':memory:');
  try {
    db.exec('PRAGMA page_size=4096; CREATE TABLE synthetic (id INTEGER PRIMARY KEY, value TEXT)');
    db.run('INSERT INTO synthetic VALUES (1, ?)', [text]);
    return db.serialize();
  } finally { db.close(); }
}

function verifySqlite(bytes: Buffer) {
  const db = new Database(bytes, {readonly: true});
  try {
    assert.deepEqual(db.query('PRAGMA integrity_check').values(), [['ok']]);
    assert.equal(db.query('SELECT count(*) FROM sqlite_schema WHERE type = ?').values('table')[0][0], 1);
  } finally { db.close(); }
}
function makeWal(frames: [number, number, Buffer][], little = true) {
  const h = Buffer.alloc(32);
  h.writeUInt32BE(little ? 0x377f0682 : 0x377f0683);
  h.writeUInt32BE(3007000, 4); h.writeUInt32BE(4096, 8);
  h.writeUInt32BE(1234, 16); h.writeUInt32BE(5678, 20);
  let sum = checksum(h.subarray(0, 24), little);
  h.writeUInt32BE(sum[0], 24); h.writeUInt32BE(sum[1], 28);
  const result = [h];
  for (const [pgno, commit, data] of frames) {
    const f = Buffer.alloc(24);
    f.writeUInt32BE(pgno); f.writeUInt32BE(commit, 4);
    h.copy(f, 8, 16, 24);
    sum = checksum(Buffer.concat([f.subarray(0, 8), data]), little, sum);
    f.writeUInt32BE(sum[0], 16); f.writeUInt32BE(sum[1], 20);
    result.push(f, data);
  }
  return Buffer.concat(result);
}

test('synthetic encrypted SQLite restores schema and rejects wrong key', () => {
  const db = fixture(), key = Buffer.alloc(16, 23);
  const encrypted = Buffer.concat([cryptPage(db.subarray(0, 4096), key, 1, true), cryptPage(db.subarray(4096), key, 2, true)]);
  const restored = reconstruct(encrypted, parseWal(Buffer.alloc(0)), key);
  verifySqlite(restored);
  assert.throws(() => reconstruct(encrypted, parseWal(Buffer.alloc(0)), Buffer.alloc(16, 24)), /candidate_rejected/);
});
test('WAL uses actual page numbers, committed prefix, both byte orders and checksum', () => {
  const db = fixture(), key = Buffer.alloc(16, 23);
  const first = cryptPage(db.subarray(0, 4096), key, 1, true);
  const second = cryptPage(db.subarray(4096), key, 2, true);
  for (const little of [true, false]) {
    const bytes = makeWal([[2, 2, second], [2, 0, Buffer.alloc(4096)]], little);
    const wal = parseWal(bytes);
    assert.equal(wal.frames.length, 2); assert.equal(wal.committedFrames, 1);
    const restored = reconstruct(Buffer.concat([first, Buffer.alloc(4096)]), wal, key);
    verifySqlite(restored);
    const corrupted = Buffer.from(bytes); corrupted[32 + 24 + 100] ^= 1;
    assert.equal(parseWal(corrupted).committedFrames, 0);
    assert.equal(parseWal(corrupted).tail, 'checksum_mismatch');
    assert.equal(parseWal(bytes.subarray(0, bytes.length - 1)).tail, 'partial_frame');
    const salt = Buffer.from(bytes); salt[40] ^= 1;
    assert.equal(parseWal(salt).tail, 'salt_mismatch');
  }
});

test('incremental snapshots apply committed changes once across a checkpoint', () => {
  const key = Buffer.alloc(16, 37);
  const encrypt = (db: Buffer) => [1, 2].map(page =>
    cryptPage(db.subarray((page - 1) * 4096, page * 4096), key, page, true));
  const base = Buffer.concat(encrypt(fixture()));
  const [first, second] = encrypt(fixture('updated'));
  const boot = bootstrapMirror(base, Buffer.alloc(0), key);
  const wal = makeWal([[2, 2, second]]);
  const plan = planIncremental(base, wal, key, boot.state);
  assert.equal(plan.stats.walPagesDecrypted, 1);
  assert.equal(plan.stats.basePagesDecrypted, 0);
  assert.deepEqual([...plan.patches.keys()], [2]);
  plan.patches.get(2)!.copy(boot.mirror, 4096);
  const db = new Database(boot.mirror, {readonly: true});
  try {
    assert.deepEqual(db.query('SELECT value FROM synthetic').values(), [['updated']]);
  } finally { db.close(); }
  const checkpoint = planIncremental(Buffer.concat([first, second]), Buffer.alloc(0), key, plan.nextState);
  assert.equal(checkpoint.patches.size, 0);
  assert.equal(checkpoint.stats.baseVersionsAlreadyApplied, 1);
});
