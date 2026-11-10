import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {ContextStore} from '../server/context-store.js';
import {conversationCopilot} from '../server/conversation-copilot.js';

test('Copilot sends only indexed messages from the authorized conversation and resolves its citations', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wecom-copilot-test-'));
  const store = new ContextStore(join(directory, 'context.sqlite'));
  const workspace = ':global';
  const profile = '1'.repeat(24);
  const scope = store.configure(workspace, profile, ['group', 'direct'], 7);
  const now = Math.floor(Date.now() / 1000);
  const source = {ref: '1'.repeat(32), profile, conversation: 'group', group: '测试群', time: now, kind: 'text', sender: '测试者'};
  const request = {profile, conversation: 'group', mode: 'question', question: '验收定了吗？'};
  const {signal} = new AbortController();
  const calls = [];
  const firstText = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const services = {
    agentDefaultModel: {currentSelection: () => ({provider: 'test-provider', model: 'test-model'})},
    llm: {async *stream(options) {
      calls.push(options);
      yield {type: 'text-delta', text: '验收已确认在周五 [1] [99]。'};
      await finish.promise;
      yield {type: 'finish', reason: {kind: 'stop'}};
    }},
  };
  const ctx = {get: name => services[name]};
  try {
    await assert.rejects(conversationCopilot(store, workspace, request, signal, ctx), /agent_copilot_index_required/);
    const entries = [
      {source, body: '确认周五验收'},
      {source: {...source, ref: '2'.repeat(32), conversation: 'direct', group: '私聊'}, body: '私聊验收时间不同'},
      {source: {...source, ref: '3'.repeat(32), time: now - 8 * 86400}, body: '过期验收时间'},
    ];
    assert(store.publish(scope, entries, {}));
    for (const unauthorized of [{profile: '2'.repeat(24)}, {conversation: 'outside'}])
      await assert.rejects(conversationCopilot(store, workspace, {...request, ...unauthorized}, signal, ctx),
        /agent_copilot_scope_required/);
    assert.equal(calls.length, 0);
    const reply = conversationCopilot(store, workspace,
      {...request, question: '这事定了吗？', previousQuestions: ['验收时间是什么？']}, signal, ctx,
      event => { if (event.type === 'delta') firstText.resolve(event.text); });
    assert.match(await Promise.race([firstText.promise, reply.then(() => '')]), /验收已确认/);
    finish.resolve();
    const result = await reply;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, 'test-model');
    const sent = JSON.parse(calls[0].messages[0].content[0].text);
    assert.deepEqual(sent.previousQuestions, ['验收时间是什么？']);
    assert.deepEqual(sent.evidence.map(item => item.text), ['确认周五验收']);
    assert.deepEqual(result.citations.map(({number, source}) => [number, source.ref]), [[1, source.ref]]);
    assert.deepEqual(store.memories(workspace, '', true), []);

    services.llm.stream = async function* () {
      store.configure(workspace, profile, ['direct'], 7);
      yield {type: 'text-delta', text: '过期回答 [1]'};
      yield {type: 'finish', reason: {kind: 'stop'}};
    };
    await assert.rejects(conversationCopilot(store, workspace, request, signal, ctx), /agent_scope_changed/);
  } finally {
    store.close();
    rmSync(directory, {recursive: true, force: true});
  }
});
