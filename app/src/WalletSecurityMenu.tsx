export type WalletSecurityView='phrase'|'viewing'|'clear';

export function WalletSecurityMenu({canReveal,canClear,onOpen}:{canReveal:boolean;canClear:boolean;onOpen:(view:WalletSecurityView)=>void}){
 return <div className="stock-security-menu">
  {canReveal&&<button type="button" className="stock-security-choice" onClick={()=>onOpen('phrase')}><strong>Recovery phrase</strong><small>Back up or reveal your words</small><span aria-hidden="true">›</span></button>}
  <button type="button" className="stock-security-choice" onClick={()=>onOpen('viewing')}><strong>Viewing access</strong><small>Share read-only wallet history</small><span aria-hidden="true">›</span></button>
  {canClear&&<button type="button" className="stock-security-choice stock-security-danger" onClick={()=>onOpen('clear')}><strong>Clear wallet</strong><small>Remove this wallet from this device</small><span aria-hidden="true">›</span></button>}
 </div>;
}

export function WalletCreatedNotice({created}:{created:number}){
 if(!created)return null;
 return <p className="stock-muted">Created {new Date(created).toLocaleDateString()}. Keep the date with the words: a restore that has it skips the pool&apos;s older history.</p>;
}
