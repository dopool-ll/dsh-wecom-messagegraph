import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {MediaHint, MediaKind} from './rich';

const areas: Record<MediaKind, string[]> = {
  image: ['Images'], video: ['Videos'], voice: ['Voices'],
  sticker: ['Emotions', 'Emotion_Thumbnail'], file: ['Files'],
};
const maxBytes = 64 * 1024 * 1024;
const refreshMs = 15_000;
type Index = {expires: number; files: Map<string, string[]>};

export interface MediaFile {
  path: string;
  mime: string;
  size: number;
  device: string;
  inode: string;
  modified: string;
  changed: string;
  match?: 'recorded_path';
  variant?: 'preview';
}

function within(root: string, file: string) {
  const relative = path.relative(root, file);
  return relative !== '' && relative.split(path.sep)[0] !== '..' && !path.isAbsolute(relative);
}

function contentType(kind: MediaKind, header: Buffer) {
  const ascii = (start: number, end: number) => header.toString('ascii', start, end);
  if (kind === 'file') return 'application/octet-stream';
  if (kind === 'video') return ascii(4, 8) === 'ftyp' ? 'video/mp4' : null;
  if (kind === 'voice') {
    if (ascii(0, 6) === '#!SILK' || (header[0] === 2 && ascii(1, 7) === '#!SILK')) return 'audio/x-silk';
    if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';
    if (ascii(0, 4) === 'OggS') return 'audio/ogg';
    if (ascii(4, 8) === 'ftyp') return 'audio/mp4';
    return null;
  }
  if (header.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return 'image/jpeg';
  if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function matchesDigest(fd: number, size: number, digest: string) {
  const hash = createHash('md5');
  const buffer = Buffer.alloc(Math.min(size, 64 * 1024));
  for (let offset = 0; offset < size;) {
    const length = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (length === 0) return false;
    hash.update(buffer.subarray(0, length));
    offset += length;
  }
  return hash.digest('hex') === digest;
}

function readCacheBytes(root: string, candidate: string, limit: number) {
  let fd: number | undefined;
  try {
    if (fs.realpathSync(root) !== root || !within(root, candidate) || fs.realpathSync(candidate) !== candidate) return;
    fd = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > limit) return;
    const bytes = Buffer.alloc(stat.size);
    if (fs.readSync(fd, bytes) === bytes.length) return bytes;
  } catch {
    // The cache may have been evicted between the lookup and the read.
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

export class MediaCache {
  private indices = new Map<string, Index>();

  constructor(private profileRoot: string, private dataRoot?: string) {}

  private index(root: string, refresh = false): Map<string, string[]> {
    const old = this.indices.get(root);
    const now = Date.now();
    if (!refresh && old && old.expires > now) return old.files;
    const files = new Map<string, string[]>();
    const add = (key: string, file: string) => {
      const paths = files.get(key) ?? [];
      paths.push(file);
      files.set(key, paths);
    };
    let visited = 0;
    function walk(folder: string, depth: number) {
      if (depth > 5 || visited >= 24_000) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(folder, {withFileTypes: true}); }
      catch { return; }
      for (const entry of entries) {
        if (++visited > 24_000) return;
        const file = path.join(folder, entry.name);
        if (entry.isDirectory()) walk(file, depth + 1);
        if (!entry.isFile()) continue;
        add(entry.name, file);
        const stem = path.parse(entry.name).name;
        if (stem !== entry.name && /^[0-9a-f]{32}$/i.test(stem)) add(stem.toLowerCase(), file);
      }
    }
    walk(root, 0);
    this.indices.set(root, {expires: now + refreshMs, files});
    return files;
  }

  private inspect(root: string, candidate: string, kind: MediaKind, expectedSize?: number, digest?: string): MediaFile | undefined {
    let fd: number | undefined;
    try {
      const file = fs.realpathSync(candidate);
      if (file !== candidate || !within(root, file)) return;
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const info = fs.fstatSync(fd, {bigint: true});
      const limit = kind === 'voice' ? 2 * 1024 * 1024 : maxBytes;
      if (!info.isFile() || info.size <= 0 || info.size > limit ||
          (expectedSize !== undefined && info.size !== BigInt(expectedSize))) return;
      const header = Buffer.alloc(16);
      fs.readSync(fd, header, 0, header.length, 0);
      const mime = contentType(kind, header);
      if (!mime) return;
      if (digest) {
        if (!matchesDigest(fd, Number(info.size), digest)) return;
        const after = fs.fstatSync(fd, {bigint: true});
        if (after.size !== info.size || after.mtimeNs !== info.mtimeNs || after.ctimeNs !== info.ctimeNs) return;
      }
      return {
        path: file, mime, size: Number(info.size), device: String(info.dev),
        inode: String(info.ino), modified: String(info.mtimeNs), changed: String(info.ctimeNs),
      };
    } catch {
      // The cache can be removed by WeCom at any time.
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }

  resolve(hint: MediaHint, refresh = false): MediaFile | undefined {
    for (const area of areas[hint.kind]) {
      const root = path.join(this.profileRoot, 'Caches', area);
      try { if (fs.realpathSync(root) !== root) continue; }
      catch { continue; }
      for (const candidate of hint.paths) {
        if (!within(root, candidate)) continue;
        const file = this.inspect(root, candidate, hint.kind, hint.size);
        if (file) return {...file, match: 'recorded_path'};
      }
      const index = this.index(root, refresh);
      const nameSize = hint.size ?? hint.nameSize;
      const names = nameSize === undefined ? [] : hint.names;
      const strongKeys = new Set(hint.keys);
      for (const key of [...new Set([...strongKeys, ...names])]) {
        const candidates = index.get(key);
        if (!candidates?.length) continue;
        const expectedSize = strongKeys.has(key) ? hint.size : nameSize;
        const matches = candidates.flatMap(candidate => {
          const file = this.inspect(root, candidate, hint.kind, expectedSize);
          return file ? [file] : [];
        });
        if (matches.length === 1) return matches[0];
        if (matches.length > 1 && hint.digest) {
          for (const match of matches) {
            const verified = this.inspect(root, match.path, hint.kind, expectedSize, hint.digest);
            if (verified) return verified;
          }
        }
      }
      if (hint.kind === 'image' && hint.digest) {
        const previews = hint.names.flatMap(name => (index.get(name) ?? []).flatMap(candidate => {
          // WeCom stores resized copies under Images/<month>/<original digest>/<filename>.
          const location = path.relative(root, candidate).split(path.sep);
          if (location.length !== 3 || !/^\d{4}-\d{2}$/.test(location[0]) || location[1] !== hint.digest) return [];
          const file = this.inspect(root, candidate, 'image');
          return file?.mime === 'image/jpeg' ? [file] : [];
        }));
        if (previews.length === 1) return {...previews[0], variant: 'preview'};
      }
    }
  }

  avatar(person: string, url?: string): string | undefined {
    if (!this.dataRoot || !/^\d{1,20}$/.test(person)) return;
    const aliases = path.join(this.dataRoot, 'Documents', 'UserAvatarUrl');
    const saved = readCacheBytes(aliases, path.join(aliases, person), 2048)?.toString('utf8').trim();
    const cache = path.join(this.dataRoot, 'Library', 'Caches', 'com.hackemist.SDImageCache', 'default');
    for (const address of new Set([saved, url])) {
      if (!address || !/^https?:\/\/\S+$/.test(address) || address.length > 2048) continue;
      const key = createHash('md5').update(address).digest('hex');
      for (const file of this.index(cache).get(key) ?? []) {
        const bytes = readCacheBytes(cache, file, 96 * 1024);
        const mime = bytes && contentType('image', bytes);
        if (bytes && mime) return `data:${mime};base64,${bytes.toString('base64')}`;
      }
    }
  }
}
