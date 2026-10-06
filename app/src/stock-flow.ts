import {ArkAddress} from '@arkade-os/sdk';
import {hex} from '@scure/base';

export type Recipient={kind:'wallet';owner:string}|{kind:'arkade';address:string;program:string};
export function parseRecipient(input:string,{self,serverKey,participants}:{self:string;serverKey:string;participants:Record<string,unknown>}):Recipient{
 const value=input.trim();
 if(/^[0-9a-f]{64}$/i.test(value)){
  const owner=value.toLowerCase();
  if(owner===self)throw new Error('That is your own wallet ID.');
  if(!Object.hasOwn(participants,owner))throw new Error('This wallet ID is not registered with this pool.');
  return {kind:'wallet',owner};
 }
 let decoded:ArkAddress;
 try{decoded=ArkAddress.decode(value);}catch{throw new Error('Enter a shielded wallet ID or an Arkade address.');}
 if(decoded.hrp!=='tark')throw new Error('Only Mutinynet Arkade addresses (tark1…) are supported.');
 if(hex.encode(decoded.serverPubKey)!==serverKey)throw new Error('This Arkade address belongs to a different Arkade server.');
 return {kind:'arkade',address:value,program:hex.encode(decoded.vtxoTaprootKey)};
}
export function autoShieldCoins<T extends {amount:number;funding:{txid:string}}>(coins:T[],history:{receipt:{txid:string}}[]):T[]{
 const payouts=new Set(history.map(entry=>entry.receipt.txid));
 return coins.filter(coin=>!payouts.has(coin.funding.txid)).sort((a,b)=>b.amount-a.amount);
}
export function noteSummary(notes:{amount:number;spent:boolean;spendable:boolean}[]){
 const live=notes.filter(note=>!note.spent),sealed=live.filter(note=>note.spendable),sum=(list:{amount:number}[])=>list.reduce((total,note)=>total+note.amount,0);
 return {spendable:sum(sealed),sealing:sum(live)-sum(sealed),maxSendable:Math.max(0,...sealed.map(note=>note.amount)),maxAfterSeal:Math.max(0,...live.map(note=>note.amount))};
}
export function sealedAfter(history:{operation:string;prepared?:{id:string}}[],id:string){
 const index=history.findIndex(entry=>entry.prepared?.id===id);
 return index>=0&&history.slice(index+1).some(entry=>entry.operation==='seal');
}
