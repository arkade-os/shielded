import {cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildPoseidon} from 'circomlibjs';
import {pinnedCircom} from './compiler.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const source=path.join(root,'circuits','rollup'),out=path.join(source,'build');
mkdirSync(out,{recursive:true});
const poseidon=await buildPoseidon(),hash=values=>BigInt(poseidon.F.toObject(poseidon(values))),zeros=[0n];
for(let level=0;level<32;level++)zeros.push(hash([zeros[level],zeros[level]]));
const EMPTY_NOTE=zeros[32],EMPTY_NF=zeros.slice(0,25).reduce((node,zero)=>hash([node,zero]),hash([20261007301n,0n,0n,0n]));
const clients=['epoch-spend','epoch-join'];
// One [name, `component main … = Template(…, [${zeros.slice(0,6)}], …, ${EMPTY_NOTE}, ${EMPTY_NF});`] per generated batch circuit.
const mains=[];
const all=[...clients,...mains.map(([name])=>name)],names=process.argv.slice(2);
if(names.some(name=>!all.includes(name)))throw new Error(`generate-epoch.mjs builds only ${all.join(', ')}.`);
for(const file of readdirSync(source).filter(name=>/^epoch.*\.circom$/.test(name))){
 const line=readFileSync(path.join(source,file),'utf8').split('\n').findIndex(text=>/<--|-->/.test(text));
 if(line>=0)throw new Error(`circuits/rollup/${file}:${line+1} uses <-- or -->, which assigns without a constraint.`);
}
cpSync(path.join(root,'node_modules','circomlib','circuits'),path.join(out,'circomlib','circuits'),{recursive:true,force:true});
for(const name of ['lib',...clients])cpSync(path.join(source,name+'.circom'),path.join(out,name+'.circom'));
for(const [name,main] of mains)writeFileSync(path.join(out,name+'.circom'),`pragma circom 2.1.6;\ninclude "epoch.circom";\n${main}\n`);
const compiler=pinnedCircom(root);
for(const name of names.length?names:all){
 const result=spawnSync(compiler,[name+'.circom','--r1cs','--wasm','--O2','-o','.'],{stdio:'inherit',cwd:out});
 if(result.status!==0)process.exit(result.status??1);
}
