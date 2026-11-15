import {invoke} from '@tauri-apps/api/core';

type Call=(command:string,args?:Record<string,unknown>)=>Promise<unknown>;
export function createWalletClipboard(
 native=()=>typeof __NATIVE_BUILD__!=='undefined'&&__NATIVE_BUILD__,
 call:Call=invoke,
 browser:()=>Pick<Clipboard,'readText'|'writeText'>=()=>navigator.clipboard,
 platform=()=>typeof __NATIVE_PLATFORM__==='string'?__NATIVE_PLATFORM__:''
){
 return {
  async readText(){
   const command=platform().startsWith('android')?'plugin:shielded-platform|clipboard_text':'plugin:clipboard-manager|read_text';
   const text=native()?await call(command):await browser().readText();
   if(typeof text!=='string'||text.length>8192)throw new Error('The clipboard holds no usable payment text.');
   return text;
  },
  async writeText(text:string){
   if(native())await call('plugin:clipboard-manager|write_text',{text});else await browser().writeText(text);
  }
 };
}
export const {readText:readWalletClipboard,writeText:writeWalletClipboard}=createWalletClipboard();
