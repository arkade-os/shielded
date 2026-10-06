import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserClient} from '../packages/protocol/src/browser.ts';

test('browser client restores a checkpoint that lists other registered wallets',async()=>{
 const alice=await createBrowserClient({owner:'alice',keys:{spend:'43',view:'47'}}),bob=await createBrowserClient({owner:'bob',keys:{spend:'53',view:'59'}});
 alice.setRecipients({alice:alice.publicDescriptor(),bob:bob.publicDescriptor()});
 const checkpoint=alice.publicCheckpoint(),restored=await createBrowserClient({owner:'bob',keys:{spend:'53',view:'59'},checkpoint});
 assert.deepEqual(restored.publicCheckpoint().recipients,checkpoint.recipients);
});
