import type {NativeMode,NativeStatus} from '../../src/native/transport.ts';

export async function openNativeVault(start:()=>Promise<NativeStatus>,read:()=>Promise<string|null>,current:()=>boolean,expected?:{generationAfter:number;mode:NativeMode}){
 if(!current())return;
 const status=await start();if(!current())return;
 if(status.phase!=='ready')throw new Error(status.error??'Tor is not ready.');
 if(expected&&(status.generation<=expected.generationAfter||(status.mode??'tor')!==expected.mode))return;
 const secret=await read();if(!current())return;
 return {status,secret};
}
