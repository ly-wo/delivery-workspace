import confluence from '../plugins/confluence/frontend.js';
import { integrationCatalog } from '../shared/integration-plugins.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { effectScope, nextTick, shallowRef } from 'vue';
import { useAgentMentions } from '../src/features/agent-workbench/useAgentMentions.js';

test('明确文档查询使用当前工作区范围，选择后写入可由后端解析的 Confluence 引用', async () => {
  const original = globalThis.fetch;
  const requests: string[] = [];
  const reference = 'confluence:https%3A%2F%2Fdocs.example.test/42';
  globalThis.fetch = async input => {
    requests.push(String(input));
    return Response.json({ pages: [{ reference, title: '接口 L001', spaceKey: 'SOP', version: 3 }] });
  };
  const scope = effectScope();
  const draft = shallowRef('');
  const mentions = scope.run(() => useAgentMentions(draft, () => ({ workspacePath: '/selected-project', provider: 'codex', modes: [] }), () => false, () => {}, shallowRef([{...integrationCatalog.find(item => item.id === 'confluence')!.mention!, search: confluence.mentions}])) )!;
  try {
    draft.value = '@文档:接口';
    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 220));
    assert.equal(requests.length, 1);
    const params = new URL(requests[0], 'http://localhost').searchParams;
    assert.equal(params.get('workspacePath'), '/selected-project');
    assert.equal(params.get('q'), '接口');
    assert.equal(mentions.options.value[0].label, '接口 L001');
    mentions.select(mentions.options.value[0]);
    assert.equal(draft.value, `@${reference} `);
  } finally { scope.stop(); globalThis.fetch = original; }
});

test('输入法确认键不选中 @ 候选，合成结束后的 Enter 仍正常选择', async () => {
  const scope = effectScope();
  const draft = shallowRef('');
  const selected: string[] = [];
  const mentions = scope.run(() => useAgentMentions(draft, () => ({ workspacePath: '', provider: 'codex',
    modes: ['agent', 'ask'], selectedMode: 'agent' }), () => false, mode => selected.push(mode), shallowRef([])))!;
  try {
    draft.value = '@';
    await nextTick();
    for (const input of [{ isComposing: true, keyCode: 13 }, { isComposing: false, keyCode: 229 }]) {
      let prevented = false;
      const event = { key: 'Enter', ...input, preventDefault() { prevented = true; } } as KeyboardEvent;
      assert.equal(mentions.handleKeydown(event), false);
      assert.equal(prevented, false);
      assert.equal(draft.value, '@');
      assert.deepEqual(selected, []);
    }
    assert.equal(mentions.handleKeydown({ key: 'Enter', isComposing: false, keyCode: 13, preventDefault() {} } as KeyboardEvent), true);
    assert.deepEqual(selected, ['agent']);
    assert.equal(draft.value, '');
  } finally { scope.stop(); }
});


test('$ 只列出 Skills，切换为同查询 @ 后不显示 Skills，向上循环选择末项', async () => {
 const original=globalThis.fetch;globalThis.fetch=async()=>Response.json({skills:[{invocation:'demo',name:'demo',description:'Demo'}],files:['demo.ts'],notes:[]});
 const scope=effectScope(),draft=shallowRef('');
 const mentions=scope.run(()=>useAgentMentions(draft,()=>({workspacePath:'/workspace',provider:'codex',modes:['agent','ask']}),()=>false,()=>{},shallowRef([])))!;
 try {
  draft.value='$';await nextTick();await new Promise(r=>setTimeout(r,220));
  assert.deepEqual(mentions.options.value.map(o=>o.kind),['skill']);mentions.select(mentions.options.value[0]);assert.equal(draft.value,'$demo ');
  draft.value='@';await nextTick();await new Promise(r=>setTimeout(r,220));
  assert.ok(mentions.options.value.every(o=>o.kind!=='skill'));
  mentions.handleKeydown({key:'ArrowUp',preventDefault(){}} as KeyboardEvent);assert.equal(mentions.activeOption.value.id,'file:demo.ts');
  mentions.handleKeydown({key:'ArrowDown',preventDefault(){}} as KeyboardEvent);assert.equal(mentions.activeOption.value.id,'mode:agent');
  draft.value='$';await nextTick();await new Promise(r=>setTimeout(r,220));assert.deepEqual(mentions.options.value.map(o=>o.kind),['skill']);
 } finally {scope.stop();globalThis.fetch=original;}
});
