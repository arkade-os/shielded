import assert from 'node:assert/strict';
import test from 'node:test';
import {createWalletClipboard} from '../app/src/wallet-clipboard.ts';

test('native copy and paste use system clipboard commands across desktop and iOS',async()=>{
 const calls:{command:string;args?:Record<string,unknown>}[]=[];
 const clipboard=createWalletClipboard(()=>true,async(command,args)=>{calls.push({command,args});return 'lightning:invoice';},()=>{throw new Error('unexpected browser clipboard');});
 assert.equal(await clipboard.readText(),'lightning:invoice');await clipboard.writeText('arkade:address');
 assert.deepEqual(calls,[{command:'plugin:clipboard-manager|read_text',args:undefined},{command:'plugin:clipboard-manager|write_text',args:{text:'arkade:address'}}]);
});

test('Android paste retains the bounded plain-text reader instead of coercing content URIs',async()=>{
 const commands:string[]=[];
 const clipboard=createWalletClipboard(()=>true,async command=>{commands.push(command);return 'invoice';},()=>{throw new Error('unexpected browser clipboard');},()=>'android-arm64');
 assert.equal(await clipboard.readText(),'invoice');assert.deepEqual(commands,['plugin:shielded-platform|clipboard_text']);
});

test('non-text and oversized clipboard entries cannot fill a payment destination',async()=>{
 for(const value of [null,{},'a'.repeat(8193)]){
  const clipboard=createWalletClipboard(()=>true,async()=>value);
  await assert.rejects(clipboard.readText(),/no usable payment text/);
 }
});

test('browser copy and paste retain their user-initiated clipboard path',async()=>{
 const written:string[]=[];
 const clipboard=createWalletClipboard(()=>false,async()=>{throw new Error('unexpected native clipboard');},()=>({readText:async()=>'bitcoin:address',writeText:async text=>{written.push(text);}}));
 assert.equal(await clipboard.readText(),'bitcoin:address');await clipboard.writeText('address');assert.deepEqual(written,['address']);
});

test('native clipboard errors propagate without falling back or exposing clipboard contents',async()=>{
 const clipboard=createWalletClipboard(()=>true,async()=>{throw new Error('Clipboard unavailable');},()=>{throw new Error('unexpected browser fallback');});
 await assert.rejects(clipboard.readText(),/Clipboard unavailable/);await assert.rejects(clipboard.writeText('private'),/Clipboard unavailable/);
});
