import {cpSync, mkdirSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildPoseidon} from 'circomlibjs';
import {pinnedCircom} from './compiler.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const source=path.join(root,'circuits','rollup'),out=path.join(source,'build');
mkdirSync(out,{recursive:true});
const poseidon=await buildPoseidon(),zeros=[0n];
for(let level=0;level<5;level++)zeros.push(BigInt(poseidon.F.toObject(poseidon([zeros[level],zeros[level]]))));
cpSync(path.join(root,'node_modules','circomlib','circuits'),path.join(out,'circomlib','circuits'),{recursive:true,force:true});
for(const name of ['lib','spend','join'])cpSync(path.join(source,name+'.circom'),path.join(out,name+'.circom'));
for(const [name,perSlot,kind] of [['batch-spend',1,0],['batch-join',2,1]])
 writeFileSync(path.join(out,name+'.circom'),`pragma circom 2.1.6;\ninclude "lib.circom";\ncomponent main {public [pub, statement]} = Batch(11, ${perSlot}, ${kind}, 20261009000, [${zeros.join(',')}]);\n`);
const compiler=pinnedCircom(root);
const names=process.argv.slice(2);
for(const name of names.length?names:['spend','join','batch-spend','batch-join']){
 const result=spawnSync(compiler,[name+'.circom','--r1cs','--wasm','--O2','-o','.'],{stdio:'inherit',cwd:out});
 if(result.status!==0)process.exit(result.status??1);
}
