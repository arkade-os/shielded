import {spawn} from 'node:child_process';
import {Extension,P2A,Transaction,type ExtensionPacket} from '@arkade-os/sdk';

/** A synthetic parent transaction whose outputs stand in for coins arkd would have created. */
export function offlineNativeFixture(outputs:readonly {script:Uint8Array;amount:bigint}[],extensionPackets:readonly ExtensionPacket[]=[]):Transaction {
 const tx=new Transaction({version:3,lockTime:0});
 tx.addInput({txid:'11'.repeat(32),index:0,sequence:0xfffffffd});
 for(const output of outputs)tx.addOutput(output);
 if(extensionPackets.length)tx.addOutput(Extension.create([...extensionPackets]).txOut());
 tx.addOutput(P2A);
 return tx;
}

/** One child per call keeps a rejected spend's VM state isolated. */
export function executeVmBinary(binary:string,request:{arkTx:string;checkpoints:string[]}):Promise<{ok:boolean;error?:string;arkTx?:string;checkpoints?:string[]}> {
 return new Promise((resolve,reject)=>{
  const child=spawn(binary,[],{stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',(chunk:string)=>{stdout+=chunk;});child.stderr.on('data',(chunk:string)=>{stderr+=chunk;});
  child.on('error',reject);
  child.on('close',code=>{
   if(code!==0)return reject(new Error(`Emulator bridge exited ${code}: ${stderr.slice(-2000)}`));
   try{resolve(JSON.parse(stdout.trim().split('\n').at(-1)!));}catch(error){reject(error);}
  });
  child.stdin.end(JSON.stringify(request)+'\n');
 });
}
