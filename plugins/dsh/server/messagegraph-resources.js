import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function linkResources(text, explicitUrl) {
  const urls = (text ?? '').matchAll(/https?:\/\/[^\s<>"'，。；！？、【】（）「」]+/gi);
  const resources = new Map();
  for (const raw of [explicitUrl, ...Array.from(urls, match => match[0]).slice(0, 12)]) {
    if (!raw) continue;
    try {
      const url = new URL(raw === explicitUrl ? raw : raw.replace(/[.,!?;]+$/, ''));
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
      if (url.pathname === '/' && !url.search && !url.hash) continue;
      const key = hash(url.href);
      resources.set(key, {kind: 'shared_link', key, label: (url.host + url.pathname).slice(0, 200)});
    } catch { /* Ignore malformed URLs. */ }
  }
  return [...resources.values()].slice(0, 4);
}

export function repeatedTextResource(text) {
  const normalized = text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  const words = normalized.match(/\p{L}+/gu) ?? [];
  const han = normalized.match(/\p{Script=Han}/gu) ?? [];
  if (normalized.length < 18 || (words.length < 6 && han.length < 12)) return undefined;
  return {kind: 'repeated_text', key: hash(normalized), label: ''};
}

export async function attachmentKey(file, signal) {
  const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const matches = stat => stat.isFile() && String(stat.dev) === file.device && String(stat.ino) === file.inode &&
      String(stat.mtimeNs) === file.modified && String(stat.ctimeNs) === file.changed && stat.size === BigInt(file.size);
    if (!matches(await handle.stat({bigint: true}))) throw Error('media_unavailable');
    const digest = createHash('sha256');
    let size = 0;
    const stream = handle.createReadStream({autoClose: false, end: file.size - 1, signal});
    for await (const bytes of stream) {
      digest.update(bytes);
      size += bytes.length;
    }
    if (size !== file.size || !matches(await handle.stat({bigint: true}))) throw Error('media_unavailable');
    return digest.digest('hex');
  } finally {
    await handle.close();
  }
}
