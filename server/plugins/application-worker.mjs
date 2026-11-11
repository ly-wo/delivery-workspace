// Trusted local code runs in its own process, not in the workspace server.
import { pathToFileURL } from 'node:url';
const [entry, dataDirectory, workspaceDirectory] = process.argv.slice(2);
let application;
process.on('message', async message => {
  if (!message || message.type !== 'request') return;
  try {
    application ||= Promise.resolve(import(pathToFileURL(entry).href)).then(module => module.createPlugin({ dataDirectory, workspaceDirectory }));
    const result = await (await application).request(message.method, message.input);
    process.send?.({ id: message.id, result });
  } catch (error) { process.send?.({ id: message.id, error: error instanceof Error ? error.message : '插件执行失败' }); }
});
let closing = false;
async function close() {
  if (closing) return; closing = true;
  const timer = setTimeout(() => process.exit(1), 2500);
  try { await (await application)?.close?.(); } finally { clearTimeout(timer); process.exit(0); }
}
process.on('SIGTERM', close);
process.on('disconnect', close);
