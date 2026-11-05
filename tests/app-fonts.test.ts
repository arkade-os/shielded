import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
import {test} from 'node:test';

test('the app loads no fonts from Google',()=>{
 const styles=readdirSync('app/src').filter(f=>f.endsWith('.css')).map(f=>`app/src/${f}`);
 for(const file of [...styles,'app/index.html'])assert.doesNotMatch(readFileSync(file,'utf8'),/fonts\.(googleapis|gstatic)\.com/,file);
});
