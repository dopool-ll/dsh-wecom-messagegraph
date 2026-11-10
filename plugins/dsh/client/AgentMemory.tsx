import {useCallback, useEffect, useMemo, useState} from 'react';
import type {Conversation, Message, Page} from '../../../packages/wecom-core/src/types';
import {describe, toDate} from './presentation';
import {ContextResults, type ContinuationPage, type EvidenceContext} from './ContextResults';
import {useTransport} from './transport';

export type SourceKind = 'text' | 'image' | 'voice' | 'link' | 'file' | 'forward';
export type SourceLink = {ref: string; group: string; conversationType?: 'group' | 'direct'; sender: string; time: number; kind: SourceKind; startMs?: number; endMs?: number; mediaState?: string};
export type Original = {ref: string; profile: string; id: string; conversation: Conversation; items: Message[]; part?: number; startMs?: number};
type Coverage = {
  conversations?: {name: string; type: 'group' | 'direct'; ref?: string}[];
  indexed: Partial<Record<SourceKind, number>>; seen: Record<'image' | 'voice', number>;
  empty: number; unavailable: number; failed: number; setup: number; limitedConversations?: number; limitedGroups?: number; limitedMedia: number; verifiedFiles?: number; unverifiedFiles?: number;
};
type Memory = {id: string; note: string; state: 'confirmed' | 'pending'; source: SourceLink};
type Panel = {
  workspace: string | null; voiceReady: boolean;
  scope: {profile: string; conversations: string[]; days: number; indexed?: number; coverage?: Coverage; allowImages: boolean} | null;
  job: {phase: 'indexing' | 'ready' | 'error'; coverage: Coverage; error?: string} | null;
  memories: Memory[];
  externalGrants: {id: string; label: string; created: number}[];
};
type ExternalConfig = {id: string; command: string; args: string[]; env: Record<string, string>};
type Evidence = {text: string; source: SourceLink};
type Hit = Evidence & {reasons: {type: 'keyword' | 'nearby' | 'sender' | 'conversation' | 'resource' | 'filter'}[]};
export type Relation = {kind: 'shared_link' | 'shared_attachment' | 'named_handoff' | 'repeated_text';
  certainty: 'supported' | 'possible'; basis: 'shared_link' | 'shared_attachment' | 'repeated_text'; label: string; from: Evidence; to: Evidence};
type Exploration = {hits: Hit[]; relations: Relation[]; truncated?: boolean; context?: EvidenceContext};
const labels = {text: '聊天', image: '图片文字', voice: '语音转写', link: '链接', file: '附件', forward: '转发记录'};
const reasonLabels = {keyword: '关键词命中', nearby: '同会话附近的媒体', sender: '发送者命中',
  conversation: '会话名称命中', resource: '链接命中', filter: '符合筛选条件'};
export const relationLabels = {
  shared_link: '两条消息分享了同一链接',
  shared_attachment: '两条消息的本地缓存附件内容一致',
  named_handoff: '私聊提到发往该群，随后群里出现同一资料',
  repeated_text: '可能相关 · 两条消息有相同正文',
};

export function sourceName(source: SourceLink) {
  const type = source.conversationType === 'group' ? '群聊 · ' : source.conversationType === 'direct' ? '私聊 · ' : '';
  return type + source.group;
}

function sourceTime(source: SourceLink) {
  const stamp = toDate(source.time)?.toLocaleString('zh-CN') ?? '';
  const offset = typeof source.startMs === 'number' ? ` · 语音 ${(source.startMs / 1000).toFixed(1)} 秒` : '';
  return `${sourceName(source)} · ${source.sender} · ${stamp}${offset}`;
}

function dayBoundary(value: string, following = false) {
  if (!value) return undefined;
  const date = new Date(`${value}T00:00:00`);
  if (following) date.setDate(date.getDate() + 1);
  return Math.floor(date.getTime() / 1000);
}

export function AgentMemory({profile, ready, open, hidden}: {
  profile: string | null; ready: boolean; open: (ref: string) => void; hidden: boolean;
}) {
  const {request: rpc} = useTransport();
  const [workspace, setWorkspace] = useState(() => sessionStorage.getItem('wecom-agent-workspace') ?? '');
  const [data, setData] = useState<Panel>();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const [days, setDays] = useState(90);
  const [share, setShare] = useState(false);
  const [shareImages, setShareImages] = useState(false);
  const [conversationSearch, setConversationSearch] = useState('');
  const [conversationType, setConversationType] = useState<'group' | 'direct'>('group');
  const [available, setAvailable] = useState<Page<Conversation>>({items: [], more: false});
  const [query, setQuery] = useState('');
  const [fromDay, setFromDay] = useState('');
  const [toDay, setToDay] = useState('');
  const [searchConversation, setSearchConversation] = useState('');
  const [sender, setSender] = useState('');
  const [kind, setKind] = useState<SourceKind | ''>('');
  const [exploration, setExploration] = useState<Exploration>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [clientLabel, setClientLabel] = useState('');
  const [externalConfig, setExternalConfig] = useState<ExternalConfig>();

  const readPanel = useCallback((path?: string | null) => rpc<Panel>({op: 'agentPanel', workspace: path}), [rpc]);
  const acceptPanel = useCallback((next: Panel, keepDraft = false) => {
    setData(next);
    sessionStorage.setItem('wecom-agent-scope', next.workspace === null ? 'global' : 'workspace');
    if (next.workspace !== null) {
      setWorkspace(next.workspace);
      sessionStorage.setItem('wecom-agent-workspace', next.workspace);
    }
    const saved = next.scope;
    if (saved || !keepDraft) {
      setSelectedIds(saved?.profile === profile ? saved.conversations : []);
      setDays(saved?.days ?? 90);
    }
    setShare(saved?.profile === profile);
    setShareImages(saved?.profile === profile && saved.allowImages);
    setExploration(undefined);
    setSearchConversation('');
    setExternalConfig(undefined);
  }, [profile]);

  useEffect(() => {
    let active = true;
    const path = sessionStorage.getItem('wecom-agent-scope') === 'global'
      ? null : sessionStorage.getItem('wecom-agent-workspace') ?? undefined;
    void readPanel(path).then(next => { if (active) acceptPanel(next); })
      .catch(err => { if (active) setError(describe(err)); });
    return () => { active = false; };
  }, [readPanel, acceptPanel]);

  useEffect(() => {
    if (!data) return;
    let active = true;
    const timer = setInterval(() => void readPanel(data.workspace)
      .then(next => {
        if (active) setData(previous => previous?.workspace === next.workspace ? next : previous);
      }).catch(() => {}), data.job?.phase === 'indexing' ? 650 : 2000);
    return () => { active = false; clearInterval(timer); };
  }, [readPanel, data?.workspace, data?.job?.phase]);

  useEffect(() => {
    setAvailable({items: [], more: false});
    if (!ready || !profile) return;
    let active = true;
    const timer = setTimeout(() => {
      void rpc<Page<Conversation>>({op: 'conversations', filter: conversationType, search: conversationSearch, offset: 0})
        .then(next => { if (active) setAvailable(next); }).catch(err => { if (active) setError(describe(err)); });
    }, 120);
    return () => { active = false; clearTimeout(timer); };
  }, [rpc, profile, ready, conversationSearch, conversationType]);

  async function action(run: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    setError('');
    try { await run(); }
    catch (err) { setError(describe(err)); }
    finally { setBusy(false); }
  }

  const saved = data?.scope;
  const global = data?.workspace === null;
  const loadedScope = global || workspace.trim() === data?.workspace;
  const validDays = Number.isInteger(days) && days >= 1 && days <= 365;
  const saveHint = !ready ? '请先选择企业并等待同步完成。'
    : !loadedScope ? '请先加载所填的工作目录。'
    : !selectedIds.length ? '请至少选择一个会话。'
    : !validDays ? '请输入 1 到 365 天之间的整数。'
    : !share ? '请勾选上方的模型访问授权。' : '';
  const selectAll = () => action(async () => {
    if (!profile) return;
    const ids = await rpc<string[]>({op: 'contextConversations', profile});
    setSelectedIds(ids);
    if (!ids.length) setMessage('这个企业档案里没有可授权的群聊或私聊。');
  });
  const coverage = data?.job?.phase === 'indexing' ? data.job.coverage : saved?.coverage;
  const conversations = saved?.coverage?.conversations ?? [];
  const filters = {
    from: dayBoundary(fromDay), to: dayBoundary(toDay, true),
    conversation: searchConversation || undefined, sender: sender.trim() || undefined,
  };
  const validRange = !fromDay || !toDay || fromDay <= toDay;
  const canSearch = query.trim() || Object.values(filters).some(value => value !== undefined);
  const indexing = data?.job?.phase === 'indexing';
  const applyScope = (selected: string[]) => action(async () => {
    if (!data) return;
    const archive = selected.length ? profile : saved?.profile ?? profile;
    await rpc({op: 'agentScope', workspace: data.workspace, profile: archive, conversations: selected, days, share, allowImages: shareImages});
    acceptPanel(await readPanel(data.workspace));
    setMessage(selected.length ? '授权范围已保存' : '已撤销授权并清除此范围的索引和记忆');
  });

  return <section className="agent-pane" aria-label="Agent 记忆" hidden={hidden}>
    <div className="agent-inner">
      <h1>MessageGraph</h1>
      <p>选择同一家企业的群聊和私聊供 Agent 检索。长期记忆需在这里确认。</p>
      {error && <p className="agent-notice" role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      <section className="agent-card">
        <h2>授权范围</h2>
        <div className="agent-row" role="group" aria-label="DSH 使用范围">
          <button className="soft-button" aria-pressed={global} disabled={busy}
            onClick={() => { if (!global) void action(async () => acceptPanel(await readPanel(null), true)); }}>所有 DSH 工作区</button>
          <button className="soft-button" aria-pressed={!global} disabled={busy}
            onClick={() => { if (global) void action(async () => acceptPanel(await readPanel(workspace.trim() || undefined), true)); }}>指定工作区</button>
        </div>
        {global && <p>保存全局授权后，本机所有 DSH 工作区共用这里的检索索引和已确认记忆。撤销全局授权后，原有的单独工作区授权继续生效。</p>}
        {!global && <form className="agent-row" onSubmit={event => {
          event.preventDefault();
          void action(async () => acceptPanel(await readPanel(workspace.trim())));
        }}>
          <label className="agent-grow">DSH 工作目录 <input value={workspace} onChange={event => setWorkspace(event.target.value)} placeholder="/Users/…/project" required/></label>
          <button className="soft-button" disabled={busy}>加载工作目录</button>
        </form>}
        {saved && <p>当前已授权 {saved.conversations.length} 个会话，范围为最近 {saved.days} 天。
          {saved.profile !== profile && ' 要编辑会话范围，请切换到对应的企业档案。'}</p>}
        <label>检索最近 <input className="agent-days" type="number" value={days} min={1} max={365}
          onChange={event => setDays(Number(event.target.value))}/> 天</label>
        <div className="agent-row" role="group" aria-label="授权会话类型">
          <button className="soft-button" aria-pressed={conversationType === 'group'} onClick={() => setConversationType('group')}>群聊</button>
          <button className="soft-button" aria-pressed={conversationType === 'direct'} onClick={() => setConversationType('direct')}>私聊</button>
        </div>
        <div className="agent-row" role="group" aria-label="批量选择会话">
          <button type="button" className="soft-button" disabled={busy || !ready || !profile || !loadedScope}
            onClick={() => void selectAll()}>全选群聊和私聊</button>
          <button type="button" className="soft-button" disabled={busy || !selectedIds.length}
            onClick={() => setSelectedIds([])}>清空选择</button>
          <span aria-live="polite">已选 {selectedIds.length} 个会话</span>
        </div>
        <p>全选覆盖当前企业的所有群聊和私聊，包括搜索结果以外及尚未加载的会话。</p>
        <label>查找会话 <input value={conversationSearch} onChange={event => setConversationSearch(event.target.value)} disabled={!ready}/></label>
        {!ready && <p>请先在顶部选中一个企业并等待同步完成。</p>}
        <div className="agent-groups">
          {available.items.map(conversation => <label key={conversation.id}><input type="checkbox"
            checked={selected.has(conversation.id)} disabled={busy}
            onChange={event => setSelectedIds(previous => event.target.checked ? [...previous, conversation.id] : previous.filter(id => id !== conversation.id))}/>
            {conversation.name}</label>)}
          {available.more && <button className="soft-button" disabled={busy} onClick={() => void action(async () => {
            const next = await rpc<Page<Conversation>>({op: 'conversations', filter: conversationType, search: conversationSearch, offset: available.items.length});
            setAvailable({...next, items: [...available.items, ...next.items]});
          })}>加载更多会话</button>}
        </div>
        <label><input type="checkbox" checked={share} onChange={event => setShare(event.target.checked)}/>
          允许{global ? '本机所有 DSH 工作区' : '该工作目录'}中的 Agent 将命中的片段发送给所用模型。DSH 对话可能保留工具结果。</label>
        <label><input type="checkbox" checked={share && shareImages} disabled={!share}
          onChange={event => setShareImages(event.target.checked)}/>
          允许 Agent 按需将命中的图片交给所用模型查看。</label>
        <div className="agent-row">
          <button className="soft-button" disabled={busy || Boolean(saveHint)}
            onClick={() => void applyScope(selectedIds)}>保存 {selectedIds.length} 个会话的{global ? '全局' : ''}授权</button>
          {saved && <button className="soft-button" disabled={busy || !loadedScope} onClick={() => {
            if (window.confirm(`撤销${global ? '全局' : '此工作目录的'}授权，并删除插件中对应的索引和记忆？`)) void applyScope([]);
          }}>{global ? '撤销全局授权' : '撤销授权'}</button>}
          {saveHint && <span>{saveHint}</span>}
        </div>
      </section>
      <section className="agent-card">
        <h2>MessageGraph 检索</h2>
        {saved && <p>DSH 运行时，已授权会话的新消息会自动进入索引。</p>}
        <p>{data?.voiceReady ? '本地语音识别已就绪。' : '语音识别待配置。聊天和图片文字仍可建立索引。'}</p>
        <div className="agent-row">
          <button className="soft-button" disabled={!saved || busy || indexing || !loadedScope}
            onClick={() => void action(async () => {
              await rpc({op: 'agentIndex', workspace: data?.workspace});
              setData(await readPanel(data?.workspace));
            })}>{indexing ? '正在索引…' : saved?.indexed ? '刷新索引' : '建立索引'}</button>
          {saved?.indexed && <span>上次完成 {new Date(saved.indexed).toLocaleString('zh-CN')}</span>}
        </div>
        {coverage && <div className="agent-coverage">
          <strong>聊天 {coverage.indexed.text} · 图片 {coverage.indexed.image} · 语音片段 {coverage.indexed.voice}</strong>
          <span> 缓存缺失 {coverage.unavailable} · 未识别出文字 {coverage.empty} · 识别失败 {coverage.failed}</span>
          {coverage.verifiedFiles !== undefined && <span> · 已校验附件 {coverage.verifiedFiles} · 未校验附件 {coverage.unverifiedFiles}</span>}
          {coverage.setup > 0 && <span> · 语音待配置 {coverage.setup}</span>}
          {((coverage.limitedConversations ?? coverage.limitedGroups ?? 0) > 0 || coverage.limitedMedia > 0) && <span> · 达到索引上限</span>}
        </div>}
        {data?.job?.phase === 'error' && <p role="alert">{describe(data.job.error)}</p>}
        <form className="agent-search" onSubmit={event => {
          event.preventDefault();
          if (!validRange || !canSearch) return;
          void action(async () => setExploration(await rpc<Exploration>({op: 'agentExplore', workspace: data?.workspace,
            query: query.trim(), kind: kind || undefined, filters})));
        }}>
          <div className="agent-row">
            <label className="agent-grow">检索内容 <input value={query} onChange={event => setQuery(event.target.value)} maxLength={200}/></label>
            <label>类型 <select value={kind} onChange={event => setKind(event.target.value as SourceKind | '')}>
              <option value="">全部</option>
              {Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select></label>
          </div>
          <div className="agent-row">
            <label>开始日期 <input type="date" value={fromDay} onChange={event => setFromDay(event.target.value)} max={toDay || undefined}/></label>
            <label>结束日期 <input type="date" value={toDay} onChange={event => setToDay(event.target.value)} min={fromDay || undefined}/></label>
            <label>会话 <select value={searchConversation} onChange={event => setSearchConversation(event.target.value)}>
              <option value="">全部会话</option>
              {conversations.map(({name, type, ref}, index) =>
                <option key={ref ?? index} value={ref ?? name}>{type === 'group' ? '群聊' : '私聊'} · {name}</option>)}
            </select></label>
            <label>发送人 <input value={sender} onChange={event => setSender(event.target.value)} maxLength={200} placeholder="输入聊天中的显示名称"/></label>
          </div>
          <div className="agent-row">
            <button className="soft-button" disabled={busy || !saved?.indexed || !validRange || !canSearch}>检索</button>
            <button type="button" className="soft-button" disabled={busy} onClick={() => {
              setFromDay(''); setToDay(''); setSearchConversation(''); setSender('');
            }}>清除筛选</button>
          </div>
        </form>
        {exploration && !exploration.hits.length && !exploration.relations.length && <p>在已索引范围内没有找到匹配的记录。</p>}
        {exploration?.context && <ContextResults key={JSON.stringify([exploration.context.messages.map(item => item.source.ref), exploration.context.continuations])}
          context={exploration.context} open={open}
          load={step => rpc<ContinuationPage>({op: 'agentContinue', ...step.args, tool: step.tool})}/>}
        {exploration?.truncated && <p>已展示部分证据，可以缩小查询范围。</p>}
        {exploration && exploration.relations.length > 0 && <h3>跨会话关联</h3>}
        {exploration?.relations.map(({kind, basis, label, from, to}) => <article className="agent-result"
          key={JSON.stringify([kind, label, from.source.ref, to.source.ref])}>
          <strong>关联依据 · {relationLabels[kind]}</strong>
          {(label || kind === 'named_handoff') && <small>{label || relationLabels[basis]}</small>}
          <div className="agent-endpoints">{[from, to].map(({text, source}) => <div key={source.ref}>
            <small>{sourceTime(source)}</small>
            <p>{text || labels[source.kind]}</p>
            <button className="soft-button" onClick={() => open(source.ref)}>查看原消息 · {sourceName(source)}</button>
          </div>)}</div>
        </article>)}
        {exploration?.hits.filter(hit => !exploration.context?.messages.some(item => item.source.ref === hit.source.ref)).map(hit => <article className="agent-result" key={hit.source.ref}>
          <strong>{labels[hit.source.kind]} · {hit.reasons.map(reason => reasonLabels[reason.type]).join('、')}</strong>
          <p>{hit.text || (hit.source.mediaState === 'unavailable' ? '本机缓存不可用' : '查看原消息中的媒体')}</p>
          <small>{sourceTime(hit.source)}</small>
          <button className="soft-button" onClick={() => open(hit.source.ref)}>查看原消息</button>
        </article>)}
      </section>
      {saved && <section className="agent-card">
        <h2>CLI / MCP 授权</h2>
        <p>为单个客户端创建只读授权。它会使用此范围的会话索引和已确认记忆。</p>
        <form className="agent-row" onSubmit={event => {
          event.preventDefault();
          if (!data) return;
          void action(async () => {
            setExternalConfig(await rpc<ExternalConfig>({op: 'agentGrantExternal', workspace: data.workspace, label: clientLabel.trim()}));
            setData(await readPanel(data.workspace));
            setClientLabel('');
          });
        }}>
          <label className="agent-grow">客户端名称 <input value={clientLabel} maxLength={80} placeholder="例如 Codex"
            onChange={event => setClientLabel(event.target.value)}/></label>
          <button className="soft-button" disabled={busy || !loadedScope || !clientLabel.trim()}>创建只读授权</button>
        </form>
        {externalConfig && <div className="agent-row">
          <button className="soft-button" onClick={() => void action(async () => {
            const {command, args, env} = externalConfig;
            await navigator.clipboard.writeText(JSON.stringify({mcpServers: {messagegraph: {command, args, env}}}, null, 2));
            setMessage('已复制包含访问令牌的 MCP 配置');
          })}>复制 MCP 配置</button>
          <button className="soft-button" onClick={() => void action(async () => {
            const {command, args, env} = externalConfig;
            const lines = ['[mcp_servers.messagegraph]', `command = ${JSON.stringify(command)}`,
              `args = ${JSON.stringify(args)}`, '', '[mcp_servers.messagegraph.env]',
              ...Object.entries(env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`)];
            await navigator.clipboard.writeText(lines.join('\n') + '\n');
            setMessage('已复制包含访问令牌的 Codex 配置');
          })}>复制 Codex 配置</button>
          <button className="soft-button" onClick={() => setExternalConfig(undefined)}>收起凭证</button>
        </div>}
        {data?.externalGrants?.map(grant => <div className="agent-row" key={grant.id}>
          <span>{grant.label}</span>
          <button className="soft-button" disabled={busy} onClick={() => void action(async () => {
            await rpc({op: 'agentRevokeExternal', workspace: data.workspace, id: grant.id});
            if (externalConfig?.id === grant.id) setExternalConfig(undefined);
            setData(await readPanel(data.workspace));
          })}>撤销 {grant.label}</button>
        </div>)}
      </section>}
      <section className="agent-card">
        <h2>待确认和已保存的记忆</h2>
        <p>在{global ? '任意 DSH 工作区' : '此 DSH 工作区'}，可以请 Agent 根据已找到的原消息提出记忆。</p>
        {!data?.memories.length && <p>当前没有记忆。</p>}
        {data?.memories.map(memory => <article className="agent-result" key={memory.id} data-memory-state={memory.state}>
          <strong>{memory.state === 'pending' ? '待确认' : '已保存'}</strong>
          <p>{memory.note}</p><small>{sourceTime(memory.source)}</small>
          <div className="agent-row">
            <button className="soft-button" onClick={() => open(memory.source.ref)}>查看原消息</button>
            {memory.state === 'pending' && <button className="soft-button agent-primary" disabled={busy}
              onClick={() => void action(async () => {
                await rpc({op: 'agentApprove', workspace: data.workspace, id: memory.id});
                setData(await readPanel(data.workspace));
              })}>确认写入</button>}
            <button className="soft-button" disabled={busy} onClick={() => void action(async () => {
              await rpc({op: memory.state === 'pending' ? 'agentReject' : 'agentForget', workspace: data.workspace, id: memory.id});
              setData(await readPanel(data.workspace));
            })}>{memory.state === 'pending' ? '拒绝' : '删除记忆'}</button>
          </div>
        </article>)}
      </section>
    </div>
  </section>;
}
