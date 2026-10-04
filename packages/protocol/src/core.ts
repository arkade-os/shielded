import {isValidOwner,LEGACY_OWNERS,type Asset, type Owner, type Groth16Proof, type ProtocolState, type EncryptedRecord, type PreparedSettlement, type OwnedNote, type ProtocolSnapshot, type ProtocolKernel, type ProtocolCheckpoint} from './types.js';
export * from './types.js';
import {groth16Descriptor,proofDescriptorMatches,proofStatement,proofStatementMatches,type ProofBackend} from './proofs.js';
export * from './proofs.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { PublicProtocolCheckpoint, PublicRecipient, ClientProtocolKernel, WalletKeys } from './types.js';
export const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const DOMAIN = 20260930001n;
export const INTENT_SIGNAL_COUNT = 25;
export const TRANSITION_SIGNAL_COUNT = 30;
const ASSETS: Asset[] = ['BTC','DEMO'];
export interface ProtocolEnvironment { randomBytes(length:number):Uint8Array; vkeys:Record<string,any>; proofs:ProofBackend<Groth16Proof>; }
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
interface Internal {noteTree:Tree;spentTree:Tree;historyTree:Tree;anchor?:Anchor;records:EncryptedRecord[];intentWitness?:Record<string,unknown>}
export class Kernel implements ClientProtocolKernel {
 private noteTree:Tree; private spentTree:Tree; private historyTree:Tree;
 private state:ProtocolState; private wallets:Record<Owner,Wallet>; private log:EncryptedRecord[]=[]; private nfs:string[]=[];
 private anchors:Anchor[]=[]; private receipts:unknown[]=[]; private internals=new WeakMap<PreparedSettlement,Internal>(); private committed=new WeakSet<PreparedSettlement>(); private committedIds:Record<string,string>={};
 private vkeys:Record<string,any>; private recipientDirectory?:Record<Owner,PublicRecipient>;
 constructor(private poseidon:any,private baby:any,private env:ProtocolEnvironment,private mode:'legacy'|'client'|'public'='legacy',private localOwner?:Owner,keys?:WalletKeys,recipients?:Record<Owner,PublicRecipient>,secureKeys=false){
  if(this.localOwner!==undefined&&!isValidOwner(this.localOwner))throw new Error('Invalid client participant identifier.');
  if(env.proofs.id!=='groth16-bn254'||env.proofs.version!==1)throw new Error('This native protocol profile accepts only the pinned Groth16 BN254 backend.');
  this.noteTree=new Tree(this.hash);this.spentTree=new Tree(this.hash);this.historyTree=new Tree(this.hash);
  this.state={noteRoot:str(this.noteTree.root()),spentRoot:str(this.spentTree.root()),historyRoot:str(this.historyTree.root()),noteCount:0,historyCount:0,revision:0,reserves:{BTC:0,DEMO:0}};
  const owners=this.mode==='legacy'?[...LEGACY_OWNERS] as Owner[]:[...new Set([...(recipients?Object.keys(recipients):[]),...(this.localOwner?[this.localOwner]:[])])];
  this.wallets=Object.fromEntries(owners.map(name=>{
   const derive=(tag:string)=>BigInt('0x'+hashHex(`SHIELDED-POC-INSECURE-DEMO-KEY:${name}:${tag}`))%this.baby.subOrder||1n;
   const randomScalar=()=>BigInt('0x'+bytesToHex(this.env.randomBytes(32)))%this.baby.subOrder||1n;
   if(this.mode!=='legacy'&&name!==this.localOwner){const r=recipients?.[name];return [name,{spend:0n,view:0n,publicKey:r?r.viewPublicKey.map(BigInt):[0n,1n],owner:r?BigInt(r.owner):0n}];}
   const spend=keys?fieldValue(keys.spend):(this.mode==='client'||secureKeys?randomScalar():derive('spend')),view=keys?fieldValue(keys.view):(this.mode==='client'||secureKeys?randomScalar():derive('view'));if(spend<=0n||view<=0n||spend>=this.baby.subOrder||view>=this.baby.subOrder)throw new Error('Invalid client wallet scalar.');const publicKey=this.baby.mulPointEscalar(this.baby.Base8,view).map((x:any)=>BigInt(this.baby.F.toObject(x)));
   return [name,{spend,view,publicKey,owner:this.hash([DOMAIN,spend])}];
  })) as Record<Owner,Wallet>;
  this.vkeys=clone(this.env.vkeys);for(const name of ['intent','transition'] as const)if(!proofDescriptorMatches(this.env.proofs.describe(name,this.vkeys[name],str(DOMAIN)),groth16Descriptor(name,this.vkeys[name],str(DOMAIN))))throw new Error('Proof provider does not match the pinned Groth16 verifier profile.');if(recipients)this.setRecipients(recipients);if(this.mode==='public'&&!Object.keys(recipients??{}).length)throw new Error('Public coordinator requires registered recipient descriptors.');
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
  return {state:clone(this.state),wallets,encryptedLog:clone(this.log),nullifiers:this.nfs.slice(),anchors:this.anchors.map(a=>a.root),profile:{treeDepth:8,noteCapacity:256,nullifierCapacity:256,intentPublicSignals:25,transitionPublicSignals:30},receipts:clone(this.receipts)};
 }
 private profileFingerprint(){return protocolProfileFingerprint(this.vkeys);}
 exportState():ProtocolCheckpoint{if(this.mode!=='legacy')throw new Error('Use publicCheckpoint and client wallet backup separately.');return {version:1,domain:str(DOMAIN),profile:this.profileFingerprint(),state:clone(this.state),wallets:{alice:{spend:str(this.wallets.alice.spend),view:str(this.wallets.alice.view)},bob:{spend:str(this.wallets.bob.spend),view:str(this.wallets.bob.view)}},trees:{notes:this.noteTree.leaves.map(str),spent:this.spentTree.leaves.map(str),history:this.historyTree.leaves.map(str)},encryptedLog:clone(this.log),nullifiers:this.nfs.slice(),anchors:this.anchors.map(a=>({root:a.root,count:a.count,leaves:a.tree.leaves.map(str)})),receipts:clone(this.receipts),committed:{...this.committedIds}};}
 private fingerprint(p:PreparedSettlement){return hashHex(JSON.stringify(p));}
 restoreCheckpoint(c:ProtocolCheckpoint){this.loadCheckpoint(c);}
 private loadCheckpoint(c:ProtocolCheckpoint|PublicProtocolCheckpoint){
  const fail=(s:string):never=>{throw new Error(`Invalid protocol checkpoint: ${s}`);};
  if(!c||c.version!==1||c.domain!==str(DOMAIN)||c.profile!==this.profileFingerprint())fail('version, domain, or proof profile mismatch.');
  const field=(v:unknown):bigint=>{try{return fieldValue(v);}catch{return fail('non-canonical or out-of-range field encoding.');}};
  const leaves=(a:unknown):bigint[]=>{if(!Array.isArray(a)||a.length!==256)fail('tree leaf count mismatch.');return (a as unknown[]).map(field);};
  if(!c.state||!Number.isSafeInteger(c.state.noteCount)||c.state.noteCount<0||c.state.noteCount>256||!Number.isSafeInteger(c.state.historyCount)||c.state.historyCount<0||c.state.historyCount>256||!Number.isSafeInteger(c.state.revision)||c.state.revision!==c.state.noteCount/2+c.state.historyCount)fail('invalid state counts.');
  for(const n of [c.state.reserves?.BTC,c.state.reserves?.DEMO])if(!Number.isSafeInteger(n)||n<0)fail('invalid reserve.');
  const noteLeaves=leaves(c.trees?.notes),spentLeaves=leaves(c.trees?.spent),historyLeaves=leaves(c.trees?.history);
  this.noteTree=new Tree(this.hash,noteLeaves);this.spentTree=new Tree(this.hash,spentLeaves);this.historyTree=new Tree(this.hash,historyLeaves);
  this.state=clone(c.state);
  if(this.state.noteRoot!==str(this.noteTree.root())||this.state.spentRoot!==str(this.spentTree.root())||this.state.historyRoot!==str(this.historyTree.root()))fail('tree root mismatch.');
  if(this.state.noteCount%2!==0||!Array.isArray(c.encryptedLog)||c.encryptedLog.length!==this.state.noteCount||c.encryptedLog.some((r,i)=>!r||r.index!==i||r.createdRevision<1||r.createdRevision>this.state.revision||r.createdRevision<(i?c.encryptedLog[i-1].createdRevision:1)||(i%2===1&&r.createdRevision!==c.encryptedLog[i-1].createdRevision)||r.ciphertext?.length!==7||r.commitment!==str(field(r.commitment))||r.ciphertext.some(x=>x!==str(field(x)))||r.leaf!==str(this.hash([field(r.commitment),...r.ciphertext.map(field)]))))fail('encrypted record log mismatch.');
  this.log=clone(c.encryptedLog);
  if(noteLeaves.some((v,i)=>v!==(i<this.log.length?BigInt(this.log[i].leaf):0n)))fail('note tree does not match encrypted log.');
  if(!Array.isArray(c.nullifiers)||c.nullifiers.some(n=>n!==str(field(n))||n==='0')||new Set(c.nullifiers).size!==c.nullifiers.length)fail('invalid nullifier list.');
  this.nfs=c.nullifiers.slice();const expectedSpent=Array(256).fill(0n);for(const nf of this.nfs){const slot=Number(BigInt(nf)&255n);if(expectedSpent[slot]!==0n)fail('nullifier slot collision.');expectedSpent[slot]=BigInt(nf);}if(expectedSpent.some((n,i)=>n!==spentLeaves[i]))fail('nullifier tree/list mismatch.');
  if(!Array.isArray(c.anchors)||c.anchors.length!==this.state.historyCount)fail('anchor count mismatch.');
  this.anchors=c.anchors.map((a,i)=>{if(!a||!Number.isSafeInteger(a.count)||a.count<0||a.count>this.state.noteCount||a.root!==str(field(a.root)))fail('invalid anchor.');const historical=leaves(a.leaves);const tree=new Tree(this.hash,historical);if(tree.root()!==BigInt(a.root))fail('anchor root mismatch.');for(let j=0;j<256;j++){const expected=j<a.count?BigInt(this.log[j]?.leaf??'0'):0n;if(historical[j]!==expected)fail('anchor leaves do not match log prefix.');}if(historyLeaves[i]!==this.hash([DOMAIN,BigInt(a.root)]))fail('anchor history leaf mismatch.');return {root:a.root,tree,count:a.count};});
  if(!Array.isArray(c.receipts)||c.receipts.length!==c.state.revision)fail('receipt count mismatch.');this.receipts=clone(c.receipts);
  if(!c.committed||typeof c.committed!=='object')fail('missing wallet or commit data.');
  if(this.mode==='legacy'){if(!(c as ProtocolCheckpoint).wallets)fail('missing legacy wallet keys.');
  this.wallets=Object.fromEntries(LEGACY_OWNERS.map(name=>{const keys=(c as ProtocolCheckpoint).wallets[name];if(!keys)fail('missing legacy wallet key.');const spend=field(keys.spend),view=field(keys.view);if(spend<=0n||spend>=this.baby.subOrder||view<=0n||view>=this.baby.subOrder)fail('wallet scalar outside subgroup order.');const publicKey=this.baby.mulPointEscalar(this.baby.Base8,view).map((x:any)=>BigInt(this.baby.F.toObject(x)));if(!this.baby.inSubgroup(this.point(publicKey)))fail('wallet view key is invalid.');return [name,{spend,view,publicKey,owner:this.hash([DOMAIN,spend])}];})) as Record<Owner,Wallet>;
  const knownNullifiers=new Set<string>();for(const record of this.log)if(this.anchors.some(a=>record.index<a.count)){for(const owner of LEGACY_OWNERS){const note=this.decrypt(owner,record);if(note&&note.amount>0)knownNullifiers.add(str(this.hash([DOMAIN,this.wallets[owner].spend,BigInt(note.rho)])));}}if(this.nfs.some(nf=>!knownNullifiers.has(nf)))fail('nullifier has no recoverable sealed note.');
  }else{const publicState=c as PublicProtocolCheckpoint;if(publicState.version!==1||!publicState.recipients)fail('missing public recipients.');const checkpointOwners=Object.keys(publicState.recipients),knownOwners=Object.keys(this.wallets);if(checkpointOwners.length<2||checkpointOwners.length>knownOwners.length||checkpointOwners.some((name,index)=>name!==knownOwners[index]))fail('recipient directory is not a registered append-only prefix.');for(const [name,recipient] of Object.entries(publicState.recipients))if(JSON.stringify(recipient)!==JSON.stringify(this.publicRecipients()[name]))fail('recipient profile mismatch.');}
  for(const [id,fp] of Object.entries(c.committed))if(!/^[0-9a-f]{24}$/.test(id)||!/^[0-9a-f]{64}$/.test(fp))fail('invalid committed settlement index.');if(Object.keys(c.committed).length!==c.receipts.length)fail('committed settlement count mismatch.');this.committedIds={...c.committed};
 }

 private requireOwner(owner:Owner){if(this.mode==='public'||(this.mode==='client'&&owner!==this.localOwner))throw new Error('Client spend authority is required.');}
 publicDescriptor():PublicRecipient {if(!this.localOwner)throw new Error('No client wallet.');return clone(this.publicRecipients()[this.localOwner]);}
 private publicRecipients():Record<Owner,PublicRecipient>{return Object.fromEntries(Object.keys(this.wallets).map(name=>[name,{owner:str(this.wallets[name].owner),viewPublicKey:this.wallets[name].publicKey.map(str)}])) as Record<Owner,PublicRecipient>;}
 setRecipients(recipients:Record<Owner,PublicRecipient>){
  const names=Object.keys(recipients);if(!names.length||names.some(name=>!isValidOwner(name)))throw new Error('Invalid public recipient identifier.');
  if(this.localOwner&&!Object.hasOwn(recipients,this.localOwner))throw new Error('Client recipient directory omits this wallet.');
  if(this.recipientDirectory){const priorNames=Object.keys(this.recipientDirectory);if(priorNames.some((name,index)=>names[index]!==name))throw new Error('Registered recipient directory changed: identities are append-only.');for(const [name,prior] of Object.entries(this.recipientDirectory))if(JSON.stringify(recipients[name])!==JSON.stringify(prior))throw new Error('Registered recipient directory changed: descriptors are immutable.');}
  const staged:Record<Owner,Wallet>={},owners=new Set<string>(),views=new Set<string>();
  for(const name of names){const r=recipients[name];if(!r||r.viewPublicKey?.length!==2)throw new Error('Invalid public recipient.');const owner=fieldValue(r.owner),publicKey=r.viewPublicKey.map(fieldValue);if(owner===0n||publicKey[0]===0n||!this.baby.inCurve(this.point(publicKey))||!this.baby.inSubgroup(this.point(publicKey)))throw new Error('Invalid public recipient subgroup.');const ownerKey=str(owner),viewKey=publicKey.map(str).join(':');if(owners.has(ownerKey)||views.has(viewKey))throw new Error('Duplicate public recipient key.');owners.add(ownerKey);views.add(viewKey);const existing=this.wallets[name];if(existing?.spend!==undefined&&existing.spend!==0n&&(owner!==existing.owner||publicKey.some((v,i)=>v!==existing.publicKey[i])))throw new Error('Client keys do not match the registered recipient.');if(existing?.spend===undefined&&this.mode==='client'&&name===this.localOwner)throw new Error('Client wallet is missing its private keys.');staged[name]={...(existing??{spend:0n,view:0n}),owner,publicKey};}
  this.wallets=staged;this.recipientDirectory=clone(recipients);
 }
 exportWalletKeys():WalletKeys {if(this.mode!=='client'||!this.localOwner)throw new Error('Client wallet keys are unavailable.');const w=this.wallets[this.localOwner];return {spend:str(w.spend),view:str(w.view)};}
 publicCheckpoint():PublicProtocolCheckpoint{return {version:1,domain:str(DOMAIN),profile:this.profileFingerprint(),state:clone(this.state),recipients:this.publicRecipients(),trees:{notes:this.noteTree.leaves.map(str),spent:this.spentTree.leaves.map(str),history:this.historyTree.leaves.map(str)},encryptedLog:clone(this.log),nullifiers:this.nfs.slice(),anchors:this.anchors.map(a=>({root:a.root,count:a.count,leaves:a.tree.leaves.map(str)})),receipts:clone(this.receipts),committed:{...this.committedIds}};}
 restorePublicCheckpoint(checkpoint:PublicProtocolCheckpoint){if(this.mode==='legacy')throw new Error('Public restoration requires client or public mode.');if('wallets' in checkpoint)throw new Error('Public archive must not contain wallet keys.');const previous=this.publicCheckpoint();try{this.loadCheckpoint(checkpoint);}catch(error){this.loadCheckpoint(previous);throw error;}}
 verificationKeys(){return clone(this.vkeys);}
 private validateAmount(amount:number){if(!Number.isSafeInteger(amount)||amount<=0||amount>=2**48)throw new Error('Amount must be a positive bounded 48-bit integer.');}
 private async prove(name:'intent'|'transition',witness:Record<string,unknown>){
  const started=performance.now();
  const result=await this.env.proofs.prove(name,witness,this.vkeys[name],str(DOMAIN));
  const descriptor=groth16Descriptor(name,this.vkeys[name],str(DOMAIN));
  if(!proofDescriptorMatches(this.env.proofs.describe(name,this.vkeys[name],str(DOMAIN)),descriptor))throw new Error('Proof provider is not compatible with the pinned Groth16 profile.');
  const expected=proofStatement(descriptor,result.publicSignals);
  if(!proofStatementMatches(expected,result.statement))throw new Error('Proof provider returned a statement for a different backend profile.');
  return {proof:result.proof as Groth16Proof,signals:result.publicSignals as string[],ms:performance.now()-started};
 }
 async prepareShield(owner:Owner,asset:Asset,amount:number){this.validateAmount(amount);return this.makeIntent('shield',owner,owner,asset,amount);}
 async prepareTransfer(from:Owner,to:Owner,asset:Asset,amount:number){this.validateAmount(amount);return this.makeIntent('transfer',from,to,asset,amount);}
 async prepareWithdraw(owner:Owner,asset:Asset,amount:number,destination:string){this.validateAmount(amount);return this.makeIntent('withdraw',owner,owner,asset,amount,destinationField(destination));}
 private async makeIntent(operation:'shield'|'transfer'|'withdraw',from:Owner,to:Owner,asset:Asset,amount:number,destination='0'){
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
  return {oldState,newState,transitionData,proofInput:{data:transitionData,appendPaths,spentPath,historyPath,historyIndex,sealPath},internal:{noteTree:notes,spentTree:spent,historyTree:history,anchor:seal?{root:oldState.noteRoot,tree:this.noteTree.clone(),count:oldState.noteCount}:undefined,records,intentWitness:args.intentWitness}};
 }
 private async prepareApplication(args:{operation:PreparedSettlement['operation'];intentProof?:Groth16Proof;intentSignals:string[];ciphertextRecords:EncryptedRecord[];boundary:PreparedSettlement['boundary'];intentMs:number;intentWitness?:Record<string,unknown>}){
  const plan=this.planApplication(args),proof=await this.prove('transition',plan.proofInput);
  const prepared:PreparedSettlement={id:bytesToHex(this.env.randomBytes(12)),operation:args.operation,intentProof:args.intentProof,transitionProof:proof.proof,intentSignals:args.intentSignals,transitionSignals:proof.signals,oldState:plan.oldState,newState:plan.newState,ciphertextRecords:plan.internal.records,boundary:args.boundary,proofTimes:{intentMs:args.intentMs,transitionMs:proof.ms}};
  this.internals.set(prepared,plan.internal);
  return freeze(prepared);
 }
 async restorePrepared(input:PreparedSettlement){
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
 async prepareSeal(){return this.prepareApplication({operation:'seal',intentSignals:[str(DOMAIN),...Array(24).fill('0')],ciphertextRecords:[],boundary:{deposit:{BTC:0,DEMO:0},withdrawal:{BTC:0,DEMO:0},destination:'0'},intentMs:0});}
 async rebase(prepared:PreparedSettlement){const internal=this.internals.get(prepared);if(!internal)throw new Error('Unknown prepared settlement.');return this.prepareApplication({operation:prepared.operation,intentProof:prepared.intentProof,intentSignals:prepared.intentSignals,ciphertextRecords:prepared.ciphertextRecords,boundary:prepared.boundary,intentMs:0,intentWitness:internal.intentWitness});}
 async verify(prepared:PreparedSettlement){
  if(prepared.intentSignals.length!==25||prepared.transitionSignals.length!==30)return false;
  if(prepared.intentSignals.slice(0,19).some((v,i)=>v!==prepared.transitionSignals[i]))return false;
  try{
   const intentDescriptor=groth16Descriptor('intent',this.vkeys.intent,str(DOMAIN)),transitionDescriptor=groth16Descriptor('transition',this.vkeys.transition,str(DOMAIN));
   if(!proofDescriptorMatches(this.env.proofs.describe('intent',this.vkeys.intent,str(DOMAIN)),intentDescriptor)||!proofDescriptorMatches(this.env.proofs.describe('transition',this.vkeys.transition,str(DOMAIN)),transitionDescriptor))return false;
   if(prepared.operation!=='seal'&&(!prepared.intentProof||!await this.env.proofs.verify(proofStatement(intentDescriptor,prepared.intentSignals),prepared.intentProof,this.vkeys.intent,str(DOMAIN))))return false;
   return await this.env.proofs.verify(proofStatement(transitionDescriptor,prepared.transitionSignals),prepared.transitionProof,this.vkeys.transition,str(DOMAIN));
  }catch{return false;}
 }
 async commit(prepared:PreparedSettlement,receipt:unknown){
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
