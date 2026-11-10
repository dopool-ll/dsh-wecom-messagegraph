import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {ContextStore, digest} from '../server/context-store.js';
import {explore} from '../server/messagegraph.js';
import {assembleContext, focusQuery} from '../server/messagegraph-context.js';
import {buildIndex, indexCoverage} from '../server/messagegraph-indexer.js';

test('indexes group and direct conversations, keeps verified cross-chat evidence scoped and resolvable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'messagegraph-test-'));
  const path = join(directory, 'index.sqlite');
  const store = new ContextStore(path);
  try {
    const workspace = '/test/authorized';
    const scope = store.configure(workspace, 'enterprise', ['a', 'b'], 90, true);
    const url = 'https://docs.example.net/releases/checklist?edition=2';
    const repeated = '请按照这一版排期安排下周的联调和验收工作';
    const text = value => ({kind: 'text', text: value});
    const record = (id, time, part) => ({
      fingerprint: digest(id), senderId: 'sender', message: {...part, id, sender: '测试', time},
    });
    const group = {conversation: {id: 'a', name: '发布群 (验收)', kind: 'group'}, messages: [
      record('1', 200, {kind: 'link', text: '群内验收资料', detail: {url}}),
      record('3', 300, {kind: 'file', text: '群内排期.csv'}),
      record('5', 400, text('工单 FB-20261109-022 已收到')),
      record('7', 500, text(repeated)),
      record('9', 600, {kind: 'file', text: '同名排期.txt'}),
      record('13', 620, {kind: 'file', text: '同名同大小.txt'}),
      record('11', 700, {kind: 'link', text: '旧版验收资料', detail: {url: url.replace('=2', '=1')}}),
    ]};
    const direct = {conversation: {id: 'b', name: '项目同事', kind: 'direct'}, messages: [
      record('2', 100, text(`我会同步到「发布群 (验收)」：新版清单 ${url}`)),
      record('4', 310, {kind: 'file', text: '私聊排期.csv'}),
      record('6', 410, text('刚看到 FB-20261109-022 这个编号')),
      record('8', 510, text(repeated)),
      record('10', 610, {kind: 'file', text: '同名排期.txt'}),
      record('14', 630, {kind: 'file', text: '同名同大小.txt'}),
    ]};
    for (const [id, bytes] of [['3', 'identical content'], ['4', 'identical content'], ['9', 'first'], ['10', 'second'], ['13', 'same fallback'], ['14', 'same fallback']])
      writeFileSync(join(directory, id), bytes);
    const index = async (scope, groups) => {
      const coverage = indexCoverage();
      const {entries, extracts} = await buildIndex(scope, {
        signal: new AbortController().signal, coverage,
        scan: ids => ({state: {}, groups: groups.filter(({conversation}) => ids.includes(conversation.id))}),
        mediaFile: ({id}) => {
          const path = join(directory, id);
          const stat = statSync(path, {bigint: true});
          return {path, device: String(stat.dev), inode: String(stat.ino), size: Number(stat.size),
            modified: String(stat.mtimeNs), changed: String(stat.ctimeNs),
            match: ['13', '14'].includes(id) ? undefined : 'recorded_path'};
        },
        readExtract: (ref, version) => store.mediaExtract(workspace, ref, version),
      });
      assert(store.publish(scope, entries.values(), coverage, extracts));
    };
    await index(scope, [group, direct]);
    const results = (query, kind) => explore(store, workspace, {query, kind});
    const getLink = () => results('新版清单');
    const [link] = getLink().relations;
    assert.equal(getLink().relations.length, 1);
    assert.equal(link.kind, 'named_handoff');
    assert.equal(link.basis, 'shared_link');
    assert.equal(link.certainty, 'supported');
    assert.deepEqual([link.from.source.conversationType, link.to.source.conversationType], ['direct', 'group']);
    assert.equal(store.source(workspace, link.from.source.ref).id, '2');
    assert.equal(store.source(workspace, link.to.source.ref).id, '1');
    const filtered = explore(store, workspace, {query: url,
      filters: {conversation: digest(scope.profile, 'a'), sender: '测试', from: 200, to: 201}});
    assert.deepEqual(filtered.hits.map(hit => hit.source.ref), [link.to.source.ref]);
    assert.deepEqual(filtered.relations, []);
    assert.deepEqual(explore(store, workspace, {filters: {conversation: '发布群 (验收)', from: 200, to: 201}})
      .hits.map(hit => hit.source.ref), [link.to.source.ref]);
    assert.equal(explore(store, workspace, {filters: {sender: '其他发送人'}}).status, 'no_match');
    assert.throws(() => explore(store, workspace, {query: url, filters: {from: 201, to: 200}}), /invalid_request/);
    assert.deepEqual(results(url).relations, [link]);
    assert.deepEqual(results('新版清单', 'link').relations, [link]);
    assert.equal(results('群内排期').relations[0].kind, 'shared_attachment');
    assert.equal(results(repeated).relations[0].certainty, 'possible');
    assert.deepEqual(results('同名排期').relations, []);
    assert.deepEqual(results('同名同大小').relations, []);
    assert.deepEqual(results('FB-20261109-022').relations, []);
    assert.equal(results('FB-20261109-022').hits.length >= 2, true);
    assert.equal(explore(store, '/test/other', {query: url}).status, 'scope_required');

    const grant = store.grantExternal(workspace, 'test client');
    const reader = new ContextStore(path, {readOnly: true});
    try {
      assert.deepEqual(reader.externalQuery(grant.token, workspace => explore(reader, workspace, {query: '新版清单'})), getLink());
      const prior = store.scope(workspace);
      const narrowed = store.configure(workspace, 'enterprise', ['a'], 90);
      assert.throws(() => reader.externalQuery(grant.token, () => null), /messagegraph_access_required/);
      assert.equal(store.publish(prior, [], {}), false);
      await index(narrowed, [group]);
      assert.deepEqual(results(url).relations, []);
      assert.equal(store.source(workspace, link.from.source.ref), undefined);
      assert.equal(store.ownerWorkspace(link.from.source.ref), undefined);
      assert.equal(store.source(workspace, link.to.source.ref).id, '1');
    } finally { reader.close(); }
  } finally {
    store.close();
    rmSync(directory, {recursive: true, force: true});
  }
});

test('indexes every authorized conversation in batches beyond the old scope limit', async () => {
  const groups = Array.from({length: 123}, (_, index) => 'conversation-' + index);
  const coverage = indexCoverage();
  const scanned = [];
  const {entries} = await buildIndex({workspace: '/test/all', profile: 'enterprise', groups, days: 90}, {
    signal: new AbortController().signal, coverage,
    scan(ids) {
      assert(ids.length <= 8);
      scanned.push(...ids);
      return {state: {}, groups: ids.map(id => ({
        conversation: {id, name: id, kind: 'group'},
        messages: [{fingerprint: id, message: {id: '1', kind: 'text', text: id, time: 100}}],
      }))};
    },
  });
  assert.deepEqual(scanned, groups);
  assert.equal(coverage.conversations.length, groups.length);
  assert.equal(entries.size, groups.length);
});

test('commits just the changed conversation and its media cache alongside the checkpoint', () => {
  const directory = mkdtempSync(join(tmpdir(), 'messagegraph-increment-test-'));
  const store = new ContextStore(join(directory, 'index.sqlite'));
  const entry = (conversation, ref) => ({source: {conversation, ref, time: 100, kind: 'text'}, body: ref});
  try {
    const scope = store.configure('/test/delta', 'enterprise', ['a', 'b'], 90);
    const snapshot = {version: 'initial', expires: null, windows: new Map([
      ['a', {signature: '1', extracts: ['old-a']}], ['b', {signature: '2', extracts: ['keep-b']}],
    ])};
    const extract = {version: 'cached', segments: ['caption']};
    assert(store.publish(scope, [entry('a', 'old-a'), entry('b', 'keep-b')], {},
      new Map([['old-a', extract], ['keep-b', extract]]), undefined, snapshot));
    const before = store.scope(scope.workspace);
    assert.equal(store.checkpoint(before).windows.get('b').signature, '2');
    const delta = {...snapshot, version: 'next', changed: new Set(['a']), staleExtracts: ['old-a']};
    assert(store.publish(before, [entry('a', 'new-a')], {}, new Map(), undefined, delta));
    assert.equal(store.source(scope.workspace, 'old-a'), undefined);
    assert.equal(store.source(scope.workspace, 'keep-b').conversation, 'b');
    assert.equal(store.source(scope.workspace, 'new-a').conversation, 'a');
    assert.equal(store.mediaExtract(scope.workspace, 'old-a', 'cached'), undefined);
    assert.deepEqual(store.mediaExtract(scope.workspace, 'keep-b', 'cached'), ['caption']);
    assert.equal(store.checkpoint(store.scope(scope.workspace)).version, 'next');
  } finally {
    store.close();
    rmSync(directory, {recursive: true, force: true});
  }
});

test('a superseded index writer cannot publish over a newer writer', () => {
  const directory = mkdtempSync(join(tmpdir(), 'messagegraph-lease-test-'));
  const path = join(directory, 'index.sqlite');
  const first = new ContextStore(path);
  const second = new ContextStore(path);
  try {
    const scope = first.configure('/test/lease', 'enterprise', ['a'], 90);
    const now = Date.now();
    assert(first.claimIndex(scope, 'writer-one', now));
    assert.equal(second.claimIndex(scope, 'writer-two', now), false);
    assert(first.renewIndex('writer-one', now + 15_000));
    assert.equal(second.claimIndex(scope, 'writer-two', now + 60_000), false);
    assert(second.claimIndex(scope, 'writer-two', now + 76_000));
    assert.equal(first.publish(scope, [], {}, new Map(), 'writer-one'), false);
    first.releaseIndex('writer-one');
    assert(second.publish(scope, [], {}, new Map(), 'writer-two'));
    second.releaseIndex('writer-two');
    assert.equal(first.indexRunning(scope.workspace), false);
  } finally {
    second.close();
    first.close();
    rmSync(directory, {recursive: true, force: true});
  }
});


test('a single context result includes linked decisions and prefers the later correction', async () => {
  const item = (id, text, reason, time) => {
    const source = {ref: digest(id), conversation: 'project', id, group: '项目群', time};
    return {source, view: {source, reason, text, kind: 'text'}};
  };
  const original = item('1', '周五验收计划下午两点', 'anchor', 10);
  const initial = item('2', '确认：周五下午两点', 'reply', 30);
  const changed = item('3', '最终确认：改到下周一上午十点', 'reply', 100);
  const topic = focusQuery('周五验收最后定了吗？');
  assert.equal(topic, '周五验收');
  const {context} = await assembleContext([{...original.view, reasons: [{type: 'keyword'}]}], topic, {
    gather: async () => ({items: [original, initial, changed], more: false}),
    page: async () => ({items: [item('4', '最终确认：另一件事改到下周三', 'topic', 101)], more: false}),
    filters: {}, allows: () => true,
  });
  assert.deepEqual(context.messages.map(x => x.source.ref), [original, initial, changed].map(x => x.source.ref));
  assert.deepEqual(context.messages.map(x => x.decision), [undefined, 'confirmed', 'changed']);
  assert.equal(context.needsMore, false);
  assert.deepEqual(context.continuations, []);
});

test('a pending result gives a concrete follow-up and keeps same-topic guesses separate', async () => {
  const item = (id, text, reason, time) => {
    const source = {ref: digest(id), conversation: 'project', id, group: '项目群', time};
    return {source, view: {source, reason, text, kind: 'text'}};
  };
  const original = item('1', '周三交付还没定下来', 'anchor', 10);
  const nearby = item('2', '周三交付最终确认了吗？', 'topic', 12);
  const other = item('3', '确认：周五发布', 'topic', 15);
  const filters = {to: 20, sender: '测试'};
  const {context, locators} = await assembleContext([{...original.view, reasons: [{type: 'keyword'}]}], '周三交付', {
    gather: async () => ({items: [original], more: false}),
    page: async (_source, direction) => ({items: direction === 'after' ? [nearby, other] : [], more: true}),
    filters, allows: () => true,
  });
  assert.equal(context.needsMore, true);
  assert.deepEqual(context.messages.map(x => [x.reason, x.decision]), [['anchor', 'pending'], ['topic', undefined]]);
  assert.deepEqual(context.continuations[0].args, {ref: original.source.ref, direction: 'after', filters});
  assert(locators.some(source => source.ref === nearby.source.ref));
  assert(!locators.some(source => source.ref === other.source.ref));
});


test('ambiguous assent preserves both nearby proposals without treating either as confirmed', async () => {
  const item = (id, text, time, person, conversation = 'same') => {
    const source = {ref: digest(id), conversation, id, group: '发布群', time, person};
    return {source, view: {source, reason: 'topic', text, kind: 'text'}};
  };
  const anchor = item('6', '确认：就按这个来。', 1000, 'owner');
  anchor.view.reason = 'anchor';
  const a = item('1', '方案 A 用蓝绿切换，先保留旧版本。', 970, 'owner');
  const b = item('2', '方案 B 按租户灰度，先验证客户侧链路。', 975, 'teammate');
  const mention = item('3', '收到，方案 B。', 980, 'owner');
  const chatter = item('4', '大家今天午饭吃什么？', 990, 'owner');
  const foreign = item('5', '方案 C 直接全量上线。', 999, 'owner', 'other');
  const old = item('7', '方案 D 等到年底再升级。', 80, 'owner');
  const question = '群里说「就按这个来」，指的是哪个方案？';
  assert.equal(focusQuery(question), '就按这个来');
  const {context, locators} = await assembleContext([{...anchor.view, reasons: [{type: 'keyword'}]}], '就按这个来', {
    gather: async () => ({items: [anchor], more: false}),
    page: async (_source, direction) => ({items: direction === 'before' ? [a, b, mention, chatter, foreign, old] : [], more: false}),
    query: question, filters: {}, allows: () => true,
  });
  assert.equal(context.needsMore, true);
  assert.deepEqual(context.messages.map(item => item.source.ref), [a.source.ref, b.source.ref, anchor.source.ref]);
  assert.deepEqual(context.messages.map(item => item.reason), ['topic', 'topic', 'anchor']);
  assert(context.messages.every(item => item.decision === undefined));
  assert(context.messages.slice(0, 2).every(item => item.certainty === 'possible'));
  assert.deepEqual(context.messages.slice(0, 2).map(item => item.clues.topics[0]), ['方案 A', '方案 B']);
  assert.deepEqual(context.messages.slice(0, 2).map(item => item.clues.participant), ['same_sender', 'shared_participant']);
  assert(context.messages.every(item => locators.some(locator => locator.ref === item.source.ref)));
});
