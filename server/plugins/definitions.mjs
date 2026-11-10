/** Built-in integration manifests. Only registered plugins can receive credentials. */
export const pluginDefinitions = [
  { id: 'jira', name: 'Jira', description: '任务、日历、需求开发和状态回写', capabilities: ['issues.read', 'issues.write'], prefix: 'JIRA', probe: '/rest/api/2/myself' },
  { id: 'confluence', name: 'Confluence', description: '知识检索、页面读取和方案发布', capabilities: ['pages.read', 'pages.write'], prefix: 'CONFLUENCE', probe: '/rest/api/user/current' },
  { id: 'wecom', name: '企微通知 Webhook', description: '群消息、联调反馈和自动报告通知', capabilities: ['notifications.send'], prefix: 'WECOM' },
];
export function definition(id) {
  const plugin = pluginDefinitions.find(item => item.id === id);
  if (!plugin) throw new Error('未注册的接入插件');
  return plugin;
}
export function assertPluginEnabled(id, env = process.env) {
  const plugin = definition(id);
  if (env[`DELIVERY_PLUGIN_${plugin.prefix}_ENABLED`] === 'false') throw Object.assign(new Error(`${plugin.name} 插件已停用，请在设置中启用并重启工作台`), { code: 'PLUGIN_DISABLED', definite: true });
}
