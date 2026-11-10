import crypto from 'node:crypto';

const header = Buffer.from('SQLite format 3\0');
const md5 = b => crypto.createHash('md5').update(b).digest();
function requireThat(ok, code) { if (!ok) throw new Error(code); }

// Public wxSQLite3 AES-128 password KDF candidate, distinct from the derived 16-byte key.
// References: SQLite3MultipleCiphers cipher_wxaes128.c / cipher_common.c (MIT).
// Static client evidence matches its 32-byte padding, 50/20/50 iteration structure.
export function deriveWxPassword(password) {
  requireThat(Buffer.isBuffer(password), 'password_must_be_buffer');
  const padding = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');
  const user = Buffer.alloc(32), count = Math.min(password.length, 32);
  password.copy(user, 0, 0, count); padding.copy(user, count, 0, 32 - count);
  const iterate = input => { let d = md5(input); for (let i = 0; i < 50; i++) { const next = md5(d); d.fill(0); d = next; } return d; };
  const ownerDigest = iterate(padding), owner = Buffer.from(user), roundKey = Buffer.alloc(16);
  const s = Buffer.alloc(256);
  try {
    for (let round = 0; round < 20; round++) {
      for (let i = 0; i < 16; i++) roundKey[i] = ownerDigest[i] ^ round;
      for (let i = 0; i < 256; i++) s[i] = i;
      let j = 0;
      for (let i = 0; i < 256; i++) { j = (j + s[i] + roundKey[i % 16]) & 255; [s[i], s[j]] = [s[j], s[i]]; }
      let i = 0; j = 0;
      for (let n = 0; n < owner.length; n++) {
        i = (i + 1) & 255; j = (j + s[i]) & 255; [s[i], s[j]] = [s[j], s[i]];
        owner[n] ^= s[(s[i] + s[j]) & 255];
      }
    }
    const joined = Buffer.concat([user, owner]);
    try { return iterate(joined); } finally { joined.fill(0); }
  } finally { user.fill(0); owner.fill(0); ownerDigest.fill(0); roundKey.fill(0); s.fill(0); }
}

export function checksum(bytes, little, initial = [0, 0]) {
  requireThat(bytes.length % 8 === 0, 'checksum_alignment');
  let [a, b] = initial;
  for (let i = 0; i < bytes.length; i += 8) {
    const x = little ? bytes.readUInt32LE(i) : bytes.readUInt32BE(i);
    const y = little ? bytes.readUInt32LE(i + 4) : bytes.readUInt32BE(i + 4);
    a = (a + x + b) >>> 0;
    b = (b + y + a) >>> 0;
  }
  return [a, b];
}

export function parseWal(wal) {
  if (!wal.length) return { pageSize: null, frames: [], committedFrames: 0, dbPages: null, salt: null, tail: 'empty' };
  requireThat(wal.length >= 32, 'wal_header_truncated');
  const magic = wal.readUInt32BE(0);
  requireThat(magic === 0x377f0682 || magic === 0x377f0683, 'wal_magic');
  requireThat(wal.readUInt32BE(4) === 3007000, 'wal_version');
  const little = magic === 0x377f0682;
  const pageSize = wal.readUInt32BE(8);
  requireThat(pageSize >= 512 && pageSize <= 65536 && (pageSize & (pageSize - 1)) === 0, 'wal_page_size');
  let sum = checksum(wal.subarray(0, 24), little);
  requireThat(sum[0] === wal.readUInt32BE(24) && sum[1] === wal.readUInt32BE(28), 'wal_header_checksum');
  const frames = [];
  let committedFrames = 0, dbPages = null, tail = 'none';
  let offset = 32;
  for (; offset + 24 + pageSize <= wal.length; offset += 24 + pageSize) {
    const frame = wal.subarray(offset, offset + 24 + pageSize);
    if (!frame.subarray(8, 16).equals(wal.subarray(16, 24))) { tail = 'salt_mismatch'; break; }
    const next = checksum(Buffer.concat([frame.subarray(0, 8), frame.subarray(24)]), little, sum);
    if (next[0] !== frame.readUInt32BE(16) || next[1] !== frame.readUInt32BE(20)) { tail = 'checksum_mismatch'; break; }
    const pgno = frame.readUInt32BE(0), commit = frame.readUInt32BE(4);
    if (!pgno || pgno > 0xfffffffe) { tail = 'invalid_page_number'; break; }
    sum = next;
    frames.push({ pgno, data: frame.subarray(24), commit });
    if (commit) { committedFrames = frames.length; dbPages = commit; }
  }
  if (tail === 'none' && offset !== wal.length) tail = 'partial_frame';
  return { pageSize, frames, committedFrames, dbPages, salt: wal.subarray(16, 24).toString('hex'), tail };
}

function ivForPage(pgno) {
  let z = pgno + 1;
  const seed = Buffer.alloc(16);
  for (let i = 0; i < 4; i++) {
    const q = Math.floor(z / 52774);
    z = 40692 * (z - 52774 * q) - 3791 * q;
    if (z < 0) z += 2147483399;
    seed.writeUInt32LE(z >>> 0, i * 4);
  }
  return md5(seed);
}

// Candidate algorithm, NOT a claim about the installed WeCom client.
export function cryptPage(page, rawKey, pgno, encrypt = false) {
  requireThat(rawKey.length === 16, 'candidate_key_length');
  requireThat(page.length >= 512 && page.length % 16 === 0, 'page_length');
  const n = Buffer.alloc(4); n.writeUInt32LE(pgno);
  const key = md5(Buffer.concat([rawKey, n, Buffer.from('sAlT')]));
  const run = bytes => {
    const cipher = encrypt ? crypto.createCipheriv('aes-128-cbc', key, ivForPage(pgno)) : crypto.createDecipheriv('aes-128-cbc', key, ivForPage(pgno));
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(bytes), cipher.final()]);
  };
  if (pgno !== 1) return run(page);
  const result = Buffer.from(page), fragment = Buffer.from(page.subarray(16, 24));
  if (encrypt) {
    run(page.subarray(0, 16)).copy(result, 0);
    run(page.subarray(16)).copy(result, 16);
    result.copy(result, 8, 16, 24);
    fragment.copy(result, 16);
  } else {
    result.copy(result, 16, 8, 16);
    run(result.subarray(16)).copy(result, 16);
    requireThat(result.subarray(16, 24).equals(fragment), 'candidate_rejected');
    header.copy(result);
    requireThat([2, 5, 10, 13].includes(result[100]), 'btree_header_rejected');
  }
  key.fill(0);
  return result;
}

export function reconstruct(db, wal, key) {
  const ps = db.readUInt16BE(16) || 0;
  const pageSize = ps === 1 ? 65536 : ps;
  requireThat(pageSize >= 512 && pageSize <= 65536 && (pageSize & (pageSize - 1)) === 0, 'db_page_size');
  requireThat(db.length % pageSize === 0, 'db_partial_page');
  requireThat(!wal.pageSize || wal.pageSize === pageSize, 'wal_db_page_size_mismatch');
  const count = wal.dbPages ?? db.length / pageSize;
  requireThat(count * pageSize <= 512 * 1024 * 1024, 'database_size_limit');
  const latest = new Map(wal.frames.slice(0, wal.committedFrames).map(f => [f.pgno, f.data]));
  const result = Buffer.alloc(count * pageSize);
  for (let pgno = 1; pgno <= count; pgno++) {
    const page = latest.get(pgno) ?? db.subarray((pgno - 1) * pageSize, pgno * pageSize);
    requireThat(page.length === pageSize, 'missing_committed_page');
    cryptPage(page, key, pgno).copy(result, (pgno - 1) * pageSize);
  }
  // A fully merged in-memory snapshot has no WAL sidecar.
  result[18] = 1; result[19] = 1;
  return result;
}
