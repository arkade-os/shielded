import {hkdf} from '@noble/hashes/hkdf.js';
import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex,hexToBytes} from '@noble/hashes/utils.js';
import {secp256k1} from '@noble/curves/secp256k1.js';
import {entropyToMnemonic,mnemonicToEntropy} from '@scure/bip39';
import {wordlist} from '@scure/bip39/wordlists/english.js';
import {ROLLUP_FIELD} from './rollup/constants.ts';

export const WALLET_KEY_DERIVATION_VERSION=1 as const;
export const MUTINYNET_KEY_NETWORK='mutinynet' as const;
export interface WalletKeyMaterial {keys:{spend:string;view:string};nativeSecret:string}
const BABYJUB_SUBORDER=2736030358979909402780800718157159386076813972158567259200215660948447373041n;
const SECP256K1_ORDER=secp256k1.Point.Fn.ORDER;
const DOMAIN='arkade-shielded:wallet-key-derivation:v1';
const SALT=new TextEncoder().encode('arkade-shielded:master-secret:v1');
const MNEMONIC12=new TextEncoder().encode(`${DOMAIN}:mnemonic12:v1`);

const phraseEntropy=(value:string)=>{
 const words=value.trim().toLowerCase().split(/\s+/);
 if(words.length!==12&&words.length!==24)return undefined;
 try{return mnemonicToEntropy(words.join(' '),wordlist);}catch{throw new Error('That recovery phrase is not valid; check each word.');}
};

export function parseMasterSecret(value:string):Uint8Array {
 if(typeof value==='string'&&/^(?:[0-9a-fA-F]{2}){32}$/.test(value))return hexToBytes(value);
 const entropy=typeof value==='string'?phraseEntropy(value):undefined;
 if(!entropy)throw new Error('A recovery phrase is 12 or 24 words (older wallets: 64 hexadecimal characters).');
 // A permanent recovery constant: changing this stretch loses every wallet created from 12 words.
 return entropy.length===32?entropy:hkdf(sha256,entropy,SALT,MNEMONIC12,32);
}
/** The phrase a wallet is backed up with: 24 words are the 32-byte secret itself, and a 12-word phrase comes back as its own 12 words, since the stretch above cannot be reversed. */
export const recoveryPhraseOf=(masterSecret:Uint8Array|string)=>{
 if(typeof masterSecret!=='string'&&masterSecret.length!==32)throw new Error('A master secret is 32 bytes.');
 return entropyToMnemonic(typeof masterSecret==='string'?phraseEntropy(masterSecret)??parseMasterSecret(masterSecret):masterSecret,wordlist);
};

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

/** Genesis-2 rollup keys: spend authority, the nullifier key a full viewing key shares, and the X25519 view secret. */
export function deriveRollupKeys2(masterSecret:Uint8Array|string,network:string):{ask:bigint;nk:bigint;viewSecret:Uint8Array} {
 const master=typeof masterSecret==='string'?parseMasterSecret(masterSecret):new Uint8Array(masterSecret);
 if(master.length!==32)throw new Error('Recovery secret must contain exactly 32 bytes.');
 return {ask:scalar(master,network,'rollup2-ask',ROLLUP_FIELD),nk:scalar(master,network,'rollup2-nk',ROLLUP_FIELD),viewSecret:hkdf(sha256,master,SALT,new TextEncoder().encode(`${DOMAIN}:${network}:rollup2-view`),32)};
}

/** A claim link's seed, keyed by the nullifier of the note that funded it: unique per link, and re-derivable from the phrase. */
export function bearerSecretOf(masterSecret:Uint8Array|string,network:string,nullifier:bigint):Uint8Array {
 const master=typeof masterSecret==='string'?parseMasterSecret(masterSecret):new Uint8Array(masterSecret);
 if(master.length!==32)throw new Error('Recovery secret must contain exactly 32 bytes.');
 if(!/^[a-z0-9][a-z0-9.-]{0,62}$/.test(network))throw new Error('Invalid wallet network label.');
 return hkdf(sha256,master,SALT,new TextEncoder().encode(`${DOMAIN}:${network}:rollup2-bearer:${nullifier}`),32);
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
