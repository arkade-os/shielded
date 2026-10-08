import {RestEmulatorProvider,RestIndexerProvider} from '@arkade-os/sdk';
import {assertStockWeightBudget,type StockNetworkInfo} from '../stock/network.ts';
import {createStockMutinynetTransport,stockSignedWeights,verifyStockCustomerSignatures,verifyStockResponse} from '../stock/transport.ts';
import type {RollupTransport} from './operator.ts';

/** Batches go through the Arkade emulator; the rollup pays up to the operator's own weight limit, not the stock profile's. */
export function createRollupTransport(network:StockNetworkInfo,providers:{emulator?:Pick<RestEmulatorProvider,'submitTx'>;indexer?:Pick<RestIndexerProvider,'getVirtualTxs'|'getVtxos'>}={}):RollupTransport&{fresh(coin:{txid:string;vout:number},floorMs:number):Promise<boolean>} {
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
   return verifyStockResponse(request,await emulator.submitTx(request.arkTx,request.checkpoints),rollup);
  },
  unspent:async coin=>live(await coinOf(coin)),
  fresh:async(coin,floorMs)=>{const v=await coinOf(coin);return live(v)&&v!.expiresAt instanceof Date&&v!.expiresAt.getTime()>Date.now()+floorMs;},
 };
}
