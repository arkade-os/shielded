import {basename,dirname} from 'node:path';
import express from 'express';
import {hex} from '@scure/base';
import {RollupRejection} from '../../packages/protocol/src/rollup/constants.ts';
import {ROLLUP_RECORD_BYTES} from '../../packages/protocol/src/rollup/wallet.ts';
import type {RollupSpend} from './batcher.ts';
import type {SnarkProof} from './covenant.ts';
import type {RollupService} from './service.ts';

const decimal=(v:unknown)=>{if(typeof v!=='string'||!/^(0|[1-9][0-9]{0,77})$/.test(v))throw new Error('Expected a decimal field element.');return BigInt(v);};
const hexOf=(v:unknown,bytes?:number,max=4096)=>{if(typeof v!=='string'||!/^([0-9a-f]{2})+$/.test(v)||v.length>2*max||(bytes!==undefined&&v.length!==2*bytes))throw new Error('Expected lowercase hex of the right length.');return v;};
const proofOf=(p:any):SnarkProof=>{
 const ok=(list:unknown,n:number)=>Array.isArray(list)&&list.length===n&&list.every(x=>typeof x==='string'&&/^[0-9]{1,78}$/.test(x));
 if(!p||!ok(p.pi_a,3)||!ok(p.pi_c,3)||!Array.isArray(p.pi_b)||p.pi_b.length!==3||!p.pi_b.every((row:unknown)=>ok(row,2)))throw new Error('Malformed Groth16 proof.');
 return {pi_a:p.pi_a,pi_b:p.pi_b,pi_c:p.pi_c};
};

/** The v2 wallet API: status, proving keys, published batches, spend submission and the deposit signing round. */
export function createRollupRouter(service:()=>RollupService|undefined){
 const router=express.Router();
 router.use(express.json({limit:'64kb',strict:true}));
 router.use((req,res,next)=>{
  if(req.method==='POST'&&req.get('origin')){let origin:string;try{origin=new URL(req.get('origin')!).host;}catch{res.status(403).json({error:'Invalid origin'});return;}if(origin!==req.get('host')){res.status(403).json({error:'Same-origin request required'});return;}}
  if(!service()){res.status(503).json({error:'The rollup pool is starting.'});return;}
  next();
 });
 router.get('/status',(_req,res)=>{res.setHeader('Cache-Control','no-store');res.json(service()!.status());});
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
 router.post('/spends',async(req,res)=>{
  try{
   const b=req.body??{},s=b.slot??{};
   if(typeof b.id!=='string'||!/^[0-9a-f]{16,64}$/.test(b.id))throw new Error('A spend id is 8 to 32 random bytes in hex.');
   if(!Array.isArray(s.nullifiers)||!Array.isArray(s.commitments)||s.commitments.length!==2||!Array.isArray(b.publics)||b.publics.length!==5)throw new Error('Malformed spend slot.');
   const groupId=decimal(s.groupId);
   if(!(groupId===0n&&s.groupSize===0)&&!(groupId!==0n&&(s.groupSize===2||s.groupSize===3)))throw new Error('A group has a nonzero id and two or three members; a lone spend has neither.');
   const coinRef=b.coin?{txid:hexOf(b.coin.txid,32),vout:Number.isInteger(b.coin.vout)&&b.coin.vout>=0?b.coin.vout:-1,tapTree:hexOf(b.coin.tapTree),leaf:hexOf(b.coin.leaf)}:undefined;
   const coin=coinRef?await service()!.depositCoin(coinRef):undefined;
   const spend:Omit<RollupSpend,'receivedAt'>={id:b.id,
    slot:{root:decimal(s.root),nullifiers:s.nullifiers.map(decimal),commitments:[decimal(s.commitments[0]),decimal(s.commitments[1])],ctDigest:decimal(s.ctDigest),groupId,groupSize:s.groupSize},
    publics:b.publics.map(decimal) as unknown as RollupSpend['publics'],proof:proofOf(b.proof),ciphertext:hex.decode(hexOf(b.ciphertext,ROLLUP_RECORD_BYTES)),
    ...(b.program!==undefined?{program:hex.decode(hexOf(b.program,32))}:{}),...(coin?{coin}:{})};
   await service()!.submit(spend,coinRef);
   res.status(202).json({id:spend.id,status:'pending'});
  }catch(error){res.status(400).json({error:(error as Error).message,...(error instanceof RollupRejection?{code:error.code}:{})});}
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
