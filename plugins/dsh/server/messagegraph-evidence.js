import {digest} from './context-store.js';
import {evidenceKinds, visibleSource} from './messagegraph.js';
import {linkResources} from './messagegraph-resources.js';

export function messageEvidence(scope, conversation, item, reason, originalSource, via) {
  const {message, fingerprint, senderId} = item;
  const source = originalSource ?? {
    ref: digest('original', scope.workspace, scope.profile, conversation.id, message.id, fingerprint),
    original: true, profile: scope.profile, conversation: conversation.id, conversationType: conversation.kind, group: conversation.name,
    conversationRef: digest(scope.profile, conversation.id), id: message.id, fingerprint, time: message.time,
    sender: message.sender, kind: evidenceKinds.includes(message.kind) ? message.kind : 'text',
    ...(senderId ? {person: digest(scope.profile, senderId)} : {}),
  };
  const view = {
    source: visibleSource(source), text: message.text.slice(0, 750), kind: message.kind,
    sender: message.sender, time: message.time, reason, anchor: reason === 'anchor',
    ...(via ? {via} : {}),
  };
  return {message, source, view};
}

export async function gatherEvidence(scope, source, limit, {read, resources, peers, allows = () => true}) {
  const graph = await read(source, 'related');
  if (!graph) throw Error('agent_source_unavailable');
  const found = new Map();
  let more = graph.more;
  const identity = (conversation, id) => JSON.stringify([conversation, id]);
  const add = (conversation, item, reason, originalSource, via) => {
    if (!item) return;
    const key = identity(conversation.id, item.message.id);
    if (found.has(key)) return;
    const evidence = messageEvidence(scope, conversation, item, reason, originalSource, via);
    if (!allows(evidence)) return;
    if (found.size >= limit) { more = true; return; }
    found.set(key, evidence);
  };

  add(graph.conversation, graph.anchor, 'anchor', source);
  add(graph.conversation, graph.quoted, 'quoted', undefined, source.ref);
  for (const reply of graph.replies) add(graph.conversation, reply, 'reply', undefined, source.ref);

  // Follow one further citation from the strongest reply evidence, then look up
  // shared material for the originals and replies already collected.
  const follow = [...found.values()].slice(1, 3);
  for (const item of follow) {
    if (found.size >= limit) break;
    const next = await read(item.source, 'related');
    if (!next) continue;
    more ||= next.more;
    add(next.conversation, next.quoted, 'quoted', undefined, item.source.ref);
    for (const reply of next.replies) add(next.conversation, reply, 'reply', undefined, item.source.ref);
  }

  for (const item of [...found.values()]) {
    if (found.size >= limit) { more = true; break; }
    const parts = item.message.kind === 'mixed' ? item.message.parts : [item.message];
    const links = parts.flatMap(part => ['text', 'link'].includes(part.kind)
      ? linkResources(part.text, part.detail?.url) : []);
    const keys = new Map([...links, ...resources(item.source)].map(resource => [
      JSON.stringify([resource.kind, resource.key]), resource,
    ]));
    for (const resource of [...keys.values()].slice(0, 12)) {
      for (const peer of peers(resource, item.source)) {
        if (found.has(identity(peer.conversation, peer.id))) continue;
        if (found.size >= limit) { more = true; break; }
        const current = await read(peer, 'source');
        if (current) add(current.conversation, current.anchor, resource.kind, undefined, item.source.ref);
      }
      if (found.size >= limit) break;
    }
  }
  const items = [...found.values()];
  return {items, more};
}
