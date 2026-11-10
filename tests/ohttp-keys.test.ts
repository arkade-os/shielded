import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {promisify} from 'node:util';
import {x25519} from '@noble/curves/ed25519.js';
import {AEAD_AES_128_GCM,CipherSuite,KDF_HKDF_SHA256,KEM_DHKEM_X25519_HKDF_SHA256} from 'hpke';
import {KeyConfig,OHTTPClient} from 'ohttp-ts';
import {generateOhttpKey,loadOhttpKey} from '../src/rollup/ohttp-keys.ts';

const FORMAT=/<keyId>:<base64url of the 32-byte X25519 private key>/;
const split=(env:string)=>({keyId:Number(env.slice(0,env.indexOf(':'))),secret:env.slice(env.indexOf(':')+1)});

test('a generated key round-trips through its env form and yields the same config',async()=>{
 const made=await generateOhttpKey(),loaded=await loadOhttpKey(made.env);
 assert.deepEqual(loaded?.config,made.config);
 assert.equal(loaded?.keyId,split(made.env).keyId);
 assert.notEqual((await generateOhttpKey()).env,made.env,'every key is new');
});

test('an unset key leaves the gateway off',async()=>{
 assert.equal(await loadOhttpKey(undefined),undefined);
 assert.equal(await loadOhttpKey(''),undefined);
});

test('a malformed key is refused with the expected format in the message',async()=>{
 const {secret}=split((await generateOhttpKey()).env);
 const bad={'no id':secret,'empty id':`:${secret}`,'id above 255':`256:${secret}`,'31 bytes':`1:${secret.slice(0,-1)}`,'33 bytes':`1:${secret}A`,'padded':`1:${secret}=`,'not base64url':`1:${secret.slice(0,-1)}+`};
 for(const [why,env] of Object.entries(bad))await assert.rejects(loadOhttpKey(env),(error:Error)=>{
  assert.match(error.message,FORMAT,why);
  assert.ok(!error.message.includes(secret),`${why}: the message must not repeat the key`);
  return true;
 });
});

test('the encoded config names the pinned suite',async()=>{
 const {env,config}=await generateOhttpKey(),{keyId,secret}=split(env),view=new DataView(config.buffer,config.byteOffset,config.byteLength);
 assert.equal(config.length,43);
 assert.equal(view.getUint16(0),41,'application/ohttp-keys: one length-prefixed key configuration');
 assert.equal(view.getUint8(2),keyId);
 assert.equal(view.getUint16(3),0x0020,'DHKEM(X25519, HKDF-SHA256)');
 assert.deepEqual(config.slice(5,37),x25519.getPublicKey(Buffer.from(secret,'base64url')));
 assert.equal(view.getUint16(37),4,'one KDF and AEAD pair');
 assert.equal(view.getUint16(39),0x0001,'HKDF-SHA256');
 assert.equal(view.getUint16(41),0x0001,'AES-128-GCM');
});

test('a client that reads the published config exchanges a request and a 4 MiB response with the loaded server',async()=>{
 const suite=new CipherSuite(KEM_DHKEM_X25519_HKDF_SHA256,KDF_HKDF_SHA256,AEAD_AES_128_GCM),key=(await loadOhttpKey((await generateOhttpKey()).env))!;
 const client=new OHTTPClient(suite,KeyConfig.select(suite,KeyConfig.parseMultiple(key.config)),{maxMessageSize:5<<20});
 const {init,context}=await client.encapsulateRequest(new Request('https://target.example/v1/info',{headers:{accept:'application/json'}}));
 const opened=await key.server.decapsulateRequest(new Request('https://gateway.example/ohttp',init));
 assert.equal(opened.request.url,'https://target.example/v1/info');
 assert.equal(opened.request.headers.get('accept'),'application/json');
 const body=new Uint8Array(4<<20).fill(7),response=await context.decapsulateResponse(await opened.context.encapsulateResponse(new Response(body,{status:200})));
 assert.equal(response.status,200);
 assert.deepEqual(new Uint8Array(await response.arrayBuffer()),body);
});

test('the Nostr key is derived from the OHTTP key',async()=>{
 const key=(await loadOhttpKey('7:'+Buffer.alloc(32,1).toString('base64url')))!;
 assert.equal(Buffer.from(key.nostrSecret).toString('hex'),'0e4cd930c29efd7569b9c1573ac7cb4eefe3af331f1d536cc9c45528fee69828');
 assert.equal(key.nostrPublic,'06f039a86ac2ca05938d277ec5efb6aab8620431699837354e8e069b337668d1');
 const made=await generateOhttpKey();assert.equal(made.nostrPublic,(await loadOhttpKey(made.env))!.nostrPublic);assert.notEqual(made.nostrPublic,key.nostrPublic);
});

test('the keygen tool writes the key only to a new private file and prints just the id, config and Nostr key',async(t)=>{
 const dir=mkdtempSync(join(tmpdir(),'ohttp-keygen-')),file=join(dir,'ohttp.key'),run=(...args:string[])=>promisify(execFile)(process.execPath,['--import','tsx','tools/ohttp-keygen.ts',...args]);
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const {stdout}=await run(file),line=readFileSync(file,'utf8'),env=line.replace(/^SHIELDED_OHTTP_KEY=/,'').trim(),{secret}=split(env),key=(await loadOhttpKey(env))!;
 assert.equal(line,`SHIELDED_OHTTP_KEY=${env}\n`);
 assert.equal(stdout,`key id: ${key.keyId}\nconfig: ${Buffer.from(key.config).toString('base64url')}\nnostr: ${key.nostrPublic}\n`);
 assert.match(stdout,/^nostr: [0-9a-f]{64}$/m);assert.ok(!stdout.includes(secret),'stdout never carries the secret');
 if(process.platform!=='win32')assert.equal(statSync(file).mode&0o777,0o600);
 await assert.rejects(run(file),(error:{stderr:string})=>{assert.match(error.stderr,/already exists/);assert.ok(!error.stderr.includes(secret));return true;});
 assert.equal(readFileSync(file,'utf8'),line,'a second run leaves the first key alone');
 await assert.rejects(run(),/Usage/);
 await assert.rejects(run(file,'extra'),/Usage/);
});
