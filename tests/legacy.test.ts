import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {dropLegacyData} from '../src/legacy.ts';

test('removes only the retired v1 entries from the data volume',()=>{
 const data=mkdtempSync(join(tmpdir(),'shielded-legacy-'));
 try{
  for(const dir of ['installation','releases/abc','coordinator','rollup/operator','lost+found'])mkdirSync(join(data,dir),{recursive:true});
  writeFileSync(join(data,'stock-profile-qualification.json'),'{}');
  writeFileSync(join(data,'notes.txt'),'keep');
  assert.deepEqual(dropLegacyData(data).sort(),['coordinator','installation','releases','stock-profile-qualification.json']);
  assert.deepEqual(readdirSync(data).sort(),['lost+found','notes.txt','rollup']);
  assert.deepEqual(readdirSync(join(data,'rollup')),['operator']);
  assert.deepEqual(dropLegacyData(data),[]);
 }finally{rmSync(data,{recursive:true,force:true});}
});
