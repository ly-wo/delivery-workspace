import { z } from 'zod';
export const pluginIdSchema = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/);
export const capabilitySchema = z.enum(['storage.read', 'storage.write', 'workspace.todos.read', 'workspace.todos.write', 'jira.read', 'jira.create', 'conversation.context', 'application.local', 'conversation.compose', 'workspace.open']);
export const pluginFieldSchema = z.object({
  key: z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/).refine(key => !['id', 'createdAt', 'updatedAt', '__proto__', 'constructor', 'prototype'].includes(key)),
  label: z.string().min(1).max(80), type: z.enum(['text', 'textarea', 'date', 'select']), required: z.boolean().default(false),
  options: z.array(z.object({ value: z.string().max(80), label: z.string().min(1).max(80) }).strict()).max(20).optional(),
  maxLength: z.number().int().min(1).max(8000).default(2000), default: z.string().max(8000).default(''),
}).strict().refine(field => field.type !== 'select' || !!field.options?.length, '选择字段必须声明选项');
export const pluginConfigurationFieldSchema = z.object({
  key: z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/).refine(key => !['constructor', 'prototype', '__proto__'].includes(key)),
  label: z.string().min(1).max(80), type: z.enum(['text', 'password']),
  description: z.string().max(500).optional(), required: z.boolean().default(false),
  default: z.string().max(4000).optional(), resetOnChange: z.array(z.string()).max(20).optional(),
}).strict().refine(field => field.type !== 'password' || field.default === undefined, '密码不得声明默认值');
export const pluginManifestSchema = z.object({
  apiVersion: z.literal(1), id: pluginIdSchema, name: z.string().min(1).max(80), version: z.string().regex(/^\d+\.\d+\.\d+$/),
  hostApi: z.union([z.literal(1), z.literal(2)]), description: z.string().max(1000),
  permissions: z.array(capabilitySchema).max(10),
  page: z.object({ title: z.string().min(1).max(80), kind: z.enum(['records', 'application']) }).strict(),
  application: z.object({ frontend: z.literal('ui.js'), styles: z.literal('ui.css'), backend: z.literal('server.mjs') }).strict().optional(),
  configuration: z.object({ fields: z.array(pluginConfigurationFieldSchema).min(1).max(20) }).strict().optional(),
  records: z.object({ storage: z.enum(['private', 'workspace.todos']), resourceType: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
    fields: z.array(pluginFieldSchema).min(1).max(15), }).strict(),
  commands: z.array(z.object({ id: z.string().regex(/^[a-z][a-z0-9-]*$/), label: z.string().min(1).max(80),
    action: z.enum(['jira.link', 'jira.create', 'conversation.context']) }).strict()).max(10).default([]),
}).strict().superRefine((m, ctx) => {
  const error = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (m.configuration && new Set(m.configuration.fields.map(f => f.key)).size !== m.configuration.fields.length) error('配置字段不能重复');
  for (const field of m.configuration?.fields || []) if (field.resetOnChange?.some(key => field.type !== 'password' || !m.configuration?.fields.some(f => f.key === key && f.type !== 'password'))) error('密码绑定字段必须是已声明的普通配置字段');
  if (m.page.kind === 'application') {
    if (m.hostApi !== 2 || !m.application || !m.permissions.includes('application.local') || m.records.storage !== 'private') error('应用插件需要 hostApi 2、应用入口、本机执行声明和私有存储');
  } else if (m.hostApi !== 1 || m.application || m.permissions.includes('application.local')) error('记录插件使用 hostApi 1 且不支持可执行入口');
  if (new Set(m.permissions).size !== m.permissions.length || new Set(m.records.fields.map(f => f.key)).size !== m.records.fields.length || new Set(m.commands.map(c => c.id)).size !== m.commands.length) error('标识或权限不能重复');
  if (new Set(m.records.fields.map(f => f.label)).size !== m.records.fields.length) error('字段名称不能重复，以免引用内容丢失');
  if (!m.records.fields.some(f => f.key === 'title' && f.required && f.type === 'text')) error('必须包含必填文本 title 字段');
  const prefix = m.records.storage === 'private' ? 'storage' : 'workspace.todos';
  if (!m.permissions.includes(`${prefix}.read`)) error('缺少数据读取权限');
  for (const command of m.commands) if (!m.permissions.includes(command.action === 'jira.link' ? 'jira.read' : command.action)) error('操作缺少声明的宿主权限');
  for (const f of m.records.fields) if (f.type === 'select' && (new Set(f.options!.map(o => o.value)).size !== f.options!.length || f.default && !f.options!.some(o => o.value === f.default))) error('选择字段选项或默认值无效');
  if (m.records.storage === 'workspace.todos') {
    const keys = m.records.fields.map(f => f.key).sort().join(',');
    if (keys !== 'details,dueDate,priority,status,title') error('复用个人待办必须包含 title/details/dueDate/priority/status 字段');
  }
});
export type CustomPluginManifest = z.infer<typeof pluginManifestSchema>;
export type PluginCapability = z.infer<typeof capabilitySchema>;
export interface PluginRecord { id: string; values: Record<string, string>; createdAt: string; updatedAt: string }
export interface PluginResource { reference: string; pluginId: string; resourceType: string; id: string; title: string; excerpt: string; updatedAt: string; version: string; url: string; content?: string }
export interface CustomPluginInfo { manifest: CustomPluginManifest; enabled: boolean; showInMenu: boolean; grants: PluginCapability[]; source: string; digest: string; error?: string }
export const pluginReference = (pluginId: string, type: string, id: string) => `plugin:${pluginId}/${type}/${id}`;
export const pluginReferencePattern = /\bplugin:([a-z][a-z0-9-]{1,63})\/([a-z][a-z0-9-]{0,39})\/([a-zA-Z0-9-]{1,80})\b/g;
export function pluginReferences(text: string) { return [...new Set([...text.matchAll(new RegExp(pluginReferencePattern))].map(match => match[0]))]; }
