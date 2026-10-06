import {isValidOwner,LEGACY_OWNERS,type Asset, type Owner, type Groth16Proof, type ProtocolState, type EncryptedRecord, type PreparedSettlement, type StockPreparedSettlement, type OwnedNote, type ProtocolSnapshot, type ProtocolKernel, type ProtocolCheckpoint} from './types.js';
export * from './types.js';
import {groth16Descriptor,proofDescriptorMatches,proofStatement,proofStatementMatches,type ProofBackend} from './proofs.js';
export * from './proofs.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { PublicProtocolCheckpoint, PublicRecipient, ClientProtocolKernel, WalletKeys } from './types.js';
import { encodeStockNativeBinding, stockBindingHex, stockProofDescriptor, stockProofDescriptorMatches, stockStatementScalar, stockStateCommitment, STOCK_DOMAIN, type StockNativeBinding, type StockOperation, type StockProofBackend } from './stock-native.js';
import type { StockSettlementProof } from './stock-native.js';
import { IndexedNullifiers, type IndexedNullifierWitness } from './indexed-nullifiers.js';
export * from './stock-native.js';
export const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const DOMAIN = 20260930001n;
export const INTENT_SIGNAL_COUNT = 25;
export const TRANSITION_SIGNAL_COUNT = 30;
const ASSETS: Asset[] = ['BTC','DEMO'];
export interface ProtocolEnvironment { randomBytes(length:number):Uint8Array; vkeys:Record<string,any>; proofs?:ProofBackend<Groth16Proof>; stockProof?:StockProofBackend; stockVerifierKey?:unknown; stockOnly?:boolean; }
const hashHex=(value:string)=>bytesToHex(sha256(new TextEncoder().encode(value)));
const mod=(n:bigint)=>((n%FIELD)+FIELD)%FIELD;
const clone=<T>(v:T):T=>structuredClone(v);
const str=(n:bigint|number|string)=>String(n);
export function protocolProfileFingerprint(vkeys:Record<string,any>):string{return hashHex(JSON.stringify({domain:str(DOMAIN),treeDepth:8,noteCapacity:256,nullifierCapacity:256,intentSignals:25,transitionSignals:30,vkeys}));}
function freeze<T>(value:T):T { if(value && typeof value==='object') { Object.freeze(value); for(const child of Object.values(value)) freeze(child); } return value; }
const rand=(random:(length:number)=>Uint8Array)=>{for(;;){const n=BigInt('0x'+bytesToHex(random(32)));if(n>0n&&n<FIELD)return n;}};
const bits=(n:number)=>Array.from({length:8},(_,i)=>(n>>i)&1);
function fieldValue(v:unknown):bigint { if(typeof v!=='string'||! /^(0|[1-9][0-9]*)$/.test(v))throw new Error('Non-canonical field encoding.');const n=BigInt(v);if(n>=FIELD)throw new Error('Field element out of range.');return n; }
export function destinationField(destination:string|Uint8Array):string {
 const value = typeof destination==='string' ? hexToBytes(destination.replace(/^0x/,'')) : new Uint8Array(destination);
 if(value.length!==32) throw new Error('Withdrawal destination must be the exact 32-byte native Taproot witness program, in hex.');
 const digest=sha256(value);
 return mod(BigInt('0x'+bytesToHex(digest.slice().reverse()))).toString();
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
interface Internal {noteTree:Tree;spentTree:Tree;historyTree:Tree;anchor?:Anchor;records:EncryptedRecord[];intentWitness?:Record<string,unknown>;stockTransitionWitness?:Record<string,unknown>}
interface StockInternal {noteTree:Tree;historyTree:Tree;anchor?:Anchor;records:EncryptedRecord[];intentWitness?:Record<string,unknown>;transitionWitness:Record<string,unknown>;nullifiers:IndexedNullifiers;proof?:StockSettlementProof}
export class Kernel implements ClientProtocolKernel {
 private noteTree:Tree; private spentTree:Tree; private historyTree:Tree;
 private state:ProtocolState; private wallets:Record<Owner,Wallet>; private log:EncryptedRecord[]=[]; private nfs:string[]=[];
 private anchors:Anchor[]=[]; private receipts:unknown[]=[]; private internals=new WeakMap<PreparedSettlement,Internal>(); private committed=new WeakSet<PreparedSettlement>(); private committedIds:Record<string,string>={};
 private vkeys:Record<string,any>; private recipientDirectory?:Record<Owner,PublicRecipient>;
 private stockNullifiers?:IndexedNullifiers; private stockInternals=new WeakMap<StockPreparedSettlement,StockInternal>(); private stockCommitted=new WeakMap<StockPreparedSettlement,string>();
 constructor(private poseidon:any,private baby:any,private env:ProtocolEnvironment,private mode:'legacy'|'client'|'public'='legacy',private localOwner?:Owner,keys?:WalletKeys,recipients?:Record<Owner,PublicRecipient>,secureKeys=false){
  if(this.localOwner!==undefined&&!isValidOwner(this.localOwner))throw new Error('Invalid client participant identifier.');
  if(!env.stockOnly&&(!env.proofs||env.proofs.id!=='groth16-bn254'||env.proofs.version!==1))throw new Error('This native protocol profile accepts only the pinned Groth16 BN254 backend.');
  this.noteTree=new Tree(this.hash);this.spentTree=new Tree(this.hash);this.historyTree=new Tree(this.hash);
  this.state={noteRoot:str(this.noteTree.root()),spentRoot:str(this.spentTree.root()),historyRoot:str(this.historyTree.root()),noteCount:0,historyCount:0,revision:0,reserves:{BTC:0,DEMO:0}};
  if(env.stockOnly){if(!env.stockProof)throw new Error('The stock-only profile requires its combined Groth16 verifier.');this.stockNullifiers=new IndexedNullifiers(this.hash);this.state.spentRoot=this.stockNullifiers.root().toString();}
  const owners=this.mode==='legacy'?[...LEGACY_OWNERS] as Owner[]:[...new Set([...(recipients?Object.keys(recipients):[]),...(this.localOwner?[this.localOwner]:[])])];
  this.wallets=Object.fromEntries(owners.map(name=>{
   const derive=(tag:string)=>BigInt('0x'+hashHex(`SHIELDED-POC-INSECURE-DEMO-KEY:${name}:${tag}`))%this.baby.subOrder||1n;
   const randomScalar=()=>BigInt('0x'+bytesToHex(this.env.randomBytes(32)))%this.baby.subOrder||1n;
   if(this.mode!=='legacy'&&name!==this.localOwner){const r=recipients?.[name];return [name,{spend:0n,view:0n,publicKey:r?r.viewPublicKey.map(BigInt):[0n,1n],owner:r?BigInt(r.owner):0n}];}
   const spend=keys?fieldValue(keys.spend):(this.mode==='client'||secureKeys?randomScalar():derive('spend')),view=keys?fieldValue(keys.view):(this.mode==='client'||secureKeys?randomScalar():derive('view'));if(spend<=0n||view<=0n||spend>=this.baby.subOrder||view>=this.baby.subOrder)throw new Error('Invalid client wallet scalar.');const publicKey=this.baby.mulPointEscalar(this.baby.Base8,view).map((x:any)=>BigInt(this.baby.F.toObject(x)));
   return [name,{spend,view,publicKey,owner:this.hash([DOMAIN,spend])}];
  })) as Record<Owner,Wallet>;
  this.vkeys=clone(this.env.vkeys);if(!this.env.stockOnly)for(const name of ['intent','transition'] as const)if(!proofDescriptorMatches(this.env.proofs!.describe(name,this.vkeys[name],str(DOMAIN)),groth16Descriptor(name,this.vkeys[name],str(DOMAIN))))throw new Error('Proof provider does not match the pinned Groth16 verifier profile.');if(this.env.stockProof){if(!this.env.stockVerifierKey||this.env.stockProof.id!=='groth16-bn254'||this.env.stockProof.version!==1||!this.env.stockProof.verify||!stockProofDescriptorMatches(this.env.stockProof.describe(this.env.stockVerifierKey,STOCK_DOMAIN.toString()),stockProofDescriptor(this.env.stockVerifierKey)))throw new Error('Stock prover does not match the pinned single-signal Groth16 verifier profile.');}if(recipients)this.setRecipients(recipients);if(this.mode==='public'&&!Object.keys(recipients??{}).length&&!this.env.stockOnly)throw new Error('Public coordinator requires registered recipient descriptors.');
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
   const w=this.wallets[owner];if(w.spend===0n||w.view===0n)return;const cipher=record.ciphertext.map(BigInt),pub=this.point(cipher.slice(0,2));
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
  const wallets=Object.fromEntries(Object.keys(this.wallets).map(name=>{
   const w=this.wallets[name],notes=this.recover(name),balances={BTC:0,DEMO:0},pending={BTC:0,DEMO:0};
   for(const n of notes)if(!n.spent)(n.spendable?balances:pending)[n.asset]+=n.amount;
   return [name,{address:str(w.owner),spendKey:w.spend===0n?'':str(w.spend),viewKey:w.view===0n?'':str(w.view),viewPublicKey:w.publicKey.map(str),balances,pending,notes}];
  })) as ProtocolSnapshot['wallets'];
  return {state:clone(this.state),wallets,encryptedLog:clone(this.log),nullifiers:this.nfs.slice(),anchors:this.anchors.map(a=>a.root),profile:{treeDepth:8,noteCapacity:256,nullifierCapacity:this.env.stockOnly?512:256,intentPublicSignals:25,transitionPublicSignals:30},receipts:clone(this.receipts)};
 }
 private profileFingerprint(){return this.env.stockOnly?hashHex(JSON.stringify({stock:stockProofDescriptor(this.env.stockVerifierKey),nullifiers:'indexed-nullifiers-v1'})):protocolProfileFingerprint(this.vkeys);}
 exportState():ProtocolCheckpoint{if(this.mode!=='legacy')throw new Error('Use publicCheckpoint and client wallet backup separately.');return {version:1,domain:str(DOMAIN),profile:this.profileFingerprint(),state:clone(this.state),wallets:{alice:{spend:str(this.wallets.alice.spend),view:str(this.wallets.alice.view)},bob:{spend:str(this.wallets.bob.spend),view:str(this.wallets.bob.view)}},trees:{notes:this.noteTree.leaves.map(str),spent:this.spentTree.leaves.map(str),history:this.historyTree.leaves.map(str)},encryptedLog:clone(this.log),nullifiers:this.nfs.slice(),anchors:this.anchors.map(a=>({root:a.root,count:a.count,leaves:a.tree.leaves.map(str)})),receipts:clone(this.receipts),committed:{...this.committedIds}};}
 private fingerprint(p:PreparedSettlement){return hashHex(JSON.stringify(p));}
 restoreCheckpoint(c:ProtocolCheckpoint){this.loadCheckpoint(c);}
 private loadCheckpoint(c:ProtocolCheckpoint|PublicProtocolCheckpoint){
  const fail=(s:string):never=>{throw new Error(`Invalid protocol checkpoint: ${s}`);};
  if(!c||c.version!==1||c.domain!==str(DOMAIN)||c.profile!==this.profileFingerprint())fail('version, domain, or proof profile mismatch.');
  const field=(v:unknown):bigint=>{try{return fieldValue(v);}catch{return fail('non-canonical or out-of-range field encoding.');}};
  const leaves=(a:unknown):bigint[]=>{if(!Array.isArray(a)||a.length!==256)fail('tree leaf count mismatch.');return (a as unknown[]).map(field);};
  if(!c.state||!Number.isSafeInteger(c.state.noteCount)||c.state.noteCount<0||c.state.noteCount>256||!Number.isSafeInteger(c.state.historyCount)||c.state.historyCount<0||c.state.historyCount>256||!Number.isSafeInteger(c.state.revision)||c.state.revision<0||(this.env.stockOnly?c.state.revision>1023:c.state.revision!==c.state.noteCount/2+c.state.historyCount))fail('invalid state counts.');
  for(const n of [c.state.reserves?.BTC,c.state.reserves?.DEMO])if(!Number.isSafeInteger(n)||n<0)fail('invalid reserve.');
  const noteLeaves=leaves(c.trees?.notes),spentLeaves=leaves(c.trees?.spent),historyLeaves=leaves(c.trees?.history);
  this.noteTree=new Tree(this.hash,noteLeaves);this.spentTree=new Tree(this.hash,spentLeaves);this.historyTree=new Tree(this.hash,historyLeaves);
  this.state=clone(c.state);
  if(this.state.noteRoot!==str(this.noteTree.root())||this.state.historyRoot!==str(this.historyTree.root()))fail('tree root mismatch.');
  if(this.env.stockOnly){if(!c.stockNullifiers)fail('stock profile is missing its indexed nullifier journal.');try{this.stockNullifiers=new IndexedNullifiers(this.hash,c.stockNullifiers);}catch{return fail('invalid indexed nullifier journal.');}if(this.state.spentRoot!==str(this.stockNullifiers.root()))fail('indexed nullifier root mismatch.');}
  else if(c.stockNullifiers||this.state.spentRoot!==str(this.spentTree.root()))fail('tree root mismatch.');
  if(this.state.noteCount%2!==0||!Array.isArray(c.encryptedLog)||c.encryptedLog.length!==this.state.noteCount||c.encryptedLog.some((r,i)=>!r||r.index!==i||r.createdRevision<1||r.createdRevision>this.state.revision||r.createdRevision<(i?c.encryptedLog[i-1].createdRevision:1)||(i%2===1&&r.createdRevision!==c.encryptedLog[i-1].createdRevision)||r.ciphertext?.length!==7||r.commitment!==str(field(r.commitment))||r.ciphertext.some(x=>x!==str(field(x)))||r.leaf!==str(this.hash([field(r.commitment),...r.ciphertext.map(field)]))))fail('encrypted record log mismatch.');
  this.log=clone(c.encryptedLog);
  if(noteLeaves.some((v,i)=>v!==(i<this.log.length?BigInt(this.log[i].leaf):0n)))fail('note tree does not match encrypted log.');
  if(!Array.isArray(c.nullifiers)||c.nullifiers.some(n=>n!==str(field(n))||n==='0')||new Set(c.nullifiers).size!==c.nullifiers.length)fail('invalid nullifier list.');
  this.nfs=c.nullifiers.slice();if(this.env.stockOnly){if(this.stockNullifiers!.count()!==this.nfs.length+1||this.nfs.some(nf=>!this.stockNullifiers!.has(nf)))fail('indexed nullifier journal does not match spent note records.');}
  else{const expectedSpent=Array(256).fill(0n);for(const nf of this.nfs){const slot=Number(BigInt(nf)&255n);if(expectedSpent[slot]!==0n)fail('nullifier slot collision.');expectedSpent[slot]=BigInt(nf);}if(expectedSpent.some((n,i)=>n!==spentLeaves[i]))fail('nullifier tree/list mismatch.');}
  if(!Array.isArray(c.anchors)||c.anchors.length!==this.state.historyCount)fail('anchor count mismatch.');
  this.anchors=c.anchors.map((a,i)=>{if(!a||!Number.isSafeInteger(a.count)||a.count<0||a.count>this.state.noteCount||a.root!==str(field(a.root)))fail('invalid anchor.');const historical=leaves(a.leaves);const tree=new Tree(this.hash,historical);if(tree.root()!==BigInt(a.root))fail('anchor root mismatch.');for(let j=0;j<256;j++){const expected=j<a.count?BigInt(this.log[j]?.leaf??'0'):0n;if(historical[j]!==expected)fail('anchor leaves do not match log prefix.');}if(historyLeaves[i]!==this.hash([DOMAIN,BigInt(a.root)]))fail('anchor history leaf mismatch.');return {root:a.root,tree,count:a.count};});
  if(!Array.isArray(c.receipts)||c.receipts.length!==c.state.revision)fail('receipt count mismatch.');this.receipts=clone(c.receipts);
  if(!c.committed||typeof c.committed!=='object')fail('missing wallet or commit data.');
  if(this.mode==='legacy'){if(!(c as ProtocolCheckpoint).wallets)fail('missing legacy wallet keys.');
  this.wallets=Object.fromEntries(LEGACY_OWNERS.map(name=>{const keys=(c as ProtocolCheckpoint).wallets[name];if(!keys)fail('missing legacy wallet key.');const spend=field(keys.spend),view=field(keys.view);if(spend<=0n||spend>=this.baby.subOrder||view<=0n||view>=this.baby.subOrder)fail('wallet scalar outside subgroup order.');const publicKey=this.baby.mulPointEscalar(this.baby.Base8,view).map((x:any)=>BigInt(this.baby.F.toObject(x)));if(!this.baby.inSubgroup(this.point(publicKey)))fail('wallet view key is invalid.');return [name,{spend,view,publicKey,owner:this.hash([DOMAIN,spend])}];})) as Record<Owner,Wallet>;
  const knownNullifiers=new Set<string>();for(const record of this.log)if(this.anchors.some(a=>record.index<a.count)){for(const owner of LEGACY_OWNERS){const note=this.decrypt(owner,record);if(note&&note.amount>0)knownNullifiers.add(str(this.hash([DOMAIN,this.wallets[owner].spend,BigInt(note.rho)])));}}if(this.nfs.some(nf=>!knownNullifiers.has(nf)))fail('nullifier has no recoverable sealed note.');
  }else{const publicState=c as PublicProtocolCheckpoint;if(publicState.version!==1||!publicState.recipients)fail('missing public recipients.');const checkpointOwners=Object.keys(publicState.recipients),knownOwners=Object.keys(this.wallets),minimumOwners=this.env.stockOnly?(this.mode==='public'?0:1):2;if(checkpointOwners.length<minimumOwners||checkpointOwners.length>knownOwners.length||checkpointOwners.some((name,index)=>name!==knownOwners[index]))fail('recipient directory is not a registered append-only prefix.');for(const [name,recipient] of Object.entries(publicState.recipients))if(JSON.stringify(recipient)!==JSON.stringify(this.publicRecipients()[name]))fail('recipient profile mismatch.');}
  for(const [id,fp] of Object.entries(c.committed))if(!/^[0-9a-f]{24}$/.test(id)||!/^[0-9a-f]{64}$/.test(fp))fail('invalid committed settlement index.');if(Object.keys(c.committed).length!==c.receipts.length)fail('committed settlement count mismatch.');this.committedIds={...c.committed};
 }

 private requireOwner(owner:Owner){if(this.mode==='public'||(this.mode==='client'&&owner!==this.localOwner))throw new Error('Client spend authority is required.');}
 publicDescriptor():PublicRecipient {if(!this.localOwner)throw new Error('No client wallet.');return clone(this.publicRecipients()[this.localOwner]);}
 private publicRecipients():Record<Owner,PublicRecipient>{return Object.fromEntries(Object.keys(this.wallets).map(name=>[name,{owner:str(this.wallets[name].owner),viewPublicKey:this.wallets[name].publicKey.map(str)}])) as Record<Owner,PublicRecipient>;}
 setRecipients(recipients:Record<Owner,PublicRecipient>){
  const names=Object.keys(recipients);if((!names.length&&!(this.env.stockOnly&&this.mode==='public'))||names.some(name=>!isValidOwner(name)))throw new Error('Invalid public recipient identifier.');
  if(this.localOwner&&!Object.hasOwn(recipients,this.localOwner))throw new Error('Client recipient directory omits this wallet.');
  if(this.recipientDirectory){const priorNames=Object.keys(this.recipientDirectory);if(priorNames.some((name,index)=>names[index]!==name))throw new Error('Registered recipient directory changed: identities are append-only.');for(const [name,prior] of Object.entries(this.recipientDirectory))if(JSON.stringify(recipients[name])!==JSON.stringify(prior))throw new Error('Registered recipient directory changed: descriptors are immutable.');}
  const staged:Record<Owner,Wallet>={},owners=new Set<string>(),views=new Set<string>();
  for(const name of names){const r=recipients[name];if(!r||r.viewPublicKey?.length!==2)throw new Error('Invalid public recipient.');const owner=fieldValue(r.owner),publicKey=r.viewPublicKey.map(fieldValue);if(owner===0n||publicKey[0]===0n||!this.baby.inCurve(this.point(publicKey))||!this.baby.inSubgroup(this.point(publicKey)))throw new Error('Invalid public recipient subgroup.');const ownerKey=str(owner),viewKey=publicKey.map(str).join(':');if(owners.has(ownerKey)||views.has(viewKey))throw new Error('Duplicate public recipient key.');owners.add(ownerKey);views.add(viewKey);const existing=this.wallets[name];if(existing?.spend!==undefined&&existing.spend!==0n&&(owner!==existing.owner||publicKey.some((v,i)=>v!==existing.publicKey[i])))throw new Error('Client keys do not match the registered recipient.');if(existing?.spend===undefined&&this.mode==='client'&&name===this.localOwner)throw new Error('Client wallet is missing its private keys.');staged[name]={...(existing??{spend:0n,view:0n}),owner,publicKey};}
  this.wallets=staged;this.recipientDirectory=clone(recipients);
 }
 exportWalletKeys():WalletKeys {if(this.mode!=='client'||!this.localOwner)throw new Error('Client wallet keys are unavailable.');const w=this.wallets[this.localOwner];return {spend:str(w.spend),view:str(w.view)};}
 publicCheckpoint():PublicProtocolCheckpoint{return {version:1,domain:str(DOMAIN),profile:this.profileFingerprint(),state:clone(this.state),recipients:this.publicRecipients(),trees:{notes:this.noteTree.leaves.map(str),spent:this.spentTree.leaves.map(str),history:this.historyTree.leaves.map(str)},encryptedLog:clone(this.log),nullifiers:this.nfs.slice(),...(this.stockNullifiers?{stockNullifiers:this.stockNullifiers.checkpoint()}:{}),anchors:this.anchors.map(a=>({root:a.root,count:a.count,leaves:a.tree.leaves.map(str)})),receipts:clone(this.receipts),committed:{...this.committedIds}};}
 restorePublicCheckpoint(checkpoint:PublicProtocolCheckpoint){if(this.mode==='legacy')throw new Error('Public restoration requires client or public mode.');if('wallets' in checkpoint)throw new Error('Public archive must not contain wallet keys.');const previous=this.publicCheckpoint();try{this.loadCheckpoint(checkpoint);}catch(error){this.loadCheckpoint(previous);throw error;}}
 verificationKeys(){return clone(this.vkeys);}
 private validateAmount(amount:number){if(!Number.isSafeInteger(amount)||amount<=0||amount>=2**48)throw new Error('Amount must be a positive bounded 48-bit integer.');}
 private async prove(name:'intent'|'transition',witness:Record<string,unknown>){
  const started=performance.now();
  if(!this.env.proofs)throw new Error('The legacy intent/transition proof backend is not configured.');
  const result=await this.env.proofs.prove(name,witness,this.vkeys[name],str(DOMAIN));
  const descriptor=groth16Descriptor(name,this.vkeys[name],str(DOMAIN));
  if(!proofDescriptorMatches(this.env.proofs.describe(name,this.vkeys[name],str(DOMAIN)),descriptor))throw new Error('Proof provider is not compatible with the pinned Groth16 profile.');
  const expected=proofStatement(descriptor,result.publicSignals);
  if(!proofStatementMatches(expected,result.statement))throw new Error('Proof provider returned a statement for a different backend profile.');
  return {proof:result.proof as Groth16Proof,signals:result.publicSignals as string[],ms:performance.now()-started};
 }
 async prepareShield(owner:Owner,asset:Asset,amount:number){if(this.env.stockOnly)throw new Error('Use prepareStockShield for the stock-only profile.');this.validateAmount(amount);return this.makeIntent('shield',owner,owner,asset,amount) as Promise<PreparedSettlement>;}
 async prepareTransfer(from:Owner,to:Owner,asset:Asset,amount:number){if(this.env.stockOnly)throw new Error('Use prepareStockTransfer for the stock-only profile.');this.validateAmount(amount);return this.makeIntent('transfer',from,to,asset,amount) as Promise<PreparedSettlement>;}
 async prepareWithdraw(owner:Owner,asset:Asset,amount:number,destination:string){if(this.env.stockOnly)throw new Error('Use prepareStockWithdraw for the stock-only profile.');this.validateAmount(amount);return this.makeIntent('withdraw',owner,owner,asset,amount,destinationField(destination)) as Promise<PreparedSettlement>;}
 async prepareStockShield(owner:Owner,asset:Asset,amount:number){this.requireStockMode();this.validateAmount(amount);if(asset!=='BTC')throw new Error('The stock native profile supports BTC only.');return this.makeIntent('shield',owner,owner,asset,amount,'0',true) as Promise<StockPreparedSettlement>;}
 async prepareStockTransfer(from:Owner,to:Owner,asset:Asset,amount:number){this.requireStockMode();this.validateAmount(amount);if(asset!=='BTC')throw new Error('The stock native profile supports BTC only.');return this.makeIntent('transfer',from,to,asset,amount,'0',true) as Promise<StockPreparedSettlement>;}
 async prepareStockWithdraw(owner:Owner,asset:Asset,amount:number,destination:string){this.requireStockMode();this.validateAmount(amount);if(asset!=='BTC')throw new Error('The stock native profile supports BTC only.');return this.makeIntent('withdraw',owner,owner,asset,amount,destinationField(destination),true) as Promise<StockPreparedSettlement>;}
 async prepareStockSeal(){this.requireStockMode();return this.prepareStockApplication({operation:'seal',intentSignals:[str(DOMAIN),...Array(24).fill('0')],ciphertextRecords:[],boundary:{deposit:{BTC:0,DEMO:0},withdrawal:{BTC:0,DEMO:0},destination:'0'},intentMs:0});}
 private requireStockMode(){if(!this.env.stockOnly||!this.stockNullifiers||!this.env.stockProof)throw new Error('This client was not initialized with the pinned stock-only profile.');}
 private async makeIntent(operation:'shield'|'transfer'|'withdraw',from:Owner,to:Owner,asset:Asset,amount:number,destination='0',stockOnly=false){
  if(!isValidOwner(from)||!isValidOwner(to)||!this.wallets[from]||!this.wallets[to])throw new Error('Unknown public participant.');
  this.requireOwner(from);
  const input=operation==='shield'?undefined:this.recover(from).find(n=>n.asset===asset&&!n.spent&&n.spendable&&n.amount>=amount);
  if(operation!=='shield'&&!input)throw new Error(`No sealed ${asset} note covers this amount. Seal new receipts first; this profile consumes one note per intent.`);
  const anchor=input?this.anchors.findLast(a=>input.index<a.count):undefined;
  const nonce=rand(this.env.randomBytes);const randoms=[rand(this.env.randomBytes),rand(this.env.randomBytes)];const ephemeral=[rand(this.env.randomBytes)%this.baby.subOrder||1n,rand(this.env.randomBytes)%this.baby.subOrder||1n];
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
  if(stockOnly)return this.prepareStockApplication({operation,intentSignals:data,ciphertextRecords:records,boundary:{deposit,withdrawal,destination},intentMs:0,intentWitness:witness});
  const intent=await this.prove('intent',witness);
  return this.prepareApplication({operation,intentProof:intent.proof,intentSignals:intent.signals,ciphertextRecords:records,boundary:{deposit,withdrawal,destination},intentMs:intent.ms,intentWitness:witness});
 }
 private planApplication(args:{operation:PreparedSettlement['operation'];intentProof?:Groth16Proof;intentSignals:string[];ciphertextRecords:EncryptedRecord[];boundary:PreparedSettlement['boundary'];intentMs:number;intentWitness?:Record<string,unknown>}){
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
  const proofInput={data:transitionData,appendPaths,spentPath,historyPath,historyIndex,sealPath};
  return {oldState,newState,transitionData,proofInput,internal:{noteTree:notes,spentTree:spent,historyTree:history,anchor:seal?{root:oldState.noteRoot,tree:this.noteTree.clone(),count:oldState.noteCount}:undefined,records,intentWitness:args.intentWitness,stockTransitionWitness:proofInput}};
 }
 private planStockApplication(args:{operation:StockPreparedSettlement['operation'];intentSignals:string[];ciphertextRecords:EncryptedRecord[];boundary:StockPreparedSettlement['boundary'];intentMs:number;intentWitness?:Record<string,unknown>;appendOutputs?:boolean}){
  this.requireStockMode();
  if(args.intentSignals.length!==25||args.intentSignals[0]!==str(DOMAIN))throw new Error('Stock intent must contain the 25 canonical public signals.');
  const oldState=clone(this.state),notes=this.noteTree.clone(),history=this.historyTree.clone(),nfs=new IndexedNullifiers(this.hash,this.stockNullifiers!.checkpoint()),seal=args.operation==='seal',intentData=args.intentSignals.slice(0,19),nf=BigInt(intentData[2]);
  if(oldState.revision>=1023)throw new Error('Stock revision capacity exhausted.');
  let appendPaths=[Array(8).fill('0'),Array(8).fill('0')],historyPath=Array(8).fill('0'),sealPath=Array(8).fill('0'),lastSealPath=Array(8).fill('0'),historyIndex=0,proofNf:IndexedNullifierWitness=nfs.noopWitness();
  let nextNullifiers=nfs,anchor:Anchor|undefined;
  const records=args.ciphertextRecords.map((record,index)=>({...clone(record),index:oldState.noteCount+index,createdRevision:oldState.revision+1}));
  const lastAnchor=this.anchors.at(-1),lastSealedRoot=lastAnchor?.root??'0';if(lastAnchor)lastSealPath=this.historyTree.path(this.anchors.length-1);
  if(seal){
   if(oldState.noteCount===0||oldState.historyCount>=256||lastSealedRoot===oldState.noteRoot)throw new Error('There are no new notes to anchor.');
   sealPath=history.path(oldState.historyCount);history.set(oldState.historyCount,this.hash([DOMAIN,notes.root()]));anchor={root:oldState.noteRoot,tree:this.noteTree.clone(),count:oldState.noteCount};
  }else{
   if(args.ciphertextRecords.length!==2)throw new Error('Stock intent must carry its two encrypted output records.');
   if(nf!==0n){const inserted=nfs.insert(str(nf));nextNullifiers=inserted.next;proofNf=inserted.witness;historyIndex=this.anchors.findIndex(item=>item.root===intentData[1]);if(historyIndex<0)throw new Error('Stock spend anchor is not authenticated.');const anchored=this.anchors[historyIndex],inputBits=args.intentWitness?.inputBits as number[]|undefined;if(inputBits){const inputIndex=inputBits.reduce((n,bit,index)=>n+(bit<<index),0);if(!Number.isInteger(inputIndex)||inputIndex<0||inputIndex>=anchored.count)throw new Error('Stock input note is not included in its anchor.');}historyPath=history.path(historyIndex);}
   const amounts=args.intentWitness?.outputAmount as number[]|undefined;
   const append=args.appendOutputs??!(args.operation==='withdraw'&&amounts?.length===2&&amounts[0]===0&&amounts[1]===0);
   if(append){if(oldState.noteCount+2>256)throw new Error('Stock note capacity exhausted.');for(let i=0;i<2;i++){appendPaths[i]=notes.path(oldState.noteCount+i);notes.set(oldState.noteCount+i,BigInt(records[i].leaf));}}
  }
  const appends=!seal&&(args.appendOutputs??!(args.operation==='withdraw'&&(args.intentWitness?.outputAmount as number[]|undefined)?.every(amount=>amount===0)));
  const deposit=args.boundary.deposit.BTC,withdrawal=args.boundary.withdrawal.BTC;
  if(args.boundary.deposit.DEMO||args.boundary.withdrawal.DEMO||oldState.reserves.DEMO)throw new Error('The stock-only profile supports BTC backing only.');
  const newState={...oldState,noteRoot:str(notes.root()),spentRoot:str(nextNullifiers.root()),historyRoot:str(history.root()),noteCount:oldState.noteCount+(appends?2:0),historyCount:oldState.historyCount+(seal?1:0),revision:oldState.revision+1,reserves:{BTC:oldState.reserves.BTC+deposit-withdrawal,DEMO:0}};
  if(newState.reserves.BTC<0)throw new Error('Stock transition would undercollateralize the pool.');
  const transitionData=[...intentData,str(seal?1:0),oldState.noteRoot,newState.noteRoot,oldState.spentRoot,newState.spentRoot,oldState.historyRoot,newState.historyRoot,str(oldState.noteCount),str(newState.noteCount),str(oldState.historyCount),str(newState.historyCount)];
  const transitionWitness={data:transitionData,appendPaths,historyPath,historyIndex,sealPath,nfCount:proofNf.nfCount,nfPredecessorIndex:proofNf.nfPredecessorIndex,nfPredecessor:proofNf.nfPredecessor,nfPredecessorPath:proofNf.nfPredecessorPath,nfAppendPath:proofNf.nfAppendPath,lastSealedRoot,lastSealPath};
  const committedRecords=appends?records:[];
  return {oldState,newState,transitionData,publicRecords:records,internal:{noteTree:notes,historyTree:history,anchor,records:committedRecords,intentWitness:args.intentWitness,transitionWitness,nullifiers:nextNullifiers}};
 }
 private async prepareStockApplication(args:{operation:StockPreparedSettlement['operation'];intentSignals:string[];ciphertextRecords:EncryptedRecord[];boundary:StockPreparedSettlement['boundary'];intentMs:number;intentWitness?:Record<string,unknown>}):Promise<StockPreparedSettlement>{
  const plan=this.planStockApplication(args),prepared:StockPreparedSettlement={id:bytesToHex(this.env.randomBytes(12)),operation:args.operation,intentSignals:args.intentSignals,transitionSignals:plan.transitionData,oldState:plan.oldState,newState:plan.newState,ciphertextRecords:plan.publicRecords,boundary:args.boundary,proofTimes:{intentMs:args.intentMs,transitionMs:0}};
  this.stockInternals.set(prepared,plan.internal);return freeze(prepared);
 }
 private async prepareApplication(args:{operation:PreparedSettlement['operation'];intentProof?:Groth16Proof;intentSignals:string[];ciphertextRecords:EncryptedRecord[];boundary:PreparedSettlement['boundary'];intentMs:number;intentWitness?:Record<string,unknown>}){
  const plan=this.planApplication(args),proof=await this.prove('transition',plan.proofInput);
  const prepared:PreparedSettlement={id:bytesToHex(this.env.randomBytes(12)),operation:args.operation,intentProof:args.intentProof,transitionProof:proof.proof,intentSignals:args.intentSignals,transitionSignals:proof.signals,oldState:plan.oldState,newState:plan.newState,ciphertextRecords:plan.internal.records,boundary:args.boundary,proofTimes:{intentMs:args.intentMs,transitionMs:proof.ms}};
  this.internals.set(prepared,plan.internal);
  return freeze(prepared);
 }
 async restorePrepared(input:PreparedSettlement){
  if(this.env.stockOnly)throw new Error('Legacy settlements cannot be restored into the stock-only profile.');
  if(!input||typeof input.id!=='string'||! /^[0-9a-f]{24}$/.test(input.id)||!['shield','transfer','withdraw','seal'].includes(input.operation))throw new Error('Invalid prepared settlement.');
  for(const signals of [input.intentSignals,input.transitionSignals]){if(!Array.isArray(signals))throw new Error('Invalid public signals');signals.forEach(fieldValue);}
  const prepared=freeze(clone(input)),args={operation:prepared.operation,intentProof:prepared.intentProof,intentSignals:prepared.intentSignals,ciphertextRecords:prepared.ciphertextRecords,boundary:prepared.boundary,intentMs:prepared.proofTimes?.intentMs??0};
  if(!Array.isArray(args.intentSignals)||args.intentSignals.length!==25||!Array.isArray(args.ciphertextRecords)||!args.boundary||!prepared.proofTimes)throw new Error('Invalid prepared settlement payload.');
  if(!Number.isFinite(prepared.proofTimes.intentMs)||prepared.proofTimes.intentMs<0||!Number.isFinite(prepared.proofTimes.transitionMs)||prepared.proofTimes.transitionMs<0||!['BTC','DEMO'].every(a=>Number.isSafeInteger(args.boundary.deposit[a as Asset])&&args.boundary.deposit[a as Asset]>=0&&args.boundary.deposit[a as Asset]<2**48&&Number.isSafeInteger(args.boundary.withdrawal[a as Asset])&&args.boundary.withdrawal[a as Asset]>=0&&args.boundary.withdrawal[a as Asset]<2**48)||typeof args.boundary.destination!=='string')throw new Error('Invalid prepared settlement metadata.');fieldValue(args.boundary.destination);
  const expectedIndex=prepared.oldState?.noteCount,expectedRevision=(prepared.oldState?.revision??-1)+1;
  if(prepared.ciphertextRecords.some((r,i)=>r.index!==expectedIndex+i||r.createdRevision!==expectedRevision||r.ciphertext?.length!==7||r.commitment!==str(fieldValue(r.commitment))||r.ciphertext.some(v=>v!==str(fieldValue(v)))||r.leaf!==str(this.hash([fieldValue(r.commitment),...r.ciphertext.map(fieldValue)]))))throw new Error('Prepared settlement contains inconsistent encrypted records.');
  const plan=this.planApplication(args),expectedIntent=prepared.operation==='seal'?[str(DOMAIN),...Array(24).fill('0')]:[str(DOMAIN),prepared.intentSignals[1],prepared.intentSignals[2],...prepared.ciphertextRecords.map(r=>r.commitment),...prepared.ciphertextRecords.flatMap(r=>r.ciphertext),str(args.boundary.deposit.BTC),str(args.boundary.deposit.DEMO),str(args.boundary.withdrawal.BTC),str(args.boundary.withdrawal.DEMO),args.boundary.destination,prepared.intentSignals[24]];
  if(JSON.stringify(plan.oldState)!==JSON.stringify(prepared.oldState)||JSON.stringify(plan.newState)!==JSON.stringify(prepared.newState)||JSON.stringify(plan.transitionData)!==JSON.stringify(prepared.transitionSignals)||JSON.stringify(expectedIntent)!==JSON.stringify(prepared.intentSignals))throw new Error('Prepared settlement does not match the restored protocol state.');
  if(prepared.operation==='seal'&&(prepared.intentProof!==undefined||prepared.ciphertextRecords.length!==0||args.boundary.destination!=='0'||args.boundary.deposit.BTC!==0||args.boundary.deposit.DEMO!==0||args.boundary.withdrawal.BTC!==0||args.boundary.withdrawal.DEMO!==0))throw new Error('Invalid seal payload.');
  if(prepared.operation!=='seal'&&(!prepared.intentProof||prepared.ciphertextRecords.length!==2||prepared.intentSignals[0]!==str(DOMAIN)))throw new Error('Invalid intent payload.');
  if(!await this.verify(prepared))throw new Error('Prepared settlement proof verification failed.');
  this.internals.set(prepared,plan.internal);return prepared;
 }
 async prepareSeal(){if(this.env.stockOnly)throw new Error('Use prepareStockSeal for the stock-only profile.');return this.prepareApplication({operation:'seal',intentSignals:[str(DOMAIN),...Array(24).fill('0')],ciphertextRecords:[],boundary:{deposit:{BTC:0,DEMO:0},withdrawal:{BTC:0,DEMO:0},destination:'0'},intentMs:0});}
 private stockStateWitness(state:ProtocolState){return [state.noteRoot,state.spentRoot,state.historyRoot,str(state.noteCount),str(state.historyCount),str(state.revision),str(state.reserves.BTC),str(state.reserves.DEMO)];}
 private stockDummyIntentWitness():Record<string,unknown>{
  const ownerName=Object.keys(this.wallets)[0] as Owner|undefined;if(!ownerName)throw new Error('A public recipient is required to create the seal dummy intent.');
  const wallet=this.wallets[ownerName],nonce=3n,randoms=[1n,2n],ephemeral=[1n,2n],destination=0n,amounts=[0,0],owners=[ownerName,ownerName] as Owner[];
  const records=amounts.map((amount,index)=>{const rho=this.hash([DOMAIN,randoms[index],destination,nonce]),cm=this.hash([DOMAIN,BigInt(amount),0n,wallet.owner,rho]),ciphertext=this.encrypt(owners[index],amount,'BTC',rho,ephemeral[index]);return {rho,cm,ciphertext};});
  const data=[str(DOMAIN),'0','0',...records.map(record=>str(record.cm)),...records.flatMap(record=>record.ciphertext.map(str)),'0','0','0','0',str(destination),str(nonce)];
  const recipient=wallet.publicKey.map(str),preimage=this.baby.mulPointEscalar(this.point(wallet.publicKey),this.inverseEight()).map((x:any)=>str(BigInt(this.baby.F.toObject(x))));
  return {data,inputAmount:0,inputAsset:0,inputRho:'0',spendSecret:'1',inputCipher:Array(7).fill('0'),inputPath:Array(8).fill('0'),inputBits:Array(8).fill(0),outputAmount:amounts,outputAsset:[0,0],outputOwner:[str(wallet.owner),str(wallet.owner)],outputRandom:randoms.map(str),recipient:[recipient,recipient],recipientPreimage:[preimage,preimage],ephemeral:ephemeral.map(str)};
 }
 private validateStockBinding(prepared:Pick<PreparedSettlement,'operation'|'oldState'|'newState'|'boundary'>|Pick<StockPreparedSettlement,'operation'|'oldState'|'newState'|'boundary'>,binding:StockNativeBinding):StockOperation{
  const mode:StockOperation=prepared.operation==='shield'?'deposit':prepared.operation==='withdraw'?'withdraw':prepared.operation==='seal'?'seal':'transfer';
  if(binding.mode!==mode||JSON.stringify(binding.oldState)!==JSON.stringify(prepared.oldState)||JSON.stringify(binding.newState)!==JSON.stringify(prepared.newState))throw new Error('Stock native statement is for a different prepared settlement.');
  if(prepared.oldState.reserves.DEMO!==0||prepared.newState.reserves.DEMO!==0||prepared.boundary.deposit.DEMO!==0||prepared.boundary.withdrawal.DEMO!==0)throw new Error('The first stock native profile is BTC only.');
  const oldReserve=BigInt(prepared.oldState.reserves.BTC),newReserve=BigInt(prepared.newState.reserves.BTC),poolInput=BigInt(binding.poolInputBTC),continuation=BigInt(binding.continuationBTC),funding=BigInt(binding.externalFundingBTC??0),payout=BigInt(binding.payoutOrChangeBTC??0);
  if(continuation!==330n+newReserve)throw new Error('Stock continuation value does not match the proved BTC reserve.');
  if(mode==='deposit'){
   if(poolInput!==330n+oldReserve||funding<=0n||funding!==BigInt(prepared.boundary.deposit.BTC)||newReserve-oldReserve!==funding||poolInput+funding!==continuation+payout||payout!==0n||binding.externalProgram)throw new Error('Stock deposit must bind exact customer funding to the proved reserve.');
   if(prepared.boundary.withdrawal.BTC!==0)throw new Error('Stock deposit cannot include a payout.');
  }else{
   if(poolInput!==330n+oldReserve||funding<0n||(mode!=='withdraw'&&funding!==0n))throw new Error('Stock transaction does not spend the authenticated pool value.');
   if(mode==='withdraw'){
    if(payout<=0n||oldReserve-newReserve!==BigInt(prepared.boundary.withdrawal.BTC)||payout!==BigInt(prepared.boundary.withdrawal.BTC)+funding||!binding.externalProgram||destinationField(binding.externalProgram)!==prepared.boundary.destination)throw new Error('Stock withdrawal must bind the exact payout, external funding, and Taproot destination.');
    if(prepared.boundary.deposit.BTC!==0)throw new Error('Stock withdrawal cannot include external funding.');
   }else if(payout!==0n||binding.externalProgram||oldReserve!==newReserve||prepared.boundary.deposit.BTC!==0||prepared.boundary.withdrawal.BTC!==0){
    throw new Error(`Stock ${mode} cannot change native backing or add a payout.`);
   }
  }
  if(binding.assetPacket?.length)throw new Error('The first stock native profile cannot include an asset packet.');
  return mode;
 }
 async proveStock(prepared:PreparedSettlement|StockPreparedSettlement,binding:StockNativeBinding):Promise<StockSettlementProof>{
  if(this.mode!=='client'&&!(this.mode==='public'&&prepared.operation==='seal'))throw new Error('Stock settlement proofs must be produced by the client that holds the required private witness.');
  if(!this.env.stockProof)throw new Error('The stock combined Groth16 proving artifacts are not configured.');
  const stockPrepared=!('transitionProof' in prepared);if(this.env.stockOnly&&!stockPrepared)throw new Error('Stock-only clients accept only stock prepared settlements.');
  const stockInternal=stockPrepared?this.stockInternals.get(prepared):undefined,legacyInternal=stockPrepared?undefined:this.internals.get(prepared);if(stockPrepared?!stockInternal:!legacyInternal?.stockTransitionWitness)throw new Error('Stock proofs require the exact locally prepared settlement.');
  if(JSON.stringify(prepared.oldState)!==JSON.stringify(this.state))throw new Error('Stale stock settlement: reconcile and rebase it before proving.');
  const mode=this.validateStockBinding(prepared,binding),native=encodeStockNativeBinding(binding,this.hash),statement=stockStatementScalar(native).toString();
  const intent=prepared.operation==='seal'?this.stockDummyIntentWitness():(stockPrepared?stockInternal!.intentWitness:legacyInternal!.intentWitness);
  if(!intent)throw new Error('Client private intent witness is unavailable; restore the wallet before proving.');
  const intentData=intent.data as string[];
  if(!Array.isArray(intentData)||intentData.length!==25)throw new Error('Prepared stock intent witness is malformed.');
  if(prepared.operation!=='seal'&&JSON.stringify(intentData)!==JSON.stringify(prepared.intentSignals))throw new Error('Private stock intent no longer matches the prepared public statement.');
  const transition=stockPrepared?stockInternal!.transitionWitness:legacyInternal!.stockTransitionWitness!;
  const witness:Record<string,unknown>={
   native:Array.from(native),intentData,
   inputAmount:intent.inputAmount,inputAsset:intent.inputAsset,inputRho:intent.inputRho,spendSecret:intent.spendSecret,inputCipher:intent.inputCipher,inputPath:intent.inputPath,inputBits:intent.inputBits,
   outputAmount:intent.outputAmount,outputAsset:intent.outputAsset,outputOwner:intent.outputOwner,outputRandom:intent.outputRandom,recipient:intent.recipient,recipientPreimage:intent.recipientPreimage,ephemeral:intent.ephemeral,
   transitionData:transition.data,appendPaths:transition.appendPaths,historyPath:transition.historyPath,historyIndex:transition.historyIndex,sealPath:transition.sealPath,
   nfCount:transition.nfCount??0,nfPredecessorIndex:transition.nfPredecessorIndex??0,nfPredecessor:((transition.nfPredecessor as Array<string|number>|undefined)??['0','0','0']).map(value=>str(value)),nfPredecessorPath:transition.nfPredecessorPath??Array(9).fill('0'),nfAppendPath:transition.nfAppendPath??Array(9).fill('0'),lastSealedRoot:transition.lastSealedRoot??'0',lastSealPath:transition.lastSealPath??Array(8).fill('0'),
   oldState:this.stockStateWitness(prepared.oldState),newState:this.stockStateWitness(prepared.newState),
  };
  const verifierKey=this.env.stockVerifierKey,expectedDescriptor=stockProofDescriptor(verifierKey);
  if(!stockProofDescriptorMatches(this.env.stockProof.describe(verifierKey,STOCK_DOMAIN.toString()),expectedDescriptor))throw new Error('Stock prover verifier profile changed after initialization.');
  const result=await this.env.stockProof.prove(witness,verifierKey,STOCK_DOMAIN.toString());
  if(!result||!Array.isArray(result.publicSignals)||result.publicSignals.length!==1||result.publicSignals[0]!==statement)throw new Error('Stock prover returned a public statement that does not match the native transaction binding.');
  const envelope:StockSettlementProof={version:1,profile:'shielded-stock-btc-v1',descriptorProfileId:expectedDescriptor.profileId,operation:mode,nativeBinding:stockBindingHex(native),statement,publicSignals:[statement],proof:result.proof};
  const verifyStock=this.env.stockProof.verify;if(!verifyStock||!await verifyStock.call(this.env.stockProof,envelope,verifierKey,STOCK_DOMAIN.toString()))throw new Error('Stock prover returned a proof rejected by the pinned verifier.');
  if(stockPrepared)stockInternal!.proof=envelope;
  return envelope;
 }
 private stockBindingFor(prepared:StockPreparedSettlement,proof:StockSettlementProof):StockNativeBinding{
  const bytes=hexToBytes(proof.nativeBinding);if(bytes.length!==201)throw new Error('Stock proof has no canonical native binding.');
  const modes=['transfer','deposit','withdraw','seal'] as const,mode=modes[bytes[4]];if(!mode)throw new Error('Stock proof has an unknown operation.');
  const leValue=(start:number,length:number)=>{let n=0n;for(let i=length-1;i>=0;i--)n=(n<<8n)|BigInt(bytes[start+i]);return n;};
  const program=bytes.slice(137,169),hasProgram=program.some(value=>value!==0);
  return {mode,checkpointTxidLE:bytesToHex(bytes.slice(5,37)),checkpointVout:Number(leValue(37,4)),oldState:prepared.oldState,newState:prepared.newState,poolInputBTC:leValue(105,8),continuationBTC:leValue(113,8),externalFundingBTC:leValue(121,8),payoutOrChangeBTC:leValue(129,8),...(hasProgram?{externalProgram:bytesToHex(program)}:{})};
 }
 private async verifyStockSettlement(prepared:StockPreparedSettlement,proof:StockSettlementProof):Promise<void>{
  this.requireStockMode();if(prepared.operation==='seal'?proof.operation!=='seal':proof.operation!==(prepared.operation==='shield'?'deposit':prepared.operation))throw new Error('Stock proof does not match the prepared operation.');
  const binding=this.stockBindingFor(prepared,proof),canonical=encodeStockNativeBinding(binding,this.hash);
  if(stockBindingHex(canonical)!==proof.nativeBinding)throw new Error('Stock proof metadata does not bind to this prepared transition.');
  this.validateStockBinding(prepared,binding);
  const verify=this.env.stockProof!.verify;if(!verify||!await verify.call(this.env.stockProof,proof,this.env.stockVerifierKey,STOCK_DOMAIN.toString()))throw new Error('Stock proof was rejected by the pinned verifier.');
 }
 async restoreStockPrepared(input:StockPreparedSettlement,proof:StockSettlementProof):Promise<StockPreparedSettlement>{
  this.requireStockMode();if(!input||typeof input.id!=='string'||!/^[0-9a-f]{24}$/.test(input.id)||!['shield','transfer','withdraw','seal'].includes(input.operation))throw new Error('Invalid stock prepared settlement.');
  if(input.intentSignals?.length!==25||input.transitionSignals?.length!==30||!Array.isArray(input.ciphertextRecords)||!input.oldState||!input.newState||!input.boundary||!input.proofTimes)throw new Error('Invalid stock prepared payload.');
  input.intentSignals.forEach(fieldValue);input.transitionSignals.forEach(fieldValue);
  if(JSON.stringify(input.oldState)!==JSON.stringify(this.state))throw new Error('Stock prepared settlement is stale; reconcile and rebase before restoring.');
  if(!Number.isFinite(input.proofTimes.intentMs)||input.proofTimes.intentMs<0||!Number.isFinite(input.proofTimes.transitionMs)||input.proofTimes.transitionMs<0)throw new Error('Invalid stock proof timing metadata.');
  const seal=input.operation==='seal';if((seal&&input.ciphertextRecords.length!==0)||(!seal&&input.ciphertextRecords.length!==2))throw new Error('Stock prepared settlement has the wrong encrypted record count.');
  for(const [index,record] of input.ciphertextRecords.entries())if(record.index!==input.oldState.noteCount+index||record.createdRevision!==input.oldState.revision+1||record.ciphertext?.length!==7||record.commitment!==str(fieldValue(record.commitment))||record.ciphertext.some(value=>value!==str(fieldValue(value)))||record.leaf!==str(this.hash([fieldValue(record.commitment),...record.ciphertext.map(fieldValue)])))throw new Error('Stock prepared settlement contains an invalid encrypted record.');
  for(const asset of ['BTC','DEMO'] as const)for(const amount of [input.boundary.deposit?.[asset],input.boundary.withdrawal?.[asset]])if(!Number.isSafeInteger(amount)||amount!<0||amount!>=2**48)throw new Error('Stock prepared settlement has an invalid native boundary amount.');
  fieldValue(input.boundary.destination);
  if(seal&&(input.intentSignals.some((value,index)=>index>0&&value!=='0')||input.boundary.destination!=='0'||input.boundary.deposit.BTC!==0||input.boundary.deposit.DEMO!==0||input.boundary.withdrawal.BTC!==0||input.boundary.withdrawal.DEMO!==0))throw new Error('Invalid stock seal payload.');
  const expectedIntent=seal?[str(DOMAIN),...Array(24).fill('0')]:[str(DOMAIN),input.intentSignals[1],input.intentSignals[2],...input.ciphertextRecords.map(record=>record.commitment),...input.ciphertextRecords.flatMap(record=>record.ciphertext),str(input.boundary.deposit.BTC),str(input.boundary.deposit.DEMO),str(input.boundary.withdrawal.BTC),str(input.boundary.withdrawal.DEMO),input.boundary.destination,input.intentSignals[24]];
  if(JSON.stringify(expectedIntent)!==JSON.stringify(input.intentSignals))throw new Error('Stock encrypted records do not match the public intent signals.');
  const appended=seal?false:input.newState.noteCount===input.oldState.noteCount+2;
  if(!seal&&input.newState.noteCount!==input.oldState.noteCount+(appended?2:0))throw new Error('Stock prepared settlement has an invalid note count change.');
  const args={operation:input.operation,intentSignals:input.intentSignals,ciphertextRecords:input.ciphertextRecords,boundary:input.boundary,intentMs:input.proofTimes.intentMs,appendOutputs:appended};
  const plan=this.planStockApplication(args);
  if(JSON.stringify(plan.oldState)!==JSON.stringify(input.oldState)||JSON.stringify(plan.newState)!==JSON.stringify(input.newState)||JSON.stringify(plan.transitionData)!==JSON.stringify(input.transitionSignals))throw new Error('Stock prepared settlement does not match the restored accumulator state.');
  const prepared=freeze(clone(input));await this.verifyStockSettlement(prepared,proof);this.stockInternals.set(prepared,{...plan.internal,proof});return prepared;
 }
 async commitStock(prepared:StockPreparedSettlement,proof:StockSettlementProof,receipt:unknown):Promise<ProtocolSnapshot>{
  this.requireStockMode();const fingerprint=hashHex(JSON.stringify(prepared)),known=this.committedIds[prepared.id];if(known){if(known!==fingerprint)throw new Error('Stock settlement ID was already committed with a different payload.');return this.snapshot();}
  const internal=this.stockInternals.get(prepared);if(!internal)throw new Error('Unknown stock prepared settlement; restore it with its verified proof first.');
  if(JSON.stringify(prepared.oldState)!==JSON.stringify(this.state))throw new Error('Stock settlement is stale; reconcile and rebase before commit.');
  if(internal.proof&&internal.proof.nativeBinding!==proof.nativeBinding)throw new Error('Stock proof changed after the native transaction was prepared.');
  await this.verifyStockSettlement(prepared,proof);
  if(JSON.stringify(prepared.oldState)!==JSON.stringify(this.state))throw new Error('Stock settlement became stale before commit.');
  this.noteTree=internal.noteTree;this.historyTree=internal.historyTree;this.stockNullifiers=internal.nullifiers;this.state=clone(prepared.newState);this.log.push(...clone(internal.records));
  if(prepared.intentSignals[2]!=='0')this.nfs.push(prepared.intentSignals[2]);if(internal.anchor)this.anchors.push(internal.anchor);
  this.receipts.push(clone(receipt));this.committedIds[prepared.id]=fingerprint;this.stockCommitted.set(prepared,fingerprint);return this.snapshot();
 }
 async rebaseStock(prepared:StockPreparedSettlement):Promise<StockPreparedSettlement>{
  this.requireStockMode();if(prepared.operation==='seal')return this.prepareStockSeal();
  const internal=this.stockInternals.get(prepared);if(!internal?.intentWitness)throw new Error('Client private intent witness is unavailable; restore the wallet before rebasing.');
  return this.prepareStockApplication({operation:prepared.operation,intentSignals:prepared.intentSignals,ciphertextRecords:prepared.ciphertextRecords,boundary:prepared.boundary,intentMs:0,intentWitness:internal.intentWitness});
 }
 async rebase(prepared:PreparedSettlement){const internal=this.internals.get(prepared);if(!internal)throw new Error('Unknown prepared settlement.');return this.prepareApplication({operation:prepared.operation,intentProof:prepared.intentProof,intentSignals:prepared.intentSignals,ciphertextRecords:prepared.ciphertextRecords,boundary:prepared.boundary,intentMs:0,intentWitness:internal.intentWitness});}
 async verify(prepared:PreparedSettlement){
  if(prepared.intentSignals.length!==25||prepared.transitionSignals.length!==30)return false;
  if(prepared.intentSignals.slice(0,19).some((v,i)=>v!==prepared.transitionSignals[i]))return false;
  try{
   const intentDescriptor=groth16Descriptor('intent',this.vkeys.intent,str(DOMAIN)),transitionDescriptor=groth16Descriptor('transition',this.vkeys.transition,str(DOMAIN));
   if(!this.env.proofs)return false;
   if(!proofDescriptorMatches(this.env.proofs.describe('intent',this.vkeys.intent,str(DOMAIN)),intentDescriptor)||!proofDescriptorMatches(this.env.proofs.describe('transition',this.vkeys.transition,str(DOMAIN)),transitionDescriptor))return false;
   if(prepared.operation!=='seal'&&(!prepared.intentProof||!await this.env.proofs.verify(proofStatement(intentDescriptor,prepared.intentSignals),prepared.intentProof,this.vkeys.intent,str(DOMAIN))))return false;
   return await this.env.proofs.verify(proofStatement(transitionDescriptor,prepared.transitionSignals),prepared.transitionProof,this.vkeys.transition,str(DOMAIN));
  }catch{return false;}
 }
 async commit(prepared:PreparedSettlement,receipt:unknown){
  if(this.env.stockOnly)throw new Error('Legacy settlements cannot commit into the stock-only profile.');
  const fingerprint=this.fingerprint(prepared),known=this.committedIds[prepared.id];if(known){if(known!==fingerprint)throw new Error('Settlement ID was already committed with a different payload.');return this.snapshot();}
  const internal=this.internals.get(prepared);if(!internal)throw new Error('Unknown prepared settlement.');
  if(this.committed.has(prepared))return this.snapshot();
  if(JSON.stringify(prepared.oldState)!==JSON.stringify(this.state))throw new Error('Stale settlement: regenerate the public-state proof; private intent remains reusable.');
  if(!await this.verify(prepared))throw new Error('Proof verification failed.');
  if(this.committed.has(prepared))return this.snapshot();
  if(JSON.stringify(prepared.oldState)!==JSON.stringify(this.state))throw new Error('Stale settlement: regenerate the public-state proof; private intent remains reusable.');
  const nextState=clone(prepared.newState),records=clone(internal.records),savedReceipt=clone(receipt);
  this.noteTree=internal.noteTree;this.spentTree=internal.spentTree;this.historyTree=internal.historyTree;this.state=nextState;
  this.log.push(...records);if(prepared.intentSignals[2]!=='0')this.nfs.push(prepared.intentSignals[2]);if(internal.anchor)this.anchors.push(internal.anchor);
  this.receipts.push(savedReceipt);this.committed.add(prepared);this.committedIds[prepared.id]=fingerprint;return this.snapshot();
 }
}
