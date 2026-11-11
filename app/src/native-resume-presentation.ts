export interface NativeResumeActivity {
 title:string;
 detail?:string;
 amount?:string;
}

export interface NativeResumeSnapshot {
 balance:string;
 unshielded?:string;
 activity:readonly NativeResumeActivity[];
}

export const NATIVE_RESUME_GRACE_MS=30_000;
const text=(value:unknown,limit=160)=>typeof value==='string'?value.slice(0,limit):'';
export function createNativeResumePresentation(now:()=>number=()=>performance.now()){
 let latest:NativeResumeSnapshot|undefined,frozen:NativeResumeSnapshot|undefined,deadline=0,ticket=0,requested=false,delivery:number|undefined;
 const clear=()=>{latest=undefined;frozen=undefined;deadline=0;requested=false;delivery=undefined;};
 const expire=(expected=ticket)=>{if(expected===ticket&&deadline&&now()>=deadline)clear();};
 return {
  get ticket(){return ticket;},
  get remaining(){expire();return deadline?Math.max(0,deadline-now()):0;},
  get snapshot(){expire();return frozen;},
  remember(value:NativeResumeSnapshot){latest=Object.freeze({balance:text(value.balance,80),...(value.unshielded===undefined?{}:{unshielded:text(value.unshielded,80)}),activity:Object.freeze(value.activity.slice(0,3).map(row=>Object.freeze({title:text(row.title),...(row.detail===undefined?{}:{detail:text(row.detail)}),...(row.amount===undefined?{}:{amount:text(row.amount,80)})})))});},
  scanner(value:boolean){requested=value;if(!value)delivery=undefined;},
  freeze(){expire();if(deadline)return;deadline=now()+NATIVE_RESUME_GRACE_MS;frozen=latest;ticket++;if(requested)delivery=ticket;},
  delivery(){expire();return delivery;},
  acknowledge(value:number){expire();if(delivery===value){delivery=undefined;if(!frozen)deadline=0;}},
  promote(){expire();frozen=undefined;latest=undefined;if(delivery===undefined)deadline=0;},
  expire,clear,
 };
}
