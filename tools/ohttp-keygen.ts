// Makes the Oblivious HTTP gateway key. The SHIELDED_OHTTP_KEY line goes only into <file>, which must not exist; stdout gets the public key id, config and Nostr key, safe to publish.
import {writeFileSync} from 'node:fs';
import {generateOhttpKey} from '../src/rollup/ohttp-keys.ts';

const args=process.argv.slice(2);
if(args.length!==1)throw new Error('Usage: npm run ohttp:keygen -- <file>; the SHIELDED_OHTTP_KEY line is written there (mode 0600, never overwritten) and never printed.');
const [file]=args,{env,config,nostrPublic}=await generateOhttpKey();
try{writeFileSync(file,`SHIELDED_OHTTP_KEY=${env}\n`,{flag:'wx',mode:0o600});}
catch(error){throw (error as NodeJS.ErrnoException).code==='EEXIST'?new Error(`${file} already exists; ohttp:keygen never overwrites a key file.`):error;}
console.log(`key id: ${env.slice(0,env.indexOf(':'))}\nconfig: ${Buffer.from(config).toString('base64url')}\nnostr: ${nostrPublic}`);
