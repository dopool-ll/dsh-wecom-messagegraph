import {Fragment, useEffect, useId, useLayoutEffect, useRef, useState} from 'react';
import {ChevronUp, Send, Sparkles, Square} from 'lucide-react';
import type {Original} from './AgentMemory';
import {describe, toDate} from './presentation';
import {useTransport, type CopilotAnswer, type CopilotMode} from './transport';

const prompts = {summary: '总结最近消息', actions: '整理待办'};
type Turn = {id: number; mode: CopilotMode; question: string; text: string; result?: CopilotAnswer; stopped?: boolean};

export function ConversationCopilot({profile, conversation, openOriginal}: {
  profile: string; conversation: string; openOriginal: (original: Original) => void;
}) {
  const {request: rpc, askCopilot} = useTransport();
  const [expanded, setExpanded] = useState(false);
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState<'search' | 'generating' | 'source'>();
  const [error, setError] = useState('');
  const bodyId = useId();
  const active = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => { if (expanded) input.current?.focus(); }, [expanded]);
  useLayoutEffect(() => {
    if (expanded && followLatest.current && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [turns, expanded]);

  async function ask(mode: CopilotMode) {
    if (active.current) return;
    const submitted = mode === 'question' ? question.trim() : prompts[mode];
    const previousQuestions = turns.filter(turn => turn.mode === 'question' && turn.result)
      .slice(-2).map(turn => turn.question);
    const controller = new AbortController();
    active.current = controller;
    const id = ++sequence.current;
    const update = (patch: Partial<Turn>) => setTurns(value => value.map(turn => turn.id === id ? {...turn, ...patch} : turn));
    followLatest.current = true;
    setTurns(value => [...value.slice(-7), {id, mode, question: submitted, text: ''}]);
    if (mode === 'question') setQuestion('');
    setBusy('search');
    setError('');
    let text = '';
    let flush: ReturnType<typeof setTimeout> | undefined;
    try {
      const workspace = sessionStorage.getItem('wecom-agent-workspace') ?? undefined;
      const result = await askCopilot({profile, conversation, workspace, mode, previousQuestions,
        question: mode === 'question' ? submitted : undefined}, event => {
        if (controller.signal.aborted) return;
        if (event.type === 'generating') setBusy('generating');
        else {
          text += event.text;
          flush ??= setTimeout(() => {
            flush = undefined;
            if (!controller.signal.aborted) update({text});
          }, 40);
        }
      }, controller.signal);
      if (!controller.signal.aborted) update({result, text: result.answer});
    } catch (err) {
      if (!controller.signal.aborted) {
        update({text: ''});
        setError(describe(err));
      }
    } finally {
      clearTimeout(flush);
      active.current = null;
      if (controller.signal.aborted) update({text, stopped: true});
      setBusy(undefined);
    }
  }

  async function showSource(ref: string) {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy('source');
    setError('');
    try {
      const original = await rpc<Original>({op: 'agentSource', ref}, controller.signal);
      if (original.profile !== profile || original.conversation.id !== conversation) throw 'agent_source_unavailable';
      if (!controller.signal.aborted) openOriginal(original);
    } catch (err) {
      if (!controller.signal.aborted) setError(describe(err));
    } finally {
      active.current = null;
      if (!controller.signal.aborted) setBusy(undefined);
    }
  }

  const generating = busy === 'search' || busy === 'generating';
  return <section className="copilot" aria-label="会话 Copilot">
    <button className="copilot-toggle" type="button" aria-expanded={expanded} aria-controls={bodyId}
      onClick={() => setExpanded(value => !value)}>
      <Sparkles size={16}/><strong>Copilot</strong><span>问问这段聊天</span><ChevronUp size={15} className="copilot-chevron"/>
    </button>
    <div id={bodyId} className="copilot-body" hidden={!expanded}>
      <p className="copilot-hint">仅查询当前会话的已授权索引。提问时，相关片段会发送给 DSH 默认模型。</p>
      {busy && <div className="copilot-status" role="status">
        {busy === 'search' ? '正在查找当前会话…' : busy === 'generating' ? '正在生成回答…' : '正在定位原消息…'}
      </div>}
      {error && <div className="copilot-status" role="alert">{error}</div>}
      {turns.length > 0 && <div className="copilot-transcript" ref={transcript} onScroll={event => {
        const box = event.currentTarget;
        followLatest.current = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
      }}>
        {turns.map(turn => <div className="copilot-turn" key={turn.id}>
          <p className="copilot-question">{turn.question}</p>
          {turn.text && <div className="copilot-answer">
            {turn.result ? <CitedAnswer result={turn.result} disabled={Boolean(busy)} open={ref => void showSource(ref)}/> : turn.text}
          </div>}
          {turn.stopped && <p className="copilot-status">已停止生成</p>}
        </div>)}
      </div>}
      <div className="copilot-actions">
        <button className="soft-button" type="button" disabled={Boolean(busy)} onClick={() => void ask('summary')}>{prompts.summary}</button>
        <button className="soft-button" type="button" disabled={Boolean(busy)} onClick={() => void ask('actions')}>{prompts.actions}</button>
      </div>
      <form className="copilot-form" onSubmit={event => {
        event.preventDefault();
        if (question.trim()) void ask('question');
      }}>
        <input ref={input} value={question} aria-label="询问当前会话" maxLength={200} placeholder="例如，周五的验收时间定了吗？"
          onChange={event => setQuestion(event.target.value)}/>
        {generating ? <button className="soft-button" type="button" onClick={() => active.current?.abort()}><Square size={14}/>停止生成</button>
          : <button className="soft-button" type="submit" disabled={Boolean(busy) || !question.trim()}><Send size={14}/>提问</button>}
      </form>
    </div>
  </section>;
}

function CitedAnswer({result, disabled, open}: {result: CopilotAnswer; disabled: boolean; open: (ref: string) => void}) {
  const citations = new Map(result.citations.map(({number, source}) => [number, source]));
  return result.answer.split(/(\[\d+\])/g).map((part, index) => {
    if (index % 2 === 0) return <Fragment key={index}>{part}</Fragment>;
    const number = Number(part.slice(1, -1));
    const source = citations.get(number);
    if (!source) return null;
    const label = `查看原消息 ${part} · ${source.sender} · ${toDate(source.time)?.toLocaleString('zh-CN') ?? ''}`;
    return <button key={index} type="button" className="copilot-citation" aria-label={label} title={label}
      disabled={disabled} onClick={() => open(source.ref)}>{number}</button>;
  });
}
