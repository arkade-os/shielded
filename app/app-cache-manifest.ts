import {createHash} from 'node:crypto';

// Every browser with service workers takes woff2, so the woff fallbacks would only cost a first visit.
// index.html is the one file whose name does not change with its content, so the version hashes it too.
export function appCacheManifest(fileNames:string[],force=false,indexHtml:string|Uint8Array=''):{version:string;files:string[];force:boolean;integrity:string}{
 const files=[...new Set([...fileNames.filter(name=>name!=='sw.js'&&!name.endsWith('.woff')),'index.html'])].map(name=>'/'+name).sort();
 return {version:createHash('sha256').update(files.join('\n')).update('\0').update(indexHtml).digest('hex').slice(0,12),files,force,integrity:`sha256-${createHash('sha256').update(indexHtml).digest('base64')}`};
}
