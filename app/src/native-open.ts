import type {NativeMode,NativeStatus} from '../../src/native/transport.ts';

export async function openNativeVault(start:()=>Promise<NativeStatus>,read:()=>Promise<string|null>,current:()=>boolean,expected?:{generation?:number;mode:NativeMode;current:()=>boolean}){
 if(!current())return;
 const status=await start();if(!current())return;
 if(status.phase!=='ready')throw new Error(status.error??'Tor is not ready.');
 if(expected&&(expected.generation!==undefined&&status.generation!==expected.generation||(status.mode??'tor')!==expected.mode))return;
 if(expected&&!expected.current())return;
 const secret=await read();if(!current())return;
 if(expected&&!expected.current())return;
 return {status,secret};
}

export async function resumeNativeForeground(pending:Promise<unknown>,current:()=>boolean,open:()=>Promise<void>){
 await pending;
 if(current())await open();
}
