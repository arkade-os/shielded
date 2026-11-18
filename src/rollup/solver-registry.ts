import express from 'express';

export const SOLVER_REGISTRY_URL='https://arkade-os.github.io/solver-registry/mutinynet.json';
const MAX_BYTES=128<<10,TIMEOUT_MS=10_000;

/** The Mutinynet solver registry, mirrored so a sealed wallet reads it from the pool instead of asking the gateway for a foreign host. A held copy answers at once and is refreshed behind the answer. */
export function createSolverRegistryMirror({url=SOLVER_REGISTRY_URL,fetch:send=fetch,now=Date.now,freshMs=5*60_000,staleMs=24*60*60_000,warn=(message:string)=>console.warn(message)}:{url?:string;fetch?:typeof fetch;now?:()=>number;freshMs?:number;staleMs?:number;warn?:(message:string)=>void}={}){
 let held:{body:Buffer;at:number}|undefined,pending:Promise<void>|undefined;
 const read=async()=>{
  const response=await send(url,{redirect:'error',signal:AbortSignal.timeout(TIMEOUT_MS),headers:{accept:'application/json'}});
  if(!response.ok||!response.body)throw new Error(`HTTP ${response.status}`);
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  for(;;){const {done,value}=await reader.read();if(done)break;if((size+=value.length)>MAX_BYTES){await reader.cancel();throw new Error(`larger than ${MAX_BYTES} bytes`);}chunks.push(value);}
  const body=Buffer.concat(chunks),index=JSON.parse(body.toString('utf8'));
  // Only the shape: the wallet's discovery client validates the index itself.
  if(!index||typeof index!=='object'||!Array.isArray(index.markets)||index.solvers!==undefined&&!Array.isArray(index.solvers))throw new Error('not a solver registry index');
  held={body,at:now()};
 };
 const refresh=()=>pending??=read().catch(error=>warn(`Solver registry mirror: ${error instanceof Error?error.message:String(error)}`)).finally(()=>{pending=undefined;});
 const router=express.Router();
 router.get('/solver-registry',async(_req,res)=>{
  if(!held)await refresh();else if(now()-held.at>=freshMs)void refresh();
  res.setHeader('Cache-Control','no-store');
  if(!held||now()-held.at>=staleMs){res.status(503).json({error:'The solver registry is unavailable.'});return;}
  res.setHeader('Content-Type','application/json').end(held.body);
 });
 return router;
}
