import {createHash} from 'node:crypto';

// Every browser with service workers takes woff2, so the woff fallbacks would only cost a first visit.
export function appCacheManifest(fileNames:string[],force=false):{version:string;files:string[];force:boolean}{
 const files=[...new Set([...fileNames.filter(name=>name!=='sw.js'&&!name.endsWith('.woff')),'index.html'])].map(name=>'/'+name).sort();
 return {version:createHash('sha256').update(files.join('\n')).digest('hex').slice(0,12),files,force};
}
