export type Asset = 'BTC' | 'DEMO';
// Legacy fixtures use alice/bob. Client-owned deployments use a validated
// public participant identifier (the native x-only key in the live UI).
export type Owner = string;
export const LEGACY_OWNERS = ['alice','bob'] as const;
const RESERVED_OWNERS = new Set(['__proto__','prototype','constructor']);
export function isValidOwner(value: unknown): value is Owner {
 return typeof value==='string'&&value.length<=128&&/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)&&!RESERVED_OWNERS.has(value.toLowerCase());
}
export type Groth16Proof = {pi_a:string[];pi_b:string[][];pi_c:string[];protocol:string;curve:string};
export interface ProtocolState {noteRoot:string;spentRoot:string;historyRoot:string;noteCount:number;historyCount:number;revision:number;reserves:Record<Asset,number>}
export interface EncryptedRecord {index:number;commitment:string;ciphertext:string[];leaf:string;createdRevision:number}
export interface PreparedSettlement {id:string;operation:'shield'|'transfer'|'withdraw'|'seal';intentProof?:Groth16Proof;transitionProof:Groth16Proof;intentSignals:string[];transitionSignals:string[];oldState:ProtocolState;newState:ProtocolState;ciphertextRecords:EncryptedRecord[];boundary:{deposit:Record<Asset,number>;withdrawal:Record<Asset,number>;destination:string};proofTimes:{intentMs:number;transitionMs:number};metadata?:Record<string,unknown>}
export interface OwnedNote {index:number;amount:number;asset:Asset;owner:string;rho:string;commitment:string;ciphertext:string[];leaf:string;spent:boolean;spendable:boolean}
export interface ProtocolSnapshot {state:ProtocolState;wallets:Record<string,{address:string;spendKey:string;viewKey:string;viewPublicKey:string[];balances:Record<Asset,number>;pending:Record<Asset,number>;notes:OwnedNote[]}>;encryptedLog:EncryptedRecord[];nullifiers:string[];anchors:string[];profile:{treeDepth:number;noteCapacity:number;nullifierCapacity:number;intentPublicSignals:number;transitionPublicSignals:number};receipts:unknown[]}
export interface ProtocolCheckpoint {version:1;domain:string;profile:string;state:ProtocolState;wallets:Record<Owner,{spend:string;view:string}>;trees:{notes:string[];spent:string[];history:string[]};encryptedLog:EncryptedRecord[];nullifiers:string[];anchors:{root:string;count:number;leaves:string[]}[];receipts:unknown[];committed:Record<string,string>}
export interface ProtocolKernel {snapshot():ProtocolSnapshot;exportState():ProtocolCheckpoint;restorePrepared(prepared:PreparedSettlement):Promise<PreparedSettlement>;prepareShield(owner:Owner,asset:Asset,amount:number):Promise<PreparedSettlement>;prepareTransfer(from:Owner,to:Owner,asset:Asset,amount:number):Promise<PreparedSettlement>;prepareWithdraw(owner:Owner,asset:Asset,amount:number,destination:string):Promise<PreparedSettlement>;prepareSeal():Promise<PreparedSettlement>;commit(prepared:PreparedSettlement,receipt:unknown):Promise<ProtocolSnapshot>;rebase(prepared:PreparedSettlement):Promise<PreparedSettlement>;verify(prepared:PreparedSettlement):Promise<boolean>;recover(owner:Owner):OwnedNote[];verificationKeys():Record<string,unknown>}

export interface WalletKeys {spend:string;view:string}
export interface PublicRecipient {owner:string;viewPublicKey:string[]}
export interface PublicProtocolCheckpoint extends Omit<ProtocolCheckpoint,'wallets'> {recipients:Record<Owner,PublicRecipient>}
export interface ClientProtocolKernel extends ProtocolKernel {publicDescriptor():PublicRecipient;setRecipients(recipients:Record<Owner,PublicRecipient>):void;exportWalletKeys():WalletKeys;publicCheckpoint():PublicProtocolCheckpoint;restorePublicCheckpoint(checkpoint:PublicProtocolCheckpoint):void}
