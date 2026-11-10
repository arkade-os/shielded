export default function WalletSyncStatus({privateReady,error,onRetry}:{privateReady:boolean;arkReady?:boolean;error:string;onRetry?:()=>void}){
 if(privateReady&&!error)return null;
 return <div className="stock-sync-status" role="status" aria-live="polite">
  <span className="stock-balance-state">{error?'Recovering wallet data…':'Syncing your private balance…'}</span>
  {error&&onRetry&&<button type="button" className="stock-ghost stock-mini" onClick={onRetry}>Retry connection</button>}
 </div>;
}
