import express from 'express';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {timingSafeEqual,createHash} from 'node:crypto';
import {createPublicCoordinator,type PublicCoordinator} from './coordinator.ts';
const root=fileURLToPath(new URL('../..',import.meta.url));
function exact(value:unknown,keys:string[]){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw new Error('Unexpected request fields');}
export function validateSettlement(value:any){
 exact(value,['id','operation','intentProof','transitionProof','intentSignals','transitionSignals','oldState','newState','ciphertextRecords','boundary','proofTimes']);
 for(const proof of [value.intentProof,value.transitionProof])if(proof){exact(proof,['pi_a','pi_b','pi_c','protocol','curve']);if(proof.protocol!=='groth16'||proof.curve!=='bn128')throw new Error('Wrong proof encoding');}
 for(const state of [value.oldState,value.newState]){exact(state,['noteRoot','spentRoot','historyRoot','noteCount','historyCount','revision','reserves']);exact(state.reserves,['BTC','DEMO']);}
 exact(value.boundary,['deposit','withdrawal','destination']);exact(value.boundary.deposit,['BTC','DEMO']);exact(value.boundary.withdrawal,['BTC','DEMO']);exact(value.proofTimes,['intentMs','transitionMs']);
 if(!Array.isArray(value.ciphertextRecords)||value.ciphertextRecords.length>2)throw new Error('Invalid encrypted records');for(const record of value.ciphertextRecords)exact(record,['index','commitment','ciphertext','leaf','createdRevision']);
}
function sameOrigin(origin:string,host:string){try{return new URL(origin).host===host;}catch{return false;}}
export function createNoncustodialApp(coordinator:PublicCoordinator,token?:string,webRoot=resolve(root,'app/dist')){
 const app=express();app.disable('x-powered-by');app.use(express.json({limit:'32kb',strict:true}));
 app.get('/health',(_req,res)=>res.json({ok:true,profile:coordinator.profile()}));
 app.use('/api',(req,res,next)=>{if(token){const supplied=req.get('authorization')?.replace(/^Bearer /,'')??'';if(!timingSafeEqual(createHash('sha256').update(supplied).digest(),createHash('sha256').update(token).digest())){res.status(401).json({error:'Authentication required'});return;}}if(req.method==='POST'&&req.get('origin')&&!sameOrigin(req.get('origin')!,req.get('host')??'')){res.status(403).json({error:'Same-origin request required'});return;}next();});
 app.get('/api/profile',(_req,res)=>res.json(coordinator.profile()));app.get('/api/archive',(_req,res)=>res.json(coordinator.archive()));
 app.get('/api/proving/:name',(req,res)=>{const names:Record<string,string>={'intent.wasm':'intent_js/intent.wasm','transition.wasm':'transition_js/transition.wasm','intent.zkey':'intent.zkey','transition.zkey':'transition.zkey'};const file=names[req.params.name];if(!file){res.status(404).json({error:'Unknown proving artifact'});return;}res.sendFile(file,{root:resolve(root,'circuits/build')});});
 app.post('/api/participants/:owner',async(req,res)=>{exact(req.body,['recipient','nativePublicKey']);exact(req.body.recipient,['owner','viewPublicKey']);res.json(await coordinator.register(req.params.owner as 'alice'|'bob',req.body));});
 app.post('/api/settlements',async(req,res)=>{validateSettlement(req.body);res.json(await coordinator.submit(req.body));});
 app.post('/api/seal',async(req,res)=>{exact(req.body,[]);res.json(await coordinator.seal());});
 app.get('/',(_req,res)=>res.redirect('/wallet'));
 app.use(express.static(webRoot));app.get('/wallet',(_req,res)=>res.sendFile('index.html',{root:webRoot}));
 app.use((error:any,_req:express.Request,res:express.Response,_next:express.NextFunction)=>res.status(error.status??400).json({error:error.message??'Request rejected'}));return app;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.env.SHIELDED_NETWORK&&process.env.SHIELDED_NETWORK!=='local-emulator')throw new Error('Registered verifier service is local-only until operator deployment');
 const host=process.env.HOST??'127.0.0.1';if(host!=='127.0.0.1'&&host!=='localhost'&&(!process.env.SHIELDED_API_TOKEN||process.env.SHIELDED_API_TOKEN.length<32))throw new Error('Non-loopback lab deployment requires a strong API token');
 const coordinator=await createPublicCoordinator(resolve(process.env.SHIELDED_DATA_DIR??'data/noncustodial'));
 const server=createNoncustodialApp(coordinator,process.env.SHIELDED_API_TOKEN).listen(Number(process.env.PORT??8789),host,()=>console.log('Noncustodial local wallet: http://'+host+':'+(process.env.PORT??8789)+'/wallet'));
 let stopping=false;const close=()=>{if(stopping)return;stopping=true;server.close(()=>{void (async()=>{await coordinator.close();await (globalThis as any).curve_bn128?.terminate();})().then(()=>process.exit(0),()=>{console.error('Lab shutdown failed');process.exit(1);});});};process.once('SIGINT',close);process.once('SIGTERM',close);
}
