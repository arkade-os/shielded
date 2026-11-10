import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {build} from 'vite';

test('production CSS preserves standard and Safari glass backdrops',async()=>{
 const result=await build({
  configFile:false,
  logLevel:'silent',
  build:{
   write:false,
   emptyOutDir:false,
   rollupOptions:{input:['wallet-glass','wallet-receive','native-tor-health'].map(name=>fileURLToPath(new URL(`../app/src/${name}.css`,import.meta.url)))},
  },
 });
 const bundles=Array.isArray(result)?result:[result];
 const rules:{selector:string;value:string}[]=[];
 for(const bundle of bundles){
  assert.ok('output' in bundle,'a production build emits assets');
  for(const asset of bundle.output){
   if(asset.type!=='asset'||!asset.fileName.endsWith('.css'))continue;
   const css=typeof asset.source==='string'?asset.source:new TextDecoder().decode(asset.source);
   for(const [,selector,body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)){
    const declarations=[...body!.matchAll(/(?:^|;)(-webkit-backdrop-filter|backdrop-filter):([^;}]*)/g)];
    if(!declarations.length)continue;
    const prefixed=declarations.filter(([,property])=>property==='-webkit-backdrop-filter').map(([,,value])=>value);
    const standard=declarations.filter(([,property])=>property==='backdrop-filter').map(([,,value])=>value);
    assert.ok(prefixed.length,`${selector} retains Safari backdrop support`);
    assert.deepEqual(standard,prefixed,`${selector} retains equivalent standard backdrop support`);
    for(const value of standard)rules.push({selector:selector!.trim(),value:value!});
   }
  }
 }
 for(const [selector,filter] of [
  ['.stock-page.has-dock .stock-panel',/^blur\(/],
  ['.stock-panel.has-liquid-refraction',/^var\(--wallet-glass-filter\)/],
  ['.wallet-glass-lens',/^blur\(/],
  ['.wallet-glass-lens.has-liquid-refraction',/^var\(--wallet-glass-filter\)/],
  ['.stock-soundbar.has-refraction',/^url\(/],
  ['.receive-pill',/^blur\(/],
  ['.native-wallet-topbar',/^blur\(/],
  ['.stock-panel.has-liquid-refraction',/^none$/],
  ['.native-wallet-topbar',/^none$/],
 ] as const){
  assert.ok(rules.some(rule=>rule.selector.split(',').some(part=>part.endsWith(selector))&&filter.test(rule.value)),`${selector} emits ${filter} backdrops`);
 }
});
