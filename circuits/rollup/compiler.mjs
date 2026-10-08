import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
const pins={'circom-windows-amd64.exe':'e976b5e83b1627fcdc3ab173ef6d6b3253332dd957d2fb834c098ea246d2ead1','circom-linux-amd64':'f3d8d1fdbc123779b80e210c909ee941d7a1e130c70365524646b48b8b0fe9d5'};
export function pinnedCircom(root){
 const deps=path.join(root,'.deps','native-circom-2.2.2'),metadata=JSON.parse(readFileSync(path.join(deps,'compiler.json'),'utf8'));
 const compiler=path.join(deps,metadata.file);
 if(metadata.version!=='2.2.2'||pins[metadata.file]!==metadata.sha256||createHash('sha256').update(readFileSync(compiler)).digest('hex')!==metadata.sha256)
  throw new Error('Pinned circom 2.2.2 is missing or altered. Run: npm run circom');
 return compiler;
}
