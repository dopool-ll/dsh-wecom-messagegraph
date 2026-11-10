import {digest} from './context-store.js';
import {evidenceKinds} from './messagegraph.js';
import {attachmentKey, linkResources, repeatedTextResource} from './messagegraph-resources.js';
import {extractionVersion, recognitionTools, recognize} from './recognize.js';

const indexLimits = {scanBatch: 8, rows: 600, image: 60, voice: 40, file: 40, fileCandidates: 160, fileBytes: 16 * 1024 * 1024};

export function indexCoverage() {
  return {indexed: {text: 0, image: 0, voice: 0, link: 0, file: 0, forward: 0}, seen: {image: 0, voice: 0},
    empty: 0, unavailable: 0, failed: 0, setup: 0, limitedConversations: 0, limitedMedia: 0, verifiedFiles: 0, unverifiedFiles: 0};
}

export async function buildIndex(scope, {signal, coverage, scan, mediaFile, readExtract, previous = new Map()}) {
  const tools = await recognitionTools();
  const entries = new Map();
  const windows = new Map(previous);
  const changed = new Set();
  const extracts = new Map();
  const attempts = {image: 0, voice: 0};
  const since = Math.floor(Date.now() / 1000) - scope.days * 86400;
  const media = [];
  const files = [];
  const versions = {
    image: await extractionVersion('image', tools),
    voice: await extractionVersion('voice', tools),
  };
  coverage.conversations = [];
  for (let offset = 0; offset < scope.groups.length; offset += indexLimits.scanBatch) {
    signal.throwIfAborted();
    const ids = scope.groups.slice(offset, offset + indexLimits.scanBatch);
    const known = ids.filter(id => previous.has(id)).map(id => [id, previous.get(id).signature]);
    const {state, groups} = await scan(ids, since, indexLimits.rows, known);
    const found = new Set(groups.map(group => group.conversation.id));
    for (const id of ids) {
      if (!found.has(id) && windows.delete(id)) changed.add(id);
    }
    coverage.sourceUpdatedAt ??= state.updatedAt;
    for (const group of groups) {
      const {id, name, kind} = group.conversation;
      if (group.messages === null) continue;
      changed.add(id);
      const conversationRef = digest(scope.profile, id);
      windows.set(id, {signature: group.signature, stats: indexCoverage(), extracts: [], detail: {
        name, type: kind, ref: conversationRef, messages: group.messages.length,
        oldest: group.messages.at(-1)?.message.time ?? null, newest: group.messages[0]?.message.time ?? null,
        limited: group.more,
      }});
      for (const {message, fingerprint, senderId} of group.messages) {
        const parts = message.kind === 'mixed' ? message.parts : [message];
        const handoffText = parts.filter(part => part.kind === 'text' && !part.placeholder)
          .map(part => part.text).join(' ').slice(0, 6000);
        for (const [index, part] of parts.entries()) {
          if (!evidenceKinds.includes(part.kind)) continue;
          const partIndex = message.kind === 'mixed' ? index : undefined;
          const source = {
            profile: scope.profile, conversation: id, conversationRef, group: name,
            conversationType: group.conversation.kind, id: message.id, fingerprint, sender: message.sender, time: message.time, kind: part.kind, part: partIndex,
            ...(senderId ? {person: digest(scope.profile, senderId)} : {}),
          };
          if (part.kind === 'text') {
            if (!part.text?.trim() || part.placeholder) continue;
            const resources = linkResources(part.text);
            const repeated = resources.length ? undefined : repeatedTextResource(part.text);
            if (repeated) resources.push(repeated);
            add({...source, resources}, part.text);
          } else if (part.kind === 'link') {
            const resources = linkResources(part.text, part.detail?.url);
            add({...source, resources, handoffText}, part.text);
          } else if (part.kind === 'file') {
            files.push({source: {...source, handoffText}, body: part.detail?.name || part.text});
          } else if (part.kind === 'forward') {
            add(source, part.text);
          } else media.push(source);
        }
      }
    }
  }
  media.sort((a, b) => b.time - a.time);
  for (const source of media) {
    signal.throwIfAborted();
    const {kind} = source;
    const {stats} = windows.get(source.conversation);
    stats.seen[kind]++;
    if (!versions[kind]) {
      stats.setup++;
      add({...source, mediaState: 'setup'}, '');
      continue;
    }
    try {
      const file = await mediaFile(source);
      const ref = partReference(source);
      const version = digest(versions[kind], file.device, file.inode, file.size, file.modified, file.mime);
      let segments = readExtract(ref, version);
      if (segments === undefined) {
        if (attempts[kind] >= indexLimits[kind]) {
          stats.limitedMedia++;
          add({...source, mediaState: 'pending'}, '');
          continue;
        }
        attempts[kind]++;
        segments = await recognize(file, kind, tools, signal);
      }
      cache(source, ref, version, segments);
      if (!segments.length) {
        stats.empty++;
        add({...source, mediaState: 'empty'}, '');
      }
      for (const [index, segment] of segments.entries())
        add({...source, startMs: segment.startMs, endMs: segment.endMs}, segment.text, index);
    } catch (error) {
      signal.throwIfAborted();
      const missing = error.message === 'media_unavailable';
      if (missing) stats.unavailable++;
      else stats.failed++;
      add({...source, mediaState: missing ? 'unavailable' : 'failed'}, '');
    }
  }
  files.sort((a, b) => b.source.time - a.source.time);
  let attemptsFile = 0;
  for (const [index, {source, body}] of files.entries()) {
    signal.throwIfAborted();
    let resource;
    if (index < indexLimits.fileCandidates) {
      try {
        const file = await mediaFile(source);
        if (file.match === 'recorded_path' && file.changed && Number.isSafeInteger(file.size) && file.size > 0 && file.size <= indexLimits.fileBytes) {
          const ref = digest('file-content', partReference(source));
          const version = digest(file.device, file.inode, file.size, file.modified, file.changed);
          let key = readExtract(ref, version);
          if (key === undefined && attemptsFile < indexLimits.file) {
            attemptsFile++;
            key = await attachmentKey(file, signal);
          }
          if (key !== undefined) {
            cache(source, ref, version, key);
            resource = {kind: 'shared_attachment', key, label: ''};
          }
        }
      } catch { signal.throwIfAborted(); }
    }
    const {stats} = windows.get(source.conversation);
    if (resource) stats.verifiedFiles++;
    else stats.unverifiedFiles++;
    add({...source, resources: resource ? [resource] : []}, body);
  }
  signal.throwIfAborted();
  for (const {detail, stats} of windows.values()) {
    coverage.conversations.push(detail);
    if (detail.limited) coverage.limitedConversations++;
    for (const [key, value] of Object.entries(stats)) {
      if (typeof value === 'number') coverage[key] += value;
    }
    for (const key of ['indexed', 'seen'])
      for (const [kind, count] of Object.entries(stats[key])) coverage[key][kind] += count;
  }
  return {entries, extracts, windows, changed};

  function cache(source, ref, version, segments) {
    windows.get(source.conversation).extracts.push(ref);
    extracts.set(ref, {version, segments});
  }

  function partReference(source, index = 0) {
    return digest(scope.workspace, source.profile, source.conversation, source.id,
      source.fingerprint, source.part ?? -1, index);
  }

  function add(source, body, index = 0) {
    const ref = partReference(source, index);
    const text = (body ?? '').trim().slice(0, 6000);
    entries.set(ref, {source: {...source, ref}, body: text});
    if (text) windows.get(source.conversation).stats.indexed[source.kind]++;
  }
}
