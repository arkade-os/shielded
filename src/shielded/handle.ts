import {makeHandle,type PaymentHandle,type PaymentStatus,type RouteResult} from '@arkade-os/sdk';

export interface StepState {title:string;steps:readonly string[];current:number;done?:boolean;error?:string}
export interface ShieldedPaymentHandle extends PaymentHandle {readonly title:string;readonly steps:readonly string[];stepState():StepState;subscribeSteps(fn:(s:StepState)=>void):()=>void}
export const isShieldedHandle=(h:PaymentHandle):h is ShieldedPaymentHandle=>typeof (h as ShieldedPaymentHandle).subscribeSteps==='function';

/**
 * A real SDK handle, plus the step stream the status sheet renders. The SDK's update shape carries no label, so
 * the steps ride beside it rather than inside an `as`-cast update.
 */
export function shieldedHandle(o:{id?:string;title:string;steps:readonly string[];railId:string},run:(step:(n:number)=>void)=>Promise<{txid?:string}>):ShieldedPaymentHandle{
 let state:StepState={title:o.title,steps:o.steps,current:0};
 const watchers=new Set<(s:StepState)=>void>();
 // A throwing listener must not fail the action; makeHandle swallows subscriber errors the same way.
 const set=(next:Partial<StepState>)=>{state={...state,...next};for(const fn of [...watchers])try{fn(state)}catch{}};
 const step=(current:number)=>set({current});
 const id=o.id??`${o.railId}:${Date.now().toString(36)}-${Math.trunc(Math.random()*1e6)}`;
 const handle=makeHandle(id,async emit=>{
  let out:{txid?:string};try{out=await run(step)}catch(e){set({error:e instanceof Error?e.message:String(e)});throw e;}
  const result:RouteResult={railId:o.railId,...out};
  set({current:o.steps.length-1,done:true});
  // An SDK handle's status only moves through emit, and the rails emit their own terminal update.
  emit({status:'settled',result});
  return result;
 });
 return Object.assign(handle,{title:o.title,steps:o.steps,stepState:()=>state,
  subscribeSteps:(fn:(s:StepState)=>void)=>{watchers.add(fn);try{fn(state)}catch{}return()=>{watchers.delete(fn);};}});
}

const PLAIN:Record<Exclude<PaymentStatus,'failed'>,number>={pending:0,sent:1,settled:2};
/**
 * One way for the page to render any handle. A shielded handle streams its own labelled steps; an `ark`,
 * `ark-asset` or `onchain` quote returns a plain SDK handle, which gets one step per status instead.
 */
export function watchHandle(handle:PaymentHandle,title:string,onState:(s:StepState)=>void):()=>void{
 if(isShieldedHandle(handle))return handle.subscribeSteps(onState);
 const steps=['Submit the payment','Wait for the operator','Sent'] as const;
 let at=0;
 return handle.subscribe(u=>{
  if(u.status!=='failed')at=PLAIN[u.status];
  onState({title,steps,current:at,...(u.status==='settled'?{done:true}:{}),
   ...(u.status==='failed'?{error:u.error instanceof Error?u.error.message:typeof u.error==='string'?u.error:'The payment failed.'}:{})});
 });
}
