import {CopyButton} from './components.tsx';

export type WalletSecurityView='phrase'|'viewing'|'clear';

export function WalletSecurityMenu({canReveal,canClear,onOpen}:{canReveal:boolean;canClear:boolean;onOpen:(view:WalletSecurityView)=>void}){
 return <div className="stock-security-menu">
  {canReveal&&<button type="button" className="stock-security-choice" onClick={()=>onOpen('phrase')}><strong>Recovery phrase</strong><small>Back up or reveal your words</small><span aria-hidden="true">›</span></button>}
  <button type="button" className="stock-security-choice" onClick={()=>onOpen('viewing')}><strong>Viewing access</strong><small>Share read-only wallet history</small><span aria-hidden="true">›</span></button>
  {canClear&&<button type="button" className="stock-security-choice stock-security-danger" onClick={()=>onOpen('clear')}><strong>Clear wallet</strong><small>Remove this wallet from this device</small><span aria-hidden="true">›</span></button>}
 </div>;
}

export function WalletPhrase({phrase}:{phrase:string}){
 return <><ol className="stock-words">{phrase.split(' ').map((word,i)=><li key={i}>{word}</li>)}</ol><CopyButton value={phrase}/></>;
}

export function WalletBackupCard({words,phrase,reveal,error,onReveal,onSaved}:{words:number;phrase:string;reveal:boolean;error?:string;onReveal:()=>void;onSaved:()=>void}){
 return <section className="stock-card stock-recovery"><h2>Save your recovery phrase</h2><p className="stock-muted">{`These ${words} words restore your pool notes and Arkade keys. Anyone with them can spend your funds.`}</p><details className="stock-more"><summary>Before you switch devices</summary><p className="stock-muted">Keep this browser&apos;s data until pending Lightning swaps and their payouts have finished. The phrase alone does not restore every outstanding swap.</p></details>{reveal&&<WalletPhrase phrase={phrase}/>}{error&&<p className="stock-blocked" role="alert">{error}</p>}<div className="stock-actions">{!reveal&&<button onClick={onReveal}>Show phrase</button>}<button className="stock-ghost" onClick={onSaved}>I saved it</button></div></section>;
}

export function WalletCreatedNotice({created}:{created:number}){
 if(!created)return null;
 return <p className="stock-muted">Created {new Date(created).toLocaleDateString()}. Keep the date with the words: a restore that has it skips the pool&apos;s older history.</p>;
}
