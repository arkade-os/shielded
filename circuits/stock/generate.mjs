import {readFileSync, writeFileSync, mkdirSync, cpSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const out=path.join(root,'circuits','stock','build');
mkdirSync(out,{recursive:true});
function stockTemplate(name){
 return readFileSync(path.join(root,'circuits','stock',name+'.circom'),'utf8')
  .split(/\r?\n/).filter(line=>!line.startsWith('pragma circom ')).join('\n');
}
function template(name){
 return readFileSync(path.join(root,'circuits',name+'.circom'),'utf8')
  .replace(/^pragma circom [^\r\n]*\r?\n/gm,'')
  .replaceAll('include "common.circom";','')
  .replace(/^component main[^\n]*\n?/m,'');
}
const body=stockTemplate('stock-template')
 .replaceAll('include "common.circom";','')
 .replaceAll('include "circomlib/circuits/sha256/sha256.circom";','');
const source='pragma circom 2.1.6;\ninclude "common.circom";\ninclude "circomlib/circuits/sha256/sha256.circom";\n'+template('intent')+'\n'+template('transition')+'\n'+stockTemplate('indexed-nullifiers')+'\n'+stockTemplate('stock-transition')+'\n'+body;
writeFileSync(path.join(out,'stock-combined.circom'),source);
if(process.argv.includes('--compile')){
 const compiled=path.join(out,'compiled');
 mkdirSync(compiled,{recursive:true});
 cpSync(path.join(root,'node_modules','circomlib','circuits'),path.join(compiled,'circomlib','circuits'),{recursive:true,force:true});
 writeFileSync(path.join(compiled,'common.circom'),readFileSync(path.join(root,'circuits','common.circom'),'utf8').replaceAll('../node_modules/circomlib/circuits/','circomlib/circuits/'));
 writeFileSync(path.join(compiled,'stock-combined.circom'),source);
 const metadataPath=path.join(root,'.deps','native-circom-2.2.2','compiler.json');
 const metadata=JSON.parse(readFileSync(metadataPath,'utf8'));
 const compilerPins={'circom-windows-amd64.exe':'e976b5e83b1627fcdc3ab173ef6d6b3253332dd957d2fb834c098ea246d2ead1','circom-linux-amd64':'f3d8d1fdbc123779b80e210c909ee941d7a1e130c70365524646b48b8b0fe9d5'};
 if(metadata.version!=='2.2.2'||compilerPins[metadata.file]!==metadata.sha256) throw new Error('Pinned native Circom metadata is invalid. Run tools/prepare-stock-tools.mjs first.');
 const compiler=path.join(root,'.deps','native-circom-2.2.2',metadata.file);
 const compilerHash=createHash('sha256').update(readFileSync(compiler)).digest('hex');
 if(compilerHash!==metadata.sha256) throw new Error('Pinned native Circom checksum mismatch.');
 const result=spawnSync(compiler,['stock-combined.circom','--r1cs','--wasm','--sym','--O2','-o','.'],{stdio:'inherit',cwd:compiled});
 process.exit(result.status??1);
}
console.log(path.join(out,'stock-combined.circom'));
