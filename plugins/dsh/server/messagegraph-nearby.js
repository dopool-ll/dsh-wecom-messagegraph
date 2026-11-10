const segmenter = new Intl.Segmenter('zh', {granularity: 'word'});
const localWindowSeconds = 15 * 60;
const reference = /(?:就按[这那](?:个|套|版|种)?来|按[这那](?:个|套|版)(?:来|做)|按(?:刚才|上面)(?:说的)?(?:来|做)|就用[这那](?:个|套|版)|就这么(?:定|办)|就这样(?:定|办)?|同意[这那](?:个|套|版)|就定[这那](?:个|套|版))/u;
const common = new Set(['这个', '那个', '这一版', '那一版', '这样', '那样', '这么', '刚才', '上面', '收到', '好的', '可以',
  '按这个', '按那个', '同意', '确认', '确定', '决定', '方案', '选项', '版本', '讨论', '说的', '说话', '消息', '群聊',
  '有人', '哪个', '什么意思', '意思', '可能', '相关', '最后', '到底', '定了', '怎么办', '为什么', '上下文',
  '一下', '看看', '看看吧', '继续', '这个来', '哪个方案', '哪一个']);

function textOf(text) {
  return text.normalize('NFKC').toLowerCase();
}

function wordsOf(text) {
  const clean = textOf(text).replace(/https?:\/\/\S+/gu, ' ').replace(reference, ' ');
  return new Set([...segmenter.segment(clean)].filter(({segment, isWordLike}) =>
    isWordLike && segment.length >= 2 && !common.has(segment) && !/^\d+$/u.test(segment))
    .slice(0, 32).map(({segment}) => segment));
}

function namedOptions(text) {
  const found = textOf(text).matchAll(/(?:方案|选项)\s*([a-z](?![a-z])|\d{1,2}(?!\d)|[甲乙丙丁一二三四五六七八九十])|(?:^|[^a-z\d])([a-z]|\d{1,2}|[甲乙丙丁一二三四五六七八九十])\s*(?:方案|选项)/gu);
  return new Set([...found].map(match => `方案 ${(match[1] ?? match[2]).toUpperCase()}`));
}

export function referencePhrase(text) {
  return textOf(text).match(reference)?.[0];
}

export function unresolvedReference(text) {
  return Boolean(referencePhrase(text) && !namedOptions(text).size && wordsOf(text).size < 2);
}

function commonWords(left, right) {
  return [...left].filter(word => right.has(word));
}

function sameTopic(left, right) {
  if (left.options.size && right.options.size)
    return commonWords(left.options, right.options).length === 1;
  const overlap = commonWords(left.words, right.words);
  return overlap.length >= 2 || overlap.some(word => word.length >= 4);
}

export function nearbyContext(anchor, items, query = '') {
  const focus = new Set([...wordsOf(anchor.view.text), ...wordsOf(query)]);
  const records = items.flatMap(item => {
    const seconds = Math.abs(item.source.time - anchor.source.time);
    if (item.source.conversation !== anchor.source.conversation || item.source.id === anchor.source.id ||
        seconds > localWindowSeconds || !['text', 'mixed'].includes(item.view.kind) || unresolvedReference(item.view.text))
      return [];
    const words = wordsOf(item.view.text);
    const options = namedOptions(item.view.text);
    return words.size || options.size ? [{item, seconds, words, options}] : [];
  });

  const ranked = records.flatMap(record => {
    const supporting = records.filter(other => other !== record && sameTopic(record, other));
    const shared = commonWords(record.words, focus);
    const themes = new Set([...record.options, ...shared]);
    for (const other of supporting) for (const word of commonWords(record.words, other.words)) themes.add(word);
    if (!record.words.size || !themes.size) return [];
    const person = anchor.source.person;
    const sameSender = person && person === record.item.source.person;
    const sharedParticipant = person && supporting.some(other => other.item.source.person === person);
    const participant = sameSender ? 'same_sender' : sharedParticipant ? 'shared_participant' : undefined;
    const score = (record.options.size === 1 ? 4 : 0) + Math.min(6, shared.length * 2) +
      Math.min(3, supporting.length) + Math.min(3, record.words.size / 2) +
      (sameSender ? 3 : sharedParticipant ? 2 : 0) +
      3 * (1 - record.seconds / localWindowSeconds);
    const clues = {seconds: record.seconds, topics: [...themes].slice(0, 3), ...(participant ? {participant} : {})};
    return [{...record, score, clues}];
  }).sort((a, b) => b.score - a.score || a.seconds - b.seconds || a.item.source.time - b.item.source.time);

  // Reserve the first slots for distinct topics even when one participant
  // contributes many messages to a single option.
  const selected = [];
  for (const candidate of ranked) {
    if (candidate.options.size > 1 || selected.some(previous => sameTopic(candidate, previous))) continue;
    selected.push(candidate);
    if (selected.length === 4) break;
  }
  if (!selected.length && ranked[0]) selected.push(ranked[0]);
  return selected.map(({item, score, clues}) => ({
    ...item, candidateScore: score, view: {...item.view, reason: 'topic', certainty: 'possible', clues},
  }));
}
