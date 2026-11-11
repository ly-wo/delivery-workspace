import path from 'node:path';
import { createGoLearningService } from './service.js';
import { createGoLearningRoutes } from './routes.js';
import { assertPluginEnabled } from '../../server/plugins/definitions.mjs';
import type { IntegrationExtension, IntegrationHost } from '../../server/plugins/integration-runtime.js';

export function createExtension(host: IntegrationHost): IntegrationExtension {
  let pending: ReturnType<typeof createGoLearningService> | undefined;
  let closing = false;
  const requests = new Set<Promise<boolean>>();
  function service() {
    if (!host.rootDirectory) throw new Error('Go 实训插件需要工作台根目录');
    // Keep the original paths; loading the plugin does not copy or reset user data.
    return pending ||= createGoLearningService(path.join(host.directory, 'go-learning'), {
      rootDir: host.rootDirectory,
    }).catch(error => { pending = undefined; throw error; });
  }
  return {
    id: 'go-learning',
    matches: url => url.pathname.startsWith('/api/go-learning/'),
    route(request, response, url) {
      if (closing) throw new Error('Go 实训插件正在关闭');
      const operation = (async () => {
        const go = await service();
        assertPluginEnabled('go-learning');
        const route = createGoLearningRoutes(go, { ...host, assertActive: () => assertPluginEnabled('go-learning') });
        return route(request, response, url);
      })();
      requests.add(operation);
      void operation.then(() => requests.delete(operation), () => requests.delete(operation));
      return operation;
    },
    async close() {
      closing = true;
      await Promise.allSettled([...requests]);
      if (pending) await (await pending).close();
    },
  };
}
