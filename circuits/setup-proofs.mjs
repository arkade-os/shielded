import * as snarkjs from 'snarkjs';
import {randomBytes} from 'node:crypto';
import {existsSync,unlinkSync,writeFileSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('..',import.meta.url));process.chdir(root);const dir='circuits/build';mkdirSync(dir,{recursive:true});
if(!process.argv.includes('--skip-compile'))for(const name of ['intent','transition']){
 const result=spawnSync('node_modules/.bin/circom2',[`circuits/${name}.circom`,'--r1cs','--wasm','--sym','--O2','-o',dir,'-l','node_modules'],{stdio:'inherit'});
 if(result.status!==0)process.exit(result.status??1);
}
const ptau=`${dir}/poc-local-final.ptau`;
if(!existsSync(ptau)) {
 console.log('Generating fresh local single-party demonstration setup.');
 const {buildBn128}=await import('ffjavascript');const curve=await buildBn128(true);
 await snarkjs.powersOfTau.newAccumulator(curve,15,`${dir}/poc-local-initial.ptau`);await curve.terminate();
 await snarkjs.powersOfTau.contribute(`${dir}/poc-local-initial.ptau`,`${dir}/poc-local-contributed.ptau`,'local random PoC phase 1',randomBytes(64).toString('hex'));
 await snarkjs.powersOfTau.preparePhase2(`${dir}/poc-local-contributed.ptau`,ptau);
 unlinkSync(`${dir}/poc-local-initial.ptau`);unlinkSync(`${dir}/poc-local-contributed.ptau`);
}
for(const name of ['intent','transition']) {
 console.log(`Creating ${name} proving key.`);
 await snarkjs.zKey.newZKey(`${dir}/${name}.r1cs`,ptau,`${dir}/${name}.initial.zkey`);
 await snarkjs.zKey.contribute(`${dir}/${name}.initial.zkey`,`${dir}/${name}.zkey`,'local random PoC phase 2',randomBytes(64).toString('hex'));
 const vk=await snarkjs.zKey.exportVerificationKey(`${dir}/${name}.zkey`);writeFileSync(`${dir}/${name}.vkey.json`,JSON.stringify(vk,null,2));
 unlinkSync(`${dir}/${name}.initial.zkey`);
 console.log(`${name}: ${vk.nPublic} public inputs, ${vk.IC.length} IC points.`);
}
writeFileSync(`${dir}/setup.json`,JSON.stringify({profile:'bounded-v1',setup:'fresh random local single-party contributions',createdAt:new Date().toISOString(),circuits:['intent','transition'],publicInputs:[25,30]},null,2));
console.log('Proof artifacts ready. Single-party experimental setup; demonstration keys only.');
process.exit(0);
