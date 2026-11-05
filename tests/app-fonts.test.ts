import assert from 'node:assert/strict';
import {existsSync,readdirSync,readFileSync} from 'node:fs';
import {test} from 'node:test';

const files=(path:string,pattern:RegExp)=>[...readFileSync(path,'utf8').matchAll(pattern)].map(m=>m[1]!);

test('the app loads no fonts from Google',()=>{
 const styles=readdirSync('app/src').filter(f=>f.endsWith('.css')).map(f=>`app/src/${f}`);
 for(const file of [...styles,'app/index.html'])assert.doesNotMatch(readFileSync(file,'utf8'),/fonts\.(googleapis|gstatic)\.com/,file);
});

test('the app bundles only the latin subset of each font',()=>{
 for(const file of files('app/src/main.tsx',/import '(@fontsource[^']+)'/g))assert.match(file,/\/latin-\d+\.css$/,file);
 const faces=files('app/src/fonts.css',/url\(([^)]+)\)/g);
 assert.ok(faces.length);
 for(const file of faces)assert.match(file,/-latin-/,file);
});

test('every font file the app names exists in its package',()=>{
 for(const file of files('app/src/fonts.css',/url\(([^)]+)\)/g))assert.ok(existsSync(`node_modules/${file}`),file);
});
