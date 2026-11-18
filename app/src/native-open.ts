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

export const NATIVE_FOREGROUND_HOLD='Shielded is waiting for Android to bring it back to the foreground. Switch to another app and back to continue.';

// Android can leave the host believing the app is still in the background, and it then refuses every new connection.
export function nativeForegroundHold(status:NativeStatus|undefined,state:{visible:boolean;live:boolean;paused:boolean}){
 if(!state.visible||state.live||state.paused)return;
 return status?.foreground===false?NATIVE_FOREGROUND_HOLD:undefined;
}

export async function resumeNativeForeground(pending:Promise<unknown>,current:()=>boolean,open:()=>Promise<void>,retained?:()=>Promise<boolean>){
 await pending;
 if(!current())return;
 if(retained&&await retained())return;
 if(current())await open();
}

export async function reopenNativeForeground(views:{shown?:{retired:boolean};candidate?:unknown},current:()=>boolean,retire:()=>Promise<void>,open:()=>Promise<void>){
 if(views.candidate||views.shown&&!views.shown.retired)await retire();
 if(current())await open();
}
