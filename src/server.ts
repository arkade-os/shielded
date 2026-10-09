// The Shielded service: the rollup pool, its wallet API and the web app on one port, with one /data volume.
import {existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import express from 'express';
import {dropLegacyData} from './legacy.ts';
import {createRollupRouter} from './rollup/http.ts';
import {DEFAULT_VM_BINARY} from './rollup/leaves.ts';
import {openRollupService,type RollupService} from './rollup/service.ts';

const root=fileURLToPath(new URL('..',import.meta.url)),web=join(root,'app/dist');
const data=resolve(process.env.SHIELDED_DATA_DIR??'/data'),port=Number(process.env.PORT??8792);
const rapidsnark=join(root,'bin','rapidsnark');
let service:RollupService|undefined,stopping=false,timer:ReturnType<typeof setTimeout>|undefined;

// Dokploy's proxy sits on a private network; only such a hop may name the client, so a direct caller cannot.
const app=express();app.disable('x-powered-by');app.set('trust proxy','loopback, linklocal, uniquelocal');
// Health stays green while waiting for a previous instance's volume lock, or the rollout would never finish.
app.get('/health',(_req,res)=>{const phase=service?.status().phase??'starting';res.status(phase==='blocked'?503:200).json({ok:phase!=='blocked',ready:phase==='ready',phase});});
app.get('/readyz',(_req,res)=>res.status(service?.ready()?200:503).json({ready:!!service?.ready()}));
app.use('/api/rollup',createRollupRouter(()=>service));
for(const old of ['/stock-wallet','/rollup','/lab'])app.get(old,(_req,res)=>res.redirect(301,'/wallet'));
app.get(['/','/wallet','/verify','/watch'],(_req,res)=>res.sendFile('index.html',{root:web}));
app.use(express.static(web));
const listener=app.listen(port,process.env.HOST??'0.0.0.0',()=>console.log(`Shielded listening on port ${port}.`));

const stop=async()=>{if(stopping)return;stopping=true;if(timer)clearTimeout(timer);service?.close();listener.close();await (globalThis as {curve_bn128?:{terminate():Promise<void>}}).curve_bn128?.terminate();process.exit(0);};
process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());

service=await openRollupService({directory:join(data,'rollup2'),circuits:resolve(process.env.SHIELDED_ROLLUP_CIRCUITS??join(root,'rollup-circuits')),setupTool:join(root,'tools','rollup-setup.mjs'),
 ...(process.env.SHIELDED_ROLLUP_KEYS?{bundled:resolve(process.env.SHIELDED_ROLLUP_KEYS)}:{}),...(process.env.SHIELDED_ROLLUP_RENEW_HOURS?{renewBeforeMs:Number(process.env.SHIELDED_ROLLUP_RENEW_HOURS)*3600_000}:{}),vmBinary:DEFAULT_VM_BINARY,...(existsSync(rapidsnark)?{rapidsnark}:{}),
 endpoints:{...(process.env.SHIELDED_ARK_URL?{arkUrl:process.env.SHIELDED_ARK_URL}:{}),...(process.env.SHIELDED_EMULATOR_URL?{emulatorUrl:process.env.SHIELDED_EMULATOR_URL}:{}),...(process.env.SHIELDED_INDEXER_URL?{indexerUrl:process.env.SHIELDED_INDEXER_URL}:{})}});
const step=async()=>{
 await service!.step();
 // v1 data goes only once this instance owns the pool, so the previous instance has stopped using it.
 if(service!.ready()){try{const removed=dropLegacyData(data);if(removed.length)console.log('Removed retired v1 data: '+removed.join(', '));}catch(error){console.error('Could not remove retired v1 data: '+(error as Error).message);}return;}
 if(!stopping)timer=setTimeout(step,15000);
};
void step();
