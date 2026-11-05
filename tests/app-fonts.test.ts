import assert from 'node:assert/strict';
import {existsSync,readdirSync,readFileSync} from 'node:fs';
import {test} from 'node:test';

const matches=(text:string,pattern:RegExp)=>[...text.matchAll(pattern)].map(m=>m[1]!);
const files=(path:string,pattern:RegExp)=>matches(readFileSync(path,'utf8'),pattern);
const styles=readdirSync('app/src').filter(f=>f.endsWith('.css')).map(f=>`app/src/${f}`);

test('the app loads no fonts from Google',()=>{
 for(const file of [...styles,'app/index.html'])assert.doesNotMatch(readFileSync(file,'utf8'),/fonts\.(googleapis|gstatic)\.com/,file);
});

test('the app bundles only the latin subset of each font',()=>{
 for(const file of files('app/src/main.tsx',/import '(@fontsource[^']+)'/g))assert.match(file,/\/latin-\d+\.css$/,file);
 const faces=files('app/src/fonts.css',/url\(([^)]+)\)/g);
 assert.ok(faces.length);
 for(const file of faces)assert.match(file,/-latin-(?!ext)/,file);
});

test('every font file the app names exists in its package',()=>{
 for(const file of files('app/src/fonts.css',/url\(([^)]+)\)/g))assert.ok(existsSync(`node_modules/${file}`),file);
});

test('every family the stylesheets name is a face from the font CSS main.tsx imports, or a system font',()=>{
 const registered=new Set(files('app/src/main.tsx',/import '([^']+\.css)'/g).flatMap(css=>files(css.startsWith('.')?`app/src/${css}`:`node_modules/${css}`,/@font-face\s*\{[^}]*?font-family:\s*['"]([^'"]+)['"]/g)));
 for(const file of styles)for(const value of files(file,/(?:font-family|font|--[\w-]+)\s*:([^;}]+)/g))
  for(const family of matches(value,/['"]([^'"]+)['"]/g))assert.ok(registered.has(family)||family==='Segoe UI',`${file}: '${family}'`);
});
