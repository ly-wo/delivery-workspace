export async function pluginRequest<T = any>(action = '', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/custom-plugins${action ? '/' + action : ''}`, body === undefined ? { signal } : {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || '插件请求失败');
  return data as T;
}
