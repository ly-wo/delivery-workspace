# Go 实训工坊插件

在 `codex/integration-plugins` 分支引入 main 的 Go 实训实现（790dac0），作为随工作台源码发布的受信任本机插件接入。七天课程、检查清单、练习、笔记、代码编辑、快照、运行、单元测试、竞态检测、格式化、HTTP 调试和助教入口继续使用原实现。真实执行、模拟输出与保存失败的展示逻辑保持不变。

## 使用

构建并重启新版工作台后，在「设置 → 接入插件」找到「Go 实训工坊」。本机插件无需地址、用户名或 Token；默认启用以兼容原入口。菜单、页面和 API 全部由插件注册。停用/移除即时阻止后端新调用，前端在插件状态刷新时隐藏菜单；管理页操作会立即刷新当前窗口状态。旧页面显示恢复指引，不把停用解释成离线模拟模式。

旧链接 `/go-studio` 和 `/agent?view=go-studio`（包括 day 等查询参数）继续可用。菜单标识 `learning` 不变，原有排序和图标偏好继续适用。移除只改变接入状态，不删除源码和学习数据；恢复后继续学习。

Go 工具链是否安装由实训页面检测。插件“已启用”表示本机功能可访问，不表示编译、测试或竞态检查已经通过。运行课程代码仍由用户点击原运行按钮触发。

## 文件与接入契约

- `integration.json`：本机插件声明，`kind: local`，页面/菜单/能力/API 前缀。
- `frontend.ts`：异步注册 `studio` 组件。
- `GoLearningStudio.vue`、`fallback-data.ts`：完整实训界面和已有离线降级数据。
- `server.ts`：延迟创建服务、注册兼容接口、检查启用状态、等待在途请求关闭。
- `service.ts`、`routes.ts`、`curriculum.ts`、`types.ts`：插件自有业务、路由、课程与契约。

宿主只在接入定义表、共享清单和服务工厂表登记插件；不再在主入口创建 Go 服务，也不在固定面板/导航表登记 Go 页面。插件使用通用 `IntegrationHost.rootDirectory` 获取工作台根目录。前端插件入口及 Vue 文件纳入类型检查。

该插件不是 `plugin.json` 声明式记录插件：它包含受信任服务端代码和本机 Go 执行能力，需随源码构建、重启，不通过任意目录执行第三方代码。

## 数据兼容与生命周期

保持原路径，无复制、清空或格式迁移：

- `${DELIVERY_DATA_DIR:-.data}/go-learning/progress.json`：章节、清单、练习和笔记。
- 同目录 `toolchain/`：隔离的 Go 工具链缓存。
- `<工作台根目录>/work/go-taskmgr-lab/`：原练习工程、编辑文件及 tasks.json。
- `<工作台根目录>/work/go-learning-docs/`：原本机详细课程文档；缺少时保留 main 原有内置课程降级。
- 浏览器原有进度 key 不变。

服务只在首个合法、已启用的请求到来时初始化；停用状态不会创建/重置练习工程。启停/移除仅持久化插件状态，不改变学习记录。请求体读取后再次检查状态，避免停用前挂起的请求在停用后开始保存或执行。已经进入业务操作的请求可以完成；关闭工作台时等待在途请求和进度写入结束，不停止用户自行启动的其他进程。

旧阅读型 `go-seven-days` 自定义插件的独立记录不属于此实训工程，本迁移不覆盖它们。

## 验证

```sh
node --import tsx --test test/go-learning-plugin.test.ts test/go-learning.test.ts test/integration-plugins.test.ts test/integration-extension-runtime.test.ts test/agent-workspace-navigation.test.ts
pnpm build
```

覆盖本机无凭据状态、启停/移除/恢复、旧链接、原进度与代码保留、未初始化时的停用、同源和确认限制、请求体等待期间撤回、课程快照/Go 真实执行/HTTP 调试及既有接入插件回归。测试数据使用临时目录，不写用户的学习记录。
