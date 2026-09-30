import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
// @ts-ignore circomlibjs has no bundled declarations.
import { buildPoseidon, buildBabyjub } from 'circomlibjs';
// @ts-ignore snarkjs has no bundled declarations.
import * as snarkjs from 'snarkjs';
import type {Asset, Owner, Groth16Proof, ProtocolState, EncryptedRecord, PreparedSettlement, OwnedNote, ProtocolSnapshot, ProtocolKernel} from './types.js';
export * from './types.js';
export const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const DOMAIN = 20260930001n;
export const INTENT_SIGNAL_COUNT = 25;
export const TRANSITION_SIGNAL_COUNT = 30;
const ASSETS: Asset[] = ['BTC','DEMO'];
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const BUILD = path.join(ROOT,'circuits/build');
const mod=(n:bigint)=>((n%FIELD)+FIELD)%FIELD;
const clone=<T>(v:T):T=>structuredClone(v);
const str=(n:bigint|number|string)=>String(n);
function freeze<T>(value:T):T { if(value && typeof value==='object') { Object.freeze(value); for(const child of Object.values(value)) freeze(child); } return value; }
const rand=()=>{for(;;){const n=BigInt('0x'+randomBytes(32).toString('hex'));if(n>0n&&n<FIELD)return n;}};
const bits=(n:number)=>Array.from({length:8},(_,i)=>(n>>i)&1);
export function destinationField(destination:string|Uint8Array):string {
 const value = typeof destination==='string' ? Buffer.from(destination.replace(/^0x/,''),'hex') : Buffer.from(destination);
 if(value.length!==32) throw new Error('Withdrawal destination must be the exact 32-byte native Taproot witness program, in hex.');
 const digest=createHash('sha256').update(value).digest();
 return mod(BigInt('0x'+Buffer.from(digest).reverse().toString('hex'))).toString();
}
class Tree {
 leaves:bigint[]; private cached?:bigint[][];
 constructor(private hash:(v:bigint[])=>bigint,leaves?:bigint[]){this.leaves=leaves?.slice()??Array<bigint>(256).fill(0n);}
 clone(){return new Tree(this.hash,this.leaves);}
 levels(){if(!this.cached){this.cached=[this.leaves.slice()];for(let d=0;d<8;d++){const last=this.cached[d];this.cached.push(Array.from({length:last.length/2},(_,i)=>this.hash([last[2*i],last[2*i+1]])));}}return this.cached;}
 root(){return this.levels()[8][0];}
 path(index:number){const levels=this.levels();return Array.from({length:8},(_,d)=>str(levels[d][(index>>d)^1]));}
 set(index:number,value:bigint){if(index<0||index>=256)throw new Error('Depth-8 demonstration tree capacity exhausted.');this.leaves[index]=value;this.cached=undefined;}
}
interface Wallet {spend:bigint;view:bigint;publicKey:bigint[];owner:bigint}
interface Anchor {root:string;tree:Tree;count:number}
interface Internal {noteTree:Tree;spentTree:Tree;historyTree:Tree;anchor?:Anchor;records:EncryptedRecord[];intentWitness?:Record<string,unknown>}
class Kernel implements ProtocolKernel {
 private noteTree:Tree; private spentTree:Tree; private historyTree:Tree;
 private state:ProtocolState; private wallets:Record<Owner,Wallet>; private log:EncryptedRecord[]=[]; private nfs:string[]=[];
 private anchors:Anchor[]=[]; private receipts:unknown[]=[]; private internals=new WeakMap<PreparedSettlement,Internal>();
 private vkeys:Record<string,any>;
 constructor(private poseidon:any,private baby:any){
  this.noteTree=new Tree(this.hash);this.spentTree=new Tree(this.hash);this.historyTree=new Tree(this.hash);
  this.state={noteRoot:str(this.noteTree.root()),spentRoot:str(this.spentTree.root()),historyRoot:str(this.historyTree.root()),noteCount:0,historyCount:0,revision:0,reserves:{BTC:0,DEMO:0}};
  this.wallets=Object.fromEntries((['alice','bob'] as Owner[]).map(name=>{
   const derive=(tag:string)=>BigInt('0x'+createHash('sha256').update(`SHIELDED-POC-INSECURE-DEMO-KEY:${name}:${tag}`).digest('hex'))%this.baby.subOrder||1n;
   const spend=derive('spend'),view=derive('view');const publicKey=this.baby.mulPointEscalar(this.baby.Base8,view).map((x:any)=>BigInt(this.baby.F.toObject(x)));
   return [name,{spend,view,publicKey,owner:this.hash([DOMAIN,spend])}];
  })) as Record<Owner,Wallet>;
  this.vkeys=Object.fromEntries(['intent','transition'].map(name=>[name,JSON.parse(readFileSync(path.join(BUILD,`${name}.vkey.json`),'utf8'))]));
 }
 private hash=(values:bigint[]):bigint=>BigInt(this.poseidon.F.toObject(this.poseidon(values)));
 private inverseEight(){ for(let k=1n;k<8n;k++)if((k*this.baby.subOrder+1n)%8n===0n)return(k*this.baby.subOrder+1n)/8n;throw new Error("No cofactor inverse.");}
 private point(values:bigint[]){return values.map(x=>this.baby.F.e(x));}
 private encrypt(owner:Owner,amount:number,asset:Asset,rho:bigint,ephemeral:bigint){
  const wallet=this.wallets[owner];
  if(!this.baby.inSubgroup(this.point(wallet.publicKey)))throw new Error('Recipient view key is not in the BabyJub prime-order subgroup.');
  const pub=this.baby.mulPointEscalar(this.baby.Base8,ephemeral).map((x:any)=>BigInt(this.baby.F.toObject(x)));
  const shared=this.baby.mulPointEscalar(this.point(wallet.publicKey),ephemeral).map((x:any)=>BigInt(this.baby.F.toObject(x)));
  const plain=[BigInt(amount),BigInt(ASSETS.indexOf(asset)),wallet.owner,rho];
  const encrypted=plain.map((v,i)=>mod(v+this.hash([DOMAIN,shared[0],shared[1],BigInt(100+i)])));
  const tag=this.hash([DOMAIN,shared[0],shared[1],...encrypted,200n]);
  return [...pub,...encrypted,tag];
 }
 private decrypt(owner:Owner,record:EncryptedRecord):OwnedNote|undefined{
  try {
   const w=this.wallets[owner],cipher=record.ciphertext.map(BigInt),pub=this.point(cipher.slice(0,2));
   if(!this.baby.inCurve(pub)||!this.baby.inSubgroup(pub)||cipher[0]===0n)return;
   const shared=this.baby.mulPointEscalar(pub,w.view).map((x:any)=>BigInt(this.baby.F.toObject(x)));
   if(this.hash([DOMAIN,shared[0],shared[1],...cipher.slice(2,6),200n])!==cipher[6])return;
   const plain=cipher.slice(2,6).map((v,i)=>mod(v-this.hash([DOMAIN,shared[0],shared[1],BigInt(100+i)])));
   if(plain[2]!==w.owner||plain[0]>=2n**48n||plain[1]>1n)return;
   const cm=this.hash([DOMAIN,...plain]);if(str(cm)!==record.commitment)return;
   const nf=str(this.hash([DOMAIN,w.spend,plain[3]]));
   return {index:record.index,amount:Number(plain[0]),asset:ASSETS[Number(plain[1])],owner:str(plain[2]),rho:str(plain[3]),commitment:record.commitment,ciphertext:record.ciphertext.slice(),leaf:record.leaf,spent:this.nfs.includes(nf),spendable:this.anchors.some(a=>record.index<a.count)};
  }catch{return;}
 }
 recover(owner:Owner):OwnedNote[]{return this.log.map(r=>this.decrypt(owner,r)).filter((n):n is OwnedNote=>!!n&&n.amount>0);}
 snapshot():ProtocolSnapshot{
  const wallets=Object.fromEntries((['alice','bob'] as Owner[]).map(name=>{
   const w=this.wallets[name],notes=this.recover(name),balances={BTC:0,DEMO:0},pending={BTC:0,DEMO:0};
   for(const n of notes)if(!n.spent)(n.spendable?balances:pending)[n.asset]+=n.amount;
   return [name,{address:str(w.owner),spendKey:str(w.spend),viewKey:str(w.view),viewPublicKey:w.publicKey.map(str),balances,pending,notes}];
  })) as ProtocolSnapshot['wallets'];
  return {state:clone(this.state),wallets,encryptedLog:clone(this.log),nullifiers:this.nfs.slice(),anchors:this.anchors.map(a=>a.root),profile:{treeDepth:8,noteCapacity:256,nullifierCapacity:256,intentPublicSignals:25,transitionPublicSignals:30},receipts:clone(this.receipts)};
 }
 verificationKeys(){return clone(this.vkeys);}
 private validateAmount(amount:number){if(!Number.isSafeInteger(amount)||amount<=0||amount>=2**48)throw new Error('Amount must be a positive bounded 48-bit integer.');}
 private async prove(name:'intent'|'transition',witness:Record<string,unknown>){
  const started=performance.now();
  const result=await snarkjs.groth16.fullProve(witness,path.join(BUILD,`${name}_js/${name}.wasm`),path.join(BUILD,`${name}.zkey`),undefined,undefined,{singleThread:true});
  return {proof:result.proof as Groth16Proof,signals:result.publicSignals as string[],ms:performance.now()-started};
 }
 async prepareShield(owner:Owner,asset:Asset,amount:number){this.validateAmount(amount);return this.makeIntent('shield',owner,owner,asset,amount);}
 async prepareTransfer(from:Owner,to:Owner,asset:Asset,amount:number){this.validateAmount(amount);return this.makeIntent('transfer',from,to,asset,amount);}
 async prepareWithdraw(owner:Owner,asset:Asset,amount:number,destination:string){this.validateAmount(amount);return this.makeIntent('withdraw',owner,owner,asset,amount,destinationField(destination));}
 private async makeIntent(operation:'shield'|'transfer'|'withdraw',from:Owner,to:Owner,asset:Asset,amount:number,destination='0'){
  const input=operation==='shield'?undefined:this.recover(from).find(n=>n.asset===asset&&!n.spent&&n.spendable&&n.amount>=amount);
  if(operation!=='shield'&&!input)throw new Error(`No sealed ${asset} note covers this amount. Seal new receipts first; this profile consumes one note per intent.`);
  const anchor=input?this.anchors.findLast(a=>input.index<a.count):undefined;
  const nonce=rand();const randoms=[rand(),rand()];const ephemeral=[rand()%this.baby.subOrder||1n,rand()%this.baby.subOrder||1n];
  const amounts=operation==='shield'?[amount,0]:operation==='transfer'?[amount,input!.amount-amount]:[input!.amount-amount,0];
  const owners:Owner[]=operation==='transfer'?[to,from]:[from,from];
  const records=amounts.map((value,i)=>{
   const rho=this.hash([DOMAIN,randoms[i],BigInt(destination),nonce]);
   const cm=this.hash([DOMAIN,BigInt(value),BigInt(ASSETS.indexOf(asset)),this.wallets[owners[i]].owner,rho]);
   const ciphertext=this.encrypt(owners[i],value,asset,rho,ephemeral[i]);
   return {index:this.state.noteCount+i,commitment:str(cm),ciphertext:ciphertext.map(str),leaf:str(this.hash([cm,...ciphertext])),createdRevision:this.state.revision+1};
  });
  const deposit={BTC:0,DEMO:0},withdrawal={BTC:0,DEMO:0};if(operation==='shield')deposit[asset]=amount;if(operation==='withdraw')withdrawal[asset]=amount;
  const nf=input?this.hash([DOMAIN,this.wallets[from].spend,BigInt(input.rho)]):0n;
  const data=[str(DOMAIN),anchor?.root??'0',str(nf),...records.map(r=>r.commitment),...records.flatMap(r=>r.ciphertext),str(deposit.BTC),str(deposit.DEMO),str(withdrawal.BTC),str(withdrawal.DEMO),destination,str(nonce)];
  const witness={data,inputAmount:input?.amount??0,inputAsset:input?ASSETS.indexOf(input.asset):0,inputRho:input?.rho??0,spendSecret:str(this.wallets[from].spend),inputCipher:input?.ciphertext??Array(7).fill('0'),inputPath:input?anchor!.tree.path(input.index):Array(8).fill('0'),inputBits:bits(input?.index??0),outputAmount:amounts,outputAsset:[ASSETS.indexOf(asset),ASSETS.indexOf(asset)],outputOwner:owners.map(o=>str(this.wallets[o].owner)),outputRandom:randoms.map(str),recipient:owners.map(o=>this.wallets[o].publicKey.map(str)),recipientPreimage:owners.map(o=>this.baby.mulPointEscalar(this.point(this.wallets[o].publicKey),this.inverseEight()).map((x:any)=>str(BigInt(this.baby.F.toObject(x))))),ephemeral:ephemeral.map(str)};
  const intent=await this.prove('intent',witness);
  return this.prepareApplication({operation,intentProof:intent.proof,intentSignals:intent.signals,ciphertextRecords:records,boundary:{deposit,withdrawal,destination},intentMs:intent.ms,intentWitness:witness});
 }
 private async prepareApplication(args:{operation:PreparedSettlement['operation'];intentProof?:Groth16Proof;intentSignals:string[];ciphertextRecords:EncryptedRecord[];boundary:PreparedSettlement['boundary'];intentMs:number;intentWitness?:Record<string,unknown>}){
  const oldState=clone(this.state),notes=this.noteTree.clone(),spent=this.spentTree.clone(),history=this.historyTree.clone();
  const seal=args.operation==='seal',data=args.intentSignals.slice(0,19),nf=BigInt(data[2]);
  let appendPaths=[Array(8).fill('0'),Array(8).fill('0')],spentPath=Array(8).fill('0'),historyPath=Array(8).fill('0'),sealPath=Array(8).fill('0'),historyIndex=0;
  const records=args.ciphertextRecords.map((r,i)=>({...clone(r),index:oldState.noteCount+i,createdRevision:oldState.revision+1}));
  if(seal){if(oldState.historyCount>=256)throw new Error('Anchor history full.');sealPath=history.path(oldState.historyCount);history.set(oldState.historyCount,this.hash([DOMAIN,notes.root()]));}
  else {
   if(oldState.noteCount+2>256)throw new Error('Note tree full.');
   if(nf!==0n){const slot=Number(nf&255n);if(spent.leaves[slot]!==0n)throw new Error(spent.leaves[slot]===nf?'Nullifier already spent.':'Depth-8 nullifier slot collision; this bounded demo must stop rather than delete old spends.');spentPath=spent.path(slot);spent.set(slot,nf);historyIndex=this.anchors.findIndex(a=>a.root===data[1]);if(historyIndex<0)throw new Error('Private intent anchor is not authenticated.');historyPath=history.path(historyIndex);}
   for(let i=0;i<2;i++){appendPaths[i]=notes.path(oldState.noteCount+i);notes.set(oldState.noteCount+i,BigInt(records[i].leaf));}
  }
  const newState={...oldState,noteRoot:str(notes.root()),spentRoot:str(spent.root()),historyRoot:str(history.root()),noteCount:oldState.noteCount+(seal?0:2),historyCount:oldState.historyCount+(seal?1:0),revision:oldState.revision+1,reserves:{BTC:oldState.reserves.BTC+args.boundary.deposit.BTC-args.boundary.withdrawal.BTC,DEMO:oldState.reserves.DEMO+args.boundary.deposit.DEMO-args.boundary.withdrawal.DEMO}};
  if(newState.reserves.BTC<0||newState.reserves.DEMO<0)throw new Error('Insufficient native backing.');
  const transitionData=[...data,str(seal?1:0),oldState.noteRoot,newState.noteRoot,oldState.spentRoot,newState.spentRoot,oldState.historyRoot,newState.historyRoot,str(oldState.noteCount),str(newState.noteCount),str(oldState.historyCount),str(newState.historyCount)];
  const proof=await this.prove('transition',{data:transitionData,appendPaths,spentPath,historyPath,historyIndex,sealPath});
  const prepared:PreparedSettlement={id:randomBytes(12).toString('hex'),operation:args.operation,intentProof:args.intentProof,transitionProof:proof.proof,intentSignals:args.intentSignals,transitionSignals:proof.signals,oldState,newState,ciphertextRecords:records,boundary:args.boundary,proofTimes:{intentMs:args.intentMs,transitionMs:proof.ms}};
  this.internals.set(prepared,{noteTree:notes,spentTree:spent,historyTree:history,anchor:seal?{root:oldState.noteRoot,tree:this.noteTree.clone(),count:oldState.noteCount}:undefined,records,intentWitness:args.intentWitness});
  return freeze(prepared);
 }
 async prepareSeal(){return this.prepareApplication({operation:'seal',intentSignals:[str(DOMAIN),...Array(24).fill('0')],ciphertextRecords:[],boundary:{deposit:{BTC:0,DEMO:0},withdrawal:{BTC:0,DEMO:0},destination:'0'},intentMs:0});}
 async rebase(prepared:PreparedSettlement){const internal=this.internals.get(prepared);if(!internal)throw new Error('Unknown prepared settlement.');return this.prepareApplication({operation:prepared.operation,intentProof:prepared.intentProof,intentSignals:prepared.intentSignals,ciphertextRecords:prepared.ciphertextRecords,boundary:prepared.boundary,intentMs:0,intentWitness:internal.intentWitness});}
 async verify(prepared:PreparedSettlement){
  if(prepared.intentSignals.length!==25||prepared.transitionSignals.length!==30)return false;
  if(prepared.intentSignals.slice(0,19).some((v,i)=>v!==prepared.transitionSignals[i]))return false;
  if(prepared.operation!=='seal'&&(!prepared.intentProof||!await snarkjs.groth16.verify(this.vkeys.intent,prepared.intentSignals,prepared.intentProof)))return false;
  return snarkjs.groth16.verify(this.vkeys.transition,prepared.transitionSignals,prepared.transitionProof);
 }
 async commit(prepared:PreparedSettlement,receipt:unknown){
  const internal=this.internals.get(prepared);if(!internal)throw new Error('Unknown prepared settlement.');
  if(JSON.stringify(prepared.oldState)!==JSON.stringify(this.state))throw new Error('Stale settlement: regenerate the public-state proof; private intent remains reusable.');
  if(!await this.verify(prepared))throw new Error('Proof verification failed.');
  this.noteTree=internal.noteTree;this.spentTree=internal.spentTree;this.historyTree=internal.historyTree;this.state=clone(prepared.newState);
  this.log.push(...clone(internal.records));if(prepared.intentSignals[2]!=='0')this.nfs.push(prepared.intentSignals[2]);if(internal.anchor)this.anchors.push(internal.anchor);
  this.receipts.push(clone(receipt));return this.snapshot();
 }
}
export async function createProtocol():Promise<ProtocolKernel>{
 for(const name of ['intent','transition'])if(!existsSync(path.join(BUILD,`${name}.zkey`)))throw new Error(`Missing ${name} proof artifacts. Run npm run setup first.`);
 const [poseidon,baby]=await Promise.all([buildPoseidon(),buildBabyjub()]);return new Kernel(poseidon,baby);
}
