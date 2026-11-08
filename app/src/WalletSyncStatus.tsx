export default function WalletSyncStatus({privateReady,arkReady,error,onRetry}:{privateReady:boolean;arkReady:boolean;error:string;onRetry?:()=>void}){
 if(privateReady&&arkReady&&!error)return null;
 return <div className="stock-sync-status" role="status" aria-live="polite">
  <span className="stock-balance-state">{error?'Recovering wallet data…':privateReady?'Checking your Arkade balance…':'Syncing your private balance…'}</span>
  {error&&onRetry&&<button type="button" className="stock-ghost stock-mini" onClick={onRetry}>Retry connection</button>}
 </div>;
}
