import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';

// Backport ts-sdk PR1089 (11097c06): absent claim evidence never proves a refund.
export const bundles={
 'chunk-DQ2DY2L2.js':['7d824f83ccaf8b4a27a3cd451a05260348952fc4a3e40b2e1ed5a4e71279a647','f5ab4c2001bef41fdec9a7038f2f987f162abba66fb88111a8440ff054e949e2'],
 'index.cjs':['c52661748a516674df02cc5f393a706ee99ffc78e6270b2bc0dc9f87bfe86a03','67d7238a0e8aff8dce62e9c4f68656a625e2bfe108d0a3534d9e7658651f4cfb'],
 'advanced.cjs':['de4bff32833f863be04060d774511b68ae2736baa928d0bbe10ce123ebd836b0','c65ece141444ccc7b9e4931712b427c19229e682181d10ad22a561eee457ae94'],
 'protocol.cjs':['6526c6131a1fa3d0af2c890f120155f9dfed0b00786edc85e126a12c95b57664','6534130541369ee1b87f6135e57b7ffbb8a405ef879c7b9d22326ef16f24797f'],
};
export const digest=source=>createHash('sha256').update(source).digest('hex');
const once=(source,before,after)=>{
 if(source.split(before).length!==2)throw new Error('Swap claim patch layout changed');
 return source.replace(before,after);
};
export function patchSource(source,file){
 const start=source.indexOf('async function readLockupFate('),end=source.indexOf('\nvar assertNoneSwept =',start);
 if(start<0||end<0)throw new Error('Swap claim classifier is missing');
 let body=source.slice(start,end);
 body=once(body,'const observed = /* @__PURE__ */ new Set();','const refunded = /* @__PURE__ */ new Set();');
 body=once(body,'if (spentBy.has(tx.id)) observed.add(tx.id);','if (!spentBy.has(tx.id)) continue;');
 body=once(body,'if (!all.some((vtxo) => vtxo.txid === txid && vtxo.vout === spent.index)) continue;',
  'const vtxo = all.find((vtxo) => vtxo.txid === txid && vtxo.vout === spent.index && vtxo.spentBy === tx.id);\n      if (!vtxo) continue;');
 body=once(body,'      }\n    }\n  }\n  return everySpendNamed',
  '      }\n      if (shieldedRefundLeaf(tx, i)) refunded.add(`${vtxo.txid}:${vtxo.vout}`);\n    }\n  }\n  return everySpendNamed');
 body=once(body,'observed.size === spentBy.size','all.every((vtxo) => refunded.has(`${vtxo.txid}:${vtxo.vout}`))');
 const imports=file.endsWith('.cjs')
  ?'var {decodeTapscript: shieldedDecodeTapscript, scriptFromTapLeafScript: shieldedLeafScript} = require("@arkade-os/sdk");'
  :'import {decodeTapscript as shieldedDecodeTapscript, scriptFromTapLeafScript as shieldedLeafScript} from "@arkade-os/sdk";';
 const helper=`${imports}
function shieldedRefundLeaf(tx, inputIndex) {
  const input = tx.getInput(inputIndex), witness = input.finalScriptWitness, leaves = input.tapLeafScript ?? [];
  const script = witness && witness.length >= 2 ? witness[witness.length - 2] : leaves.length === 1 ? shieldedLeafScript(leaves[0]) : undefined;
  if (!script) return false;
  try {
    const {type} = shieldedDecodeTapscript(script);
    return type === "multisig" || type === "csv-multisig" || type === "cltv-multisig";
  } catch { return false; }
}
`;
 return source.slice(0,start)+helper+body+source.slice(end);
}
export function patchSwapClaim(directory=dirname(createRequire(import.meta.url).resolve('@arkade-os/swap'))){
 const pkg=JSON.parse(readFileSync(join(directory,'../package.json'),'utf8'));
 if(pkg.version!=='0.1.0-rc.23')throw new Error(`Swap claim patch requires rc.23; found ${pkg.version}`);
 const pending=[];
 for(const [file,[before,after]] of Object.entries(bundles)){
  const path=join(directory,file),source=readFileSync(path,'utf8'),hash=digest(source);
  if(hash===after)continue;
  if(hash!==before)throw new Error(`Swap claim patch hash mismatch: ${file}`);
  const patched=patchSource(source,file);
  if(digest(patched)!==after)throw new Error(`Swap claim patch output mismatch: ${file}`);
  pending.push([path,patched]);
 }
 for(const [path,source] of pending)writeFileSync(path,source);
 return pending.length;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)console.log(`Swap claim patch: ${patchSwapClaim()} bundles updated`);
