import {Transaction} from '@arkade-os/sdk';
import {base64} from '@scure/base';

export function decodeStockIndexerTransaction(encoded:string):Transaction {
 try{return Transaction.fromPSBT(base64.decode(encoded));}
 catch{throw new Error('Public Arkade indexer returned a malformed base64 PSBT.');}
}
