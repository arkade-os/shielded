import assert from 'node:assert/strict';
import {test} from 'node:test';
import {isPrivateFetch,isSealedFetch} from '../src/shielded/network-privacy.ts';

test('native renderer disables WebRTC constructors before an ICE connection can start',async()=>{
 let direct=0;
 Object.defineProperty(globalThis,'__SHIELDED_NATIVE__',{value:{version:1,poolOrigin:'https://shielded.mutinynet.arkade.sh'}});
 for(const name of ['RTCPeerConnection','webkitRTCPeerConnection'])Object.defineProperty(globalThis,name,{value:class {constructor(){direct++;}},configurable:true});
 const {installNativeTransport}=await import('../src/native/index.ts');
 installNativeTransport();
 for(const name of ['RTCPeerConnection','webkitRTCPeerConnection']){
  assert.throws(()=>Reflect.construct(Reflect.get(globalThis,name),[{iceServers:[{urls:'stun:example.com'}]}]),/WebRTC/);
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,name)!;
  assert.equal(descriptor.writable,false);assert.equal(descriptor.configurable,false);
 }
 assert.equal(direct,0);
});

test('the native fetch is private but not sealed, so it keeps the retries a sealed fetch gives up',async()=>{
 const {nativeFetch}=await import('../src/native/index.ts');
 assert.deepEqual([isPrivateFetch(nativeFetch),isSealedFetch(nativeFetch)],[true,false]);
});
