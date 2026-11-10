<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
interface Plugin {
  id: string; name: string; description: string; enabled: boolean; baseUrl: string; username: string;
  groupName: string; configured: boolean; restartRequired: boolean; source: string; token?: string; webhook?: string;
}
const plugins = ref<Plugin[]>([]), busy = ref(false), error = ref('');
async function load() {
  busy.value = true;
  try {
    const response = await fetch('/api/plugins');
    if (!response.ok) throw new Error('读取接入插件失败');
    plugins.value = (await response.json()).plugins;
    error.value = '';
  } catch (e) { error.value = e instanceof Error ? e.message : '读取接入插件失败'; }
  finally { busy.value = false; }
}
async function act(plugin: Plugin, action: 'configure' | 'test') {
  busy.value = true;
  try {
    const config = plugin.id === 'wecom'
      ? { enabled: plugin.enabled, groupName: plugin.groupName, webhook: plugin.webhook || '' }
      : { enabled: plugin.enabled, baseUrl: plugin.baseUrl, username: plugin.username, token: plugin.token || '' };
    const response = await fetch(`/api/plugins/${plugin.id}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || '插件操作失败');
    if (result.plugins) {
      const saved = result.plugins.find((item: Plugin) => item.id === plugin.id);
      Object.assign(plugin, saved, { token: '', webhook: '' });
    }
    ElMessage.success(result.message);
  } catch (e) { ElMessage.error(e instanceof Error ? e.message : '插件操作失败'); }
  finally { busy.value = false; }
}
onMounted(load);
</script>
<template>
  <section class="surface integration-plugins">
    <div class="surface-header"><div><h2>接入插件</h2><p>配置仅保存在本机。保存后，等待任务结束并重启工作台使配置生效。</p></div></div>
    <div v-if="error" role="alert">{{ error }} <el-button @click="load">重试</el-button></div>
    <div class="plugin-grid">
      <el-form v-for="plugin in plugins" :key="plugin.id" label-position="top" :disabled="busy" class="plugin-card">
        <h3>{{ plugin.name }}</h3><p>{{ plugin.description }}</p>
        <p>{{ plugin.configured ? '已配置凭据（尚需验证权限）' : '待配置凭据' }} · {{ plugin.source === 'legacy' ? '沿用本机原配置' : '插件管理' }}</p>
        <el-alert v-if="plugin.restartRequired" title="配置待重启生效" type="warning" :closable="false" />
        <el-form-item label="启用插件"><el-switch v-model="plugin.enabled" :aria-label="`启用 ${plugin.name}`" /></el-form-item>
        <template v-if="plugin.id !== 'wecom'">
          <el-form-item label="服务地址"><el-input v-model="plugin.baseUrl" placeholder="https://your-site.example.com" /></el-form-item>
          <el-form-item label="用户名 / 邮箱（Bearer Token 留空）"><el-input v-model="plugin.username" autocomplete="off" /></el-form-item>
          <el-form-item label="Token（同一站点、账号留空保留插件已存密钥）"><el-input v-model="plugin.token" type="password" show-password autocomplete="new-password" /></el-form-item>
          <p v-if="plugin.source === 'legacy'">首次改为插件管理时需重新填写 Token；未保存前继续沿用原连接。</p>
        </template>
        <template v-else>
          <el-form-item label="群名称"><el-input v-model="plugin.groupName" /></el-form-item>
          <el-form-item label="机器人 Webhook（留空保留插件已存地址）"><el-input v-model="plugin.webhook" type="password" show-password autocomplete="new-password" /></el-form-item>
        </template>
        <div class="plugin-actions">
          <el-button @click="act(plugin, 'test')">{{ plugin.id === 'wecom' ? '检查地址格式' : '只读测试连接' }}</el-button>
          <el-button type="primary" @click="act(plugin, 'configure')">保存插件</el-button>
        </div>
      </el-form>
    </div>
    <p class="plugin-note">企微地址检查不会发送消息；实际发送仍需在消息页预览并确认。停用企微插件同时停止工作台内专用报告机器人的发送。外部 Agent 自己的 MCP 连接不由此处管理。</p>
  </section>
</template>
<style scoped>
.integration-plugins { margin-bottom: 22px; }
.plugin-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); gap: 24px; padding: 20px; }
.plugin-card { min-width: 0; }
.plugin-card p, .plugin-note { color: var(--ui-muted); line-height: 1.6; font-size: 13px; }
.plugin-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.plugin-actions :deep(.el-button) { margin: 0; }
.plugin-note { padding: 0 20px 20px; }
</style>
