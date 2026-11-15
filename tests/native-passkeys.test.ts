import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {createPrfPasskey,evaluatePrf,PasskeyCancelled,PasskeyUnconfirmed,PrfUnavailable} from '@arkade-os/sdk';
import {hex} from '@scure/base';
import {nativePasskeys} from '../app/src/native-passkeys.ts';

const RP='shielded.mutinynet.arkade.sh';
// Encoded with Node's Buffer rather than @scure/base, so the adapter's decoding is checked against another implementation.
const PRF='-_-_ABEiM0RVZneImaq7zN3u_wECAwQFBgcICQoLDA0',PRF31='-_-_ABEiM0RVZneImaq7zN3u_wECAwQFBgcICQoLDA',RAW='-__-AQIDBAUGBwgJCgsMDQ',USER='DPv_vwQFBgcICQoLDA0ODw',SALT='RGVmYXVsdA';
const prf=hex.decode('fbffbf00112233445566778899aabbccddeeff0102030405060708090a0b0c0d'),raw=hex.decode('fbfffe0102030405060708090a0b0c0d'),user=hex.decode('0cfbffbf0405060708090a0b0c0d0e0f');
const salt=new TextEncoder().encode('Default'),passkey={rp:{id:RP,name:'Shielded'},userId:user,userName:'Shielded wallet',salt};
const registration=(extensions:object)=>JSON.stringify({id:RAW,rawId:RAW,type:'public-key',authenticatorAttachment:'platform',response:{clientDataJSON:'e30',attestationObject:'oA',transports:['internal','hybrid'],publicKeyAlgorithm:-7},clientExtensionResults:{credProps:{rk:true},...extensions}});
const authentication=(extensions:object,userHandle:string|null=USER)=>JSON.stringify({id:RAW,rawId:RAW,type:'public-key',authenticatorAttachment:'platform',response:{clientDataJSON:'e30',authenticatorData:'AA',signature:'AA',userHandle},clientExtensionResults:extensions});

test('logical cancellation settles an unanswered native prompt and rejects its late result',async()=>{
 const abort=new AbortController();let reply!:(json:string)=>void,calls=0;
 const client=nativePasskeys(async()=>{calls++;return new Promise<string>(resolve=>{reply=resolve;});},{signal:abort.signal});
 const pending=createPrfPasskey({...passkey,client});
 await new Promise(resolve=>setImmediate(resolve));abort.abort();
 await assert.rejects(pending);reply(registration({prf:{enabled:true}}));
 await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
});

test('a retired owner cannot start the confirming get after native registration',async()=>{
 let current=true,calls=0;
 const client=nativePasskeys(async()=>{calls++;current=false;return registration({prf:{enabled:true}});},{current:()=>{if(!current)throw new Error('Retired');}});
 await assert.rejects(createPrfPasskey({...passkey,client}));assert.equal(calls,1);
});

test('confirming a native credential waits for its owner to return to the foreground',async()=>{
 let prompts=0,checks=0;const order:string[]=[];
 const client=nativePasskeys(async()=>{order.push('prompt');prompts++;return prompts===1?registration({prf:{enabled:true}}):authentication({prf:{results:{first:PRF}}});},{before:async()=>{checks++;order.push('foreground');}});
 await createPrfPasskey({...passkey,client});assert.equal(checks,2);assert.deepEqual(order,['foreground','prompt','foreground','prompt']);
});

test('a hide between foreground wait and dispatch delays the next native prompt',async()=>{
 let foreground=false,checks=0,prompts=0;
 const client=nativePasskeys(async()=>{assert.equal(foreground,true);prompts++;return authentication({prf:{results:{first:PRF}}});},{foreground:()=>foreground,before:async()=>{if(++checks===2)foreground=true;}});
 await evaluatePrf({rpId:RP,salt,client});assert.equal(prompts,1);assert.equal(checks,2);
});

function bridge(...replies:(string|{reject:unknown})[]){
 const calls:{command:string;request:Record<string,any>}[]=[];
 const client=nativePasskeys(async(command,{request})=>{
  calls.push({command,request:JSON.parse(request)});
  const reply=replies.shift();assert.ok(reply!==undefined,'unexpected bridge call');
  if(typeof reply!=='string')throw reply.reject;
  return reply;
 });
 return {client,calls};
}

test('createPrfPasskey sends base64url WebAuthn JSON through the bridge and a 32-byte PRF survives the round trip',async()=>{
 const {client,calls}=bridge(registration({prf:{enabled:true,results:{first:PRF}}}),authentication({prf:{results:{first:PRF}}}));
 assert.deepEqual(await createPrfPasskey({...passkey,client}),{credentialId:raw,prf});
 assert.deepEqual(calls.map(call=>call.command),['plugin:shielded-platform|passkey_create','plugin:shielded-platform|passkey_get']);
 const [{challenge:created,...create},{challenge:used,...get}]=calls.map(call=>call.request);
 for(const challenge of [created,used])assert.match(challenge,/^[\w-]{43}$/,'a 32-byte challenge in unpadded base64url');
 assert.deepEqual(create,{rp:{id:RP,name:'Shielded'},user:{id:USER,name:'Shielded wallet',displayName:'Shielded wallet'},pubKeyCredParams:[{type:'public-key',alg:-7},{type:'public-key',alg:-257}],authenticatorSelection:{residentKey:'required',userVerification:'required'},extensions:{prf:{eval:{first:SALT}}}});
 assert.deepEqual(get,{rpId:RP,allowCredentials:[{type:'public-key',id:RAW}],userVerification:'required',extensions:{prf:{eval:{first:SALT}}}});
});

test('a registration PRF result still requires a matching PRF from the confirming native assertion',async()=>{
 const changed=prf.slice();changed[0]^=1;
 const {client,calls}=bridge(registration({prf:{enabled:true,results:{first:PRF}}}),authentication({prf:{results:{first:Buffer.from(changed).toString('base64url')}}}));
 await assert.rejects(createPrfPasskey({...passkey,client}),error=>error instanceof PrfUnavailable&&/different secret/.test(error.message)&&hex.encode(error.credentialId!)===hex.encode(raw));
 assert.deepEqual(calls.map(call=>call.command),['plugin:shielded-platform|passkey_create','plugin:shielded-platform|passkey_get']);
});

test('evaluatePrf reads rawId, userHandle and the PRF result, and offers every passkey when no id is given',async()=>{
 const {client,calls}=bridge(authentication({prf:{results:{first:PRF}}}),authentication({prf:{results:{first:PRF}}},null),authentication({prf:{results:{first:PRF}}},`${USER}==`));
 assert.deepEqual(await evaluatePrf({rpId:RP,salt,client}),{credentialId:raw,userHandle:user,prf});
 assert.equal('allowCredentials' in calls[0]!.request,false);
 assert.equal((await evaluatePrf({rpId:RP,salt,client})).userHandle,null);
 assert.deepEqual((await evaluatePrf({rpId:RP,salt,client})).userHandle,user,'trailing padding decodes to the same bytes');
});

test('a cancelled prompt reaches the SDK as NotAllowedError and any other bridge failure does not',async()=>{
 await assert.rejects(bridge({reject:'Passkey cancelled'}).client.get({publicKey:{challenge:new Uint8Array(32)}}),(error:unknown)=>error instanceof DOMException&&error.name==='NotAllowedError');
 await assert.rejects(createPrfPasskey({...passkey,client:bridge({reject:'Passkey cancelled'}).client}),PasskeyCancelled);
 await assert.rejects(evaluatePrf({rpId:RP,salt,client:bridge({reject:'Passkey cancelled'}).client}),PasskeyCancelled);
 await assert.rejects(createPrfPasskey({...passkey,client:bridge(registration({prf:{enabled:true}}),{reject:'Passkey cancelled'}).client}),(error:unknown)=>error instanceof PasskeyUnconfirmed&&hex.encode(error.credentialId!)===hex.encode(raw));
 for(const [reject,message]of [['Passkey unavailable','Passkey unavailable'],[new Error('IPC closed'),'Passkey unavailable']] as const){
  await assert.rejects(evaluatePrf({rpId:RP,salt,client:bridge({reject}).client}),(error:unknown)=>error instanceof Error&&error.name==='Error'&&error.message===message);
 }
});

test('a passkey without a usable PRF result is PrfUnavailable and keeps the new credential id',async()=>{
 for(const [label,replies,prompts]of [
  ['create reports PRF disabled',[registration({prf:{enabled:false}})],1],
  ['create drops the PRF extension',[registration({})],1],
  ['create and get return an empty PRF',[registration({prf:{}}),authentication({prf:{}})],2],
  ['get returns 31 bytes',[registration({prf:{enabled:true}}),authentication({prf:{results:{first:PRF31}}})],2],
 ] as const){
  const {client,calls}=bridge(...replies);
  await assert.rejects(createPrfPasskey({...passkey,client}),(error:unknown)=>error instanceof PrfUnavailable&&error.name==='PrfUnavailable'&&hex.encode(error.credentialId!)===hex.encode(raw),label);
  assert.equal(calls.length,prompts,label);
 }
});

test('a malformed bridge response fails without quoting the response',async()=>{
 for(const reply of [`{"rawId":"${RAW}","clientExtensionResults":{"prf":{"results":{"first":["${PRF}",]}}}}`,authentication({prf:{results:{first:PRF}}}).replace(`"rawId":"${RAW}"`,'"rawId":"+//+AQIDBAUGBwgJCgsMDQ"')]){
  await assert.rejects(bridge(reply).client.get({publicKey:{challenge:new Uint8Array(32)}}),(error:unknown)=>error instanceof Error&&error.message==='Passkey unavailable');
 }
});

test('native assertions refuse another credential when the request restricts its identity',async()=>{
 const {client}=bridge(authentication({prf:{results:{first:PRF}}}));
 await assert.rejects(evaluatePrf({rpId:RP,salt,credentialIds:[new Uint8Array([1,2,3])],client}),/Passkey unavailable/);
});

test('native relying-party enforcement and Apple associations match the bundled pool origin',()=>{
 const source=(path:string)=>readFileSync(new URL(path,import.meta.url),'utf8'),plugin='../src-tauri/plugins/shielded-platform/';
 const origin=/poolOrigin: '([^']+)'/.exec(source('../src-tauri/src/lib.rs'))?.[1];assert.ok(origin);
 const url=new URL(origin);assert.equal(url.protocol,'https:');assert.equal(url.hostname,RP);
 for(const [path,pattern,expected]of [
  [plugin+'src/passkeys/mod.rs',/const RP: &str = "([^"]+)"/,url.hostname],
  [plugin+'src/passkeys/linux.rs',/const ORIGIN: &str = "([^"]+)"/,url.origin],
  [plugin+'ios/Sources/Passkeys.swift',/static let rpID = "([^"]+)"/,url.hostname],
  ['../src-tauri/macos/PasskeyEntitlements.plist',/<string>(webcredentials:[^<]+)<\/string>/,`webcredentials:${url.hostname}`],
  ['../tools/native-build.mjs',/domain = '(webcredentials:[^']+)'/,`webcredentials:${url.hostname}`],
 ]as const)assert.equal(pattern.exec(source(path))?.[1],expected,path);
});

test('passkey commands, permissions and the cancel message line up across build.rs, Rust, the capability and Kotlin',()=>{
 const source=(path:string)=>readFileSync(new URL(path,import.meta.url),'utf8'),plugin='../src-tauri/plugins/shielded-platform/';
 const build=source(plugin+'build.rs'),rust=source(plugin+'src/lib.rs'),kotlin=source(plugin+'android/src/main/java/io/arkade/shielded/platform/ShieldedPlatformPlugin.kt');
 const commands=[...(/Builder::new\(&\[([^\]]*)\]\)/.exec(build)?.[1]??'').matchAll(/"(\w+)"/g)].map(match=>match[1]!).sort();
 const handlers=[...(/generate_handler!\[([^\]]*)\]/.exec(rust)?.[1]??'').matchAll(/\w+/g)].map(match=>match[0]).sort();
 const permissions=(JSON.parse(source('../src-tauri/capabilities/main.json')).permissions as unknown[]).filter((entry):entry is string=>typeof entry==='string'&&entry.startsWith('shielded-platform:')).sort();
 assert.ok(commands.includes('passkey_create')&&commands.includes('passkey_get'));
 assert.deepEqual(handlers,commands);
 assert.deepEqual(permissions,commands.map(command=>`shielded-platform:allow-${command.replaceAll('_','-')}`).sort());
 for(const command of commands){
  const native=command.replace(/_(\w)/g,(_,letter:string)=>letter.toUpperCase());
  assert.match(kotlin,new RegExp(`@Command\\s+fun ${native}\\(invoke: Invoke\\)`),native);
  assert.ok(rust.includes(`"${native}"`),native);
 }
 assert.match(rust,/const PASSKEY_CANCELLED: &str = "Passkey cancelled";/);
 assert.match(source(plugin+'android/src/main/java/io/arkade/shielded/platform/AndroidPasskeys.kt'),/const val PASSKEY_CANCELLED = "Passkey cancelled"/);
 assert.match(source(plugin+'android/build.gradle.kts'),/"androidx\.credentials:credentials:([\d.]+)"\)\s+implementation\("androidx\.credentials:credentials-play-services-auth:\1"\)/);
});
