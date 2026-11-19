import {useEffect,useRef} from 'react';
import {CopyButton} from './components.tsx';
import './native-connection-warning.css';

export default function NativeConnectionWarning({onCancel,onConfirm}:{onCancel:()=>void;onConfirm:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{const node=dialog.current;if(node&&!node.open)node.showModal();return()=>node?.close();},[]);
 return <dialog ref={dialog} className="native-connection-warning" aria-labelledby="direct-connection-title" aria-describedby="direct-connection-detail" onCancel={event=>{event.preventDefault();onCancel();}}>
  <span className="native-connection-warning-eyebrow">Network privacy</span>
  <h2 id="direct-connection-title">Turn off Tor?</h2>
  <p id="direct-connection-detail">Wallet services will see your IP address. Your network and DNS provider can see which services you contact. Separate Tor circuits will no longer protect unrelated wallet items.</p>
  <p>Your wallet will reconnect directly. Tor stays off, even after you restart Shielded, until you turn it back on.</p>
  <div><button type="button" autoFocus onClick={onCancel}>Keep Tor on</button><button type="button" className="native-connection-confirm" onClick={onConfirm}>Turn off Tor and reconnect</button></div>
 </dialog>;
}

/** Modal, so the top layer holds it above an open wallet sheet, which covers anything rendered in the page. */
export function NativeExternalLink({url,onClose}:{url:string;onClose:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{const node=dialog.current;if(node&&!node.open)node.showModal();return()=>node?.close();},[]);
 // Escape must close only this prompt, not the sheet listening on window behind it.
 return <dialog ref={dialog} className="native-connection-warning" aria-labelledby="external-link-title" onCancel={event=>{event.preventDefault();onClose();}} onKeyDown={event=>{if(event.key==='Escape')event.stopPropagation();}}>
  <h2 id="external-link-title">Open outside Shielded</h2>
  <p>Copy this link to open it in your browser. Your browser uses its own network connection.</p>
  <code className="native-external-link">{url}</code>
  <div><CopyButton value={url} label="Copy link"/><button type="button" className="native-connection-confirm" onClick={onClose}>Close</button></div>
 </dialog>;
}
