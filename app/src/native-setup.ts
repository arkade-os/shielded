import type {NativeStatus} from '../../src/native/transport.ts';

export async function saveNativeSetup(expected:NativeStatus,status:()=>Promise<NativeStatus>,current:()=>boolean,make:()=>string,write:(secret:string)=>Promise<void>){
 if(expected.phase!=='ready')throw new Error('Wait until the selected connection is ready before creating or restoring your wallet.');
 const actual=await status();
 if(!current()||actual.phase!=='ready'||actual.generation!==expected.generation||(actual.mode??'tor')!==(expected.mode??'tor'))throw new Error('The connection changed. Wait until it is ready and try again.');
 const secret=make();
 if(!current())throw new Error('The connection changed. Wait until it is ready and try again.');
 await write(secret);
}
