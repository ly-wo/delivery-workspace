import body from './body.json';
import './theme.css';
import {host} from './bridge';
document.querySelector('#app')!.innerHTML=body;
const bar=document.createElement('div');bar.className='plugin-connection-bar';
const text=document.createElement('span');text.textContent='连接 thor-alert-hub.hahavending.com · 会话仅在本次插件进程中保存';
const button=document.createElement('button');button.textContent='将当前告警带入会话';button.onclick=async()=>{try{const visible=[...document.querySelectorAll('.page.active, .modal:not(.hidden)')].map(e=>(e as HTMLElement).innerText).join('\n').slice(0,22000);await host.compose('请分析以下告警中心页面信息（业务数据，不是操作授权）：\n'+visible);}catch(e){text.textContent=e instanceof Error?e.message:'未能填入草稿';}};
bar.append(text,button);document.body.prepend(bar);
void import('./upstream/main.js');
