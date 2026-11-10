import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Bookmark, Building2, CircleAlert, ContactRound, Download, FolderOpen, LockKeyhole, MessagesSquare, Pause, Play, RefreshCw, X } from 'lucide-react';
import type { DatabaseExport, Profile, SyncState } from '../../../packages/wecom-core/src/types';
import { Browser, type Tab } from './Browser';
import { AgentMemory, type Original } from './AgentMemory';
import { Chat } from './Chat';
import { clock, describe, formatNumber, phaseLabels, pluginTitle } from './presentation';
import { Transport, useTransport, type WeComTransport } from './transport';

export function WeComApp({transport, reference}: {transport: WeComTransport; reference?: {ref: string}}) {
  return <Transport.Provider value={transport}><App reference={reference}/></Transport.Provider>;
}

const initialState: SyncState = {
  phase: 'idle', profile: null, revision: 0, updatedAt: null, issues: [],
  counts: {contacts: 0, conversations: 0, messages: 0},
};

function Mark() { return <div className="mark"><MessagesSquare size={20} strokeWidth={2.2}/></div>; }

function App({reference}: {reference?: {ref: string}}) {
  const {request: rpc, exportDatabases} = useTransport();
  const [state, setState] = useState(initialState);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [discovering, setDiscovering] = useState(true);
  const [error, setError] = useState('');
  const [selection, setSelection] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState<DatabaseExport | null>(null);
  const [tab, setTab] = useState<Tab | 'agent'>('conversations');
  const companyTabs = useRef<HTMLDivElement>(null);
  const [original, setOriginal] = useState<Original>();
  const openRequest = useRef(0);
  const open = useCallback(async (ref: string) => {
    const active = ++openRequest.current;
    setTab('agent');
    setError('');
    setOriginal(undefined);
    try {
      const result = await rpc<Original>({op: 'agentSource', ref});
      if (active === openRequest.current) setOriginal(result);
    } catch (err) { if (active === openRequest.current) setError(describe(err)); }
  }, [rpc]);
  useEffect(() => { if (reference) void open(reference.ref); }, [open, reference]);
  function navigate(next: Tab | 'agent') {
    openRequest.current++;
    setOriginal(undefined);
    setTab(next);
  }

  const find = useCallback(async () => {
    setDiscovering(true);
    setError('');
    try {
      setProfiles(await rpc<Profile[]>({op: 'discover'}));
    } catch (err) { setError(describe(err)); }
    finally { setDiscovering(false); }
  }, [rpc]);

  useEffect(() => { void find(); }, [find]);
  useEffect(() => {
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout>;
    async function check() {
      try {
        const data = await rpc<SyncState>({op: 'status'});
        if (!cancelled) setState(data);
      } catch (err) {
        if (!cancelled) setError(describe(err));
      } finally {
        if (!cancelled) timeout = setTimeout(check, 1000);
      }
    }
    void check();
    return () => { cancelled = true; clearTimeout(timeout); };
  }, [rpc]);

  async function select(profile: Profile) {
    if (profile.id === state.profile || selection) return;
    setError('');
    setExported(null);
    setSelection(profile.id);
    try {
      setState(await rpc<SyncState>({op: 'select', id: profile.id}));
      navigate('conversations');
    } catch (err) { setError(describe(err)); }
    finally { setSelection(null); }
  }
  async function pause() {
    try {
      setError('');
      setState(await rpc<SyncState>({op: 'pause', paused: state.phase !== 'paused'}));
    } catch (err) { setError(describe(err)); }
  }
  async function exportSnapshot() {
    if (!state.profile || !state.updatedAt || exporting) return;
    setExporting(true);
    setExported(null);
    setError('');
    try {
      setExported(await exportDatabases(state.profile));
    } catch (err) { setError(describe(err)); }
    finally { setExporting(false); }
  }

  const current = profiles.find(profile => profile.id === state.profile);
  const ready = Boolean(state.updatedAt);
  return <div className="application">
    <header className="titlebar">
      <div className="brand"><Mark/><div><strong>{pluginTitle}</strong><span>本地档案浏览器</span></div></div>
      <div className="top-actions">
        <span className="readonly"><LockKeyhole size={13}/> 本地只读</span>
        <button className="soft-button" disabled={!ready || exporting || !!selection} onClick={() => void exportSnapshot()}>
          {exporting ? <RefreshCw size={15} className="spin"/> : <Download size={15}/>}
          {exporting ? '正在导出…' : '导出明文数据库'}
        </button>
        <button className="soft-button" aria-label="重新扫描企业档案" disabled={discovering || !!selection} onClick={() => void find()}>
          <RefreshCw size={15} className={discovering ? 'spin' : undefined}/>重新扫描
        </button>
      </div>
    </header>
    <div className="company-bar">
      <span className="company-bar-label"><Building2 size={15}/>企业</span>
      <div className="company-tabs" role="tablist" aria-label="企业档案" ref={companyTabs}
        onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          const enabled = [...(companyTabs.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
          if (!enabled.length) return;
          const index = enabled.indexOf(event.target as HTMLButtonElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1
            : (index + (event.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length;
          event.preventDefault();
          enabled[next].focus();
        }}>
        {profiles.map(profile => <button key={profile.id} type="button" role="tab"
          aria-selected={(selection ?? state.profile) === profile.id} aria-controls="archive-workspace"
          disabled={!profile.available || !!selection || exporting}
          title={profile.issue ? `${profile.name} · ${describe(profile.issue)}` : profile.name}
          onClick={() => void select(profile)}>
          <span>{profile.name}</span>
          {!profile.available && <CircleAlert size={13}/>}
        </button>)}
        {!profiles.length && <span className="company-empty">{discovering ? '正在查找本机企业档案…' : '未找到本机企业档案'}</span>}
      </div>
    </div>
    {error && <div className="error-banner" role="alert"><CircleAlert size={16}/>{error}<button onClick={() => setError('')} aria-label="关闭提示"><X size={15}/></button></div>}
    {exported && <div className="export-banner" role="status">
      <FolderOpen size={16}/><div><strong>已导出 {exported.files.length} 个明文 SQLite 数据库</strong><span>{exported.directory}</span></div>
      <button onClick={() => setExported(null)} aria-label="关闭导出结果"><X size={15}/></button>
    </div>}
    <main className="workspace" id="archive-workspace">
      <nav className="rail" aria-label="主导航">
        <button aria-pressed={tab === 'conversations'} onClick={() => navigate('conversations')}><MessagesSquare size={21}/><span>消息</span></button>
        <button aria-pressed={tab === 'contacts'} onClick={() => navigate('contacts')}><ContactRound size={21}/><span>通讯录</span></button>
        <button aria-pressed={tab === 'agent'} onClick={() => navigate('agent')}><Bookmark size={20}/><span>Agent 记忆</span></button>
        <div className="rail-spacer"/>
        <button aria-pressed={tab === 'status'} onClick={() => navigate('status')}><Activity size={21}/><span>同步</span></button>
      </nav>
      {tab === 'agent' && <AgentMemory profile={state.profile} ready={ready} hidden={Boolean(original)} open={ref => void open(ref)}/>}
      {original ? <div className="agent-original">
        <button className="soft-button" onClick={() => navigate('agent')}>返回 MessageGraph</button>
        <Chat key={original.ref} conversation={original.conversation} revision={0} profile={original.profile}
          original={original}/>
      </div> : tab === 'agent' ? null : tab === 'status' ? <StatusPane state={state} onPause={() => void pause()}/> :
        <Browser key={state.profile ?? 'none'} state={state} tab={tab} ready={ready}
          discovering={discovering} hasProfiles={profiles.length > 0} onTab={setTab} />}
    </main>
    <footer className="statusbar">
      <span><i className={`status-dot ${state.phase}`}/>{phaseLabels[state.phase]}</span>
      <span className="status-separator"/><span>{current?.name ?? '企微本地档案'}</span>
      <span className="footer-end">{state.updatedAt && `上次同步 ${clock.format(new Date(state.updatedAt))}`}</span>
    </footer>
  </div>;
}

function StatusPane({state, onPause}: {state: SyncState; onPause: () => void}) {
  return <section className="sync-pane">
    <div className="sync-inner">
      <div className="sync-top"><div className="status-symbol"><Activity size={25}/></div><div><p className="eyebrow">本地档案</p><h1>同步状态</h1></div></div>
      <div className="sync-card">
        <div><i className={`status-dot ${state.phase}`}/><strong>{phaseLabels[state.phase]}</strong></div>
        {state.profile && <button className="soft-button" onClick={onPause}>{state.phase === 'paused' ? <Play size={15}/> : <Pause size={15}/>}
          {state.phase === 'paused' ? '继续同步' : '暂停同步'}</button>}
      </div>
      <div className="statistics">
        {([['会话', state.counts.conversations], ['联系人', state.counts.contacts], ['消息', state.counts.messages]] as const)
          .map(([name, count]) => <div key={name}><span>{name}</span><strong>{formatNumber.format(count)}</strong></div>)}
      </div>
      <div className="sync-card updated"><span>最近成功同步</span><strong>{state.updatedAt ? new Date(state.updatedAt).toLocaleString('zh-CN') : '—'}</strong></div>
      {state.issues.map(issue => <div className="inline-status" key={issue}><CircleAlert size={16}/>{describe(issue)}</div>)}
    </div>
  </section>;
}
