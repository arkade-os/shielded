import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readNativeReleaseResponse} from '../src/native-release-response.ts';

const cases:{status:number;headers:Record<string,string>;message:RegExp}[]=[
 {status:503,headers:{},message:/unavailable/},
 {status:200,headers:{'content-length':'65537'},message:/too large/},
 {status:200,headers:{'content-length':'invalid'},message:/too large/},
];
for(const rejected of cases)test(`rejected release response cancels its body: ${rejected.status} ${JSON.stringify(rejected.headers)}`,async()=>{
 let cancelled=false;
 const body=new ReadableStream<Uint8Array>({cancel(){cancelled=true;}});
 await assert.rejects(readNativeReleaseResponse(new Response(body,rejected)),rejected.message);
 assert.equal(cancelled,true);
});
