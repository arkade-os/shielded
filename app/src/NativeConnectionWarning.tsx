import {useEffect,useRef} from 'react';
import './native-connection-warning.css';

export default function NativeConnectionWarning({onCancel,onConfirm}:{onCancel:()=>void;onConfirm:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{const node=dialog.current;if(node&&!node.open)node.showModal();return()=>node?.close();},[]);
 return <dialog ref={dialog} className="native-connection-warning" aria-labelledby="direct-connection-title" aria-describedby="direct-connection-detail" onCancel={event=>{event.preventDefault();onCancel();}}>
  <span className="native-connection-warning-eyebrow">Network privacy</span>
  <h2 id="direct-connection-title">Turn off Tor?</h2>
  <p id="direct-connection-detail">Wallet services will see your IP address. Your network and DNS provider can see which services you contact. Separate Tor circuits will no longer protect unrelated wallet items.</p>
  <p>Your wallet will reconnect directly for this app session. Tor starts again the next time you launch Shielded.</p>
  <div><button type="button" autoFocus onClick={onCancel}>Keep Tor on</button><button type="button" className="native-connection-confirm" onClick={onConfirm}>Turn off Tor and reconnect</button></div>
 </dialog>;
}
