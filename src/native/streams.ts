import type {NativeRoute} from './policy.ts';
import {decode64,NativeBridge,SseDecoder,type NativeHandle} from './transport.ts';

export class NativeEventSource extends EventTarget {
 static readonly CONNECTING=0;static readonly OPEN=1;static readonly CLOSED=2;
 readonly CONNECTING=0;readonly OPEN=1;readonly CLOSED=2;readyState=0;readonly withCredentials=false;
 onopen:((event:Event)=>void)|null=null;onmessage:((event:MessageEvent)=>void)|null=null;onerror:((event:Event)=>void)|null=null;
 private handle:NativeHandle;private off:()=>void;
 constructor(readonly url:string,bridge:NativeBridge){
  super();const decoder=new SseDecoder(),generation=bridge.current.generation;
  this.off=bridge.subscribe(status=>{if(status.generation!==generation||status.phase!=='ready')this.failure('Native network generation retired');});
  this.handle=bridge.open('native_stream',url,event=>{
   if(this.readyState===2)return;
   if(event.type==='open'){if(event.status!==undefined&&(event.status<200||event.status>=300)){this.failure('The event stream returned HTTP '+event.status);return;}this.readyState=1;const opened=new Event('open');this.dispatchEvent(opened);this.onopen?.(opened);}
   else if(event.type==='data'){
    try{for(const frame of decoder.push(decode64(event.data??''))){const message=new MessageEvent(frame.type,{data:frame.data,lastEventId:frame.lastEventId,origin:new URL(url).origin});this.dispatchEvent(message);if(frame.type==='message')this.onmessage?.(message);}}
    catch(error){this.failure(error instanceof Error?error.message:String(error));}
   }else this.failure(event.error??'The native event stream closed');
  });
 }
 private failure(message:string){const event=new MessageEvent('error',{data:message});this.dispatchEvent(event);this.onerror?.(event);this.close();}
 override addEventListener(type:'message'|'error'|'failure',listener:(event:MessageEvent)=>void):void;
 override addEventListener(type:string,listener:EventListenerOrEventListenerObject|null,options?:boolean|AddEventListenerOptions):void;
 override addEventListener(type:string,listener:EventListenerOrEventListenerObject|((event:MessageEvent)=>void)|null,options?:boolean|AddEventListenerOptions){super.addEventListener(type,listener as EventListener,options);}
 override removeEventListener(type:'message'|'error'|'failure',listener:(event:MessageEvent)=>void):void;
 override removeEventListener(type:string,listener:EventListenerOrEventListenerObject|null,options?:boolean|EventListenerOptions):void;
 override removeEventListener(type:string,listener:EventListenerOrEventListenerObject|((event:MessageEvent)=>void)|null,options?:boolean|EventListenerOptions){super.removeEventListener(type,listener as EventListener,options);}
 close(){if(this.readyState===2)return;this.readyState=2;this.off();this.handle.close();}
}
export class NativeWebSocket extends EventTarget {
 static readonly CONNECTING=0;static readonly OPEN=1;static readonly CLOSING=2;static readonly CLOSED=3;
 readonly CONNECTING=0;readonly OPEN=1;readonly CLOSING=2;readonly CLOSED=3;
 readyState=0;bufferedAmount=0;binaryType:BinaryType='blob';readonly extensions='';readonly protocol='';
 onopen:((event:Event)=>void)|null=null;onmessage:((event:MessageEvent)=>void)|null=null;onerror:((event:Event)=>void)|null=null;onclose:((event:CloseEvent)=>void)|null=null;
 private handle:NativeHandle;private off:()=>void;
 constructor(readonly url:string,bridge:NativeBridge,route?:NativeRoute,protocols?:string|string[]){
  super();if(typeof protocols==='string'?protocols.length:protocols?.length)throw new Error('Native WebSocket subprotocols are not supported');
  const generation=bridge.current.generation;
  this.off=bridge.subscribe(status=>{if(status.generation!==generation||status.phase!=='ready')this.close(1001,'Network paused');});
  this.handle=bridge.open('native_socket',url,event=>{
   if(this.readyState>=2)return;
   if(event.type==='open'){this.readyState=1;const opened=new Event('open');this.dispatchEvent(opened);this.onopen?.(opened);}
   else if(event.type==='data'){const message=new MessageEvent('message',{data:event.data??'',origin:new URL(url).origin});this.dispatchEvent(message);this.onmessage?.(message);}
   else if(event.type==='error'){const error=new Event('error');this.dispatchEvent(error);this.onerror?.(error);this.close(1006,event.error??'Native socket error');}
   else this.close(1000,'');
  },route);
 }
 send(data:string|ArrayBufferLike|Blob|ArrayBufferView){if(this.readyState!==1)throw new DOMException('Native WebSocket is not open','InvalidStateError');if(typeof data!=='string')throw new TypeError('Native WebSocket supports text messages only');this.handle.send(data);}
 close(code=1000,reason=''){
  if(this.readyState>=2)return;this.readyState=3;this.off();this.handle.close();
  const event=typeof CloseEvent==='function'?new CloseEvent('close',{code,reason,wasClean:code===1000}):Object.assign(new Event('close'),{code,reason,wasClean:code===1000}) as CloseEvent;
  this.dispatchEvent(event);this.onclose?.(event);
 }
}
