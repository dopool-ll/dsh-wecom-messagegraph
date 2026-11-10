import {spawn} from 'node:child_process';
import {homedir} from 'node:os';
import {isAbsolute, join} from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {mediaResponse} from './media.js';
import {WeComContext} from './context.js';

const coreBinary = fileURLToPath(new URL('../dist/wecom-core', import.meta.url));
const maxRequestBytes = 8192;
const maxScopeBytes = 4 * 1024 * 1024;
const contactFilters = ['all', 'internal', 'external'];
const conversationFilters = [...contactFilters, 'group', 'direct'];

class Backend {
  #worker;
  #id = 0;
  #closed = false;

  request(request) {
    if (this.#closed) throw Error('backend_unavailable');
    if (process.platform !== 'darwin') throw Error('unsupported_platform');
    const worker = this.#worker ?? this.#start();
    if (worker.pending.size >= 32) throw Error('backend_unavailable');
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#stop(worker), 60_000);
      timer.unref();
      worker.pending.set(id, {resolve, reject, timer});
      worker.child.stdin.write(JSON.stringify({id, request}) + '\n');
    });
  }

  #start() {
    const child = spawn(coreBinary, [], {stdio: ['pipe', 'pipe', 'ignore']});
    const lines = createInterface({input: child.stdout, crlfDelay: Infinity});
    const worker = {child, lines, pending: new Map()};
    this.#worker = worker;
    const stop = () => this.#stop(worker);
    child.once('error', stop);
    child.once('exit', stop);
    child.stdin.on('error', stop);
    lines.on('error', stop);
    lines.on('line', line => {
      if (this.#worker !== worker) return;
      let response;
      try { response = JSON.parse(line); }
      catch { this.#stop(worker, 'backend_protocol_error'); return; }
      const pending = worker.pending.get(response?.id);
      if (!pending || (!Object.hasOwn(response, 'data') && typeof response.error !== 'string')) {
        this.#stop(worker, 'backend_protocol_error');
        return;
      }
      worker.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (typeof response.error === 'string') pending.reject(Error(response.error));
      else pending.resolve(response.data);
    });
    return worker;
  }

  #stop(worker, code = 'backend_unavailable') {
    if (this.#worker !== worker || !worker) return;
    this.#worker = undefined;
    worker.lines.close();
    worker.child.stdin.end();
    const kill = setTimeout(() => worker.child.kill(), 1500);
    kill.unref();
    worker.child.once('close', () => clearTimeout(kill));
    for (const {reject, timer} of worker.pending.values()) {
      clearTimeout(timer);
      reject(Error(code));
    }
    worker.pending.clear();
  }

  close() {
    this.#closed = true;
    this.#stop(this.#worker);
  }
}

function shortString(value, limit) {
  return typeof value === 'string' && value.length <= limit && !value.includes('\0');
}

function validatedRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid_request');
  const {op, id, profile, conversation, paused, search, offset, before, filter, directory, part, read, refreshCache} = value;
  switch (op) {
    case 'discover':
    case 'status':
    case 'chooseExport':
      return {op};
    case 'select':
      if (typeof id === 'string' && /^[0-9a-f]{24}$/.test(id)) return {op, id};
      break;
    case 'pause':
      if (typeof paused === 'boolean') return {op, paused};
      break;
    case 'contacts':
    case 'conversations': {
      const filters = op === 'contacts' ? contactFilters : conversationFilters;
      if (shortString(search, 200) && Number.isInteger(offset) && offset >= 0 && offset <= 1_000_000 &&
          (filter === undefined || filters.includes(filter)) &&
          (read === undefined || (op === 'conversations' && ['all', 'read', 'unread'].includes(read))))
        return {op, search, offset, filter, read};
      break;
    }
    case 'contactConversations':
      if (shortString(id, 1024)) return {op, id};
      break;
    case 'contextConversations':
      if (typeof profile === 'string' && /^[0-9a-f]{24}$/.test(profile)) return {op, profile};
      break;
    case 'conversationAvatars':
      if (typeof profile === 'string' && /^[0-9a-f]{24}$/.test(profile) && shortString(id, 1024)) return {op, profile, id};
      break;
    case 'messages':
      if (shortString(id, 1024) && (before === undefined || shortString(before, 128))) return {op, id, before};
      break;
    case 'media':
      if (typeof profile === 'string' && /^[0-9a-f]{24}$/.test(profile) &&
          shortString(conversation, 1024) && typeof id === 'string' && /^-?\d{1,20}$/.test(id) &&
          (part === undefined || (Number.isInteger(part) && part >= 0 && part < 64)) &&
          (refreshCache === undefined || typeof refreshCache === 'boolean'))
        return {op, profile, conversation, id, part, refreshCache};
      break;
    case 'exportDatabases':
      if (typeof profile === 'string' && /^[0-9a-f]{24}$/.test(profile) &&
          shortString(directory, 4096) && isAbsolute(directory)) return {op, profile, directory};
      break;
  }
  throw Error('invalid_request');
}

function isLoopback(host) {
  return host === 'localhost' || host === '::1' || host === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(host ?? '');
}

const reply = (body, status = 200) => Response.json(body, {status, headers: {'cache-control': 'no-store'}});
const errorCode = error => error instanceof Error && /^[a-z_]{3,60}$/.test(error.message)
  ? error.message : 'backend_unavailable';

function copilotStream(run, requestSignal) {
  const cancellation = new AbortController();
  const signal = AbortSignal.any([requestSignal, cancellation.signal]);
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      const emit = event => {
        if (!signal.aborted) controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
      };
      try {
        const data = await run(signal, emit);
        emit({type: 'done', data});
      } catch (error) {
        emit({type: 'error', error: errorCode(error)});
      } finally {
        if (!cancellation.signal.aborted) controller.close();
      }
    },
    cancel() { cancellation.abort(); },
  });
  return new Response(body, {headers: {
    'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store, no-transform',
  }});
}

export const inject = ['connection', 'tools'];

export function apply(ctx) {
  const backend = new Backend();
  const context = new WeComContext(new Backend());
  const local = () => {
    const server = ctx.get('webServer');
    return !ctx.connection.allowsRemoteAuthorities && (!server || isLoopback(server.host));
  };
  let pausedProfile;
  context.register(ctx, local);
  context.startAuto(local, () => pausedProfile);
  ctx.effect(() => () => { context.close(); backend.close(); });
  // Connection handles origin checks and admits only an authenticated owner for exact routes.
  ctx.connection.fetch.register({
    path: '/api/wecom-local',
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      if (!local())
        return reply({error: 'local_only'}, 403);
      try {
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? ''))
          return reply({error: 'invalid_request'}, 415);
        const body = await request.text();
        const size = Buffer.byteLength(body);
        if (size > maxScopeBytes) return reply({error: 'invalid_request'}, 413);
        let operation;
        try { operation = JSON.parse(body); }
        catch { return reply({error: 'invalid_request'}, 400); }
        if (size > maxRequestBytes && operation?.op !== 'agentScope')
          return reply({error: 'invalid_request'}, 413);
        if (operation?.op === 'agentCopilot' && request.headers.get('accept') === 'application/x-ndjson')
          return copilotStream((signal, emit) => context.owner(operation.op, operation, signal, ctx, emit), request.signal);
        if (typeof operation?.op === 'string' && operation.op.startsWith('agent')) {
          const data = await context.owner(operation.op, operation, request.signal, ctx);
          return operation.op === 'agentMedia' ? await mediaResponse(data) : reply({data});
        }
        try { operation = validatedRequest(operation); }
        catch { return reply({error: 'invalid_request'}, 400); }
        if (operation.op === 'chooseExport') {
          const picker = ctx.get('directoryPicker')?.capability();
          const data = picker?.kind === 'native'
            ? {kind: 'native', directory: await picker.pick(request.signal)}
            : {kind: 'manual', directory: join(homedir(), 'Downloads')};
          return reply({data});
        }
        if (request.signal.aborted) return reply({error: 'backend_unavailable'}, 400);
        const data = await backend.request(operation);
        if (operation.op === 'pause' || operation.op === 'select')
          pausedProfile = data.phase === 'paused' ? data.profile : undefined;
        return operation.op === 'media' ? await mediaResponse(data) : reply({data});
      } catch (error) {
        return reply({error: errorCode(error)}, 400);
      }
    },
  });
}
