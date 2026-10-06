import {useEffect,useState} from 'react';

export type StockSetup={version:1;phase:'starting'|'qualifying'|'waiting-funds'|'bootstrapping'|'recovering'|'ready'|'blocked';network:'mutinynet';fundingAddress?:string;minimumFundingSats:660;releaseFingerprint?:string;message?:string;qualification?:{stage:string;completed?:number;total?:number;startedAt?:string;updatedAt?:string}};
export function stockSetupPresentation(setup?:StockSetup,error?:string){
 const titles={starting:'Starting the pool',qualifying:'Checking the network and proof verifier','waiting-funds':'Waiting for initial pool funding',bootstrapping:'Creating the pool',recovering:'Recovering the saved pool',ready:'Pool initialized',blocked:'Pool setup needs attention'};
 const details={starting:'The service is starting.',qualifying:'The service is verifying that this network can run the pool safely. Customer wallets are not available yet.','waiting-funds':'The network checks passed. The operator must fund the initial pool before customer wallets can be used.',bootstrapping:'The service is creating the initial pool transaction.',recovering:'The service is checking its saved transaction history.',ready:'The pool is initialized. Your wallet will verify its archive before using it.',blocked:'The service could not complete setup. Check the operator logs before continuing.'};
 const progress=setup?.qualification;
 const stages:Record<string,string>={preparing:'Preparing proof checks','native-paths':'Verifying transaction paths',cached:'Previously verified checks'};
 return {title:setup?titles[setup.phase]:'Checking pool availability',detail:error?`Could not refresh pool status: ${error}. Retrying automatically.`:setup?.message??(setup?details[setup.phase]:'Contacting the service. Customer wallets become available after pool setup completes.'),funding:setup?.phase==='waiting-funds'&&!!setup.fundingAddress,progress:setup?.phase==='qualifying'&&progress?{...progress,stage:stages[progress.stage]??'Running proof checks'}:undefined};
}
export function stockWalletStatus(setup:StockSetup|undefined,supported:boolean|undefined,profile?:{proofSystem:string;setup:string;blockedReason:string},profileError?:string,archiveVerified=false){
 if(supported!==false&&setup?.phase!=='ready')return undefined;
 if(profileError)return {proof:'Unavailable',setup:'Could not load pool details',state:profileError};
 if(!profile)return {proof:'Waiting for pool details',setup:'Loading initialized pool',state:'Your wallet has not verified the pool archive yet.'};
 return {proof:profile.proofSystem,setup:profile.setup,state:profile.blockedReason||(archiveVerified?'Pool archive verified by this wallet.':'Pool initialized. Unlock or create a wallet to verify its archive.')};
}
export function useStockSetup(){
 const [setup,setSetup]=useState<StockSetup>(),[supported,setSupported]=useState<boolean>(),[error,setError]=useState<string>();
 useEffect(()=>{
  let stopped=false,timer:ReturnType<typeof setTimeout>|undefined,request:AbortController|undefined;
  const poll=async()=>{
   request=new AbortController();const timeout=setTimeout(()=>request?.abort(),15000);
   try{
    const response=await fetch('/api/setup',{cache:'no-store',signal:request.signal});
    if(response.status===404){if(!stopped){setError(undefined);setSupported(false);}return;}
    if(!response.ok)throw new Error(`HTTP ${response.status}`);
    const value=await response.json() as StockSetup;
    if(value.version!==1||value.network!=='mutinynet'||!['starting','qualifying','waiting-funds','bootstrapping','recovering','ready','blocked'].includes(value.phase))throw new Error('The service returned an invalid pool status');
    if(stopped)return;setError(undefined);setSupported(true);setSetup(value);
    timer=setTimeout(()=>void poll(),8000);
   }catch(cause){if(!stopped){setError(request.signal.aborted?'The service did not respond within 15 seconds':(cause as Error).message);timer=setTimeout(()=>void poll(),8000);}}
   finally{clearTimeout(timeout);}
  };
  void poll();return()=>{stopped=true;request?.abort();if(timer)clearTimeout(timer);};
 },[]);
 return {setup,supported,error};
}
