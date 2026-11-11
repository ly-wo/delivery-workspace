/** hostApi 2 browser bridge. Never supplies credentials or starts an AI task. */
declare global { interface Window { __deliveryToken: string; __deliveryTheme: Record<string, string> } }
const pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
function applyTheme(values: Record<string, string>) { for (const [name, value] of Object.entries(values)) if (/^--(?:ui-|el-|sans$|mono$)/.test(name)) document.documentElement.style.setProperty(name, value); }
applyTheme(window.__deliveryTheme || {});
window.addEventListener('message', event => {
  if (event.source !== window.parent || event.data?.token !== window.__deliveryToken) return;
  if (event.data.type === 'delivery:theme') { applyTheme(event.data.values); return; }
  if (event.data.type !== 'delivery:response') return;
  const item = pending.get(event.data.id); if (!item) return;
  pending.delete(event.data.id); clearTimeout(item.timer);
  event.data.error ? item.reject(new Error(event.data.error)) : item.resolve(event.data.result);
});
export function hostCall<T = any>(method: string, input: unknown): Promise<T> {
  if (pending.size >= 12) return Promise.reject(new Error('请等待当前操作完成'));
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID(), timer = setTimeout(() => { pending.delete(id); reject(new Error('插件请求超时，请核对实际结果后操作')); }, 120000);
    pending.set(id, { resolve, reject, timer });
    window.parent.postMessage({ type: 'delivery:request', token: window.__deliveryToken, id, method, input }, '*');
  });
}
export const host = {
  request: <T = any>(method: string, input?: unknown) => hostCall<T>('plugin.request', { method, input }),
  compose: (prompt: string, workspacePath?: string) => hostCall('conversation.compose', { prompt, workspacePath }),
  openWorkspace: (app: 'terminal' | 'cursor', workspacePath: string) => hostCall('workspace.open', { app, workspacePath }),
  copy: (text: string) => hostCall('clipboard.write', { text }),
};
