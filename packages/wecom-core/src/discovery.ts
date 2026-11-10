import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cryptPage, deriveWxPassword } from './storage/wxsqlite.mjs';
import { companyIdentity, corpVids } from './protobuf';
import type { Platform, Profile } from './types';

export interface Source {
  profile: Profile;
  dataRoot: string;
  message: string;
  conversation?: string;
  contact?: string;
  candidates: string[];
}

export function validVid(value: string): boolean {
  return /^\d{1,20}$/.test(value) && BigInt(value) > 0n && BigInt(value) <= 0xffff_ffff_ffff_ffffn;
}

function entries(root: string) {
  try { return fs.readdirSync(root, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function regular(file: string): boolean {
  try { return fs.lstatSync(file).isFile(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function metadataVids(file: string): string[] {
  try {
    if (!regular(file) || fs.statSync(file).size > 1024 * 1024) return [];
    return [...corpVids(fs.readFileSync(file, 'utf8'))];
  } catch { return []; }
}

function profileIdentity(file: string) {
  try {
    if (!regular(file) || fs.statSync(file).size > 2 * 1024 * 1024) return;
    return companyIdentity(fs.readFileSync(file, 'utf8'));
  } catch { return undefined; }
}

function macVids(root: string): string[] {
  let last = '';
  try {
    last = execFileSync('/usr/bin/plutil', ['-extract', 'wew_last_vid', 'raw', '-o', '-',
      path.join(root, 'Library', 'Preferences', 'com.tencent.WeWorkMac.plist')],
      { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { /* older or missing preferences */ }
  const documents = path.join(root, 'Documents');
  const names = entries(path.join(documents, 'cefcache')).map(entry => /^wew_(\d+)$/.exec(entry.name)?.[1] ?? '');
  return [last, ...names, ...metadataVids(path.join(documents, 'Profiles', 'othercorp_setting.json'))];
}

export function readFirstPage(file: string): Buffer {
  const fd = fs.openSync(file, 'r');
  try {
    const prefix = Buffer.alloc(24);
    if (fs.readSync(fd, prefix, 0, prefix.length, 0) !== prefix.length) throw Error('database_too_small');
    const field = prefix.readUInt16BE(16);
    const size = field === 1 ? 65536 : field;
    if (size < 512 || size > 65536 || (size & (size - 1))) throw Error('database_page_size');
    const page = Buffer.alloc(size);
    if (fs.readSync(fd, page, 0, size, 0) !== size) throw Error('database_partial_page');
    return page;
  } finally { fs.closeSync(fd); }
}

export function deriveKey(vid: string): Buffer {
  if (!validVid(vid)) throw Error('invalid_vid');
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(vid));
  try { return deriveWxPassword(bytes); }
  finally { bytes.fill(0); }
}

export function matchesKey(page: Buffer, key: Buffer): boolean {
  try {
    const plain = cryptPage(page, key, 1);
    try {
      return [1, 2].includes(plain[18]) && [1, 2].includes(plain[19]) &&
        plain[20] === 0 && plain[21] === 64 && plain[22] === 32 && plain[23] === 32;
    } finally { plain.fill(0); }
  } catch (error) {
    if (error instanceof Error && ['candidate_rejected', 'btree_header_rejected'].includes(error.message))
      return false;
    throw error;
  }
}

export function discover(platform: Platform, documents?: string, rootOverride?: string): Source[] {
  const root = platform === 'macos' ?
    path.join(os.homedir(), 'Library', 'Containers', 'com.tencent.WeWorkMac', 'Data') :
    rootOverride ?? path.join(documents ?? path.join(os.homedir(), 'Documents'), 'WXWork');
  const mac = platform === 'macos';
  const profiles = mac ? path.join(root, 'Documents', 'Profiles') : root;
  const sharedCandidates = mac ? macVids(root) : [
    ...metadataVids(path.join(root, 'othercorp_setting.json')),
    ...metadataVids(path.join(root, 'Profiles', 'othercorp_setting.json')),
  ];
  const sources: Source[] = [];
  const companyNames = new Map<string, Set<string>>();
  const addIdentity = (file: string) => {
    const identity = profileIdentity(file);
    if (!identity || !validVid(identity.vid)) return;
    const names = companyNames.get(identity.vid) ?? new Set<string>();
    names.add(identity.name);
    companyNames.set(identity.vid, names);
    return identity.vid;
  };
  if (!mac) {
    for (const entry of entries(path.join(root, 'Profiles'))) {
      if (entry.isDirectory()) addIdentity(path.join(root, 'Profiles', entry.name, 'io_data.json'));
    }
  }
  const seen = new Set<string>();
  const add = (directory: string, localCandidates: string[]) => {
    const message = path.join(directory, mac ? 'Info.db' : 'message.db');
    if (seen.has(message) || !regular(message)) return;
    seen.add(message);
    const identityVids = [
      addIdentity(path.join(path.dirname(directory), 'io_data.json')),
      ...(mac ? [] : [addIdentity(path.join(directory, 'io_data.json'))]),
    ].filter((value): value is string => !!value);
    const candidates = [...new Set([...localCandidates, ...identityVids, ...sharedCandidates].filter(validVid))];
    const profile: Profile = {
      id: createHash('sha256').update(message).digest('hex').slice(0, 24),
      name: `本地档案 ${String(sources.length + 1).padStart(2, '0')}`,
      platform,
      available: false,
    };
    const conversation = mac ? message : path.join(directory, 'session.db');
    const contact = path.join(directory, mac ? 'Session.db' : 'user.db');
    sources.push({ profile, dataRoot: root, message, conversation, contact, candidates });
  };
  if (!mac) {
    add(root, [path.basename(path.dirname(root)), path.basename(root)]);
    add(path.join(root, 'Data'), [path.basename(root)]);
  }
  for (const entry of entries(profiles)) {
    if (!entry.isDirectory()) continue;
    add(path.join(profiles, entry.name, mac ? 'Messages1' : 'Data'), mac ? [] : [entry.name]);
  }
  // Derive each candidate at most once during a discovery. Do not retain keys
  // for unopened profiles or send the identifier to the renderer.
  const keys = new Map<string, Buffer>();
  try {
    for (const source of sources) {
      try {
        const page = readFirstPage(source.message);
        const candidates = mac ? source.candidates : new Set([...source.candidates, ...companyNames.keys()]);
        const matched = [...candidates].find(vid => {
          if (!keys.has(vid)) keys.set(vid, deriveKey(vid));
          return matchesKey(page, keys.get(vid)!);
        });
        if (matched) {
          source.profile.available = true;
          source.candidates = [matched];
          const names = companyNames.get(matched);
          if (names?.size === 1) source.profile.name = [...names][0];
        } else source.profile.issue = 'vid_not_verified';
      } catch { source.profile.issue = 'source_unreadable'; }
    }
  } finally {
    for (const key of keys.values()) key.fill(0);
  }
  const counts = new Map<string, number>();
  for (const { profile } of sources) counts.set(profile.name, (counts.get(profile.name) ?? 0) + 1);
  for (const [index, { profile }] of sources.entries())
    if ((counts.get(profile.name) ?? 0) > 1) profile.name += ` · 档案 ${String(index + 1).padStart(2, '0')}`;
  return sources;
}
