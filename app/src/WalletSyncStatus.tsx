export default function WalletSyncStatus({privateReady,arkReady,error,onRetry}:{privateReady:boolean;arkReady:boolean;error:string;onRetry:()=>void}){
 if(privateReady&&arkReady&&!error)return null;
 return <div className="stock-sync-status" role="status" aria-live="polite">
  <span className="stock-balance-state">{error?'Wallet services need attention':privateReady?'Checking your Arkade balance…':'Syncing your private balance…'}</span>
  {error&&<button type="button" className="stock-ghost stock-mini" onClick={onRetry}>Retry connection</button>}
 </div>;
}
