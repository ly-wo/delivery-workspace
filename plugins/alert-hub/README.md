# Alert Hub 自定义插件

连接 https://thor-alert-hub.hahavending.com/，按 hostApi 2 安装；不修改宿主业务路由、注册表或 Alert Hub 服务。来源为 GitLab `raytheon-middleware/alert-hub` 的 `test` 分支 `299a3f2a020bf81e8f8e017dab6decbf2347398d`，其已构建资源 `index-CLi9w-YW.js` 与本次线上页面引用一致。仓库默认 prod 分支目前只有 README，不能用它推断线上功能。

## 使用

```sh
node plugins/alert-hub/build.mjs
node plugins/alert-hub/install.mjs http://localhost:5199 --trust-local-code
```

或在自定义插件管理中检查本目录下 `package` 的绝对路径、核对本机代码信任后添加。可独立分发 package 四个文件。页面为 `/agent?view=plugins&plugin=alert-hub`。在插件内输入自己的 Alert Hub 账号密码；不要把密码发到会话中。安装不需要修改宿主源码。插件升级涉及摘要变更时仍按宿主迁移规则处理，安装器不会覆盖已有不同版本或重置授权。

## 插件自身职责

- 独立保留上游告警工作台、Case/事件、Todo、人员团队、Owner、规则、通知策略、诊断和导入页面；上游前端位于 upstream，业务都在插件包中。
- 固定 HTTPS 远端及明确方法/路径清单；拒绝任意 URL、重定向、Webhook 和具有写入效果的通知动作 GET。
- API 参数和错误文案原样转交。业务写入先预览目标、方法、路径及正文，确认票据两分钟有效、绑定完整请求、一次使用，不自动重试。超时结果须先到远端核对。
- 会话 Cookie 只存在插件进程内，不返回前端、不写文件；密码仅转交登录/修改密码接口，不存储。不复用浏览器 Cookie、宿主凭据或 X-User-ID 来伪造身份。停用、移除或重启后重新登录。
- CSV 原内容通过宿主文件导出；当前页面可经确认带入会话草稿，不自动发送 AI。
- 查询取消会忽略已取消请求结果；已派发的远端读请求可能继续到 20 秒超时。响应最大 4 MB，过大时缩小查询范围。

## 公开宿主能力与扩展

使用既有应用安装/授权、菜单、独立页面、专属进程、应用调用、主题变量、conversation.compose。未添加宿主 Alert Hub ID 分支或专属服务。

本次独立扩展只有通用 `host.download(name,text)` / `file.download`：宿主确认文件名后导出文本，限制文件名和大小，确认后重新检查插件启用及本机应用授权。不接受路径或覆盖磁盘指定文件，下载位置由浏览器管理。基于本会话“涉及工作台能力时补充公开能力”的授权实现，不包含告警含义。

`storage.read` 是 hostApi 2 声明中的私有记录契约；此插件不复制远端业务数据到宿主数据库。本机信任权限不是操作系统安全沙箱。

## 验证与限制

```sh
node --import tsx --test test/alert-hub-plugin.test.ts
pnpm build
```

测试覆盖固定目标、会话私有性、写前预览、篡改/重放拒绝、鉴权失败、CSV 响应、安装启停移除恢复和数据保留。已实际检查 5199 菜单、登录表单以及远端匿名鉴权响应（401）。未提供账号，因此真实登录、授权后的查询、实际 CSV 下载和远端写操作尚未验收；测试没有修改线上告警或发送通知。
