import {RestEmulatorProvider,RestIndexerProvider} from '@arkade-os/sdk';
import {assertStockWeightBudget,type StockNetworkInfo} from '../stock/network.ts';
import {createStockMutinynetTransport,stockSignedWeights,verifyStockCustomerSignatures,verifyStockResponse} from '../stock/transport.ts';
import type {RollupDepositFacts,RollupTransport} from './epoch-operator.ts';

const holdings=(assets:readonly {assetId:string;amount:bigint}[])=>assets.map(a=>`${a.assetId}:${a.amount}`).sort().join(',');

/** The emulator answers only after arkd finalizes, retrying that for up to two minutes, yet arkd indexes the batch within seconds; a losing call simply runs out. */
export function landedOrAnswered<T>(answer:Promise<T>,landed:()=>Promise<T|undefined>,everyMs=2000):Promise<T>{
 return new Promise<T>((resolve,reject)=>{
  let done=false;
  answer.then(value=>{done=true;resolve(value);},error=>{done=true;reject(error);});
  void (async()=>{
   while(!done){
    await new Promise(r=>setTimeout(r,everyMs));
    if(done)return;
    const found=await landed().catch(()=>undefined);
    if(found!==undefined&&!done){done=true;resolve(found);}
   }
  })();
 });
}

/** Only the emulator's own error body is a refusal; a dead link or a proxy's error page says nothing about the batch. */
export const emulatorRefused=(error:unknown)=>error instanceof Error&&/^Failed to submit tx to emulator: \{"code":\d+/.test(error.message);

/** Batches go through the Arkade emulator; the rollup pays up to the operator's own weight limit, not the stock profile's. */
export function createRollupTransport(network:StockNetworkInfo,providers:{emulator?:Pick<RestEmulatorProvider,'submitTx'>;indexer?:Pick<RestIndexerProvider,'getVirtualTxs'|'getVtxos'>}={}):RollupTransport&{fresh(coin:RollupDepositFacts,floorMs:number):Promise<boolean>} {
 const rollup={...network,weightLimit:network.operatorMaxWeight};
 const stock=createStockMutinynetTransport(rollup,providers);
 const emulator=providers.emulator??new RestEmulatorProvider(network.emulatorUrl),indexer=providers.indexer??new RestIndexerProvider(network.indexerUrl??network.arkUrl);
 const coinOf=async(coin:{txid:string;vout:number})=>(await indexer.getVtxos({outpoints:[coin]})).vtxos.find(v=>v.txid===coin.txid&&v.vout===coin.vout);
 const live=(v:Awaited<ReturnType<typeof coinOf>>)=>!!v&&!v.isSpent&&!v.isSwept&&!v.isUnrolled;
 return {
  lookup:stock.lookup,
  verify:(request,receipt)=>{if(JSON.stringify(verifyStockResponse(request,receipt,rollup))!==JSON.stringify(receipt))throw new Error('Rollup acceptance receipt is inconsistent.');},
  submit:async(request,firstDeposit)=>{
   assertStockWeightBudget(rollup,stockSignedWeights(request,true));
   verifyStockCustomerSignatures(request,network.serverKey,firstDeposit);
   const answer=emulator.submitTx(request.arkTx,request.checkpoints).then(response=>verifyStockResponse(request,response,rollup),(error:unknown)=>{throw emulatorRefused(error)?Object.assign(error as Error,{refused:true}):error;});
   return landedOrAnswered(answer,()=>stock.lookup(request));
  },
  unspent:async coin=>live(await coinOf(coin)),
  spentBy:async coin=>{const v=await coinOf(coin);return v?.isSpent?v.arkTxId||v.settledBy||'an unknown transaction':undefined;},
  // A client that misstates its coin's value or assets would unbalance the batch arkd checks, so compare both.
  fresh:async(coin,floorMs)=>{
   const v=await coinOf(coin);
   if(!live(v)||!(v!.expiresAt instanceof Date)||v!.expiresAt.getTime()<=Date.now()+floorMs)return false;
   return v!.value===coin.value&&v!.script===coin.script&&holdings(v!.assets??[])===holdings(coin.assets);
  },
 };
}
