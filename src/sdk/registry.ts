import { sha256 } from '@noble/hashes/sha2.js';
import { hex } from '@scure/base';
import { arkade } from '@arkade-os/sdk';
import { concatBytes } from '@noble/hashes/utils.js';
import type { CompiledContract, PacketData } from './adapter.ts';
export interface RegistryContract extends CompiledContract {registryOriginal:CompiledContract}
export function registeredContract(original:CompiledContract,programs:Record<string,string>):RegistryContract {
 const serialized=JSON.parse(arkade.stringifyArtifact(original.program));
 for(const fn of original.script.compiled){if(!fn.arkadeScript)continue;const id=hex.encode(sha256(fn.arkadeScript));programs[id]=hex.encode(fn.arkadeScript);serialized.functions[fn.name].arkadeScript={asm:['0x'+id,'RETURN'],witness:[]};}
 const program=arkade.parseArtifact(serialized);const script=new arkade.ArkadeProgramScript(program,original.args,original.keys);
 return {...original,program,script,registryOriginal:original};
}
function u16(value:number){if(!Number.isInteger(value)||value<0||value>65535)throw new Error('Registry integer out of range');return Uint8Array.of(value&255,value>>8);}
export function registrySidecar(packets:readonly PacketData[],entries:{vin:number;profile:Uint8Array;witness:Uint8Array[]}[],oldState:Uint8Array):Uint8Array{
 if(entries.length<1||entries.length>4)throw new Error('Invalid registry input count');const parts:Uint8Array[]=[Uint8Array.of(0x53,1)];
 for(let type=0x80;type<=0x83;type++){const matching=packets.filter(p=>p.type===type);if(matching.length!==1||matching[0].data.length>520)throw new Error('Missing or duplicate registry public packet');parts.push(u16(matching[0].data.length),matching[0].data);}
 if(oldState.length!==160)throw new Error("Invalid registry old state");parts.push(u16(oldState.length),oldState);
 parts.push(Uint8Array.of(entries.length));let previous=-1;
 for(const entry of entries){if(entry.vin<=previous||entry.profile.length!==32||entry.witness.length>1000)throw new Error('Noncanonical registry entry');previous=entry.vin;parts.push(u16(entry.vin),entry.profile,u16(entry.witness.length));for(const item of entry.witness){if(item.length>520)throw new Error('Registry witness exceeds VM limit');parts.push(u16(item.length),item);}}
 const encoded=concatBytes(...parts);if(encoded.length>128*1024)throw new Error('Registry sidecar exceeds bound');return encoded;
}
