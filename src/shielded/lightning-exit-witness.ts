import {ConditionWitness,Transaction,getArkPsbtFields,type ExitPackage,type Wallet} from '@arkade-os/sdk';
import {base64,hex} from '@scure/base';
import {Script} from '@scure/btc-signer';
import {sha256} from '@noble/hashes/sha2.js';
import {ripemd160} from '@noble/hashes/legacy.js';

const same=(a:Uint8Array,b:Uint8Array)=>hex.encode(a)===hex.encode(b);
const fail=()=>{throw new Error('The recovery condition witness cannot be restored without changing its signed transactions.');};
function conditionHash(witness:Uint8Array[]){
 if(witness.length<3)return;
 const script=Script.decode(witness.at(-2)!);
 if(script[0]!=='SIZE')return;
 if(!(script[1] instanceof Uint8Array)||hex.encode(script[1])!=='20'||script[2]!=='EQUALVERIFY'||script[3]!=='HASH160'||!(script[4] instanceof Uint8Array)||script[4].length!==20||script[5]!=='EQUAL'||script[6]!=='VERIFY')return fail();
 return script[4];
}
function addedWitness(before:Uint8Array[],after:Uint8Array[]){
 const hash=conditionHash(before),preimage=after.at(-3);
 return !!hash&&after.length===before.length+1&&preimage?.length===32&&same(ripemd160(sha256(preimage)),hash)&&before.every((item,i)=>same(item,after[i<before.length-2?i:i+1]!));
}
export function needsRecoveryWitnessRepair(pkg:ExitPackage){
 for(const step of pkg.steps){
  if(step.kind!=='package')continue;const tx=Transaction.fromRaw(hex.decode(step.parentHex));
  for(let i=0;i<tx.inputsLength;i++){
   const witness=tx.getInput(i).finalScriptWitness??[],hash=conditionHash(witness);if(!hash)continue;
   const top=witness.at(-3);if(top?.length!==32)return true;if(!same(ripemd160(sha256(top)),hash))return fail();
  }
 }
 return false;
}
export function checkRecoveryWitnessRepair(original:ExitPackage,corrected:ExitPackage){
 const copy=structuredClone(corrected);
 if(original.steps.length!==copy.steps.length)return fail();
 for(let i=0;i<original.steps.length;i++){
  const before=original.steps[i]!,after=copy.steps[i]!;
  if(before.kind!=='package'||after.kind!=='package'||before.parentHex===after.parentHex)continue;
  const a=Transaction.fromRaw(hex.decode(before.parentHex)),b=Transaction.fromRaw(hex.decode(after.parentHex));
  if(!same(a.toBytes(true,false),b.toBytes(true,false))||a.inputsLength!==b.inputsLength)return fail();
  for(let j=0;j<a.inputsLength;j++){
   const aw=a.getInput(j).finalScriptWitness??[],bw=b.getInput(j).finalScriptWitness??[];
   if(JSON.stringify(aw.map(hex.encode))!==JSON.stringify(bw.map(hex.encode))&&!addedWitness(aw,bw))return fail();
  }
  after.parentHex=before.parentHex;
 }
 if(JSON.stringify(original)!==JSON.stringify(copy))return fail();
}

export async function completeRecoveryWitnesses(original:ExitPackage,wallet:Pick<Wallet,'indexerProvider'|'virtualTxRepository'>):Promise<ExitPackage>{
 const pkg=structuredClone(original);
 for(const step of pkg.steps){
  if(step.kind!=='package')continue;
  const tx=Transaction.fromRaw(hex.decode(step.parentHex));let changed=false,sources:Transaction[]|undefined,remoteLoaded=false;
  for(let i=0;i<tx.inputsLength;i++){
   const witness=tx.getInput(i).finalScriptWitness??[],hash=conditionHash(witness);if(!hash)continue;
   const top=witness.at(-3);
   if(top?.length===32){if(!same(ripemd160(sha256(top)),hash))return fail();continue;}
   if(!sources){
    const local=await wallet.virtualTxRepository?.getVirtualTx(step.parentTxid);
    sources=local?.psbt?[Transaction.fromPSBT(base64.decode(local.psbt))]:[];
   }
   const find=()=>sources!.find(candidate=>candidate.id===step.parentTxid&&getArkPsbtFields(candidate,i,ConditionWitness).length>0);
   if(!find()&&!remoteLoaded){sources.push(...(await wallet.indexerProvider.getVirtualTxs([step.parentTxid])).txs.map(raw=>Transaction.fromPSBT(base64.decode(raw))));remoteLoaded=true;}
   const source=find();
   if(!source||!same(source.unsignedTx,tx.unsignedTx))return fail();
   const conditions=getArkPsbtFields(source,i,ConditionWitness);
   if(conditions.length!==1||conditions[0]!.length!==1)return fail();
   const corrected=[...witness.slice(0,-2),...conditions[0]!,...witness.slice(-2)];
   if(!addedWitness(witness,corrected))return fail();
   tx.updateInput(i,{finalScriptWitness:corrected});changed=true;
  }
  if(changed)step.parentHex=tx.hex;
 }
 checkRecoveryWitnessRepair(original,pkg);return pkg;
}
