import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { privateJson, readJson } from './plugins/custom-runtime.js';
import { spaceCleanupPolicySchema, type WorkspaceActivity, type SpaceCleanupItem, type SpaceCleanupResult, type SpaceCleanupState } from '../shared/space-cleanup.js';
import type { ProjectsData } from '../shared/hub.js';
import type { createProjectWorkspaces } from './project-workspaces.js';
const exec = promisify(execFile);
const day = 86400_000, inside = (root: string, child: string) => child === root || child.startsWith(root + path.sep);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function git(folder: string, args: string[]) {
  return (await exec('git', ['-C', folder, ...args], { timeout: 15000, maxBuffer: 4_000_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })).stdout;
}
export async function workspaceLastUsed(folder: string, activities: WorkspaceActivity[]) {
  const stat = await fs.stat(folder);
  const reflog = await git(folder, ['reflog', 'show', '-1', '--date=unix', '--format=%gD']);
  const matches = activities.filter(a => inside(folder, path.resolve(a.path)));
  const times = [stat.birthtimeMs, stat.mtimeMs, Number(reflog.match(/@\{(\d+)\}/)?.[1] || 0) * 1000,
    ...matches.map(a => Date.parse(a.updatedAt))].filter(Number.isFinite);
  return { timestamp: Math.max(...times), matches };
}
export function createUnusedWorkspaceCheck(readActivity: () => WorkspaceActivity[], managedRoot: string, now = Date.now) {
  return async (folder: string, idleBefore?: number) => {
    const { timestamp, matches } = await workspaceLastUsed(folder, readActivity());
    if (!matches.length) throw new Error('工作区已无关联会话，请重新扫描');
    if (matches.some(a => a.active)) throw new Error('工作区有运行或排队中的会话');
    if (idleBefore !== undefined) {
      if (path.dirname(folder) !== managedRoot || !matches.some(a => a.managed && path.resolve(a.path) === folder)) throw new Error('周期清理仅处理工作台创建且有会话记录的 worktree');
      if (!Number.isFinite(timestamp) || timestamp > now() || timestamp > idleBefore) throw new Error('工作区尚未达到闲置时间，已跳过');
    }
  };
}
const storedSchema = z.object({ policy: spaceCleanupPolicySchema, nextRunAt: z.string().datetime().optional(),
  history: z.array(z.object({ path: z.string(), deleted: z.boolean(), message: z.string(), bytes: z.number(), at: z.string(), mode: z.enum(['manual','scheduled']) })).max(200) }).strict();
export async function createSpaceCleanup(directory: string, options: {
  readProjects(refresh?: boolean): Promise<ProjectsData>; readActivity(): WorkspaceActivity[];
  workspaces: Pick<Awaited<ReturnType<typeof createProjectWorkspaces>>, 'preview' | 'cleanup'>;
  scanBusy?: () => Promise<(folder: string) => Promise<void>>;
  managedRoot: string; canRun(): boolean; now?: () => number; intervalMs?: number;
  measure?: (folder: string) => Promise<number>;
}) {
  const file = path.join(directory, 'space-cleanup.json'), now = options.now || Date.now;
  const stored = storedSchema.parse(await readJson(file, { policy: {enabled:false,idleDays:7,intervalHours:24}, history:[] }));
  const state: SpaceCleanupState = { ...stored, scanning:false,cleaning:false,progress:0,total:0,warnings:[],items:[] };
  let cleaning: Promise<unknown> | undefined;
  let scanning: Promise<void> | undefined, ticking: Promise<void> | undefined, timer: ReturnType<typeof setInterval> | undefined, closed = false, saving = false;
  let writes: Promise<unknown> = Promise.resolve();
  function persist() {
    const copy = structuredClone({ policy:state.policy, nextRunAt:state.nextRunAt, history:state.history });
    const task = writes.then(() => privateJson(file, copy)); writes = task.catch(() => {}); return task;
  }
  const measure = options.measure || (async (folder: string) => {
    const { stdout } = await exec('du', ['-sk', folder], { timeout:30000, maxBuffer:100000 });
    const kb = Number(stdout.match(/^(\d+)\s/)?.[1]); if (!Number.isFinite(kb)) throw new Error('无法统计占用'); return kb * 1024;
  });
  async function inspect(project: ProjectsData['projects'][number], activities: WorkspaceActivity[], checkBusy?: (folder: string) => Promise<void>): Promise<SpaceCleanupItem> {
    const folder = path.resolve(project.path);
    const item: SpaceCleanupItem = {path:folder,project:project.displayName || project.projectName || path.basename(folder),branch:project.branch || '',bytes:null,
      linked:false,managed:false,lastUsedAt:'',sessions:0,activeSessions:0,sessionDetails:[],eligible:false,reason:'',revision:''};
    const sessions = new Map<string, SpaceCleanupItem['sessionDetails'][number]>();
    for (const activity of activities) {
      const previous = sessions.get(activity.sessionId);
      if (!previous) sessions.set(activity.sessionId, { id: activity.sessionId, title: activity.title, active: activity.active, updatedAt: activity.updatedAt });
      else {
        previous.active ||= activity.active;
        if (Date.parse(activity.updatedAt) > Date.parse(previous.updatedAt)) { previous.updatedAt = activity.updatedAt; previous.title = activity.title; }
      }
    }
    item.sessionDetails = [...sessions.values()];
    item.sessions = sessions.size;
    item.activeSessions = item.sessionDetails.filter(s => s.active).length;
    try {
      const stat = await fs.lstat(folder);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(folder) !== folder) throw new Error('目录不可访问或为符号链接');
      const [gitDir,common] = await Promise.all(['--git-dir','--git-common-dir'].map(flag => git(folder,['rev-parse','--path-format=absolute',flag])));
      item.linked = gitDir.trim() !== common.trim();
      const usage = await workspaceLastUsed(folder, activities);
      item.lastUsedAt = new Date(usage.timestamp).toISOString();
      item.sessions = new Set(usage.matches.map(a=>a.sessionId)).size;
      item.activeSessions = new Set(usage.matches.filter(a=>a.active).map(a=>a.sessionId)).size;
      item.managed = item.linked && path.dirname(folder) === options.managedRoot && usage.matches.some(a=>a.managed && path.resolve(a.path)===folder);
      if (!item.linked) { item.reason='主仓库受保护，不参与空间清理'; return item; }
      try { item.bytes = await measure(folder); } catch { item.sizeError='占用统计失败'; }
      const preview = await options.workspaces.preview(folder, checkBusy); item.revision=preview.revision;
      item.reason = item.activeSessions ? '会话正在运行或排队' : preview.reason || '';
      if (!item.reason && (await git(folder,['ls-files','--others','--ignored','--exclude-standard','-z'])).length) item.reason='含 Git 忽略文件，需自行处理后再清理';
      item.eligible = preview.eligible && !item.reason;
    } catch { item.reason ||= '无法完整核验该目录，已保护'; }
    return item;
  }
  function snapshot() { return structuredClone({...state, policyRevision:digest(state.policy)}); }
  function scan() {
    if (scanning) return scanning;
    if (state.cleaning || saving || closed) return Promise.reject(new Error('清理或配置保存中，请稍后扫描'));
    state.scanning=true;state.error=undefined;state.progress=0;state.total=0;state.items=[];state.warnings=[];
    scanning=(async()=>{
      const source=await options.readProjects(true);
      const checkBusy = await options.scanBusy?.();
      if(source.limited)state.warnings.push('项目扫描达到上限，当前列表不代表全部 worktree');
      if(source.unreadableCount)state.warnings.push(`${source.unreadableCount} 个目录无法读取或核验`);
      // Resolve each session to its closest Git root. A repository's other registered
      // worktrees (or a parent repository) are not session workspaces by association.
      const candidates=[...new Map(source.projects.map(p=>[path.resolve(p.path),p])).values()].sort((a,b)=>b.path.length-a.path.length);
      const associations = new Map<string, WorkspaceActivity[]>();
      for (const activity of options.readActivity()) {
        if (!path.isAbsolute(activity.path)) continue;
        const project = candidates.find(p => inside(path.resolve(p.path), path.resolve(activity.path)));
        if (project) associations.set(project.path, [...(associations.get(project.path) || []), activity]);
      }
      const projects = candidates.filter(p => associations.has(p.path)); state.total=projects.length;
      let cursor=0;
      await Promise.all(Array.from({length:3},async()=>{while(cursor<projects.length&&!closed){const project=projects[cursor++];state.items.push(await inspect(project, associations.get(project.path)!, checkBusy));state.progress++;}}));
      state.items.sort((a,b)=>(b.bytes||0)-(a.bytes||0));state.scannedAt=new Date(now()).toISOString();
    })().catch(e=>{state.error=e instanceof Error?e.message:'扫描失败';}).finally(()=>{state.scanning=false;scanning=undefined;});
    return scanning;
  }
  async function performClean(raw: unknown, mode: 'manual'|'scheduled'='manual') {
    const input=z.object({confirmed:z.literal(true),items:z.array(z.object({path:z.string(),revision:z.string().min(1)}).strict()).min(1).max(100)}).strict().parse(raw);
    if(closed||state.cleaning||state.scanning||saving||!options.canRun())throw new Error('工作台或空间清理正在处理其他操作');
    if(mode==='scheduled'&&!state.policy.enabled)throw new Error('周期清理已关闭');
    if(new Set(input.items.map(i=>i.path)).size!==input.items.length)throw new Error('清理列表包含重复目录');
    for(const selected of input.items){const item=state.items.find(i=>i.path===selected.path);if(!item?.eligible||item.revision!==selected.revision)throw new Error('清理预览已变化，请重新扫描选择');}
    state.cleaning=true;
    const results:SpaceCleanupResult[]=[];
    try{
      await persist(); // Verify the audit store before touching any worktree.
      for(const selected of input.items){
        if(closed||!options.canRun())break;
        const item=state.items.find(i=>i.path===selected.path)!;
        const result:SpaceCleanupResult={path:item.path,deleted:false,bytes:0,message:'',mode,at:new Date(now()).toISOString()};
        try{
          // This guard is repeated under the existing workspace lock by cleanup().
          await createUnusedWorkspaceCheck(options.readActivity,options.managedRoot,now)(item.path,mode==='scheduled'?now()-state.policy.idleDays*day:undefined);
          await options.workspaces.cleanup({...selected,...(mode==='scheduled'?{idleBefore:now()-state.policy.idleDays*day}:{})});
          result.deleted=true;result.bytes=item.bytes||0;result.message='已清理 worktree，保留 Git 分支和会话记录';
          state.items=state.items.filter(i=>i.path!==item.path);
        }catch(e){result.message=e instanceof Error?e.message:'清理失败';item.eligible=false;item.reason=result.message;}
        results.push(result);state.history=[result,...state.history].slice(0,200);await persist();
      }
    }finally{state.cleaning=false;}
    return {results};
  }
  function clean(raw: unknown, mode: 'manual'|'scheduled'='manual') {
    if (cleaning) return Promise.reject(new Error('清理正在进行，请稍后重试'));
    const task = performClean(raw, mode); cleaning = task;
    return task.finally(() => { if (cleaning === task) cleaning = undefined; });
  }
  async function tick() {
    if(closed||scanning||state.cleaning||saving||!options.canRun()||!state.policy.enabled)return;
    if(state.nextRunAt&&Date.parse(state.nextRunAt)>now())return;
    const revision=digest(state.policy);
    state.nextRunAt=new Date(now()+state.policy.intervalHours*3600000).toISOString();await persist();
    await scan();
    if(closed||state.error||!state.policy.enabled||digest(state.policy)!==revision)return;
    const items=state.items.filter(i=>i.managed&&i.eligible&&Date.parse(i.lastUsedAt)<=now()-state.policy.idleDays*day).slice(0,100).map(i=>({path:i.path,revision:i.revision}));
    if(items.length)await clean({confirmed:true,items},'scheduled');
  }
  return {
    snapshot,scan,clean,
    async savePolicy(raw:unknown){
      const input=z.object({policy:spaceCleanupPolicySchema,revision:z.string(),confirmed:z.literal(true)}).strict().parse(raw);
      if(saving||state.cleaning||closed)throw new Error('清理或保存正在进行，请稍后重试');
      if(input.revision!==digest(state.policy))throw new Error('策略已变化，请刷新后保存');
      saving=true;const previous={policy:state.policy,nextRunAt:state.nextRunAt};
      state.policy=input.policy;state.nextRunAt=input.policy.enabled?new Date(now()+input.policy.intervalHours*3600000).toISOString():undefined;
      try{await persist();}catch(e){Object.assign(state,previous);throw e;}finally{saving=false;}return snapshot();
    },
    tick,
    start(){if(timer||closed)return;timer=setInterval(()=>{if(ticking)return;ticking=tick().catch(e=>{state.error=e instanceof Error?e.message:'周期清理失败';}).finally(()=>{ticking=undefined;});},options.intervalMs||60000);timer.unref();},
    isIdle:()=>!state.cleaning&&!scanning&&!ticking&&!saving,
    async close(){closed=true;if(timer)clearInterval(timer);await ticking;await scanning;await cleaning;await writes;},
  };
}
export type SpaceCleanupService=Awaited<ReturnType<typeof createSpaceCleanup>>;
