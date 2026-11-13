import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SpaceCleanupService } from './space-cleanup.js';
export function createSpaceCleanupRoutes(service: SpaceCleanupService, io: { port:number; json(r:ServerResponse,status:number,value:unknown):void; body(r:IncomingMessage,limit?:number):Promise<unknown> }) {
  const base='/api/workspace/space-cleanup';
  return async(request:IncomingMessage,response:ServerResponse,url:URL)=>{
    if(![base,base+'/scan',base+'/clean',base+'/policy'].includes(url.pathname))return false;
    const send=(status:number,value:unknown)=>{io.json(response,status,value);return true;};
    if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(request.socket.remoteAddress||'')||![`localhost:${io.port}`,`127.0.0.1:${io.port}`].includes(request.headers.host||''))return send(403,{message:'请从本机工作台管理空间清理'});
    if(request.method==='GET'&&url.pathname===base)return send(200,service.snapshot());
    if(request.method!=='POST'||url.pathname===base)return send(405,{message:'请求方法不支持'});
    if(request.headers.origin!==`http://${request.headers.host}`||request.headers['x-delivery-confirmed']!=='yes')return send(403,{message:'请在本机工作台确认清理操作'});
    if(request.headers['content-type']?.split(';')[0].trim()!=='application/json')return send(415,{message:'请发送 JSON'});
    try{
      const input=await io.body(request,32000);
      if(url.pathname.endsWith('/scan')){void service.scan().catch(()=>{});return send(202,service.snapshot());}
      if(url.pathname.endsWith('/clean'))return send(200,await service.clean(input));
      return send(200,await service.savePolicy(input));
    }catch(e){return send(400,{message:e instanceof Error?e.message:'空间清理操作失败'});}
  };
}
