import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { bootstrapMirror, planIncremental } from './storage/mirror.mjs';
import { Catalog, requiredTables } from './catalog';
import { MediaCache } from './media';
import { deriveKey, matchesKey, readFirstPage, type Source } from './discovery';
import type { DatabaseExport, SyncState } from './types';

const maxFileBytes = 512 * 1024 * 1024;
const settleMs = 1250;
const maxBatchMs = 5000;
const retryMs = 3000;
const zero = { contacts: 0, conversations: 0, messages: 0 };
type Stamp = { token: string; size: number };
type MirrorState = ReturnType<typeof bootstrapMirror>['state'];
interface Mirror {
  bytes: Buffer;
  state: MirrorState;
  db: Database;
  signature: string;
}

function stamp(file: string): Stamp | null {
  try {
    const s = fs.lstatSync(file, { bigint: true });
    if (!s.isFile()) throw Error('unsafe_source_file');
    if (s.size > maxFileBytes) throw Error('source_too_large');
    return { token: `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`, size: Number(s.size) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function inspect(file: string) {
  const main = stamp(file);
  const wal = stamp(file + '-wal');
  return { main, wal, signature: `${main?.token ?? '-'}|${wal?.token ?? '-'}` };
}

const version = (token: string) => createHash('sha256').update(token).digest('hex');

export function sourceVersion(source: Source) {
  const files = new Set([source.message, source.conversation, source.contact]);
  return version(JSON.stringify([...files].flatMap(file => file ? [inspect(file).signature] : [])));
}

function read(file: string, expected: Stamp): Buffer {
  const fd = fs.openSync(file, 'r');
  try {
    const s = fs.fstatSync(fd, { bigint: true });
    if (!s.isFile() || `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}` !== expected.token)
      throw Error('source_changed');
    const buffer = Buffer.alloc(expected.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!count) throw Error('source_changed');
      offset += count;
    }
    return buffer;
  } finally { fs.closeSync(fd); }
}

function dispose(mirror: Mirror) {
  mirror.db.close();
  mirror.bytes.fill(0);
}

function stage(file: string, table: string, current: ReturnType<typeof inspect>, key: Buffer, prior?: Mirror): Mirror {
  if (!current.main) throw Error('database_missing');
  const db = read(file, current.main);
  const wal = current.wal ? read(file + '-wal', current.wal) : Buffer.alloc(0);
  let bytes: Buffer;
  let state: MirrorState;
  if (prior) {
    const plan = planIncremental(db, wal, key, prior.state);
    if (!plan.patches.size && plan.targetPages === prior.state.dbPages)
      return { ...prior, state: plan.nextState, signature: current.signature };
    bytes = Buffer.alloc(plan.targetPages * plan.nextState.pageSize);
    prior.bytes.copy(bytes);
    for (const [pgno, patch] of plan.patches) {
      patch.copy(bytes, (pgno - 1) * plan.nextState.pageSize);
      patch.fill(0);
    }
    state = plan.nextState;
  } else {
    ({mirror: bytes, state} = bootstrapMirror(db, wal, key));
  }

  let connection: Database | undefined;
  try {
    connection = Database.deserialize(bytes, {readonly: true, safeIntegers: true});
    connection.exec('PRAGMA temp_store=MEMORY; PRAGMA trusted_schema=OFF; PRAGMA query_only=ON');
    if (!connection.query('SELECT 1 FROM sqlite_schema WHERE type=? AND upper(name)=upper(?)').get('table', table))
      throw Error('unsupported_schema');
    const checks = connection.query<{ integrity_check: string }, []>(`PRAGMA integrity_check('${table}')`).all();
    if (checks.length !== 1 || checks[0].integrity_check !== 'ok') throw Error('sqlite_integrity_failed');
    return { bytes, state, db: connection, signature: current.signature };
  } catch (error) {
    connection?.close();
    bytes.fill(0);
    throw error;
  }
}

export function errorCode(error: unknown): string {
  if (!(error instanceof Error)) return 'source_unreadable';
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return 'database_missing';
  if (code && ['EACCES', 'EPERM', 'EBUSY', 'EAGAIN'].includes(code)) return 'source_busy';
  if (code?.startsWith('SQLITE')) return 'sqlite_integrity_failed';
  return /^[a-z][a-z_]{2,60}$/.test(error.message) ? error.message : 'source_unreadable';
}

export class Synchronizer {
  private source?: Source;
  private media?: MediaCache;
  private key?: Buffer;
  private snapshots = new Map<string, Mirror>();
  private seen = '';
  private firstChange = 0;
  private lastChange = 0;
  private retryAt = 0;
  private applied = '';
  private lastWarnings: string[] = [];
  private timer?: ReturnType<typeof setInterval>;
  catalog?: Catalog;
  state: SyncState = {phase: 'idle', profile: null, revision: 0, updatedAt: null, issues: [], counts: zero};

  get contextVersion() { return this.applied ? version(this.applied) : null; }

  start(source: Source) {
    if (!source.profile.available || !source.candidates[0]) throw Error('vid_not_verified');
    const key = deriveKey(source.candidates[0]);
    this.close();
    this.source = source;
    if (source.profile.platform === 'macos') this.media = new MediaCache(path.dirname(path.dirname(source.message)), source.dataRoot);
    this.key = key;
    this.state.profile = source.profile.id;
    this.state.phase = 'syncing';
    this.timer = setInterval(() => this.tick(), 1000);
    // Return the selected state before doing the initial decryption.
    queueMicrotask(() => this.tick());
    return this.state;
  }

  pause(paused: boolean) {
    if (!this.source) return this.state;
    this.state.phase = paused ? 'paused' : this.catalog ? 'ready' : 'syncing';
    if (!paused) {
      this.firstChange = this.lastChange = this.retryAt = 0;
      queueMicrotask(() => this.tick());
    }
    return this.state;
  }

  exportDatabases(profile: string, destination: string): DatabaseExport {
    if (profile !== this.state.profile) throw Error('export_profile_changed');
    if (!this.source || !this.state.updatedAt || !this.snapshots.has(this.source.message))
      throw Error('export_not_ready');

    const files = [...this.snapshots].map(([source, mirror]) => ({
      name: path.basename(source), bytes: mirror.bytes,
    }));
    let staging: string | undefined;
    try {
      const directory = fs.realpathSync(destination);
      let sourceRoot = path.resolve(this.source.dataRoot);
      try { sourceRoot = fs.realpathSync(sourceRoot); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const relative = path.relative(sourceRoot, directory);
      if (!relative || (!path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..'))
        throw Error('export_inside_source');

      staging = fs.mkdtempSync(path.join(directory, '.wecom-export-'));
      const timestamp = this.state.updatedAt.replace(/[-:]/g, '').slice(0, 15).replace('T', '-');
      const suffix = path.basename(staging).slice('.wecom-export-'.length);
      const output = path.join(directory, `wecom-db-${timestamp}-${suffix}`);
      if (fs.existsSync(output)) throw Error('export_failed');
      for (const file of files)
        fs.writeFileSync(path.join(staging, file.name), file.bytes, {mode: 0o600, flag: 'wx'});
      fs.renameSync(staging, output);
      staging = undefined;
      return {directory: output, files: files.map(file => file.name), capturedAt: this.state.updatedAt};
    } catch (error) {
      if (error instanceof Error && error.message === 'export_inside_source') throw error;
      throw Error('export_failed');
    } finally {
      if (staging) fs.rmSync(staging, {recursive: true, force: true});
    }
  }

  close() {
    clearInterval(this.timer);
    this.timer = undefined;
    this.catalog = undefined;
    for (const value of this.snapshots.values()) dispose(value);
    this.snapshots.clear();
    this.key?.fill(0);
    this.key = undefined;
    this.source = undefined;
    this.media = undefined;
    this.seen = this.applied = '';
    this.lastWarnings = [];
    this.firstChange = this.lastChange = this.retryAt = 0;
    this.state = {phase: 'idle', profile: null, revision: this.state.revision + 1, updatedAt: null, issues: [], counts: zero};
  }

  tick(now = Date.now()) {
    const source = this.source, key = this.key;
    if (!source || !key || this.state.phase === 'paused' || now < this.retryAt) return;
    const schema = requiredTables(source.profile.platform);
    const sources = new Map([[source.message, schema.message as string]]);
    if (source.conversation && source.conversation !== source.message) sources.set(source.conversation, schema.conversation);
    if (source.contact) sources.set(source.contact, schema.contact);
    const staged = new Map<string, Mirror>();
    try {
      const stamps = new Map([...sources.keys()].map(file => [file, inspect(file)]));
      const token = JSON.stringify([...stamps.values()].map(value => value.signature));
      if (token === this.applied) {
        if (this.state.phase === 'retrying') this.state = { ...this.state, phase: 'ready', issues: this.lastWarnings };
        this.firstChange = this.lastChange = 0;
        return;
      }
      if (token !== this.seen) {
        if (!this.firstChange) this.firstChange = now;
        this.lastChange = now;
        this.seen = token;
      }
      if (this.catalog && now - this.lastChange < settleMs && now - this.firstChange < maxBatchMs) return;

      const warnings: string[] = [];
      for (const [file, table] of sources) {
        const current = stamps.get(file)!;
        const previous = this.snapshots.get(file);
        if (!current.main) {
          if (file === source.message || previous) throw Error('database_missing');
          warnings.push(file === source.contact ? 'contacts_missing' : 'conversations_missing');
          continue;
        }
        if (previous?.signature === current.signature) {
          staged.set(file, previous);
          continue;
        }
        if (!matchesKey(readFirstPage(file), key)) {
          if (file === source.message || previous) throw Error('vid_not_verified');
          warnings.push(file === source.contact ? 'contacts_key_unverified' : 'conversations_key_unverified');
          continue;
        }
        staged.set(file, stage(file, table, current, key, previous));
      }

      for (const [file, value] of stamps)
        if (inspect(file).signature !== value.signature) throw Error('source_changed');

      const messages = staged.get(source.message)!;
      const conversations = source.conversation ? staged.get(source.conversation) : undefined;
      const contacts = source.contact ? staged.get(source.contact) : undefined;
      const changed = !this.catalog || [...staged].some(([file, value]) => this.snapshots.get(file)?.db !== value.db);
      if (conversations && source.conversation === source.message &&
          !conversations.db.query("SELECT 1 FROM sqlite_schema WHERE type='table' AND upper(name)=?").get(schema.conversation))
        warnings.push('conversations_missing');
      const catalog = changed ? new Catalog(
        source.profile.platform, messages.db,
        warnings.includes('conversations_missing') ? undefined : conversations?.db, contacts?.db,
        source.candidates[0], this.media,
      ) : this.catalog!;

      for (const [file, value] of this.snapshots)
        if (staged.get(file)?.db !== value.db) dispose(value);
      this.snapshots = staged;
      this.catalog = catalog;
      this.applied = token;
      this.lastWarnings = warnings;
      this.firstChange = this.lastChange = 0;
      this.state = {
        phase: 'ready', profile: source.profile.id,
        revision: this.state.revision + (changed ? 1 : 0),
        updatedAt: new Date().toISOString(), issues: warnings, counts: catalog.counts,
      };
    } catch (error) {
      for (const [file, value] of staged)
        if (this.snapshots.get(file)?.db !== value.db) dispose(value);
      this.retryAt = now + retryMs;
      this.state.phase = 'retrying';
      this.state.issues = [errorCode(error)];
    }
  }
}
