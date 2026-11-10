import {nearbyContext, referencePhrase, unresolvedReference} from './messagegraph-nearby.js';

const normalized = text => text.normalize('NFKC').trim().toLowerCase();
const statusQuestion = /(?:到底|最终|最后|后来|现在|目前)?(?:是怎么定的|是否(?:确定|确认|定下来了)|确定了(?:吗|没)|确认了(?:吗|没)|定了(?:吗|没)|定下来(?:了吗|没|没有)|有(?:最终)?结论(?:吗|没)|怎么定的|最后怎么样了)[?？。！!\s]*$/u;
const contextLimit = 10;

export function focusQuery(query) {
  if (typeof query !== 'string' || query.length > 200 || query.includes('\0')) return query;
  const text = query.trim();
  const reference = referencePhrase(text);
  if (reference) return reference;
  const topic = text.replace(statusQuestion, '').replace(/[，、,:：\s]+$/u, '').trim();
  return topic.length >= 2 ? topic : text;
}

function decisionCue(text) {
  const clauses = normalized(text).match(/[^。！？?!；;\n]+[。！？?!；;]?/gu) ?? [];
  for (const clause of clauses.reverse()) {
    if (/[?？]$/u.test(clause)) {
      if (/(?:确认|确定|定了|定下来|改期|取消)/u.test(clause)) return 'pending';
      continue;
    }
    if (/(?:未|没|待|请|先|麻烦|帮忙|能否|是否|还需|等|如果|尚未|暂未|未能).{0,5}(?:确认|确定|定稿|敲定|决定)|(?:还没定|没定下来|待定|暂定|先按|暂按|等通知|再议)|(?:定了|确认了|确定了)(?:吗|没)/u.test(clause))
      return 'pending';
    if (/(?:拟|建议|考虑|计划|可能|是否|要不|如果|假如|希望|倾向于).{0,8}(?:改到|改为|改期|延期|取消|定在|就定|确认|敲定)/u.test(clause))
      continue;
    if (/(?:最终确认|最终确定|正式确认|已经确认|已确认|已确定|确认[:：]|确定[:：]|现已决定|现决定|已决定).{0,20}(?:改到|改为|改期|延期|取消)|(?:已改期|已取消|确定取消|决定取消|决定改到|确定改到)/u.test(clause))
      return 'changed';
    if (/(?:最终确认|最终确定|正式确认|已经确认|已确认|已确定|确认[:：]|确定[:：]|已敲定|就定在|就定了|已定下|确定按|确认按)/u.test(clause))
      return 'confirmed';
  }
}

function comparePosition(a, b) {
  return a.source.time - b.source.time || a.source.id.length - b.source.id.length || a.source.id.localeCompare(b.source.id);
}

function latestDecision(items) {
  return items.filter(item => ['anchor', 'quoted', 'reply'].includes(item.view.reason) && item.view.decision)
    .sort((a, b) => comparePosition(b, a))[0];
}

export async function assembleContext(hits, topic, {gather, page, filters, allows, query = topic}) {
  const phrase = normalized(topic);
  const eligible = hits.filter(hit => hit.reasons.some(({type}) => type !== 'nearby'));
  const exact = eligible.filter(hit => phrase && normalized(hit.text).includes(phrase));
  const ranked = (exact.length ? exact : eligible).slice().reverse();
  const byConversation = new Map();
  for (const hit of ranked) {
    const key = hit.source.conversationRef ?? hit.source.group;
    if (!byConversation.has(key)) byConversation.set(key, hit);
  }
  const seeds = [...byConversation.values()].slice(0, 3);
  const candidates = new Map();
  const locators = new Map();
  const continuations = [];
  let needsMore = false;

  function priority(item) {
    if (item.view.reason === 'anchor') return 0;
    if (['quoted', 'reply'].includes(item.view.reason)) return item.view.decision ? 1 : 2;
    return item.view.reason === 'topic' ? 3 : 4;
  }

  function add(item) {
    const key = JSON.stringify([item.source.conversation, item.source.id]);
    const decision = item.view.reason === 'topic' || unresolvedReference(item.view.text)
      ? undefined : decisionCue(item.view.text);
    const evidence = item.view.reason === 'topic' ? {...item, view: {...item.view, certainty: 'possible'}}
      : decision ? {...item, view: {...item.view, decision}} : item;
    const existing = candidates.get(key);
    if (!existing || priority(evidence) < priority(existing)) candidates.set(key, evidence);
    return evidence;
  }

  function next(tool, item, direction) {
    continuations.push({
      tool, source: item.view.source,
      args: {ref: item.source.ref, ...(direction ? {direction} : {}), filters},
    });
    locators.set(item.source.ref, item.source);
  }

  for (const seed of seeds) {
    const graph = await gather(seed.source.ref);
    if (!graph?.items.length) continue;
    const linked = graph.items.map(add);
    const anchor = linked[0];
    const verified = linked.some(item => ['quoted', 'reply'].includes(item.view.reason));
    const decision = latestDecision(linked);
    const settled = (verified || !unresolvedReference(anchor.view.text)) &&
      (decision?.view.decision === 'confirmed' || decision?.view.decision === 'changed');
    needsMore ||= !settled;
    const sameChat = linked.filter(item => item.source.conversation === anchor.source.conversation);
    const first = sameChat.reduce((a, b) => comparePosition(a, b) <= 0 ? a : b, anchor);
    const last = sameChat.reduce((a, b) => comparePosition(a, b) > 0 ? a : b, anchor);
    const windows = settled && verified ? [['after', last]] : [['after', last], ['before', first]];
    const neighbors = [];
    for (const [direction, boundary] of windows) {
      const window = await page(boundary.source, direction);
      if (!window?.items.length) continue;
      const allowed = window.items.filter(allows);
      if (!verified) neighbors.push(...allowed);
      const possible = verified ? allowed.filter(item => phrase &&
        normalized(item.view.text).includes(phrase) && decisionCue(item.view.text)) : [];
      for (const item of possible.slice(0, 2)) add(item);
      if (!settled || possible.length) {
        needsMore = true;
        next('wecom_read_timeline', boundary, direction);
      }
    }
    if (!verified) {
      const possible = nearbyContext(anchor, neighbors, query);
      for (const item of possible) add(item);
      if (possible.length && unresolvedReference(anchor.view.text)) needsMore = true;
    }
    if (graph.more) next('wecom_get_evidence', settled ? decision : anchor);
  }

  const entries = [...candidates.values()];
  const selected = entries.sort((a, b) => priority(a) - priority(b) ||
    (b.candidateScore ?? 0) - (a.candidateScore ?? 0) || b.source.time - a.source.time)
    .slice(0, contextLimit).sort(comparePosition);
  for (const item of selected) locators.set(item.source.ref, item.source);
  if (entries.length > contextLimit && !continuations.some(step => step.tool === 'wecom_get_evidence')) {
    const anchor = selected.find(item => item.view.reason === 'anchor');
    if (anchor) next('wecom_get_evidence', anchor);
  }
  const steps = [...new Map(continuations.map(step => [
    JSON.stringify([step.tool, step.args.ref, step.args.direction]), step,
  ])).values()].slice(0, 6);
  return {context: {messages: selected.map(item => item.view), needsMore: needsMore || !selected.length, continuations: steps}, locators: [...locators.values()]};
}
