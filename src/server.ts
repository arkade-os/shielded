// The Shielded service: the rollup pool, its wallet API and the web app on one port, with one /data volume.
import {randomBytes} from 'node:crypto';
import {existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ESPLORA_URL} from '@arkade-os/sdk';
import compression from 'compression';
import express from 'express';
import {dropLegacyData} from './legacy.ts';
import {createRollupRouter} from './rollup/http.ts';
import {DEFAULT_VM_BINARY} from './rollup/leaves.ts';
import {createOhttpGateway} from './rollup/ohttp-gateway.ts';
import {loadOhttpKey} from './rollup/ohttp-keys.ts';
import {openRollupService,rollupDepositFeeFromEnv,type RollupService} from './rollup/service.ts';
import {MUTINY_ARK_URL} from './stock/network.ts';
import {serveWeb} from './web.ts';

const root=fileURLToPath(new URL('..',import.meta.url)),web=join(root,'app/dist');
const data=resolve(process.env.SHIELDED_DATA_DIR??'/data'),port=Number(process.env.PORT??8792);
const rapidsnark=join(root,'bin','rapidsnark');
let service:RollupService|undefined,stopping=false,timer:ReturnType<typeof setTimeout>|undefined;

// Dokploy's proxy sits on a private network; only such a hop may name the client, so a direct caller cannot.
const app=express();app.disable('x-powered-by');app.set('trust proxy','loopback, linklocal, uniquelocal');app.use(compression());
// Health stays green while waiting for a previous instance's volume lock, or the rollout would never finish.
app.get('/health',(_req,res)=>{const phase=service?.status().phase??'starting';res.status(phase==='blocked'?503:200).json({ok:phase!=='blocked',ready:phase==='ready',phase});});
app.get('/readyz',(_req,res)=>res.status(service?.ready()?200:503).json({ready:!!service?.ready()}));
// Off without a key; a malformed key, rate or upstream, or a PORT that is not a fixed number, stops startup instead. The token is minted per process and never logged: it is the loopback header the pool's per-address limit exempts.
const ohttpKey=await loadOhttpKey(process.env.SHIELDED_OHTTP_KEY),gatewayToken=ohttpKey?randomBytes(32).toString('hex'):undefined;
if(ohttpKey&&gatewayToken){
 if(!port)throw new Error('PORT must be a fixed port number while SHIELDED_OHTTP_KEY is set: the gateway reaches the pool at http://127.0.0.1:$PORT.');
 // Each prefix starts at the base URL's own path, so it matches what the SDK clients request: ${base}/v1/, ${base}/v1/indexer/ and, for Esplora, ${base}/.
 const upstream=(base:string,api:string)=>{const url=new URL(base);return {origin:url.origin,prefix:url.pathname.replace(/\/?$/,'/')+api};};
 const ark=process.env.SHIELDED_ARK_URL||MUTINY_ARK_URL;
 app.use('/api/rollup',createOhttpGateway({key:ohttpKey,gatewayToken,poolOrigin:process.env.SHIELDED_PUBLIC_ORIGIN||'https://shielded.mutinynet.arkade.sh',poolLoopback:`http://127.0.0.1:${port}`,
  upstreams:[upstream(ark,'v1/'),upstream(process.env.SHIELDED_INDEXER_URL||ark,'v1/indexer/'),upstream(process.env.SHIELDED_ESPLORA_URL||ESPLORA_URL.mutinynet,'')],
  ...(process.env.SHIELDED_OHTTP_RATE?{rate:Number(process.env.SHIELDED_OHTTP_RATE)}:{})}));
}
console.log(ohttpKey?`Oblivious HTTP gateway on (key id ${ohttpKey.keyId}).`:'Oblivious HTTP gateway off.');
app.use('/api/rollup',createRollupRouter(()=>service,{allowedOrigins:process.env.SHIELDED_ALLOWED_ORIGINS?.split(',').map(origin=>origin.trim()).filter(Boolean),gatewayToken}));
for(const old of ['/stock-wallet','/rollup','/lab'])app.get(old,(_req,res)=>res.redirect(301,'/wallet'));
serveWeb(app,web);
const listener=app.listen(port,process.env.HOST??'0.0.0.0',()=>console.log(`Shielded listening on port ${port}.`));

const stop=async()=>{if(stopping)return;stopping=true;if(timer)clearTimeout(timer);service?.close();listener.close();await (globalThis as {curve_bn128?:{terminate():Promise<void>}}).curve_bn128?.terminate();process.exit(0);};
process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());

service=await openRollupService({directory:join(data,'rollup4'),epochLen:process.env.SHIELDED_ROLLUP_EPOCH_LEN??128,circuits:resolve(process.env.SHIELDED_ROLLUP_CIRCUITS??join(root,'rollup-circuits')),setupTool:join(root,'tools','rollup-setup.mjs'),
 ...(process.env.SHIELDED_ROLLUP_KEYS?{bundled:resolve(process.env.SHIELDED_ROLLUP_KEYS)}:{}),...(process.env.SHIELDED_ROLLUP_RENEW_HOURS?{renewBeforeMs:Number(process.env.SHIELDED_ROLLUP_RENEW_HOURS)*3600_000}:{}),vmBinary:DEFAULT_VM_BINARY,...(existsSync(rapidsnark)?{rapidsnark}:{}),
 depositFee:rollupDepositFeeFromEnv(process.env),
 endpoints:{...(process.env.SHIELDED_ARK_URL?{arkUrl:process.env.SHIELDED_ARK_URL}:{}),...(process.env.SHIELDED_EMULATOR_URL?{emulatorUrl:process.env.SHIELDED_EMULATOR_URL}:{}),...(process.env.SHIELDED_INDEXER_URL?{indexerUrl:process.env.SHIELDED_INDEXER_URL}:{})}});
const step=async()=>{
 await service!.step();
 // v1 data goes only once this instance owns the pool, so the previous instance has stopped using it.
 if(service!.ready()){try{const removed=dropLegacyData(data);if(removed.length)console.log('Removed retired v1 data: '+removed.join(', '));}catch(error){console.error('Could not remove retired v1 data: '+(error as Error).message);}return;}
 if(!stopping)timer=setTimeout(step,15000);
};
void step();
