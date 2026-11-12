import {host} from '../../shared/plugin-application-sdk';
export {host};
const memory = new Map<string,string>();
export const pluginStorage={getItem:(key:string)=>memory.get(key)||null,setItem:(key:string,value:string)=>memory.set(key,value)};
export function pluginConfirm(message:string):Promise<boolean>{
 return new Promise(resolve=>{const shade=document.createElement('div');shade.className='plugin-confirm';const box=document.createElement('section');const title=document.createElement('h3');title.textContent='确认告警中心操作';const pre=document.createElement('pre');pre.textContent=message;const cancel=document.createElement('button');cancel.textContent='取消';const ok=document.createElement('button');ok.textContent='确认执行';const finish=(value:boolean)=>{shade.remove();resolve(value)};cancel.onclick=()=>finish(false);ok.onclick=()=>finish(true);box.append(title,pre,cancel,ok);shade.append(box);document.body.append(shade);cancel.focus();});
}
export async function pluginFetch(path:string,opts:RequestInit={}):Promise<Response>{
 const check=()=>{if(opts.signal?.aborted)throw new DOMException('Aborted','AbortError')};check();
 const input={path,method:opts.method||'GET',...(opts.body?{body:String(opts.body)}:{})};let ticket;
 if(input.method!=='GET'&&!['/api/auth/login','/api/auth/logout'].includes(path)){
  const preview=await host.request('prepare',input);
  if(!await pluginConfirm(`目标：${preview.endpoint}\n${preview.method} ${preview.path}\n\n${preview.body}\n\n此操作会写入远端告警中心。`))throw new Error('操作已取消');ticket=preview.ticket;
 }
 check();const data=await host.request('request',{...input,ticket});check();
 return new Response([204,205,304].includes(data.status)?null:data.body,{status:data.status,headers:data.headers});
}
