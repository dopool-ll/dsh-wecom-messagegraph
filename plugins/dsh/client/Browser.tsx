import { useCallback, useEffect, useRef, useState } from 'react';
import { BellOff, ChevronRight, CircleAlert, ContactRound, FolderOpen, MessageCircle, MessagesSquare, RefreshCw, Search, ShieldCheck, UsersRound, X } from 'lucide-react';
import type { Contact, ContactFilter, Conversation, ConversationFilter, Page, SyncState } from '../../../packages/wecom-core/src/types';
import { Avatar } from './Avatar';
import { Chat } from './Chat';
import { describe, formatNumber, shortDate, toDate } from './presentation';
import { useTransport } from './transport';

export type Tab = 'conversations' | 'contacts' | 'status';
const conversationFilters: [ConversationFilter, string][] = [
  ['all', '全部'], ['group', '群聊'], ['direct', '单聊'], ['internal', '内部'], ['external', '外部'],
];
const contactFilters: [ContactFilter, string][] = [['all', '全部'], ['internal', '内部'], ['external', '外部']];
const contactScopes = {internal: '内部', external: '外部', unknown: '未分类'};

interface BrowserProps {
  state: SyncState; tab: Exclude<Tab, 'status'>; ready: boolean;
  discovering: boolean; hasProfiles: boolean; onTab: (tab: Tab) => void;
}

export function Browser(props: BrowserProps) {
  const {request: rpc} = useTransport();
  const {state, tab, ready, discovering, hasProfiles, onTab} = props;
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ConversationFilter>('all');
  const [contactFilter, setContactFilter] = useState<ContactFilter>('all');
  const [conversation, setConversation] = useState<Conversation>();
  const [contact, setContact] = useState<Contact>();
  const [page, setPage] = useState<Page<Contact | Conversation>>({items: [], more: false});
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const listRequest = useRef<{pending: boolean} | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const isContacts = tab === 'contacts';
  const nextOffset = page.items.length;

  const load = useCallback(async (offset = 0) => {
    if (offset && listRequest.current?.pending) return;
    const request = {pending: true};
    listRequest.current = request;
    setLoading(true);
    setError('');
    try {
      const data = await rpc<Page<Contact | Conversation>>(isContacts
        ? {op: 'contacts', search, offset, filter: contactFilter} : {op: 'conversations', search, offset, filter});
      if (request !== listRequest.current) return;
      setPage(previous => offset ? {...data, items: [...previous.items, ...data.items]} : data);
      if (!isContacts) setConversation(previous => {
        const matches = previous && (filter === 'all' || previous.kind === filter || previous.scope === filter);
        if (!matches) return data.items[0] as Conversation | undefined;
        return data.items.find(item => item.id === previous.id) as Conversation | undefined ?? previous;
      });
    } catch (err) {
      if (request === listRequest.current) setError(describe(err));
    } finally {
      if (request === listRequest.current) {
        request.pending = false;
        setLoading(false);
      }
    }
  }, [rpc, isContacts, search, filter, contactFilter]);
  useEffect(() => {
    setSearch('');
    setPage({items: [], more: false});
    list.current?.scrollTo(0, 0);
  }, [tab]);
  useEffect(() => {
    if (!ready) return;
    listRequest.current = {pending: true};
    setLoading(true);
    const debounce = setTimeout(() => void load(), search ? 140 : 0);
    return () => { clearTimeout(debounce); listRequest.current = null; };
  }, [ready, search, load, state.revision]);
  useEffect(() => {
    const root = list.current;
    const target = moreButton.current;
    if (!ready || !page.more || loading || error || !root || !target) return;
    const request = listRequest.current;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting || request !== listRequest.current) return;
      observer.disconnect();
      void load(nextOffset);
    }, {root, rootMargin: '0px 0px 160px 0px'});
    observer.observe(target);
    return () => observer.disconnect();
  }, [ready, page.more, loading, error, nextOffset, load, state.revision]);

  function resetList() {
    listRequest.current = {pending: true};
    setLoading(true);
    setError('');
    setPage({items: [], more: false});
    list.current?.scrollTo(0, 0);
  }

  return <>
    <aside className={`list-pane${isContacts ? '' : ' conversation-pane'}`}>
      <div className="list-heading">
        <h1>{isContacts ? '通讯录' : '消息'}<span>{ready && (!isContacts || contactFilter === 'all' || page.total !== undefined)
          ? formatNumber.format(page.total ?? (isContacts ? state.counts.contacts : state.counts.conversations)) : '—'}</span></h1>
        <label className="search"><Search size={16}/><input aria-label={isContacts ? '搜索联系人' : '搜索会话'} placeholder={isContacts ? '搜索联系人' : '搜索会话'} value={search}
          onChange={event => { resetList(); setSearch(event.target.value); }}/>
          {search && <button onClick={() => { resetList(); setSearch(''); }} aria-label="清除搜索"><X size={14}/></button>}
        </label>
        {isContacts ? <div className="list-filters contact-filters" role="group" aria-label="联系人类型">
          {contactFilters.map(([key, name]) => <button key={key} aria-pressed={contactFilter === key}
            onClick={() => {
              if (key === contactFilter) return;
              resetList();
              setContactFilter(key);
              if (key !== 'all' && contact?.scope !== key) setContact(undefined);
            }}>{name}</button>)}
        </div> : <div className="list-filters" role="group" aria-label="会话类型">
          {conversationFilters.map(([key, name]) => <button key={key} aria-pressed={filter === key}
            onClick={() => {
              if (key === filter) { list.current?.scrollTo(0, 0); return; }
              resetList();
              setFilter(key);
            }}>{name}</button>)}
        </div>}
      </div>
      <div className={`list-scroll${isContacts ? '' : ' conversation-scroll'}`} ref={list}>
        {!ready ? <div className="list-empty"><FolderOpen size={22}/><span>选择档案后显示{isContacts ? '联系人' : '会话'}</span></div> :
          <>
            {error && <div className="small-muted">{error}</div>}
            {!page.items.length && !loading && <div className="list-empty"><Search size={21}/><span>{search ? '没有匹配结果' : '暂无记录'}</span></div>}
            {isContacts ? (page.items as Contact[]).map(item =>
              <button key={item.id} className={`list-row ${contact?.id === item.id ? 'selected' : ''}`} onClick={() => setContact(item)}>
                <Avatar name={item.name}/><span className="row-body">
                  <span className="row-title"><strong>{item.name}</strong><small>{contactScopes[item.scope]}</small></span>
                  <span>{item.job || '本地联系人'}</span>
                </span>
              </button>) :
              (page.items as Conversation[]).map(item =>
                <ConversationRow key={item.id} item={item} profile={state.profile}
                  selected={conversation?.id === item.id} onSelect={() => setConversation(item)}/>)}
            {page.more && <button ref={moreButton} className="more-list" disabled={loading} onClick={() => void load(nextOffset)}>
              {loading ? '正在读取…' : error ? '重试加载' : '加载更多'}
            </button>}
          </>}
      </div>
    </aside>
    {!ready ? <Welcome {...{state, discovering, hasProfiles}}/> :
      isContacts ? (contact ? <ContactPane contact={contact} revision={state.revision} onConversation={value => { setFilter('all'); setConversation(value); onTab('conversations'); }}/> :
        <div className="empty-detail"><ContactRound size={32}/><p>选择一个联系人</p></div>) :
      conversation ? <Chat key={conversation.id} conversation={conversation} revision={state.revision} profile={state.profile}/> :
        <div className="empty-detail"><MessageCircle size={32}/><p>选择一个会话</p></div>}
  </>;
}

function ConversationRow({item, profile, selected, onSelect}: {
  item: Conversation; profile: string | null; selected: boolean; onSelect(): void;
}) {
  const unread = item.unreadCount ?? 0;
  const stamp = toDate(item.time);
  return <button type="button" className={`list-row conversation-row${selected ? ' selected' : ''}`}
    aria-pressed={selected} onClick={onSelect}>
    <span className="conversation-avatar">
      <ConversationAvatar item={item} profile={profile}/>
      {unread > 0 && <span className={`conversation-unread${item.muted ? ' dot' : ''}`}
        aria-label={`${unread} 条未读`} title={`${unread} 条未读`}>
        {!item.muted && (unread > 99 ? '99+' : unread)}
      </span>}
    </span>
    <span className="conversation-body">
      <span className="conversation-title">
        <strong title={item.name}>{item.name}</strong>
        {item.scope === 'external' && <small className="conversation-external">外部</small>}
        {item.muted && <span className="conversation-muted" title="消息免打扰" aria-label="消息免打扰"><BellOff size={13}/></span>}
      </span>
      <span className="conversation-summary">
        <span className="conversation-preview">
          {item.muted && unread > 0 && `[${unread}条] `}
          {item.previewSender && `${item.previewSender}: `}{item.preview || '暂无消息'}
        </span>
        {stamp && <time dateTime={stamp.toISOString()}>{shortDate(item.time)}</time>}
      </span>
    </span>
  </button>;
}

function ConversationAvatar({item, profile}: {item: Conversation; profile: string | null}) {
  const {request} = useTransport();
  const node = useRef<HTMLSpanElement>(null);
  const [images, setImages] = useState<string[]>([]);
  const group = item.kind === 'group';

  useEffect(() => {
    if (!profile || !node.current || item.kind === 'unknown') return;
    let active = true;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      observer.disconnect();
      request<string[]>({op: 'conversationAvatars', profile, id: item.id}).then(
        result => { if (active) setImages(result); },
        () => { /* Keep the fallback when the cache is unavailable. */ },
      );
    });
    observer.observe(node.current);
    return () => { active = false; observer.disconnect(); };
  }, [item.id, item.kind, profile, request]);

  const photos = !group ? 'conversation-photos' :
    `conversation-photos group${images.length <= 4 ? ' compact' : ''}`;
  return <span className="conversation-avatar-content" ref={node} aria-hidden="true">
    {images.length >= (group ? 2 : 1)
      ? <span className={photos}>
        {images.map((src, index) => <img key={index} src={src} alt="" decoding="async"
          onError={() => setImages(current => current.filter(image => image !== src))}/>)}
      </span>
      : group ? <span className="avatar conversation-group-fallback"><UsersRound size={20}/></span>
        : <Avatar name={item.name}/>}
  </span>;
}

function Welcome({state, discovering, hasProfiles}: Pick<BrowserProps, 'state' | 'discovering' | 'hasProfiles'>) {
  return <section className="welcome">
    <div className="welcome-content">
      <div className="welcome-icon"><MessagesSquare size={36} strokeWidth={1.55}/><span><ShieldCheck size={16}/></span></div>
      <p className="eyebrow">本地消息档案</p>
      <h2>从顶部选择企业</h2>
      <p className="muted intro">{discovering ? '正在查找本机企业档案…' : hasProfiles
        ? '选择企业后，查看它在这台设备上的会话、联系人和历史消息。'
        : '当前没有找到企业档案，可以重新扫描。'}</p>
      {state.phase === 'syncing' && <div className="inline-status"><RefreshCw size={16} className="spin"/>正在解密并建立本地视图…</div>}
      {state.phase === 'retrying' && <div className="inline-status"><CircleAlert size={16}/>{describe(state.issues[0])}</div>}
    </div>
  </section>;
}

function ContactPane({contact, revision, onConversation}: {contact: Contact; revision: number; onConversation: (value: Conversation) => void}) {
  const {request: rpc} = useTransport();
  const [related, setRelated] = useState<Conversation[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setError('');
    rpc<Page<Conversation>>({op: 'contactConversations', id: contact.id}).then(
      result => { if (active) setRelated(result.items); },
      err => { if (active) { setRelated([]); setError(describe(err)); } },
    );
    return () => {active = false;};
  }, [contact.id, revision]);
  return <section className="contact-pane">
    <div className="detail-header"><h2>联系人资料</h2><span className="scope-badge">{contactScopes[contact.scope]}</span></div>
    <div className="contact-inner">
      <div className="contact-card"><Avatar name={contact.name} size="large"/><div><h2>{contact.name}</h2><p>{contact.job || '本地联系人'}</p></div></div>
      <h3>发过消息的会话</h3>
      {related.map(item => <button key={item.id} className="related" onClick={() => onConversation(item)}><MessageCircle size={17}/>{item.name}<ChevronRight size={15}/></button>)}
      {error && <p className="muted">{error}</p>}
      {!related.length && !error && <p className="muted">当前档案没有此联系人的消息记录。</p>}
    </div>
  </section>;
}
