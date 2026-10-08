import {arkade,asset,buildOffchainTx,CSVMultisigTapscript,EmulatorPacket,Extension,MultisigTapscript,PrevArkTxField,setArkPsbtField,UnknownPacket,VtxoScript,type Transaction} from '@arkade-os/sdk';
import {RawWitness} from '@scure/btc-signer';

export const ROLLUP_STATE_PACKET=0x87;
const BASE_FIELD=21888242871839275222246405745257275088696311157297823662689037894645226208583n;

export interface RollupLeaves {batch:Uint8Array;reserve:Uint8Array;renew:Uint8Array}
export interface SnarkProof {pi_a:string[];pi_b:string[][];pi_c:string[]}
export interface RollupCoin {txid:string;vout:number;value:number;sourceTx:Uint8Array;tapTree:Uint8Array;leaf:ReturnType<VtxoScript['findLeaf']>}
/** A slot's boundary legs; an asset payout's carrier sats come from the next slot, a BTC payout to the same program. */
export interface RollupLeg {deposit:bigint;withdraw:bigint;asset:boolean;program?:Uint8Array}
export interface RollupBatch {
 head:RollupCoin;
 reserve?:RollupCoin&{amount:bigint};
 deposits:(RollupCoin&{assetAmount?:bigint})[];
 legs:RollupLeg[];
 token:string;
 asset?:string;
 leaves:RollupLeaves;
 witness:Uint8Array[];
 newPacket:Uint8Array;
 checkpoint:CSVMultisigTapscript.Type;
}

function fail(message:string):never{throw new Error('Rollup batch: '+message);}

export function rollupPoolTree(serverKey:Uint8Array,emulatorKey:Uint8Array,leaves:RollupLeaves,exitDelay:{type:'seconds'|'blocks';value:number}){
 const tweak=(script:Uint8Array)=>arkade.computeArkadeScriptPublicKey(emulatorKey,script);
 const collab=(script:Uint8Array)=>MultisigTapscript.encode({pubkeys:[serverKey,tweak(script)]}).script;
 const batch=collab(leaves.batch),reserve=collab(leaves.reserve),renew=collab(leaves.renew);
 const exit=CSVMultisigTapscript.encode({timelock:{type:exitDelay.type,value:BigInt(exitDelay.value)},pubkeys:[tweak(leaves.batch)]}).script;
 return {tree:new VtxoScript([batch,reserve,renew,exit]),batch,reserve,renew};
}

function scriptNum(value:bigint):Uint8Array {
 if(value<0n)fail('negative witness number.');
 const bytes:number[]=[];for(let v=value;v>0n;v>>=8n)bytes.push(Number(v&255n));
 if(bytes.length&&bytes.at(-1)!&0x80)bytes.push(0);
 return Uint8Array.from(bytes);
}
const le32=(value:bigint)=>value===0n?new Uint8Array():Uint8Array.from({length:32},(_,i)=>Number((value>>BigInt(8*i))&255n));

/** A snarkjs proof as the batch leaf's eight items: A, B in pairing order (x.c1, x.c0, y.c1, y.c0), C. */
export function rollupProofItems(proof:SnarkProof):Uint8Array[] {
 const {pi_a:a,pi_b:b,pi_c:c}=proof;
 if(a?.[2]!=='1'||c?.[2]!=='1'||b?.[2]?.[0]!=='1'||b[2][1]!=='0')fail('proof points must be affine.');
 return [a[0],a[1],b[0][1],b[0][0],b[1][1],b[1][0],c[0],c[1]].map(text=>{
  if(!/^(0|[1-9][0-9]*)$/.test(text??'')||BigInt(text)>=BASE_FIELD)fail('proof coordinate outside the base field.');
  return scriptNum(BigInt(text));
 });
}
/** pub, deposit, withdraw as script numbers; asset and destination fields as 32-byte LE; zero is empty. */
export function rollupPublicItems(publics:readonly bigint[]):Uint8Array[] {
 if(publics.length!==5)fail('a slot has five public inputs.');
 return [scriptNum(publics[0]!),scriptNum(publics[1]!),scriptNum(publics[2]!),le32(publics[3]!),le32(publics[4]!)];
}
export function rollupWitness(batch:SnarkProof,slots:readonly {proof:SnarkProof;publics:readonly bigint[]}[]):Uint8Array[] {
 const items=rollupProofItems(batch);
 for(let i=slots.length-1;i>=0;i--)items.push(...rollupProofItems(slots[i]!.proof),...rollupPublicItems(slots[i]!.publics));
 return items;
}

export function buildRollupBatchTx(b:RollupBatch):{arkTx:Transaction;checkpoints:Transaction[]} {
 let nbtc=0n,nx=0n,pending=0n;
 const payouts:{script:Uint8Array;amount:bigint}[]=[],assetPayouts:{vout:number;amount:bigint}[]=[];
 const firstPayout=b.reserve?2:1;
 for(const leg of b.legs){
  if(leg.deposit<0n||leg.withdraw<0n)fail('legs are non-negative.');
  if(leg.asset)nx+=leg.deposit-leg.withdraw;else nbtc+=leg.deposit-leg.withdraw;
  if(leg.withdraw===0n)continue;
  if(leg.asset){if(pending)fail('an asset payout needs its carrier slot next.');pending=leg.withdraw;continue;}
  if(leg.program?.length!==32)fail('a payout needs a 32-byte P2TR program.');
  payouts.push({script:Uint8Array.of(0x51,0x20,...leg.program),amount:leg.withdraw});
  if(pending){assetPayouts.push({vout:firstPayout+payouts.length-1,amount:pending});pending=0n;}
 }
 if(pending)fail('an asset payout needs its carrier slot next.');
 if((nx!==0n||assetPayouts.length)&&(!b.reserve||!b.asset))fail('asset legs need the asset reserve.');
 const depositAssets=b.deposits.reduce((sum,coin)=>sum+(coin.assetAmount??0n),0n),assetDeposits=b.legs.reduce((sum,leg)=>sum+(leg.asset?leg.deposit:0n),0n);
 if(depositAssets!==assetDeposits)fail('deposit coins must carry exactly the deposited asset.');
 const depositSats=b.deposits.reduce((sum,coin)=>sum+BigInt(coin.value),0n),btcDeposits=b.legs.reduce((sum,leg)=>sum+(leg.asset?0n:leg.deposit),0n);
 if(depositSats!==btcDeposits)fail('deposit coins must carry exactly the deposited sats.');
 const coins=[b.head,...(b.reserve?[b.reserve]:[]),...b.deposits];
 const outputs=[{script:VtxoScript.decode(b.head.tapTree).pkScript,amount:BigInt(b.head.value)+nbtc}];
 if(b.reserve)outputs.push({script:VtxoScript.decode(b.reserve.tapTree).pkScript,amount:BigInt(b.reserve.value)});
 outputs.push(...payouts);
 const id=asset.AssetId.fromString,groups=[asset.AssetGroup.create(id(b.token),null,[asset.AssetInput.create(0,1n)],[asset.AssetOutput.create(0,1n)],[])];
 if(b.reserve&&b.asset){
  const remaining=b.reserve.amount+nx;
  if(remaining<0n)fail('payouts exceed the asset reserve.');
  const inputs=[asset.AssetInput.create(1,b.reserve.amount),...b.deposits.flatMap((coin,i)=>coin.assetAmount?[asset.AssetInput.create(2+i,coin.assetAmount)]:[])];
  const outs=[...(remaining>0n?[asset.AssetOutput.create(1,remaining)]:[]),...assetPayouts.map(p=>asset.AssetOutput.create(p.vout,p.amount))];
  groups.push(asset.AssetGroup.create(id(b.asset),null,inputs,outs,[]));
 }
 const entries=[{vin:0,script:b.leaves.batch,witness:RawWitness.encode(b.witness)},...(b.reserve?[{vin:1,script:b.leaves.reserve,witness:RawWitness.encode([])}]:[])];
 const ext=Extension.create([asset.Packet.create(groups),EmulatorPacket.create(entries),new UnknownPacket(ROLLUP_STATE_PACKET,b.newPacket)]);
 const built=buildOffchainTx(coins.map(c=>({txid:c.txid,vout:c.vout,value:c.value,tapTree:c.tapTree,tapLeafScript:c.leaf})),[...outputs,ext.txOut()],b.checkpoint);
 coins.forEach((coin,vin)=>setArkPsbtField(built.arkTx,vin,PrevArkTxField,coin.sourceTx));
 return built;
}
