import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createSpaceCleanup,createUnusedWorkspaceCheck} from '../server/space-cleanup.js';
import {createProjectWorkspaces} from '../server/project-workspaces.js';
import {createWorkspaceDiscovery} from '../server/workspace-discovery.js';
import {createWorkspaceUsageCheck} from '../server/project-workspace-usage.js';
import {createSpaceCleanupRoutes} from '../server/space-cleanup-routes.js';
import type {ProjectsData} from '../shared/hub.js';
import type {WorkspaceActivity} from '../shared/space-cleanup.js';
const exec=promisify(execFile),day=86400000;
async function git(folder:string,...args:string[]){return (await exec('git',['-C',folder,...args],{env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'}})).stdout.trim();}
async function fixture(t:any){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'space-cleanup-'))),repo=path.join(root,'repo'),remote=path.join(root,'remote.git'),managedRoot=path.join(root,'workspaces');
 await fs.mkdir(repo);await fs.mkdir(managedRoot);await git(root,'init','--bare',remote);await git(repo,'init','-b','main');await git(repo,'config','user.email','test@example.invalid');await git(repo,'config','user.name','Test');
 await fs.writeFile(path.join(repo,'file.txt'),'preserved\n');await fs.writeFile(path.join(repo,'.gitignore'),'private/\n');await git(repo,'add','.');await git(repo,'commit','-m','fixture');await git(repo,'remote','add','origin',remote);await git(repo,'push','-u','origin','main');
 const activities:WorkspaceActivity[]=[],busy=new Set<string>();let now=Date.now()+30*day;
 const readProjects=createWorkspaceDiscovery(async()=>({projects:[{path:repo,displayName:'测试项目',branch:'main'}],roots:[],directoryCount:1,durationMs:0,limited:false,unreadableCount:0}) as ProjectsData,managedRoot);
 const options={readProjects,withWorkspace:async<T>(_p:string,_o:string,work:()=>Promise<T>)=>work(),checkBusy:async(p:string)=>{if(busy.has(p))throw Error('进程正在使用');},checkUnused:createUnusedWorkspaceCheck(()=>activities,managedRoot,()=>now),canRun:()=>true,protectedPaths:[]};
 const workspaces=await createProjectWorkspaces(path.join(root,'state'),options);
 const serviceOptions={readProjects,readActivity:()=>activities,workspaces,managedRoot,canRun:()=>true,now:()=>now};
 const service=await createSpaceCleanup(path.join(root,'state'),serviceOptions);
 t.after(async()=>{await service.close();await workspaces.close();await fs.rm(root,{recursive:true,force:true})});
 let created=0;
 async function linked(managed=true){const id=(created++===0?'f':'0')+randomUUID().slice(1),folder=path.join(managed?managedRoot:root,id);await git(repo,'worktree','add','-b','fixture/'+id,folder,'origin/main');activities.push({path:folder,sessionId:id,title:'测试会话',updatedAt:new Date(now-20*day).toISOString(),active:false,managed});return folder;}
 const select=(folder:string)=>{const row=service.snapshot().items.find(i=>i.path===folder)!;return {path:row.path,revision:row.revision};};
 return {root,repo,remote,managedRoot,activities,busy,service,workspaces,serviceOptions,options,linked,select,advance:(ms:number)=>{now+=ms}};
}

test('发现会话及外部 linked worktree，展示占用与会话，主仓库和修改/忽略/占用目录受保护',async t=>{
 const f=await fixture(t),clean=await f.linked(),dirty=await f.linked(),ignored=await f.linked(),busy=await f.linked(),external=await f.linked(false);
 await fs.writeFile(path.join(dirty,'file.txt'),'changed');await fs.mkdir(path.join(ignored,'private'));await fs.writeFile(path.join(ignored,'private','secret.txt'),'test fixture');f.busy.add(busy);
 await f.service.scan();const rows=f.service.snapshot().items,find=(p:string)=>rows.find(i=>i.path===p)!;
 assert.equal(rows.length,5);assert.equal(find(f.repo),undefined);assert.equal(find(clean).eligible,true);assert.ok(find(clean).bytes!>0);assert.equal(find(clean).sessions,1);assert.equal(find(clean).managed,true);assert.equal(find(external).managed,false);
 assert.equal(find(dirty).eligible,false);assert.match(find(ignored).reason,/忽略/);assert.match(find(busy).reason,/进程/);
 const result=await f.service.clean({confirmed:true,items:[f.select(clean)]});assert.equal(result.results[0].deleted,true,result.results[0].message);await assert.rejects(fs.stat(clean),{code:'ENOENT'});assert.equal((await git(f.repo,'branch','--list','fixture/*')).split('\n').length,5);assert.equal(await fs.readFile(path.join(f.repo,'file.txt'),'utf8'),'preserved\n');
 assert.equal(f.service.snapshot().history[0].deleted,true);
});

test('清理前重新核验：新增活动、忽略文件、未提交改动和未推送提交均不删除',async t=>{
 for(const kind of ['active','ignored','dirty','commit']){
  const f=await fixture(t),folder=await f.linked();await f.service.scan();const item=f.select(folder);
  if(kind==='active')f.activities[0].active=true;
  if(kind==='ignored'){await fs.mkdir(path.join(folder,'private'));await fs.writeFile(path.join(folder,'private','keep'),'preserve');}
  if(kind==='dirty'||kind==='commit')await fs.writeFile(path.join(folder,'file.txt'),'new');
  if(kind==='commit'){await git(folder,'add','file.txt');await git(folder,'commit','-m','unpushed');}
  const result=await f.service.clean({confirmed:true,items:[item]});assert.equal(result.results[0].deleted,false,kind);assert.ok(await fs.stat(folder));
 }
});

test('不接受未确认、重复或伪造目标；旧预览不能删除主仓库或改动目录',async t=>{
 const f=await fixture(t),folder=await f.linked();await f.service.scan();const item=f.select(folder);
 await assert.rejects(f.service.clean({items:[item]}));await assert.rejects(f.service.clean({confirmed:true,items:[item,item]}),/重复/);
 await assert.rejects(f.service.clean({confirmed:true,items:[{path:f.root,revision:item.revision}]}),/预览/);
 await assert.rejects(f.workspaces.cleanup({path:f.repo,revision:(await f.workspaces.preview(f.repo)).revision}),/主仓库|依赖/);
 await fs.writeFile(path.join(folder,'file.txt'),'keep');await assert.rejects(f.workspaces.cleanup(item),/变化|改动/);
});

test('周期默认关闭；启用后仅删除满足闲置期限的工作台会话 worktree，策略与结果持久化',async t=>{
 const f=await fixture(t),old=await f.linked(),recent=await f.linked(),external=await f.linked(false);
 f.activities.find(a=>a.path===recent)!.updatedAt=new Date(Date.now()+30*day).toISOString();
 await f.service.tick();assert.ok(await fs.stat(old));assert.equal(f.service.snapshot().scannedAt,undefined);
 await f.service.savePolicy({confirmed:true,revision:f.service.snapshot().policyRevision,policy:{enabled:true,idleDays:7,intervalHours:1}});
 f.advance(3600001);await f.service.tick();assert.equal(f.service.snapshot().history[0]?.deleted,true,JSON.stringify(f.service.snapshot().history));await assert.rejects(fs.stat(old),{code:'ENOENT'});assert.ok(await fs.stat(recent));assert.ok(await fs.stat(external));
 const loaded=await createSpaceCleanup(path.join(f.root,'state'),f.serviceOptions);t.after(()=>loaded.close());assert.equal(loaded.snapshot().policy.enabled,true);assert.equal(loaded.snapshot().history[0].mode,'scheduled');assert.equal(loaded.snapshot().history[0].path,old);
 await loaded.savePolicy({confirmed:true,revision:loaded.snapshot().policyRevision,policy:{enabled:false,idleDays:7,intervalHours:1}});assert.equal(loaded.snapshot().nextRunAt,undefined);
});

test('周期删除持锁后再次检查最近使用时间，重新使用的目录保留',async t=>{
 const f=await fixture(t),folder=await f.linked();
 f.options.withWorkspace=async(_p,_o,work)=>{f.activities[0].updatedAt=new Date(Date.now()+31*day).toISOString();return work();};
 await f.service.savePolicy({confirmed:true,revision:f.service.snapshot().policyRevision,policy:{enabled:true,idleDays:7,intervalHours:1}});f.advance(3600001);await f.service.tick();
 assert.ok(await fs.stat(folder));assert.match(f.service.snapshot().history[0].message,/闲置/);
});

test('磁盘统计失败标为未知，策略冲突拒绝覆盖；扫描失败不可误判为空闲',async t=>{
 const f=await fixture(t),folder=await f.linked();const service=await createSpaceCleanup(path.join(f.root,'other-state'),{...f.serviceOptions,measure:async()=>{throw Error('denied')}});t.after(()=>service.close());
 await service.scan();assert.equal(service.snapshot().items.find(i=>i.path===folder)!.bytes,null);
 const revision=service.snapshot().policyRevision;await service.savePolicy({confirmed:true,revision,policy:{enabled:false,idleDays:10,intervalHours:12}});
 await assert.rejects(service.savePolicy({confirmed:true,revision,policy:{enabled:true,idleDays:1,intervalHours:1}}),/变化/);
 const failed=await createSpaceCleanup(path.join(f.root,'failed-state'),{...f.serviceOptions,scanBusy:async()=>{throw Error('无法核验占用')}});t.after(()=>failed.close());await failed.scan();assert.match(failed.snapshot().error!,/核验/);assert.equal(failed.snapshot().items.length,0);
});

test('进程占用检查保护子目录，读取占用失败时拒绝',async t=>{
 const f=await fixture(t),folder=await f.linked();await fs.mkdir(path.join(folder,'nested'));
 await assert.rejects(createWorkspaceUsageCheck(()=>[],async()=>`p123\nn${folder}/nested\n`)(folder),/123/);
 await assert.rejects(createWorkspaceUsageCheck(()=>[folder],async()=>'')(folder),/运行或排队/);
 await assert.rejects(createWorkspaceUsageCheck(()=>[],async()=>{throw Error('lsof unavailable')})(folder));
});

test('空间清理 HTTP 路由保护同源、确认头与请求格式',async()=>{
 let called=0,status=0;const service:any={snapshot:()=>({items:[]}),scan:async()=>{called++},clean:async()=>{called++;return{}},savePolicy:async()=>{called++;return{}}};
 const route=createSpaceCleanupRoutes(service,{port:5317,json(_r,s){status=s},body:async()=>({})});
 const req:any={method:'POST',socket:{remoteAddress:'127.0.0.1'},headers:{host:'localhost:5317',origin:'http://localhost:5317','content-type':'application/json','x-delivery-confirmed':'yes'}};
 const url=new URL('http://localhost:5317/api/workspace/space-cleanup/clean');
 for(const headers of [{origin:'https://evil.test'},{'x-delivery-confirmed':''}]){await route({...req,headers:{...req.headers,...headers}},{} as any,url);assert.equal(status,403)}
 await route({...req,headers:{...req.headers,'content-type':'text/plain'}},{} as any,url);assert.equal(status,415);assert.equal(called,0);
 await route(req,{} as any,url);assert.equal(status,200);assert.equal(called,1);
});


test('周期扫描期间关闭策略，不继续删除；重启后到期策略重新扫描',async t=>{
 const f=await fixture(t),folder=await f.linked();
 await f.service.savePolicy({confirmed:true,revision:f.service.snapshot().policyRevision,policy:{enabled:true,idleDays:7,intervalHours:1}});
 f.advance(3600001);
 let reached!:()=>void,release!:()=>void;
 const entered=new Promise<void>(r=>{reached=r}),held=new Promise<void>(r=>{release=r});
 const loaded=await createSpaceCleanup(path.join(f.root,'state'),{...f.serviceOptions,readProjects:async refresh=>{reached();await held;return f.serviceOptions.readProjects(refresh)}});
 t.after(()=>loaded.close());
 const pending=loaded.tick();await entered;
 await loaded.savePolicy({confirmed:true,revision:loaded.snapshot().policyRevision,policy:{enabled:false,idleDays:7,intervalHours:1}});
 release();await pending;assert.ok(await fs.stat(folder));assert.equal(loaded.snapshot().history.length,0);assert.equal(loaded.snapshot().policy.enabled,false);
});


test('项目根目录未配置时，从已知会话子目录发现注册 worktree，缺失会话目录仅警告',async t=>{
 const f=await fixture(t),folder=await f.linked(false),nested=path.join(folder,'nested');await fs.mkdir(nested);
 const read=createWorkspaceDiscovery(async()=>({projects:[],roots:[],limited:false,unreadableCount:0}) as unknown as ProjectsData,path.join(f.root,'empty-managed'),()=>[nested,nested,path.join(f.root,'gone'),'']);
 const result=await read(true);
 assert.ok(result.projects.some(p=>p.path===folder));assert.ok(result.projects.some(p=>p.path===f.repo));assert.equal(result.projects.some(p=>p.path===nested),false);assert.equal(result.projects.length,2);assert.equal(result.unreadableCount,1);
});


test('只列出会话实际工作区，排除同仓库无会话 worktree；共用会话合并展示并保护活跃占用',async t=>{
 const f=await fixture(t),folder=await f.linked(),unrelated=await f.linked();
 f.activities.splice(1,1);f.activities.push({...f.activities[0],sessionId:'second',title:'第二个会话',active:true});
 await f.service.scan();const rows=f.service.snapshot().items;
 assert.equal(rows.length,1);assert.equal(rows[0].path,folder);assert.equal(rows[0].sessions,2);assert.equal(rows[0].activeSessions,1);assert.equal(rows[0].eligible,false);assert.ok(rows[0].sessionDetails.some(s=>s.title==='第二个会话'));assert.ok(await fs.stat(unrelated));
 f.activities.splice(0);await assert.rejects(f.options.checkUnused(folder),/无关联会话/);
});
