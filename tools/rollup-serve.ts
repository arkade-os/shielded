// Serves only the v2 rollup pool and the built web app, for local runs against Mutinynet. Test funds only.
import {resolve} from 'node:path';
import express from 'express';
import {createRollupRouter} from '../src/rollup/http.ts';
import {openRollupService} from '../src/rollup/service.ts';
import {DEFAULT_VM_BINARY} from '../src/sdk/runtime.ts';

const data=resolve(process.env.SHIELDED_DATA_DIR??'.deps/rollup-serve'),port=Number(process.env.PORT??8793);
const service=await openRollupService({directory:data,circuits:resolve('circuits/rollup/build'),setupTool:resolve('tools/rollup-setup.mjs'),
 ...(process.env.SHIELDED_ROLLUP_KEYS?{bundled:resolve(process.env.SHIELDED_ROLLUP_KEYS)}:{}),vmBinary:DEFAULT_VM_BINARY,endpoints:{},
 ...(process.env.SHIELDED_ROLLUP_RENEW_HOURS?{renewBeforeMs:Number(process.env.SHIELDED_ROLLUP_RENEW_HOURS)*3600_000}:{})});
const app=express();app.disable('x-powered-by');
app.use('/api/rollup',createRollupRouter(()=>service));
app.get('/rollup',(_req,res)=>res.sendFile(resolve('app/dist/index.html')));
app.use(express.static(resolve('app/dist')));
app.listen(port,'127.0.0.1',()=>console.log(`rollup pool on http://127.0.0.1:${port} data ${data}`));
const step=async()=>{await service.step();if(!service.ready())setTimeout(step,15000);};
void step();
