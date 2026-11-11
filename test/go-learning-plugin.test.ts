import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createPluginStore, applyPluginEnvironment, readPluginFile } from '../server/plugins/store.mjs';
import { createIntegrationRuntime } from '../server/plugins/integration-runtime.js';
import { createExtension } from '../plugins/go-learning/server.js';
import { integrationAvailable } from '../shared/integration-plugins.js';
import { registeredWorkspaceSections, workspaceLocation, workspaceSections, workspaceView } from '../src/pages/agent/workspace-navigation.js';
import { registeredNavigation } from '../src/app/navigation.js';

test('local Go plugin is configured without credentials; disable/remove/restart preserves state and gates its menus', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'go-plugin-state-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'plugins.json'), env: NodeJS.ProcessEnv = {};
  const store = await createPluginStore({ file, env, fetchImpl: async () => { throw new Error('unexpected network'); } });
  const current = () => store.list().then(items => items.find(item => item.id === 'go-learning')!);
  assert.equal(integrationAvailable(await current()), true);
  assert.equal((await current()).source, 'bundled');
  assert.equal((await current()).restartRequired, false);
  assert.equal(workspaceSections.some(section => section.id === 'learning'), false);
  assert.equal(registeredWorkspaceSections([]).some(section => section.id === 'learning'), false);
  assert.equal(registeredNavigation([]).flatMap(group => group.items).some(item => item.path === '/go-studio'), false);
  assert.equal(registeredWorkspaceSections(['go-learning']).flatMap(section => section.items).filter(view => view.id === 'go-studio').length, 1);
  assert.equal(workspaceView('go-studio')?.pluginId, 'go-learning');
  assert.deepEqual(workspaceLocation('/go-studio', { day: '4' }), { path: '/agent', query: { view: 'go-studio', day: '4' } });
  await assert.rejects(store.save('go-learning', { enabled: true, token: 'forbidden' }), /不支持/);
  assert.match((await store.test('go-learning', { enabled: true })).message, /未执行课程代码/);
  await store.state('go-learning', { enabled: false });
  assert.equal(integrationAvailable(await current()), false);
  await store.state('go-learning', { installed: false });
  const freshEnv: NodeJS.ProcessEnv = {};
  applyPluginEnvironment(await readPluginFile(file), freshEnv);
  const reloaded = await createPluginStore({ file, env: freshEnv });
  assert.equal(integrationAvailable((await reloaded.list()).find(item => item.id === 'go-learning')), false);
  const restored = await reloaded.state('go-learning', { installed: true, enabled: true });
  assert.equal(integrationAvailable(restored.plugins.find(item => item.id === 'go-learning')), true);
  assert.doesNotMatch(await fs.readFile(file, 'utf8'), /token|username|baseUrl/);
});

test('plugin lazily loads legacy work and progress; disabled requests and revoked in-flight bodies cannot mutate them', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'go-plugin-route-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const key = 'DELIVERY_PLUGIN_GO_LEARNING_ENABLED', installedKey = 'DELIVERY_PLUGIN_GO_LEARNING_INSTALLED';
  const old = process.env[key], oldInstalled = process.env[installedKey];
  t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; if (oldInstalled === undefined) delete process.env[installedKey]; else process.env[installedKey] = oldInstalled; });
  process.env[key] = 'false'; delete process.env[installedKey];
  let status = 0, result: any, input: unknown = {};
  let readBody: () => Promise<unknown> = async () => input;
  const runtime = createIntegrationRuntime({ directory: path.join(root, '.data'), rootDirectory: root, port: 5199,
    source: { jiraIssueRequest: async () => { throw new Error('unexpected Jira'); }, confluenceReadRequest: async () => { throw new Error('unexpected Confluence'); } },
    json: (_response, code, value) => { status = code; result = value; }, body: () => readBody(),
  }, [createExtension]);
  t.after(() => runtime.close());
  const headers = { host: 'localhost:5199', origin: 'http://localhost:5199', 'content-type': 'application/json', 'x-delivery-confirmed': 'yes' };
  const call = (method: string, action: string, extra = {}) => runtime.route({ method, headers: { ...headers, ...extra }, socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage, {} as ServerResponse, new URL(`http://localhost:5199/api/go-learning/${action}`));
  await call('GET', 'day?day=2'); assert.equal(status, 400);
  await assert.rejects(fs.access(path.join(root, 'work')), { code: 'ENOENT' });
  const state = path.join(root, '.data/go-learning');
  const lab = path.join(root, 'work/go-taskmgr-lab');
  await fs.mkdir(state, { recursive: true }); await fs.mkdir(lab, { recursive: true });
  await fs.writeFile(path.join(lab, 'go.mod'), 'module example.com/taskmgr\n\ngo 1.22\n');
  await fs.writeFile(path.join(lab, 'package.json'), '{}');
  const code = 'package main\nfunc main() {}\n';
  await fs.writeFile(path.join(lab, 'main.go'), code);
  await fs.writeFile(path.join(state, 'progress.json'), JSON.stringify({ currentDay: 4, activeSnapshot: 'day4', notes: { '4': '原学习笔记' }, checkedItems: ['d4-c1'], completedExercises: [], updatedAt: new Date().toISOString() }));
  process.env[key] = 'true';
  await call('GET', 'day?day=4'); assert.equal(status, 200);
  assert.equal(result.progress.notes['4'], '原学习笔记');
  assert.equal(await fs.readFile(path.join(lab, 'main.go'), 'utf8'), code);
  await call('POST', 'progress', { origin: 'https://foreign.test' }); assert.equal(status, 403);
  await call('POST', 'progress', { 'x-delivery-confirmed': '' }); assert.equal(status, 403);
  await call('POST', 'progress', { 'content-type': 'text/plain' }); assert.equal(status, 415);
  await call('DELETE', 'day'); assert.equal(status, 405);
  input = { note: { day: 4, content: '插件保存的笔记' } };
  await call('POST', 'progress'); assert.equal(status, 200);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  readBody = async () => { entered(); await blocked; return { note: { day: 4, content: '不应保存' } }; };
  const writing = call('POST', 'progress'); await started;
  process.env[key] = 'false'; release(); await writing;
  assert.equal(status, 400);
  const saved = JSON.parse(await fs.readFile(path.join(state, 'progress.json'), 'utf8'));
  assert.equal(saved.notes['4'], '插件保存的笔记');
  for (const action of ['overview', 'day', 'sandbox/run', 'sandbox/init', 'sandbox/save-file', 'sandbox/http-debug', 'progress']) {
    await call(action === 'overview' || action === 'day' ? 'GET' : 'POST', action);
    assert.equal(status, 400); assert.match(result.message, /停用/);
  }
  assert.equal(await fs.readFile(path.join(lab, 'main.go'), 'utf8'), code);
});
