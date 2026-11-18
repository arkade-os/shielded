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

const PREDICATES=/const lightningOn=nativeHost\|\|!PRIVATE\|\|initialPool\?\.privateLightning===true,batchStreams=nativeHost\|\|!PRIVATE;/;
test('a private wallet has Lightning exactly when its server says it carries it, and receive opens on unified then and on shielded otherwise',()=>{
 const wallet=read('app/src/RollupWallet.tsx');
 assert.match(wallet,PREDICATES);
 assert.ok(wallet.includes(`const receiveMode=chosenReceiveMode??(lightningOn?'unified':'shielded');`));
 assert.match(wallet,/<ReceivePortal [^>]*unified=\{lightningOn\}/);
 assert.ok(wallet.includes('const pairing=PRIVATE&&!nativeHost&&!status.privateLightning?undefined:createLightningWallet('),'no companion, so no Lightning request, against a server without the routes');
 assert.ok(wallet.includes('...(nativeHost?nativeSwapConfig():PRIVATE?privateSwapConfig(PRIVATE):{})'),'a private wallet\'s swaps never use the default socket transport');
});

test('in private mode the Lightning address details say what this site\'s server now sees, and how to recover older payouts',()=>{
 const wallet=read('app/src/RollupWallet.tsx'),line=/\{PRIVATE&&' With private networking on, this site\\'s server makes the requests to that service for you:([^\n]*?)'\}<\/p><\/details>/.exec(wallet)?.[1]??'';
 assert.match(line,/the server sees this Lightning address, its access token and your shielded address\./);
 assert.match(line,/to recover those, turn private networking off and open the wallet again\.$/);
});

test('the private boot never loads the swap package, whose Nostr module captures WebSocket as it evaluates',()=>{
 for(const file of ['app/src/private-boot.ts','src/shielded/private-transport.ts','src/shielded/sealed-fetch.ts','src/shielded/network-privacy.ts','src/native/policy.ts'])assert.doesNotMatch(read(file),/from '@arkade-os\/swap|private-swap/,file);
 assert.match(read('src/shielded/private-swap.ts'),/from '@arkade-os\/swap\/nostr'/,'the swap\'s Nostr module is reached only from the lazily loaded wallet');
});

test('a private wallet offers no Bitcoin or renewal action its transport cannot carry, and Lightning only as its server carries it',()=>{
 const wallet=read('app/src/RollupWallet.tsx');
 assert.match(wallet,PREDICATES);
 assert.ok(wallet.includes(`placeholder={lightningOn?'shrol21…, tark1…, a Lightning invoice or address':'shrol21… or tark1…'}`));
 assert.ok(wallet.includes(`{batchStreams?' A Bitcoin address leaves the pool`));
 assert.ok(wallet.includes(`{!lightningOn?' This server does not carry Lightning payments over private networking yet.'`));
 assert.ok(wallet.includes(`{lightningOn&&to.trim()&&`));
 assert.match(wallet,/expiring>0&&\(batchStreams\?<button[^\n]*?>Renew expiring sats<\/button>:/);
 assert.match(wallet,/^import \{PRIVATE_FLAG\} from '\.\/private-boot(\.ts)?';$/m);
 assert.ok(wallet.includes('turn private networking off: remove {PRIVATE_FLAG} from this site&apos;s local storage, then open this page again without ?private=1 in its address.'));
 assert.ok(read('app/src/private-boot.ts').includes("To turn private networking off, remove ${PRIVATE_FLAG} from this site's local storage, then open this page again without ?private=1 in its address."),'a link with ?private=1 sets the flag again on reload');
});

const TICK_EFFECT=/useEffect\(\(\)=>\{\s*if\(!wallet\|\|!nativeHost&&!PRIVATE\)return;([\s\S]*?)\},\[([^\]]*)\]\);/;
test('a private wallet reconciles its journal on every tick and caps its shields',()=>{
 const wallet=read('app/src/RollupWallet.tsx'),effect=TICK_EFFECT.exec(wallet),body=effect?.[1]??'';
 assert.match(body,/nativeHost\?reconcileNativeJournal\([^\n]*POOL_ORIGIN,wallet\):PRIVATE!\.reconcile\(wallet\)/);
 assert.match(body,/setNativePending\(pending\);setJournalError\(''\)[^\n]*setNativePending\(true\);setJournalError\(errorText\(error\)\)/,'a failed reconcile keeps the unresolved line and its own error; a later success clears only that');
 assert.doesNotMatch(body,/setPoolError/,'a journal error never replaces a startup error');
 assert.match(wallet,/\{ready&&journalError&&<p className="stock-blocked">\{journalError\}<\/p>\}/);
 assert.match(effect?.[2]??'',/\btick\b/);
 assert.match(wallet,/:PRIVATE\?\{[^\n]*maxShieldCoins:PRIVATE_SHIELD_COINS/);
});

test('every tick hands the journal the wallet itself, on the native path as much as the sealed one',()=>{
 const effect=TICK_EFFECT.exec(read('app/src/RollupWallet.tsx'));
 assert.match(effect?.[1]??'',/void \(nativeHost\?reconcileNativeJournal\([^\n]*,wallet\):PRIVATE!\.reconcile\(wallet\)\)\s*\.then\(/);
 assert.match(effect?.[2]??'',/\bwallet\b/);
});

test('the unresolved-outcomes banner offers a release behind a confirm, on either private path',()=>{
 const wallet=read('app/src/RollupWallet.tsx'),banner=/\{nativePending&&<section className="stock-warning" role="status">([\s\S]*?)<\/section>\}/.exec(wallet)?.[1]??'';
 assert.match(banner,/\{confirmRelease\s*\?/,'the action asks before it releases');
 assert.match(banner,/coin can be spent only once[\s\S]*?A payment is never released here/,'the confirm says why a shield is safe and a payment is not offered');
 assert.equal((banner.match(/>Release reserved shields<\/button>/g)??[]).length,2,'one button opens the confirm, one does the release');
 assert.match(banner,/onClick=\{releaseReserved\}/);
 assert.doesNotMatch(banner,/releaseNote&&/);
 assert.match(wallet,/<\/section>\}\s*\{releaseNote&&<section className="stock-warning" role="status"><span>\{releaseNote\}<\/span>[\s\S]*?onClick=\{\(\)=>setReleaseNote\(''\)\}>Dismiss</,'the result outlives the banner, which unmounts once nothing is reserved');
 const handler=/const releaseReserved=\(\)=>\{([\s\S]*?)\n \};/.exec(wallet)?.[1]??'';
 assert.match(handler,/nativeHost\?forceReleaseNativeJournal\(POOL_ORIGIN\):PRIVATE!\.journal\.forceRelease\(PRIVATE!\.poolOrigin\)/,'both paths release through the journal, never the component');
 assert.doesNotMatch(handler,/settledNullifiers/,'a payment is never released by hand, whatever the wallet would say');
 assert.match(handler,/setTick/,'the banner is recomputed from the journal, not assumed');
});

const PREFETCH_EFFECT=/useEffect\(\(\)=>\{\s*if\(!pool\)return;([\s\S]*?)\},\[([^\]]*)\]\);/;
test('a private wallet prefetches both proving circuits on open, not on the send tab',()=>{
 const effect=PREFETCH_EFFECT.exec(read('app/src/RollupWallet.tsx')),body=effect?.[1]??'',branch=/if\(PRIVATE\)\{([^}]*)\}/.exec(body);
 assert.ok(branch,'the prefetch effect has a private branch');
 for(const circuit of ['spend','join'])assert.ok(branch[1]!.includes(`prefetchProvingKeys(pool,'${circuit}','',sessionFetch);`),circuit);
 assert.ok(branch[1]!.includes("if(pool.proving?.join)prefetchProvingKeys(pool,'join','',sessionFetch);"),'a status that names no join circuit gets no join prefetch, which would throw inside the effect');
 assert.match(branch[1]!,/return;$/,'a private open leaves before the send-tab condition');
 assert.doesNotMatch(branch[1]!,/\btab\b/);
 assert.equal(body.slice(body.indexOf(branch[0])+branch[0].length).trim(),"if(tab==='send')prefetchProvingKeys(pool,'spend','',sessionFetch);");
 assert.match(effect?.[2]??'',/^tab,pool,sessionFetch$/);
});

// Source-level: /watch and the wallet are read for their literals and branches, not rendered.
test('the pool-reading pages take their page size and their links from the transport',()=>{
 const disclose=read('app/src/Disclose.tsx'),wallet=read('app/src/RollupWallet.tsx');
 assert.ok(disclose.includes('privateTransport()?.pageSize'));
 assert.doesNotMatch(disclose,/limit=100\b/);
 const links=disclose.split(/\r?\n/).filter(line=>line.includes('${EXPLORER}'));
 assert.ok(links.length);
 for(const line of links)assert.match(line,/privateTransport\(\)\?<code>\{txid\}<\/code>:<a [^>]*\$\{EXPLORER\}/);
 const explorers=wallet.match(/explorerUrl\(/g)?.length;
 assert.ok(explorers);
 assert.equal(wallet.match(/PRIVATE\?undefined:explorerUrl\(/g)?.length,explorers,'a private wallet neither opens nor copies an explorer link');
 assert.doesNotMatch(wallet,/explorer\.mutinynet|\$\{EXPLORER\}|TxLink/,'activity links open in the app instead of navigating to an explorer');
});
