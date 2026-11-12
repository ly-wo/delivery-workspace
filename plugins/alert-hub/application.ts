import { createHash, randomUUID } from 'node:crypto';
import routes from './routes.json' with {type:'json'};
export const endpoint = 'https://thor-alert-hub.hahavending.com';
const patterns = routes.map(([method, path]) => ({method, pattern: new RegExp('^'+path!.replace('{id}', '[a-zA-Z0-9_-]+')+'$')}));
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function createPlugin(_host: unknown, fetchImpl = fetch) {
  let cookie = '';
  const tickets = new Map<string,{digest:string;expires:number}>();
  function validate(raw: any) {
    if (!raw || typeof raw.path !== 'string' || !raw.path.startsWith('/') || raw.path.startsWith('//') || /[\\\x00-\x20]/.test(raw.path)) throw new Error('请求路径无效');
    const url = new URL(raw.path,endpoint), method = raw.method || 'GET';
    if (url.origin !== endpoint || !patterns.some(p=>p.method===method && p.pattern.test(url.pathname)) && !(method==='GET' && ['/samples/generic-alert.json','/samples/tencent-cls.ndjson'].includes(url.pathname))) throw new Error('该操作未在插件接口清单中');
    if (raw.body !== undefined && (typeof raw.body !== 'string' || Buffer.byteLength(raw.body)>350000)) throw new Error('请求内容过大或格式无效');
    return {path:url.pathname+url.search,method,body:raw.body as string|undefined};
  }
  async function send(input: ReturnType<typeof validate>) {
    let response: Response;
    try { response=await fetchImpl(endpoint+input.path,{method:input.method,headers:{Accept:'application/json, text/csv, text/plain','Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:input.body,redirect:'error',signal:AbortSignal.timeout(20000)}); }
    catch { throw new Error(input.method==='GET'?'连接告警中心失败，请检查网络后重试':'请求结果未知，请到告警中心核对后再操作；未自动重试'); }
    const setCookies=response.headers.getSetCookie();
    for(const value of setCookies) {const match=/^ah_session=([^;]*)/.exec(value);if(match)cookie=match[1]?`ah_session=${match[1]}`:'';}
    if(input.path==='/api/auth/logout') {cookie='';tickets.clear();}
    if(response.status===401) {cookie='';tickets.clear();}
    const reader=response.body?.getReader();let text='',size=0;const decoder=new TextDecoder();
    if(reader) {try {while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>4000000){await reader.cancel();throw new Error('响应超过 4 MB，请缩小查询范围');}text+=decoder.decode(value,{stream:true});}text+=decoder.decode();}catch(error){throw new Error(input.method==='GET'?'读取响应失败，请缩小查询范围':'响应读取失败，操作结果未知，请先核对远端状态');}}
    return {status:response.status,body:text,headers:{'content-type':response.headers.get('content-type')||'application/json','content-disposition':response.headers.get('content-disposition')||''}};
  }
  return {async request(method:string, raw:any) {
    if(method==='status')return {endpoint,authenticated:!!cookie};
    const input=validate(raw);
    const login=['/api/auth/login','/api/auth/logout'].includes(input.path);
    if(method==='prepare') {
      if(input.method==='GET'||login)throw new Error('该操作无需写入预览');
      if(!cookie)throw new Error('请先登录告警中心');
      for(const [id,t] of tickets)if(t.expires<Date.now())tickets.delete(id);
      if(tickets.size>=20)throw new Error('待确认操作过多');
      const ticket=randomUUID();tickets.set(ticket,{digest:fingerprint(input),expires:Date.now()+120000});
      return {ticket,endpoint,path:input.path,method:input.method,body:input.path==='/api/auth/password'?'密码修改（不展示密码）':input.body||''};
    }
    if(method!=='request')throw new Error('不支持的插件操作');
    if(input.method!=='GET'&&!login) {const t=tickets.get(raw.ticket);tickets.delete(raw.ticket);if(!t||t.expires<Date.now()||t.digest!==fingerprint(input))throw new Error('写入确认已失效，请重新预览');}
    return send(input);
  },async close(){cookie='';tickets.clear();}};
}
