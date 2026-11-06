import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const result=spawnSync(process.execPath,['node_modules/vite/bin/vite.js','build','--config','app/vite.config.ts'],{cwd:root,env:{...process.env,SHIELDED_NATIVE:'1'},stdio:'inherit'});
if(result.error)throw result.error;
process.exit(result.status??1);
