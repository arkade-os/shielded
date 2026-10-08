import {existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';

// Only what the retired v1 installer created: the data directory may be shared outside the container.
const V1_ENTRIES=['installation','artifacts','bootstrap','releases','coordinator','stock-profile-qualification.json'];

export function dropLegacyData(data:string):string[] {
 const removed=V1_ENTRIES.filter(name=>existsSync(join(data,name)));
 for(const name of removed)rmSync(join(data,name),{recursive:true,force:true});
 return removed;
}
