import type {NativeStatus} from '../../src/native/transport.ts';

export async function openNativeVault(start:()=>Promise<NativeStatus>,read:()=>Promise<string|null>,current:()=>boolean){
 if(!current())return;
 const status=await start();if(!current())return;
 if(status.phase!=='ready')throw new Error(status.error??'Tor is not ready.');
 const secret=await read();if(!current())return;
 return {status,secret};
}
