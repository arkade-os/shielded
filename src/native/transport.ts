import {nativeUrl,NativePolicy,type NativeRoute} from './policy.ts';

export interface NativeStatus {phase:string;generation:number;progress?:string;error?:string}
export interface NativeEvent {id:string;generation:number;type:'open'|'data'|'error'|'close';data?:string;error?:string;status?:number;sequence?:number}
export interface NativeBackend {invoke:(command:string,args?:Record<string,unknown>)=>Promise<any>;channel:(receive:(event:NativeEvent)=>void)=>unknown}
interface NativeRequest {generation:number;requestId:string;scope:string;url:string;method:string;headers:[string,string][];bodyBase64?:string}
interface ScopeEntry {generation:number;users:number;pending:Promise<{id:string;generation:number}>;dispose?:boolean}
export interface MutationRequest {url:string;method:string;body?:string}
export interface NativeHandle {id:string;ready:Promise<void>;close():void;send(data:string):void}
export const encode64=(bytes:Uint8Array)=>{let result='';for(let i=0;i<bytes.length;i+=8192)result+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(result);};
export const decode64=(value:string)=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
const cancelled=()=>new DOMException('Native request was cancelled','AbortError');
const SESSION_PATH='/.shielded-native-session/';

function abortable<T>(pending:Promise<T>,signal:AbortSignal):Promise<T>{
 return new Promise((resolve,reject)=>{
  const cleanup=()=>signal.removeEventListener('abort',abort),abort=()=>{cleanup();reject(signal.reason??cancelled());};
  signal.addEventListener('abort',abort,{once:true});
  void pending.then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
  if(signal.aborted)abort();
 });
}

export function bindNativeProvider<T extends object>(provider:T,check:()=>void):T {
 const cleanup=(value:any)=>{try{void Promise.resolve(typeof value==='function'?value():value?.return?.()).catch(()=>{});}catch{}};
 const guarded=(value:any):any=>{
  if(value&&typeof value.then==='function')return value.then((result:any)=>{
   try{check();return guarded(result);}catch(error){cleanup(result);throw error;}
  });
  if(value&&typeof value.next==='function'&&typeof value[Symbol.asyncIterator]==='function'){
   return {[Symbol.asyncIterator](){return this;},async next(...args:unknown[]){try{check();const result=await value.next(...args);check();return result;}catch(error){cleanup(value);throw error;}},return:(...args:unknown[])=>value.return?.(...args)??Promise.resolve({done:true,value:undefined}),throw:(error:unknown)=>value.throw?.(error)??Promise.reject(error)};
  }
  return value;
 };
 return new Proxy(provider,{get(target,key,receiver){
  if(key==='serverUrl'||key==='baseUrl')check();
  const value=Reflect.get(target,key,receiver);
  if(typeof value!=='function')return value;
  return (...args:unknown[])=>{
   if(key==='retire'||key==='unsubscribeForScripts')return Reflect.apply(value,receiver,args);
   check();
   return guarded(Reflect.apply(value,receiver,args));
  };
 }});
}

export class NativeBridge {
 current:NativeStatus={phase:'idle',generation:0};
 beforeMutation?:(request:MutationRequest)=>void|Promise<void>;
 observeResponse?:(response:MutationRequest&{status:number;requestBody?:string})=>void;
 private scopes=new Map<string,ScopeEntry>();
 private handles=new Set<NativeHandle>();
 private listeners=new Set<(status:NativeStatus)=>void>();
 private statusRevision=0;
 private pausePending=0;
 private pauseIntent=false;
 constructor(readonly backend:NativeBackend,readonly policy:NativePolicy){}
 acceptStatus(status:NativeStatus){
  if(!Number.isSafeInteger(status.generation)||status.generation<this.current.generation)return this.current;
  if(status.generation!==this.current.generation||status.phase!=='ready'){
   for(const handle of this.handles)handle.close();
   this.scopes.clear();this.policy.clear();
  }
  this.current=status;for(const fn of this.listeners)try{fn(status);}catch{}return status;
 }
 subscribe(fn:(status:NativeStatus)=>void){this.listeners.add(fn);return()=>{this.listeners.delete(fn);};}
 async status(){
  const revision=this.statusRevision,status:NativeStatus=await this.backend.invoke('native_status');
  if(revision!==this.statusRevision||this.pausePending||this.pauseIntent)return this.current;
  if(status.phase==='ready'&&Number.isSafeInteger(status.generation)&&status.generation>=this.current.generation&&(this.current.phase!=='ready'||status.generation!==this.current.generation))++this.statusRevision;
  return this.acceptStatus(status);
 }
 async start(){
  if(this.pausePending)return this.current;
  const revision=++this.statusRevision;this.pauseIntent=false;
  try{
   const status=await this.backend.invoke('native_start');
   if(revision!==this.statusRevision||this.pausePending||this.pauseIntent)return this.current;
   ++this.statusRevision;return this.acceptStatus(status);
  }finally{if(revision===this.statusRevision)++this.statusRevision;}
 }
 async pause(){
  const revision=++this.statusRevision;this.pauseIntent=true;this.pausePending++;
  this.acceptStatus({...this.current,phase:'paused'});
  try{
   const status=await this.backend.invoke('native_pause');
   return revision===this.statusRevision?this.acceptStatus({...status,phase:'paused'}):this.current;
  }finally{if(revision===this.statusRevision)++this.statusRevision;this.pausePending--;}
 }
 private check(generation:number){if(this.current.phase!=='ready'||generation!==this.current.generation)throw new Error('Native network generation is retired or paused');}
 sessionGuard(){const generation=this.current.generation;this.check(generation);return ()=>this.check(generation);}
 bindFetch(fetcher:typeof fetch):typeof fetch {const check=this.sessionGuard();return async(input,init)=>{check();const response=await fetcher(input,init);check();return response;};}
 sessionUrl(input:string){this.check(this.current.generation);const url=nativeUrl(input,this.policy.poolOrigin);url.pathname=SESSION_PATH+this.current.generation+url.pathname.replace(/\/$/,'');return url.href;}
 private target(input:string){
  const url=nativeUrl(input,this.policy.poolOrigin);
  if(url.pathname.startsWith(SESSION_PATH)){
   const match=/^\/\.shielded-native-session\/([1-9]\d*)(\/.*)?$/.exec(url.pathname);
   if(!match||!Number.isSafeInteger(Number(match[1])))throw new Error('Invalid native session URL');
   this.check(Number(match[1]));url.pathname=match[2]??'/';
  }
  return url.href;
 }
 private async scope(route:NativeRoute,generation:number,signal?:AbortSignal){
  if(signal?.aborted)throw signal.reason??cancelled();
  this.check(generation);let entry=this.scopes.get(route.key);
  if(!entry){
   const pending=this.backend.invoke('native_scope',{generation,purpose:route.purpose}).then(scope=>{
    try{this.check(generation);if(scope.generation!==generation)throw new Error('Native scope generation mismatch');return scope;}
    catch(error){void this.backend.invoke('native_scope_close',{generation,id:scope.id}).catch(()=>{});throw error;}
   });
   entry={generation,users:0,pending};this.scopes.set(route.key,entry);void pending.catch(()=>{if(this.scopes.get(route.key)===entry)this.scopes.delete(route.key);});
  }
  this.scopes.delete(route.key);this.scopes.set(route.key,entry);entry.users++;
  const owned=entry;let released=false;
  const release=()=>{if(released)return;released=true;owned.users--;if(owned.dispose&&!owned.users)this.closeScope(route.key,owned);this.trimScopes();};
  try{return {scope:await (signal?abortable(entry.pending,signal):entry.pending),release};}
  catch(error){release();if(signal?.aborted&&!owned.users)this.closeScope(route.key,owned);throw error;}
 }
 private closeScope(key:string,entry:ScopeEntry){if(this.scopes.get(key)===entry)this.scopes.delete(key);void entry.pending.then(scope=>this.backend.invoke('native_scope_close',{generation:scope.generation,id:scope.id})).catch(()=>{});}
 private trimScopes(){for(const [key,entry] of this.scopes){if(this.scopes.size<=512)break;if(!entry.users)this.closeScope(key,entry);}}
 private async request(url:string,method:string,headers:[string,string][],body:Uint8Array|undefined,requestId:string,explicit?:NativeRoute,signal?:AbortSignal):Promise<{request:NativeRequest;release:()=>void}>{
  const generation=this.current.generation,bodyText=body&&new TextDecoder('utf-8',{fatal:true}).decode(body);
  const route=explicit??this.policy.classify(url,method,bodyText),lease=await this.scope(route,generation,signal);
  try{this.check(generation);return {request:{generation,requestId,scope:lease.scope.id,url,method,headers,...(body?.length?{bodyBase64:encode64(body)}:{})},release:lease.release};}catch(error){lease.release();throw error;}
 }
 private cancel(generation:number,id:string){void this.backend.invoke('native_cancel',{generation,id}).catch(()=>{});}
 async release(route:NativeRoute){const entry=this.scopes.get(route.key);if(!entry)return;entry.dispose=true;if(!entry.users)this.closeScope(route.key,entry);}
 async fetch(input:RequestInfo|URL,init?:RequestInit,explicit?:NativeRoute):Promise<Response>{
  const url=this.target(input instanceof Request?input.url:String(input));
  const request=new Request(url,input instanceof Request?new Request(input,init):init),id=crypto.randomUUID(),generation=this.current.generation;
  if(request.signal.aborted)throw request.signal.reason??cancelled();
  let dispatched=false;const abort=()=>{if(dispatched)this.cancel(generation,id);};request.signal.addEventListener('abort',abort,{once:true});let release:(()=>void)|undefined,oneShot:NativeRoute|undefined;
  try{
   const bytes=request.body?new Uint8Array(await request.arrayBuffer()):undefined,body=bytes&&new TextDecoder('utf-8',{fatal:true}).decode(bytes);
   const target=new URL(url);
   if(!explicit&&request.method==='GET'&&target.origin===this.policy.poolOrigin&&target.pathname==='/api/rollup/status')oneShot={...this.policy.classify(url,request.method),key:'pool-status:'+id};
   const prepared=await this.request(url,request.method,[...request.headers],bytes,id,explicit??oneShot,request.signal),native=prepared.request;release=prepared.release;
   if(request.signal.aborted)throw request.signal.reason??cancelled();
   if(request.method!=='GET'&&request.method!=='HEAD')await this.beforeMutation?.({url,method:request.method,body});
   this.check(generation);if(request.signal.aborted)throw request.signal.reason??cancelled();
   const response=await new Promise<any>((resolve,reject)=>{
    const stopped=()=>reject(request.signal.reason??cancelled());request.signal.addEventListener('abort',stopped,{once:true});
    if(request.signal.aborted){stopped();return;}
    dispatched=true;void this.backend.invoke('native_http',{request:native}).then(resolve,reject).finally(()=>request.signal.removeEventListener('abort',stopped));
   });
   this.check(generation);if(response.generation!==generation)throw new Error('Native response generation mismatch');
   if(request.signal.aborted)throw request.signal.reason??cancelled();
   const responseBytes=decode64(response.bodyBase64??''),responseBody=new TextDecoder().decode(responseBytes);
   if(response.status>=200&&response.status<300&&request.method==='POST'&&new URL(url).pathname==='/v1/indexer/script/subscribe'){
    const sent=JSON.parse(body!),received=JSON.parse(responseBody);this.policy.subscription(received.subscriptionId,sent.scripts[0],new URL(url).origin);
   }
   if(response.status>=200&&response.status<300&&request.method==='POST'&&new URL(url).pathname==='/v1/indexer/script/unsubscribe')this.policy.forgetSubscription(JSON.parse(body!).subscriptionId,new URL(url).origin);
   this.observeResponse?.({url,method:request.method,status:response.status,body:responseBody,requestBody:body});
   return new Response([101,204,205,304].includes(response.status)||request.method==='HEAD'?null:responseBytes,{status:response.status,headers:response.headers});
  }finally{request.signal.removeEventListener('abort',abort);release?.();if(oneShot)await this.release(oneShot);}
 }
 open(command:'native_stream'|'native_socket',input:string,receive:(event:NativeEvent)=>void,explicit?:NativeRoute):NativeHandle {
  const url=this.target(input),id=crypto.randomUUID(),generation=this.current.generation;
  let closed=false,dispatched=false,remote:string|undefined,release:(()=>void)|undefined;
  const finish=()=>{if(closed)return;closed=true;this.handles.delete(handle);if(dispatched){this.cancel(generation,id);if(remote&&remote!==id)this.cancel(generation,remote);}release?.();};
  const channel=this.backend.channel(event=>{
   if(closed||event.generation!==generation||this.current.phase!=='ready'||this.current.generation!==generation||remote&&event.id!==remote)return;
   remote??=event.id;try{receive(event);}catch{finish();}finally{
    if(!closed&&event.type==='data'&&Number.isSafeInteger(event.sequence)&&event.sequence!>0)void this.backend.invoke('native_stream_ack',{generation,id:event.id,sequence:event.sequence}).catch(()=>{if(!closed){receive({id:event.id,generation,type:'error',error:'Native stream acknowledgement failed'});finish();}});
    if(event.type==='close'||event.type==='error')finish();
   }
  });
  const handle:NativeHandle={id,ready:Promise.resolve(),close:finish,send:data=>{
   this.check(generation);if(closed||!remote)throw new Error('Native socket is not open');
   void this.backend.invoke('native_socket_send',{generation,id:remote,data}).catch(error=>{if(!closed){receive({id:remote!,generation,type:'error',error:String(error)});finish();}});
  }};
  this.handles.add(handle);
  handle.ready=(async()=>{
   try{
    const prepared=await this.request(url,'GET',command==='native_stream'?[['Accept','text/event-stream']]:[],undefined,id,explicit);release=prepared.release;if(closed){release();return;}
    dispatched=true;const opened=await this.backend.invoke(command,{request:prepared.request,channel});
    if(closed||this.current.generation!==generation||this.current.phase!=='ready'){this.cancel(generation,opened.id);return;}
    if(opened.generation!==generation||remote&&remote!==opened.id)throw new Error('Native stream generation or identifier mismatch');remote=opened.id;
   }catch(error){if(!closed){receive({id:remote??id,generation,type:'error',error:error instanceof Error?error.message:String(error)});finish();}}
  })();
  return handle;
 }
}

export interface SseMessage {type:string;data:string;lastEventId:string}
export class SseDecoder {
 private decoder=new TextDecoder();private text='';private data:string[]=[];private dataLength=0;private event='';private lastEventId='';
 push(bytes:Uint8Array):SseMessage[]{
  this.text+=this.decoder.decode(bytes,{stream:true});if(this.text.length>4*1024*1024)throw new Error('Native SSE frame exceeds its limit');
  const messages:SseMessage[]=[];
  for(;;){
   const index=this.text.search(/[\r\n]/);if(index<0||this.text[index]==='\r'&&index===this.text.length-1)break;
   const line=this.text.slice(0,index),width=this.text[index]==='\r'&&this.text[index+1]==='\n'?2:1;this.text=this.text.slice(index+width);
   if(!line){if(this.data.length)messages.push({type:this.event||'message',data:this.data.join('\n'),lastEventId:this.lastEventId});this.data=[];this.dataLength=0;this.event='';continue;}
   if(line[0]===':')continue;
   const colon=line.indexOf(':'),name=colon<0?line:line.slice(0,colon),raw=colon<0?'':line.slice(colon+1),value=raw.startsWith(' ')?raw.slice(1):raw;
   if(name==='data'){this.data.push(value);this.dataLength+=value.length+1;}else if(name==='event')this.event=value;else if(name==='id'&&!value.includes('\0'))this.lastEventId=value;
   if(this.dataLength>4*1024*1024)throw new Error('Native SSE event exceeds its limit');
  }
  return messages;
 }
}
