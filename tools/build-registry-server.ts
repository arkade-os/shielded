import {spawnSync} from 'node:child_process';
import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
function run(command:string,args:string[],cwd:string){
 const result=spawnSync(command,args,{cwd,stdio:'inherit',windowsHide:true});
 if(result.error)throw new Error(`Registry service build failed: ${result.error.message}`);
 if(result.status!==0)process.exit(result.status??1);
}
run(process.execPath,[resolve(root,'tools/native-registry/apply.mjs')],root);
const directory=resolve(root,'tools/registry-server'),go=process.env.GO??'go';
if(process.argv.includes('--test'))run(go,['test','-mod=readonly','./...'],directory);
else{
 mkdirSync(resolve(root,'bin'),{recursive:true});
 run(go,['build','-mod=readonly','-trimpath','-o',resolve(root,'bin',process.platform==='win32'?'shielded-registry-server.exe':'shielded-registry-server'),'.'],directory);
}
