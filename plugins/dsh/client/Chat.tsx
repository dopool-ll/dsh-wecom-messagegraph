import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, LockKeyhole, MessageCircle } from 'lucide-react';
import type { Conversation, Message, MessagePart, Page } from '../../../packages/wecom-core/src/types';
import { Avatar } from './Avatar';
import type { Original } from './AgentMemory';
import { ConversationCopilot } from './ConversationCopilot';
import { clock, describe, formatNumber, fullDate, toDate } from './presentation';
import { useTransport } from './transport';

const richLabels = {
  image: '图片', video: '视频', voice: '语音', file: '文件', sticker: '表情',
  link: '链接', location: '位置', card: '卡片', forward: '合并转发', system: '系统消息',
} as const;

function readableSize(bytes?: number) {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type AudioAnchor = {ref: string; part?: number; startMs?: number};

function MessageBody({item, profile, conversation, anchor}: {item: Message; profile: string | null; conversation: string; anchor?: AudioAnchor}) {
  if (item.kind === 'mixed') {
    return <div className="bubble mixed-bubble">
      {item.parts.map((part, index) => <MessagePartBody key={index} item={part} id={item.id}
        profile={profile} conversation={conversation} part={index} sourceRef={anchor?.ref} startMs={anchor?.part === index ? anchor.startMs : undefined}/>)}
    </div>;
  }
  return <MessagePartBody item={item} id={item.id} profile={profile} conversation={conversation} sourceRef={anchor?.ref} startMs={anchor?.startMs}/>;
}

function MessagePartBody({item, id, profile, conversation, part, startMs, sourceRef}: {
  item: MessagePart;
  id: string;
  profile: string | null;
  conversation: string;
  part?: number;
  startMs?: number;
  sourceRef?: string;
}) {
  const {readMedia} = useTransport();
  const [attempt, setAttempt] = useState(0);
  const [asset, setAsset] = useState<{url: string; mime: string}>();
  const [failed, setFailed] = useState(false);
  const target = useRef<HTMLDivElement>(null);
  const inlineImage = item.kind === 'image' || item.kind === 'sticker';
  const isMedia = item.localMedia !== undefined;
  const canRead = Boolean(profile && item.localMedia && readMedia);
  const canRecheckImage = !sourceRef && item.kind === 'image' && isMedia && Boolean(profile && readMedia);
  const load = attempt > 0;

  useEffect(() => {
    if (!inlineImage || !canRead || load || !target.current) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      setAttempt(1);
      observer.disconnect();
    });
    observer.observe(target.current);
    return () => observer.disconnect();
  }, [inlineImage, canRead, load]);

  useEffect(() => {
    if (!attempt || (!canRead && !canRecheckImage) || !readMedia || !profile) return;
    const controller = new AbortController();
    let url: string | undefined;
    setFailed(false);
    setAsset(undefined);
    const refreshCache = canRecheckImage && (!canRead || attempt > 1);
    void readMedia(profile, conversation, id, controller.signal, part, refreshCache, sourceRef).then(blob => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(blob);
      setAsset({url, mime: blob.type});
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [attempt, canRead, canRecheckImage, readMedia, profile, conversation, id, part, sourceRef]);

  const wrapper = part === undefined ? 'bubble' : 'mixed-part';
  if (item.kind === 'text' || item.kind === 'unknown')
    return <div className={`${wrapper}${item.placeholder ? ' placeholder' : ''}`}>{item.text}</div>;
  const label = richLabels[item.kind];
  const detail = item.detail;
  const reading = load && (canRead || canRecheckImage) && !asset && !failed;
  const unavailable = isMedia && !item.localMedia && !asset && !reading;
  const size = readableSize(detail?.bytes);
  const dimensions = detail?.width && detail.height ? `${detail.width} × ${detail.height}` : '';
  const stats = [detail?.seconds ? `${detail.seconds} 秒` : '', size, dimensions,
    detail?.count ? `${detail.count} 条记录` : ''].filter(Boolean).join(' · ');
  const attachmentName = detail?.name ?? (item.kind === 'video' ? 'video.mp4' : 'attachment');
  return <div className={`${wrapper} rich-bubble`} ref={target}>
    <span className="rich-kind">{label}</span>
    {item.kind === 'file' ? detail?.name && <strong>{detail.name}</strong> :
      !isMedia && <strong>{item.text}</strong>}
    {detail?.description && <span className="rich-muted">{detail.description}</span>}
    {detail?.url && <span className="rich-url">{detail.url}</span>}
    {stats && <span className="rich-muted">{stats}</span>}
    {canRead && item.localPreview && <span className="rich-muted">本机缓存预览</span>}
    {unavailable && <span className="rich-muted" role="status">本地缓存不可用</span>}
    {canRecheckImage && (unavailable || failed) && <button type="button" className="soft-button" onClick={() => {
      setAsset(undefined);
      setFailed(false);
      setAttempt(value => value + 1);
    }}>
      重新检查本地缓存
    </button>}
    {canRead && !load && !inlineImage && <button type="button" className="soft-button" onClick={() => setAttempt(1)}>
      {item.kind === 'file' ? '读取本地文件' : `加载${label}`}
    </button>}
    {reading && <span className="rich-muted">正在读取本地缓存…</span>}
    {failed && !unavailable && <span className="rich-muted" role="status">无法预览本地缓存</span>}
    {asset && inlineImage && !failed && <img className="message-image" src={asset.url} alt={label} onError={() => setFailed(true)}/>}
    {asset && item.kind === 'video' && !failed && <video className="message-video" src={asset.url} controls playsInline preload="metadata" onError={() => setFailed(true)}/>}
    {asset && item.kind === 'voice' && !failed && <audio onLoadedMetadata={event => {
          if (startMs !== undefined && startMs / 1000 <= event.currentTarget.duration) event.currentTarget.currentTime = startMs / 1000;
        }} className="message-audio" src={asset.url} controls preload="metadata" onError={() => setFailed(true)}/>}
    {asset && (item.kind === 'file' || (item.kind === 'video' && failed)) &&
      <a className="rich-download" href={asset.url} download={attachmentName}>保存本地文件</a>}
  </div>;
}

export function Chat({conversation, revision, profile, original: openedSource}: {
  conversation: Conversation; revision: number; profile: string | null;
  original?: AudioAnchor & {id: string; items: Message[]};
}) {
  const {request: rpc} = useTransport();
  const [copilotSource, setCopilotSource] = useState<Original>();
  const original = openedSource ?? copilotSource;
  const [page, setPage] = useState<Page<Message>>({items: [], more: false});
  const items = original?.items ?? page.items;
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const view = useRef<HTMLDivElement>(null);
  const request = useRef(0);
  const previous = useRef<Page<Message>>({items: [], more: false});
  const scroll = useRef<{bottom?: boolean; anchor?: string; offset?: number}>({bottom: true});
  const returnScroll = useRef<typeof scroll.current>({});
  useLayoutEffect(() => {
    previous.current = page;
    const box = view.current;
    if (!box) return;
    if (original) {
      const target = [...box.querySelectorAll<HTMLElement>('[data-message-id]')]
        .find(element => element.dataset.messageId === original.id);
      if (target) box.scrollTop += target.getBoundingClientRect().top - box.getBoundingClientRect().top - box.clientHeight / 3;
      return;
    }
    if (scroll.current.bottom) box.scrollTop = box.scrollHeight;
    else if (scroll.current.anchor) {
      const target = [...box.querySelectorAll<HTMLElement>('[data-message-id]')]
        .find(element => element.dataset.messageId === scroll.current.anchor);
      if (target) box.scrollTop += target.getBoundingClientRect().top -
        box.getBoundingClientRect().top - (scroll.current.offset ?? 0);
    }
    scroll.current = {};
  }, [page, original]);
  function nearEnd() {
    const box = view.current;
    return !box || box.scrollHeight - box.scrollTop - box.clientHeight < 70;
  }
  function preserveScroll(followLatest: boolean) {
    const box = view.current;
    if (!box || followLatest) {
      scroll.current = {bottom: true};
      return;
    }
    const top = box.getBoundingClientRect().top;
    const anchor = [...box.querySelectorAll<HTMLElement>('[data-message-id]')]
      .find(element => element.getBoundingClientRect().bottom > top);
    scroll.current = anchor ? {anchor: anchor.dataset.messageId, offset: anchor.getBoundingClientRect().top - top} : {};
  }
  useEffect(() => {
    if (original) return;
    const active = ++request.current;
    setLoading(false);
    setError('');
    async function refresh() {
      try {
        const old = previous.current.items;
        let result = await rpc<Page<Message>>({op: 'messages', id: conversation.id});
        // Rebuild the visible range through the oldest displayed record. This
        // preserves history and handles refreshes that insert more than one page.
        const oldest = old[0]?.id;
        while (active === request.current && oldest && result.more && result.items[0] &&
            !result.items.some(item => item.id === oldest) && result.items.length < old.length + 120) {
          const older = await rpc<Page<Message>>({op: 'messages', id: conversation.id, before: result.items[0].id});
          if (!older.items.length) break;
          result = {items: [...older.items, ...result.items], more: older.more};
        }
        if (active !== request.current) return;
        preserveScroll(nearEnd());
        setPage(result);
      } catch (err) { if (active === request.current) setError(describe(err)); }
    }
    void refresh();
    return () => { request.current++; };
  }, [conversation.id, revision, original]);

  async function loadOlder() {
    if (original || loading || !page.more || !page.items[0]) return;
    const active = ++request.current;
    setLoading(true);
    setError('');
    try {
      const result = await rpc<Page<Message>>({op: 'messages', id: conversation.id, before: page.items[0].id});
      if (active !== request.current) return;
      preserveScroll(false);
      const known = new Set(page.items.map(item => item.id));
      setPage({items: [...result.items.filter(item => !known.has(item.id)), ...page.items], more: result.more});
    } catch (err) { if (active === request.current) setError(describe(err)); }
    finally { if (active === request.current) setLoading(false); }
  }
  let lastDay = '';
  return <section className="chat">
    <header className="detail-header"><Avatar name={conversation.name} size="small"/><div><h2>{conversation.name}</h2>
      <span>{formatNumber.format(conversation.count)} 条本地消息</span></div>
      {conversation.scope !== 'unknown' && <span className="scope-badge">{conversation.scope === 'internal' ? '内部' : '外部'}</span>}
      {copilotSource && <button className="soft-button" type="button" onClick={() => {
        scroll.current = returnScroll.current;
        setCopilotSource(undefined);
      }}>返回实时会话</button>}
    </header>
    <div className="chat-viewport">
      <div className="chat-history" ref={view} onScroll={event => {
        setAtBottom(nearEnd());
        if (event.currentTarget.scrollTop < 35 && !scroll.current.bottom) void loadOlder();
      }}>
        {!original && page.more && <button className="history-more" disabled={loading} onClick={() => void loadOlder()}>{loading ? '正在读取…' : '查看更早的消息'}</button>}
        {!original && error && <div className="inline-status">{error}</div>}
        {!items.length && !error && <div className="empty-detail"><MessageCircle size={26}/><p>暂无本地消息</p></div>}
        {items.map(item => {
          const stamp = toDate(item.time);
          const day = stamp ? fullDate.format(stamp) : '';
          const separate = day && day !== lastDay;
          lastDay = day;
          return <div key={item.id} data-message-id={item.id} className={original?.id === item.id ? 'message-target' : undefined}>
            {separate && <div className="day-divider"><span>{day}</span></div>}
            <div className={`message ${item.own ? 'own' : ''}`}>
              <Avatar name={item.sender} size="small"/>
              <div className="message-inner">
                <div className="message-meta"><strong>{item.sender}</strong>{stamp && <time>{clock.format(stamp)}</time>}</div>
                <MessageBody item={item} profile={profile} conversation={conversation.id} anchor={original?.id === item.id ? original : undefined}/>
              </div>
            </div>
          </div>;
        })}
      </div>
      {!original && !atBottom && <button className="jump" aria-label="回到最新消息" onClick={() => view.current?.scrollTo(0, view.current.scrollHeight)}><ArrowDown size={17}/></button>}
    </div>
    {!openedSource && profile ? <ConversationCopilot profile={profile} conversation={conversation.id} openOriginal={source => {
      if (!copilotSource) {
        preserveScroll(nearEnd());
        returnScroll.current = scroll.current;
        scroll.current = {};
      }
      setCopilotSource(source);
    }}/> : <div className="chat-foot"><LockKeyhole size={14}/> 本地历史消息</div>}
  </section>;
}
