import type {ReactNode} from 'react';
import type {NativeResumeSnapshot} from './native-resume-presentation.ts';

export default function NativeResumePresentation({snapshot,phase,error,controls}:{snapshot:NativeResumeSnapshot;phase:string;error:string;controls?:ReactNode}){
 return <div className="stock-page has-dock" aria-busy="true"><main className="stock-shell">
  <header className="stock-header"><strong>Shielded <small>wallet</small></strong>{controls}</header>
  <p className="stock-muted">Mutinynet · Test funds only</p>
  <section className="stock-card stock-balance"><div className="stock-balance-main"><small>Last known private balance</small><strong>{snapshot.balance}</strong><p className="stock-muted" role="status"><span className="stock-spinner" aria-hidden="true"/> {phase}</p></div>{snapshot.unshielded&&<div className="stock-balance-side"><small>Unshielded</small><b>{snapshot.unshielded}</b></div>}</section>
  {error&&<p className="stock-blocked" role="alert">{error}</p>}
  <section className="stock-card stock-history stock-history-preview"><h2>Recent activity</h2>{snapshot.activity.length?<ul>{snapshot.activity.map((row,index)=><li key={index}><span>{row.title}</span>{row.amount&&<b>{row.amount}</b>}{row.detail&&<small>{row.detail}</small>}</li>)}</ul>:<p className="stock-muted">No recent activity</p>}</section>
  <p className="stock-muted">Refreshing your wallet. Payments become available when it is ready.</p>
  <nav className="stock-tabs stock-main-tabs" aria-label="Wallet sections">{['Home','Activity','Receive','Send'].map(label=><button key={label} type="button" disabled>{label}</button>)}</nav>
 </main></div>;
}
