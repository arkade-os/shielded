import {basename,dirname} from 'node:path';
import express from 'express';
import {hex} from '@scure/base';
import {BATCH_SLOTS,RollupRejection} from '../../packages/protocol/src/rollup/constants.ts';
import type {EpochSlot} from '../../packages/protocol/src/rollup/epoch.ts';
import {recordSlotOf} from '../../packages/protocol/src/rollup/epoch-record.ts';
import {ROLLUP_RECORD_BYTES} from '../../packages/protocol/src/rollup/wallet.ts';
import type {SnarkProof} from './covenant.ts';
import type {RollupEpochSpend} from './epoch-operator.ts';
import type {RollupService} from './service.ts';

const decimal=(v:unknown)=>{if(typeof v!=='string'||!/^(0|[1-9][0-9]{0,77})$/.test(v))throw new Error('Expected a decimal field element.');return BigInt(v);};
const hexOf=(v:unknown,bytes?:number,max=4096)=>{if(typeof v!=='string'||!/^([0-9a-f]{2})+$/.test(v)||v.length>2*max||(bytes!==undefined&&v.length!==2*bytes))throw new Error('Expected lowercase hex of the right length.');return v;};
const proofOf=(p:any):SnarkProof=>{
 const ok=(list:unknown,n:number)=>Array.isArray(list)&&list.length===n&&list.every(x=>typeof x==='string'&&/^[0-9]{1,78}$/.test(x));
 if(!p||!ok(p.pi_a,3)||!ok(p.pi_c,3)||!Array.isArray(p.pi_b)||p.pi_b.length!==3||!p.pi_b.every((row:unknown)=>ok(row,2)))throw new Error('Malformed Groth16 proof.');
 return {pi_a:p.pi_a,pi_b:p.pi_b,pi_c:p.pi_c};
};
/** Both epoch write routes' slot: an anchor where a classic slot has its root, and exactly one of rCur (a fast-path spend) and origin (a recovery). */
const epochSlotOf=(s:any):EpochSlot=>{
 if(!s||typeof s!=='object'||!Array.isArray(s.nullifiers)||![1,2].includes(s.nullifiers.length)||!Array.isArray(s.commitments)||s.commitments.length!==2)throw new Error('Malformed epoch slot.');
 if('root' in s)throw new Error('An epoch slot names its anchor, not a root.');
 if((s.rCur===undefined)===(s.origin===undefined))throw new Error('An epoch slot names exactly one of rCur, for a fast-path spend, and origin, for a recovery.');
 if(s.origin!==undefined&&(!Number.isSafeInteger(s.origin)||s.origin<0))throw new Error('A recovery names its origin epoch as a whole number.');
 if(s.rCur!==undefined&&(typeof s.rCur!=='object'||!Number.isSafeInteger(s.rCur?.epoch)||s.rCur.epoch<0))throw new Error('A window leaf names a whole epoch and its root.');
 const groupId=decimal(s.groupId);
 if(!(groupId===0n&&s.groupSize===0)&&!(groupId!==0n&&(s.groupSize===2||s.groupSize===3)))throw new Error('A group has a nonzero id and two or three members; a lone spend has neither.');
 return {anchor:decimal(s.anchor),...(s.origin!==undefined?{origin:s.origin as number}:{rCur:{epoch:s.rCur.epoch as number,root:decimal(s.rCur.root)}}),
  nullifiers:s.nullifiers.map(decimal),commitments:[decimal(s.commitments[0]),decimal(s.commitments[1])],ctDigest:decimal(s.ctDigest),groupId,groupSize:s.groupSize};
};
/** A system error's message names a path, so a route open to anyone logs the cause here and answers a fixed string. */
const logged=(route:string,error:unknown)=>console.error(`[rollup] ${route}: ${(error as Error).message}`);

/** The v2 wallet API: status, proving keys, published batches, spend submission and the deposit signing round. */
const POSTS_PER_MINUTE=60;
/** Each admission checks a Groth16 proof in this process; past this many at once, a flood from many addresses would stall batching. */
const ADMITTING_AT_ONCE=8;
export function createRollupRouter(service:()=>RollupService|undefined){
 const router=express.Router();
 let admitting=0;
 // Every submission costs a proof check, so each address gets a budget; reads and signatures, which an admitted deposit owes within its round, stay open.
 const writes=new Map<string,{count:number;since:number}>();
 router.use((req,res,next)=>{
  if(req.method!=='POST'||/^\/spends\/[^/]+\/sign$/.test(req.path))return next();
  const now=Date.now(),key=req.ip??'',seen=writes.get(key);
  if(!seen||now-seen.since>60_000){if(writes.size>10_000)writes.clear();writes.set(key,{count:1,since:now});return next();} // ponytail: crude reset, an LRU if the map ever matters
  if(++seen.count>POSTS_PER_MINUTE){res.setHeader('Retry-After',Math.floor((60_000-(now-seen.since))/1000)+1);res.status(429).json({error:'Too many requests from this address; try again in a minute.',code:'admission-rate-limit'});return;}
  next();
 });
 router.use(express.json({limit:'64kb',strict:true}));
 router.use((req,res,next)=>{
  if(req.method==='POST'&&req.get('origin')){let origin:string;try{origin=new URL(req.get('origin')!).host;}catch{res.status(403).json({error:'Invalid origin'});return;}if(origin!==req.get('host')){res.status(403).json({error:'Same-origin request required'});return;}}
  if(!service()){res.status(503).json({error:'The rollup pool is starting.'});return;}
  next();
 });
 router.get('/status',(_req,res)=>{res.setHeader('Cache-Control','no-store');res.json(service()!.status());});
 router.get('/storage',(_req,res)=>{
  res.setHeader('Cache-Control','no-store');
  try{res.json(service()!.storage());}catch(error){logged('/storage',error);res.status(503).json({error:'Storage figures are unavailable.'});}
 });
 router.get('/proving/:file',(req,res)=>{
  const path=service()!.keyFile(req.params.file);
  if(!path){res.status(404).json({error:'Unknown proving file.'});return;}
  // A root keeps send's dotfile rule off the directory path; cache headers ride on success only, never on a 404.
  res.sendFile(basename(path),{root:dirname(path),maxAge:'365d',immutable:true},error=>{if(error&&!res.headersSent)res.status(404).setHeader('Cache-Control','no-store').json({error:'Proving file unavailable.'});});
 });
 router.use((_req,res,next)=>{if(!service()!.ready()){res.status(503).json({error:'The rollup pool is not open yet; read /api/rollup/status.'});return;}next();});
 router.get('/batches',(req,res)=>{
  const from=Number(req.query.from??0),limit=Math.min(Number(req.query.limit??50),100);
  if(!Number.isInteger(from)||from<0||!Number.isInteger(limit)||limit<1){res.status(400).json({error:'Invalid batch range.'});return;}
  res.setHeader('Cache-Control','no-store');res.json(service()!.batches(from,limit));
 });
 router.get('/scan',(req,res)=>{
  const from=Number(req.query.from??0),limit=Math.min(Number(req.query.limit??500),500);
  if(!Number.isInteger(from)||from<0||!Number.isInteger(limit)||limit<1){res.status(400).json({error:'Invalid batch range.'});return;}
  res.setHeader('Cache-Control','no-store');
  try{res.json(service()!.scan(from,limit));}
  catch(error){logged('/scan',error);res.status(500).json({error:(error as NodeJS.ErrnoException).syscall?'The batch records could not be read.':(error as Error).message});}
 });
 router.get('/times',(_req,res)=>{res.setHeader('Cache-Control','no-store');res.json(service()!.times());});
 router.get('/archives',(_req,res)=>{
  res.setHeader('Cache-Control','no-store');
  try{res.json({epochs:service()!.archiveEpochs()});}
  catch(error){logged('/archives',error);res.status(500).json({error:'The archive files could not be read.'});}
 });
 router.get('/archives/:name',(req,res)=>{
  let path:string|undefined;
  try{path=service()!.archiveFile(req.params.name);}
  catch(error){logged('/archives/:name',error);res.status(500).setHeader('Cache-Control','no-store').json({error:'The archive files could not be read.'});return;}
  if(!path){res.status(404).setHeader('Cache-Control','no-store').json({error:'Unknown nullifier archive.'});return;}
  res.sendFile(basename(path),{root:dirname(path),maxAge:'365d',immutable:true},error=>{if(error&&!res.headersSent)res.status(404).setHeader('Cache-Control','no-store').json({error:'Nullifier archive unavailable.'});});
 });
 router.get('/checkpoints/:epoch/:blocks',(req,res)=>{
  const whole=/^(0|[1-9][0-9]{0,9})$/,{epoch,blocks}=req.params;
  const checkpoint=whole.test(epoch)&&whole.test(blocks)?service()!.checkpointAt(Number(epoch),Number(blocks)):undefined;
  res.setHeader('Cache-Control','no-store');
  if(!checkpoint){res.status(404).json({error:'There is no checkpoint at that epoch and batch count.'});return;}
  res.json(checkpoint);
 });
 router.post('/external',async(req,res)=>{
  try{
   const b=req.body??{};
   if(typeof b.txid!=='string'||!/^[0-9a-f]{64}$/.test(b.txid)||(b.slots!==undefined&&(!Array.isArray(b.slots)||!b.slots.length||b.slots.length>BATCH_SLOTS)))throw new Error("Expected a txid, and its batch record's slots unless it is followed chain-only.");
   const slots=b.slots?.map((s:any)=>({...recordSlotOf(epochSlotOf(s)),...(s.ciphertext!==undefined?{ciphertext:hexOf(s.ciphertext,ROLLUP_RECORD_BYTES)}:{})}));
   res.json(await service()!.external(b.txid,slots));
  }catch(error){res.status(400).json({error:(error as Error).message,...(error instanceof RollupRejection?{code:error.code}:{})});}
 });
 router.post('/spends',async(req,res)=>{
  if(admitting>=ADMITTING_AT_ONCE){res.status(503).json({error:'The pool is busy checking other spends; try again in a moment.'});return;}
  admitting++;
  try{
   const b=req.body??{};
   if(typeof b.id!=='string'||!/^[0-9a-f]{16,64}$/.test(b.id))throw new Error('A spend id is 8 to 32 random bytes in hex.');
   if(!Array.isArray(b.publics)||b.publics.length!==7)throw new Error('A spend carries its seven public inputs.');
   const slot=epochSlotOf(b.slot);
   if(b.asset!==undefined&&(typeof b.asset!=='string'||!/^[0-9a-f]{68}$/.test(b.asset)))throw new Error('An asset id is 68 lowercase hex characters.');
   const coinRef=b.coin?{txid:hexOf(b.coin.txid,32),vout:Number.isInteger(b.coin.vout)&&b.coin.vout>=0?b.coin.vout:-1,tapTree:hexOf(b.coin.tapTree),leaf:hexOf(b.coin.leaf)}:undefined;
   const coin=coinRef?await service()!.depositCoin(coinRef):undefined;
   if(coin&&coin.assetId!==b.asset)throw new Error(coin.assetId?`The deposit coin holds asset ${coin.assetId}; deposit it as that asset.`:'The deposit coin holds no asset.');
   // kindOf requires a recovery's origin on the spend and on its slot alike.
   const spend:Omit<RollupEpochSpend,'receivedAt'>={id:b.id,slot,...(slot.origin!==undefined?{origin:slot.origin}:{}),
    publics:b.publics.map(decimal) as unknown as RollupEpochSpend['publics'],proof:proofOf(b.proof),ciphertext:hex.decode(hexOf(b.ciphertext,ROLLUP_RECORD_BYTES)),
    ...(b.program!==undefined?{program:hex.decode(hexOf(b.program,32))}:{}),...(b.asset?{asset:b.asset}:{}),...(coin?{coin}:{})};
   await service()!.submit(spend,coinRef);
   res.status(202).json({id:spend.id,status:'pending'});
  }catch(error){res.status(400).json({error:(error as Error).message,...(error instanceof RollupRejection?{code:error.code}:{})});}
  finally{admitting--;}
 });
 router.get('/spends/:id',(req,res)=>{
  const status=service()!.spend(req.params.id);
  res.setHeader('Cache-Control','no-store');
  if(!status){res.status(404).json({error:'Unknown spend; it may have expired or the server restarted.'});return;}
  res.json(status);
 });
 router.post('/spends/:id/sign',(req,res)=>{
  try{
   const {arkTx,checkpoint}=req.body??{};
   if(typeof arkTx!=='string'||typeof checkpoint!=='string'||arkTx.length>65536||checkpoint.length>65536)throw new Error('Send the signed batch transaction and your checkpoint as base64 PSBTs.');
   service()!.sign(req.params.id,{arkTx,checkpoint});
   res.json({id:req.params.id,status:'signed'});
  }catch(error){res.status(409).json({error:(error as Error).message});}
 });
 return router;
}
