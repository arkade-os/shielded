import {awaitTransaction} from '@arkade-os/sdk';
import {IndexedDbAssetSwapRepository,type AssetSwapRepository,type LockupSpendIndexer,type SwapRecord} from '@arkade-os/swap';
import {readLockupFate} from '@arkade-os/swap/protocol';
import {hex} from '@scure/base';

export interface ConditionalSwapRepository extends AssetSwapRepository {
 saveSwapRecordIfUnchanged(expected:SwapRecord,next:SwapRecord):Promise<boolean>;
}
export class LightningSwapRepository extends IndexedDbAssetSwapRepository implements ConditionalSwapRepository {
 constructor(private readonly receiptDatabase:string){super(receiptDatabase);}
 async saveSwapRecordIfUnchanged(expected:SwapRecord,next:SwapRecord):Promise<boolean>{
  if(expected.id!==next.id)return false;
  const expectedJson=JSON.stringify(expected);
  const db=await new Promise<IDBDatabase>((resolve,reject)=>{
   const request=indexedDB.open(this.receiptDatabase);
   request.onupgradeneeded=()=>request.transaction!.abort();
   request.onerror=()=>reject(new Error('The saved Lightning receipt database could not be opened.'));
   request.onsuccess=()=>resolve(request.result);
  });
  try{
   if(db.version!==5||!db.objectStoreNames.contains('swapRecords'))throw new Error('The Lightning receipt database format changed.');
   const tx=db.transaction('swapRecords','readwrite'),done=awaitTransaction(tx),store=tx.objectStore('swapRecords');let saved=false;
   const request=store.get(expected.id);
   request.onsuccess=()=>{if(JSON.stringify(request.result)!==expectedJson)return;store.put(next);saved=true;};
   await done;return saved;
  }finally{db.close();}
 }
}

export async function repairLightningReceipt(repository:AssetSwapRepository,indexer:LockupSpendIndexer,id:string):Promise<boolean>{
 const conditional=repository as Partial<ConditionalSwapRepository>;
 if(typeof conditional.saveSwapRecordIfUnchanged!=='function')return false;
 const stored=await repository.getSwapRecord(id);
 if(!stored||stored.family!=='rfq'||stored.kind!=='lightning_send'||stored.state!=='refunded'||stored.refundTxid)return false;
 const expected=JSON.parse(JSON.stringify(stored)) as typeof stored;
 const fate=await readLockupFate(indexer,{swapPkScript:hex.decode(expected.lockupPkScript),paymentHash:expected.lock.hash});
 if(fate.fate!=='claimed')return false;
 return conditional.saveSwapRecordIfUnchanged(expected,{...expected,state:'settled',settlementPreimageHex:hex.encode(fate.preimage),
  lockupSpendTxids:[...new Set(fate.spends.flatMap(spend=>spend.txid?[spend.txid]:[]))],updatedAt:Math.max(expected.updatedAt,Math.floor(Date.now()/1000))});
}
