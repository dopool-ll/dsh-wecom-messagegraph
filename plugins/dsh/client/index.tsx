import {useEffect, useMemo, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {WeComApp} from './App';
import {relationLabels, sourceName, type Relation, type SourceLink} from './AgentMemory';
import {ContextResults, EvidenceItems, evidenceReasons, type ContinuationPage, type EvidenceContext, type EvidenceItem} from './ContextResults';
import type {CopilotAnswer, CopilotProgress, WeComTransport} from './transport';
import {pluginTitle} from './presentation';
import styles from './styles.css?raw';
import type {DatabaseExport} from '../../../packages/wecom-core/src/types';

const panelId = 'wecom-local';
const panelStyles = styles.replace(':root', ':host') + `
  :host { display: block; position: relative; isolation: isolate; }
  .export-dialog {
    width: min(420px, calc(100vw - 40px)); padding: 22px; border: 1px solid #dce5f2;
    border-radius: 13px; color: #182c46; background: white; box-shadow: 0 12px 50px #182c4633;
  }
  .export-dialog::backdrop { background: #182c4666; }
  .export-dialog h2 { font-size: 17px; margin-bottom: 10px; }
  .export-dialog label { display: grid; gap: 6px; font-size: 13px; }
  .export-dialog input {
    width: 100%; border: 1px solid #c8d7ea; padding: 9px; border-radius: 7px; color: inherit;
  }
  .export-dialog footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
`;

type Runtime = typeof globalThis & {
  __DSH_TRANSPORT__?: {fetch?: typeof fetch};
  __DSH_REMOTE_ACCESS__?: {owner?: boolean};
};
const runtime = globalThis as Runtime;

const ndjson = 'application/x-ndjson';

function sendRequest(operation: object, signal?: AbortSignal, accept?: string) {
  const send = runtime.__DSH_TRANSPORT__?.fetch ?? globalThis.fetch;
  return send('api/wecom-local', {
    method: 'POST',
    headers: {'content-type': 'application/json', ...(accept ? {accept} : {})},
    body: JSON.stringify(operation),
    signal,
  });
}

async function call<T>(operation: {op: string}, signal?: AbortSignal): Promise<T> {
  return readResponse<T>(await sendRequest(operation, signal));
}

async function readResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (typeof body.error === 'string') throw body.error;
  if (!response.ok || !Object.hasOwn(body, 'data')) throw 'backend_unavailable';
  return body.data as T;
}

async function readCopilot(response: Response, progress: (event: CopilotProgress) => void): Promise<CopilotAnswer> {
  if (!response.headers.get('content-type')?.startsWith(ndjson)) return readResponse<CopilotAnswer>(response);
  const reader = response.body?.getReader();
  if (!reader) throw 'backend_protocol_error';
  const decoder = new TextDecoder();
  let pending = '';
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) throw 'agent_copilot_connection_lost';
      const lines = (pending + decoder.decode(value, {stream: true})).split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const event = JSON.parse(line);
        if (event.type === 'done') return event.data;
        if (event.type === 'error') throw event.error;
        if (event.type === 'generating' || event.type === 'delta') progress(event);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function DestinationDialog({suggested, close}: {suggested: string; close(value: string | null): void}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [directory, setDirectory] = useState(suggested);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="export-dialog" aria-labelledby="wecom-export-title"
    onCancel={event => { event.preventDefault(); close(null); }}>
    <form onSubmit={event => { event.preventDefault(); close(directory.trim()); }}>
      <h2 id="wecom-export-title">导出明文数据库</h2>
      <label>本机保存目录
        <input autoFocus value={directory} onChange={event => setDirectory(event.target.value)} required/>
      </label>
      <footer>
        <button className="soft-button" type="button" onClick={() => close(null)}>取消</button>
        <button className="soft-button" type="submit" disabled={!directory.trim().startsWith('/')}>导出</button>
      </footer>
    </form>
  </dialog>;
}

const sourceEvent = 'dsh-wecom-open-source';
let selectedReference: {ref: string} | undefined;

function Panel() {
  const [root, setRoot] = useState<ShadowRoot>();
  const [reference, setReference] = useState(() => {
    const value = selectedReference;
    selectedReference = undefined;
    return value;
  });
  useEffect(() => {
    const update = () => {
      if (selectedReference) setReference(selectedReference);
      selectedReference = undefined;
    };
    window.addEventListener(sourceEvent, update);
    return () => window.removeEventListener(sourceEvent, update);
  }, []);
  const [suggested, setSuggested] = useState<string>();
  const resolveDirectory = useRef<(value: string | null) => void>(null);
  const transport = useMemo<WeComTransport>(() => ({
    request: call,
    async askCopilot(request, progress, signal) {
      return readCopilot(await sendRequest({op: 'agentCopilot', ...request}, signal, ndjson), progress);
    },
    async readMedia(profile, conversation, id, signal, part, refreshCache, sourceRef) {
      const response = await sendRequest(sourceRef ? {op: 'agentMedia', ref: sourceRef, part}
        : {op: 'media', profile, conversation, id, part, refreshCache}, signal);
      if (!response.ok || response.headers.get('content-type')?.includes('application/json')) throw 'media_unavailable';
      return response.blob();
    },
    async exportDatabases(profile) {
      const pick = await call<{kind: 'native' | 'manual'; directory: string | null}>({op: 'chooseExport'});
      let directory = pick.directory;
      if (pick.kind === 'manual' && directory) {
        const initial = directory;
        directory = await new Promise<string | null>(resolve => {
          resolveDirectory.current = resolve;
          setSuggested(initial);
        });
      }
      if (!directory) return null;
      const request = {op: 'exportDatabases', profile, directory};
      return call<DatabaseExport>(request);
    },
  }), []);
  useEffect(() => () => resolveDirectory.current?.(null), []);
  const mount = useMemo(() => (element: HTMLDivElement | null) => {
    if (element) setRoot(element.shadowRoot ?? element.attachShadow({mode: 'open'}));
  }, []);

  return <div ref={mount} style={{height: '100%', width: '100%', minHeight: 0, overflow: 'hidden'}}>
    {root && createPortal(<>
      <style>{panelStyles}</style>
      <WeComApp transport={transport} reference={reference}/>
      {suggested && <DestinationDialog suggested={suggested} close={directory => {
        resolveDirectory.current?.(directory);
        resolveDirectory.current = null;
        setSuggested(undefined);
      }}/>}
    </>, root)}
  </div>;
}

function PanelIcon({size = 16}: {size?: number}) {
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"
    fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 4h13v10H8l-5 4V4zm8 13h5l5 3V9h-2"/>
  </svg>;
}

interface ClientContext {
  connection: {isLoopback: boolean};
  layout: {selectPanel(id: string): void};
  slots: {
    inject(name: string, activate: () => unknown): void;
    register(options: {name: string; key?: string; id?: string; label?: () => string; order?: number}, component: Function): unknown;
  };
}

export const inject = ['connection', 'slots', 'layout'];

const toolNames = {
  messagegraph_explore: 'MessageGraph 证据检索',
  messagegraph_read_image: '查看企微原图',
  wecom_get_context: '检索企微上下文',
  wecom_read_timeline: '读取企微时间线',
  wecom_get_evidence: '查看企微证据',
  wecom_propose_memory: '提出企微记忆',
};
type ToolCard = {
  toolName: keyof typeof toolNames;
  phase: string;
  block: {content?: {type: string; text?: string}[]};
};

function evidence(block: ToolCard['block']) {
  const result = block.content?.find(part => part.type === 'text' && part.text)?.text;
  if (result) {
    try {
      const payload = JSON.parse(result);
      const valid = (source?: SourceLink): source is SourceLink => Boolean(source &&
        /^[0-9a-f]{32}$/.test(source.ref) && typeof source.group === 'string');
      const relations = (Array.isArray(payload.relations) ? payload.relations as Relation[] : [])
        .filter(relation => relation && Object.hasOwn(relationLabels, relation.kind) &&
          valid(relation.from?.source) && valid(relation.to?.source));
      const related = new Set(relations.flatMap(({from, to}) => [from.source.ref, to.source.ref]));
      const context = payload.context && Array.isArray(payload.context.messages) && Array.isArray(payload.context.continuations)
        ? payload.context as EvidenceContext : undefined;
      for (const item of context?.messages ?? []) if (valid(item.source)) related.add(item.source.ref);
      const hits = Array.isArray(payload.hits) ? payload.hits : [];
      const items = ([...(Array.isArray(payload.messages) ? payload.messages : []), ...hits] as EvidenceItem[])
        .filter(item => item && valid(item.source) && Object.hasOwn(evidenceReasons, item.reason));
      for (const {source} of items) related.add(source.ref);
      const entries = [payload, ...(payload.memories ?? []), ...hits] as {source?: SourceLink}[];
      const links = new Map<string, SourceLink>();
      for (const {source} of entries) {
        if (valid(source) && !related.has(source.ref)) links.set(source.ref, source);
      }
      return {links: [...links.values()], relations, items, context};
    } catch { /* Non-MessageGraph result. */ }
  }
  return {links: [], relations: [], items: [], context: undefined};
}

export function apply(ctx: ClientContext) {
  if (!ctx.connection.isLoopback || runtime.__DSH_REMOTE_ACCESS__?.owner === false) return;
  ctx.slots.inject('main', () => ctx.slots.register({name: 'main', key: panelId}, Panel));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: panelId, label: () => pluginTitle, order: 20,
  }, PanelIcon));
  function EvidenceCard({toolName, phase, block}: ToolCard) {
    const {links, relations, items, context} = evidence(phase === 'result' ? block : {});
    function open(ref: string) {
      selectedReference = {ref};
      ctx.layout.selectPanel(panelId);
      window.dispatchEvent(new Event(sourceEvent));
    }
    function original(source: SourceLink) {
      return <button key={source.ref} type="button" onClick={() => open(source.ref)}>查看原消息 · {sourceName(source)}</button>;
    }
    return <details>
      <summary>{toolNames[toolName]}{relations.length ? ` · ${relations.length} 条跨会话关联` : context?.messages.length ? ` · ${context.messages.length} 条关键证据` : links.length || items.length ? ` · ${links.length + items.length} 条来源` : ''}</summary>
      {context && <ContextResults context={context} open={open}
        load={step => {
          const request = {op: 'agentContinue', ...step.args, tool: step.tool};
          return call<ContinuationPage>(request);
        }}/>}
      {relations.map(({kind, basis, label, from, to}) => <div key={JSON.stringify([kind, basis, from.source.ref, to.source.ref])}>
        <p>关联依据 · {relationLabels[kind]}{label ? ` · ${label}` : ''}</p>
        {original(from.source)} {original(to.source)}
      </div>)}
      <EvidenceItems items={items} open={open}/>
      {links.map(source => <div key={source.ref}>{original(source)}</div>)}
      {phase === 'result' && !links.length && !relations.length && !items.length && !context && block.content?.filter(part => part.type === 'text').map((part, index) =>
        <p key={index}>{part.text}</p>)}
    </details>;
  }
  ctx.slots.inject('tool.call.toolview', () => {
    for (const key of Object.keys(toolNames))
      ctx.slots.register({name: 'tool.call.toolview', key}, EvidenceCard);
  });
}
