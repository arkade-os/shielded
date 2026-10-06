import {ArkAddress,InMemoryContractRepository,InMemoryWalletRepository,RestArkProvider,RestIndexerProvider,Transaction,VtxoScript,Wallet,type Identity} from '@arkade-os/sdk';
import {hex} from '@scure/base';
import type {VirtualCoin} from '@arkade-os/sdk';
import type {StockNetworkInfo} from './network.ts';
import {decodeStockIndexerTransaction} from './indexer.ts';

export interface CustomerVtxo {funding:{txid:string;vout:number;value:number;sourceTxHex:string;tapTreeHex:string;leafHex:string};amount:number}
export function assertUniqueCustomerVtxos(coins:readonly Pick<VirtualCoin,'txid'|'vout'>[]):void {
 const seen=new Set<string>();
 for(const coin of coins){
  if(!/^[0-9a-f]{64}$/i.test(coin.txid)||!Number.isSafeInteger(coin.vout)||coin.vout<0)throw new Error('Arkade wallet returned an invalid customer VTXO outpoint.');
  const outpoint=`${coin.txid.toLowerCase()}:${coin.vout}`;
  if(seen.has(outpoint))throw new Error('Arkade wallet returned a duplicate customer VTXO outpoint.');
  seen.add(outpoint);
 }
}
export function customerVtxoSourceMatches(coin:Pick<VirtualCoin,'txid'|'vout'|'value'|'script'>,source:Transaction,tree:VtxoScript,expectedAddressScript:Uint8Array):boolean {
 if(source.id!==coin.txid||!Number.isSafeInteger(coin.vout)||coin.vout<0||!Number.isSafeInteger(coin.value)||coin.value<330)return false;
 const output=source.getOutput(coin.vout);
 return !!output?.script&&output.amount===BigInt(coin.value)&&hex.encode(output.script)===coin.script.toLowerCase()&&hex.encode(output.script)===hex.encode(tree.pkScript)&&hex.encode(output.script)===hex.encode(expectedAddressScript);
}
export function walletIntentLeafScriptHex(leaf:readonly [unknown,Uint8Array]):string {
 if(leaf[1].length<1)throw new Error('Arkade wallet returned an empty intent tapscript.');
 return hex.encode(leaf[1].subarray(0,-1));
}
export async function openCustomerArkWallet(identity:Identity,network:StockNetworkInfo){
 const indexer=new RestIndexerProvider(network.indexerUrl??network.arkUrl),wallet=await Wallet.create({identity,arkProvider:new RestArkProvider(network.arkUrl),indexerProvider:indexer,storage:{walletRepository:new InMemoryWalletRepository(),contractRepository:new InMemoryContractRepository()},settlementConfig:false,walletMode:'static'});
 const address=await wallet.getAddress(),decoded=ArkAddress.decode(address),script=decoded.pkScript;
 if(script.length!==34||script[0]!==0x51||script[1]!==0x20)throw new Error('Arkade wallet did not return a standard P2TR receive program.');
 const rawCoins=await wallet.getSpendableVtxos();assertUniqueCustomerVtxos(rawCoins);const txids=[...new Set(rawCoins.map(coin=>coin.txid))],raw=txids.length?await indexer.getVirtualTxs(txids):{txs:[]};
 const sources=new Map<string,Transaction>();for(const encoded of raw.txs){const tx=decodeStockIndexerTransaction(encoded);sources.set(tx.id,tx);}
 const coins:CustomerVtxo[]=[];
 for(const coin of rawCoins){
  if(coin.value<330||coin.assets?.length||!coin.tapTree||!coin.intentTapLeafScript?.[1])continue;
  const source=sources.get(coin.txid),treeBytes=coin.tapTree instanceof Uint8Array?coin.tapTree:hex.decode(String(coin.tapTree));
  if(!source)continue;
  // SDK VTXOs expose TapLeafScript as [control block, script || leaf version],
  // while VtxoScript.findLeaf expects the script body without its final version byte.
  const tree=VtxoScript.decode(treeBytes);if(!customerVtxoSourceMatches(coin,source,tree,script))continue;
  const leafHex=walletIntentLeafScriptHex(coin.intentTapLeafScript);
  try{tree.findLeaf(leafHex);}catch{continue;}
  coins.push({amount:coin.value,funding:{txid:coin.txid,vout:coin.vout,value:coin.value,sourceTxHex:hex.encode(source.toBytes(true,true)),tapTreeHex:hex.encode(treeBytes),leafHex}});
 }
 return {wallet,address,externalProgram:hex.encode(script.subarray(2)),coins};
}
