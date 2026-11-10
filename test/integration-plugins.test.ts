import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPluginStore, readPluginFile, applyPluginEnvironment } from '../server/plugins/store.mjs';
import { assertPluginEnabled } from '../server/plugins/definitions.mjs';

test('plugin credentials stay private, survive reload, and never cross site/account boundaries', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugins-'));
  try {
    const file = path.join(dir, 'credentials/plugins.json');
    const store = await createPluginStore({ file, env: {} });
    await store.save('jira', { enabled: true, baseUrl: 'https://jira.example.com/context/', username: 'alice', token: 'private-token' });
    assert.ok(!JSON.stringify(await store.list()).includes('private-token'));
    assert.equal((await store.list())[0].restartRequired, true);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    await store.save('jira', { enabled: true, baseUrl: 'https://jira.example.com/context', username: 'alice', token: '' });
    assert.equal((await readPluginFile(file)).plugins.jira.token, 'private-token');
    await store.save('jira', { enabled: true, baseUrl: 'https://jira.example.com/context', username: 'bob', token: '' });
    assert.equal((await readPluginFile(file)).plugins.jira.token, '');
    await store.save('jira', { enabled: false, baseUrl: 'https://other.example.com', username: '', token: '' });
    const env = { JIRA_COOKIE: 'old-cookie', JIRA_AUTH_HEADER: 'old-header' } as Record<string, string>;
    applyPluginEnvironment(await readPluginFile(file), env);
    assert.equal(env.JIRA_COOKIE, undefined);
    assert.equal(env.JIRA_AUTH_HEADER, undefined);
    assert.throws(() => assertPluginEnabled('jira', env), /已停用/);
    const reloaded = await createPluginStore({ file, env });
    assert.equal((await reloaded.list())[0].restartRequired, false);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('read-only probes, webhook validation, unknown fields and malformed storage fail closed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugins-'));
  try {
    const file = path.join(dir, 'plugins.json'); let calls = 0;
    const store = await createPluginStore({ file, env: {}, fetchImpl: async (url: string, options: RequestInit) => {
      calls++; assert.equal(url, 'https://wiki.example.com/wiki/rest/api/user/current');
      assert.equal(options.redirect, 'error'); assert.equal(options.method, undefined);
      return new Response(JSON.stringify({ username: 'tester' }));
    } });
    await store.test('confluence', { enabled: true, baseUrl: 'https://wiki.example.com/wiki', username: 'tester', token: 'secret' });
    await store.test('wecom', { enabled: true, groupName: 'Test', webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret' });
    assert.equal(calls, 1);
    await assert.rejects(store.save('wecom', { enabled: true, webhook: 'https://evil.example/send?key=secret' }));
    await assert.rejects(store.save('jira', { enabled: true, baseUrl: 'https://jira.example.com', token: 'secret\nINJECT=true' }));
    await assert.rejects(store.save('unknown', { enabled: true }));
    await assert.rejects(store.save('jira', { enabled: true, arbitrary: true }));
    await fs.writeFile(file, 'invalid');
    await assert.rejects(store.save('jira', { enabled: true }));
    assert.equal(await fs.readFile(file, 'utf8'), 'invalid');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('disabled plugins block actual Jira and notification calls before network access', async () => {
  const { loadJiraConfiguration } = await import('../server/jira-dev/jira-client.mjs');
  await assert.rejects(loadJiraConfiguration({ DELIVERY_PLUGIN_JIRA_ENABLED: 'false', JIRA_BASE_URL: 'https://jira.example.com', JIRA_AUTH_HEADER: 'Bearer secret' }), /已停用/);
  const { createWecomIntegration } = await import('../server/wecom-integration.js');
  const { integrationCatalogFixture } = await import('./fixtures/integration-catalog.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugins-disabled-'));
  const previous = process.env.DELIVERY_PLUGIN_WECOM_ENABLED;
  try {
    let calls = 0;
    const service = await createWecomIntegration(dir, { configFile: path.join(dir, 'bot.json'), catalog: integrationCatalogFixture,
      fetch: async () => { calls++; return new Response('{"errcode":0}'); } });
    await service.configure({ groupName: 'Test', webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret' });
    const preview = service.messagePreview({ title: 'Test', msgtype: 'text', content: 'Test' });
    process.env.DELIVERY_PLUGIN_WECOM_ENABLED = 'false';
    await assert.rejects(service.sendMessage({ input: preview.input, previewId: preview.previewId, hash: preview.hash }), /已停用/);
    assert.equal(calls, 0);
  } finally {
    if (previous === undefined) delete process.env.DELIVERY_PLUGIN_WECOM_ENABLED; else process.env.DELIVERY_PLUGIN_WECOM_ENABLED = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('disabled backend Jira and Confluence adapters reject before fetch', async t => {
  const backend = await import(new URL('../server/jira-backend/server.mjs', import.meta.url).href);
  const originalJira = process.env.DELIVERY_PLUGIN_JIRA_ENABLED;
  const originalConfluence = process.env.DELIVERY_PLUGIN_CONFLUENCE_ENABLED;
  t.after(() => {
    if (originalJira === undefined) delete process.env.DELIVERY_PLUGIN_JIRA_ENABLED; else process.env.DELIVERY_PLUGIN_JIRA_ENABLED = originalJira;
    if (originalConfluence === undefined) delete process.env.DELIVERY_PLUGIN_CONFLUENCE_ENABLED; else process.env.DELIVERY_PLUGIN_CONFLUENCE_ENABLED = originalConfluence;
  });
  process.env.DELIVERY_PLUGIN_JIRA_ENABLED = 'false';
  process.env.DELIVERY_PLUGIN_CONFLUENCE_ENABLED = 'false';
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('Unexpected network request'); });
  await assert.rejects(backend.confluenceReadRequest('content/123?expand=space'), /插件已停用/);
  let responseBody = '';
  await backend.handleJiraTaskCalendarRequest({ method: 'GET', url: '/api/issues?allTime=true', headers: { host: 'localhost:5199' } }, {
    setHeader() {}, writeHead() {}, end(value: string) { responseBody = value; },
  });
  assert.match(responseBody, /插件已停用/);
  assert.equal(calls, 0);
});
