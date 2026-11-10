import {useState} from 'react';
import {describe, toDate} from './presentation';
import type {SourceLink} from './AgentMemory';

export const evidenceReasons = {
  anchor: '命中原文', quoted: '被引用的原消息', reply: '引用回复', shared_link: '共享链接',
  shared_attachment: '共享附件', timeline: '按时间回查', topic: '可能相关',
};
const decisions = {confirmed: '确认表述', changed: '改期或取消', pending: '待确认'};
export type EvidenceItem = {source: SourceLink; text: string; reason: keyof typeof evidenceReasons;
  decision?: keyof typeof decisions;
  clues?: {seconds: number; topics: string[]; participant?: 'same_sender' | 'shared_participant'}};
const participants = {same_sender: '同一发送人', shared_participant: '有共同参与人'};
export type Continuation = {
  tool: 'wecom_get_evidence' | 'wecom_read_timeline';
  source: SourceLink;
  args: {ref: string; direction?: 'before' | 'after'; cursor?: string;
    filters?: {from?: number; to?: number; conversation?: string; sender?: string}};
};
export type EvidenceContext = {messages: EvidenceItem[]; needsMore: boolean; continuations: Continuation[]};
export type ContinuationPage = {messages?: EvidenceItem[]; hits?: EvidenceItem[]; nextCursor?: string | null};

export function EvidenceItems({items, open}: {items: EvidenceItem[]; open(ref: string): void}) {
  return <>{items.map(({source, text, reason, decision, clues}) => <article className="agent-result" key={source.ref}>
    <strong>{evidenceReasons[reason]}{decision && reason !== 'topic' ? ` · ${decisions[decision]}` : ''}</strong>
    {text && <p>{text}</p>}
    {clues && <small>同一会话 · 相隔 {clues.seconds} 秒{clues.participant ? ` · ${participants[clues.participant]}` : ''}
      {clues.topics.length ? ` · ${clues.topics.join('、')}` : ''}</small>}
    <small>{source.group} · {source.sender} · {toDate(source.time)?.toLocaleString('zh-CN')}</small>
    <button type="button" className="soft-button" onClick={() => open(source.ref)}>查看原消息 · {source.group}</button>
  </article>)}</>;
}

export function ContextResults({context, open, load}: {
  context: EvidenceContext;
  open(ref: string): void;
  load(step: Continuation): Promise<ContinuationPage>;
}) {
  const [pages, setPages] = useState<Record<number, {items: EvidenceItem[]; cursor?: string}>>({});
  const [busy, setBusy] = useState<number>();
  const [error, setError] = useState('');
  async function follow(step: Continuation, index: number) {
    const current = pages[index];
    setBusy(index);
    setError('');
    try {
      const result = await load({...step, args: {...step.args, cursor: current?.cursor ?? step.args.cursor}});
      const items = [...(current?.items ?? []), ...(result.hits ?? result.messages ?? [])];
      setPages(previous => ({...previous, [index]: {items, cursor: result.nextCursor ?? undefined}}));
    } catch (err) { setError(describe(err)); }
    finally { setBusy(undefined); }
  }

  return <section aria-label="关键证据">
    {context.messages.length > 0 && <><h3>关键证据</h3><EvidenceItems items={context.messages} open={open}/></>}
    {context.needsMore && <p>部分线索还需要继续核对。</p>}
    {context.continuations.map((step, index) => {
      const page = pages[index];
      const label = step.tool === 'wecom_get_evidence' ? '继续查引用和资料'
        : step.args.direction === 'after' ? '往后翻原消息' : '往前翻原消息';
      return <div key={`${step.tool}:${step.args.ref}:${step.args.direction ?? ''}`}>
        {(!page || page.cursor) && <button type="button" className="soft-button" disabled={busy !== undefined}
          onClick={() => void follow(step, index)}>{busy === index ? '正在读取…' : `${label} · ${step.source.group}`}</button>}
        {page && <EvidenceItems items={page.items} open={open}/>}
        {page && !page.items.length && <p>这页没有符合筛选条件的消息。</p>}
      </div>;
    })}
    {error && <p role="alert">{error}</p>}
  </section>;
}
