import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,chmod} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createWriteStream} from 'node:fs';
const root=resolve('.deps'),version='2.2.2';
const binaries={win32:['circom-windows-amd64.exe','e976b5e83b1627fcdc3ab173ef6d6b3253332dd957d2fb834c098ea246d2ead1'],linux:['circom-linux-amd64','f3d8d1fdbc123779b80e210c909ee941d7a1e130c70365524646b48b8b0fe9d5']};
if(process.arch!=='x64'||!binaries[process.platform])throw new Error('Pinned stock compiler supports Windows/Linux x64. Supply a separately verified compiler on other platforms.');
const [name,sha]=binaries[process.platform];
async function pinned(url,path,algorithm,expected){
 await mkdir(resolve(path,'..'),{recursive:true});
 try{if(createHash(algorithm).update(await readFile(path)).digest('hex')===expected)return;}catch{}
 const response=await fetch(url,{signal:AbortSignal.timeout(180000)});if(!response.ok||!response.body)throw new Error('Pinned stock tool download failed: HTTP '+response.status);
 const temporary=path+'.partial-'+process.pid,hash=createHash(algorithm);let size=0;
 const meter=new Transform({transform(chunk,encoding,callback){size+=chunk.length;if(size>320*1024*1024)return callback(new Error('Stock tool exceeds its download limit.'));hash.update(chunk);callback(null,chunk);}});
 await pipeline(Readable.fromWeb(response.body),meter,createWriteStream(temporary,{flags:'wx'}));
 if(hash.digest('hex')!==expected)throw new Error('Stock tool checksum mismatch; refusing to execute or use it.');
 await rename(temporary,path);
}
const compiler=join(root,'native-circom-'+version,name);
await pinned('https://github.com/iden3/circom/releases/download/v'+version+'/'+name,compiler,'sha256',sha);await chmod(compiler,0o755);
await writeFile(join(root,'native-circom-'+version,'compiler.json'),JSON.stringify({version,platform:process.platform,sha256:sha,file:name})+'\n');
if(!process.argv.includes('--compiler-only'))await pinned('https://circom.info/powersOfTau28_hez_final_18.ptau',join(root,'stock-ceremony/powersOfTau28_hez_final_18.ptau'),'blake2b512','7e6a9c2e5f05179ddfc923f38f917c9e6831d16922a902b0b4758b8e79c2ab8a81bb5f29952e16ee6c5067ed044d7857b5de120a90704c1d3b637fd94b95b13e');
console.log('Pinned stock compiler'+(process.argv.includes('--compiler-only')?'':' and public phase1 transcript')+' verified.');
