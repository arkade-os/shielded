import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

const read=(path:string)=>readFileSync(path,'utf8');
const FLAGS=['SHIELDED_OHTTP_CONFIG','SHIELDED_NOSTR_GATEWAY','SHIELDED_NOSTR_RELAYS','SHIELDED_PUBLIC_ORIGIN'];

test('every private build flag is declared as an app-build ARG',()=>{
 const lines=read('Dockerfile.dokploy').split(/\r?\n/),start=lines.findIndex(line=>/ AS app-build$/.test(line)),end=lines.indexOf('RUN npm run build',start);
 assert.ok(start>=0&&end>start,'the app-build stage runs npm run build');
 const stage=lines.slice(start,end);
 for(const flag of FLAGS)assert.ok(stage.some(line=>new RegExp(`^ARG ${flag}(=|$)`).test(line)),flag);
});

test('every private define is declared for TypeScript',()=>{
 const block=/define:\s*\{([^}]*)\}/.exec(read('app/vite.config.ts'))?.[1]??'',declared=read('app/src/vite-env.d.ts');
 const names=[...block.matchAll(/(__SHIELDED_\w+__)\s*:/g)].map(m=>m[1]!).sort();
 assert.deepEqual(names,['__SHIELDED_NOSTR_GATEWAY__','__SHIELDED_NOSTR_RELAYS__','__SHIELDED_OHTTP_CONFIG__','__SHIELDED_POOL_ORIGIN__']);
 for(const name of names)assert.match(declared,new RegExp(`^declare const ${name}:string;$`,'m'),name);
});

test('the transport is the first module main.tsx imports',()=>{
 assert.match(/^import\b.*$/m.exec(read('app/src/main.tsx'))?.[0]??'',/^import '\.\/private-boot(\.ts)?';/);
});

test('a private wallet, which has no Lightning, opens receive on shielded and offers no unified tab',()=>{
 const wallet=read('app/src/RollupWallet.tsx'),lightning=/const (\w+)=nativeHost\|\|!PRIVATE;/.exec(wallet)?.[1];
 assert.ok(lightning);
 assert.ok(wallet.includes(`useState<ReceiveMode>(${lightning}?'unified':'shielded')`));
 assert.match(wallet,new RegExp(`<ReceivePortal [^>]*unified=\\{${lightning}\\}`));
});

test('a private wallet offers no Lightning, Bitcoin or renewal action its transport cannot carry',()=>{
 const wallet=read('app/src/RollupWallet.tsx'),live=/const (\w+)=nativeHost\|\|!PRIVATE;/.exec(wallet)?.[1];
 assert.ok(live);
 assert.ok(wallet.includes(`placeholder={${live}?'shrol21…, tark1…, a Lightning invoice or address':'shrol21… or tark1…'}`));
 assert.ok(wallet.includes(`{${live}?' A Bitcoin address leaves the pool`));
 assert.ok(wallet.includes(`{${live}&&to.trim()&&`));
 assert.match(wallet,new RegExp(`expiring>0&&\\(${live}\\?<button[^\\n]*?>Renew expiring sats</button>:`));
 assert.match(wallet,/^import \{PRIVATE_FLAG\} from '\.\/private-boot(\.ts)?';$/m);
 assert.ok(wallet.includes('turn private networking off: remove {PRIVATE_FLAG} from this site&apos;s local storage, then open this page again without ?private=1 in its address.'));
 assert.ok(read('app/src/private-boot.ts').includes("To turn private networking off, remove ${PRIVATE_FLAG} from this site's local storage, then open this page again without ?private=1 in its address."),'a link with ?private=1 sets the flag again on reload');
});

test('a private wallet reconciles its journal on every tick and caps its shields',()=>{
 const wallet=read('app/src/RollupWallet.tsx'),effect=/useEffect\(\(\)=>\{\s*if\(!wallet\|\|!nativeHost&&!PRIVATE\)return;([\s\S]*?)\},\[([^\]]*)\]\);/.exec(wallet);
 assert.match(effect?.[1]??'',/if\(!nativeHost\)\{[^\n]*PRIVATE!\.reconcile\(\)/);
 assert.match(effect?.[2]??'',/\btick\b/);
 assert.match(wallet,/:PRIVATE\?\{[^\n]*maxShieldCoins:PRIVATE_SHIELD_COINS/);
});

// Source-level: /watch and the wallet are read for their literals and branches, not rendered.
test('the pool-reading pages take their page size and their links from the transport',()=>{
 const disclose=read('app/src/Disclose.tsx');
 assert.ok(disclose.includes('privateTransport()?.pageSize'));
 assert.doesNotMatch(disclose,/limit=100\b/);
 for(const file of ['app/src/RollupWallet.tsx','app/src/Disclose.tsx']){
  const links=read(file).split(/\r?\n/).filter(line=>line.includes('${EXPLORER}'));
  assert.ok(links.length,file);
  for(const line of links)assert.match(line,/(PRIVATE|privateTransport\(\))\?<code>\{txid\}<\/code>:<a [^>]*\$\{EXPLORER\}/,file);
 }
});
