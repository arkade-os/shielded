import {cpSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildPoseidon} from 'circomlibjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const source=path.join(root,'circuits','rollup'),out=path.join(source,'build');
mkdirSync(out,{recursive:true});
const poseidon=await buildPoseidon(),zeros=[0n];
for(let level=0;level<5;level++)zeros.push(BigInt(poseidon.F.toObject(poseidon([zeros[level],zeros[level]]))));
cpSync(path.join(root,'node_modules','circomlib','circuits'),path.join(out,'circomlib','circuits'),{recursive:true,force:true});
for(const name of ['lib','spend','join'])cpSync(path.join(source,name+'.circom'),path.join(out,name+'.circom'));
for(const [name,perSlot,kind] of [['batch-spend',1,0],['batch-join',2,1]])
 writeFileSync(path.join(out,name+'.circom'),`pragma circom 2.1.6;\ninclude "lib.circom";\ncomponent main {public [pub, statement]} = Batch(11, ${perSlot}, ${kind}, 20261007000, [${zeros.join(',')}]);\n`);
const deps=path.join(root,'.deps','native-circom-2.2.2'),metadata=JSON.parse(readFileSync(path.join(deps,'compiler.json'),'utf8'));
const pins={'circom-windows-amd64.exe':'e976b5e83b1627fcdc3ab173ef6d6b3253332dd957d2fb834c098ea246d2ead1','circom-linux-amd64':'f3d8d1fdbc123779b80e210c909ee941d7a1e130c70365524646b48b8b0fe9d5'};
const compiler=path.join(deps,metadata.file);
if(metadata.version!=='2.2.2'||pins[metadata.file]!==metadata.sha256||createHash('sha256').update(readFileSync(compiler)).digest('hex')!==metadata.sha256)
 throw new Error('Pinned circom 2.2.2 is missing or altered. Run: npm run stock:tools -- --compiler-only');
const names=process.argv.slice(2);
for(const name of names.length?names:['spend','join','batch-spend','batch-join']){
 const result=spawnSync(compiler,[name+'.circom','--r1cs','--wasm','--O2','-o','.'],{stdio:'inherit',cwd:out});
 if(result.status!==0)process.exit(result.status??1);
}
