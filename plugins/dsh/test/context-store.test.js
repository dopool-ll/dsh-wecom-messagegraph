import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {ContextStore} from '../server/context-store.js';

test('only confirmed memories survive as recallable facts and revoking a group removes its evidence', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wecom-context-test-'));
  const path = join(directory, 'context.sqlite');
  let store = new ContextStore(path);
  try {
    const workspace = '/workspace/authorized';
    const group = 'group-a';
    const scope = store.configure(workspace, 'profile-a', [group], 90);
    const source = {ref: 'source-1', conversation: group, group: '群聊', time: 200, kind: 'voice'};
    assert(store.publish(scope, [{source, body: '确认接口发布日期'}], {count: 1}));
    assert.equal(store.search(workspace, '接口', 'voice', 10)[0].source.ref, source.ref);
    assert.equal(store.search(workspace, '发布日期', '', 10).length, 1);
    assert.deepEqual(store.search('/workspace/another', '接口', '', 10), []);
    const pending = store.propose(workspace, '接口发布日期已经确认', source);
    assert.equal(pending.state, 'pending');
    assert.equal(store.propose(workspace, pending.note, source).id, pending.id);
    assert.deepEqual(store.memories(workspace, '接口'), []);
    assert.equal(store.memories(workspace, '', true).length, 1);
    assert.equal(store.confirm(workspace, pending.id), true);
    assert.equal(store.confirm(workspace, pending.id), false);
    store.close();
    store = new ContextStore(path);
    assert.equal(store.memories(workspace, '接口')[0].source.ref, source.ref);
    const changed = store.configure(workspace, 'profile-a', ['group-b'], 90);
    assert.notEqual(changed.generation, scope.generation);
    assert.equal(store.publish(scope, [{source, body: '过期的索引任务'}], {}), false);
    assert.equal(store.source(workspace, source.ref), undefined);
    assert.deepEqual(store.memories(workspace, '接口'), []);
  } finally {
    store.close();
    rmSync(directory, {recursive: true, force: true});
  }
});
