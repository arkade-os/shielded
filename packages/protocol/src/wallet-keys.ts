import {hkdf} from '@noble/hashes/hkdf.js';
import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex,hexToBytes} from '@noble/hashes/utils.js';
import {secp256k1} from '@noble/curves/secp256k1.js';
import {ROLLUP_FIELD} from './rollup/constants.ts';

export const WALLET_KEY_DERIVATION_VERSION=1 as const;
export const MUTINYNET_KEY_NETWORK='mutinynet' as const;
export interface WalletKeyMaterial {keys:{spend:string;view:string};nativeSecret:string}
const BABYJUB_SUBORDER=2736030358979909402780800718157159386076813972158567259200215660948447373041n;
const SECP256K1_ORDER=secp256k1.Point.Fn.ORDER;
const DOMAIN='arkade-shielded:wallet-key-derivation:v1';
const SALT=new TextEncoder().encode('arkade-shielded:master-secret:v1');

export function parseMasterSecret(value:string):Uint8Array {
 if(typeof value!=='string'||!/^(?:[0-9a-fA-F]{2}){32}$/.test(value))throw new Error('Recovery secret must be exactly 64 hexadecimal characters.');
 return hexToBytes(value);
}

function scalar(master:Uint8Array,network:string,purpose:string,order:bigint):bigint {
 if(!/^[a-z0-9][a-z0-9.-]{0,62}$/.test(network))throw new Error('Invalid wallet network label.');
 for(let counter=0;counter<4096;counter++){
  const info=new TextEncoder().encode(`${DOMAIN}:${network}:${purpose}:${counter}`);
  const candidate=BigInt('0x'+bytesToHex(hkdf(sha256,master,SALT,info,32)));
  if(candidate>0n&&candidate<order)return candidate;
 }
 throw new Error('Could not derive a valid wallet key.');
}

/** Rollup v2 keys from the same recovery secret: a spend scalar in the BN254 scalar field and an X25519 view secret. */
export function deriveRollupKeyMaterial(masterSecret:Uint8Array|string,network:string):{spendSecret:bigint;viewSecret:Uint8Array} {
 const master=typeof masterSecret==='string'?parseMasterSecret(masterSecret):new Uint8Array(masterSecret);
 if(master.length!==32)throw new Error('Recovery secret must contain exactly 32 bytes.');
 return {spendSecret:scalar(master,network,'rollup-spend',ROLLUP_FIELD),viewSecret:hkdf(sha256,master,SALT,new TextEncoder().encode(`${DOMAIN}:${network}:rollup-view`),32)};
}

export function deriveWalletKeyMaterial(masterSecret:Uint8Array|string,network:string):WalletKeyMaterial {
 const master=typeof masterSecret==='string'?parseMasterSecret(masterSecret):new Uint8Array(masterSecret);
 if(master.length!==32)throw new Error('Recovery secret must contain exactly 32 bytes.');
 if(!/^[a-z0-9][a-z0-9.-]{0,62}$/.test(network))throw new Error('Invalid wallet network label.');
 const withdrawal=scalar(master,network,'secp256k1-withdrawal',SECP256K1_ORDER);
 return {
  keys:{
   spend:scalar(master,network,'babyjub-spend',BABYJUB_SUBORDER).toString(),
   view:scalar(master,network,'babyjub-view',BABYJUB_SUBORDER).toString()
  },
  nativeSecret:withdrawal.toString(16).padStart(64,'0')
 };
}
