import {createHash, randomBytes} from 'node:crypto';
import {mkdirSync, openSync, closeSync, fchmodSync, constants} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

export const digest = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
const tokenHash = token => createHash('sha256').update(token).digest('hex');
export const indexPath = () => join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'wecom-local', 'context.sqlite');
const segmenter = new Intl.Segmenter('zh', {granularity: 'word'});
const searchText = text => text.normalize('NFKC').toLowerCase();

function terms(query) {
  const input = searchText(query.trim());
  return [...new Set([
    ...input.split(/[^\p{L}\p{N}_-]+/u).filter(Boolean),
    ...[...segmenter.segment(input)].filter(part => part.isWordLike).map(part => part.segment),
  ])].filter(word => [...word].length > 1).slice(0, 16);
}

function evidenceFilter(filters = {}, at = 'at') {
  const clauses = [];
  const values = [];
  if (filters.from !== undefined) { clauses.push(`${at}>=?`); values.push(filters.from); }
  if (filters.to !== undefined) { clauses.push(`${at}<?`); values.push(filters.to); }
  if (filters.conversationId !== undefined) {
    clauses.push('conversation=?');
    values.push(filters.conversationId);
  } else if (filters.conversation !== undefined) {
    clauses.push("json_extract(source,'$.group') COLLATE NOCASE=?");
    values.push(filters.conversation);
  }
  if (filters.sender !== undefined) {
    clauses.push("(json_extract(source,'$.sender') COLLATE NOCASE=? OR json_extract(source,'$.person')=?)");
    values.push(filters.sender, filters.sender);
  }
  return {where: clauses.length ? ' AND ' + clauses.join(' AND ') : '', values};
}

export class ContextStore {
  constructor(path, {readOnly = false} = {}) {
    if (readOnly) {
      this.db = new DatabaseSync(path, {readOnly: true});
      this.db.exec('PRAGMA busy_timeout=3000; PRAGMA query_only=ON;');
      return;
    }
    mkdirSync(dirname(path), {recursive: true, mode: 0o700});
    const fd = openSync(path, constants.O_CREAT | constants.O_NOFOLLOW | constants.O_RDWR, 0o600);
    try { fchmodSync(fd, 0o600); } finally { closeSync(fd); }
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout=3000;
      PRAGMA journal_mode=WAL;
      PRAGMA secure_delete=ON;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS scope(
        workspace TEXT PRIMARY KEY, profile TEXT NOT NULL, groups TEXT NOT NULL,
        days INTEGER NOT NULL, generation TEXT NOT NULL, indexed INTEGER, coverage TEXT
      );
      CREATE TABLE IF NOT EXISTS index_snapshot(
        workspace TEXT PRIMARY KEY REFERENCES scope(workspace) ON DELETE CASCADE,
        indexed INTEGER NOT NULL, version TEXT NOT NULL, expires INTEGER, windows TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS image_access(
        workspace TEXT PRIMARY KEY REFERENCES scope(workspace) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS external_access(
        id TEXT PRIMARY KEY, workspace TEXT NOT NULL REFERENCES scope(workspace) ON DELETE CASCADE,
        label TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS external_access_workspace ON external_access(workspace);
      CREATE TABLE IF NOT EXISTS index_lease(
        slot INTEGER PRIMARY KEY CHECK(slot=1), owner TEXT NOT NULL, workspace TEXT NOT NULL,
        generation TEXT NOT NULL, expires INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entry(
        id INTEGER PRIMARY KEY, workspace TEXT NOT NULL, ref TEXT NOT NULL,
        conversation TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL,
        body TEXT NOT NULL, normalized TEXT NOT NULL, source TEXT NOT NULL,
        UNIQUE(workspace,ref)
      );
      CREATE INDEX IF NOT EXISTS entry_timeline ON entry(workspace,conversation,at DESC,ref DESC);
      CREATE INDEX IF NOT EXISTS entry_media ON entry(workspace,conversation,kind,at);
      DROP TABLE IF EXISTS ticket_evidence;
      CREATE TABLE IF NOT EXISTS entry_resource(
        workspace TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL,
        entry_id INTEGER NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
        PRIMARY KEY(workspace,kind,key,entry_id)
      );
      CREATE INDEX IF NOT EXISTS entry_resource_entry ON entry_resource(entry_id);
      CREATE TABLE IF NOT EXISTS media_extract(
        workspace TEXT NOT NULL, ref TEXT NOT NULL, version TEXT NOT NULL, segments TEXT NOT NULL,
        PRIMARY KEY(workspace,ref)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS entry_fts USING fts5(normalized, content='entry', content_rowid='id', tokenize='trigram');
      CREATE TRIGGER IF NOT EXISTS entry_insert AFTER INSERT ON entry BEGIN
        INSERT INTO entry_fts(rowid,normalized) VALUES(new.id,new.normalized);
      END;
      CREATE TRIGGER IF NOT EXISTS entry_delete AFTER DELETE ON entry BEGIN
        INSERT INTO entry_fts(entry_fts,rowid,normalized) VALUES('delete',old.id,old.normalized);
      END;
      CREATE TABLE IF NOT EXISTS evidence_source(
        workspace TEXT NOT NULL REFERENCES scope(workspace) ON DELETE CASCADE,
        ref TEXT NOT NULL, source TEXT NOT NULL, PRIMARY KEY(workspace,ref)
      );
      CREATE INDEX IF NOT EXISTS evidence_source_ref ON evidence_source(ref);
      CREATE TABLE IF NOT EXISTS memory(
        workspace TEXT NOT NULL, id TEXT NOT NULL, state TEXT NOT NULL,
        conversation TEXT NOT NULL, note TEXT NOT NULL, source TEXT NOT NULL,
        created INTEGER NOT NULL, confirmed INTEGER, PRIMARY KEY(workspace,id)
      );
      CREATE INDEX IF NOT EXISTS memory_state ON memory(workspace,state,created DESC);
    `);
  }

  transaction(action, begin = 'BEGIN IMMEDIATE') {
    this.db.exec(begin);
    try {
      const value = action();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  read(action) { return this.db.isTransaction ? action() : this.transaction(action, 'BEGIN'); }

  claimIndex(scope, owner, now = Date.now()) {
    return this.transaction(() => {
      if (this.scope(scope.workspace)?.generation !== scope.generation) throw Error('agent_scope_changed');
      const running = this.db.prepare(`SELECT 1 FROM index_lease l JOIN scope s
        ON s.workspace=l.workspace AND s.generation=l.generation WHERE l.expires>?`).get(now);
      if (running) return false;
      this.db.prepare('INSERT OR REPLACE INTO index_lease VALUES(1,?,?,?,?)')
        .run(owner, scope.workspace, scope.generation, now + 60_000);
      return true;
    });
  }

  renewIndex(owner, now = Date.now()) {
    return this.db.prepare(`UPDATE index_lease SET expires=? WHERE owner=? AND expires>?
      AND EXISTS(SELECT 1 FROM scope s WHERE s.workspace=index_lease.workspace AND s.generation=index_lease.generation)`)
      .run(now + 60_000, owner, now).changes === 1;
  }

  indexRunning(workspace) {
    return Boolean(this.db.prepare(`SELECT 1 FROM index_lease l JOIN scope s ON
      s.workspace=l.workspace AND s.generation=l.generation WHERE l.workspace=? AND l.expires>?`).get(workspace, Date.now()));
  }

  releaseIndex(owner) {
    this.db.prepare('DELETE FROM index_lease WHERE owner=?').run(owner);
  }

  externalGrants(workspace) {
    return this.db.prepare('SELECT id,label,created FROM external_access WHERE workspace=? ORDER BY created DESC').all(workspace);
  }

  grantExternal(workspace, label) {
    return this.transaction(() => {
      if (!this.scope(workspace)) throw Error('agent_scope_required');
      if (this.externalGrants(workspace).length >= 16) throw Error('agent_grant_limit');
      const id = randomBytes(16).toString('hex');
      const token = randomBytes(32).toString('base64url');
      this.db.prepare('INSERT INTO external_access VALUES(?,?,?,?,?)').run(id, workspace, label, tokenHash(token), Date.now());
      return {id, token};
    });
  }

  revokeExternal(workspace, id) {
    return this.db.prepare('DELETE FROM external_access WHERE workspace=? AND id=?').run(workspace, id).changes === 1;
  }

  externalQuery(token, query) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw Error('messagegraph_access_required');
    return this.read(() => {
      const grant = this.db.prepare('SELECT workspace FROM external_access WHERE token_hash=?').get(tokenHash(token));
      if (!grant) throw Error('messagegraph_access_required');
      return query(grant.workspace);
    });
  }

  scope(workspace) {
    const row = this.db.prepare('SELECT * FROM scope WHERE workspace=?').get(workspace);
    return row && {...row, groups: JSON.parse(row.groups), coverage: row.coverage ? JSON.parse(row.coverage) : null};
  }

  allowsImages(workspace) {
    return Boolean(this.db.prepare('SELECT 1 FROM image_access WHERE workspace=?').get(workspace));
  }

  configure(workspace, profile, groups, days, allowImages = false) {
    return this.transaction(() => {
      const prior = this.scope(workspace);
      const generation = digest(workspace, profile, groups, days, Date.now(), Math.random());
      if (prior?.profile === profile && prior.days === days && JSON.stringify(prior.groups) === JSON.stringify(groups)) {
        if (allowImages === this.allowsImages(workspace)) return prior;
        this.db.prepare('UPDATE scope SET generation=? WHERE workspace=?').run(generation, workspace);
        this.setImages(workspace, allowImages);
        return this.scope(workspace);
      }
      this.db.prepare('DELETE FROM entry WHERE workspace=?').run(workspace);
      this.db.prepare('DELETE FROM media_extract WHERE workspace=?').run(workspace);
      if (!groups.length || prior?.profile !== profile) this.db.prepare('DELETE FROM memory WHERE workspace=?').run(workspace);
      else this.db.prepare('DELETE FROM memory WHERE workspace=? AND conversation NOT IN (SELECT value FROM json_each(?))')
        .run(workspace, JSON.stringify(groups));
      if (groups.length) this.db.prepare('INSERT OR REPLACE INTO scope VALUES(?,?,?,?,?,NULL,NULL)')
        .run(workspace, profile, JSON.stringify(groups), days, generation);
      else this.db.prepare('DELETE FROM scope WHERE workspace=?').run(workspace);
      this.setImages(workspace, groups.length > 0 && allowImages);
      return this.scope(workspace);
    });
  }

  setImages(workspace, enabled) {
    this.db.prepare(enabled ? 'INSERT OR IGNORE INTO image_access VALUES(?)' : 'DELETE FROM image_access WHERE workspace=?')
      .run(workspace);
  }

  indexTargets() {
    return this.db.prepare(`SELECT s.workspace,s.profile,c.version,c.expires FROM scope s
      LEFT JOIN index_snapshot c ON c.workspace=s.workspace AND c.indexed=s.indexed ORDER BY s.indexed,s.workspace`).all();
  }

  checkpoint(scope) {
    const row = this.db.prepare('SELECT version,expires,windows FROM index_snapshot WHERE workspace=? AND indexed=?')
      .get(scope.workspace, scope.indexed);
    return row && {...row, windows: new Map(JSON.parse(row.windows))};
  }

  publish(scope, entries, coverage, extracts = new Map(), owner, snapshot) {
    return this.transaction(() => {
      const live = this.scope(scope.workspace);
      if (live?.generation !== scope.generation || live.indexed !== scope.indexed) return false;
      if (owner && !this.db.prepare('SELECT 1 FROM index_lease WHERE owner=? AND expires>?').get(owner, Date.now()))
        return false;
      const changed = snapshot?.changed;
      const rows = changed ? (changed.size ? this.db.prepare(`SELECT id,ref,body,source FROM entry WHERE workspace=?
        AND conversation IN (SELECT value FROM json_each(?))`).all(scope.workspace, JSON.stringify([...changed])) : [])
        : this.db.prepare('SELECT id,ref,body,source FROM entry WHERE workspace=?').all(scope.workspace);
      const current = new Map(rows.map(row => [row.ref, row]));
      const remove = this.db.prepare('DELETE FROM entry WHERE id=?');
      const insert = this.db.prepare('INSERT INTO entry(workspace,ref,conversation,at,kind,body,normalized,source) VALUES(?,?,?,?,?,?,?,?)');
      const link = this.db.prepare('INSERT INTO entry_resource VALUES(?,?,?,?)');
      for (const {source, body} of entries) {
        const prior = current.get(source.ref);
        current.delete(source.ref);
        const serialized = JSON.stringify(source);
        if (prior?.body === body && prior.source === serialized) continue;
        if (prior) remove.run(prior.id);
        const entryId = insert.run(scope.workspace, source.ref, source.conversation,
          source.time, source.kind, body, searchText(body), serialized).lastInsertRowid;
        for (const {kind, key} of source.resources ?? []) link.run(scope.workspace, kind, key, entryId);
      }
      for (const row of current.values()) remove.run(row.id);
      const saveExtract = this.db.prepare(`INSERT INTO media_extract VALUES(?,?,?,?)
        ON CONFLICT(workspace,ref) DO UPDATE SET version=excluded.version,segments=excluded.segments
        WHERE media_extract.version<>excluded.version`);
      const removeExtract = this.db.prepare('DELETE FROM media_extract WHERE workspace=? AND ref=?');
      const stale = changed ? snapshot.staleExtracts : this.db.prepare('SELECT ref FROM media_extract WHERE workspace=?')
        .all(scope.workspace).map(row => row.ref);
      for (const ref of stale) if (!extracts.has(ref)) removeExtract.run(scope.workspace, ref);
      for (const [ref, {version, segments}] of extracts)
        saveExtract.run(scope.workspace, ref, version, JSON.stringify(segments));
      const indexed = Date.now();
      this.db.prepare('UPDATE scope SET indexed=?,coverage=? WHERE workspace=?')
        .run(indexed, JSON.stringify(coverage), scope.workspace);
      if (snapshot) this.db.prepare('INSERT OR REPLACE INTO index_snapshot VALUES(?,?,?,?,?)')
        .run(scope.workspace, indexed, snapshot.version, snapshot.expires, JSON.stringify([...snapshot.windows]));
      else this.db.prepare('DELETE FROM index_snapshot WHERE workspace=?').run(scope.workspace);
      return true;
    });
  }

  mediaExtract(workspace, ref, version) {
    const row = this.db.prepare('SELECT segments FROM media_extract WHERE workspace=? AND ref=? AND version=?')
      .get(workspace, ref, version);
    return row && JSON.parse(row.segments);
  }

  resourceEvidence(workspace, {kind, key}, exceptConversation, limit, filters, exclude) {
    const {where, values} = evidenceFilter(filters, 'e.at');
    const excluded = exclude ? " AND (e.conversation<>? OR json_extract(e.source,'$.id')<>?)" : '';
    // One representative per conversation so a busy chat cannot crowd out other sources.
    return this.db.prepare(`WITH matched AS (
      SELECT e.body,e.source,e.at,e.ref,
        row_number() OVER (PARTITION BY e.conversation ORDER BY e.at DESC,e.ref DESC) AS rank
      FROM entry_resource r JOIN entry e ON e.id=r.entry_id AND e.workspace=r.workspace
      WHERE r.workspace=? AND r.kind=? AND r.key=? AND e.conversation<>?${where}${excluded}
    ) SELECT body,source FROM matched WHERE rank=1 ORDER BY at DESC,ref DESC LIMIT ?`)
      .all(workspace, kind, key, exceptConversation, ...values, ...(exclude ? [exclude.conversation, exclude.id] : []), limit)
      .map(row => ({text: row.body, source: JSON.parse(row.source)}));
  }

  messageResources(workspace, source) {
    return this.db.prepare(`SELECT r.kind,r.key FROM entry_resource r JOIN entry e ON e.id=r.entry_id AND e.workspace=r.workspace
      WHERE e.workspace=? AND e.conversation=? AND json_extract(e.source,'$.id')=?
        AND json_extract(e.source,'$.fingerprint')=? AND r.kind IN ('shared_link','shared_attachment')
      GROUP BY r.kind,r.key ORDER BY r.kind,r.key LIMIT 12`)
      .all(workspace, source.conversation, source.id, source.fingerprint);
  }

  entityEvidence(workspace, query, limit, filters) {
    const {where, values} = evidenceFilter(filters);
    return this.db.prepare(`SELECT body,source,CASE WHEN json_extract(source,'$.person')=? OR
      lower(json_extract(source,'$.sender'))=? THEN 'sender' ELSE 'conversation' END AS reason
      FROM entry WHERE workspace=? AND (json_extract(source,'$.person')=? OR
      lower(json_extract(source,'$.sender'))=? OR lower(json_extract(source,'$.group'))=?)${where}
      ORDER BY at DESC,ref DESC LIMIT ?`)
      .all(query, query, workspace, query, query, query, ...values, limit)
      .map(row => ({text: row.body, source: JSON.parse(row.source), reason: row.reason}));
  }

  nearbyMedia(workspace, source, kind, limit, filters) {
    const {where, values} = evidenceFilter(filters);
    return this.db.prepare(`SELECT body,source FROM entry WHERE workspace=? AND conversation=?
      AND kind IN ('image','voice') AND (?='' OR kind=?) AND at BETWEEN ? AND ?${where}
      ORDER BY abs(at-?),at,ref LIMIT ?`)
      .all(workspace, source.conversation, kind, kind, source.time - 90, source.time + 90, ...values, source.time, limit)
      .map(row => ({text: row.body, source: JSON.parse(row.source)}));
  }

  search(workspace, query, kind, limit, filters) {
    const {where, values} = evidenceFilter(filters);
    const words = terms(query);
    if (!words.length && query.trim()) words.push(searchText(query.trim()));
    if (!words.length) return where ? this.db.prepare(`SELECT body,source FROM entry WHERE workspace=?
      AND (?='' OR kind=?)${where} ORDER BY at DESC,ref DESC LIMIT ?`)
      .all(workspace, kind, kind, ...values, limit)
      .map(row => ({text: row.body, source: JSON.parse(row.source), reason: 'filter'})) : [];
    const long = words.filter(word => [...word].length >= 3);
    const short = words.filter(word => [...word].length < 3);
    const predicates = [];
    const arguments_ = [];
    if (long.length) {
      predicates.push('id IN (SELECT rowid FROM entry_fts WHERE entry_fts MATCH ?)');
      arguments_.push(long.map(word => `"${word.replaceAll('"', '""')}"`).join(' OR '));
    }
    for (const word of short) {
      predicates.push('instr(normalized,?)>0');
      arguments_.push(word);
    }
    const score = words.map(() => '(instr(normalized,?)>0)').join('+');
    return this.db.prepare(`SELECT body,source FROM entry WHERE workspace=? AND (?='' OR kind=?)
      AND (${predicates.join(' OR ')})${where} ORDER BY (instr(normalized,?)>0) DESC, ${score} DESC,at DESC,ref DESC LIMIT ?`)
      .all(workspace, kind, kind, ...arguments_, ...values, searchText(query.trim()), ...words, limit)
      .map(row => ({text: row.body, source: JSON.parse(row.source)}));
  }

  registerEvidence(scope, sources) {
    this.transaction(() => {
      if (this.scope(scope.workspace)?.generation !== scope.generation) throw Error('agent_scope_changed');
      const save = this.db.prepare('INSERT OR IGNORE INTO evidence_source VALUES(?,?,?)');
      for (const source of sources) {
        const {ref, profile, conversation, conversationRef, conversationType, group, id, fingerprint, time,
          sender, kind, person, part, startMs, endMs, mediaState} = source;
        const locator = {ref, profile, conversation, conversationRef, conversationType, group, id, fingerprint, time,
          sender, kind, person, part, startMs, endMs, mediaState, original: true};
        save.run(scope.workspace, ref, JSON.stringify(locator));
      }
    });
  }

  source(workspace, ref, includePending = false) {
    const entry = this.db.prepare('SELECT source FROM entry WHERE workspace=? AND ref=?').get(workspace, ref);
    if (entry) return JSON.parse(entry.source);
    const locator = this.db.prepare('SELECT source FROM evidence_source WHERE workspace=? AND ref=?').get(workspace, ref);
    if (locator) return JSON.parse(locator.source);
    const row = this.db.prepare(`SELECT source FROM memory WHERE workspace=? AND (state='confirmed' OR ?)
      AND json_extract(source,'$.ref')=? LIMIT 1`).get(workspace, Number(includePending), ref);
    return row && JSON.parse(row.source);
  }

  ownerWorkspace(ref) {
    return this.db.prepare(`SELECT workspace FROM entry WHERE ref=? UNION
      SELECT workspace FROM evidence_source WHERE ref=? UNION
      SELECT workspace FROM memory WHERE json_extract(source,'$.ref')=? LIMIT 1`).get(ref, ref, ref)?.workspace;
  }

  memories(workspace, query, includePending = false, limit = 50, filters) {
    const {where, values} = evidenceFilter(filters, "CAST(json_extract(source,'$.time') AS INTEGER)");
    const words = terms(query);
    return this.db.prepare(`SELECT id,state,note,source,created,confirmed FROM memory
      WHERE workspace=? AND (state='confirmed' OR ?)${where} ORDER BY created DESC LIMIT 500`)
      .all(workspace, Number(includePending), ...values).map(row => {
        const source = JSON.parse(row.source);
        const body = searchText(`${row.note} ${source.group}`);
        const score = words.filter(word => body.includes(word)).length;
        return {...row, source, score};
      }).filter(row => !query || row.score).sort((a, b) => b.score - a.score)
      .slice(0, limit).map(({score: _, ...row}) => row);
  }

  propose(workspace, note, source) {
    const id = digest(workspace, source.ref, note);
    this.db.prepare(`INSERT OR IGNORE INTO memory(workspace,id,state,conversation,note,source,created) VALUES(?,?,'pending',?,?,?,?)`)
      .run(workspace, id, source.conversation, note, JSON.stringify(source), Date.now());
    return this.memory(workspace, id);
  }

  memory(workspace, id) {
    const row = this.db.prepare('SELECT * FROM memory WHERE workspace=? AND id=?').get(workspace, id);
    return row && {...row, source: JSON.parse(row.source)};
  }

  confirm(workspace, id) {
    return this.db.prepare(`UPDATE memory SET state='confirmed',confirmed=? WHERE workspace=? AND id=? AND state='pending'`)
      .run(Date.now(), workspace, id).changes === 1;
  }

  remove(workspace, id, state) {
    return this.db.prepare('DELETE FROM memory WHERE workspace=? AND id=? AND state=?').run(workspace, id, state).changes === 1;
  }

  close() { this.db.close(); }
}
