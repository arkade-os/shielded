import {randomInt} from 'node:crypto';
import {x25519} from '@noble/curves/ed25519.js';
import {AEAD_AES_128_GCM,CipherSuite,KDF_HKDF_SHA256,KEM_DHKEM_X25519_HKDF_SHA256} from 'hpke';
import {KeyConfig,OHTTPServer} from 'ohttp-ts';

/** `config` is the `application/ohttp-keys` body (RFC 9458 section 3.2): one length-prefixed key configuration. */
export interface OhttpGatewayKey{keyId:number;config:Uint8Array;server:OHTTPServer}

const SUITE=new CipherSuite(KEM_DHKEM_X25519_HKDF_SHA256,KDF_HKDF_SHA256,AEAD_AES_128_GCM);
const FORMAT='SHIELDED_OHTTP_KEY must be <keyId>:<base64url of the 32-byte X25519 private key>, with a key id from 0 to 255; npm run ohttp:keygen -- <file> makes one.';
// The server's cap covers the 4 MiB inner response, its headers and padding; the 1 MiB request cap is the route's body limit.
const MAX_MESSAGE=5<<20;

const keyOf=async(keyId:number,secret:Uint8Array):Promise<OhttpGatewayKey>=>{
 const keyConfig=await KeyConfig.import(SUITE,keyId,x25519.getPublicKey(secret),secret);
 return {keyId,config:KeyConfig.serializeMultiple([keyConfig]),server:new OHTTPServer([keyConfig],{maxMessageSize:MAX_MESSAGE})};
};

export const loadOhttpKey=async(env:string|undefined):Promise<OhttpGatewayKey|undefined>=>{
 const value=env?.trim();
 if(!value)return undefined;
 const match=/^(\d{1,3}):([A-Za-z0-9_-]{43})$/.exec(value);
 if(!match||Number(match[1])>255)throw new Error(FORMAT);
 return keyOf(Number(match[1]),Buffer.from(match[2],'base64url'));
};

export const generateOhttpKey=async():Promise<{env:string;config:Uint8Array}>=>{
 const keyId=randomInt(256),secret=x25519.utils.randomSecretKey();
 return {env:`${keyId}:${Buffer.from(secret).toString('base64url')}`,config:(await keyOf(keyId,secret)).config};
};
