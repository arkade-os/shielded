import {useState} from 'react';
import {shortValue} from './rollup-client.ts';
import {CONTACT_PRIVACY,RECENTS_LINE,clearRecents,deleteContact,saveContact,setRecentsOn,CONTACT_NOT_SAVED} from './wallet-contacts.ts';
import type {Contact,Recent} from './wallet-contacts.ts';

type Store=Pick<Storage,'getItem'|'setItem'|'removeItem'>;

export function ContactsCard({storage,contacts,recents,recentsOn,onChange}:{storage:Store;contacts:Contact[];recents:Recent[];recentsOn:boolean;onChange:()=>void}){
 const [name,setName]=useState(''),[address,setAddress]=useState(''),[editing,setEditing]=useState<string>(),[confirm,setConfirm]=useState<string>(),[error,setError]=useState('');
 const reset=()=>{setName('');setAddress('');setEditing(undefined);setError('');};
 const done=(ok:boolean)=>{if(ok){setError('');onChange();}else setError(CONTACT_NOT_SAVED);return ok;};
 const submit=()=>{
  const failed=saveContact(storage,{name,address},editing);
  if(failed)return setError(failed);
  reset();onChange();
 };
 return <details className="stock-card stock-advanced"><summary>Contacts</summary>
  <p className="stock-muted">{CONTACT_PRIVACY}</p>
  {contacts.length===0?<p className="stock-muted">No contacts yet.</p>:<div className="stock-notes">
   {contacts.map(c=><div key={c.address}><span>{c.name}</span><span className="stock-muted">{shortValue(c.address)}</span>
    <div className="stock-actions">
     <button type="button" className="stock-ghost stock-mini" onClick={()=>{setEditing(c.address);setName(c.name);setAddress(c.address);setError('');setConfirm(undefined);}}>Edit</button>
     {confirm===c.address
      ?<><button type="button" className="stock-danger stock-mini" onClick={()=>{setConfirm(undefined);if(done(deleteContact(storage,c.address))&&editing===c.address)reset();}}>Delete “{c.name}”</button><button type="button" className="stock-ghost stock-mini" onClick={()=>setConfirm(undefined)}>Keep</button></>
      :<button type="button" className="stock-ghost stock-mini" onClick={()=>setConfirm(c.address)}>Delete</button>}
    </div></div>)}
  </div>}
  <form className="stock-send" onSubmit={e=>{e.preventDefault();submit();}}>
   <label>Name<input value={name} onChange={e=>{setName(e.target.value);setError('');}} autoComplete="off"/></label>
   <label>Address<input value={address} onChange={e=>{setAddress(e.target.value);setError('');}} autoComplete="off" spellCheck={false}/></label>
   {error&&<p className="stock-blocked" role="alert">{error}</p>}
   <div className="stock-actions"><button type="submit" className="stock-ghost stock-mini">{editing===undefined?'Save contact':'Save changes'}</button>{editing!==undefined&&<button type="button" className="stock-ghost stock-mini" onClick={reset}>Cancel</button>}</div>
  </form>
  <label><input type="checkbox" checked={recentsOn} onChange={e=>done(setRecentsOn(storage,e.target.checked))}/>Remember recent payees</label>
  {recentsOn&&<p className="stock-muted">{RECENTS_LINE}</p>}
  {recents.length>0&&<button type="button" className="stock-ghost stock-mini" onClick={()=>done(clearRecents(storage))}>Clear recents</button>}
 </details>;
}

export function ContactPicker({contacts,recents,onPick}:{contacts:Contact[];recents:Recent[];onPick:(address:string)=>void}){
 if(contacts.length===0&&recents.length===0)return null;
 return <select aria-label="Pay a contact" defaultValue="" onChange={e=>{onPick(e.target.value);e.target.value='';}}>
  <option value="" disabled>Contacts</option>
  {contacts.length>0&&<optgroup label="Saved">{contacts.map(c=><option key={c.address} value={c.address}>{c.name} · {shortValue(c.address)}</option>)}</optgroup>}
  {recents.length>0&&<optgroup label="Recent">{recents.map(r=><option key={r.address} value={r.address}>{shortValue(r.address)}</option>)}</optgroup>}
 </select>;
}

export function SaveContactOffer({address,storage,onSaved,onDismiss}:{address:string;storage:Store;onSaved:()=>void;onDismiss:()=>void}){
 const [name,setName]=useState(''),[error,setError]=useState('');
 return <form className="stock-send" onSubmit={e=>{e.preventDefault();const failed=saveContact(storage,{name,address});if(failed)setError(failed);else onSaved();}}>
  <p className="stock-muted">Save {shortValue(address)} as a contact?</p>
  <input aria-label="Contact name" value={name} onChange={e=>{setName(e.target.value);setError('');}} placeholder="Name" autoComplete="off"/>
  {error&&<p className="stock-blocked" role="alert">{error}</p>}
  <div className="stock-actions"><button type="submit" className="stock-ghost stock-mini">Save</button><button type="button" className="stock-ghost stock-mini" onClick={onDismiss}>Not now</button></div>
 </form>;
}
