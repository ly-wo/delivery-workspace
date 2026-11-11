<script setup lang="ts">
import { inject, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessageBox } from 'element-plus';
import { agentWorkspaceContext } from '../../shared/agent-workspace-context';
import { pluginRequest, useCustomPlugins } from './api';
const props = defineProps<{ pluginId: string }>();
const customPlugins = useCustomPlugins();
const workspace = inject(agentWorkspaceContext, undefined);
const frame = ref<HTMLIFrameElement>(), document = ref(''), error = ref('');
let token = '', inFlight = 0, generation = 0;
function theme() {
  const styles = getComputedStyle(window.document.documentElement), values: Record<string, string> = {};
  for (let i = 0; i < styles.length; i++) { const name = styles.item(i); if (/^--(?:ui-|el-|sans$|mono$)/.test(name)) values[name] = styles.getPropertyValue(name); }
  return values;
}
async function reload() {
  const current = ++generation;
  document.value = ''; error.value = ''; token = crypto.randomUUID();
  try {
    const data = await pluginRequest(`${props.pluginId}/application`);
    if (current !== generation) return;
    const nonce = crypto.randomUUID().replaceAll('-', '');
    // Opaque-origin iframe: no parent DOM, storage or direct network access. Calls go through a source-bound bridge.
    const boot = `window.__deliveryToken=${JSON.stringify(token)};window.__deliveryTheme=${JSON.stringify(theme())};`;
    document.value = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'"><style>${data.css.replace(/<\/style/gi, '<\\/style')}</style></head><body><div id="app"></div><script nonce="${nonce}">${(boot + data.javascript).replace(/<\/script/gi, '<\\/script')}</` + 'script></body></html>';
  } catch (e) { if (current === generation) error.value = e instanceof Error ? e.message : '插件页面加载失败'; }
}
async function receive(event: MessageEvent) {
  const data = event.data;
  if (event.source !== frame.value?.contentWindow || !data || data.token !== token || data.type !== 'delivery:request' || typeof data.id !== 'string') return;
  const source = event.source, requestToken = token, pluginId = props.pluginId;
  const reply = (value: unknown) => source?.postMessage({ type: 'delivery:response', token: requestToken, id: data.id, ...value as object }, { targetOrigin: '*' });
  if (inFlight >= 12) { reply({ error: '插件请求过于频繁，请稍后再试' }); return; }
  inFlight++;
  try {
    let result: unknown;
    if (data.method === 'plugin.request') result = await pluginRequest(`${pluginId}/application-call`, data.input);
    else if (data.method === 'conversation.compose') {
      if (!workspace) throw new Error('当前页面没有会话入口');
      const draft = await pluginRequest(`${pluginId}/compose`, data.input);
      await ElMessageBox.confirm(draft.prompt.slice(0, 500) + (draft.prompt.length > 500 ? '…' : ''), '将插件内容带入会话草稿？', { confirmButtonText: '填入草稿', cancelButtonText: '取消' });
      // Recheck after the user confirmation: a plugin may have been disabled meanwhile.
      const checked = await pluginRequest(`${pluginId}/compose`, data.input);
      workspace.compose(checked.prompt, checked.workspacePath); result = { ok: true };
    } else if (data.method === 'workspace.open') {
      await ElMessageBox.confirm('打开此插件工作目录的终端或编辑器？', '打开本机应用', { confirmButtonText: '打开', cancelButtonText: '取消' });
      result = await pluginRequest(`${pluginId}/open-workspace`, data.input);
    } else if (data.method === 'clipboard.write') {
      if (typeof data.input?.text !== 'string' || data.input.text.length > 200000) throw new Error('复制内容无效');
      await ElMessageBox.confirm('将插件选中的文本复制到剪贴板？', '复制文本');
      await navigator.clipboard.writeText(data.input.text); result = { ok: true };
    } else throw new Error('宿主不支持该能力');
    reply({ result });
  } catch (e) { reply({ error: e instanceof Error ? e.message : '操作已取消' }); }
  finally { inFlight--; }
}
const observer = new MutationObserver(() => frame.value?.contentWindow?.postMessage({ type: 'delivery:theme', token, values: theme() }, '*'));
onMounted(() => { window.addEventListener('message', receive); observer.observe(window.document.documentElement, { attributes: true }); void reload(); });
onBeforeUnmount(() => { generation++; window.removeEventListener('message', receive); observer.disconnect(); });
watch(() => props.pluginId, reload);
watch(() => customPlugins.query.data.value, value => {
  if (!value) return;
  const active = value.plugins.find(p => p.manifest.id === props.pluginId);
  if (!active?.enabled || !active.grants.includes('application.local')) {
    generation++; document.value = ''; token = crypto.randomUUID(); error.value = '插件已停用、移除或未授权本机运行，请在插件管理中恢复。';
  }
});
defineExpose({ reload });
</script>
<template><el-alert v-if="error" :title="error" type="error" :closable="false" /><iframe v-else-if="document" ref="frame" :srcdoc="document" sandbox="allow-scripts" title="自定义应用插件" class="plugin-application" /><el-skeleton v-else :rows="8" animated /></template>
<style scoped>.plugin-application{border:0;width:100%;min-height:850px;height:calc(100vh - 220px);display:block;color-scheme:normal}</style>
