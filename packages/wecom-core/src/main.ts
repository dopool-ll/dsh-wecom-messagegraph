import { createInterface } from 'node:readline';
import { discover, type Source } from './discovery';
import { Synchronizer, errorCode, sourceVersion } from './sync';
import type { Request } from './types';

const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : null;
const sync = new Synchronizer();
let sources = new Map<string, Source>();

function dispatch(request: Request) {
  switch (request.op) {
    case 'discover': {
      if (!platform) throw Error('platform_unsupported');
      let found: Source[];
      try { found = discover(platform, request.documents, request.root); }
      catch (error) {
        if (['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? ''))
          throw Error('source_access_denied');
        throw error;
      }
      sources = new Map(found.map(source => [source.profile.id, source]));
      return found.map(source => source.profile);
    }
    case 'select': {
      const source = sources.get(request.id);
      if (!source) throw Error('profile_not_found');
      return sync.start(source);
    }
    case 'pause': return sync.pause(request.paused);
    case 'status': return sync.state;
    case 'conversations':
    case 'contacts': {
      const offset = Math.max(0, Math.min(1000000, Math.floor(request.offset) || 0));
      const search = typeof request.search === 'string' ? request.search.slice(0, 200) : '';
      return (request.op === 'contacts' ? sync.catalog?.list('contacts', search, offset, request.filter ?? 'all') :
        sync.catalog?.list('conversations', search, offset, request.filter ?? 'all', request.read ?? 'all')) ?? { items: [], more: false };
    }
    case 'contactConversations': return sync.catalog?.contactConversations(request.id) ?? {items: [], more: false};
    case 'conversationAvatars':
      return request.profile === sync.state.profile ? sync.catalog?.conversationAvatars(request.id) ?? [] : [];
    case 'messages': return sync.catalog?.messages(request.id, request.before) ?? { items: [], more: false };
    case 'contextConversations':
      if (request.profile !== sync.state.profile || !sync.catalog) throw Error('agent_archive_unavailable');
      return sync.catalog.contextConversationIds();
    case 'contextProbe':
      return request.profiles.map(profile => {
        const source = sources.get(profile);
        if (!source) return null;
        try { return sourceVersion(source); }
        catch { return null; }
      });
    case 'contextStatus':
      return {state: sync.state, snapshot: sync.contextVersion};
    case 'contextScan':
      if (request.profile !== sync.state.profile || !sync.catalog) throw Error('agent_archive_unavailable');
      if (request.conversations.length > 8) throw Error('invalid_request');
      if (request.snapshot && request.snapshot !== sync.contextVersion) throw Error('agent_archive_changed');
      return {state: sync.state, groups: sync.catalog.contextScan(request.conversations,
        request.since, Math.max(1, Math.min(800, request.limit)), new Map(request.known))};
    case 'contextRelated':
    case 'contextPage': {
      if (request.profile !== sync.state.profile || !sync.catalog) throw Error('agent_archive_unavailable');
      const limit = Math.max(1, Math.min(40, request.limit));
      return request.op === 'contextRelated'
        ? sync.catalog.contextRelated(request.conversation, request.id, request.fingerprint, request.anchorOnly ? 0 : limit, request.since, request)
        : sync.catalog.contextPage(request.conversation, request.id, request.fingerprint, request.direction, limit, request.since, request.until);
    }
    case 'contextSource':
      if (request.profile !== sync.state.profile || !sync.catalog) throw Error('agent_archive_unavailable');
      return sync.catalog.contextSource(request.conversation, request.id, request.fingerprint,
        Math.max(0, Math.min(30, request.around)));
    case 'media': {
      if (request.profile !== sync.state.profile) throw Error('media_unavailable');
      const file = sync.catalog?.mediaFile(request.conversation, request.id, request.part, request.refreshCache, request.fingerprint);
      if (!file) throw Error('media_unavailable');
      return file;
    }
    case 'exportDatabases': return sync.exportDatabases(request.profile, request.directory);
    case 'shutdown': sync.close(); return null;
    default: throw Error('invalid_request');
  }
}

const input = createInterface({input: process.stdin, terminal: false, crlfDelay: Infinity});
for await (const line of input) {
  let id: number | undefined;
  let shutdown = false;
  try {
    const envelope: { id: number; request: Request } = JSON.parse(line);
    id = envelope.id;
    shutdown = envelope.request.op === 'shutdown';
    const data = dispatch(envelope.request);
    process.stdout.write(JSON.stringify({id, data}) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({id, error: errorCode(error)}) + '\n');
  }
  if (shutdown) break;
}
sync.close();
input.close();
process.stdin.pause();
