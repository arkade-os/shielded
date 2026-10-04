import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { isValidOwner, type Owner, type PublicRecipient } from './types.js';

export type RegistrationNetwork='local-emulator'|'mutinynet';
export interface ParticipantAuthorization {version:1;network:RegistrationNetwork;profile:string;signature:string}
export interface RegistrationPayload {owner:Owner;recipient:PublicRecipient;nativePublicKey:string;authorization:ParticipantAuthorization}
export const REGISTRATION_DOMAIN='arkade-shielded:participant-registration:v1';

function publicKey(value:string){if(!/^[0-9a-f]{64}$/.test(value))throw new Error('Native participant key must be lowercase x-only hex.');return hexToBytes(value);}
function canonical(network:RegistrationNetwork,profile:string,owner:Owner,recipient:PublicRecipient,nativePublicKey:string){
 if(network!=='local-emulator'&&network!=='mutinynet')throw new Error('Unsupported participant network.');
 if(!/^[0-9a-f]{64}$/.test(profile))throw new Error('Invalid proof profile fingerprint.');
 if(!isValidOwner(owner)||owner!==nativePublicKey)throw new Error('Participant ID must equal its native public key.');
 if(!recipient||typeof recipient.owner!=='string'||!Array.isArray(recipient.viewPublicKey)||recipient.viewPublicKey.length!==2||recipient.viewPublicKey.some(value=>typeof value!=='string'))throw new Error('Invalid public recipient descriptor.');
 return JSON.stringify({domain:REGISTRATION_DOMAIN,version:1,network,profile,owner,nativePublicKey,recipient:{owner:recipient.owner,viewPublicKey:[...recipient.viewPublicKey]}});
}
function message(network:RegistrationNetwork,profile:string,owner:Owner,recipient:PublicRecipient,nativePublicKey:string){return sha256(new TextEncoder().encode(canonical(network,profile,owner,recipient,nativePublicKey)));}

export function participantId(nativePublicKey:string):Owner {publicKey(nativePublicKey);return nativePublicKey;}
export function participantPublicKey(secretKey:string|Uint8Array):string {
 const secret=typeof secretKey==='string'?hexToBytes(secretKey):new Uint8Array(secretKey);if(secret.length!==32)throw new Error('Native secret must be 32 bytes.');return bytesToHex(schnorr.getPublicKey(secret));
}
export function signParticipantRegistration(args:{network:RegistrationNetwork;profile:string;secretKey:string|Uint8Array;recipient:PublicRecipient}):RegistrationPayload {
 const nativePublicKey=participantPublicKey(args.secretKey),owner=participantId(nativePublicKey),signature=bytesToHex(schnorr.sign(message(args.network,args.profile,owner,args.recipient,nativePublicKey),typeof args.secretKey==='string'?hexToBytes(args.secretKey):args.secretKey));
 return {owner,recipient:structuredClone(args.recipient),nativePublicKey,authorization:{version:1,network:args.network,profile:args.profile,signature}};
}
export function verifyParticipantRegistration(payload:RegistrationPayload,expectedNetwork:RegistrationNetwork,expectedProfile:string):boolean {
 try{
  if(!payload||!payload.authorization||payload.authorization.version!==1||payload.authorization.network!==expectedNetwork||payload.authorization.profile!==expectedProfile||!/^[0-9a-f]{128}$/.test(payload.authorization.signature))return false;
  return schnorr.verify(hexToBytes(payload.authorization.signature),message(expectedNetwork,expectedProfile,payload.owner,payload.recipient,payload.nativePublicKey),publicKey(payload.nativePublicKey));
 }catch{return false;}
}
