import {isPageBusy} from './shielded-page.ts';

export default function WalletSyncStatus({privateReady,error,onRetry}:{privateReady:boolean;arkReady?:boolean;error:string;onRetry?:()=>void}){
 if(privateReady&&!error)return null;
 // A rate limit is a wait, not a loss: the saved balance beside it is still the right number, and there is nothing to retry by hand.
 const busy=isPageBusy(error);
 return <div className="stock-sync-status" role="status" aria-live="polite">
  <span className="stock-balance-state">{busy?error:error?'Recovering wallet data…':'Syncing your private balance…'}</span>
  {error&&!busy&&onRetry&&<button type="button" className="stock-ghost stock-mini" onClick={onRetry}>Retry connection</button>}
 </div>;
}
