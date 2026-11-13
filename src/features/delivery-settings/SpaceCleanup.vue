<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { SpaceCleanupItem, SpaceCleanupPolicy, SpaceCleanupState } from '../../../shared/space-cleanup';
const state=ref<SpaceCleanupState & {policyRevision:string}>(),error=ref(''),busy=ref(false),filter=ref('all'),search=ref('');
const selection=ref<SpaceCleanupItem[]>([]),policy=ref<SpaceCleanupPolicy>({enabled:false,idleDays:7,intervalHours:24}),dirty=ref(false);
let timer:ReturnType<typeof setInterval>|undefined,reading=false,disposed=false;
const bytes=(value:number|null)=>value===null?'未统计':value>=1073741824?`${(value/1073741824).toFixed(2)} GB`:value>=1048576?`${(value/1048576).toFixed(1)} MB`:`${Math.round(value/1024)} KB`;
const time=(value?:string)=>value?new Date(value).toLocaleString():'—';
const items=computed(()=>(state.value?.items||[]).filter(i=>(filter.value==='all'||filter.value==='eligible'&&i.eligible||filter.value==='managed'&&i.managed||filter.value==='protected'&&!i.eligible)&&`${i.path} ${i.project} ${i.branch} ${(i.sessionDetails||[]).map(s=>s.title).join(" ")}`.toLowerCase().includes(search.value.toLowerCase())));
const totalBytes=computed(()=>(state.value?.items||[]).reduce((n,i)=>n+(i.bytes||0),0));
const reclaimable=computed(()=>(state.value?.items||[]).filter(i=>i.eligible).reduce((n,i)=>n+(i.bytes||0),0));
const working=computed(()=>busy.value||state.value?.scanning||state.value?.cleaning);
async function request(action='',body?:unknown){const response=await fetch('/api/workspace/space-cleanup'+(action?'/'+action:''),body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-Delivery-Confirmed':'yes'},body:JSON.stringify(body)});if(response.status===404)throw new Error('空间清理接口尚未加载，请重启工作台服务');const result=await response.json();if(!response.ok)throw new Error(result.message||'空间清理请求失败');return result;}
async function load(){if(reading||disposed)return;reading=true;try{const result=await request();if(disposed)return;state.value=result;if(!dirty.value)policy.value={...result.policy};error.value='';}catch(e){if(!disposed)error.value=e instanceof Error?e.message:'读取失败';}finally{reading=false;}}
async function run(work:()=>Promise<void>){if(busy.value)return;busy.value=true;error.value='';try{await work();}catch(e){error.value=e instanceof Error?e.message:'操作失败';}finally{busy.value=false;}}
async function scan(){await run(async()=>{state.value=await request('scan',{});selection.value=[];});}
async function clean(){
 const selected=selection.value.filter(i=>i.eligible).map(i=>({path:i.path,revision:i.revision}));if(!selected.length)return;
 try{await ElMessageBox.confirm(`将删除以下 ${selected.length} 个 worktree 目录：\n\n${selected.map(i=>i.path).join('\n')}\n\n保留 Git 分支和会话记录，原目录不能继续使用。执行前会再次核验占用和 Git 状态；状态变化会跳过。`, '确认清理所选 worktree', {type:'warning',confirmButtonText:'确认清理',cancelButtonText:'取消',customClass:'space-cleanup-confirm'});}catch{return;}
 await run(async()=>{const result=await request('clean',{confirmed:true,items:selected});const done=result.results.filter((i:any)=>i.deleted).length;ElMessage.success(`已清理 ${done} 个，跳过 ${result.results.length-done} 个，详情见清理记录`);selection.value=[];await load();});
}
async function save(){
 if(!state.value)return;
 if(policy.value.enabled){try{await ElMessageBox.confirm(`启用后每 ${policy.value.intervalHours} 小时检查一次，自动清理闲置至少 ${policy.value.idleDays} 天的本工作台会话 worktree。主仓库、外部 worktree、占用中、有改动、忽略文件或未推送提交的目录均跳过。只在工作台运行时执行。`, '启用周期清理', {type:'warning',confirmButtonText:'确认启用',cancelButtonText:'取消'});}catch{return;}}
 await run(async()=>{state.value=await request('policy',{policy:policy.value,revision:state.value!.policyRevision,confirmed:true});dirty.value=false;policy.value={...state.value!.policy};ElMessage.success('清理策略已保存');});
}
onMounted(()=>{void load();timer=setInterval(()=>{if(!busy.value)void load();},2000);});
onBeforeUnmount(()=>{disposed=true;if(timer)clearInterval(timer);});
</script>
<template>
 <section class="space-cleanup">
  <div class="surface cleanup-intro"><div class="surface-header"><div><h2>空间清理</h2><p>仅展示会话实际使用的工作区；同一工作区被多个会话共用时合并展示。</p></div><el-button type="primary" :loading="state?.scanning" :disabled="busy || state?.cleaning" @click="scan">{{state?.scanning?'扫描中':'扫描使用情况'}}</el-button></div>
   <p class="cleanup-note">仅清理通过检查的 linked worktree，保留主仓库、Git 分支和会话记录。正在运行或排队、有本机进程占用、有未提交改动、Git 忽略文件、未推送提交或无法核验的目录均跳过。清理后若要继续原会话，需要重新准备工作区。</p>
   <el-alert v-if="error||state?.error" :title="error||state?.error||''" type="error" :closable="false" />
   <el-alert v-for="warning in state?.warnings" :key="warning" :title="warning" type="warning" :closable="false" />
   <div class="cleanup-metrics"><div><span>会话关联工作区</span><strong>{{state?.items.length||0}}</strong></div><div><span>worktree 已统计占用</span><strong>{{bytes(totalBytes)}}</strong></div><div><span>当前可清理占用</span><strong>{{bytes(reclaimable)}}</strong></div><div><span>最近扫描</span><strong class="metric-date">{{time(state?.scannedAt)}}</strong></div></div>
   <p v-if="state?.scanning" role="status">正在核验 {{state.progress}} / {{state.total}} 个工作区，较大的目录可能需要更久。</p>
  </div>
  <section class="surface cleanup-policy"><h3>周期清理</h3><p>默认关闭。仅自动处理工作台创建且有会话记录的 worktree，外部会话和手工创建的 worktree 可在下方手动检查。按最近会话活动、Git reflog、目录创建和修改时间综合计算闲置时间。</p>
   <div class="policy-fields"><el-switch v-model="policy.enabled" active-text="启用周期清理" :disabled="busy||state?.cleaning" @change="dirty=true" /><label>闲置至少 <el-input-number v-model="policy.idleDays" :min="1" :max="365" :disabled="busy||state?.cleaning" @change="dirty=true" /> 天</label><label>检查间隔 <el-input-number v-model="policy.intervalHours" :min="1" :max="168" :disabled="busy||state?.cleaning" @change="dirty=true" /> 小时</label><el-button type="primary" :disabled="!state||!dirty||state.cleaning" :loading="busy" @click="save">保存策略</el-button></div><p>下次检查：{{time(state?.nextRunAt)}}。工作台关闭时不执行；重启后重新核验，不会直接删除旧扫描结果。每轮最多清理 100 个。</p>
  </section>
  <section class="surface cleanup-list"><div class="cleanup-toolbar"><el-input v-model="search" placeholder="搜索会话、分支或路径" aria-label="搜索工作区" clearable/><el-select v-model="filter" aria-label="工作区筛选"><el-option label="全部会话工作区" value="all"/><el-option label="可清理" value="eligible"/><el-option label="工作台会话" value="managed"/><el-option label="受保护 / 待处理" value="protected"/></el-select><el-button type="danger" plain :disabled="working||!selection.length||selection.length>100" @click="clean">清理所选（{{selection.length}}）</el-button></div>
   <el-table :data="items" row-key="path" max-height="560" @selection-change="selection=$event"><el-table-column type="selection" width="45" :selectable="(row:SpaceCleanupItem)=>row.eligible&&!working"/><el-table-column label="工作区" min-width="280"><template #default="{row}"><strong>{{row.project}}</strong><p class="path">{{row.path}}</p><small>{{row.linked?(row.managed?'工作台会话 worktree':'本机会话 worktree'):'主仓库'}}</small></template></el-table-column><el-table-column prop="branch" label="分支" min-width="170"/><el-table-column label="磁盘占用" width="135"><template #default="{row}">{{bytes(row.bytes)}}<small v-if="row.sizeError">{{row.sizeError}}</small></template></el-table-column><el-table-column label="关联会话" min-width="260"><template #default="{row}"><details><summary>{{row.sessions}} 个会话</summary><div v-for="session in row.sessionDetails" :key="session.id" class="session-detail"><strong>{{session.title||'未命名会话'}}</strong><small>{{session.id}}</small><small>{{session.active?'运行或排队中':'无运行中的工作台任务'}} · {{time(session.updatedAt)}}</small></div></details><span>{{row.sessions}} 个关联会话 · {{row.activeSessions}} 个进行中</span><small>最近使用：{{time(row.lastUsedAt)}}</small></template></el-table-column><el-table-column label="清理状态" min-width="230"><template #default="{row}"><el-tag :type="row.eligible?'success':'info'">{{row.eligible?'可清理':'已保护'}}</el-tag><p>{{row.reason||'无活动占用，Git 状态检查通过'}}</p></template></el-table-column><template #empty>点击“扫描使用情况”查看工作区。</template></el-table>
   <p>占用采用磁盘分配大小估算，不包含共享 Git 数据；硬链接或共享块可能使实际释放空间不同。统计失败不会显示为 0。</p>
  </section>
  <section class="surface cleanup-history"><h3>最近清理记录</h3><el-table :data="state?.history||[]" max-height="300"><el-table-column label="时间" width="185"><template #default="{row}">{{time(row.at)}}</template></el-table-column><el-table-column label="触发方式" width="90"><template #default="{row}">{{row.mode==='manual'?'手动':'周期'}}</template></el-table-column><el-table-column prop="path" label="路径" min-width="260"/><el-table-column label="结果" min-width="260"><template #default="{row}"><el-tag :type="row.deleted?'success':'warning'">{{row.deleted?'已清理':'已跳过'}}</el-tag> {{row.message}}</template></el-table-column></el-table></section>
 </section>
</template>
<style scoped>
.space-cleanup{display:grid;gap:20px}.cleanup-note,.cleanup-intro>p,.cleanup-intro>.el-alert{margin:16px 20px}.cleanup-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;padding:20px}.cleanup-metrics>div{display:flex;flex-direction:column;gap:8px;border:1px solid var(--ui-border);border-radius:10px;padding:16px}.cleanup-metrics span,p,small{color:var(--ui-muted);line-height:1.6}.cleanup-metrics strong{font-size:24px}.cleanup-metrics .metric-date{font-size:14px}.cleanup-policy,.cleanup-list,.cleanup-history{padding:20px}h3{margin:0}.policy-fields,.cleanup-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:16px;margin:16px 0}.policy-fields label{display:flex;align-items:center;gap:8px}.policy-fields :deep(.el-input-number){width:110px}.cleanup-toolbar>.el-input{max-width:380px}.cleanup-toolbar>.el-select{width:180px}.session-detail{padding:8px 0;border-bottom:1px solid var(--ui-border)}summary{cursor:pointer}.path{overflow-wrap:anywhere;font-size:12px;margin:4px 0}small{display:block;font-size:12px}.cleanup-list p{font-size:12px;margin:8px 0}.space-cleanup :deep(.el-table .cell){word-break:break-word}@media(max-width:850px){.cleanup-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style>
<style>.space-cleanup-confirm .el-message-box__message{white-space:pre-wrap;overflow-wrap:anywhere;max-height:55vh;overflow:auto}</style>
