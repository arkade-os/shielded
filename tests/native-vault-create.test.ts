import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

test('Android vault creation shares the process lock with every vault mutation',()=>{
 const source=readFileSync(new URL('../src-tauri/plugins/shielded-platform/android/src/main/java/io/arkade/shielded/platform/AndroidSeedVault.kt',import.meta.url),'utf8');
 assert.match(source,/companion object\s*\{\s*private val access = Any\(\)/);
 for(const name of ['get','set','clear','create'])assert.match(source,new RegExp(`fun ${name}\\([^)]*\\)[^{=]*(?:= synchronized\\(access\\)|\\{\\s*(?:return )?synchronized\\(access\\))`));
 const create=source.slice(source.indexOf('fun create('),source.indexOf('private fun requireSeed'));
 assert.match(create,/val previous = get\(\)/);assert.match(create,/previous == null \|\| previous == value/);
 assert.match(create,/if \(previous == null\) set\(value\)/);assert.match(create,/isInterrupted/);
});

test('an Android seed write that misses the disk leaves no seed in the preferences map',()=>{
 const source=readFileSync(new URL('../src-tauri/plugins/shielded-platform/android/src/main/java/io/arkade/shielded/platform/AndroidSeedVault.kt',import.meta.url),'utf8');
 const set=source.slice(source.indexOf('fun set('),source.indexOf('fun clear('));
 assert.match(set,/val previous = records\.getString\("seed", null\)/);
 assert.match(set,/if \(!records\.edit\(\)\.putString\("seed", .*\)\.commit\(\)\) \{/,'a failed commit is handled, never trusted');
 assert.match(set,/val restored = records\.edit\(\)\.apply \{ if \(previous == null\) remove\("seed"\) else putString\("seed", previous\) \}\.commit\(\)[\s\S]*?error\(if \(restored\)/,'the durable record returns to the map before the write reports failure, and a failed rollback says so');
});

test('iOS vault creation atomically adds and accepts a duplicate only if its seed matches',()=>{
 const source=readFileSync(new URL('../src-tauri/plugins/shielded-platform/ios/Sources/SeedVault.swift',import.meta.url),'utf8');
 const create=source.slice(source.indexOf('func create('),source.indexOf('func clear('));
 assert.match(create,/SecItemAdd\(/);assert.doesNotMatch(create,/SecItemUpdate\(/);
 assert.match(create,/errSecDuplicateItem/);assert.match(create,/try get\(\) == value/);
});
