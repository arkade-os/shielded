export function createNativeCleanup(){
 const pending=new Set<()=>Promise<void>>();let running:Promise<void>|undefined;
 const drain=():Promise<void>=>{
  if(running)return running;
  if(!pending.size)return Promise.resolve();
  const work=(async()=>{
   while(pending.size){
    const batch=[...pending],results=await Promise.allSettled(batch.map(task=>Promise.resolve().then(task)));
    for(let i=0;i<results.length;i++)if(results[i]!.status==='fulfilled')pending.delete(batch[i]!);
    const failed=results.find(result=>result.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
   }
  })();
  running=work.finally(()=>{running=undefined;});return running;
 };
 return {drain,add(...tasks:(()=>Promise<void>)[]){for(const task of tasks)pending.add(task);return drain();}};
}
